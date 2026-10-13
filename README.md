# screenshot-to-code-agent

Drop in a screenshot. Get pixel-faithful HTML/CSS code back.

Powered entirely by the **Claude Code CLI** on a Pro Max subscription — no API key, no per-token cost.

---

## What it does

You paste or drag a screenshot of any UI into the browser. The app spins up an agent loop that:

1. Reads your screenshot
2. Writes a first-pass `output.html`
3. Renders it headless with Playwright
4. Pixel-diffs the render against your screenshot (pixelmatch) → produces a similarity score
5. Reads its own render + diff image, finds the red areas (mismatches), fixes them with Edit
6. Re-renders, confirms the score went up, repeats — up to 6 rounds by default

Two variants run in parallel (Opus + Sonnet). You watch both streams live, see the similarity score climb each round, and pick whichever result you like.

After generation you can refine with a follow-up instruction ("make the nav sticky", "change the font to Inter") — the agent applies only your change and re-scores.

---

## Key insight

The upstream project [abi/screenshot-to-code](https://github.com/abi/screenshot-to-code) achieves high fidelity through an agent that calls a `screenshot_preview` tool, looks at its own render next to the original, and fixes differences — up to 30 tool-turns.

**That agent loop is exactly what the `claude` CLI already is.** The upstream project hand-built ~1,500 lines of agent infrastructure (turn loop, tool runtime, provider abstraction). Claude Code has all of that natively via `Read`/`Write`/`Edit`/`Bash` tools.

So this project:
- **Reuses** the React frontend, the prompt strategy, and the Playwright render approach from abi/screenshot-to-code
- **Replaces** their entire backend model layer with a thin Node.js server that just spawns `claude`
- **Adds** an objective pixel-diff score (pixelmatch) that gives the agent — and you — a real number to chase

---

## Architecture

```
  React frontend (port 5173)              Node backend (port 7001)
        │                                        │
        │  1. WebSocket + params JSON             │
        │  (screenshot, stack, model) ──────────►│  decode → work/<id>/target.png
        │                                        │  spawn: claude -p "<task>" \
        │                                        │    --model opus \
        │                                        │    --output-format stream-json \
        │                                        │    --allowedTools Read Write Edit Bash
        │                                        │         │
        │                                        │   AGENT LOOP (Claude drives it)
        │                                        │   Read target.png
        │                                        │   Write output.html
        │                                        │   Bash: node render.mjs
        │                                        │   Read render.png + diff.png
        │                                        │   Edit output.html
        │                                        │   … up to MAX_ROUNDS …
        │                                        │
        │  ◄── setCode (full HTML on each change)│◄ fs poll output.html
        │  ◄── status ("Similarity 87%…")        │◄ fs poll score.json
        │  ◄── assistant / toolStart events      │◄ parse stream-json stdout
        │  ◄── variantComplete → close(1000)     │  on process exit
        ▼
   live preview + similarity score in the browser
```

Two variants run concurrently in separate work directories — one Opus, one Sonnet. Both stream to the UI simultaneously.

---

## Stack

| Layer | Tech |
|-------|------|
| Frontend | React 18, TypeScript, Vite, Tailwind, Zustand |
| Backend | Node.js, Express, `ws` (WebSocket) |
| Render | Playwright (headless Chromium), pixelmatch, pngjs, sharp |
| Agent | `claude` CLI — Claude Code Pro Max (no API key needed) |
| Code targets | HTML+Tailwind, HTML+CSS, React+Tailwind, Bootstrap, Vue+Tailwind, Ionic+Tailwind |

---

## Getting started

**Prerequisites:** Node.js 18+, pnpm, and the `claude` CLI installed and authenticated on a Pro Max plan.

```bash
# 1. Backend
cd backend
npm install
npx playwright install chromium
node server.js          # ws://127.0.0.1:7001

# 2. Frontend (separate terminal)
cd frontend
pnpm install
pnpm dev                # http://localhost:5173
```

Open http://localhost:5173, drop a screenshot, and watch the score climb.

### Environment variables (backend)

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `7001` | WebSocket/HTTP port |
| `MAX_ROUNDS` | `6` | Max improvement rounds per variant |
| `HARD_TIMEOUT_MS` | `600000` | 10-minute wall-clock kill |
| `VARIANT_MODELS` | `opus,sonnet` | Comma-separated model list (one variant per entry) |
| `MAX_CONCURRENT_SOCKETS` | `10` | Max parallel sessions |

---

## How the render loop works

`render.mjs` is copied into each session's work directory and called by the agent via `Bash`:

1. Loads `output.html` in headless Chromium (`networkidle` + fonts settled)
2. Screenshots at 1280px desktop and 375px mobile → `render.png`, `render.mobile.png`
3. Resizes to match `target.png` dimensions, runs pixelmatch → `diff.png` + `score.json`
4. Prints `SIMILARITY_SCORE=NN%` to stdout (the agent reads this and adjusts strategy)

The server polls `output.html` every 700ms and pushes any change to the frontend as a live `setCode` message. The preview updates in real time as the agent writes.

---

## Project structure

```
screenshot-to-code-agent/
├── backend/
│   ├── server.js        WebSocket server; speaks the frontend protocol; drives the CLI
│   ├── prompt.js        System prompt + per-stack instructions + iterative task text
│   ├── render.mjs       Playwright render + pixelmatch scoring
│   ├── crop.mjs         Optional: extract a real asset from the screenshot by pixel box
│   ├── make-sample.mjs  Generate a sample target.png for smoke testing
│   └── test-loop.mjs    Headless smoke test of the agent loop (no browser UI)
└── frontend/
    └── src/
        ├── App.tsx           Main app — state machine, WS lifecycle, generation callbacks
        ├── generateCode.ts   WebSocket client wrapper
        ├── store/
        │   ├── app-store.ts      AppState machine (INITIAL → CODING → CODE_READY)
        │   └── project-store.ts  Commits, variants, agent events (Zustand)
        └── components/
            ├── sidebar/      Prompt input, variant status, generation controls
            ├── preview/      Live HTML preview (iframe) + code tab
            ├── variants/     Multi-variant selector
            └── history/      Version history navigation
```

---

## Supported stacks

| Value | Output |
|-------|--------|
| `html_tailwind` (default) | Single HTML file + Tailwind CDN |
| `html_css` | Single HTML file + `<style>` block |
| `react_tailwind` | Single HTML file — React 18 + Babel + Tailwind via CDN |
| `bootstrap` | Single HTML file + Bootstrap 5 CDN |
| `vue_tailwind` | Single HTML file — Vue 3 + Tailwind via CDN |
| `ionic_tailwind` | Single HTML file — Ionic web components + Tailwind via CDN |

---

## Notes

- **No API cost.** The `claude` CLI uses your Pro Max OAuth session, not an API key. Each generation is metered against your plan's usage limits, not billed per token.
- **Isolated work dirs.** Each session gets its own `backend/work/<id>/` directory. It is deleted automatically when the WebSocket closes.
- **`--dangerously-skip-permissions`** is passed to the CLI so the agent can run Bash/Write/Edit unattended inside its isolated work directory. This is intentional for a local sandbox.
- **Score is a heuristic.** Full-page renders are cropped `cover/top` to match the target dimensions, so a tall output is only partially compared. The score drives iteration and shows progress — it is not a correctness guarantee.
