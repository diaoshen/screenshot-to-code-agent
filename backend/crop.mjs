// crop.mjs — extract a real pixel region from target.png as a reusable asset.
// Usage:  node crop.mjs <x> <y> <width> <height> <name>
// Writes asset_<name>.png in the current working dir. Coordinates are in target.png pixels.
// Runs with cwd = a session working dir; imports resolve up-tree to backend/node_modules.

import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";

const [xs, ys, ws, hs, rawName] = process.argv.slice(2);
const x = parseInt(xs, 10), y = parseInt(ys, 10), w = parseInt(ws, 10), h = parseInt(hs, 10);
const name = (rawName || "crop").replace(/[^a-zA-Z0-9_-]/g, "_");

if ([x, y, w, h].some((n) => !Number.isFinite(n)) || w <= 0 || h <= 0) {
  console.error("Usage: node crop.mjs <x> <y> <width> <height> <name>  (x,y,w,h must be integers; w,h > 0)");
  process.exit(1);
}

const cwd = process.cwd();
const target = path.join(cwd, "target.png");
if (!fs.existsSync(target)) {
  console.error("target.png not found in working dir — nothing to crop.");
  process.exit(1);
}

try {
  const meta = await sharp(target).metadata();
  // Clamp the box to the image bounds so an over-estimated region doesn't throw.
  const left = Math.max(0, Math.min(x, meta.width - 1));
  const top = Math.max(0, Math.min(y, meta.height - 1));
  const width = Math.max(1, Math.min(w, meta.width - left));
  const height = Math.max(1, Math.min(h, meta.height - top));
  const out = `asset_${name}.png`;
  await sharp(target).extract({ left, top, width, height }).toFile(path.join(cwd, out));
  console.log(`wrote ${out} (${width}x${height} at ${left},${top})`);
} catch (e) {
  console.error("crop failed:", e?.message || e);
  process.exit(1);
}
