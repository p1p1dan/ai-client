/**
 * Addendum check 3 — coming back to the window must refresh history and
 * branches once.
 *
 * Why it matters: polling is suspended while the window is in the background
 * (`useShouldPoll` → idle), and React Query's own refetch-on-focus is a no-op
 * here because `renderer/index.tsx` sets a 60s global `staleTime`. T100 adds
 * an explicit invalidate on the focus edge; this measures it.
 *
 * Three phases, each sampled once a second off the QueryClient cache:
 *   control — nothing touched, so history/branches must NOT move;
 *   blurred — the fingerprint poll must stop;
 *   refocused — history, branches and the fingerprint must each move once.
 *
 * The blur/focus edges are dispatched as `window` events rather than taken
 * from the window manager: `useWindowFocus.ts` listens for exactly
 * `focus`/`blur`/`visibilitychange`, and a synthetic event drives the same
 * listener a real one would. Whether the OS actually moved focus is not part
 * of what is being measured.
 */
import { connect, save, shot, sleep, stamp } from './lib.mjs';

const { cdp } = await connect();

const GRAB_CLIENT = `(() => {
  if (window.__pcQC) return 'already';
  const host = document.getElementById('root');
  const key = Object.keys(host).find((k) => k.startsWith('__reactContainer$'));
  if (!key) return 'no fiber key';
  const stack = [host[key]];
  const seen = new Set();
  while (stack.length) {
    const f = stack.pop();
    if (!f || seen.has(f)) continue;
    seen.add(f);
    const c = f.memoizedProps && f.memoizedProps.client;
    if (c && typeof c.getQueryCache === 'function') { window.__pcQC = c; return 'found'; }
    if (f.child) stack.push(f.child);
    if (f.sibling) stack.push(f.sibling);
  }
  return 'not found';
})()`;

const SAMPLE = `(() => {
  const qc = window.__pcQC;
  if (!qc) return { error: 'no query client' };
  const out = { t: Date.now(), hidden: document.hidden, hasFocus: document.hasFocus() };
  for (const q of qc.getQueryCache().getAll()) {
    if (!Array.isArray(q.queryKey) || q.queryKey[0] !== 'git') continue;
    const scope = q.queryKey[1];
    if (!['log-infinite', 'branches', 'head-signature'].includes(scope)) continue;
    const obs = q.getObserversCount ? q.getObserversCount() : (q.observers || []).length;
    if (obs === 0 && out[scope]) continue; // prefer the mounted one
    out[scope] = { updates: q.state.dataUpdateCount, at: q.state.dataUpdatedAt,
                   fetchStatus: q.state.fetchStatus, observers: obs };
  }
  return out;
})()`;

const fire = (type) => `(() => {
  window.dispatchEvent(new Event(${JSON.stringify(type)}));
  return { t: Date.now(), type: ${JSON.stringify(type)} };
})()`;

async function phase(label, seconds) {
  const samples = [];
  for (let i = 0; i < seconds; i += 1) {
    samples.push(await cdp.evaluate(SAMPLE));
    await sleep(1000);
  }
  const first = samples[0];
  const last = samples[samples.length - 1];
  const delta = {};
  for (const scope of ['log-infinite', 'branches', 'head-signature']) {
    delta[scope] = (last[scope]?.updates ?? 0) - (first[scope]?.updates ?? 0);
  }
  console.log(`${label} (${seconds}s): Δupdates ${JSON.stringify(delta)}  focus=${last.hasFocus} hidden=${last.hidden}`);
  return { samples, delta, spanMs: last.t - first.t };
}

const result = { at: stamp() };
try {
  console.log('query client:', await cdp.evaluate(GRAB_CLIENT));
  result.control = await phase('control  ', 12);
  result.blurEvent = await cdp.evaluate(fire('blur'));
  result.blurred = await phase('blurred  ', 10);
  result.focusEvent = await cdp.evaluate(fire('focus'));
  result.refocused = await phase('refocused', 8);
  console.log('shot:', await shot(cdp, '14-a-after-refocus.png'));
} catch (error) {
  result.error = String(error && error.message);
  console.log('ERROR:', result.error);
} finally {
  save('14-00-result.json', result);
  cdp.close();
}
