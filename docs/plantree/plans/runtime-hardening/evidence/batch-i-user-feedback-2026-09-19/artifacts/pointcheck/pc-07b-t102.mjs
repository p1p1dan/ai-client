/**
 * T102, take 2 — the first run picked the wrong conversation.
 *
 * At cold start the store's session list is still filling, so "the first title
 * starting with T09" matched nothing and the probe fell through to the fresh
 * session the app had just made — which has no history, so "history showed up
 * without a worker" was never actually tested.
 *
 * This one waits for the list, prints the candidates, and takes the target from
 * the command line so the choice is visible in the log rather than inferred.
 */
import {
  CLICK_SEND,
  connect,
  messagesOf,
  save,
  sessionStatus,
  shot,
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
  return { len: text.length, tail: text.slice(-400),
           emptyState: /暂无消息|No messages|还没有消息/.test(document.body.innerText) };
})()`;

try {
  await evalAsync(
    `const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
     window.__pci_store = chat.useChatSessionsStore; return 'ready';`,
    { label: 'prefetch' }
  );
  // The rail remembers which panel was last open, and the conversation list
  // only exists while the 聊天 panel is mounted — with the 文件 panel showing,
  // the store holds one session and the sidebar paints zero rows, which reads
  // exactly like "the history is gone".
  console.log('open 聊天 panel:', await cdp.evaluate(`(() => {
    const b = document.querySelector('nav[aria-label="主导航"] button[aria-label="聊天"]');
    if (!b) return 'no button';
    if (b.getAttribute('aria-pressed') === 'true') return 'already open';
    b.click();
    return 'clicked';
  })()`));
  await sleep(3000);

  // Wait for the session list to actually be populated.
  let candidates = [];
  for (let i = 0; i < 20; i += 1) {
    candidates = await evalAsync(
      `const s = window.__pci_store.getState();
       return s.sessions
         .filter((x) => /^T09/.test(x.title ?? ''))
         .slice(0, 8)
         .map((x) => ({ id: x.id, title: x.title, status: x.status,
                        loadedMsgs: (s.messages[x.id] ?? []).length,
                        bound: s.hostBoundSessionIds.includes(x.id) }));`,
      { label: 'candidates' }
    );
    if (candidates.length > 0) break;
    await sleep(1500);
  }
  console.log('candidates:', JSON.stringify(candidates, null, 1));
  save('07b-00-candidates.json', candidates);
  // Prefer one that is NOT bound and has no messages loaded in memory: that is
  // exactly the "cold history" case decision 030 is about.
  const target = candidates.find((c) => !c.bound && c.loadedMsgs === 0) ?? candidates[0];
  if (!target) throw new Error('no T09x session to open');
  console.log('target:', JSON.stringify(target));

  const workersBefore = workerPids();
  const storeBefore = await evalAsync(STORE, { label: 'before' });
  console.log(`[${stamp()}] workers before = ${JSON.stringify(workersBefore)} hostBound=${JSON.stringify(storeBefore.hostBoundSessionIds)}`);
  save('07b-01-before.json', { workersBefore, storeBefore });

  const clicked = await cdp.evaluate(`(() => {
    const rows = [...document.querySelectorAll('[role="button"][title]')]
      .filter((n) => n.offsetParent !== null && n.getAttribute('title') === ${JSON.stringify(target.title)});
    if (rows.length !== 1) return { ok: false, matches: rows.length,
      titles: [...document.querySelectorAll('[role="button"][title]')].filter((n)=>n.offsetParent!==null).map((n)=>n.getAttribute('title')).slice(0,20) };
    rows[0].click();
    return { ok: true, at: new Date().toISOString() };
  })()`);
  console.log('sidebar click:', JSON.stringify(clicked));
  if (!clicked.ok) {
    console.log('falling back to selectSession');
    await evalAsync(
      `window.__pci_store.getState().selectSession(${JSON.stringify(target.id)}); return true;`,
      { label: 'selectSession' }
    );
  }

  const series = [];
  for (let i = 0; i < 14; i += 1) {
    await sleep(1500);
    const st = await evalAsync(sessionStatus(target.id), { label: `poll ${i}` });
    const tr = await cdp.evaluate(TRANSCRIPT);
    const w = workerPids();
    series.push({ t: st.t, status: st.status, msgs: st.msgs, hostBound: st.hostBound,
                  active: st.active, transcriptLen: tr.len, emptyState: tr.emptyState, workers: w });
    console.log(
      `  [${st.t}] active=${st.active === target.id ? 'TARGET' : st.active} status=${st.status}` +
        ` msgs=${st.msgs} bound=${st.hostBound} transcriptLen=${tr.len} empty=${tr.emptyState} workers=${JSON.stringify(w)}`
    );
  }
  save('07b-02-open-history.json', { target, workersBefore, series });
  save('07b-03-messages.json', await evalAsync(messagesOf(target.id), { label: 'msgs' }));
  console.log('shot:', await shot(cdp, '07b-a-history-no-worker.png'));

  const last = series[series.length - 1];
  console.log(
    `VERDICT: msgs=${last.msgs} transcript=${last.transcriptLen} chars empty=${last.emptyState}` +
      ` hostBound=${last.hostBound} workers ${JSON.stringify(workersBefore)} -> ${JSON.stringify(last.workers)}` +
      ` (unchanged=${JSON.stringify(last.workers) === JSON.stringify(workersBefore)})`
  );

  console.log('typed:', await cdp.evaluate(typeInto('T102：现在才发送，这时才该起 worker')));
  await cdp.waitFor(
    `(() => { const b = document.querySelector('[aria-label="发送消息"]'); return !!b && !b.disabled; })()`,
    { timeoutMs: 20_000, label: 'send enabled' }
  );
  console.log(`[${stamp()}] send:`, JSON.stringify(await cdp.evaluate(CLICK_SEND)));
  const after = [];
  for (let i = 0; i < 20; i += 1) {
    await sleep(2500);
    const st = await evalAsync(sessionStatus(target.id), { label: `after ${i}` });
    const w = workerPids();
    after.push({ t: st.t, status: st.status, msgs: st.msgs, hostBound: st.hostBound, workers: w });
    console.log(`  [${st.t}] status=${st.status} msgs=${st.msgs} bound=${st.hostBound} workers=${JSON.stringify(w)}`);
    if (st.hostBound && st.msgs > last.msgs) break;
  }
  save('07b-04-after-send.json', { after, gateway: await fetch('http://127.0.0.1:18099/health').then((r) => r.json()) });
  console.log('shot:', await shot(cdp, '07b-b-after-send.png'));
} finally {
  cdp.close();
}
