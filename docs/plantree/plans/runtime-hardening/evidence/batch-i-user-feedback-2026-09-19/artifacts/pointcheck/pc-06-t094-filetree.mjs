/**
 * T094 — the file tree must repaint after an in-app delete / create, with
 * nobody pressing refresh.
 *
 * Scratch files live in THIS evidence directory: `--open-path` did not move the
 * app's active workspace off the repo, and the only place inside the repo where
 * deleting a file is safe is a directory this point-check made itself.
 *
 * Two things about this tree make a naive probe report nonsense, both learned
 * the hard way here:
 *   1. it is VIRTUALIZED — an off-screen row is not in the DOM, so "not found"
 *      means "scroll", not "absent";
 *   2. names are not unique — `docs/plans` and `docs/plantree/plans` are both
 *      「plans」, and a name-only match clicks the wrong one and then reports
 *      that the right one never appeared.
 * Rows are therefore addressed by (name, depth), with depth read off the
 * inline `padding-left` the tree uses for indentation: `depth * 12 + 8` px,
 * which is the design system's indent rule.
 */
import fs from 'node:fs';
import path from 'node:path';
import { connect, save, shot, sleep, stamp } from './lib.mjs';

const DEMO = path.join(
  '/home/ai/code/ai-client/docs/plantree/plans/runtime-hardening/evidence',
  'batch-i-user-feedback-2026-09-19/artifacts/pointcheck/tree-demo'
);
/** name → depth, counting the workspace root's children as depth 0. */
const PATH_PARTS = [
  ['docs', 0], ['plantree', 1], ['plans', 2], ['runtime-hardening', 3], ['evidence', 4],
  ['batch-i-user-feedback-2026-09-19', 5], ['artifacts', 6], ['pointcheck', 7], ['tree-demo', 8],
];
const FILE_DEPTH = 9;

const { cdp } = await connect();

const PANEL = `(() => {
  const vps = [...document.querySelectorAll('[data-slot="scroll-area-viewport"]')]
    .filter((v) => v.offsetParent !== null);
  return vps.find((v) => /node_modules|package\\.json|tsconfig/.test(v.innerText || '')) ?? null;
})()`;

/** All rows currently in the DOM, as {name, depth}. */
const ROWS = `(() => {
  const p = ${PANEL};
  if (!p) return { ok: false };
  const rows = [...p.querySelectorAll('[role="button"], [role="treeitem"]')]
    .filter((n) => n.offsetParent !== null)
    .map((n) => ({
      name: (n.textContent || '').trim(),
      depth: Math.round((parseFloat(getComputedStyle(n).paddingLeft) - 8) / 12),
      top: Math.round(n.getBoundingClientRect().top),
    }))
    .filter((r) => r.name);
  return { ok: true, rows, scrollTop: p.scrollTop, max: p.scrollHeight - p.clientHeight };
})()`;

const rowAt = (name, depth) => `(() => {
  const p = ${PANEL};
  if (!p) return null;
  return [...p.querySelectorAll('[role="button"], [role="treeitem"]')]
    .filter((n) => n.offsetParent !== null)
    .find((n) => (n.textContent || '').trim() === ${JSON.stringify(name)} &&
      Math.round((parseFloat(getComputedStyle(n).paddingLeft) - 8) / 12) === ${depth}) ?? null;
})()`;

const scrollPanel = (top) => `(() => { const p = ${PANEL}; if (p) p.scrollTop = ${top}; return p ? p.scrollTop : null; })()`;
const panelMax = `(() => { const p = ${PANEL}; return p ? p.scrollHeight - p.clientHeight : 0; })()`;

/** Scroll the whole panel looking for (name, depth); `act` runs on a hit. */
async function sweep(name, depth, act) {
  const max = await cdp.evaluate(panelMax);
  for (let top = 0; top <= max + 240; top += 240) {
    await cdp.evaluate(scrollPanel(top));
    await sleep(160);
    const hit = await cdp.evaluate(`(() => {
      const n = ${rowAt(name, depth)};
      if (!n) return null;
      ${act}
    })()`);
    if (hit) return { ...hit, atScrollTop: top };
  }
  return null;
}

