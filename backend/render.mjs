// render.mjs — render output.html headless (desktop + mobile) and score it against target.png.
// Run with cwd = the session working dir (which contains output.html + target.png).
// Writes render.png, render.mobile.png, diff.png, score.json and prints SIMILARITY_SCORE=NN%.
//
// Module resolution note: when copied into backend/work/<id>/, imports resolve up-tree to
// backend/node_modules (Node walks parent dirs), so this file needs no local install.

import { chromium } from "playwright";
import sharp from "sharp";
import pixelmatch from "pixelmatch";
import pngjs from "pngjs"; // CJS module — destructure default for reliable ESM interop
import fs from "node:fs";
import path from "node:path";

const { PNG } = pngjs;

const cwd = process.cwd();
const htmlPath = path.join(cwd, "output.html");
const targetPath = path.join(cwd, "target.png");

function writeScoreAtomic(data) {
  const target = path.join(cwd, "score.json");
  const tmp = target + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, target);
}

function fail(msg) {
  // Never throw: write a zero score so the agent loop gets feedback instead of a crash.
  console.error("render.mjs error:", msg);
  const out = { score: 0, diffPixels: -1, width: 0, height: 0, error: String(msg) };
  try { writeScoreAtomic(out); } catch {}
  console.log(`SIMILARITY_SCORE=0.00% (render failed: ${msg})`);
  process.exit(0);
}

if (!fs.existsSync(htmlPath)) fail("output.html not found — write it first.");
const hasTarget = fs.existsSync(targetPath);

let browser;
try {
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  const fileUrl = "file://" + htmlPath;
  try {
    await page.goto(fileUrl, { waitUntil: "networkidle", timeout: 20000 });
  } catch {
    // networkidle can stall on a slow/blocked CDN — fall back to DOM load and continue.
    try { await page.goto(fileUrl, { waitUntil: "load", timeout: 10000 }); } catch {}
  }
  try { await page.evaluate(() => document.fonts && document.fonts.ready); } catch {}
  await page.waitForTimeout(350); // let CSS transitions / late layout settle

  await page.screenshot({ path: path.join(cwd, "render.png"), fullPage: true });

  await page.setViewportSize({ width: 375, height: 812 });
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(cwd, "render.mobile.png"), fullPage: true });

  await browser.close();
  browser = null;

  // No target to compare against (e.g. an update with no original screenshot): render only.
  if (!hasTarget) {
    const out = { score: null, diffPixels: null, width: 0, height: 0, note: "no target.png to score against" };
    writeScoreAtomic(out);
    console.log("RENDERED output.html (no target.png to score against).");
    process.exit(0);
  }

  // Score: compare desktop render against the target at the target's dimensions.
  const meta = await sharp(targetPath).metadata();
  const W = meta.width, H = meta.height;

  const targetRaw = await sharp(targetPath)
    .resize(W, H, { fit: "fill" })
    .ensureAlpha()
    .raw()
    .toBuffer();

  // cover/top: keep the render's aspect ratio, align to top-left, crop overflow — no distortion.
  const renderRaw = await sharp(path.join(cwd, "render.png"))
    .resize(W, H, { fit: "cover", position: "left top" })
    .ensureAlpha()
    .raw()
    .toBuffer();

  const diff = new PNG({ width: W, height: H });
  const diffPixels = pixelmatch(targetRaw, renderRaw, diff.data, W, H, { threshold: 0.1 });
  fs.writeFileSync(path.join(cwd, "diff.png"), PNG.sync.write(diff));

  const score = Math.max(0, 100 * (1 - diffPixels / (W * H)));
  const out = { score: +score.toFixed(2), diffPixels, width: W, height: H };
  writeScoreAtomic(out);
  console.log(`SIMILARITY_SCORE=${out.score}% diffPixels=${diffPixels} (${W}x${H})`);
} catch (e) {
  // Race-timeout browser.close() so a hung browser doesn't stall the agent loop.
  try {
    if (browser) await Promise.race([
      browser.close(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 5000)),
    ]);
  } catch {}
  fail(e?.message || e);
}
