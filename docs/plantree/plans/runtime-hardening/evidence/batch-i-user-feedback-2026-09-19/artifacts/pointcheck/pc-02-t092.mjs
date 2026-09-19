/**
 * T092 — 「结束对话」 must keep the transcript on screen.
 *
 * The three fields that together make the claim (the handbook's rule: a tab
 * disappearing proves nothing about the worker):
 *   messages[id] still populated · hostBoundSessionIds no longer contains id ·
 *   sessions[id].status === 'disconnected'
 * then one more send, which must resume without the user doing anything.
 */
import {
  CLICK_SEND,
  connect,
  contextMenuOn,
  DIALOG,
  MENU_ITEMS,
  messagesOf,
  save,
  sessionStatus,
  shot,
  SIDEBAR,
  sleep,
  stamp,
  STORE,
  typeInto,
} from './lib.mjs';

const target = process.argv[2];
if (!target) throw new Error('usage: node pc-02-t092.mjs <sessionId>');

const { cdp, evalAsync } = await connect();
const transcriptText = `(() => {
  const vps = [...document.querySelectorAll('[data-slot="scroll-area-viewport"]')]
    .filter((v) => v.offsetParent !== null);
  let best = '', bestLen = -1;
  for (const v of vps) {
    const t = v.innerText || '';
    if (t.length > bestLen) { bestLen = t.length; best = t; }
  }
  return { len: best.length, head: best.slice(0, 300), tail: best.slice(-600),
           emptyState: /暂无消息|No messages/.test(document.body.innerText) };
})()`;

try {
  await evalAsync(
    `const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
     window.__pci_store = chat.useChatSessionsStore; return 'ready';`,
    { label: 'prefetch' }
  );

  // Stop anything still running, so 结束对话 is not racing a live turn.
  const stopped = await evalAsync(
    `const s = window.__pci_store.getState();
     const busy = new Set(['starting','running','stopping','waiting_permission','waiting_question']);
     const ids = s.sessions.filter((x) => busy.has(x.status)).map((x) => x.id);
     for (const id of ids) { try { await window.electronAPI.chat.stop({ sessionId: id }); } catch {} }
     return ids;`,
    { label: 'stop busy', timeoutMs: 60_000 }
  );
  console.log(`[${stamp()}] stopped busy sessions:`, JSON.stringify(stopped));
  await sleep(6000);

  // Activate the target through its real sidebar row.
  const title = await evalAsync(
    `const s = window.__pci_store.getState();
     return s.sessions.find((x) => x.id === ${JSON.stringify(target)})?.title ?? null;`,
    { label: 'target title' }
  );
  console.log('target title:', JSON.stringify(title));
  const activated = await cdp.evaluate(`(() => {
    const rows = [...document.querySelectorAll('[role="button"][title]')]
      .filter((n) => n.offsetParent !== null && n.getAttribute('title') === ${JSON.stringify(title)});
    if (rows.length !== 1) return { ok: false, matches: rows.length };
    rows[0].click();
    return { ok: true };
  })()`);
  console.log('activated:', JSON.stringify(activated));
  await sleep(2500);

  const before = {
    status: await evalAsync(sessionStatus(target), { label: 'before' }),
    transcript: await cdp.evaluate(transcriptText),
    messages: await evalAsync(messagesOf(target), { label: 'msgs before' }),
  };
  console.log(
    `BEFORE status=${before.status.status} msgs=${before.status.msgs} bound=${before.status.hostBound} transcriptLen=${before.transcript.len}`
  );
  save('02-00-before.json', before);
  console.log('shot:', await shot(cdp, '02-a-before-end.png'));

  // Right-click the row → menu.
  console.log('contextmenu:', JSON.stringify(await cdp.evaluate(contextMenuOn(title))));
  await sleep(900);
  const menu = await cdp.evaluate(MENU_ITEMS);
  console.log('menu items:', JSON.stringify(menu));
  save('02-01-menu.json', menu);
  console.log('shot:', await shot(cdp, '02-b-context-menu.png'));

  const clickedEnd = await cdp.evaluate(`(() => {
    const vis = (n) => n.offsetParent !== null;
    const hit = [...document.querySelectorAll('[role="menuitem"], button')]
      .find((n) => /结束对话/.test((n.innerText || '').trim()) && vis(n));
    if (!hit) return { ok: false, why: 'no 结束对话 item' };
    hit.click();
    return { ok: true, text: (hit.innerText || '').trim() };
  })()`);
  console.log('结束对话 click:', JSON.stringify(clickedEnd));
  await sleep(1200);
  const dialog = await cdp.evaluate(DIALOG);
  console.log('confirm dialog:', JSON.stringify(dialog));
  save('02-02-dialog.json', dialog);
  console.log('shot:', await shot(cdp, '02-c-confirm-dialog.png'));

  const confirmed = await cdp.evaluate(`(() => {
    const vis = (n) => n.offsetParent !== null;
    const d = [...document.querySelectorAll('[role="dialog"], [data-slot="dialog-popup"]')].filter(vis)[0];
    const scope = d ?? document;
    const hit = [...scope.querySelectorAll('button')]
      .filter(vis)
      .find((b) => /^(结束对话|结束|确认|确定)$/.test((b.innerText || '').trim()));
    if (!hit) return { ok: false, buttons: [...scope.querySelectorAll('button')].map((b) => (b.innerText||'').trim()) };
    hit.click();
    return { ok: true, text: (hit.innerText || '').trim() };
  })()`);
  console.log('confirm click:', JSON.stringify(confirmed));

  const series = [];
  for (let i = 0; i < 8; i += 1) {
    await sleep(1500);
    const row = {
      status: await evalAsync(sessionStatus(target), { label: `after ${i}` }),
      transcript: await cdp.evaluate(transcriptText),
    };
    series.push(row);
    console.log(
      `  [${row.status.t}] status=${row.status.status} msgs=${row.status.msgs} bound=${row.status.hostBound}` +
        ` active=${row.status.active === target ? 'TARGET' : row.status.active} transcriptLen=${row.transcript.len} empty=${row.transcript.emptyState}`
    );
  }
  save('02-03-after-end-series.json', series);
  save('02-04-messages-after-end.json', await evalAsync(messagesOf(target), { label: 'msgs after' }));
  console.log('shot:', await shot(cdp, '02-d-after-end.png'));

  // One more send: must resume by itself.
  console.log('typed:', await cdp.evaluate(typeInto('T092：结束后再发一条，应当自动 resume')));
  await sleep(800);
  const sent = await cdp.evaluate(CLICK_SEND);
  console.log(`[${stamp()}] resume send:`, JSON.stringify(sent));
  const resumeSeries = [];
  for (let i = 0; i < 20; i += 1) {
    await sleep(2500);
    const st = await evalAsync(sessionStatus(target), { label: `resume ${i}` });
    resumeSeries.push(st);
    console.log(`  [${st.t}] status=${st.status} msgs=${st.msgs} bound=${st.hostBound}`);
    if (st.hostBound && st.msgs > before.status.msgs) break;
  }
  save('02-05-resume-series.json', resumeSeries);
  save('02-06-final-store.json', await evalAsync(STORE, { label: 'final' }));
  save('02-07-sidebar.json', await cdp.evaluate(SIDEBAR));
  console.log('shot:', await shot(cdp, '02-e-after-resume.png'));
} finally {
  cdp.close();
}
