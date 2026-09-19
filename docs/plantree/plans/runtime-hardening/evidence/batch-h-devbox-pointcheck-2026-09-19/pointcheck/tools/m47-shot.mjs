#!/usr/bin/env node
/** Scroll the transcript to the bottom and re-take one screenshot. */
import { Cdp, sleep } from '/home/ai/code/ai-client/scripts/h21-cdp.mjs';
import { EXPAND_WORK_GROUPS, shoot } from './pc-lib.mjs';

const [, , dir, name, mode] = process.argv;
const cdp = await Cdp.attach(9222, 60_000);
if (mode !== 'nogroups') await cdp.evaluate(EXPAND_WORK_GROUPS);
await sleep(800);
console.log(
  'scrolled:',
  await cdp.evaluate(`(() => {
    const vs = [...document.querySelectorAll('[data-slot="scroll-area-viewport"]')];
    let best = null;
    for (const v of vs) if (!best || v.scrollHeight > best.scrollHeight) best = v;
    if (!best) return null;
    best.scrollTop = best.scrollHeight;
    return { top: best.scrollTop, height: best.scrollHeight };
  })()`)
);
await sleep(1500);
console.log('shot:', await shoot(cdp, dir, name));
cdp.close();
setTimeout(() => process.exit(0), 300).unref();
