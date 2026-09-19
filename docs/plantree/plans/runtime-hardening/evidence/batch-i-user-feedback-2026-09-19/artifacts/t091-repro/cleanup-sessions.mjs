import { connect, STORE, save, sleep } from './lib.mjs';

const { cdp, evalAsync } = await connect();
try {
  const r = await evalAsync(
    `const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
     const s = chat.useChatSessionsStore.getState();
     const busy = new Set(['starting','running','stopping','waiting_permission','waiting_question']);
     const targets = s.sessions.filter((x) => busy.has(x.status)).map((x) => x.id);
     for (const id of targets) { try { await window.electronAPI.chat.stop({ sessionId: id }); } catch (e) {} }
     return { targets };`,
    { label: 'stop all', timeoutMs: 60000 }
  );
  console.log('stopped:', JSON.stringify(r));
  await sleep(6000);
  const st = await evalAsync(STORE, { label: 'store' });
  console.log('statuses now:', JSON.stringify(st.sessions.map((x) => x.status)));
  save('cleanup-store.json', st);
} finally {
  cdp.close();
}
