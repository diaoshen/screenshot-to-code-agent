// make-sample.mjs — generate a sample target.png to test the pipeline against.
// Renders a small reference UI to backend/sample/target.png at desktop width.

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, "sample");
fs.mkdirSync(outDir, { recursive: true });

const html = `<!doctype html><html><head><meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; font-family: -apple-system, Segoe UI, Roboto, sans-serif; }
  body { background:#0f172a; display:flex; align-items:center; justify-content:center; height:720px; }
  .card { background:#fff; width:360px; border-radius:16px; padding:32px; box-shadow:0 20px 50px rgba(0,0,0,.3); }
  h1 { font-size:24px; color:#0f172a; margin-bottom:6px; }
  p.sub { color:#64748b; font-size:14px; margin-bottom:24px; }
  label { display:block; font-size:13px; color:#334155; margin:14px 0 6px; font-weight:600; }
  input { width:100%; padding:11px 12px; border:1px solid #cbd5e1; border-radius:9px; font-size:14px; }
  button { width:100%; margin-top:22px; padding:12px; background:#4f46e5; color:#fff; border:none;
           border-radius:9px; font-size:15px; font-weight:600; cursor:pointer; }
  .foot { text-align:center; margin-top:18px; font-size:13px; color:#64748b; }
  .foot a { color:#4f46e5; text-decoration:none; font-weight:600; }
</style></head>
<body>
  <div class="card">
    <h1>Welcome back</h1>
    <p class="sub">Sign in to your GrowStack account</p>
    <label>Email address</label>
    <input value="you@example.com">
    <label>Password</label>
    <input type="password" value="password">
    <button>Sign in</button>
    <div class="foot">Don't have an account? <a>Sign up</a></div>
  </div>
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.setContent(html, { waitUntil: "networkidle" });
await page.screenshot({ path: path.join(outDir, "target.png") });
await browser.close();
console.log("Wrote", path.join(outDir, "target.png"));
