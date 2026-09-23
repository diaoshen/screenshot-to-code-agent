// test-loop.mjs — headless smoke test of the CLI agent loop (no browser UI).
// Sets up a temp workdir with a sample target.png, spawns `claude` with a low round cap,
// streams its stream-json output to the console, and prints the final similarity score.
//
//   node make-sample.mjs      # once, to create sample/target.png
//   MAX_ROUNDS=2 node test-loop.mjs

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildTask, SYSTEM_PROMPT } from "./prompt.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rounds = Number(process.env.MAX_ROUNDS || 2);
const stack = process.env.STACK || "html_tailwind";
const model = process.env.MODEL || "opus";

const samplePng = path.join(__dirname, "sample", "target.png");
if (!fs.existsSync(samplePng)) {
  console.error("Missing sample/target.png. Run:  node make-sample.mjs");
  process.exit(1);
}

const dir = path.join(__dirname, "work", `test-${Date.now()}`);
fs.mkdirSync(dir, { recursive: true });
fs.copyFileSync(samplePng, path.join(dir, "target.png"));
fs.copyFileSync(path.join(__dirname, "render.mjs"), path.join(dir, "render.mjs"));
console.log("Workdir:", dir, "\nModel:", model, "Rounds:", rounds, "Stack:", stack, "\n---");

const args = [
  "-p", buildTask({ stack, rounds }),
  "--model", model,
  "--output-format", "stream-json",
  "--verbose",
  "--append-system-prompt", SYSTEM_PROMPT,
  "--allowedTools", "Read Write Edit Bash",
  "--dangerously-skip-permissions",
];

const proc = spawn("claude", args, { cwd: dir, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
let buf = "";
proc.stdout.on("data", (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === "assistant" && ev.message?.content) {
      for (const b of ev.message.content) {
        if (b.type === "text" && b.text?.trim()) console.log("💬", b.text.trim().slice(0, 300));
        else if (b.type === "tool_use") console.log("🔧", b.name, JSON.stringify(b.input).slice(0, 160));
      }
    } else if (ev.type === "result") {
      console.log("🏁 result:", (ev.result || "").slice(0, 300));
    }
  }
});
proc.stderr.on("data", (d) => process.stderr.write(String(d)));
proc.on("close", (code) => {
  console.log("\n--- claude exited", code, "---");
  const scoreFile = path.join(dir, "score.json");
  if (fs.existsSync(scoreFile)) console.log("FINAL score.json:", fs.readFileSync(scoreFile, "utf8"));
  const out = path.join(dir, "output.html");
  console.log(fs.existsSync(out) ? `output.html written (${fs.statSync(out).size} bytes)` : "NO output.html produced");
});
