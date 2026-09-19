/**
 * Addendum check 2, second pass — photograph the visible proof.
 *
 * The first pass measured the React Query cache. It also turned up something
 * better than a cache reading: the top history row renders ref badges, so an
 * externally created branch appears ON the commit row with nobody opening the
 * dropdown. This pass creates the branch, waits for the row to grow the badge,
 * photographs it, then deletes the branch and photographs the row losing it.
 */
import { spawnSync } from 'node:child_process';
import { connect, REPO, save, shot, sleep, stamp } from './lib.mjs';

const BRANCH = 't100-probe-branch';
const { cdp } = await connect();

const git = (...args) => {
  const r = spawnSync('git', args, { cwd: REPO, encoding: 'utf8' });
  console.log(`  $ git ${args.join(' ')} -> [${r.status}] ${`${r.stdout || ''}${r.stderr || ''}`.trim().slice(0, 160)}`);
  return r.status;
};

const HISTORY_ROWS = `(() => {
  const vis = (n) => n.offsetParent !== null;
  const rows = [...document.querySelectorAll('[role="button"][aria-expanded][title]')]
    .filter(vis)
    .map((n) => ({ text: (n.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 110),
                   title: (n.getAttribute('title') || '').replace(/\\s+/g, ' ').slice(0, 60) }));
  return { t: Date.now(), count: rows.length, rows: rows.slice(0, 3) };
})()`;

const hasBadge = (rows) => JSON.stringify(rows.rows || []).includes(BRANCH);

async function watch(label, want, budgetMs = 20_000) {
  const t0 = Date.now();
  let rows = await cdp.evaluate(HISTORY_ROWS);
  while (Date.now() - t0 < budgetMs && hasBadge(rows) !== want) {
    await sleep(500);
    rows = await cdp.evaluate(HISTORY_ROWS);
  }
  const ms = Date.now() - t0;
  const ok = hasBadge(rows) === want;
  console.log(`${label}: ${ok ? 'ok' : 'TIMED OUT'} after ${ms}ms — first row: ${JSON.stringify(rows.rows[0])}`);
  return { ok, ms, rows };
}

const result = { at: stamp() };
try {
  result.baseline = await cdp.evaluate(HISTORY_ROWS);
  console.log('baseline first row:', JSON.stringify(result.baseline.rows[0]));

  console.log(`[${stamp()}] external: create ${BRANCH}`);
  git('branch', BRANCH);
  result.appear = await watch('badge appears without any click', true);
  result.appearShot = await shot(cdp, '13-e-badge-after-create.png');
  console.log('shot:', result.appearShot);

  console.log(`[${stamp()}] external: delete ${BRANCH}`);
  git('branch', '-D', BRANCH);
  result.disappear = await watch('badge disappears without any click', false);
  result.disappearShot = await shot(cdp, '13-f-badge-after-delete.png');
  console.log('shot:', result.disappearShot);
} catch (error) {
  result.error = String(error && error.message);
  console.log('ERROR:', result.error);
} finally {
  if (spawnSync('git', ['branch', '--list', BRANCH], { cwd: REPO, encoding: 'utf8' }).stdout.trim()) {
    git('branch', '-D', BRANCH);
  }
  result.branchListAtExit = spawnSync('git', ['branch'], { cwd: REPO, encoding: 'utf8' }).stdout.trim();
  console.log('branches at exit:', result.branchListAtExit.replace(/\n/g, ' / '));
  save('13b-00-result.json', result);
  cdp.close();
}
