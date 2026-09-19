/**
 * T093 part 1b — screenshot the banner and actually press 「立即放弃」.
 *
 * The first run reported "no 立即放弃 button" while the same probe's own
 * `bannerLines` (read from `document.body.innerText`) listed 立即放弃 one line
 * below the countdown. The button therefore existed; the finder was wrong, so
 * this one matches on `textContent` and reports every near-miss instead of a
 * silent `false`.
 *
 * The click is made on the 30 s rung, which is the only one long enough to be
 * sure the press landed during a wait rather than between two attempts.
 */
import { CLICK_NEW, CLICK_SEND, connect, RETRY_BANNER, save, sessionStatus, shot, sleep, stamp, typeInto } from './lib.mjs';

const { cdp, evalAsync } = await connect();
const gw = () => fetch('http://127.0.0.1:18099/health').then((r) => r.json());

const BUTTON_DUMP = `(() => {
  const all = [...document.querySelectorAll('button')];
  const near = all
    .map((b, i) => ({
      i,
      innerText: JSON.stringify((b.innerText ?? '').slice(0, 30)),
      textContent: JSON.stringify((b.textContent ?? '').slice(0, 30)),
      offsetParentNull: b.offsetParent === null,
      rect: (() => { const r = b.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top) }; })(),
    }))
    .filter((x) => /放弃/.test(x.innerText) || /放弃/.test(x.textContent));
  return { total: all.length, near };
})()`;

try {
  await evalAsync(
    `const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
     window.__pci_store = chat.useChatSessionsStore; return 'ready';`,
    { label: 'prefetch' }
  );
  await cdp.evaluate(CLICK_NEW);
  await sleep(2000);
  const sid = await evalAsync(`return window.__pci_store.getState().activeSessionId;`, { label: 'sid' });
  console.log(`[${stamp()}] session ${sid}`);

  console.log('typed:', await cdp.evaluate(typeInto('T093b：一直 503，点验「立即放弃」')));
  await cdp.waitFor(
    `(() => { const b = document.querySelector('[aria-label="发送消息"]'); return !!b && !b.disabled; })()`,
    { timeoutMs: 20_000, label: 'send enabled' }
  );
  console.log(`[${stamp()}] send:`, JSON.stringify(await cdp.evaluate(CLICK_SEND)));

  // Wait for the 30 s rung (attempt 3), so the press lands inside a long wait.
  let st = null;
  for (let i = 0; i < 40; i += 1) {
    await sleep(1000);
    st = await evalAsync(sessionStatus(sid), { label: `poll ${i}` });
    const banner = await cdp.evaluate(RETRY_BANNER);
    if (i % 4 === 0 || st.retry) {
      console.log(`  +${i}s status=${st.status} retry=${JSON.stringify(st.retry?.attempt ?? null)}/${st.retry?.maxRetries ?? '?'} countdown=${JSON.stringify(banner.countdownText)}`);
    }
    if (st.retry?.delayMs === 30_000) break;
  }
  const dump = await cdp.evaluate(BUTTON_DUMP);
  console.log('buttons matching 放弃:', JSON.stringify(dump, null, 1));
  save('05b-00-button-dump.json', dump);
  const banner = await cdp.evaluate(RETRY_BANNER);
  console.log('banner now:', JSON.stringify(banner));
  save('05b-01-banner.json', { banner, status: st });
  console.log('shot (countdown + give-up):', await shot(cdp, '05b-a-countdown-banner.png'));

  const gwBefore = await gw();
  const give = await cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')]
      .find((n) => /立即放弃/.test(n.textContent ?? ''));
    if (!b) return { ok: false, why: 'no button whose textContent contains 立即放弃' };
    b.click();
    return { ok: true, at: new Date().toISOString(),
             innerText: JSON.stringify(b.innerText), textContent: JSON.stringify(b.textContent) };
  })()`);
  console.log(`[${stamp()}] 立即放弃 click:`, JSON.stringify(give), 'gwBefore:', JSON.stringify(gwBefore));

  const after = [];
  for (let i = 0; i < 20; i += 1) {
    await sleep(2500);
    const s = await evalAsync(sessionStatus(sid), { label: `after ${i}` });
    const b = await cdp.evaluate(RETRY_BANNER);
    const g = await gw();
    after.push({ t: s.t, status: s.status, retry: s.retry, gwCount: g.count, banner: b });
    console.log(`  [${s.t}] status=${s.status} gwCount=${g.count} countdown=${JSON.stringify(b.countdownText)} giveUp=${b.giveUpButton}`);
  }
  save('05b-02-after-giveup.json', { gwBefore, give, after });
  console.log('shot:', await shot(cdp, '05b-b-after-giveup.png'));
  const g = await gw();
  console.log(`gateway requests: before=${gwBefore.count} after=${g.count} (delta ${g.count - gwBefore.count})`);
  console.log('SID', sid);
} finally {
  cdp.close();
}
