/**
 * Addendum check 1 — T103 (app-drawn delete confirmation) + the T094 delete
 * half that the first batch-I run could not reach.
 *
 * Built on `pc-06-t094-filetree.mjs` (virtualized tree, rows addressed by
 * name+depth read off `padding-left = depth * 12 + 8`) and on
 * `pc-06d-t094-realclick.mjs` (trusted `Input.dispatchMouseEvent` for menu
 * items, every post-click read raced against a timeout so an unresponsive
 * renderer is reported instead of hanging the probe).
 *
 * Fixtures live one level deeper than last time — `tree-demo/alpha/beta.txt`
 * — so the folder case has a real directory to right-click.
 *
 * The tree COMPACTS single-child directory chains the way VS Code does, so
 * `tree-demo` + `alpha` render as ONE row named 「tree-demo/alpha」 at depth 8
 * and the files sit at depth 9. Addressing `alpha` as its own row finds
 * nothing and reads as "could not expand".
 */
import fs from 'node:fs';
import path from 'node:path';
import { connect, save, shot, sleep, stamp } from './lib.mjs';

const DEMO = path.join(
  '/home/ai/code/ai-client/docs/plantree/plans/runtime-hardening/evidence',
  'batch-i-user-feedback-2026-09-19/artifacts/pointcheck/tree-demo'
);
const ALPHA = path.join(DEMO, 'alpha');
const PATH_PARTS = [
  ['docs', 0], ['plantree', 1], ['plans', 2], ['runtime-hardening', 3], ['evidence', 4],
  ['batch-i-user-feedback-2026-09-19', 5], ['artifacts', 6], ['pointcheck', 7],
  ['tree-demo/alpha', 8],
];
const DIR_ROW = 'tree-demo/alpha';
const DIR_DEPTH = 8;
const FILE_DEPTH = 9;

const { cdp } = await connect();

const PANEL = `(() => {
  const vps = [...document.querySelectorAll('[data-slot="scroll-area-viewport"]')]
    .filter((v) => v.offsetParent !== null);
  return vps.find((v) => /node_modules|package\\.json|tsconfig/.test(v.innerText || '')) ?? null;
})()`;

