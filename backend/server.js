// server.js — HTTP + WebSocket backend that speaks the abi/screenshot-to-code frontend protocol
// but is powered by the local `claude` CLI (Pro Max) driving an iterative render→score→fix loop.
//
// Phase 3: multiple variants in parallel (e.g. Opus + Sonnet), and an "update / refine with an
// instruction" flow that seeds the existing code and applies a change while keeping fidelity.

import express from "express";
import http from "node:http";
import { WebSocketServer } from "ws";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildTask, buildUpdateTask, SYSTEM_PROMPT } from "./prompt.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 7001);
const RENDER_SCRIPT = path.join(__dirname, "render.mjs");
const CROP_SCRIPT = path.join(__dirname, "crop.mjs");
const WORK_ROOT = path.join(__dirname, "work");
const MAX_ROUNDS = Number(process.env.MAX_ROUNDS || 6);
const HARD_TIMEOUT_MS = Number(process.env.HARD_TIMEOUT_MS || 10 * 60 * 1000);
// Default variant model plan. Override with VARIANT_MODELS="opus,sonnet,opus" or VARIANTS=1.
const VARIANT_MODELS = (process.env.VARIANT_MODELS || "opus,sonnet")
  .split(",").map((s) => s.trim()).filter(Boolean);
fs.mkdirSync(WORK_ROOT, { recursive: true });

// Frontend close codes (see frontend/src/constants.ts)
const CLOSE_OK = 1000;
const CLOSE_APP_ERROR = 4332;

const app = express();
// Frontend runs cross-origin (http://localhost:5173). Restrict to that origin only.
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "http://localhost:5173");
  res.header("Access-Control-Allow-Headers", "*");
  res.header("Access-Control-Allow-Methods", "*");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
// The frontend proxies /api/* and /local-assets/* to the backend. We don't need them,
// but stub responses so the UI never errors on load.
app.get("/health", (_req, res) => res.json({ ok: true }));
app.all(/^\/api\/.*/, (_req, res) => res.json({}));
app.all(/^\/local-assets\/.*/, (_req, res) => res.status(204).end());

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/generate-code" });

let sessionCounter = 0;
let _eventCounter = 0; // unique fallback for eventIds when the CLI omits an ID
const MAX_CONCURRENT_SOCKETS = Number(process.env.MAX_CONCURRENT_SOCKETS || 10);

