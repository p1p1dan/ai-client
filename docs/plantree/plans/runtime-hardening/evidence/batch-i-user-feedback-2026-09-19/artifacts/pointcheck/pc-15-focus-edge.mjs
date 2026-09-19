/**
 * Addendum check 3, decisive pass.
 *
 * `pc-14` saw the fingerprint query move after a refocus while history and
 * branches did not, but that reading is ambiguous: the fingerprint also moves
 * because its 5s poll resumes, and "no movement" in history/branches is what
 * an idle window looks like anyway.
 *
 * This pass removes the ambiguity by listening to the QueryCache itself and
 * by staging a change the window CANNOT already know about:
 *
 *   1. wake the window (a real mouse move resets the 90s idle timer) and
 *      confirm the fingerprint poll is ticking — otherwise every later
 *      "nothing happened" is meaningless;
 *   2. blur; confirm the poll stops (proves the blur reached the hook);
 *   3. create a branch from the command line WHILE blurred — the app cannot
 *      see it, because nothing is polling;
 *   4. focus; timestamp every cache event from that instant.
 *
 * If T100's focus-edge invalidate works, history and branches refetch within
 * milliseconds of the focus event. If it does not, the panel only catches up
 * when the 5s poll happens to come round again.
 */
import { spawnSync } from 'node:child_process';
import { connect, REPO, save, shot, sleep, stamp } from './lib.mjs';

const BRANCH = 't100-probe-branch';
const { cdp } = await connect();

const git = (...args) => {
  const r = spawnSync('git', args, { cwd: REPO, encoding: 'utf8' });
  console.log(`  $ git ${args.join(' ')} -> [${r.status}] ${`${r.stdout || ''}${r.stderr || ''}`.trim().slice(0, 120)}`);
  return r.status;
};

const INSTALL = `(() => {
  const qc = window.__pcQC;
  if (!qc) return 'no query client';
  if (window.__pcUnsub) window.__pcUnsub();
  window.__pcLog = [];
  window.__pcUnsub = qc.getQueryCache().subscribe((ev) => {
    const key = ev.query && ev.query.queryKey;
    if (!Array.isArray(key) || key[0] !== 'git') return;
    const scope = key[1];
    if (!['log-infinite', 'branches', 'head-signature', 'log'].includes(scope)) return;
    window.__pcLog.push({ t: Date.now(), type: ev.type,
      action: ev.action && ev.action.type, scope,
      fetchStatus: ev.query.state.fetchStatus, updates: ev.query.state.dataUpdateCount });
  });
  return 'installed';
})()`;

const DRAIN = `(() => {
  const out = window.__pcLog || [];
  window.__pcLog = [];
  return { t: Date.now(), events: out };
})()`;

const fire = (type) => `(() => { window.dispatchEvent(new Event(${JSON.stringify(type)})); return Date.now(); })()`;

const BADGE = `(() => {
  const vis = (n) => n.offsetParent !== null;
  const row = [...document.querySelectorAll('[role="button"][aria-expanded][title]')].filter(vis)[0];
  return { t: Date.now(), badge: row ? (row.innerText || '').includes(${JSON.stringify(BRANCH)}) : null,
           text: row ? (row.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 110) : null };
})()`;

const result = { at: stamp() };
try {
  console.log('cache listener:', await cdp.evaluate(INSTALL));

  // 1 — wake the window: a real mouse move resets the idle timer.
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 500, y: 400, button: 'none', buttons: 0 });
  await sleep(500);
  await cdp.evaluate(DRAIN);
  await sleep(12_000);
  const awake = await cdp.evaluate(DRAIN);
  result.awake = awake;
  const ticks = (log) => log.events.filter((e) => e.scope === 'head-signature' && e.action === 'success').length;
  console.log(`awake 12s: fingerprint fetches = ${ticks(awake)} (expect ~2 at the 5s cadence)`);

  // 2 — blur: the poll must stop.
  result.blurAt = await cdp.evaluate(fire('blur'));
  await sleep(1000);
  await cdp.evaluate(DRAIN);
  await sleep(10_000);
  const blurred = await cdp.evaluate(DRAIN);
  result.blurred = blurred;
  console.log(`blurred 10s: fingerprint fetches = ${ticks(blurred)} (expect 0)`);

  // 3 — change the repository while the app is blind to it.
  console.log(`[${stamp()}] external (while blurred): create ${BRANCH}`);
  git('branch', BRANCH);
  await sleep(4000);
  const stillBlind = await cdp.evaluate(DRAIN);
  result.whileBlurred = { events: stillBlind.events, badge: await cdp.evaluate(BADGE) };
  console.log(`4s after the external branch, still blurred: events=${stillBlind.events.length}, badge=${result.whileBlurred.badge.badge}`);

  // 4 — focus, then timestamp everything.
  const focusAt = await cdp.evaluate(fire('focus'));
  result.focusAt = focusAt;
  const badgeSeries = [];
  for (let i = 0; i < 24; i += 1) {
    await sleep(250);
    const b = await cdp.evaluate(BADGE);
    badgeSeries.push({ dt: b.t - focusAt, badge: b.badge });
    if (b.badge) break;
  }
  const drained = await cdp.evaluate(DRAIN);
  result.afterFocus = {
    events: drained.events.map((e) => ({ dt: e.t - focusAt, ...e })),
    badgeSeries,
    badgeAtMs: badgeSeries.find((b) => b.badge)?.dt ?? null,
  };
  const firstBy = (scope) => result.afterFocus.events.find((e) => e.scope === scope && e.action === 'fetch');
  console.log(`focus → first fetch: history ${JSON.stringify(firstBy('log-infinite'))}, branches ${JSON.stringify(firstBy('branches'))}, fingerprint ${JSON.stringify(firstBy('head-signature'))}`);
  console.log(`focus → badge visible after ${result.afterFocus.badgeAtMs}ms`);
  console.log('shot:', await shot(cdp, '15-a-after-focus.png'));
} catch (error) {
  result.error = String(error && error.message);
  console.log('ERROR:', result.error);
} finally {
  await cdp.evaluate(`(() => { if (window.__pcUnsub) window.__pcUnsub(); window.__pcUnsub = null; return 'off'; })()`).catch(() => {});
  if (spawnSync('git', ['branch', '--list', BRANCH], { cwd: REPO, encoding: 'utf8' }).stdout.trim()) {
    git('branch', '-D', BRANCH);
  }
  result.branchListAtExit = spawnSync('git', ['branch'], { cwd: REPO, encoding: 'utf8' }).stdout.trim();
  console.log('branches at exit:', result.branchListAtExit.replace(/\n/g, ' / '));
  save('15-00-result.json', result);
  cdp.close();
}
