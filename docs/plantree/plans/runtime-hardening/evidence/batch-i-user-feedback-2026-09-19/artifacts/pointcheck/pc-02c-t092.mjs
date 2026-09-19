/** T092, take 3 — the confirm is an ALERT dialog; finish from the open box. */
import {
  CLICK_SEND,
  connect,
  DIALOG,
  messagesOf,
  save,
  sessionStatus,
  shot,
  sleep,
  stamp,
  STORE,
  typeInto,
} from './lib.mjs';

const target = process.argv[2];
const { cdp, evalAsync } = await connect();
const TRANSCRIPT = `(() => {
  const vps = [...document.querySelectorAll('[data-slot="scroll-area-viewport"]')]
    .filter((v) => v.offsetParent !== null);
  let best = '', bestLen = -1;
  for (const v of vps) { const t = v.innerText || ''; if (t.length > bestLen) { bestLen = t.length; best = t; } }
  return { len: best.length, tail: best.slice(-400),
           emptyState: /暂无消息|No messages|还没有消息/.test(document.body.innerText) };
})()`;

try {
  const dialog = await cdp.evaluate(DIALOG);
  console.log('dialog now:', JSON.stringify(dialog));
  save('02c-00-dialog.json', dialog);

  const before = {
    status: await evalAsync(sessionStatus(target), { label: 'before' }),
    transcript: await cdp.evaluate(TRANSCRIPT),
  };
  console.log(`BEFORE status=${before.status.status} msgs=${before.status.msgs} bound=${before.status.hostBound} len=${before.transcript.len}`);
  save('02c-01-before.json', before);

  const confirmed = await cdp.evaluate(`(() => {
    const vis = (n) => n.offsetParent !== null;
    const btn = [...document.querySelectorAll('[data-slot="alert-dialog-popup"] button, [role="alertdialog"] button')]
      .filter(vis)
      .find((b) => (b.innerText || '').trim() === '结束对话');
    if (!btn) return { ok: false };
    btn.click();
    return { ok: true, at: new Date().toISOString() };
  })()`);
  console.log(`[${stamp()}] confirm:`, JSON.stringify(confirmed));

  const series = [];
  for (let i = 0; i < 10; i += 1) {
    await sleep(1500);
    const row = {
      status: await evalAsync(sessionStatus(target), { label: `after ${i}` }),
      transcript: await cdp.evaluate(TRANSCRIPT),
    };
    series.push(row);
    console.log(
      `  [${row.status.t}] status=${row.status.status} msgs=${row.status.msgs} bound=${row.status.hostBound}` +
        ` active=${row.status.active === target ? 'TARGET' : row.status.active} len=${row.transcript.len} empty=${row.transcript.emptyState}`
    );
  }
  save('02c-02-after-end.json', series);
  save('02c-03-messages.json', await evalAsync(messagesOf(target), { label: 'msgs' }));
  console.log('shot:', await shot(cdp, '02c-a-after-end.png'));

  console.log('typed:', await cdp.evaluate(typeInto('T092：结束后再发一条，应自动 resume')));
  await sleep(900);
  console.log(`[${stamp()}] send:`, JSON.stringify(await cdp.evaluate(CLICK_SEND)));
  const resume = [];
  for (let i = 0; i < 18; i += 1) {
    await sleep(2500);
    const st = await evalAsync(sessionStatus(target), { label: `resume ${i}` });
    resume.push(st);
    console.log(`  [${st.t}] status=${st.status} msgs=${st.msgs} bound=${st.hostBound}`);
    if (st.hostBound && st.status === 'running') break;
  }
  save('02c-04-resume.json', resume);
  save('02c-05-store.json', await evalAsync(STORE, { label: 'store' }));
  console.log('shot:', await shot(cdp, '02c-b-after-resume.png'));
  console.log('gateway:', JSON.stringify(await fetch('http://127.0.0.1:18099/health').then((r) => r.json())));
} finally {
  cdp.close();
}