const has = (name, depth) => sweep(name, depth, `return { found: true };`);
const click = (name, depth) => sweep(name, depth, `n.click(); return { clicked: true };`);
const rect = (name, depth) => sweep(name, depth, `
  n.scrollIntoView({ block: 'center' });
  const r = n.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
`);

const presence = `(() => {
  const p = ${PANEL};
  const text = p ? (p.innerText || '') : '';
  return { t: Date.now(), alpha: text.includes('alpha.txt'), beta: text.includes('beta.txt'),
           gamma: text.includes('gamma.txt'), delta: text.includes('delta.txt') };
})()`;

async function rightClick(x, y) {
  const base = { x, y, button: 'right', buttons: 2, clickCount: 1 };
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  await sleep(150);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
  await sleep(80);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
}

const MENU = `(() => {
  const popups = [...document.querySelectorAll('[data-slot="menu-popup"], [role="menu"]')]
    .filter((n) => n.offsetParent !== null);
  return popups.map((p) => [...p.querySelectorAll('[role="menuitem"], button')]
    .map((b) => (b.textContent || '').trim()).filter(Boolean));
})()`;

try {
  if (!fs.existsSync(DEMO)) fs.mkdirSync(DEMO, { recursive: true });
  for (const [f, body] of [['alpha.txt', 'a\n'], ['beta.txt', 'b\n'], ['gamma.txt', 'c\n']]) {
    if (!fs.existsSync(path.join(DEMO, f))) fs.writeFileSync(path.join(DEMO, f), body);
  }
  fs.rmSync(path.join(DEMO, 'delta.txt'), { force: true });
  console.log('files on disk before:', fs.readdirSync(DEMO).join(', '));

  console.log('open 文件 panel:', await cdp.evaluate(`(() => {
    const b = document.querySelector('nav[aria-label="主导航"] button[aria-label="文件"]');
    if (!b) return 'no button';
    if (b.getAttribute('aria-pressed') === 'true') return 'already open';
    b.click();
    return 'clicked';
  })()`));
  await sleep(2500);
  save('06-00-panel.json', await cdp.evaluate(ROWS));

  for (let i = 0; i < PATH_PARTS.length; i += 1) {
    const [name, depth] = PATH_PARTS[i];
    const [childName, childDepth] = PATH_PARTS[i + 1] ?? ['alpha.txt', FILE_DEPTH];
    let ok = null;
    for (let attempt = 0; attempt < 3 && !ok; attempt += 1) {
      if (await has(childName, childDepth)) { ok = { via: 'already open', attempt }; break; }
      const c = await click(name, depth);
      if (!c) { ok = null; break; }
      await sleep(1300);
      if (await has(childName, childDepth)) ok = { via: 'clicked', attempt, atScrollTop: c.atScrollTop };
    }
    console.log(`expand ${name}@${depth} (expect ${childName}@${childDepth}):`, JSON.stringify(ok));
    if (!ok) {
      save('06-01-expand-failed.json', { name, depth, childName, rows: await cdp.evaluate(ROWS) });
      throw new Error(`could not expand ${name}`);
    }
  }
  await sleep(800);
  console.log('presence:', JSON.stringify(await cdp.evaluate(presence)));
  await rect('tree-demo', 8);
  console.log('shot:', await shot(cdp, '06-a-tree-expanded.png'));
  save('06-02-expanded.json', await cdp.evaluate(ROWS));

  // ---- delete beta.txt from inside the app ---------------------------------
  const r = await rect('beta.txt', FILE_DEPTH);
  console.log('beta.txt rect:', JSON.stringify(r));
  if (!r) throw new Error('beta.txt row not reachable');
  await rightClick(r.x, r.y);
  await sleep(900);
  const menu = await cdp.evaluate(MENU);
  console.log('file context menu:', JSON.stringify(menu));
  save('06-03-file-menu.json', menu);
  console.log('shot:', await shot(cdp, '06-b-file-menu.png'));

  console.log('删除 click:', JSON.stringify(await cdp.evaluate(`(() => {
    const hit = [...document.querySelectorAll('[role="menuitem"], [data-slot="menu-item"], button')]
      .filter((n) => n.offsetParent !== null)
      .find((n) => /^(删除|删除文件)$/.test((n.textContent || '').trim()));
    if (!hit) return { ok: false };
    hit.click();
    return { ok: true, text: (hit.textContent || '').trim() };
  })()`)));
  await sleep(1000);
  const confirm = await cdp.evaluate(`(() => {
    const d = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], [data-slot="alert-dialog-popup"], [data-slot="dialog-popup"]')]
      .filter((n) => n.offsetParent !== null)[0];
    if (!d) return { ok: false, why: 'no dialog' };
    const text = (d.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 300);
    const buttons = [...d.querySelectorAll('button')].filter((b) => b.offsetParent !== null);
    const hit = buttons.find((b) => /^(删除|确认|确定)$/.test((b.textContent || '').trim())) ?? buttons[buttons.length - 1];
    hit.click();
    return { ok: true, text, clicked: (hit.textContent || '').trim() };
  })()`);
  console.log('delete confirm:', JSON.stringify(confirm));

  const deletedAt = Date.now();
  const deleteSeries = [];
  for (let i = 0; i < 20; i += 1) {
    await sleep(250);
    const p = await cdp.evaluate(presence);
    deleteSeries.push({ dt: p.t - deletedAt, ...p });
    if (!p.beta) break;
  }
  const gone = deleteSeries[deleteSeries.length - 1];
  console.log(`beta.txt gone from tree after ${gone.dt}ms (still present: ${gone.beta}); disk: ${fs.readdirSync(DEMO).join(', ')}`);
  save('06-04-delete-series.json', { deletedAt, deleteSeries, disk: fs.readdirSync(DEMO) });
  console.log('shot:', await shot(cdp, '06-c-after-delete.png'));

  // ---- create delta.txt from inside the app --------------------------------
  const dr = await rect('tree-demo', 8);
  await rightClick(dr.x, dr.y);
  await sleep(900);
  const dirMenu = await cdp.evaluate(MENU);
  console.log('dir context menu:', JSON.stringify(dirMenu));
  save('06-05-dir-menu.json', dirMenu);
  console.log('新建文件 click:', JSON.stringify(await cdp.evaluate(`(() => {
    const hit = [...document.querySelectorAll('[role="menuitem"], [data-slot="menu-item"], button')]
      .filter((n) => n.offsetParent !== null)
      .find((n) => /新建文件|New file/.test((n.textContent || '').trim()));
    if (!hit) return { ok: false };
    hit.click();
    return { ok: true, text: (hit.textContent || '').trim() };
  })()`)));
  await sleep(1200);
  const typed = await cdp.evaluate(`(() => {
    const el = document.activeElement && document.activeElement.tagName === 'INPUT'
      ? document.activeElement
      : [...document.querySelectorAll('input')].filter((n) => n.offsetParent !== null).pop();
    if (!el) return { ok: false };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, 'delta.txt');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return { ok: true, value: el.value, placeholder: el.placeholder };
  })()`);
  console.log('typed name:', JSON.stringify(typed));
  for (const type of ['keyDown', 'keyUp']) {
    await cdp.send('Input.dispatchKeyEvent', {
      type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
    });
  }
  const createdAt = Date.now();
  const createSeries = [];
  for (let i = 0; i < 20; i += 1) {
    await sleep(250);
    const p = await cdp.evaluate(presence);
    createSeries.push({ dt: p.t - createdAt, ...p });
    if (p.delta) break;
  }
  const appeared = createSeries[createSeries.length - 1];
  console.log(`delta.txt in tree after ${appeared.dt}ms (present: ${appeared.delta}); disk: ${fs.readdirSync(DEMO).join(', ')}`);
  save('06-06-create-series.json', { createdAt, createSeries, disk: fs.readdirSync(DEMO) });
  console.log('shot:', await shot(cdp, '06-d-after-create.png'));
  console.log(`[${stamp()}] done`);
} finally {
  cdp.close();
}
