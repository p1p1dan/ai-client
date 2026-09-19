/**
 * T093 part 1 — the retry banner counts down, and 「立即放弃」 really gives up.
 *
 * The gateway answers 503 to everything, so the runtime walks its whole 3/10/30
 * second ladder. Sampling is once a second for the full ladder, which is the
 * only way to tell a LIVE countdown from the static "Next attempt in 30s" the
 * banner used to print once and leave.
 *
 * "Really gives up" is two readings, not one: the session leaves every busy
 * state AND the gateway's request counter stops moving.
 */
import {
  CLICK_NEW,
  CLICK_SEND,
  connect,
  RETRY_BANNER,
  save,
  sessionStatus,
  shot,
  sleep,
  stamp,
  typeInto,
} from './lib.mjs';

const { cdp, evalAsync } = await connect();
const gw = () => fetch('http://127.0.0.1:18099/health').then((r) => r.json());

try {
  await evalAsync(
    `const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
     window.__pci_store = chat.useChatSessionsStore; return 'ready';`,
    { label: 'prefetch' }
  );
  await cdp.evaluate(CLICK_NEW);
  await sleep(2000);
  const sid = await evalAsync(`return window.__pci_store.getState().activeSessionId;`, { label: 'sid' });
  console.log(`[${stamp()}] session ${sid}  gateway=${JSON.stringify(await gw())}`);

  console.log('typed:', await cdp.evaluate(typeInto('T093：渠道一直 503（点验倒计时与立即放弃）')));
  await cdp.waitFor(
    `(() => { const b = document.querySelector('[aria-label="发送消息"]'); return !!b && !b.disabled; })()`,
    { timeoutMs: 20_000, label: 'send enabled' }
  );
  const sentAt = Date.now();
  console.log(`[${stamp()}] send:`, JSON.stringify(await cdp.evaluate(CLICK_SEND)));

  const samples = [];
  let shotDone = false;
  for (let i = 0; i < 55; i += 1) {
    await sleep(1000);
    const banner = await cdp.evaluate(RETRY_BANNER);
    const st = await evalAsync(sessionStatus(sid), { label: `poll ${i}` });
    const row = { dt: Date.now() - sentAt, ...banner, status: st.status, retry: st.retry };
    samples.push(row);
    console.log(
      `  +${Math.round(row.dt / 1000)}s status=${row.status} countdown=${JSON.stringify(row.countdownText)}` +
        ` retryingNow=${row.retryingNow} giveUp=${row.giveUpButton} retry=${JSON.stringify(row.retry)}`
    );
    if (!shotDone && row.countdownText && row.giveUpButton) {
      console.log('shot (banner):', await shot(cdp, '05-a-countdown.png'));
      shotDone = true;
    }
  }
  save('05-00-countdown-samples.json', { sentAt, sid, samples });

  const distinct = [];
  for (const s of samples) {
    const label = `${s.countdownText ?? ''}|${s.retryingNow}`;
    if (label !== distinct[distinct.length - 1]?.label) distinct.push({ dt: s.dt, label });
  }
  console.log('countdown sequence:');
  for (const d of distinct) console.log(`  +${Math.round(d.dt / 1000)}s  ${d.label}`);
  save('05-01-countdown-sequence.json', distinct);

  // Give up while a countdown is on screen.
  const gwBefore = await gw();
  const give = await cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')]
      .find((n) => (n.innerText || '').trim() === '立即放弃' && n.offsetParent !== null);
    if (!b) return { ok: false, why: 'no 立即放弃 button on screen' };
    b.click();
    return { ok: true, at: new Date().toISOString() };
  })()`);
  console.log(`[${stamp()}] 立即放弃:`, JSON.stringify(give), 'gwBefore:', JSON.stringify(gwBefore));

  const after = [];
  for (let i = 0; i < 16; i += 1) {
    await sleep(2000);
    const st = await evalAsync(sessionStatus(sid), { label: `after ${i}` });
    const banner = await cdp.evaluate(RETRY_BANNER);
    const g = await gw();
    after.push({ t: st.t, status: st.status, gwCount: g.count, banner });
    console.log(`  [${st.t}] status=${st.status} gwCount=${g.count} banner=${JSON.stringify(banner.countdownText)} giveUp=${banner.giveUpButton}`);
  }
  save('05-02-after-giveup.json', { gwBefore, give, after });
  console.log('shot:', await shot(cdp, '05-b-after-giveup.png'));
  console.log('SID', sid);
} finally {
  cdp.close();
}
