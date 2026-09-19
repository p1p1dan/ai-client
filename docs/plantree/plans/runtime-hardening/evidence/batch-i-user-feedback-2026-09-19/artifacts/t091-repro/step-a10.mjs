/**
 * A-4, done by WAITING for the stale-Stop condition instead of guessing its
 * timing: send, press New, then poll until (active === the new empty chat AND
 * the Stop button is on screen). Only then type, read which round button the
 * composer offers, press it, and follow where the text lands.
 */
import {
  CLICK_SEND,
  connect,
  messagesOf,
  SIDEBAR,
  STORE,
  save,
  shot,
  sleep,
  stamp,
  typeInto,
} from './lib.mjs';

const { cdp, evalAsync } = await connect();
try {
  await evalAsync(
    `const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
     window.__t091_store = chat.useChatSessionsStore; return 'ready';`,
    { label: 'prefetch' }
  );

  await cdp.evaluate(`(() => {
    [...document.querySelectorAll('button')]
      .find((n) => /^(新建|New)$/.test((n.innerText || '').trim()) && n.offsetParent !== null).click();
    return true; })()`);
  await sleep(1500);
  const senderId = await cdp.evaluate(`window.__t091_store.getState().activeSessionId`);
  console.log(`[${stamp()}] sender = ${senderId}`);
  await cdp.evaluate(typeInto('T091 A10：长回合，请一直跑'));
  await cdp.waitFor(
    `(() => { const b = document.querySelector('[aria-label="发送消息"]'); return !!b && !b.disabled; })()`,
    { timeoutMs: 15_000, label: 'send enabled' }
  );
  await cdp.evaluate(CLICK_SEND);
  console.log(`[${stamp()}] sent`);
  await sleep(900);

  await cdp.evaluate(`(() => {
    window.__t091_a10 = null;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const byLabel = (l) => [...document.querySelectorAll('button[aria-label]')]
      .filter((b) => b.getAttribute('aria-label') === l && b.offsetParent !== null);
    const roundLabels = () => [...document.querySelectorAll('button[aria-label]')]
      .filter((b) => ['发送消息','加入队列','停止当前回合','重试上一条消息'].includes(b.getAttribute('aria-label')) && b.offsetParent !== null)
      .map((b) => ({ label: b.getAttribute('aria-label'), disabled: b.disabled === true }));
    const snap = () => {
      const s = window.__t091_store.getState();
      return { t: new Date().toISOString(), active: s.activeSessionId, count: s.sessions.length,
               activeTitle: s.sessions.find((x) => x.id === s.activeSessionId)?.title ?? null,
               activeStatus: s.sessions.find((x) => x.id === s.activeSessionId)?.status ?? null,
               round: roundLabels() };
    };
    (async () => {
      const out = { trace: [] };
      const store = window.__t091_store;
      const pre = store.getState();
      out.senderId = pre.activeSessionId;
      [...document.querySelectorAll('button')]
        .find((n) => /^(新建|New)$/.test((n.innerText || '').trim()) && n.offsetParent !== null).click();
      out.newClickedAt = new Date().toISOString();
      const post = store.getState();
      out.newId = post.activeSessionId;
      out.created = post.activeSessionId !== pre.activeSessionId;
      out.countBefore = pre.sessions.length;
      out.countAfter = post.sessions.length;

      // Wait for the stale-Stop condition on the NEW chat.
      let hit = null;
      for (let i = 0; i < 40; i += 1) {
        await sleep(100);
        const s = snap();
        out.trace.push(s);
        if (s.active === out.newId && byLabel('停止当前回合').length > 0) { hit = s; break; }
      }
      out.staleStopSeen = hit;
      if (!hit) { window.__t091_a10 = out; return; }

      // Type inside that window and read what the composer offers.
      const ta = document.querySelector('textarea');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, 'T091 A10-B：这条在新对话里输入');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(150);
      out.afterTyping = snap();
      const primary = [...document.querySelectorAll('button[aria-label]')]
        .find((b) => ['发送消息','加入队列'].includes(b.getAttribute('aria-label')) && b.offsetParent !== null && !b.disabled);
      out.primaryLabel = primary ? primary.getAttribute('aria-label') : null;
      if (primary) { primary.click(); out.primaryClickedAt = new Date().toISOString(); }
      for (let i = 0; i < 20; i += 1) {
        await sleep(1000);
        const s = store.getState();
        out.trace.push({
          t: new Date().toISOString(), phase: 'post-click',
          sender: { status: s.sessions.find((x) => x.id === out.senderId)?.status ?? null,
                    msgs: (s.messages[out.senderId] ?? []).length },
          fresh: { status: s.sessions.find((x) => x.id === out.newId)?.status ?? null,
                   msgs: (s.messages[out.newId] ?? []).length,
                   title: s.sessions.find((x) => x.id === out.newId)?.title ?? null },
          round: roundLabels(),
          textarea: document.querySelector('textarea')?.value ?? null,
        });
      }
      window.__t091_a10 = out;
    })();
    return 'kicked';
  })()`);

  const out = await cdp.waitFor(`window.__t091_a10 ? window.__t091_a10 : null`, {
    timeoutMs: 90_000,
    label: 'a10',
  });
  console.log('created:', out.created, out.countBefore, '->', out.countAfter);
  console.log('staleStopSeen:', JSON.stringify(out.staleStopSeen));
  console.log('afterTyping:', JSON.stringify(out.afterTyping));
  console.log('primaryLabel:', out.primaryLabel, 'at', out.primaryClickedAt);
  for (const r of out.trace.filter((x) => x.phase === 'post-click')) {
    console.log(
      `  [${r.t}] sender=${r.sender.status}/${r.sender.msgs} fresh=${r.fresh.status}/${r.fresh.msgs} title=${JSON.stringify(r.fresh.title)} round=${JSON.stringify(r.round)} ta=${JSON.stringify(r.textarea)}`
    );
  }
  save('a10-01-result.json', out);
  save(
    'a10-02-sender-messages.json',
    await evalAsync(messagesOf(out.senderId), { label: 'sender' })
  );
  save('a10-03-new-messages.json', await evalAsync(messagesOf(out.newId), { label: 'new' }));
  save('a10-04-store.json', await evalAsync(STORE, { label: 'store' }));
  save('a10-05-sidebar.json', await cdp.evaluate(SIDEBAR));
  console.log('shot:', await shot(cdp, 'a10-a4-typed-in-new-chat.png'));
  const gw = await fetch('http://127.0.0.1:18099/health').then((r) => r.json());
  console.log('gateway:', JSON.stringify(gw));
  save('a10-06-gateway.json', gw);
} finally {
  cdp.close();
}
