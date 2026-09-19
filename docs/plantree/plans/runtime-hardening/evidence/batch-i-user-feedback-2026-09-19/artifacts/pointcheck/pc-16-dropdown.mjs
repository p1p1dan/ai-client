/**
 * Addendum check 2, third pass — the branch dropdown itself.
 *
 * The cache reading and the commit-row badge are the real evidence (the
 * dropdown refetches when opened, so it would look right even with T100
 * reverted). This pass exists only to photograph the dropdown listing the
 * externally created branch, which is how a user would notice.
 */
import { spawnSync } from 'node:child_process';
import { connect, REPO, save, shot, sleep, stamp } from './lib.mjs';

const BRANCH = 't100-probe-branch';
const { cdp } = await connect();
const git = (...args) => {
  const r = spawnSync('git', args, { cwd: REPO, encoding: 'utf8' });
  console.log(`  $ git ${args.join(' ')} -> [${r.status}]`);
  return r.status;
};

const TRIGGER = `(() => {
  const vis = (n) => n.offsetParent !== null;
  const b = [...document.querySelectorAll('[data-slot="select-trigger"]')].filter(vis)[0];
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { text: (b.innerText || '').trim(), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`;
const POPUP = `(() => {
  const vis = (n) => n.offsetParent !== null;
  const p = [...document.querySelectorAll('[data-slot="select-popup"], [role="listbox"]')].filter(vis)[0];
  if (!p) return null;
  return [...p.querySelectorAll('[role="option"], [data-slot="select-item"]')]
    .map((n) => (n.textContent || '').trim()).filter(Boolean);
})()`;
const BADGE = `(() => {
  const vis = (n) => n.offsetParent !== null;
  const row = [...document.querySelectorAll('[role="button"][aria-expanded][title]')].filter(vis)[0];
  return row ? (row.innerText || '').includes(${JSON.stringify(BRANCH)}) : null;
})()`;

async function leftClick(x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  await sleep(150);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await sleep(90);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 1, clickCount: 1 });
}
async function openDropdown(tag) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const trig = await cdp.evaluate(TRIGGER);
    if (!trig) return { error: 'no trigger' };
    await leftClick(trig.x, trig.y);
    await sleep(1500);
    const items = await cdp.evaluate(POPUP);
    if (items) {
      const file = await shot(cdp, `16-${tag}.png`);
      return { trigger: trig.text, items, shot: file, attempt };
    }
    await sleep(700);
  }
  return { error: 'dropdown never opened' };
}
async function escape() {
  for (const type of ['keyDown', 'keyUp']) {
    await cdp.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  }
  await sleep(800);
}

const result = { at: stamp() };
try {
  console.log(`[${stamp()}] external: create ${BRANCH}`);
  git('branch', BRANCH);
  const t0 = Date.now();
  let badge = false;
  for (let i = 0; i < 40 && !badge; i += 1) { await sleep(500); badge = await cdp.evaluate(BADGE); }
  result.badgeAfterMs = badge ? Date.now() - t0 : null;
  console.log(`commit-row badge appeared after ${result.badgeAfterMs}ms (no click involved)`);

  result.dropdown = await openDropdown('a-dropdown-with-probe-branch');
  console.log('dropdown items:', JSON.stringify(result.dropdown.items));
  console.log('shot:', result.dropdown.shot);
  await escape();

  console.log(`[${stamp()}] external: delete ${BRANCH}`);
  git('branch', '-D', BRANCH);
  const t1 = Date.now();
  let still = true;
  for (let i = 0; i < 40 && still; i += 1) { await sleep(500); still = await cdp.evaluate(BADGE); }
  result.badgeGoneAfterMs = still ? null : Date.now() - t1;
  console.log(`badge gone after ${result.badgeGoneAfterMs}ms`);
  result.dropdownAfter = await openDropdown('b-dropdown-after-delete');
  console.log('dropdown items after delete:', JSON.stringify(result.dropdownAfter.items));
  await escape();
} catch (error) {
  result.error = String(error && error.message);
  console.log('ERROR:', result.error);
} finally {
  if (spawnSync('git', ['branch', '--list', BRANCH], { cwd: REPO, encoding: 'utf8' }).stdout.trim()) {
    git('branch', '-D', BRANCH);
  }
  result.branchListAtExit = spawnSync('git', ['branch'], { cwd: REPO, encoding: 'utf8' }).stdout.trim();
  console.log('branches at exit:', result.branchListAtExit.replace(/\n/g, ' / '));
  save('16-00-result.json', result);
  cdp.close();
}
