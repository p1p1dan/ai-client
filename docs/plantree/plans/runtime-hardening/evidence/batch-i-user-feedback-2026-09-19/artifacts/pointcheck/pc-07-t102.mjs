/**
 * T102 — opening a conversation with history must NOT start a worker.
 *
 * Three readings, taken together, because any one alone is deniable:
 *   the transcript actually paints messages ·
 *   `hostBoundSessionIds` still does not contain the session ·
 *   the OS-level set of worker processes is byte-identical
 * The worker set is read from `/proc/*​/cmdline`, never from `ps | grep`, which
 * matches its own command line and miscounts.
 *
 * Then one send, which MUST start a worker — otherwise "no worker" would just
 * mean the app is broken rather than reading history.
 */
import {
  CLICK_SEND,
  connect,
  ENTER_MAIN_SURFACE,
  messagesOf,
  save,
  sessionStatus,
  shot,
  SIDEBAR,
  sleep,
  stamp,
  STORE,
  typeInto,
  workerPids,
} from './lib.mjs';

const { cdp, evalAsync } = await connect();
const TRANSCRIPT = `(() => {
  const vps = [...document.querySelectorAll('[data-slot="scroll-area-viewport"]')]
    .filter((v) => v.offsetParent !== null);
  let vp = null, w = -1;
  for (const v of vps) { const x = v.getBoundingClientRect().width; if (x > w) { w = x; vp = v; } }
  const text = vp ? (vp.innerText || '') : '';
  return { len: text.length, head: text.slice(0, 200), tail: text.slice(-500),
           emptyState: /暂无消息|No messages|还没有消息/.test(document.body.innerText) };
})()`;

try {
  const entered = await cdp.evaluate(ENTER_MAIN_SURFACE).catch((e) => `ERROR: ${e.message}`);
  console.log(`[${stamp()}] entry:`, JSON.stringify(entered));
  await cdp.waitFor(`document.querySelector('textarea') !== null`, {
    timeoutMs: 240_000, label: 'composer mounted',
  });
  await sleep(2000);
  for (let i = 0; i < 12; i += 1) {
    const open = await cdp.evaluate(`document.querySelectorAll('[role="dialog"]').length`);
    if (!open) break;
    await cdp.evaluate(`(() => {
      const labels = ['知道了','我知道了','Got it','以后再说','稍后再说','Later','关闭','Close'];
      const b = [...document.querySelectorAll('button')].find(
        (n) => labels.includes((n.innerText || '').trim()) && n.offsetParent !== null);
      if (b) b.click();
      return !!b;
    })()`);
    await sleep(800);
  }
  await evalAsync(
    `const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
     window.__pci_store = chat.useChatSessionsStore; return 'ready';`,
    { label: 'prefetch' }
  );

  const before = await evalAsync(STORE, { label: 'before' });
  const workersBefore = workerPids();
  console.log(
    `[${stamp()}] cold: active=${before.activeSessionId} hostBound=${JSON.stringify(before.hostBoundSessionIds)} workers=${JSON.stringify(workersBefore)}`
  );
  save('07-00-cold.json', { store: before, workersBefore });
  console.log('shot:', await shot(cdp, '07-a-cold-start.png'));

  // Pick a session that HAS history: one of this batch's own T09x conversations.
  const target = await evalAsync(
    `const s = window.__pci_store.getState();
     const hit = s.sessions.find((x) => /^T09/.test(x.title ?? '')) ?? s.sessions[1] ?? s.sessions[0];
     return hit ? { id: hit.id, title: hit.title, status: hit.status } : null;`,
    { label: 'pick target' }
  );
  console.log('target:', JSON.stringify(target));

  const clicked = await cdp.evaluate(`(() => {
    const rows = [...document.querySelectorAll('[role="button"][title]')]
      .filter((n) => n.offsetParent !== null && n.getAttribute('title') === ${JSON.stringify(target.title)});
    if (rows.length !== 1) return { ok: false, matches: rows.length };
    rows[0].click();
    return { ok: true, at: new Date().toISOString() };
  })()`);
  console.log('sidebar click:', JSON.stringify(clicked));

  const series = [];
  for (let i = 0; i < 14; i += 1) {
    await sleep(1500);
    const st = await evalAsync(sessionStatus(target.id), { label: `poll ${i}` });
    const tr = await cdp.evaluate(TRANSCRIPT);
    const w = workerPids();
    series.push({ t: st.t, status: st.status, msgs: st.msgs, hostBound: st.hostBound,
                  active: st.active, transcriptLen: tr.len, emptyState: tr.emptyState, workers: w });
    console.log(
      `  [${st.t}] status=${st.status} msgs=${st.msgs} bound=${st.hostBound}` +
        ` transcriptLen=${tr.len} empty=${tr.emptyState} workers=${JSON.stringify(w)}`
    );
  }
  save('07-01-open-history.json', { target, workersBefore, series });
  console.log('shot:', await shot(cdp, '07-b-history-no-worker.png'));
  save('07-02-messages.json', await evalAsync(messagesOf(target.id), { label: 'msgs' }));

  const last = series[series.length - 1];
  const same = JSON.stringify(last.workers) === JSON.stringify(workersBefore);
  console.log(
    `VERDICT read-only: transcript=${last.transcriptLen} chars, hostBound=${last.hostBound},` +
      ` worker set unchanged=${same} (${JSON.stringify(workersBefore)} -> ${JSON.stringify(last.workers)})`
  );

  // ---- now send: a worker MUST appear --------------------------------------
  console.log('typed:', await cdp.evaluate(typeInto('T102：发一条，这时才应该起 worker')));
  await cdp.waitFor(
    `(() => { const b = document.querySelector('[aria-label="发送消息"]'); return !!b && !b.disabled; })()`,
    { timeoutMs: 20_000, label: 'send enabled' }
  );
  console.log(`[${stamp()}] send:`, JSON.stringify(await cdp.evaluate(CLICK_SEND)));
  const after = [];
  for (let i = 0; i < 24; i += 1) {
    await sleep(2500);
    const st = await evalAsync(sessionStatus(target.id), { label: `after ${i}` });
    const w = workerPids();
    after.push({ t: st.t, status: st.status, msgs: st.msgs, hostBound: st.hostBound, workers: w });
    console.log(`  [${st.t}] status=${st.status} msgs=${st.msgs} bound=${st.hostBound} workers=${JSON.stringify(w)}`);
    if (st.hostBound && st.msgs > last.msgs && w.length > workersBefore.length) break;
  }
  save('07-03-after-send.json', { after, gateway: await fetch('http://127.0.0.1:18099/health').then((r) => r.json()) });
  save('07-04-sidebar.json', await cdp.evaluate(SIDEBAR));
  console.log('shot:', await shot(cdp, '07-c-after-send.png'));
  console.log('TARGET', target.id);
} finally {
  cdp.close();
}
