/** B1 / B2 / B3 / B5 — the composer branch column against /tmp/ij/repo. PARTS=b1,b5,b3,b2 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import {
  clickLabel,
  connect,
  gwMark,
  mouseClickAt,
  newSession,
  save,
  sendText,
  shot,
  sleep,
  stamp,
  waitGw,
  waitStatus,
} from './ij-lib.mjs';

const REPO = '/tmp/ij/repo';
const LONG =
  'feature/very-long-branch-name-for-width-check-ctrl-enter-interject-pointcheck-2026-09-24';
const git = (...a) => execFileSync('git', ['-C', REPO, ...a], { encoding: 'utf8' }).trim();
const parts = new Set((process.env.PARTS ?? 'b1,b5,b3,b2').split(','));
const { cdp, evalAsync } = await connect();
const out = { startedAt: stamp() };

const TRIGGER = `(() => {
  const ta = document.querySelector('textarea');
  const vis = (n) => n.offsetParent !== null;
  const cands = [...document.querySelectorAll('button')].filter(vis).filter((b) => b.querySelector('svg') && /select-none/.test(b.className) && /bg-clip-padding/.test(b.className));
  const withBranch = cands.filter((b) => b.querySelector('svg.lucide-git-branch, svg[class*="git-branch"]'));
  const b = withBranch[0] ?? null;
  if (!b) return { found: false, candidates: cands.map((c) => (c.innerText || '').trim()).slice(0, 10) };
  const r = b.getBoundingClientRect();
  const value = b.querySelector('[data-slot="select-value"], span.truncate') ?? b;
  const lockNode = [...document.querySelectorAll('[role="status"][aria-label]')].find((n) => /分支/.test(n.getAttribute('aria-label') || ''));
  const alert = [...document.querySelectorAll('[role="alert"]')].filter(vis).map((n) => (n.innerText || '').trim()).filter(Boolean);
  return { found: true, text: (b.innerText || '').trim(), disabled: b.disabled || b.getAttribute('aria-disabled') === 'true' || b.hasAttribute('data-disabled'),
    width: Math.round(r.width), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
    valueScrollWidth: value.scrollWidth, valueClientWidth: value.clientWidth, truncated: value.scrollWidth > value.clientWidth,
    maxWidthCss: getComputedStyle(b).maxWidth, lock: lockNode ? lockNode.getAttribute('aria-label') : null, alerts: alert };
})()`;
const OPTIONS = `(() => [...document.querySelectorAll('[role="option"]')].filter((n) => n.offsetParent !== null).map((n) => {
  const r = n.getBoundingClientRect(); return { text: (n.innerText || '').trim(), x: Math.round(r.left + Math.min(60, r.width / 2)), y: Math.round(r.top + r.height / 2) }; }))()`;
const POPUP_OPEN = `document.querySelectorAll('[role="listbox"]').length > 0 && [...document.querySelectorAll('[role="option"]')].some((n) => n.offsetParent !== null)`;

async function openSelect() {
  // Let any previous popup finish closing first; a click during its exit animation is swallowed.
  for (let i = 0; i < 20 && (await cdp.evaluate(POPUP_OPEN)); i += 1) await sleep(150);
  await sleep(400);
  const t = await cdp.evaluate(TRIGGER);
  if (!t.found) return { t, opened: false };
  let opened = false;
  let clicks = 0;
  for (let attempt = 0; attempt < 2 && !opened; attempt += 1) {
    await mouseClickAt(cdp, t.x, t.y);
    clicks += 1;
    for (let i = 0; i < 16 && !opened; i += 1) {
      await sleep(150);
      opened = await cdp.evaluate(POPUP_OPEN);
    }
  }
  return { t, opened, clicks, options: opened ? await cdp.evaluate(OPTIONS) : [] };
}
async function pick(branch) {
  const opened = await openSelect();
  if (!opened.opened) return { opened };
  const opt = opened.options.find((o) => o.text === branch);
  if (!opt) return { opened, missing: branch };
  const t0 = Date.now();
  await mouseClickAt(cdp, opt.x, opt.y);
  const trail = [];
  let changedAt = null;
  while (Date.now() - t0 < 6000) {
    const t = await cdp.evaluate(TRIGGER);
    const head = git('branch', '--show-current');
    trail.push({ ms: Date.now() - t0, label: t.text, head });
    if (t.text === branch && changedAt === null) changedAt = Date.now() - t0;
    if (changedAt !== null && head === branch && Date.now() - t0 > changedAt + 600) break;
    await sleep(100);
  }
  return {
    options: opened.options.map((o) => o.text),
    labelChangedAfterMs: changedAt,
    finalHead: git('branch', '--show-current'),
    trail: trail.filter(
      (x, i, a) => i === 0 || x.label !== a[i - 1].label || x.head !== a[i - 1].head
    ),
    after: await cdp.evaluate(TRIGGER),
  };
}
try {
  out.newSession = await newSession(cdp, evalAsync);
  out.headAtStart = git('branch', '--show-current');
  out.initial = await cdp.evaluate(TRIGGER);
  out.shotInitial = await shot(cdp, '30-b-initial.png');
  if (parts.has('b1')) {
    const opened = await openSelect();
    out.b1List = opened.options?.map((o) => o.text);
    out.b1ShotList = await shot(cdp, '30-b1-branch-list.png');
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
    });
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
    });
    await sleep(500);
    out.b1ToDev = await pick('dev');
    out.b1ShotDev = await shot(cdp, '30-b1-switched-to-dev.png');
    out.b1BackToMain = await pick('main');
    console.log(
      'B1',
      JSON.stringify({
        list: out.b1List,
        toDev: {
          ms: out.b1ToDev.labelChangedAfterMs,
          head: out.b1ToDev.finalHead,
          trail: out.b1ToDev.trail,
        },
        back: { ms: out.b1BackToMain.labelChangedAfterMs, head: out.b1BackToMain.finalHead },
      })
    );
  }
  if (parts.has('b5')) {
    out.b5ToLong = await pick(LONG);
    await sleep(500);
    out.b5Trigger = await cdp.evaluate(TRIGGER);
    out.b5Shot = await shot(cdp, '30-b5-long-branch.png');
    out.b5BackToMain = await pick('main');
    console.log(
      'B5',
      JSON.stringify({
        ms: out.b5ToLong.labelChangedAfterMs,
        head: out.b5ToLong.finalHead,
        trigger: out.b5Trigger,
        back: out.b5BackToMain.finalHead,
      })
    );
  }
  if (parts.has('b3')) {
    const orig = fs.readFileSync(`${REPO}/shared.txt`, 'utf8');
    fs.writeFileSync(`${REPO}/shared.txt`, `${orig}uncommitted local edit for B3\n`);
    out.b3Status = git('status', '--short');
    out.b3Attempt = await pick('dev');
    await sleep(1500);
    out.b3After = await cdp.evaluate(TRIGGER);
    out.b3Shot = await shot(cdp, '30-b3-checkout-refused.png');
    out.b3HeadAfter = git('branch', '--show-current');
    fs.writeFileSync(`${REPO}/shared.txt`, orig);
    out.b3StatusRestored = git('status', '--short');
    console.log(
      'B3',
      JSON.stringify({
        status: out.b3Status,
        head: out.b3HeadAfter,
        label: out.b3After.text,
        alerts: out.b3After.alerts,
        restored: out.b3StatusRestored,
      })
    );
  }
  if (parts.has('b2')) {
    const mark = gwMark();
    const s = await sendText(cdp, evalAsync, '⟦long⟧ B2 回合运行中分支栏应锁定');
    await waitGw((l) => l.event === 'response_complete' && /long step1/.test(l.label), mark, 60000);
    await sleep(1500);
    out.b2Trigger = await cdp.evaluate(TRIGGER);
    out.b2Try = await openSelect();
    out.b2Shot = await shot(cdp, '30-b2-locked-while-running.png');
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
    });
    out.b2Stop = await cdp.evaluate(clickLabel('停止当前回合'));
    out.b2Idle = await waitStatus(evalAsync, s.sid, (st) => st.status === 'idle', 30000);
    await sleep(1200);
    out.b2AfterStop = await cdp.evaluate(TRIGGER);
    console.log(
      'B2',
      JSON.stringify({
        trigger: out.b2Trigger,
        opened: out.b2Try.opened,
        afterStop: { disabled: out.b2AfterStop.disabled, lock: out.b2AfterStop.lock },
      })
    );
  }
  out.headAtEnd = git('branch', '--show-current');
} catch (error) {
  out.error = String(error.stack ?? error);
  console.log('ERROR', out.error);
} finally {
  save(`30-b${process.env.PARTS ? `-${process.env.PARTS.replace(/,/g, '-')}` : ''}.json`, out);
  cdp.close();
}
