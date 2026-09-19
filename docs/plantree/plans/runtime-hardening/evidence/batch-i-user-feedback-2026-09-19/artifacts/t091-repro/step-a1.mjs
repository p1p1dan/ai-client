import {
  CLICK_SEND,
  COMPOSER,
  connect,
  READ_SPY,
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
  const s0 = await evalAsync(STORE, { label: 'store' });
  const s1 = s0.activeSessionId;
  console.log(`[${stamp()}] S1 = ${s1}`);

  console.log('typed chars:', await cdp.evaluate(typeInto('T091 场景A：请开始一个长回合')));
  await cdp.waitFor(
    `(() => { const b = document.querySelector('[aria-label="发送消息"]'); return !!b && !b.disabled; })()`,
    { timeoutMs: 15_000, label: 'send enabled' }
  );
  const sent = await cdp.evaluate(CLICK_SEND);
  console.log(`[${stamp()}] send:`, JSON.stringify(sent));

  // Poll the status of S1 until it is genuinely busy.
  const deadline = Date.now() + 120_000;
  let last = null;
  while (Date.now() < deadline) {
    last = await evalAsync(
      `const s = window.__t091_store.getState();
       const x = s.sessions.find((v) => v.id === ${JSON.stringify(s1)});
       return { t: new Date().toISOString(), status: x?.status ?? null, title: x?.title ?? null,
                msgs: (s.messages[${JSON.stringify(s1)}] ?? []).length,
                hostBound: s.hostBoundSessionIds.includes(${JSON.stringify(s1)}),
                pendingPermissions: s.pendingPermissions.length,
                count: s.sessions.length, active: s.activeSessionId };`,
      { label: 'poll s1' }
    );
    console.log(
      `[${last.t}] status=${last.status} msgs=${last.msgs} hostBound=${last.hostBound} perms=${last.pendingPermissions}`
    );
    if (last.status === 'running') break;
    await sleep(2000);
  }
  save('a1-01-s1-running.json', { s1, poll: last });
  save('a1-02-store.json', await evalAsync(STORE, { label: 'store' }));
  save('a1-03-composer.json', await cdp.evaluate(COMPOSER));
  save('a1-04-sidebar.json', await cdp.evaluate(SIDEBAR));
  save('a1-05-spy.json', await cdp.evaluate(READ_SPY));
  console.log('shot:', await shot(cdp, 'a1-s1-running.png'));
} finally {
  cdp.close();
}
