# Screenshot → Code (Agent Edition) — Implementation Plan

> Reproduce a screenshot as pixel-faithful front-end code by driving the **Claude Code CLI**
> (your Claude **Pro Max** subscription — no API key, no metered cost) in an **iterative
> visual-feedback loop**: generate → render → score → fix → repeat until the render matches.

---

## 1. Goal & non-goals

**Goal:** A local web app where you drop in a screenshot and an agent iterates — writing HTML,
rendering it headless, comparing its own render against your screenshot, and fixing the gaps —
round after round until it's a near-1:1 replica. Powered entirely by the `claude` CLI on the
Pro Max plan.

**Non-goals (deferred):** Replicate image generation, Gemini asset-cropping, video→code,
multi-provider (GPT/Gemini). All optional polish; not needed for the core fidelity loop.

---

## 2. The key insight

The upstream project (`abi/screenshot-to-code`) gets its fidelity from **one technique**: an
agent that calls a `screenshot_preview` tool (Playwright render → PNG back to the model), *looks
at its own render next to the original*, and fixes differences with `edit_file` — up to 30
tool-turns, capped at $3/variant.

**That agent loop is exactly what the `claude` CLI already is.** They hand-built ~1,500 lines
(a provider protocol, a turn loop in `agent/engine.py`, a tool runtime, `create_file`/`edit_file`
tools). Claude Code *is* that agent natively — Read/Write/Edit/Bash built in. So we don't
reimplement any of it. We:

- **Reuse** their React **frontend**, their **prompts**, and their **Playwright render** approach.
- **Replace** their entire backend model layer (engine + providers) with a thin Node server that
  drives the CLI.
- **Add** something they don't even have: an **objective pixel-diff score** (pixelmatch) that
  gives the agent — and the UI — a real number to chase, instead of eyeballing.

### Component mapping

| Upstream (theirs) | Ours |
|---|---|
| `agent/engine.py` 30-turn loop | the `claude` CLI (it *is* an agent loop) |
| `create_file` / `edit_file` tools | Claude Code built-in **Write / Edit** |
| `screenshot_preview` (Playwright→PNG→model) | **`render.mjs`** run via **Bash**, image Read back |
| provider abstraction (GPT/Claude/Gemini) | not needed — Claude-only via Pro Max |
| `$3`/variant budget cap | max-rounds (prompt) + wall-clock kill (server) |
| *(none)* | **pixelmatch similarity score** — objective stop signal |

---

## 3. Architecture

```
  their React frontend (unchanged)          OUR Node backend (backend/)
  http://localhost:5173                      ws://127.0.0.1:7001/generate-code
        │                                            │
        │  1. WS connect + params JSON               │
        │  (screenshot as data URL, stack, model) ──►│  decode → work/<id>/target.png
        │                                            │  copy render.mjs into workdir
        │                                            │  spawn:  claude -p "<task>" \
        │                                            │    --model opus \
        │                                            │    --output-format stream-json --verbose \
        │                                            │    --append-system-prompt <sys> \
        │                                            │    --dangerously-skip-permissions
        │                                            │        │
        │                                            │        ▼  AGENT LOOP (Claude drives it)
        │                                            │   Read target.png
        │                                            │   Write output.html
        │                                            │   Bash: node render.mjs ─┐
        │                                            │   Read render.png+diff   │ Playwright renders
        │                                            │   Edit output.html       │ output.html →
        │                                            │   …repeat N rounds…       │ desktop+mobile PNG,
        │                                            │        │                  │ pixelmatch vs target
        │  ◄── setCode (full html each change) ──────│◄ fs poll output.html      │ → score.json
        │  ◄── status ("Similarity 87% …") ──────────│◄ fs poll score.json ◄─────┘
        │  ◄── assistant / toolStart (what it's doing)│◄ parse stream-json stdout
        │  ◄── variantComplete ; close(1000) ────────│  on process exit
        ▼
   live code + preview + score in the UI
```

**Why the frontend can't tell the difference:** it just opens a WebSocket to
`VITE_WS_BACKEND_URL/generate-code`, sends one params JSON, and consumes typed messages. Our
backend speaks that exact protocol (see §4).

---

## 4. Wire protocol (frontend contract we must honor)

**Endpoint:** `ws://127.0.0.1:7001/generate-code`. Frontend sends **one** JSON on open.