wss.on("connection", (ws) => {
  if (wss.clients.size > MAX_CONCURRENT_SOCKETS) {
    ws.close(CLOSE_APP_ERROR, "Too many concurrent sessions.");
    return;
  }
  const procs = [];
  const timers = [];
  let started = false;
  let closed = false;
  let sessionBaseDir = null; // set once run() creates it; cleaned up on close

  const send = (obj) => {
    if (ws.readyState === ws.OPEN) {
      try { ws.send(JSON.stringify(obj)); } catch {}
    }
  };
  const killProc = (p) => {
    if (!p || p.killed) return;
    try {
      // Kill the entire process group so grandchildren (e.g. Playwright Chromium
      // spawned by render.mjs) also receive SIGKILL. detached:true on spawn puts
      // claude and its descendants in their own process group (pgid = proc.pid).
      if (p.pid) process.kill(-p.pid, "SIGKILL");
    } catch {}
  };

  const cleanup = () => {
    timers.forEach((t) => { clearInterval(t); clearTimeout(t); });
    procs.forEach(killProc);
    // Remove the session work dir once the socket is done to prevent disk fill.
    if (sessionBaseDir) {
      try { fs.rmSync(sessionBaseDir, { recursive: true, force: true }); } catch {}
      sessionBaseDir = null;
    }
  };

  ws.on("close", () => { closed = true; cleanup(); });
  ws.on("error", () => { closed = true; cleanup(); });

  ws.on("message", (raw) => {
    if (started) return; // one generation per socket; ignore anything after the first params msg
    started = true;
    let params;
    try {
      params = JSON.parse(raw.toString());
    } catch {
      send({ type: "error", value: "Malformed params JSON." });
      return ws.close(CLOSE_APP_ERROR);
    }
    try {
      run(params);
    } catch (e) {
      if (closed) return;
      send({ type: "error", value: String(e?.message || e) });
      try { ws.close(CLOSE_APP_ERROR); } catch {}
    }
  });

  function run(params) {
    const id = `sess-${Date.now()}-${++sessionCounter}`;
    const baseDir = path.join(WORK_ROOT, id);
    fs.mkdirSync(baseDir, { recursive: true });
    sessionBaseDir = baseDir; // tracked for cleanup on WS close

    const isUpdate = params.generationType === "update";
    const instruction = params?.prompt?.text || params?.prompt?.fullText || "";
    const seedHtml = params?.fileState?.content ||
      (Array.isArray(params?.optionCodes) && params.optionCodes[0]) || "";

    // Decode the original screenshot (prompt.images[0]) once, if present.
    let targetBuf = null;
    const images = params?.prompt?.images || [];
    const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MB cap before decode
    if (images.length && typeof images[0] === "string") {
      const b64 = images[0].replace(/^data:[^,]*,/, "");
      if (b64.length * 0.75 > MAX_IMAGE_BYTES) {
        send({ type: "variantCount", value: "1" });
        send({ type: "variantError", value: "Screenshot too large (max 20 MB).", variantIndex: 0 });
        return ws.close(CLOSE_APP_ERROR);
      }
      try { targetBuf = Buffer.from(b64, "base64"); } catch {}
    }

    // Create needs a screenshot. Update can proceed from existing code alone.
    if (!isUpdate && !targetBuf) {
      send({ type: "variantCount", value: "1" });
      send({ type: "variantError", value: "No screenshot provided.", variantIndex: 0 });
      return ws.close(CLOSE_APP_ERROR);
    }
    if (isUpdate && !seedHtml) {
      send({ type: "variantCount", value: "1" });
      send({ type: "variantError", value: "Update requested but no existing code was provided.", variantIndex: 0 });
      return ws.close(CLOSE_APP_ERROR);
    }

    const stack = params.generatedCodeConfig || "html_tailwind";
    const requested = /sonnet/i.test(params.codeGenerationModel || "") ? "sonnet" : null;
    // If the user explicitly picked a model, honor it for a single variant; else run the plan.
    const models = requested ? [requested] : VARIANT_MODELS.slice();
    const N = Math.max(1, models.length);

    send({ type: "variantCount", value: String(N) });
    send({ type: "variantModels", data: { models: models.map((m) => `${m} · Claude Code (Pro Max)`) } });

    let remaining = N;
    const finishOne = () => {
      remaining -= 1;
      if (remaining <= 0 && !closed) { try { ws.close(CLOSE_OK); } catch {} }
    };

    // Hard wall-clock timeout kills every variant and force-closes the socket.
    // The normal path (proc 'close' → finishVariant → ws.close) can miss if a
    // proc fires 'error' without 'close' (e.g. ENOENT), leaving remaining > 0 forever.
    const killTimer = setTimeout(() => {
      procs.forEach(killProc);
      if (!closed) { try { ws.close(CLOSE_APP_ERROR, "Hard timeout reached."); } catch {} }
    }, HARD_TIMEOUT_MS);
    timers.push(killTimer);

    for (let vi = 0; vi < N; vi++) startVariant(vi, models[vi], { baseDir, id, isUpdate, instruction, seedHtml, targetBuf, stack, finishOne });
  }

  function startVariant(vi, model, ctx) {
    const { baseDir, id, isUpdate, instruction, seedHtml, targetBuf, stack, finishOne } = ctx;
    const dir = path.join(baseDir, `v${vi}`);
    fs.mkdirSync(dir, { recursive: true });
    if (targetBuf) fs.writeFileSync(path.join(dir, "target.png"), targetBuf);
    fs.copyFileSync(RENDER_SCRIPT, path.join(dir, "render.mjs"));
    fs.copyFileSync(CROP_SCRIPT, path.join(dir, "crop.mjs"));
    const outFile = path.join(dir, "output.html");
    const scoreFile = path.join(dir, "score.json");
    if (isUpdate && seedHtml) fs.writeFileSync(outFile, seedHtml);

    send({ type: "status", value: isUpdate ? "Applying changes…" : "Starting agent…", variantIndex: vi });

    // Poll working dir → stream code + score to the UI for this variant.
    let lastCode = "";
    let lastScoreStamp = 0;
    const poll = setInterval(() => {
      try {
        if (fs.existsSync(outFile)) {
          const c = fs.readFileSync(outFile, "utf8");
          if (c && c !== lastCode) {
            lastCode = c;
            send({ type: "setCode", value: c, variantIndex: vi });
          }
        }
      } catch {}
      try {
        if (fs.existsSync(scoreFile)) {
          const stamp = fs.statSync(scoreFile).mtimeMs;
          if (stamp !== lastScoreStamp) {
            const s = JSON.parse(fs.readFileSync(scoreFile, "utf8"));
            lastScoreStamp = stamp; // commit stamp only after successful parse
            let msg;
            if (s.error) msg = `Render failed: ${s.error}`;
            else if (s.score == null) msg = "Rendered (no target to score against).";
            else msg = `Similarity ${s.score}% (diff ${s.diffPixels}px)`;
            send({ type: "status", value: msg, variantIndex: vi });
          }
        }
      } catch {}
    }, 700);
    timers.push(poll);

    const task = isUpdate
      ? buildUpdateTask({ stack, instruction, rounds: MAX_ROUNDS, hasTarget: !!targetBuf })
      : buildTask({ stack, rounds: MAX_ROUNDS });
    const args = [
      "-p", task,
      "--model", model,
      "--output-format", "stream-json",
      "--verbose",
      "--append-system-prompt", SYSTEM_PROMPT,
      "--allowedTools", "Read Write Edit Bash",
      "--dangerously-skip-permissions",
    ];
    // stdin 'ignore' so `claude -p` doesn't wait 3s for piped stdin that never comes.
    // detached:true puts claude and all its children in a new process group so that
    // killProc() can SIGKILL the whole group (including Playwright Chromium) atomically.
    const proc = spawn("claude", args, { cwd: dir, env: process.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    procs.push(proc);

    let buf = "";
    let finished = false; // guard: proc can emit both "error" then "close"; call finishOne only once
    const finishVariant = () => { if (!finished) { finished = true; finishOne(); } };

    proc.stdout.on("data", (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        handleLine(line, vi);
      }
    });
    proc.stderr.on("data", (d) => process.stderr.write(`[claude:${id}:v${vi}] ${d}`));

    proc.on("error", (e) => {
      clearInterval(poll);
      if (closed) return;
      send({ type: "variantError", value: `Failed to start claude CLI: ${e.message}`, variantIndex: vi });
      finishVariant(); // sets finished=true — close handler will skip its own send
    });

    proc.on("close", (code) => {
      clearInterval(poll);
      // Flush any stdout that didn't end with a newline (the last JSON line from
      // claude --output-format stream-json is sometimes not newline-terminated).
      if (buf.trim()) { try { handleLine(buf.trim(), vi); } catch {} }
      buf = "";
      // Bail out early if the socket is already closed or proc.on('error') already
      // reported this variant — avoids a stale setCode send and duplicate messages.
      if (closed || finished) { finishVariant(); return; }
      try {
        if (fs.existsSync(outFile)) {
          const c = fs.readFileSync(outFile, "utf8");
          if (c) send({ type: "setCode", value: c, variantIndex: vi });
        }
      } catch {}
      let produced = false;
      try { produced = fs.existsSync(outFile) && fs.statSync(outFile).size > 0; } catch {}
      if (code === 0 || produced) send({ type: "variantComplete", variantIndex: vi });
      else send({ type: "variantError", value: `Agent exited (code ${code}) with no output.`, variantIndex: vi });
      finishVariant();
    });
  }

  function handleLine(line, vi) {
    const s = line.trim();
    if (!s) return;
    let ev;
    try { ev = JSON.parse(s); } catch { return; } // ignore any non-JSON noise
    try {
      if (ev.type === "assistant" && ev.message?.content) {
        for (const b of ev.message.content) {
          if (b.type === "text" && b.text?.trim()) {
            send({ type: "assistant", value: b.text, variantIndex: vi, eventId: ev.message.id || `asst-${vi}-${++_eventCounter}` });
          } else if (b.type === "tool_use") {
            send({ type: "toolStart", data: { name: b.name, input: summarizeToolInput(b.name, b.input) }, variantIndex: vi, eventId: b.id || `tool-${vi}-${++_eventCounter}` });
          }
        }
      }
    } catch {}
  }

  function summarizeToolInput(name, input) {
    if (!input) return "";
    if (name === "Bash") return input.command || "";
    if (name === "Read" || name === "Write" || name === "Edit") return input.file_path || "";
    try { return JSON.stringify(input).slice(0, 200); } catch { return ""; }
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Screenshot-to-code (agent) backend listening:`);
  console.log(`  WebSocket : ws://127.0.0.1:${PORT}/generate-code`);
  console.log(`  HTTP      : http://127.0.0.1:${PORT}/health`);
  console.log(`  Variants  : ${VARIANT_MODELS.join(" + ")}  Max rounds: ${MAX_ROUNDS}  Timeout: ${Math.round(HARD_TIMEOUT_MS / 1000)}s`);
});
