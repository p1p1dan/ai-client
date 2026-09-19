#!/usr/bin/env node
/**
 * m11-jump-order.mjs — isolate WHY only one of the two hit clicks jumped.
 *
 * `m11-hover.mjs` found that clicking a relative-path hit opened the file AND
 * scrolled to the hit's line, while clicking an absolute-path hit opened the
 * file but stayed on line 1 with `pendingCursor` still parked. Two explanations
 * fit: the path shape, or the ORDER (the first click mounts the editor column,
 * the second only adds a tab to an editor that is already mounted).
 *
 * This runs the same two clicks with the order reversed against the transcript
 * `m11-hover.mjs` left on screen. Whichever variable follows the failure is the
 * cause.
 */
import { Cdp, DEBUG_PORT, sleep } from '/home/ai/code/ai-client/scripts/h21-cdp.mjs';
import { makeEval, shoot, writeJson } from './pc-lib.mjs';

const OUT11 =
  '/home/ai/code/ai-client/docs/plantree/plans/runtime-hardening/evidence/batch-h-devbox-pointcheck-2026-09-19/pointcheck/model-11';

const cdp = await Cdp.attach(DEBUG_PORT, 60_000);
const evalAsync = makeEval(cdp, 'm11o');

const EDITOR_STATE = `
  const ed = await import(/* @vite-ignore */ '/stores/editor.ts');
  const e = ed.useEditorStore.getState();
  return {
    tabs: e.tabs.map((t) => t.path),
    activeTabPath: e.activeTabPath,
    pendingCursor: e.pendingCursor ? JSON.parse(JSON.stringify(e.pendingCursor)) : null,
    currentCursorLine: e.currentCursorLine,
  };
`;

const move = (x, y) => cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0, pointerType: 'mouse' });

async function hoverAndClick(triggerIndex, hitIndex) {
  await move(5, 5);
  await sleep(700);
  const t = (await cdp.evaluate(`(() => [...document.querySelectorAll('[data-slot="preview-card-trigger"]')].map((n) => {
    const b = n.firstElementChild ?? n;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }))()`))[triggerIndex];
  await move(t.x - 6, t.y);
  await sleep(150);
  await move(t.x, t.y);
  await sleep(2200);
  return cdp.evaluate(`(() => {
    const p = [...document.querySelectorAll('[data-slot="preview-card-content"]')].find((n) => n.hasAttribute('data-open'));
    if (!p) throw new Error('popup did not open');
    const b = [...p.querySelectorAll('button')][${hitIndex}];
    if (!b) throw new Error('no hit at index ${hitIndex}');
    const text = (b.innerText || '').trim().replace(/\\s+/g, ' ');
    b.click();
    return text;
  })()`);
}

const out = { probe: 'm11-jump-order.mjs', startedAt: new Date().toISOString(), rounds: [] };
try {
  out.reset = await evalAsync(
    `const ed = await import(/* @vite-ignore */ '/stores/editor.ts');
     ed.useEditorStore.getState().closeAllFiles();
     return ed.useEditorStore.getState().tabs.length;`,
    { label: 'close all tabs' }
  );
  await sleep(1500);

  // Round 1: the ABSOLUTE hit, but now it is the FIRST open.
  const first = await hoverAndClick(1, 0);
  await sleep(8000);
  const afterFirst = await evalAsync(EDITOR_STATE, { label: 'after first open' });
  const shot1 = await shoot(cdp, OUT11, 'model-11-jump-abs-first.png');
  out.rounds.push({ order: 'first', kind: 'absolute', clicked: first, state: afterFirst, screenshot: shot1 });
  console.log('first(absolute):', JSON.stringify(afterFirst));

  // Round 2: the RELATIVE hit, now the SECOND open into a mounted editor.
  const second = await hoverAndClick(0, 0);
  await sleep(8000);
  const afterSecond = await evalAsync(EDITOR_STATE, { label: 'after second open' });
  const shot2 = await shoot(cdp, OUT11, 'model-11-jump-rel-second.png');
  out.rounds.push({ order: 'second', kind: 'relative', clicked: second, state: afterSecond, screenshot: shot2 });
  console.log('second(relative):', JSON.stringify(afterSecond));
} catch (error) {
  out.error = String(error?.stack ?? error?.message ?? error);
  console.error(out.error);
  process.exitCode = 1;
} finally {
  out.finishedAt = new Date().toISOString();
  console.log(`report → ${writeJson(OUT11, 'model-11-jump-order.json', out)}`);
  cdp.close();
}