const ROWS = `(() => {
  const p = ${PANEL};
  if (!p) return { ok: false };
  const rows = [...p.querySelectorAll('[role="button"], [role="treeitem"]')]
    .filter((n) => n.offsetParent !== null)
    .map((n) => ({
      name: (n.textContent || '').trim(),
      depth: Math.round((parseFloat(getComputedStyle(n).paddingLeft) - 8) / 12),
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

/** Which of the fixture names the tree is currently painting. */
const presence = `(() => {
  const p = ${PANEL};
  const text = p ? (p.innerText || '') : '';
  return { t: Date.now(), alphaDir: text.includes('tree-demo/alpha'),
           beta: text.includes('beta.txt'), gamma: text.includes('gamma.txt') };
})()`;

const MENU = `(() => {
  const popups = [...document.querySelectorAll('[data-slot="menu-popup"], [role="menu"]')]
    .filter((n) => n.offsetParent !== null);
  return popups.map((p) => [...p.querySelectorAll('[role="menuitem"], button')]
    .map((b) => (b.textContent || '').trim()).filter(Boolean));
})()`;

/** Everything a human would read off the confirmation box. */
const DIALOG = `(() => {
  const vis = (n) => n.offsetParent !== null;
  const d = [...document.querySelectorAll('[role="dialog"],[role="alertdialog"],[data-slot="dialog-popup"],[data-slot="alert-dialog-popup"]')].filter(vis)[0];
  if (!d) return null;
  const title = d.querySelector('[data-slot="alert-dialog-title"]');
  const desc = d.querySelector('[data-slot="alert-dialog-description"]');
  return {
    role: d.getAttribute('role'),
    dataSlot: d.getAttribute('data-slot'),
    title: title ? (title.textContent || '').trim() : null,
    description: desc ? (desc.textContent || '').trim() : null,
    text: (d.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 400),
    buttons: [...d.querySelectorAll('button')].filter(vis).map((b) => (b.textContent || '').trim()),
  };
})()`;

async function mouse(type, x, y, button, buttons) {
  await cdp.send('Input.dispatchMouseEvent', { type, x, y, button, buttons, clickCount: 1 });
}
async function rightClick(x, y) {
  await mouse('mouseMoved', x, y, 'none', 0);
  await sleep(150);
  await mouse('mousePressed', x, y, 'right', 2);
  await sleep(80);
  await mouse('mouseReleased', x, y, 'right', 2);
}
async function leftClick(x, y) {
  await mouse('mouseMoved', x, y, 'none', 0);
  await sleep(150);
  await mouse('mousePressed', x, y, 'left', 1);
  await sleep(80);
  await mouse('mouseReleased', x, y, 'left', 1);
}

/** Read the page WITHOUT the risk of hanging on a frozen renderer. */
async function guarded(expr, label, ms = 10_000) {
  const t0 = Date.now();
  const out = await Promise.race([
    cdp.evaluate(expr).then((v) => ({ alive: true, value: v })).catch((e) => ({ alive: true, error: String(e.message) })),
    new Promise((r) => setTimeout(() => r({ alive: false }), ms)),
  ]);
  out.ms = Date.now() - t0;
  console.log(`  ${label} (${out.ms}ms): ${out.alive ? JSON.stringify(out.value ?? out.error).slice(0, 320) : 'RENDERER DID NOT ANSWER'}`);
  return out;
}

/** Round-trip latency of a trivial evaluate — the liveness measurement. */
async function pings(n, label) {
  const ms = [];
  for (let i = 0; i < n; i += 1) {
    const t0 = Date.now();
    const g = await guarded(`1 + 1`, `${label} ping ${i}`, 10_000);
    ms.push(g.alive ? Date.now() - t0 : null);
    await sleep(200);
  }
  return ms;
}

/** Right-click a row and click 「删除」 in the menu that opens. */
async function openDeleteMenu(name, depth, tag) {
  const r = await rect(name, depth);
  console.log(`${tag}: ${name}@${depth} rect ${JSON.stringify(r)}`);
  if (!r) throw new Error(`${name}@${depth} not reachable`);
  await rightClick(r.x, r.y);
  await sleep(1000);
  const menu = await cdp.evaluate(MENU);
  console.log(`${tag}: context menu ${JSON.stringify(menu)}`);
  const item = await cdp.evaluate(`(() => {
    const popups = [...document.querySelectorAll('[data-slot="menu-popup"], [role="menu"]')]
      .filter((n) => n.offsetParent !== null);
    for (const p of popups) {
      const hit = [...p.querySelectorAll('[role="menuitem"], button')]
        .find((b) => (b.textContent || '').trim() === '删除');
      if (hit) { const b = hit.getBoundingClientRect();
        return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; }
    }
    return null;
  })()`);
  if (!item) throw new Error(`${tag}: 删除 item not found`);
  console.log(`[${stamp()}] ${tag}: trusted click on 删除 at ${item.x},${item.y}`);
  const clickedAt = Date.now();
  await leftClick(item.x, item.y);
  return { menu, clickedAt };
}

/** Click a footer button of the open confirmation box, by exact label. */
async function clickDialogButton(label) {
  const pos = await cdp.evaluate(`(() => {
    const vis = (n) => n.offsetParent !== null;
    const d = [...document.querySelectorAll('[role="dialog"],[role="alertdialog"],[data-slot="dialog-popup"],[data-slot="alert-dialog-popup"]')].filter(vis)[0];
    if (!d) return null;
    const hit = [...d.querySelectorAll('button')].filter(vis)
      .find((b) => (b.textContent || '').trim() === ${JSON.stringify(label)});
    if (!hit) return null;
    const b = hit.getBoundingClientRect();
    return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
  })()`);
  if (!pos) throw new Error(`no 「${label}」 button in the dialog`);
  const at = Date.now();
  await leftClick(pos.x, pos.y);
  return at;
}

const result = { at: stamp() };

try {
  console.log('open 文件 panel:', await cdp.evaluate(`(() => {
    const b = document.querySelector('nav[aria-label="主导航"] button[aria-label="文件"]');
    if (!b) return 'no button';
    if (b.getAttribute('aria-pressed') === 'true') return 'already open';
    b.click();
    return 'clicked';
  })()`));
  await sleep(3000);
  console.log('disk before:', fs.readdirSync(ALPHA).join(', '));

  // ---- expand down to tree-demo/alpha --------------------------------------
  for (let i = 0; i < PATH_PARTS.length; i += 1) {
    const [name, depth] = PATH_PARTS[i];
    const [childName, childDepth] = PATH_PARTS[i + 1] ?? ['beta.txt', FILE_DEPTH];
    let ok = null;
    for (let attempt = 0; attempt < 3 && !ok; attempt += 1) {
      if (await has(childName, childDepth)) { ok = { via: 'already open', attempt }; break; }
      const c = await click(name, depth);
      if (!c) break;
      await sleep(1300);
      if (await has(childName, childDepth)) ok = { via: 'clicked', attempt };
    }
    console.log(`expand ${name}@${depth} (expect ${childName}@${childDepth}):`, JSON.stringify(ok));
    if (!ok) {
      save('12-01-expand-failed.json', { name, depth, childName, rows: await cdp.evaluate(ROWS) });
      throw new Error(`could not expand ${name}`);
    }
  }
  await sleep(600);
  await rect(DIR_ROW, DIR_DEPTH);
  save('12-02-expanded.json', await cdp.evaluate(ROWS));
  console.log('shot:', await shot(cdp, '12-a-tree-expanded.png'));

  // ---- pass A: file delete → dialog → 取消 ---------------------------------
  const passA = await openDeleteMenu('beta.txt', FILE_DEPTH, 'A');
  await sleep(900);
  const dialogA = await guarded(DIALOG, 'A: dialog after 删除');
  result.dialogA = dialogA.alive ? dialogA.value : 'RENDERER UNRESPONSIVE';
  result.dialogAResponseMs = dialogA.ms;
  result.pingsWhileDialogOpen = await pings(3, 'A');
  console.log('shot:', await shot(cdp, '12-b-confirm-file.png'));
  if (!dialogA.alive || !dialogA.value) throw new Error('no confirmation dialog for the file delete');

  const cancelAt = await clickDialogButton('取消');
  await sleep(800);
  result.afterCancel = {
    dialog: await cdp.evaluate(DIALOG),
    tree: await cdp.evaluate(presence),
    disk: fs.readdirSync(ALPHA),
    ms: Date.now() - cancelAt,
  };
  console.log('after 取消:', JSON.stringify(result.afterCancel));
  console.log('shot:', await shot(cdp, '12-c-after-cancel.png'));

  // ---- pass B: file delete → dialog → 删除, no refresh press ---------------
  const passB = await openDeleteMenu('beta.txt', FILE_DEPTH, 'B');
  await sleep(900);
  const dialogB = await guarded(DIALOG, 'B: dialog after 删除');
  result.dialogB = dialogB.alive ? dialogB.value : 'RENDERER UNRESPONSIVE';
  if (!dialogB.alive || !dialogB.value) throw new Error('no confirmation dialog on the second pass');

  const confirmAt = await clickDialogButton('删除');
  console.log(`[${stamp()}] B: 删除 confirmed`);
  const series = [];
  for (let i = 0; i < 20; i += 1) {
    await sleep(250);
    const g = await guarded(presence, `B t+${(i + 1) * 250}ms`, 8000);
    if (!g.alive) { series.push({ dt: null, unresponsive: true }); break; }
    series.push({ dt: g.value.t - confirmAt, beta: g.value.beta, gamma: g.value.gamma });
    if (!g.value.beta) break;
  }
  const last = series[series.length - 1];
  result.deleteSeries = series;
  result.goneAfterMs = last && last.beta === false ? last.dt : null;
  result.diskAfterDelete = fs.readdirSync(ALPHA);
  console.log(`beta.txt gone from the tree after ${result.goneAfterMs}ms; disk: ${result.diskAfterDelete.join(', ')}`);
  console.log('shot:', await shot(cdp, '12-d-after-delete.png'));

  // ---- pass C: folder delete → title must say 「删除文件夹？」 --------------
  const passC = await openDeleteMenu(DIR_ROW, DIR_DEPTH, 'C');
  await sleep(900);
  const dialogC = await guarded(DIALOG, 'C: dialog after 删除 on the folder');
  result.dialogC = dialogC.alive ? dialogC.value : 'RENDERER UNRESPONSIVE';
  console.log('shot:', await shot(cdp, '12-e-confirm-folder.png'));
  if (dialogC.alive && dialogC.value) {
    await clickDialogButton('取消');
    await sleep(800);
    result.afterFolderCancel = { tree: await cdp.evaluate(presence), disk: fs.existsSync(ALPHA) };
    console.log('after folder 取消:', JSON.stringify(result.afterFolderCancel));
  }
  result.menus = { A: passA.menu, B: passB.menu, C: passC.menu };
} catch (error) {
  result.error = String(error && error.message);
  console.log('ERROR:', result.error);
} finally {
  save('12-00-result.json', result);
  cdp.close();
}
