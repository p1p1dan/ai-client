/**
 * R7 (T128 re-check of N6) — switching branch with uncommitted changes in the
 * way: the red chip must start with 「切换分支失败: error: Your local changes…」
 * (no `Error invoking remote method` prefix) and hovering it must show git's
 * whole multi-line message. The working file is restored afterwards.
 *
 * Branch-column helpers copied from s30-b.mjs (that script runs on import).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { connect, mouseClickAt, newSession, save, shot, sleep, stamp } from './ij-lib.mjs';

const REPO = '/tmp/ij/repo';
const git = (...a) => execFileSync('git', ['-C', REPO, ...a], { encoding: 'utf8' }).trim();
const { cdp, evalAsync } = await connect();
const out = { startedAt: stamp() };

const TRIGGER = `(() => {
  const vis = (n) => n.offsetParent !== null;
  const cands = [...document.querySelectorAll('button')].filter(vis).filter((b) => b.querySelector('svg') && /select-none/.test(b.className) && /bg-clip-padding/.test(b.className));
  const b = cands.filter((x) => x.querySelector('svg.lucide-git-branch, svg[class*="git-branch"]'))[0] ?? null;
  if (!b) return { found: false };
  const r = b.getBoundingClientRect();
  return { found: true, text: (b.innerText || '').trim(), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`;
const OPTIONS = `(() => [...document.querySelectorAll('[role="option"]')].filter((n) => n.offsetParent !== null).map((n) => {
  const r = n.getBoundingClientRect(); return { text: (n.innerText || '').trim(), x: Math.round(r.left + Math.min(60, r.width / 2)), y: Math.round(r.top + r.height / 2) }; }))()`;
const POPUP_OPEN = `document.querySelectorAll('[role="listbox"]').length > 0 && [...document.querySelectorAll('[role="option"]')].some((n) => n.offsetParent !== null)`;
const CHIP = `(() => {
  const chips = [...document.querySelectorAll('[role="alert"]')].filter((n) => n.offsetParent !== null && /切换分支失败|Failed to switch branch/.test(n.textContent || ''));
  return chips.map((n) => {
    const r = n.getBoundingClientRect();
    const inner = n.querySelector('.truncate') ?? n;
    return { text: (n.textContent || '').trim(), visibleWidth: Math.round(r.width), maxWidth: getComputedStyle(n).maxWidth,
      scrollWidth: inner.scrollWidth, clientWidth: inner.clientWidth, truncated: inner.scrollWidth > inner.clientWidth,
      x: Math.round(r.left + Math.min(r.width / 2, 80)), y: Math.round(r.top + r.height / 2) };
  });
})()`;
const TOOLTIP = `(() => [...document.querySelectorAll('[data-slot="tooltip-popup"]')].filter((n) => n.offsetParent !== null).map((n) => ({
  text: n.innerText, lines: (n.innerText || '').split('\\n').length, whiteSpace: getComputedStyle(n).whiteSpace, width: Math.round(n.getBoundingClientRect().width) })))()`;

async function openSelect() {
  for (let i = 0; i < 20 && (await cdp.evaluate(POPUP_OPEN)); i += 1) await sleep(150);
  await sleep(400);
  const t = await cdp.evaluate(TRIGGER);
  if (!t.found) return { t, opened: false };
  let opened = false;
  for (let attempt = 0; attempt < 2 && !opened; attempt += 1) {
    await mouseClickAt(cdp, t.x, t.y);
    for (let i = 0; i < 16 && !opened; i += 1) {
      await sleep(150);
      opened = await cdp.evaluate(POPUP_OPEN);
    }
  }
  return { t, opened, options: opened ? await cdp.evaluate(OPTIONS) : [] };
}

const orig = fs.readFileSync(`${REPO}/shared.txt`, 'utf8');
try {
  out.newSession = await newSession(cdp, evalAsync);
  out.headBefore = git('branch', '--show-current');
  fs.writeFileSync(`${REPO}/shared.txt`, `${orig}uncommitted local edit for R7\n`);
  out.status = git('status', '--short');
  const opened = await openSelect();
  out.options = opened.options?.map((o) => o.text);
  const dev = opened.options?.find((o) => o.text === 'dev');
  if (dev) await mouseClickAt(cdp, dev.x, dev.y);
  let chips = [];
  for (let i = 0; i < 30 && chips.length === 0; i += 1) {
    await sleep(200);
    chips = await cdp.evaluate(CHIP);
  }
  out.chip = chips;
  out.headAfter = git('branch', '--show-current');
  out.shotChip = await shot(cdp, 'r7-branch-error-chip.png');
  if (chips[0]) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: chips[0].x - 20,
      y: chips[0].y - 30,
    });
    await sleep(200);
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: chips[0].x,
      y: chips[0].y,
    });
    let tip = [];
    for (let i = 0; i < 20 && tip.length === 0; i += 1) {
      await sleep(200);
      tip = await cdp.evaluate(TOOLTIP);
    }
    out.tooltip = tip;
    out.shotTooltip = await shot(cdp, 'r7-branch-error-tooltip.png');
  }
  console.log(
    JSON.stringify(
      {
        status: out.status,
        options: out.options,
        headBefore: out.headBefore,
        headAfter: out.headAfter,
        chip: out.chip,
        tooltip: out.tooltip,
      },
      null,
      1
    )
  );
} catch (error) {
  out.error = String(error.stack ?? error);
  console.log('ERROR', out.error);
} finally {
  fs.writeFileSync(`${REPO}/shared.txt`, orig);
  out.statusRestored = git('status', '--short');
  save('r7-branch-error.json', out);
  cdp.close();
}
