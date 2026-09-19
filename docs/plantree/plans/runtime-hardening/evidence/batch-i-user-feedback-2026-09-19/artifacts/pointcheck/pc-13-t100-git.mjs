/**
 * Addendum check 2 — T100: the Git panel's history and branch list must catch
 * up with a repository changed from OUTSIDE the app, with nobody pressing
 * refresh and nobody opening the branch dropdown.
 *
 * Safety rules for this repo (these are NOT negotiable, the working tree is
 * dirty with real work):
 *   - no commit, no checkout, no stash, no reset;
 *   - the only mutation is a throwaway branch REF (`git branch` /
 *     `git update-ref` / `git branch -D`), which touches neither the working
 *     tree nor HEAD.
 *
 * The visible dropdown is NOT the measurement: `BranchSwitcher`'s `onOpen`
 * refetches, so a dropdown opened by hand would show the new branch even with
 * T100 reverted. The measurement is the React Query cache — `dataUpdatedAt`
 * and the cached data — read WITHOUT touching the dropdown. The dropdown is
 * opened afterwards only to photograph the result.
 *
 * Getting at the cache: `renderer/index.tsx` creates the QueryClient as a
 * module-local const and never exports it, and `contextBridge` freezes
 * `electronAPI`, so the only handle is the React fiber tree —
 * `QueryClientProvider`'s fiber carries the client on `memoizedProps.client`.
 */
import { spawnSync } from 'node:child_process';
import { connect, REPO, save, shot, sleep, stamp } from './lib.mjs';

const BRANCH = 't100-probe-branch';
const { cdp } = await connect();

const git = (...args) => {
  const r = spawnSync('git', args, { cwd: REPO, encoding: 'utf8' });
  const out = `${(r.stdout || '').trim()}${(r.stderr || '').trim()}`;
  console.log(`  $ git ${args.join(' ')} -> [${r.status}] ${out.slice(0, 200)}`);
  return { status: r.status, out };
};

