#!/usr/bin/env node
/**
 * pc-shot.mjs — scroll the open transcript to the top, expand every work group,
 * screenshot, and print the transcript text.
 *
 * Usage: pc-shot.mjs <outDir> <fileName>
 *
 * Exists because `Page.captureScreenshot` only sees the viewport and the first
 * turn of a two-turn session scrolls off the top — the MODEL-23 comparison
 * needs the ASK row on screen, not just in the JSON dump.
 */
import { Cdp, DEBUG_PORT, sleep } from '/home/ai/code/ai-client/scripts/h21-cdp.mjs';
import { EXPAND_WORK_GROUPS, shoot } from './pc-lib.mjs';

const [outDir, fileName] = process.argv.slice(2);
if (!outDir || !fileName) throw new Error('usage: pc-shot.mjs <outDir> <fileName>');

const cdp = await Cdp.attach(DEBUG_PORT, 60_000);
try {
  console.log(JSON.stringify(await cdp.evaluate(EXPAND_WORK_GROUPS)));
  await sleep(1200);
  const scrolled = await cdp.evaluate(`(() => {
    const viewports = [...document.querySelectorAll('[data-slot="scroll-area-viewport"]')];
    let best = null;
    let bestScore = -1;
    for (const v of viewports) {
      const text = v.innerText || '';
      // The transcript is the viewport holding the composer's sibling turns;
      // scored by the markers a turn always has, whichever build painted it.
      const score = (text.match(/Worked for|steps processed|已思考|已询问|读取/g) || []).length;
      if (score > bestScore) { bestScore = score; best = v; }
    }
    if (!best) return null;
    best.scrollTop = 0;
    return { score: bestScore, text: (best.innerText || '').slice(0, 6000) };
  })()`);
  await sleep(1200);
  const file = await shoot(cdp, outDir, fileName);
  console.log(`screenshot → ${file}`);
  console.log(scrolled?.text ?? '(no transcript viewport found)');
} finally {
  cdp.close();
}
