/**
 * T091 — 「新建」 during the send handshake.
 *
 * Three claims, each read off the store in the SAME tick as the click where
 * that matters (a 200 ms-later read cannot tell "nothing happened" apart from
 * "it happened and then settled"):
 *   A. send in S1, click 新建 within 0.5 s  → a new session exists and is active
 *   B. the new session's composer shows NO Stop button
 *   C. once S1 is really running, a send from the new session goes out as a
 *      send (发送消息), not as a queue append (加入队列)
 *   D. with a non-matching keyword in the sidebar search box, 新建 still puts
 *      the new row on screen
 */
import {
  CLICK_SEND,
  COMPOSER,
  connect,
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

const { cdp, evalAsync } = await connect();
const gw = () => fetch('http://127.0.0.1:18099/health').then((r) => r.json());

try {
  await evalAsync(
    `const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
     window.__pci_store = chat.useChatSessionsStore; return 'ready';`,
    { label: 'prefetch store' }
  );

  const pre = await evalAsync(STORE, { label: 'pre' });
  const s1 = pre.activeSessionId;
  console.log(`[${stamp()}] S1=${s1} sessions=${pre.sessionCount} gw=${JSON.stringify(await gw())}`);
  save('01-00-pre.json', pre);

  // ---- A/B: send, then 新建 400 ms later, both timed from inside the page ----
  console.log('typed:', await cdp.evaluate(typeInto('T091-A：请开始一个长回合（点验用）')));
  await cdp.waitFor(
    `(() => { const b = document.querySelector('[aria-label="发送消息"]'); return !!b && !b.disabled; })()`,
    { timeoutMs: 20_000, label: 'send enabled' }
  );
  await cdp.evaluate(`(() => {
    window.__pci_t091 = null;
    const vis = (n) => n.offsetParent !== null;
    const store = window.__pci_store;
    const send = [...document.querySelectorAll('button[aria-label]')]
      .find((n) => n.getAttribute('aria-label') === '发送消息');
    const sentAt = new Date().toISOString();
    send.click();
    setTimeout(() => {
      const newBtn = [...document.querySelectorAll('button')].find(
        (n) => /^(新建|New)$/.test((n.innerText || '').trim()) && vis(n));
      const before = store.getState();
      const clickedAt = new Date().toISOString();
      if (newBtn) newBtn.click();
      const after = store.getState();
      const stopBtn = [...document.querySelectorAll('button[aria-label]')]
        .find((n) => n.getAttribute('aria-label') === '停止当前回合' && vis(n));
      window.__pci_t091 = {
        done: true,
        sentAt, clickedAt,
        gapMs: Date.parse(clickedAt) - Date.parse(sentAt),
        foundNewButton: !!newBtn,
        beforeActive: before.activeSessionId, beforeCount: before.sessions.length,
        afterActive: after.activeSessionId, afterCount: after.sessions.length,
        created: after.activeSessionId !== before.activeSessionId,
        newSession: (() => { const n = after.sessions.find((s) => s.id === after.activeSessionId);
          return n ? { id: n.id, title: n.title, status: n.status, workspaceId: n.workspaceId,
                       unbound: n.unbound ? JSON.parse(JSON.stringify(n.unbound)) : null } : null; })(),
        s1StatusSameTick: after.sessions.find((s) => s.id === before.activeSessionId)?.status ?? null,
        stopButtonSameTick: !!stopBtn,
      };
    }, 400);
    return 'armed';
  })()`);
  const sameTick = await cdp.waitFor(`window.__pci_t091?.done ? window.__pci_t091 : null`, {
    timeoutMs: 20_000,
    label: 'new-during-send',
  });
  console.log('A/B same-tick:', JSON.stringify(sameTick, null, 1));
  save('01-01-sametick.json', sameTick);
  const s2 = sameTick.afterActive;

  // The composer needs a paint to swap its round-slot button; sample a series.
  const series = [];
  for (const wait of [150, 350, 500, 1000, 2000, 3000]) {
    await sleep(wait === 150 ? 150 : 200);
    const c = await cdp.evaluate(COMPOSER);
    const st = await evalAsync(sessionStatus(s1), { label: `s1 @${wait}` });
    const s2st = await evalAsync(sessionStatus(s2), { label: `s2 @${wait}` });
    series.push({ wait, t: c.t, send: c.send, stop: c.stop, queue: c.queue, s1: st, s2: s2st });
    console.log(
      `  [+${wait}] active=${st.active === s2 ? 'S2' : st.active === s1 ? 'S1' : st.active}` +
        ` s1=${st.status} s2=${s2st.status} send=${c.send.length} stop=${c.stop.length} queue=${c.queue.length}`
    );
  }
  save('01-02-composer-series.json', series);
  console.log('shot:', await shot(cdp, '01-a-new-during-send.png'));

  // ---- C: wait for S1 to be genuinely running, then send inside S2 ----------
  let s1state = null;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    s1state = await evalAsync(sessionStatus(s1), { label: 'poll s1' });
    console.log(`  [${s1state.t}] s1=${s1state.status} msgs=${s1state.msgs} bound=${s1state.hostBound}`);
    if (s1state.status === 'running') break;
    await sleep(2500);
  }
  save('01-03-s1-running.json', s1state);

  const composerBefore = await cdp.evaluate(COMPOSER);
  console.log('C composer before typing:', JSON.stringify({ send: composerBefore.send, stop: composerBefore.stop, queue: composerBefore.queue }));
  console.log('typed:', await cdp.evaluate(typeInto('T091-C：这条应当作为「发送」而不是「排队」')));
  await sleep(700);
  const composerAfter = await cdp.evaluate(COMPOSER);
  console.log('C composer after typing:', JSON.stringify({ send: composerAfter.send, stop: composerAfter.stop, queue: composerAfter.queue }));
  save('01-04-c-buttons.json', { before: composerBefore, after: composerAfter });
  console.log('shot:', await shot(cdp, '01-c-buttons-in-s2.png'));

  const gwBefore = await gw();
  const sendClick = await cdp.evaluate(CLICK_SEND);
  console.log(`[${stamp()}] C send click:`, JSON.stringify(sendClick), 'gwBefore:', JSON.stringify(gwBefore));
  await sleep(8000);
  const gwAfter = await gw();
  const cResult = {
    sendClick,
    gwBefore, gwAfter,
    s1: await evalAsync(sessionStatus(s1), { label: 's1 after C' }),
    s2: await evalAsync(sessionStatus(s2), { label: 's2 after C' }),
  };
  console.log('C result:', JSON.stringify(cResult, null, 1));
  save('01-05-c-result.json', cResult);
  save('01-06-s2-messages.json', await evalAsync(messagesOf(s2), { label: 's2 msgs' }));
  console.log('shot:', await shot(cdp, '01-c-after-send.png'));

  // ---- D: non-matching sidebar search keyword, then 新建 ---------------------
  const searchBox = await cdp.evaluate(`(() => {
    const vis = (n) => n.offsetParent !== null;
    const inputs = [...document.querySelectorAll('input')].filter(vis).map((n, i) => ({
      i, type: n.type, placeholder: n.placeholder, ariaLabel: n.getAttribute('aria-label'),
      value: n.value, rectX: Math.round(n.getBoundingClientRect().left),
    }));
    return inputs;
  })()`);
  console.log('visible inputs:', JSON.stringify(searchBox));
  save('01-07-inputs.json', searchBox);

  const typedSearch = await cdp.evaluate(`(() => {
    const vis = (n) => n.offsetParent !== null;
    // The sidebar search is the leftmost visible text input.
    const cand = [...document.querySelectorAll('input')]
      .filter((n) => vis(n) && (n.type === 'text' || n.type === 'search' || n.type === ''))
      .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)[0];
    if (!cand) return { ok: false, why: 'no text input' };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(cand, 'zzz-no-such-session-zzz');
    cand.dispatchEvent(new Event('input', { bubbles: true }));
    return { ok: true, placeholder: cand.placeholder, ariaLabel: cand.getAttribute('aria-label'), value: cand.value };
  })()`);
  console.log('search typed:', JSON.stringify(typedSearch));
  await sleep(1200);
  const filtered = await cdp.evaluate(SIDEBAR);
  console.log(`rows while filtered: ${filtered.rows.length}`);
  save('01-08-sidebar-filtered.json', filtered);
  console.log('shot:', await shot(cdp, '01-d-filtered.png'));

  const dTick = await cdp.evaluate(`(() => {
    const vis = (n) => n.offsetParent !== null;
    const store = window.__pci_store;
    const b = [...document.querySelectorAll('button')].find(
      (n) => /^(新建|New)$/.test((n.innerText || '').trim()) && vis(n));
    if (!b) return { ok: false, why: 'no New button while filtered' };
    const before = store.getState();
    b.click();
    const after = store.getState();
    return { ok: true, at: new Date().toISOString(),
             beforeActive: before.activeSessionId, afterActive: after.activeSessionId,
             beforeCount: before.sessions.length, afterCount: after.sessions.length };
  })()`);
  console.log('D click:', JSON.stringify(dTick));
  await sleep(1500);
  const afterD = await cdp.evaluate(SIDEBAR);
  const s3 = dTick.afterActive;
  const s3title = await evalAsync(
    `const s = window.__pci_store.getState();
     return s.sessions.find((x) => x.id === ${JSON.stringify(s3)})?.title ?? null;`,
    { label: 's3 title' }
  );
  const s3Visible = afterD.rows.filter((r) => r.title === s3title);
  console.log(
    `D: s3=${s3} title=${JSON.stringify(s3title)} rowsNow=${afterD.rows.length} s3RowsVisible=${s3Visible.length}`
  );
  save('01-09-d-result.json', { dTick, s3, s3title, sidebarAfter: afterD, s3Visible });
  console.log('shot:', await shot(cdp, '01-d-after-new.png'));

  // Put the search box back so later steps see an unfiltered sidebar.
  await cdp.evaluate(`(() => {
    const vis = (n) => n.offsetParent !== null;
    const cand = [...document.querySelectorAll('input')]
      .filter((n) => vis(n) && (n.type === 'text' || n.type === 'search' || n.type === ''))
      .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)[0];
    if (!cand) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(cand, '');
    cand.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);

  save('01-10-final-store.json', await evalAsync(STORE, { label: 'final' }));
  console.log('IDS', JSON.stringify({ s1, s2, s3 }));
} finally {
  cdp.close();
}
