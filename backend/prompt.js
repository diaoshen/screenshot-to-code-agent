// prompt.js — system prompt, per-stack instructions, and the iterative task text
// handed to the `claude` CLI. Lifted in spirit from abi/screenshot-to-code's prompts,
// adapted for a CLI agent that drives its own render→score→fix loop.

export function stackInstructions(stack) {
  const map = {
    html_tailwind:
      'STACK = HTML + Tailwind. Single self-contained index file. Include Tailwind via <script src="https://cdn.tailwindcss.com"></script> in <head>. Use only inline HTML + Tailwind utility classes.',
    html_css:
      "STACK = HTML + plain CSS. Single self-contained file with all styles in one <style> tag in <head>. No external CSS frameworks.",
    react_tailwind:
      'STACK = React + Tailwind, all in ONE HTML file. Load React 18, ReactDOM 18, and Babel Standalone from CDN, plus Tailwind via cdn.tailwindcss.com. Put the app in a <script type="text/babel"> block.',
    bootstrap:
      'STACK = HTML + Bootstrap 5. Single self-contained file. Include Bootstrap 5 CSS+JS via CDN. Use Bootstrap components/classes.',
    vue_tailwind:
      'STACK = Vue 3 + Tailwind, in ONE HTML file. Load Vue 3 global build and Tailwind from CDN. Mount to a #app div.',
    ionic_tailwind:
      "STACK = Ionic + Tailwind, in ONE HTML file. Load Ionic core from CDN plus Tailwind. Use Ionic web components.",
  };
  return map[stack] || map.html_tailwind;
}

export const SYSTEM_PROMPT = `You are an elite front-end engineer specializing in pixel-perfect reproduction of UI screenshots.

Rules:
- Reproduce the target screenshot as closely as humanly possible: exact layout, spacing, alignment, colors, typography, sizes, borders, shadows, and especially the EXACT text you can read in the image.
- Do NOT invent content. Copy the visible text verbatim. If text is truncated/unclear, make the closest reasonable guess.
- For images/logos you cannot recreate with CSS, use a neutral placeholder (a solid-colored <div> or https://placehold.co/WxH) sized and positioned like the original.
- Produce a SINGLE self-contained file named output.html. No build step, no external files besides CDN links.
- Prefer semantic, clean markup. Keep it a single file even for React/Vue (via CDN + Babel).
- Be concise in chat; do the real work through the Write/Edit/Bash tools.`;

// The task the agent executes. `rounds` bounds the loop; `score` is the "good enough" bar.
export function buildTask({ stack, rounds = 6, targetScore = 92 }) {
  return `Recreate a UI screenshot as code, then iterate against your own render until it matches.

Your working directory contains:
- target.png  — the screenshot you must reproduce (READ it carefully first).
- render.mjs  — a script that renders YOUR output.html and scores it against target.png.

${stackInstructions(stack)}

Do this loop:
1. Read target.png. Study layout, colors, fonts, spacing, and all visible text.
2. Write output.html — your best first attempt at reproducing it.
3. Run this exact command with the Bash tool:  node render.mjs
   It produces render.png (desktop), render.mobile.png, diff.png, and prints
   "SIMILARITY_SCORE=NN%". It also writes score.json.
4. Read render.png AND diff.png. Compare them to target.png. In diff.png, red/magenta areas
   are where your render differs from the target — focus your fixes there.
5. Use the Edit tool to fix the biggest visual differences (wrong spacing, colors, sizes,
   positions, missing/extra elements, wrong fonts, wrong text).
6. Re-run: node render.mjs  — confirm the score went up. If a change LOWERS the score, revert it.
7. Repeat steps 4–6 until the similarity score is >= ${targetScore}% AND the render looks
   faithful to your eye, OR you have completed ${rounds} improvement rounds. Whichever comes
   first. Do NOT loop forever; stop once it is clearly close.

Optional — real assets: if the screenshot contains a photo/logo/icon you cannot reproduce with
CSS, you may extract it from the screenshot as a real image. Estimate its pixel box in target.png
and run:  node crop.mjs <x> <y> <width> <height> <name>
That writes asset_<name>.png in this directory; reference it with <img src="asset_<name>.png">.
Coordinates are approximate — check the result and re-crop if needed. Skip this if CSS suffices.

Finish by leaving the best version in output.html. In your final message, report the final
similarity score and briefly what still differs, if anything.`;
}

// Update / "refine with an instruction" flow. output.html already contains the current code;
// apply the requested change while keeping the rest faithful.
export function buildUpdateTask({ stack, instruction, rounds = 4, hasTarget = false }) {
  return `Modify an existing single-file web page (output.html) per a change request, keeping it faithful.

${stackInstructions(stack)}

The current code is ALREADY in output.html.${hasTarget ? " target.png is the original design — keep matching it except where the change request overrides it." : ""}

Change request:
"""
${instruction || "(no text provided — make a sensible, conservative improvement)"}
"""

Do this:
1. Read output.html.${hasTarget ? " Read target.png." : ""}
2. Apply ONLY the requested change with the Edit tool. Preserve everything else.
3. Run with the Bash tool:  node render.mjs
   ${hasTarget
     ? "It renders your page and scores it vs target.png (writes render.png, diff.png, score.json)."
     : "It renders your page to render.png so you can view the result (no target to score against)."}
4. Read render.png${hasTarget ? " and diff.png" : ""} to confirm the change looks right and nothing
   else broke.
5. Fix any problems with Edit and re-render. Repeat up to ${rounds} rounds, then stop.

Leave the final version in output.html and briefly report what you changed.`;
}