**Inbound params we use:** `prompt.images[]` (data URLs — screenshot is `images[0]`),
`generatedCodeConfig` (stack), `codeGenerationModel`, `generationType` (`create`/`update`),
`fileState` (for updates). API-key fields are ignored (we don't need them).

**Outbound messages we send** (every per-variant message carries `variantIndex`):

| Type | Shape | Use |
|---|---|---|
| `variantCount` | `{type,value:"1"}` | how many variants (we do 1 that iterates) |
| `variantModels` | `{type,data:{models:[label]}}` | model label |
| `status` | `{type,value,variantIndex}` | progress + **similarity score** |
| `assistant` | `{type,value,variantIndex,eventId}` | what the agent is reasoning/doing |
| `toolStart` | `{type,data:{name,input},variantIndex,eventId}` | tool calls (Write/Edit/Bash) |
| `setCode` | `{type,value:<full html>,variantIndex}` | **replace** current code (we push whole file) |
| `variantComplete` | `{type,variantIndex}` | done |
| `variantError` | `{type,value,variantIndex}` | failed |

**Close codes:** `1000` success · `4332` backend error · `4333` user cancelled (frontend closes).

We use `setCode` (replace) rather than `chunk` (append): each time `output.html` changes on disk
we push the whole file — robust and simple.

**Stacks:** `html_tailwind` (default), `html_css`, `react_tailwind`, `bootstrap`, `vue_tailwind`,
`ionic_tailwind`.

---

## 5. Files

```
screenshot-to-code-agent/
├── IMPLEMENTATION_PLAN.md      ← this file
├── frontend/                   ← their React app (reused). Only change: .env → our backend
│   └── .env                    ← VITE_WS_BACKEND_URL / VITE_HTTP_BACKEND_URL / PROXY_CODEGEN_BACKEND
└── backend/
    ├── package.json            ← express, ws, playwright, sharp, pixelmatch, pngjs
    ├── server.js               ← HTTP+WS server; speaks the frontend protocol; drives the CLI
    ├── prompt.js               ← system prompt + per-stack instructions + the iterative task text
    ├── render.mjs              ← Playwright render (desktop+mobile) + pixelmatch score → score.json
    ├── test-loop.mjs           ← headless smoke test of the CLI loop (no browser UI needed)
    ├── make-sample.mjs         ← generate a sample target.png to test against
    └── work/<session>/         ← per-run: target.png, output.html, render*.png, diff.png, score.json
```

### `render.mjs` (the crucial piece)
- Loads `output.html` via `file://` in headless Chromium, waits for `networkidle` + fonts.
- Full-page screenshot at **desktop 1280** and **mobile 375** → `render.png`, `render.mobile.png`.
- Resizes render to the target's dimensions (`fit:cover, position:top` — no aspect distortion),
  runs **pixelmatch** vs `target.png` → writes `diff.png` and `score.json`
  `{score, diffPixels, width, height}`, and prints `SIMILARITY_SCORE=NN%` to stdout.
- Runs with `cwd = work/<id>`; imports resolve up-tree to `backend/node_modules`.

### `server.js`
- `http.createServer(express)` on **7001**; stubs `GET /api/*` → `{}` so the frontend never errors;
  `WebSocketServer({server, path:'/generate-code'})`.
- On first WS message: decode `images[0]` → `work/<id>/target.png`; copy `render.mjs` in;
  send `variantCount`/`variantModels`; spawn `claude`; **poll** `output.html` (→`setCode`) and
  `score.json` (→`status`); parse `stream-json` stdout (→`assistant`/`toolStart`); on exit send
  `variantComplete` and close `1000`. Wall-clock kill at 10 min. Frontend close → kill child.

### `prompt.js`
- **System prompt** (lifted in spirit from upstream): expert front-end dev; exact text/colors;
  single self-contained file; correct CDN links per stack.
- **Task**: Read `target.png` → Write `output.html` → `node render.mjs` → Read `render.png`+`diff.png`
  → Edit to close the biggest gaps → re-render → repeat up to `MAX_ROUNDS` (env, default 6) or
  until similarity ≥ ~92% and it looks faithful. *Stop when close; don't loop forever.*

---

## 6. Build phases

1. **`render.mjs`** — prove render + score on a hand-written `output.html` vs a sample `target.png`.
2. **CLI loop** (`prompt.js` + `test-loop.mjs`) — run `claude` headless in a workdir; confirm the
   score climbs across rounds and `output.html` converges.
3. **`server.js`** — WS endpoint speaking the frontend protocol; wire polling + stream parsing.
4. **Frontend `.env`** — point at our backend; stub `/api`.
5. **End-to-end** — `pnpm dev` (frontend) + `node server.js` (backend); drop a screenshot; watch it.

---

## 7. Known risks / bug-audit checklist

- **`--bare` is forbidden.** It disables OAuth and demands an API key — the opposite of what we
  want. We run normal mode (OAuth = Pro Max). Side effect: `~/CLAUDE.md` auto-loads into the agent;
  low risk of derailing HTML generation, monitored.
- **Permissions.** `--dangerously-skip-permissions` lets the agent run Bash/Write/Edit unattended
  in its **isolated `work/<id>` dir**. Acceptable for a local sandbox; documented here so it's not a
  surprise. (Alternative: `--permission-mode acceptEdits` + explicit Bash allow.)
- **stream-json requires `--verbose`** in `-p` mode; parser must tolerate partial/interleaved lines
  (buffer to newline, `try/catch` each line, never crash on a bad line).
- **Playwright hangs.** `networkidle` can stall if a CDN never settles → per-page **timeout** + wrap
  in try/finally to always `browser.close()`; on render failure, write a low score, don't throw the
  whole loop.
- **Score is a heuristic**, not truth: full-page vs fixed-height target is resized `cover/top`, so a
  tall page is only partially compared. Good enough to *drive* iteration and *show* progress; not a
  correctness guarantee. Documented, not "fixed."
- **Concurrency / cleanup.** One generation per socket. On WS close (incl. `4333` cancel) or
  timeout, **kill the child** and clear timers/pollers — no orphaned `claude`/Chromium.
- **Data-URL decode.** Strip any `data:*;base64,` prefix defensively; reject if no image present.
- **Node module resolution** for `render.mjs` copied into `work/<id>` relies on up-tree lookup to
  `backend/node_modules` — verified in Phase 1.
- **Cost/time.** No dollars (Pro Max), but each round is a full Opus turn — a 6-round run is minutes.
  Smoke tests cap `MAX_ROUNDS=2`.

---

## 8. Run

```bash
# backend
cd backend && npm install && npx playwright install chromium   # chromium cached globally
node server.js                                                  # ws://127.0.0.1:7001

# frontend (separate terminal)
cd frontend && pnpm install && pnpm dev                         # http://localhost:5173
```
Open http://localhost:5173, drop a screenshot, watch the score climb round over round.
