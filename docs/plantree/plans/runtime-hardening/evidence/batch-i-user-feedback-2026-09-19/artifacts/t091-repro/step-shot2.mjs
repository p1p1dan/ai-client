import { CLICK_SEND, connect, save, shot, sleep, stamp, typeInto } from './lib.mjs';

const { cdp, evalAsync } = await connect();
try {
  await evalAsync(
    `const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
     window.__t091_store = chat.useChatSessionsStore; return 'ready';`,
    { label: 'prefetch' }
  );
  await cdp.evaluate(`(() => { const r=[...document.querySelectorAll('[role="button"][title]')]
      .filter((n)=>n.offsetParent!==null&&n.getAttribute('title')==='点验重命名-0919'); if(r[0])r[0].click(); return r.length;})()`);
  await sleep(2500);
  await cdp.evaluate(`(() => {[...document.querySelectorAll('button')]
      .find((n)=>/^(新建|New)$/.test((n.innerText||'').trim())&&n.offsetParent!==null).click(); return true;})()`);
  await sleep(1500);
  await cdp.evaluate(typeInto('T091 截图2：长回合'));
  await cdp.waitFor(
    `(() => { const b=document.querySelector('[aria-label="发送消息"]'); return !!b && !b.disabled; })()`,
    { timeoutMs: 15000, label: 'send enabled' }
  );
  await cdp.evaluate(
    `(() => { const xs=[...document.querySelectorAll('button[aria-label="Close"],button[aria-label="关闭"]')].filter((n)=>n.offsetParent!==null); xs.forEach((b)=>b.click()); return xs.length; })()`
  );
  await cdp.evaluate(CLICK_SEND);
  console.log(`[${stamp()}] sent`);
  // Page-side: wait for hostBound, then click New, then park the observation.
  await cdp.evaluate(`(() => {
    window.__t091_shot = null;
    const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
    (async () => {
      const store = window.__t091_store;
      const sender = store.getState().activeSessionId;
      for (let i=0;i<120;i++){ if(store.getState().hostBoundSessionIds.includes(sender)) break; await sleep(50); }
      const pre = store.getState();
      [...document.querySelectorAll('button')]
        .find((n)=>/^(新建|New)$/.test((n.innerText||'').trim())&&n.offsetParent!==null).click();
      const post = store.getState();
      await sleep(180);
      const vis=(n)=>n.offsetParent!==null;
      const stop=[...document.querySelectorAll('button[aria-label]')]
        .find((b)=>b.getAttribute('aria-label')==='停止当前回合'&&vis(b));
      window.__t091_shot = { t:new Date().toISOString(), sender,
        created: post.activeSessionId!==pre.activeSessionId,
        preCount: pre.sessions.length, postCount: post.sessions.length,
        newId: post.activeSessionId,
        newTitle: post.sessions.find(x=>x.id===post.activeSessionId)?.title ?? null,
        newStatus: post.sessions.find(x=>x.id===post.activeSessionId)?.status ?? null,
        newMsgs: (post.messages[post.activeSessionId]??[]).length,
        stopVisible: !!stop,
        senderStatus: post.sessions.find(x=>x.id===sender)?.status ?? null };
    })();
    return 'kicked';
  })()`);
  const r = await cdp.waitFor(`window.__t091_shot ? window.__t091_shot : null`, {
    timeoutMs: 40000,
    label: 'shot2',
  });
  console.log('observed:', JSON.stringify(r));
  if (r.stopVisible && r.created)
    console.log('shot:', await shot(cdp, 'A3-created-new-chat-still-shows-stop.png'));
  else console.log('shot(anyway):', await shot(cdp, 'A3-attempt.png'));
  save('shot2.json', r);
} finally {
  cdp.close();
}
