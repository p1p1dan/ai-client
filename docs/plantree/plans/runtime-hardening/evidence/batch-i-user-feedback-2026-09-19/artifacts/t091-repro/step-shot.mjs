/** Capture the exact frame report #1 describes: a brand-new empty chat that
 *  still shows the Stop button. */
import { CLICK_SEND, connect, save, shot, sleep, stamp, typeInto } from './lib.mjs';

const { cdp, evalAsync } = await connect();
try {
  await evalAsync(
    `const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
     window.__t091_store = chat.useChatSessionsStore; return 'ready';`,
    { label: 'prefetch' }
  );
  // Non-fresh session first so New really creates one.
  await cdp.evaluate(`(() => {
    const r = [...document.querySelectorAll('[role="button"][title]')]
      .filter((n) => n.offsetParent !== null && n.getAttribute('title') === '点验重命名-0919');
    if (r[0]) r[0].click(); return r.length; })()`);
  await sleep(2500);
  await cdp.evaluate(`(() => {
    [...document.querySelectorAll('button')]
      .find((n) => /^(新建|New)$/.test((n.innerText || '').trim()) && n.offsetParent !== null).click();
    return true; })()`);
  await sleep(1500);
  const sender = await cdp.evaluate(`window.__t091_store.getState().activeSessionId`);
  console.log(`[${stamp()}] sender=${sender}`);
  await cdp.evaluate(typeInto('T091 截图用：长回合'));
  await cdp.waitFor(
    `(() => { const b = document.querySelector('[aria-label="发送消息"]'); return !!b && !b.disabled; })()`,
    { timeoutMs: 15_000, label: 'send enabled' }
  );
  await cdp.evaluate(CLICK_SEND);
  const sentAt = Date.now();
  console.log(`[${stamp()}] sent`);
  await cdp.evaluate(
    `(() => { const xs = [...document.querySelectorAll('button[aria-label="Close"],button[aria-label="关闭"]')].filter((n)=>n.offsetParent!==null); xs.forEach((b)=>b.click()); return xs.length; })()`
  );
  await sleep(Number(process.argv[2] ?? 1300));

  const click = await cdp.evaluate(`(() => {
    const store = window.__t091_store;
    const pre = store.getState();
    [...document.querySelectorAll('button')]
      .find((n) => /^(新建|New)$/.test((n.innerText || '').trim()) && n.offsetParent !== null).click();
    const post = store.getState();
    return { preCount: pre.sessions.length, postCount: post.sessions.length,
             created: post.activeSessionId !== pre.activeSessionId,
             newId: post.activeSessionId, senderId: pre.activeSessionId };
  })()`);
  console.log(`New at +${Date.now() - sentAt}ms:`, JSON.stringify(click));

  let captured = null;
  for (let i = 0; i < 30; i += 1) {
    const s = await cdp.evaluate(`(() => {
      const vis = (n) => n.offsetParent !== null;
      const st = window.__t091_store.getState();
      const stop = [...document.querySelectorAll('button[aria-label]')]
        .find((b) => b.getAttribute('aria-label') === '停止当前回合' && vis(b));
      return { t: new Date().toISOString(), active: st.activeSessionId,
               title: st.sessions.find((x) => x.id === st.activeSessionId)?.title ?? null,
               status: st.sessions.find((x) => x.id === st.activeSessionId)?.status ?? null,
               msgs: (st.messages[st.activeSessionId] ?? []).length,
               stopVisible: !!stop,
               senderStatus: st.sessions.find((x) => x.id === ${JSON.stringify(click.senderId)})?.status ?? null };
    })()`);
    if (s.active === click.newId && s.stopVisible) {
      captured = s;
      console.log('CAPTURED:', JSON.stringify(s));
      console.log('shot:', await shot(cdp, 'A3-new-empty-chat-still-shows-stop.png'));
      break;
    }
    await sleep(100);
  }
  if (!captured) console.log('window missed this run');
  save('shot-capture.json', { click, captured });
} finally {
  cdp.close();
}