/** Stash the app's QueryClient on window via the fiber tree. */
const GRAB_CLIENT = `(() => {
  if (window.__pcQC) return 'already';
  const host = document.getElementById('root');
  if (!host) return 'no #root';
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

/** Every ['git', …] query in the cache, with the freshness stamps that matter. */
const GIT_QUERIES = `(() => {
  const qc = window.__pcQC;
  if (!qc) return { error: 'no query client' };
  const pick = (key, data) => {
    try {
      if (key[1] === 'branches' && Array.isArray(data)) return data.map((b) => b && b.name).filter(Boolean);
      if (key[1] === 'head-signature') return data;
      if (key[1] === 'log-infinite' && data && Array.isArray(data.pages)) {
        const first = data.pages[0];
        const list = Array.isArray(first) ? first : (first && (first.commits || first.items)) || [];
        return { pages: data.pages.length, total: data.pages.reduce((n, p) => n + ((Array.isArray(p) ? p : (p && (p.commits || p.items)) || []).length), 0),
                 first: list[0] ? { hash: String(list[0].hash).slice(0, 8), message: list[0].message } : null };
      }
      if (key[1] === 'log' && Array.isArray(data)) return { total: data.length, first: data[0] ? { hash: String(data[0].hash).slice(0, 8), message: data[0].message } : null };
    } catch (e) { return 'summarize failed: ' + e.message; }
    return undefined;
  };
  return {
    t: Date.now(),
    queries: qc.getQueryCache().getAll()
      .filter((q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'git')
      .map((q) => ({
        key: q.queryKey.map((k) => (typeof k === 'string' ? k : JSON.stringify(k))).join(' | '),
        scope: q.queryKey[1],
        status: q.state.status,
        fetchStatus: q.state.fetchStatus,
        dataUpdatedAt: q.state.dataUpdatedAt,
        dataUpdateCount: q.state.dataUpdateCount,
        observers: q.getObserversCount ? q.getObserversCount() : (q.observers || []).length,
        isActive: typeof q.isActive === 'function' ? q.isActive() : null,
        data: pick(q.queryKey, q.state.data),
      })),
  };
})()`;

/** What the panel is actually painting: the history rows, top-down. */
const HISTORY_ROWS = `(() => {
  const vis = (n) => n.offsetParent !== null;
  const rows = [...document.querySelectorAll('[role="button"][aria-expanded][title]')]
    .filter(vis)
    .map((n) => ({ text: (n.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 90),
                   title: (n.getAttribute('title') || '').replace(/\\s+/g, ' ').slice(0, 90) }));
  return { t: Date.now(), count: rows.length, first: rows[0] ?? null, rows: rows.slice(0, 5) };
})()`;

const BRANCH_TRIGGER = `(() => {
  const vis = (n) => n.offsetParent !== null;
  const b = [...document.querySelectorAll('button[data-slot="select-trigger"], [data-slot="select-trigger"]')].filter(vis)[0];
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { text: (b.innerText || '').trim().replace(/\\s+/g, ' '), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`;

const BRANCH_POPUP = `(() => {
  const vis = (n) => n.offsetParent !== null;
  const p = [...document.querySelectorAll('[data-slot="select-popup"], [role="listbox"]')].filter(vis)[0];
  if (!p) return null;
  return { items: [...p.querySelectorAll('[role="option"], [data-slot="select-item"]')]
    .map((n) => (n.textContent || '').trim()).filter(Boolean).slice(0, 40),
    text: (p.innerText || '').replace(/\\s+/g, ' ').slice(0, 400) };
})()`;

async function mouse(type, x, y, button, buttons) {
  await cdp.send('Input.dispatchMouseEvent', { type, x, y, button, buttons, clickCount: 1 });
}
async function leftClick(x, y) {
  await mouse('mouseMoved', x, y, 'none', 0);
  await sleep(120);
  await mouse('mousePressed', x, y, 'left', 1);
  await sleep(80);
  await mouse('mouseReleased', x, y, 'left', 1);
}
async function escape() {
  for (const type of ['keyDown', 'keyUp']) {
    await cdp.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  }
}

const byScope = (snap, scope) => (snap.queries || []).filter((q) => q.scope === scope);
const one = (snap, scope) => byScope(snap, scope)[0] ?? null;

/** Open the dropdown, read it, close it. Only ever used for photographs. */
async function readDropdown(tag) {
  const trig = await cdp.evaluate(BRANCH_TRIGGER);
  if (!trig) return { error: 'no branch trigger' };
  await leftClick(trig.x, trig.y);
  await sleep(1200);
  const popup = await cdp.evaluate(BRANCH_POPUP);
  const file = await shot(cdp, `13-${tag}.png`);
  await escape();
  await sleep(600);
  console.log(`dropdown ${tag}: ${JSON.stringify(popup && popup.items)}`);
  return { trigger: trig.text, popup, shot: file };
}

/** Poll the cache until `test` passes or the budget runs out. */
async function waitFor(label, test, budgetMs = 20_000, stepMs = 1000) {
  const t0 = Date.now();
  const samples = [];
  while (Date.now() - t0 < budgetMs) {
    const snap = await cdp.evaluate(GIT_QUERIES);
    samples.push({
      dt: Date.now() - t0,
      branches: one(snap, 'branches'),
      logInfinite: one(snap, 'log-infinite'),
      headSignature: one(snap, 'head-signature'),
    });
    if (test(snap)) {
      console.log(`  ${label}: satisfied after ${Date.now() - t0}ms`);
      return { ok: true, ms: Date.now() - t0, samples, snap };
    }
    await sleep(stepMs);
  }
  console.log(`  ${label}: NOT satisfied within ${budgetMs}ms`);
  return { ok: false, ms: budgetMs, samples, snap: await cdp.evaluate(GIT_QUERIES) };
}

const result = { at: stamp() };
try {
  // ---- open the Git panel --------------------------------------------------
  console.log('open Git panel:', await cdp.evaluate(`(() => {
    const b = document.querySelector('nav[aria-label="主导航"] button[aria-label="Git"]');
    if (!b) return 'no button';
    if (b.getAttribute('aria-pressed') === 'true') return 'already open';
    b.click();
    return 'clicked';
  })()`));
  await sleep(3500);

  // History section may start collapsed.
  console.log('history section:', await cdp.evaluate(`(() => {
    const vis = (n) => n.offsetParent !== null;
    const t = [...document.querySelectorAll('button')].filter(vis)
      .find((b) => /^(历史|History)/.test((b.innerText || '').trim()));
    if (!t) return 'no trigger';
    const state = t.getAttribute('data-panel-open') ?? t.getAttribute('aria-expanded') ?? t.getAttribute('data-state');
    if (state === 'false' || state === 'closed') { t.click(); return 'expanded (was ' + state + ')'; }
    return 'already ' + state;
  })()`));
  await sleep(2500);

  console.log('query client:', await cdp.evaluate(GRAB_CLIENT));
  const before = await cdp.evaluate(GIT_QUERIES);
  result.before = before;
  result.historyBefore = await cdp.evaluate(HISTORY_ROWS);
  console.log('git queries before:', JSON.stringify((before.queries || []).map((q) => `${q.scope}(obs=${q.observers},upd=${q.dataUpdateCount})`)));
  console.log('history first row:', JSON.stringify(result.historyBefore.first));
  console.log('branches cached:', JSON.stringify(one(before, 'branches') && one(before, 'branches').data));
  console.log('head signature:', JSON.stringify(one(before, 'head-signature') && one(before, 'head-signature').data));
  console.log('shot:', await shot(cdp, '13-a-git-panel.png'));

  result.dropdownBefore = await readDropdown('b-dropdown-before');

  // ---- is the 5s fingerprint poll actually running? ------------------------
  const sig0 = one(await cdp.evaluate(GIT_QUERIES), 'head-signature');
  await sleep(7000);
  const sig1 = one(await cdp.evaluate(GIT_QUERIES), 'head-signature');
  result.pollEvidence = { sig0, sig1, deltaUpdates: sig1.dataUpdateCount - sig0.dataUpdateCount,
                          deltaMs: sig1.dataUpdatedAt - sig0.dataUpdatedAt };
  console.log('head-signature poll over 7s:', JSON.stringify(result.pollEvidence));

  // ---- external branch creation -------------------------------------------
  const baseBranches = one(await cdp.evaluate(GIT_QUERIES), 'branches');
  const baseHistory = one(await cdp.evaluate(GIT_QUERIES), 'log-infinite');
  console.log(`[${stamp()}] external: create ${BRANCH}`);
  result.gitCreate = git('branch', BRANCH);
  const created = await waitFor(
    'branches cache contains the new branch',
    (snap) => (one(snap, 'branches')?.data || []).includes(BRANCH)
  );
  result.createWait = { ok: created.ok, ms: created.ms, samples: created.samples };
  result.branchesAfterCreate = one(created.snap, 'branches');
  result.historyRefetchOnCreate = {
    before: baseHistory && { dataUpdatedAt: baseHistory.dataUpdatedAt, dataUpdateCount: baseHistory.dataUpdateCount, first: baseHistory.data && baseHistory.data.first },
    after: one(created.snap, 'log-infinite') && { dataUpdatedAt: one(created.snap, 'log-infinite').dataUpdatedAt, dataUpdateCount: one(created.snap, 'log-infinite').dataUpdateCount, first: one(created.snap, 'log-infinite').data && one(created.snap, 'log-infinite').data.first },
  };
  console.log('branches before/after:', JSON.stringify(baseBranches && baseBranches.data), '->', JSON.stringify(result.branchesAfterCreate && result.branchesAfterCreate.data));
  console.log('history refetch on create:', JSON.stringify(result.historyRefetchOnCreate));
  result.dropdownAfterCreate = await readDropdown('c-dropdown-after-create');
  result.historyRowsAfterCreate = await cdp.evaluate(HISTORY_ROWS);

  // ---- move the ref: history must REFETCH but not CHANGE -------------------
  const preMove = one(await cdp.evaluate(GIT_QUERIES), 'log-infinite');
  const preMoveRows = await cdp.evaluate(HISTORY_ROWS);
  console.log(`[${stamp()}] external: move ${BRANCH} to HEAD~1`);
  result.gitMove = git('update-ref', `refs/heads/${BRANCH}`, 'HEAD~1');
  const moved = await waitFor(
    'history refetched after the ref moved',
    (snap) => (one(snap, 'log-infinite')?.dataUpdatedAt ?? 0) > (preMove?.dataUpdatedAt ?? 0)
  );
  const postMove = one(moved.snap, 'log-infinite');
  result.refMove = {
    ok: moved.ok, ms: moved.ms,
    historyBefore: preMove && { dataUpdatedAt: preMove.dataUpdatedAt, dataUpdateCount: preMove.dataUpdateCount, first: preMove.data && preMove.data.first, total: preMove.data && preMove.data.total },
    historyAfter: postMove && { dataUpdatedAt: postMove.dataUpdatedAt, dataUpdateCount: postMove.dataUpdateCount, first: postMove.data && postMove.data.first, total: postMove.data && postMove.data.total },
    rowsBefore: preMoveRows.first, rowsAfter: (await cdp.evaluate(HISTORY_ROWS)).first,
  };
  console.log('ref move:', JSON.stringify(result.refMove));

  // ---- external branch deletion -------------------------------------------
  console.log(`[${stamp()}] external: delete ${BRANCH}`);
  result.gitDelete = git('branch', '-D', BRANCH);
  const removed = await waitFor(
    'branches cache dropped the branch',
    (snap) => !(one(snap, 'branches')?.data || []).includes(BRANCH)
  );
  result.deleteWait = { ok: removed.ok, ms: removed.ms, samples: removed.samples };
  result.branchesAfterDelete = one(removed.snap, 'branches');
  console.log('branches after delete:', JSON.stringify(result.branchesAfterDelete && result.branchesAfterDelete.data));
  result.dropdownAfterDelete = await readDropdown('d-dropdown-after-delete');

  result.after = await cdp.evaluate(GIT_QUERIES);
  result.historyAfter = await cdp.evaluate(HISTORY_ROWS);
} catch (error) {
  result.error = String(error && error.message);
  console.log('ERROR:', result.error);
} finally {
  // The probe branch must never survive this script.
  const left = spawnSync('git', ['branch', '--list', BRANCH], { cwd: REPO, encoding: 'utf8' });
  if ((left.stdout || '').trim()) {
    console.log('cleanup: probe branch still present, deleting');
    git('branch', '-D', BRANCH);
  }
  result.branchListAtExit = spawnSync('git', ['branch'], { cwd: REPO, encoding: 'utf8' }).stdout.trim();
  console.log('branches at exit:', result.branchListAtExit.replace(/\n/g, ' / '));
  save('13-00-result.json', result);
  cdp.close();
}
