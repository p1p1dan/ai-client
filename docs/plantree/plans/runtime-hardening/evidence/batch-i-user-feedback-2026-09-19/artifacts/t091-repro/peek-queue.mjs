import { connect, save, shot, sleep, stamp } from './lib.mjs';

const { cdp, evalAsync } = await connect();
try {
  const q = await evalAsync(
    `const m = await import(/* @vite-ignore */ '/stores/messageQueue.ts').catch(() => null);
     const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
     const s = chat.useChatSessionsStore.getState();
     const out = { t: new Date().toISOString(), active: s.activeSessionId,
       activeStatus: s.sessions.find((x) => x.id === s.activeSessionId)?.status ?? null,
       activeMsgs: (s.messages[s.activeSessionId] ?? []).length };
     if (m) {
       const keys = Object.keys(m);
       const storeKey = keys.find((k) => /useMessageQueueStore/.test(k));
       out.moduleKeys = keys;
       if (storeKey) out.queue = JSON.parse(JSON.stringify(m[storeKey].getState()));
     } else { out.note = 'module path miss'; }
     return out;`,
    { label: 'queue' }
  );
  console.log(JSON.stringify(q, null, 1).slice(0, 3000));
  save('a10-07-queue.json', q);
  const dom = await cdp.evaluate(`(() => {
    const t = document.body.innerText;
    return { hasQueueWord: /队列|排队/.test(t),
             around: (t.match(/.{0,80}(队列|排队).{0,120}/g) || []).slice(0, 6) };
  })()`);
  console.log(JSON.stringify(dom, null, 1));
  save('a10-08-queue-dom.json', dom);
  console.log('shot:', await shot(cdp, 'a10-queue-state.png'));
} finally {
  cdp.close();
}
