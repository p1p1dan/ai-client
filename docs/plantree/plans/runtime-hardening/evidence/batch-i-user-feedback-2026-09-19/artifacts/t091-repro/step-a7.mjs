/**
 * A'' — the pure form of report #1: send inside an EXISTING conversation (one
 * that already has messages, so the New button cannot reuse it), then press New
 * while the send is still in flight. A genuinely new, empty chat is created and
 * the composer keeps showing Stop.
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

const ROW_TITLE = process.argv[2] ?? '点验重命名-0919';
const DELAY_MS = Number(process.argv[3] ?? 700);

const { cdp, evalAsync } = await connect();
const probe = `(() => {
  const vis = (n) => n.offsetParent !== null;
  const byLabel = (l) => [...document.querySelectorAll('button[aria-label]')]
    .filter((b) => b.getAttribute('aria-label') === l)
    .map((b) => ({ disabled: b.disabled === true, visible: vis(b) }));
  const s = window.__t091_store.getState();
  return {
    t: new Date().toISOString(),
    active: s.activeSessionId,
    count: s.sessions.length,
    activeStatus: s.sessions.find((x) => x.id === s.activeSessionId)?.status ?? null,
    activeTitle: s.sessions.find((x) => x.id === s.activeSessionId)?.title ?? null,
    activeMsgs: (s.messages[s.activeSessionId] ?? []).length,
    send: byLabel('发送消息'), stop: byLabel('停止当前回合'), queue: byLabel('加入队列'),
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

  const clicked = await cdp.evaluate(`(() => {
    const rows = [...document.querySelectorAll('[role="button"][title]')]
      .filter((n) => n.offsetParent !== null && n.getAttribute('title') === ${JSON.stringify(ROW_TITLE)});
    if (rows.length !== 1) return { ok: false, matches: rows.length };
    rows[0].click();
    return { ok: true };
  })()`);
  console.log('row click:', JSON.stringify(clicked));
  await sleep(6000);
  const base = await cdp.evaluate(probe);
  const old = base.active;
  console.log(
    `[${stamp()}] OLD = ${old} title=${JSON.stringify(base.activeTitle)} msgs=${base.activeMsgs} status=${base.activeStatus} count=${base.count}`
  );
  save('a7-00-old.json', base);
  if (base.activeMsgs === 0)
    console.log(
      '!! WARNING: old session has no replayed messages; freshness predicate may still reuse it'
    );

  console.log('typed:', await cdp.evaluate(typeInto('T091 A7：长回合，请慢慢来')));
  await cdp.waitFor(
    `(() => { const b = document.querySelector('[aria-label="发送消息"]'); return !!b && !b.disabled; })()`,
    { timeoutMs: 15_000, label: 'send enabled' }
  );
  const sent = await cdp.evaluate(CLICK_SEND);
  const sentAt = Date.now();
  console.log(`[${stamp()}] send:`, JSON.stringify(sent));

  const pre = [];
  while (Date.now() - sentAt < DELAY_MS) {
    pre.push(await cdp.evaluate(probe));
    await sleep(200);
  }
  for (const r of pre) {
    console.log(
      `  [pre +${new Date(r.t).getTime() - sentAt}ms] status=${r.activeStatus} msgs=${r.activeMsgs} STOP=${JSON.stringify(r.stop)} SEND=${JSON.stringify(r.send)}`
    );
  }
  save('a7-01-before-click.json', pre);

  const sameTick = await cdp.evaluate(`(() => {
    const vis = (n) => n.offsetParent !== null;
    const b = [...document.querySelectorAll('button')].find(
      (n) => /^(新建|New)$/.test((n.innerText || '').trim()) && vis(n)
    );
    const store = window.__t091_store;
    const p = store.getState();
    const clickedAt = new Date().toISOString();
    b.click();
    const q = store.getState();
    return {
      clickedAt,
      preActive: p.activeSessionId, preCount: p.sessions.length,
      preStatus: p.sessions.find((x) => x.id === p.activeSessionId)?.status ?? null,
      preMsgs: (p.messages[p.activeSessionId] ?? []).length,
      preHostBound: p.hostBoundSessionIds.includes(p.activeSessionId),
      postActive: q.activeSessionId, postCount: q.sessions.length,
      created: q.activeSessionId !== p.activeSessionId,
      newTitle: q.sessions.find((x) => x.id === q.activeSessionId)?.title ?? null,
    };
  })()`);
  console.log(
    `[${stamp()}] NEW-click at +${Date.now() - sentAt}ms:`,
    JSON.stringify(sameTick, null, 1)
  );
  save('a7-02-sametick.json', sameTick);
  const fresh = sameTick.postActive;

  const series = [];
  for (const ms of [150, 500, 1200, 3000, 6000, 10000, 16000]) {
    const target = sentAt + DELAY_MS + ms;
    while (Date.now() < target) await sleep(80);
    const r = await cdp.evaluate(probe);
    const extra = await evalAsync(
      `const s = window.__t091_store.getState();
       return { old: s.sessions.find((x) => x.id === ${JSON.stringify(old)})?.status ?? null,
                oldMsgs: (s.messages[${JSON.stringify(old)}] ?? []).length,
                fresh: s.sessions.find((x) => x.id === ${JSON.stringify(fresh)})?.status ?? null,
                freshMsgs: (s.messages[${JSON.stringify(fresh)}] ?? []).length };`,
      { label: `pair ${ms}` }
    );
    series.push({ offset: ms, ...r, pair: extra });
    console.log(
      `  [+${ms}ms] active=${r.active === fresh ? 'NEW' : r.active === old ? 'OLD' : r.active} ` +
        `title=${JSON.stringify(r.activeTitle)} activeStatus=${r.activeStatus} activeMsgs=${r.activeMsgs} ` +
        `STOP=${JSON.stringify(r.stop)} SEND=${JSON.stringify(r.send)} QUEUE=${JSON.stringify(r.queue)} ` +
        `| OLD=${extra.old}/${extra.oldMsgs} NEW=${extra.fresh}/${extra.freshMsgs} rows=${r.rowCount}`
    );
    if (ms === 1200)
      console.log('shot A-3:', await shot(cdp, 'a7-a3-new-chat-with-stale-stop.png'));
  }
  save('a7-03-series.json', series);
  save('a7-04-sidebar.json', await cdp.evaluate(SIDEBAR));
  save('a7-05-store.json', await evalAsync(STORE, { label: 'store' }));
  save('a7-06-old-messages.json', await evalAsync(messagesOf(old), { label: 'old' }));
  save('a7-07-new-messages.json', await evalAsync(messagesOf(fresh), { label: 'new' }));
  save('a7-08-spy-before-stop.json', await cdp.evaluate(READ_SPY));
  console.log('IDS', JSON.stringify({ old, fresh, created: sameTick.created }));
} finally {
  cdp.close();
}
