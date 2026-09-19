/**
 * A8 — inside the ~1.5 s window where a BRAND-NEW empty chat still shows Stop
 * (because `sending` is a component-global useState, not per session):
 *   mode=stop  : press that Stop and record which sessionId chat.stop carries.
 *   mode=send  : type a message and record which button appears and where the
 *                text lands.
 */
import {
  CLICK_SEND,
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

const MODE = process.argv[2] ?? 'stop';
const DELAY_MS = Number(process.argv[3] ?? 1500);

const { cdp, evalAsync } = await connect();
try {
  await evalAsync(
    `const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
     window.__t091_store = chat.useChatSessionsStore;
     window.__t091_calls = []; return 'ready';`,
    { label: 'prefetch' }
  );

  // contextBridge objects are frozen, so wrapping window.electronAPI.chat is a
  // silent no-op. Wrap the store action instead — it still delegates to the
  // original, it only records which session the click was about to stop.
  console.log(
    'stop wrapper:',
    await cdp.evaluate(`(() => {
      const store = window.__t091_store;
      if (window.__t091_stopWrapped) return 'already';
      const original = store.getState().stopActiveSession;
      window.__t091_stopCalls = [];
      store.setState({
        stopActiveSession: async (...args) => {
          window.__t091_stopCalls.push({
            t: new Date().toISOString(),
            activeSessionIdAtCall: store.getState().activeSessionId,
          });
          return original(...args);
        },
      });
      window.__t091_stopWrapped = true;
      return 'wrapped';
    })()`)
  );

  // Fresh sender session.
  await cdp.evaluate(`(() => {
    [...document.querySelectorAll('button')]
      .find((n) => /^(新建|New)$/.test((n.innerText || '').trim()) && n.offsetParent !== null).click();
    return true; })()`);
  await sleep(1500);
  const senderId = await cdp.evaluate(`window.__t091_store.getState().activeSessionId`);
  console.log(`[${stamp()}] sender S = ${senderId}`);

  await cdp.evaluate(typeInto('T091 A8：长回合，请一直跑'));
  await cdp.waitFor(
    `(() => { const b = document.querySelector('[aria-label="发送消息"]'); return !!b && !b.disabled; })()`,
    { timeoutMs: 15_000, label: 'send enabled' }
  );
  await cdp.evaluate(CLICK_SEND);
  const sentAt = Date.now();
  console.log(`[${stamp()}] sent`);

  while (Date.now() - sentAt < DELAY_MS) await sleep(50);

  // One page-side async block so New + the follow-up action both land inside
  // the window. Results stashed on `window` (never await a long promise).
  const body =
    MODE === 'stop'
      ? `
      const stop = document.querySelector('button[aria-label="停止当前回合"]');
      out.beforeAction = snapshot();
      if (!stop) { out.note = 'no Stop button in window'; }
      else { out.stopClickedAt = new Date().toISOString(); stop.click(); }
      await sleep(2500);
      out.afterAction = snapshot();`
      : `
      const ta = document.querySelector('textarea');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, 'T091 A8-send：这条该去哪');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(250);
      out.beforeAction = snapshot();
      const round = [...document.querySelectorAll('button[aria-label]')].filter((b) =>
        ['发送消息','加入队列','停止当前回合','重试上一条消息'].includes(b.getAttribute('aria-label')) && b.offsetParent !== null);
      out.roundButtons = round.map((b) => ({ label: b.getAttribute('aria-label'), disabled: b.disabled }));
      const primary = round.find((b) => b.getAttribute('aria-label') !== '停止当前回合' && !b.disabled);
      if (primary) { out.primaryClicked = primary.getAttribute('aria-label'); primary.click(); }
      await sleep(2500);
      out.afterAction = snapshot();`;

  await cdp.evaluate(`(() => {
    window.__t091_a8 = null;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const snapshot = () => {
      const vis = (n) => n.offsetParent !== null;
      const s = window.__t091_store.getState();
      const byLabel = (l) => [...document.querySelectorAll('button[aria-label]')]
        .filter((b) => b.getAttribute('aria-label') === l)
        .map((b) => ({ disabled: b.disabled === true, visible: vis(b) }));
      return {
        t: new Date().toISOString(),
        active: s.activeSessionId,
        count: s.sessions.length,
        activeTitle: s.sessions.find((x) => x.id === s.activeSessionId)?.title ?? null,
        activeStatus: s.sessions.find((x) => x.id === s.activeSessionId)?.status ?? null,
        send: byLabel('发送消息'), stop: byLabel('停止当前回合'), queue: byLabel('加入队列'),
        statuses: Object.fromEntries(s.sessions.slice(0, 0).map(() => [])),
      };
    };
    (async () => {
      const out = {};
      const newBtn = [...document.querySelectorAll('button')]
        .find((n) => /^(新建|New)$/.test((n.innerText || '').trim()) && n.offsetParent !== null);
      const pre = window.__t091_store.getState();
      out.preActive = pre.activeSessionId;
      out.preCount = pre.sessions.length;
      out.newClickedAt = new Date().toISOString();
      newBtn.click();
      const post = window.__t091_store.getState();
      out.postActive = post.activeSessionId;
      out.postCount = post.sessions.length;
      out.created = post.activeSessionId !== pre.activeSessionId;
      await sleep(250);
      ${body}
      window.__t091_a8 = out;
    })();
    return 'kicked';
  })()`);

  const out = await cdp.waitFor(`window.__t091_a8 ? window.__t091_a8 : null`, {
    timeoutMs: 40_000,
    label: 'a8 result',
  });
  console.log(`[${stamp()}] a8(${MODE}) =`, JSON.stringify(out, null, 1));
  save(`a8-${MODE}-01-result.json`, out);

  const stopCalls = await cdp.evaluate(`JSON.parse(JSON.stringify(window.__t091_stopCalls ?? []))`);
  console.log('stopActiveSession calls:', JSON.stringify(stopCalls));
  save(`a8-${MODE}-02-stopcalls.json`, stopCalls);

  const pair = await evalAsync(
    `const s = window.__t091_store.getState();
     const ids = [${JSON.stringify(senderId)}, ${JSON.stringify(out.postActive)}];
     return ids.map((id) => ({ id,
       status: s.sessions.find((x) => x.id === id)?.status ?? null,
       title: s.sessions.find((x) => x.id === id)?.title ?? null,
       msgs: (s.messages[id] ?? []).length }));`,
    { label: 'pair' }
  );
  console.log('pair after:', JSON.stringify(pair));
  save(`a8-${MODE}-03-pair.json`, { senderId, newId: out.postActive, pair });
  save(
    `a8-${MODE}-04-sender-messages.json`,
    await evalAsync(messagesOf(senderId), { label: 'sender' })
  );
  save(
    `a8-${MODE}-05-new-messages.json`,
    await evalAsync(messagesOf(out.postActive), { label: 'new' })
  );
  save(`a8-${MODE}-06-store.json`, await evalAsync(STORE, { label: 'store' }));
  save(`a8-${MODE}-07-sidebar.json`, await cdp.evaluate(SIDEBAR));
  console.log('shot:', await shot(cdp, `a8-${MODE}.png`));
} finally {
  cdp.close();
}
