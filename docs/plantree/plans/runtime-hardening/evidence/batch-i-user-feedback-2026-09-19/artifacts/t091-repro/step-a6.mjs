/**
 * A' — the timing the user actually described: press New WHILE the send
 * handshake is still in flight (a second or two after pressing Send), not a
 * minute later when the turn is already `running`.
 */
import {
  CLICK_SEND,
  CLICK_STOP,
  COMPOSER,
  connect,
  messagesOf,
  READ_SPY,
  SIDEBAR,
  STORE,
  save,
  shot,
  sleep,
  stamp,
  typeInto,
} from './lib.mjs';

const DELAY_MS = Number(process.argv[2] ?? 1200);

const { cdp, evalAsync } = await connect();
const probe = `(() => {
  const vis = (n) => n.offsetParent !== null;
  const byLabel = (l) => [...document.querySelectorAll('button[aria-label]')]
    .filter((b) => b.getAttribute('aria-label') === l)
    .map((b) => ({ disabled: b.disabled === true, visible: vis(b) }));
  const s = window.__t091_store.getState();
  const ta = document.querySelector('textarea');
  return {
    t: new Date().toISOString(),
    active: s.activeSessionId,
    count: s.sessions.length,
    activeStatus: s.sessions.find((x) => x.id === s.activeSessionId)?.status ?? null,
    activeTitle: s.sessions.find((x) => x.id === s.activeSessionId)?.title ?? null,
    activeMsgs: (s.messages[s.activeSessionId] ?? []).length,
    send: byLabel('发送消息'), stop: byLabel('停止当前回合'), queue: byLabel('加入队列'),
    textarea: ta ? ta.value : null,
    placeholderVisible: !!document.body.innerText.match(/给 Pi 发消息/),
    transcriptEmpty: (() => {
      const vps = [...document.querySelectorAll('[data-slot="scroll-area-viewport"]')].filter(vis);
      const main = vps[vps.length - 1];
      return main ? (main.innerText || '').trim().length : null;
    })(),
    rowCount: [...document.querySelectorAll('[role="button"][title]')].filter(vis).length,
  };
})()`;

try {
  await evalAsync(
    `const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
     window.__t091_store = chat.useChatSessionsStore;
     window.__t091_calls = []; return 'ready';`,
    { label: 'prefetch' }
  );

  // Fresh S3 to send from, so the fake gateway sees no tool_result and answers
  // with the long bash again.
  await cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(
      (n) => /^(新建|New)$/.test((n.innerText || '').trim()) && n.offsetParent !== null
    );
    b.click(); return true;
  })()`);
  await sleep(1500);
  const s3state = await cdp.evaluate(probe);
  const s3 = s3state.active;
  console.log(`[${stamp()}] S3 = ${s3} count=${s3state.count} rows=${s3state.rowCount}`);
  save('a6-00-s3.json', s3state);

  console.log('typed:', await cdp.evaluate(typeInto('T091 A6：长回合，别急着结束')));
  await cdp.waitFor(
    `(() => { const b = document.querySelector('[aria-label="发送消息"]'); return !!b && !b.disabled; })()`,
    { timeoutMs: 15_000, label: 'send enabled' }
  );
  const sent = await cdp.evaluate(CLICK_SEND);
  const sentAt = Date.now();
  console.log(`[${stamp()}] send:`, JSON.stringify(sent));

  // Watch the handshake window, then click New inside it.
  const beforeClick = [];
  while (Date.now() - sentAt < DELAY_MS) {
    beforeClick.push(await cdp.evaluate(probe));
    await sleep(300);
  }
  for (const r of beforeClick) {
    console.log(
      `  [pre +${new Date(r.t).getTime() - sentAt}ms] status=${r.activeStatus} msgs=${r.activeMsgs} stop=${JSON.stringify(r.stop)} send=${JSON.stringify(r.send)}`
    );
  }
  save('a6-01-before-click.json', beforeClick);

  const sameTick = await cdp.evaluate(`(() => {
    const vis = (n) => n.offsetParent !== null;
    const b = [...document.querySelectorAll('button')].find(
      (n) => /^(新建|New)$/.test((n.innerText || '').trim()) && vis(n)
    );
    if (!b) throw new Error('no New button');
    const store = window.__t091_store;
    const pre = store.getState();
    const clickedAt = new Date().toISOString();
    b.click();
    const post = store.getState();
    return {
      clickedAt,
      preActive: pre.activeSessionId, preCount: pre.sessions.length,
      preStatus: pre.sessions.find((x) => x.id === pre.activeSessionId)?.status ?? null,
      preMsgs: (pre.messages[pre.activeSessionId] ?? []).length,
      preHostBound: pre.hostBoundSessionIds.includes(pre.activeSessionId),
      preRuntimeIdentity: pre.sessions.find((x) => x.id === pre.activeSessionId)?.runtimeIdentity ?? null,
      postActive: post.activeSessionId, postCount: post.sessions.length,
      created: post.activeSessionId !== pre.activeSessionId,
      reusedSameSession: post.activeSessionId === pre.activeSessionId && post.sessions.length === pre.sessions.length,
    };
  })()`);
  console.log(
    `[${stamp()}] NEW-click at +${Date.now() - sentAt}ms:`,
    JSON.stringify(sameTick, null, 1)
  );
  save('a6-02-sametick.json', sameTick);
  const s4 = sameTick.postActive;

  const series = [];
  for (const ms of [150, 500, 1500, 4000, 8000, 14000]) {
    const target = sentAt + DELAY_MS + ms;
    while (Date.now() < target) await sleep(100);
    const r = await cdp.evaluate(probe);
    series.push({ offsetFromNewClick: ms, ...r });
    console.log(
      `  [+${ms}ms] active=${r.active === s3 ? 'S3' : r.active === s4 ? 'S4' : r.active} ` +
        `status=${r.activeStatus} title=${JSON.stringify(r.activeTitle)} msgs=${r.activeMsgs} ` +
        `STOP=${JSON.stringify(r.stop)} SEND=${JSON.stringify(r.send)} QUEUE=${JSON.stringify(r.queue)} ` +
        `rows=${r.rowCount} transcriptLen=${r.transcriptEmpty}`
    );
    if (ms === 1500) console.log('shot:', await shot(cdp, 'a6-a3-after-new-during-handshake.png'));
  }
  save('a6-03-series.json', series);
  save('a6-04-store.json', await evalAsync(STORE, { label: 'store' }));
  save('a6-05-sidebar.json', await cdp.evaluate(SIDEBAR));
  save('a6-06-composer.json', await cdp.evaluate(COMPOSER));
  save('a6-07-s3-messages.json', await evalAsync(messagesOf(s3), { label: 's3' }));
  if (s4 !== s3) save('a6-08-s4-messages.json', await evalAsync(messagesOf(s4), { label: 's4' }));
  save('a6-09-spy.json', await cdp.evaluate(READ_SPY));
  console.log('IDS', JSON.stringify({ s3, s4, created: sameTick.created }));
} finally {
  cdp.close();
}
