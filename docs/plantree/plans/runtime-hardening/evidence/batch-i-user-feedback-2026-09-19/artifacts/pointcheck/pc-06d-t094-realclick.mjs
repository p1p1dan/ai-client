/**
 * T094 delete, with a REAL mouse click on 「删除」.
 *
 * Two earlier attempts froze the renderer right after a synthetic `.click()` on
 * that menu item, and a synthetic click on a Base UI menu is exactly the kind of
 * thing that can behave differently from a trusted one (the menu itself only
 * opens for trusted events). This run drives the item with
 * `Input.dispatchMouseEvent`, so a freeze here cannot be blamed on the probe.
 *
 * Every page read after the click is raced against a timeout, so an unresponsive
 * renderer is REPORTED rather than hanging the script.
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
const presence = `(() => {
  const p = ${PANEL};
  const text = p ? (p.innerText || '') : '';
  return { t: Date.now(), alpha: text.includes('alpha.txt'), beta: text.includes('beta.txt'),
           gamma: text.includes('gamma.txt'), delta: text.includes('delta.txt') };
})()`;

const guarded = async (expr, label, ms = 12000) => {
  const out = await Promise.race([
    cdp.evaluate(expr).then((v) => ({ alive: true, value: v })).catch((e) => ({ alive: true, error: String(e.message) })),
    new Promise((r) => setTimeout(() => r({ alive: false }), ms)),
  ]);
  console.log(`  ${label}: ${out.alive ? JSON.stringify(out.value ?? out.error).slice(0, 300) : 'RENDERER DID NOT ANSWER'}`);
  return out;
};

async function mouse(type, x, y, button, buttons) {
  await cdp.send('Input.dispatchMouseEvent', { type, x, y, button, buttons, clickCount: 1 });
}

try {
  console.log('open 文件 panel:', await cdp.evaluate(`(() => {
    const b = document.querySelector('nav[aria-label="主导航"] button[aria-label="文件"]');
    if (!b) return 'no button';
    if (b.getAttribute('aria-pressed') === 'true') return 'already open';
    b.click();
    return 'clicked';
  })()`));
  await sleep(3000);
  console.log('disk before:', fs.readdirSync(DEMO).join(', '));
  console.log('presence:', JSON.stringify(await cdp.evaluate(presence)));

  const r = await cdp.evaluate(`(() => {
    const p = ${PANEL};
    if (!p) return null;
    const n = [...p.querySelectorAll('[role="button"], [role="treeitem"]')]
      .filter((x) => x.offsetParent !== null)
      .find((x) => (x.textContent || '').trim() === 'beta.txt' &&
        Math.round((parseFloat(getComputedStyle(x).paddingLeft) - 8) / 12) === 9);
    if (!n) return null;
    n.scrollIntoView({ block: 'center' });
    const b = n.getBoundingClientRect();
    return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
  })()`);
  console.log('beta.txt rect:', JSON.stringify(r));
  if (!r) throw new Error('beta.txt row not on screen');

  await mouse('mouseMoved', r.x, r.y, 'none', 0);
  await sleep(150);
  await mouse('mousePressed', r.x, r.y, 'right', 2);
  await sleep(80);
  await mouse('mouseReleased', r.x, r.y, 'right', 2);
  await sleep(1000);

  const item = await cdp.evaluate(`(() => {
    const popups = [...document.querySelectorAll('[data-slot="menu-popup"], [role="menu"]')]
      .filter((n) => n.offsetParent !== null);
    for (const p of popups) {
      const hit = [...p.querySelectorAll('[role="menuitem"], button')]
        .find((b) => (b.textContent || '').trim() === '删除');
      if (hit) {
        const b = hit.getBoundingClientRect();
        return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2),
                 items: [...p.querySelectorAll('[role="menuitem"], button')].map((n) => (n.textContent || '').trim()) };
      }
    }
    return null;
  })()`);
  console.log('删除 item:', JSON.stringify(item));
  save('06d-00-menu.json', item);
  console.log('shot:', await shot(cdp, '06d-a-menu.png'));
  if (!item) throw new Error('删除 item not found');

  console.log(`[${stamp()}] REAL mouse click on 删除 at ${item.x},${item.y}`);
  await mouse('mouseMoved', item.x, item.y, 'none', 0);
  await sleep(200);
  await mouse('mousePressed', item.x, item.y, 'left', 1);
  await sleep(80);
  await mouse('mouseReleased', item.x, item.y, 'left', 1);
  console.log(`[${stamp()}] click dispatched`);

  await sleep(1500);
  const first = await guarded(`(() => {
    const vis = (n) => n.offsetParent !== null;
    const d = [...document.querySelectorAll('[role="dialog"],[role="alertdialog"],[data-slot="dialog-popup"],[data-slot="alert-dialog-popup"]')].filter(vis)[0];
    return { dialog: d ? { text: (d.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 260),
                           buttons: [...d.querySelectorAll('button')].filter(vis).map((b) => (b.textContent || '').trim()) } : null };
  })()`, 'state after 删除');

  if (!first.alive) {
    console.log('*** RENDERER UNRESPONSIVE after a REAL click on 删除 — reproduced with trusted input ***');
    save('06d-01-hang.json', { at: stamp(), input: 'Input.dispatchMouseEvent (trusted)', disk: fs.readdirSync(DEMO) });
  } else if (first.value?.dialog) {
    const confirmed = await cdp.evaluate(`(() => {
      const vis = (n) => n.offsetParent !== null;
      const d = [...document.querySelectorAll('[role="dialog"],[role="alertdialog"],[data-slot="dialog-popup"],[data-slot="alert-dialog-popup"]')].filter(vis)[0];
      const buttons = [...d.querySelectorAll('button')].filter(vis);
      const hit = buttons.find((b) => /^(删除|确认|确定)$/.test((b.textContent || '').trim()));
      if (!hit) return { ok: false, buttons: buttons.map((b) => (b.textContent || '').trim()) };
      const bb = hit.getBoundingClientRect();
      return { ok: true, x: Math.round(bb.left + bb.width / 2), y: Math.round(bb.top + bb.height / 2) };
    })()`);
    console.log('confirm button:', JSON.stringify(confirmed));
    if (confirmed.ok) {
      await mouse('mouseMoved', confirmed.x, confirmed.y, 'none', 0);
      await sleep(150);
      await mouse('mousePressed', confirmed.x, confirmed.y, 'left', 1);
      await sleep(80);
      await mouse('mouseReleased', confirmed.x, confirmed.y, 'left', 1);
    }
    const t0 = Date.now();
    const series = [];
    for (let i = 0; i < 20; i += 1) {
      await sleep(250);
      const g = await guarded(presence, `t+${(i + 1) * 250}ms`, 8000);
      if (!g.alive) { console.log('*** renderer stopped answering during the delete ***'); break; }
      series.push({ dt: g.value.t - t0, ...g.value });
      if (!g.value.beta) break;
    }
    const last = series[series.length - 1];
    console.log(`beta.txt gone after ${last?.dt}ms (present: ${last?.beta}); disk: ${fs.readdirSync(DEMO).join(', ')}`);
    save('06d-02-delete-series.json', { series, disk: fs.readdirSync(DEMO) });
    console.log('shot:', await shot(cdp, '06d-b-after-delete.png'));
  } else {
    console.log('no confirm dialog; watching the tree anyway');
    const t0 = Date.now();
    for (let i = 0; i < 12; i += 1) {
      await sleep(400);
      const g = await guarded(presence, `t+${(i + 1) * 400}ms`, 8000);
      if (!g.alive) break;
      if (!g.value.beta) { console.log(`beta.txt gone after ${g.value.t - t0}ms`); break; }
    }
    save('06d-02-delete-series.json', { note: 'no dialog', disk: fs.readdirSync(DEMO) });
  }
} finally {
  cdp.close();
}
