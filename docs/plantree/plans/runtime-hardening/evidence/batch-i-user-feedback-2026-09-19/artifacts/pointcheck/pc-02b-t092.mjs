/**
 * T092, take 2 — the row context menu only opens for REAL input events.
 *
 * A synthesized `new MouseEvent('contextmenu')` does nothing here: Base UI's
 * menu trigger is driven from pointer events the browser marks as trusted, so
 * the menu never mounted and the first run read that as "no 结束对话 item".
 * `Input.dispatchMouseEvent` goes in below the DOM and is trusted.
 */
import {
  CLICK_SEND,
  connect,
  DIALOG,
  MENU_ITEMS,
  messagesOf,
  save,
  sessionStatus,
  shot,
  sleep,
  stamp,
  STORE,
  typeInto,
} from './lib.mjs';

const target = process.argv[2];
if (!target) throw new Error('usage: node pc-02b-t092.mjs <sessionId>');

const { cdp, evalAsync } = await connect();
const TRANSCRIPT = `(() => {
  const vps = [...document.querySelectorAll('[data-slot="scroll-area-viewport"]')]
    .filter((v) => v.offsetParent !== null);
  let best = '', bestLen = -1;
  for (const v of vps) { const t = v.innerText || ''; if (t.length > bestLen) { bestLen = t.length; best = t; } }
  return { len: best.length, tail: best.slice(-500),
           emptyState: /暂无消息|No messages|还没有消息/.test(document.body.innerText) };
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
  await evalAsync(
    `const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
     window.__pci_store = chat.useChatSessionsStore; return 'ready';`,
    { label: 'prefetch' }
  );
  const title = await evalAsync(
    `const s = window.__pci_store.getState();
     return s.sessions.find((x) => x.id === ${JSON.stringify(target)})?.title ?? null;`,
    { label: 'title' }
  );
  const rect = await cdp.evaluate(`(() => {
    const rows = [...document.querySelectorAll('[role="button"][title]')]
      .filter((n) => n.offsetParent !== null && n.getAttribute('title') === ${JSON.stringify(title)});
    if (rows.length !== 1) return { ok: false, matches: rows.length };
    const r = rows[0].getBoundingClientRect();
    return { ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
             w: Math.round(r.width), h: Math.round(r.height) };
  })()`);
  console.log('row rect:', JSON.stringify(rect), 'title:', JSON.stringify(title));
  if (!rect.ok) throw new Error(`sidebar row not unique: ${JSON.stringify(rect)}`);

  const before = {
    status: await evalAsync(sessionStatus(target), { label: 'before' }),
    transcript: await cdp.evaluate(TRANSCRIPT),
  };
  console.log(
    `BEFORE status=${before.status.status} msgs=${before.status.msgs} bound=${before.status.hostBound} len=${before.transcript.len}`
  );
  save('02b-00-before.json', before);

  await rightClick(rect.x, rect.y);
  await sleep(1000);
  const menu = await cdp.evaluate(MENU_ITEMS);
  console.log('menu:', JSON.stringify(menu));
  save('02b-01-menu.json', menu);
  console.log('shot:', await shot(cdp, '02b-a-context-menu.png'));

  const clicked = await cdp.evaluate(`(() => {
    const vis = (n) => n.offsetParent !== null;
    const hit = [...document.querySelectorAll('[role="menuitem"], [data-slot="menu-item"], button')]
      .find((n) => /结束对话/.test((n.innerText || '').trim()) && vis(n));
    if (!hit) return { ok: false };
    hit.click();
    return { ok: true, text: (hit.innerText || '').trim().replace(/\\s+/g, ' ') };
  })()`);
  console.log('结束对话:', JSON.stringify(clicked));
  await sleep(1200);
  const dialog = await cdp.evaluate(DIALOG);
  console.log('dialog:', JSON.stringify(dialog));
  save('02b-02-dialog.json', dialog);
  console.log('shot:', await shot(cdp, '02b-b-confirm.png'));

  const confirmed = await cdp.evaluate(`(() => {
    const vis = (n) => n.offsetParent !== null;
    const d = [...document.querySelectorAll('[role="dialog"], [data-slot="dialog-popup"]')].filter(vis)[0];
    if (!d) return { ok: false, why: 'no dialog' };
    const buttons = [...d.querySelectorAll('button')].filter(vis);
    const hit = buttons.find((b) => /^(结束对话|结束|确认|确定)$/.test((b.innerText || '').trim()))
      ?? buttons[buttons.length - 1];
    if (!hit) return { ok: false, buttons: buttons.map((b) => (b.innerText||'').trim()) };
    hit.click();
    return { ok: true, text: (hit.innerText || '').trim() };
  })()`);
  console.log('confirm:', JSON.stringify(confirmed));

  const series = [];
  for (let i = 0; i < 8; i += 1) {
    await sleep(1500);
    const row = {
      status: await evalAsync(sessionStatus(target), { label: `after ${i}` }),
      transcript: await cdp.evaluate(TRANSCRIPT),
    };
    series.push(row);
    console.log(
      `  [${row.status.t}] status=${row.status.status} msgs=${row.status.msgs} bound=${row.status.hostBound}` +
        ` len=${row.transcript.len} empty=${row.transcript.emptyState}`
    );
  }
  save('02b-03-after-end.json', series);
  save('02b-04-messages.json', await evalAsync(messagesOf(target), { label: 'msgs' }));
  console.log('shot:', await shot(cdp, '02b-c-after-end.png'));

  console.log('typed:', await cdp.evaluate(typeInto('T092：结束后再发一条，应自动 resume')));
  await sleep(900);
  console.log(`[${stamp()}] send:`, JSON.stringify(await cdp.evaluate(CLICK_SEND)));
  const resume = [];
  for (let i = 0; i < 16; i += 1) {
    await sleep(2500);
    const st = await evalAsync(sessionStatus(target), { label: `resume ${i}` });
    resume.push(st);
    console.log(`  [${st.t}] status=${st.status} msgs=${st.msgs} bound=${st.hostBound}`);
    if (st.hostBound && st.msgs > before.status.msgs && st.status !== 'idle') break;
  }
  save('02b-05-resume.json', resume);
  save('02b-06-store.json', await evalAsync(STORE, { label: 'store' }));
  console.log('shot:', await shot(cdp, '02b-d-after-resume.png'));
} finally {
  cdp.close();
}
