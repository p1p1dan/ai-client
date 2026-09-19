/**
 * T094 delete half, isolated.
 *
 * The combined run was polluted: the settings dialog from the previous probe
 * was still open, so the right-click never reached the tree (the menu came back
 * empty) and the "confirm" fallback clicked a button inside SETTINGS. Close
 * every modal first, and refuse to continue unless the file menu really opened.
 */
import fs from 'node:fs';
import { connect, save, shot, sleep, stamp } from './lib.mjs';

const DEMO = '/home/ai/code/ai-client/docs/plantree/plans/runtime-hardening/evidence/batch-i-user-feedback-2026-09-19/artifacts/pointcheck/tree-demo';
const { cdp } = await connect();

const PANEL = `(() => {
  const vps = [...document.querySelectorAll('[data-slot="scroll-area-viewport"]')]
    .filter((v) => v.offsetParent !== null);
  return vps.find((v) => /node_modules|package\\.json|tsconfig/.test(v.innerText || '')) ?? null;
})()`;
const rowAt = (name, depth) => `(() => {
  const p = ${PANEL};
  if (!p) return null;
  return [...p.querySelectorAll('[role="button"], [role="treeitem"]')]
    .filter((n) => n.offsetParent !== null)
    .find((n) => (n.textContent || '').trim() === ${JSON.stringify(name)} &&
      Math.round((parseFloat(getComputedStyle(n).paddingLeft) - 8) / 12) === ${depth}) ?? null;
})()`;
const presence = `(() => {
  const p = ${PANEL};
  const text = p ? (p.innerText || '') : '';
  return { t: Date.now(), alpha: text.includes('alpha.txt'), beta: text.includes('beta.txt'),
           gamma: text.includes('gamma.txt'), delta: text.includes('delta.txt') };
})()`;
const MENU = `(() => {
  const popups = [...document.querySelectorAll('[data-slot="menu-popup"], [role="menu"]')]
    .filter((n) => n.offsetParent !== null);
  return popups.map((p) => [...p.querySelectorAll('[role="menuitem"], button')]
    .map((b) => (b.textContent || '').trim()).filter(Boolean));
})()`;

async function rightClick(x, y) {
  const base = { x, y, button: 'right', buttons: 2, clickCount: 1 };
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  await sleep(150);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
  await sleep(80);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
}

try {
  // Close everything modal, with real Escape presses.
  for (let i = 0; i < 4; i += 1) {
    const open = await cdp.evaluate(`document.querySelectorAll('[role="dialog"],[role="alertdialog"],[data-slot="dialog-popup"],[data-slot="alert-dialog-popup"]').length`);
    console.log(`modals open: ${open}`);
    if (!open) break;
    for (const type of ['keyDown', 'keyUp']) {
      await cdp.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    }
    await sleep(900);
  }
  console.log('disk before:', fs.readdirSync(DEMO).join(', '));

  const r = await cdp.evaluate(`(() => {
    const n = ${rowAt('beta.txt', 9)};
    if (!n) return null;
    n.scrollIntoView({ block: 'center' });
    const b = n.getBoundingClientRect();
    return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
  })()`);
  console.log('beta.txt rect:', JSON.stringify(r));
  if (!r) throw new Error('beta.txt row not on screen');
  await rightClick(r.x, r.y);
  await sleep(1000);
  const menu = await cdp.evaluate(MENU);
  console.log('file menu:', JSON.stringify(menu));
  save('06c-00-menu.json', menu);
  console.log('shot:', await shot(cdp, '06c-a-file-menu.png'));
  if (!menu.some((m) => m.includes('删除'))) throw new Error('file context menu did not open');

  console.log(`[${stamp()}] clicking 删除 …`);
  const del = await cdp.evaluate(`(() => {
    const popups = [...document.querySelectorAll('[data-slot="menu-popup"], [role="menu"]')]
      .filter((n) => n.offsetParent !== null);
    for (const p of popups) {
      const hit = [...p.querySelectorAll('[role="menuitem"], button')]
        .find((b) => (b.textContent || '').trim() === '删除');
      if (hit) { hit.click(); return { ok: true }; }
    }
    return { ok: false };
  })()`);
  console.log(`[${stamp()}] 删除 click ->`, JSON.stringify(del));

  // Whatever happens next, find out WITHOUT blocking forever.
  const probe = async (label) => {
    const out = await Promise.race([
      cdp.evaluate(`(() => {
        const vis = (n) => n.offsetParent !== null;
        const d = [...document.querySelectorAll('[role="dialog"],[role="alertdialog"],[data-slot="dialog-popup"],[data-slot="alert-dialog-popup"]')].filter(vis)[0];
        return { alive: true,
          dialog: d ? { text: (d.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 260),
                        buttons: [...d.querySelectorAll('button')].filter(vis).map((b) => (b.textContent || '').trim()) } : null };
      })()`),
      new Promise((res) => setTimeout(() => res({ alive: false }), 12_000)),
    ]);
    console.log(`  ${label}:`, JSON.stringify(out));
    return out;
  };
  await sleep(1200);
  let state = await probe('right after 删除');
  if (!state.alive) {
    console.log('*** RENDERER UNRESPONSIVE after 删除 — the hang reproduced ***');
    save('06c-01-hang.json', { at: stamp(), note: 'Runtime.evaluate stopped answering after clicking 删除' });
  } else if (state.dialog) {
    const confirmed = await cdp.evaluate(`(() => {
      const vis = (n) => n.offsetParent !== null;
      const d = [...document.querySelectorAll('[role="dialog"],[role="alertdialog"],[data-slot="dialog-popup"],[data-slot="alert-dialog-popup"]')].filter(vis)[0];
      const buttons = [...d.querySelectorAll('button')].filter(vis);
      const hit = buttons.find((b) => /^(删除|确认|确定)$/.test((b.textContent || '').trim()));
      if (!hit) return { ok: false, buttons: buttons.map((b) => (b.textContent || '').trim()) };
      hit.click();
      return { ok: true, clicked: (hit.textContent || '').trim() };
    })()`);
    console.log('confirm:', JSON.stringify(confirmed));
    const t0 = Date.now();
    const series = [];
    for (let i = 0; i < 20; i += 1) {
      await sleep(250);
      const p = await cdp.evaluate(presence);
      series.push({ dt: p.t - t0, ...p });
      if (!p.beta) break;
    }
    const last = series[series.length - 1];
    console.log(`beta.txt gone after ${last.dt}ms (present: ${last.beta}); disk: ${fs.readdirSync(DEMO).join(', ')}`);
    save('06c-02-delete-series.json', { series, disk: fs.readdirSync(DEMO) });
    console.log('shot:', await shot(cdp, '06c-b-after-delete.png'));
  } else {
    // No dialog at all: the delete may have been immediate.
    const t0 = Date.now();
    const series = [];
    for (let i = 0; i < 20; i += 1) {
      await sleep(250);
      const p = await cdp.evaluate(presence);
      series.push({ dt: p.t - t0, ...p });
      if (!p.beta) break;
    }
    const last = series[series.length - 1];
    console.log(`no confirm dialog; beta.txt gone after ${last.dt}ms (present: ${last.beta}); disk: ${fs.readdirSync(DEMO).join(', ')}`);
    save('06c-02-delete-series.json', { series, disk: fs.readdirSync(DEMO), note: 'no confirm dialog appeared' });
    console.log('shot:', await shot(cdp, '06c-b-after-delete.png'));
  }
} finally {
  cdp.close();
}
