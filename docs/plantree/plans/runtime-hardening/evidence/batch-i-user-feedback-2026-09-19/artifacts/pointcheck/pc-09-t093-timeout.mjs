/**
 * T093 part 2 — the idle timeout actually cuts a silent attempt.
 *
 * The gateway answers 200 and then sends zero bytes for two minutes, which is
 * the shape decision 029 exists for: the connection is accepted, so a HEADERS
 * timeout can never fire and only the body/idle timeout can end it.
 *
 * The setting was moved to 30 s and the app RESTARTED, because the worker reads
 * it once when it starts — changing it with a worker already up proves nothing.
 *
 * The evidence is the operator log line, tailed from the file rather than read
 * off the screen: `provider retry 1/3 in 3000ms after ~30000ms`.
 */
import fs from 'node:fs';
import { CLICK_SEND, connect, RETRY_BANNER, save, sessionStatus, shot, sleep, stamp, typeInto } from './lib.mjs';

const MAIN_LOG = '/home/ai/.config/jyw-ai-client-dev/logs/aiclient-2026-09-19.log';
const startOffset = fs.statSync(MAIN_LOG).size;
const newLogLines = () => {
  const fd = fs.openSync(MAIN_LOG, 'r');
  const size = fs.statSync(MAIN_LOG).size;
  if (size <= startOffset) { fs.closeSync(fd); return []; }
  const buf = Buffer.alloc(size - startOffset);
  fs.readSync(fd, buf, 0, buf.length, startOffset);
  fs.closeSync(fd);
  return buf.toString('utf8').split('\n');
};

const { cdp, evalAsync } = await connect();
try {
  await evalAsync(
    `const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
     window.__pci_store = chat.useChatSessionsStore; return 'ready';`,
    { label: 'prefetch' }
  );
  const sid = await evalAsync(`return window.__pci_store.getState().activeSessionId;`, { label: 'sid' });
  const idle = await evalAsync(
    `const s = await import(/* @vite-ignore */ '/stores/settings/index.ts');
     return s.useSettingsStore.getState().providerIdleTimeoutMs;`,
    { label: 'idle setting' }
  );
  console.log(`[${stamp()}] session ${sid}  providerIdleTimeoutMs=${idle}  mainLog offset=${startOffset}`);

  console.log('typed:', await cdp.evaluate(typeInto('T093c：网关收下请求后不发任何字节（点验空闲超时）')));
  await cdp.waitFor(
    `(() => { const b = document.querySelector('[aria-label="发送消息"]'); return !!b && !b.disabled; })()`,
    { timeoutMs: 20_000, label: 'send enabled' }
  );
  const sentAt = Date.now();
  console.log(`[${stamp()}] send:`, JSON.stringify(await cdp.evaluate(CLICK_SEND)));

  const samples = [];
  let retryLineAt = null;
  for (let i = 0; i < 60; i += 1) {
    await sleep(2000);
    const st = await evalAsync(sessionStatus(sid), { label: `poll ${i}` });
    const banner = await cdp.evaluate(RETRY_BANNER);
    const lines = newLogLines().filter((l) => /provider retry|turn failed|idle|timeout|TIMEOUT/i.test(l));
    samples.push({ dt: Date.now() - sentAt, status: st.status, retry: st.retry,
                   countdown: banner.countdownText, logLines: lines.length });
    const hit = lines.find((l) => /provider retry/.test(l));
    if (hit && !retryLineAt) {
      retryLineAt = Date.now() - sentAt;
      console.log(`*** +${Math.round(retryLineAt / 1000)}s  ${hit.trim()}`);
      console.log('shot:', await shot(cdp, '09-a-first-timeout.png'));
    }
    console.log(
      `  +${Math.round((Date.now() - sentAt) / 1000)}s status=${st.status}` +
        ` retry=${st.retry ? `${st.retry.attempt}/${st.retry.maxRetries} delay=${st.retry.delayMs}` : 'null'}` +
        ` countdown=${JSON.stringify(banner.countdownText)}`
    );
    if (st.status === 'idle' && retryLineAt) break;
  }
  const all = newLogLines();
  const retries = all.filter((l) => /provider retry/.test(l));
  const failures = all.filter((l) => /turn failed|PROVIDER|NETWORK_ERROR/i.test(l));
  console.log('--- provider retry lines ---');
  for (const l of retries) console.log('  ' + l.trim());
  console.log('--- failure lines ---');
  for (const l of failures.slice(0, 8)) console.log('  ' + l.trim().slice(0, 300));
  save('09-00-timeout.json', { idle, sentAt, retryLineAt, samples, retries, failures: failures.slice(0, 20) });
  console.log('shot:', await shot(cdp, '09-b-after.png'));
} finally {
  cdp.close();
}
