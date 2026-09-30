#!/usr/bin/env node
/**
 * p1-7e-e3.mjs — re-check items for P1-7e group e3 (floating windows,
 * terminal, tool rows, toasts; decision 142), plus the e1 sidebar order
 * after a host kill. Helpers from p1-7e-items.mjs (`e7`).
 *
 *   P17D_SCRATCH=/tmp/aiclient-p17e node p1-7e-e3.mjs <item> [args]
 *
 *   jobs                two tickers, both windows dragged from their docked place,
 *                       then SIGKILL of the host (exact pid): the lost rows stay, 移除 works;
 *                       the sidebar order before and after the kill (e1)
 *   drag                both windows, each dragged once from the docked place (8 steps)
 *   term                right-column terminal: Ctrl+F opens its search, no ^F / BEL in the pty, Esc
 *   reveal              terminal in front, README.md already the current tab: a tree click brings it back
 *   toast               lifetimes (5 s / 10 s), hover keeps, at most 3, above the composer
 *   goal                /goal P0-GOAL-PAUSE: pause, resume, the bar sampled for 「已挂起」
 *   contrast <suffix>…  tool-row icons and the failure-card title, light and dark
 */

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { lib } = await import(path.join(here, 'p1-7e-gui.mjs'));
const { e7 } = await import(path.join(here, 'p1-7e-items.mjs'));
const { attach, makeEval, sendText, sleep } = lib;
const {
  shot,
  save,
  newChat,
  setGear,
  pressKey,
  ctrlKey,
  waitFor,
  TRANSCRIPT,
  openChat,
  SIDEBAR,
  turnAllowing,
  CONTRAST,
  TOASTS_NOW,
  hostPids,
  killOneHost,
  bashCalls,
  centerOf,
  BUSY,
} = e7;

// ---- floating windows ------------------------------------------------------------------------

const clickBarToggle = (key) => `(() => {
  const b = document.querySelector('button[data-subwindow="${key}"]');
  if (!b) return false;
  b.click();
  return true;
})()`;
const SUBWINDOWS = `(() => {
  const rect = (n) => { if (!n) return null; const r = n.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  const win = (key) => {
    const n = document.querySelector('[data-testid="subwindow-' + key + '"]');
    if (!n) return null;
    return {
      rect: rect(n),
      dragged: n.getAttribute('data-dragged'),
      text: (n.innerText || '').replace(/\\n+/g, ' | ').slice(0, 1200),
      rows: [...n.querySelectorAll('[data-testid="job-row"], [data-testid="subagent-row"]')].map((r) => ({
        status: r.getAttribute('data-status'),
        text: (r.innerText || '').replace(/\\n+/g, ' | ').slice(0, 300),
        buttons: [...r.querySelectorAll('button')].map((b) => (b.innerText || '').trim()),
      })),
    };
  };
  return { layer: rect(document.querySelector('[data-testid="session-subwindows"]')), jobs: win('jobs'), agents: win('agents') };
})()`;
const TITLE_ROW_CENTER = (key) => `(() => {
  const n = document.querySelector('[data-testid="subwindow-${key}"] > div');
  if (!n) return null;
  const r = n.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2 - 40), y: Math.round(r.y + r.height / 2) };
})()`;

async function mouse(cdp, type, x, y, extra = {}) {
  await cdp.send('Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button: 'left',
    buttons: type === 'mouseReleased' ? 0 : 1,
    clickCount: 1,
    ...extra,
  });
}

async function doubleClick(cdp, at) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
  await mouse(cdp, 'mousePressed', at.x, at.y, { clickCount: 1 });
  await mouse(cdp, 'mouseReleased', at.x, at.y, { clickCount: 1 });
  await mouse(cdp, 'mousePressed', at.x, at.y, { clickCount: 2 });
  await mouse(cdp, 'mouseReleased', at.x, at.y, { clickCount: 2 });
}

/** One drag from wherever the window is, logging its box after every pointer step. */
async function stepwiseDrag(cdp, key, dx, dy, steps = 8) {
  const from = await cdp.evaluate(TITLE_ROW_CENTER(key));
  const start = (await cdp.evaluate(SUBWINDOWS))[key];
  const log = [];
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
  await mouse(cdp, 'mousePressed', from.x, from.y);
  for (let i = 1; i <= steps; i += 1) {
    await mouse(cdp, 'mouseMoved', from.x + (dx * i) / steps, from.y + (dy * i) / steps);
    await lib.pumpFrames(cdp, 60);
    const w = (await cdp.evaluate(SUBWINDOWS))[key];
    log.push({
      step: i,
      moved: { x: w.rect.x - start.rect.x, y: w.rect.y - start.rect.y },
      wanted: { x: Math.round((dx * i) / steps), y: Math.round((dy * i) / steps) },
      dragged: w.dragged,
    });
  }
  await mouse(cdp, 'mouseReleased', from.x + dx, from.y + dy);
  await lib.pumpFrames(cdp, 300);
  const end = (await cdp.evaluate(SUBWINDOWS))[key];
  const followed = log.every(
    (s) => Math.abs(s.moved.x - s.wanted.x) <= 3 && Math.abs(s.moved.y - s.wanted.y) <= 3
  );
  return { key, from, start: start.rect, steps: log, end: end.rect, followedEveryStep: followed };
}

async function dockBoth(cdp) {
  for (const key of ['jobs', 'agents']) {
    const open = await cdp.evaluate(
      `document.querySelector('[data-testid="subwindow-${key}"]') !== null`
    );
    if (!open) await cdp.evaluate(clickBarToggle(key));
    await lib.pumpFrames(cdp, 500);
    const w = (await cdp.evaluate(SUBWINDOWS))[key];
    if (w?.dragged) {
      await doubleClick(cdp, await cdp.evaluate(TITLE_ROW_CENTER(key)));
      await lib.pumpFrames(cdp, 500);
    }
  }
}

async function drag(tag = 'e3-drag') {
  const cdp = await attach(30_000);
  const out = {};
  await dockBoth(cdp);
  out.docked = await cdp.evaluate(SUBWINDOWS);
  out.shotDocked = await lib.shot(cdp, `${tag}-0-docked`);
  out.jobs = await stepwiseDrag(cdp, 'jobs', -380, 160);
  out.shotJobs = await lib.shot(cdp, `${tag}-1-jobs-dragged-once`);
  out.agents = await stepwiseDrag(cdp, 'agents', -300, 220);
  out.shotAgents = await lib.shot(cdp, `${tag}-2-agents-dragged-once`);
  // Back to the docked place.
  for (const key of ['jobs', 'agents']) {
    await doubleClick(cdp, await cdp.evaluate(TITLE_ROW_CENTER(key)));
    await lib.pumpFrames(cdp, 400);
  }
  out.restored = await cdp.evaluate(SUBWINDOWS);
  cdp.close();
  save(tag, out);
}

const clickRowButton = (rowSelector, index, text) => `(() => {
  const rows = [...document.querySelectorAll(${JSON.stringify(rowSelector)})];
  const row = rows[${index} < 0 ? rows.length + ${index} : ${index}];
  if (!row) return 'no row';
  const b = [...row.querySelectorAll('button')].find((n) => (n.innerText || '').trim() === ${JSON.stringify(text)});
  if (!b) return 'no button';
  b.click();
  return 'clicked';
})()`;

const sidebarOrder = async (cdp) =>
  (await cdp.evaluate(SIDEBAR)).rows
    .filter((r) => r.section.startsWith('folder:'))
    .map((r) => `${r.title.slice(0, 28)} | ${r.age} | ${r.marker ?? ''}`);

async function jobs() {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_RECORDERS);
  const evalAsync = makeEval(cdp);
  const sid = await newChat(cdp, evalAsync);
  await sleep(1500);
  const out = { sid, gear: await setGear(cdp, '全自动') };
  out.turns = [];
  for (const n of [1, 2]) {
    await sendText(cdp, `P1-JOBKILL: start ticker e3-${n} in the background.`);
    out.turns.push(await turnAllowing(cdp, evalAsync, sid));
    await sleep(600);
  }
  // Both windows, each dragged once from its docked place.
  await dockBoth(cdp);
  out.docked = await cdp.evaluate(SUBWINDOWS);
  out.shotDocked = await lib.shot(cdp, 'e3-drag-0-docked-two-running');
  out.dragJobs = await stepwiseDrag(cdp, 'jobs', -380, 160);
  out.dragAgents = await stepwiseDrag(cdp, 'agents', -300, 260);
  out.shotDragged = await lib.shot(cdp, 'e3-drag-1-both-dragged-once');
  for (const key of ['jobs', 'agents']) {
    await doubleClick(cdp, await cdp.evaluate(TITLE_ROW_CENTER(key)));
    await lib.pumpFrames(cdp, 400);
  }
  // Close the subagents window so the jobs window has the room.
  await cdp.evaluate(clickBarToggle('agents'));
  await lib.pumpFrames(cdp, 400);
  // e1: the sidebar order before the kill.
  out.orderBefore = await sidebarOrder(cdp);
  out.windowBeforeKill = await cdp.evaluate(SUBWINDOWS);
  out.shotBeforeKill = await lib.shot(cdp, 'e3-jobs-1-before-host-kill');
  out.hostsBefore = hostPids();
  const killAt = Date.now();
  out.killed = killOneHost();
  const trace = [];
  let last = '';
  const shots = {};
  while (Date.now() - killAt < 20_000) {
    const w = await cdp.evaluate(SUBWINDOWS);
    const row = {
      hosts: hostPids().length,
      rows: (w.jobs?.rows ?? []).map((r) => `${r.status} | ${r.text} | ${r.buttons.join(',')}`),
    };
    const key = JSON.stringify(row);
    if (key !== last) {
      trace.push({ dt: Date.now() - killAt, ...row });
      last = key;
    }
    if (!shots.lost && (w.jobs?.rows ?? []).some((r) => /引擎重启/.test(r.text)))
      shots.lost = await lib.shot(cdp, 'e3-jobs-2-lost-right-after-kill');
    await lib.pumpFrames(cdp, 250);
  }
  out.killTrace = trace;
  out.window10s = await cdp.evaluate(SUBWINDOWS);
  out.shotLater = await lib.shot(cdp, 'e3-jobs-3-lost-rows-kept-20s');
  // 移除 on the first lost row.
  out.remove = await cdp.evaluate(clickRowButton('[data-testid="job-row"]', 0, '移除'));
  await lib.pumpFrames(cdp, 800);
  out.windowAfterRemove = await cdp.evaluate(SUBWINDOWS);
  out.shotRemoved = await lib.shot(cdp, 'e3-jobs-4-after-remove');
  // e1: the order after the host came back.
  await sleep(3000);
  out.orderAfter = await sidebarOrder(cdp);
  out.sidebarAfter = await cdp.evaluate(SIDEBAR);
  out.shotSidebarAfter = await shot(cdp, 'e1-sidebar-after-host-kill', { bottom: false });
  out.orphanTickers = lib
    .procList()
    .filter((r) => /seq 1 600/.test(r.cmd) && r.cmd.length < 300)
    .map((r) => ({ pid: r.pid, ppid: r.ppid }));
  cdp.close();
  save('e3-jobs-and-e1-kill-order', out);
}

// ---- right-column terminal ---------------------------------------------------------------------

const TERMINAL_BUTTON = `(() => {
  const b = document.querySelector('button[data-session-terminal]');
  return b ? { state: b.getAttribute('data-session-terminal'), disabled: b.disabled } : null;
})()`;
const CLICK_TERMINAL_BUTTON = `(() => { const b = document.querySelector('button[data-session-terminal]'); if (!b || b.disabled) return false; b.click(); return true; })()`;
const TERM_COLUMN = `(() => {
  const col = document.querySelector('[data-testid="terminal-column"]');
  const vis = (n) => !!n && n.offsetParent !== null && n.getBoundingClientRect().width > 0;
  const active = document.activeElement;
  return {
    shown: vis(col),
    search: col ? [...col.querySelectorAll('input')].filter(vis).map((i) => ({ placeholder: i.getAttribute('placeholder'), focused: active === i })) : [],
    focusInTerminal: !!(col && active && col.contains(active)),
    activeElement: active ? active.tagName + '.' + String(active.className).slice(0, 40) : null,
  };
})()`;

async function termType(cdp, text, { enter = true } = {}) {
  const focused = await cdp.evaluate(`(() => {
    const layer = [...document.querySelectorAll('[data-column-terminal]')].find((n) => !n.classList.contains('invisible'));
    const ta = layer?.querySelector('.xterm-helper-textarea');
    if (!ta) return false;
    ta.focus();
    return document.activeElement === ta;
  })()`);
  if (!focused) return false;
  if (text) await cdp.send('Input.insertText', { text });
  if (enter) await pressKey(cdp, 'Enter', { text: '\r' });
  await lib.pumpFrames(cdp, 1500);
  return true;
}

async function term(tag = 'e3-terminal') {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_TERM_RECORDER);
  const out = { button: await cdp.evaluate(TERMINAL_BUTTON) };
  if (out.button?.state !== 'open') {
    await cdp.evaluate(CLICK_TERMINAL_BUTTON);
    await lib.pumpFrames(cdp, 3500);
  }
  out.typed = await termType(cdp, 'echo E3-TERM-READY');
  await termType(cdp, '', { enter: false });
  await cdp.evaluate(`(() => {
    window.__p17eKeys = [];
    window.addEventListener('keydown', (e) => window.__p17eKeys.push({ capture: e.key, ctrl: e.ctrlKey }), true);
    window.addEventListener('keydown', (e) => window.__p17eKeys.push({ bubble: e.key, ctrl: e.ctrlKey }), false);
    return true;
  })()`);
  const mark = await cdp.evaluate('String(window.__p17dTermText ?? "").length');
  await ctrlKey(cdp, 'f', 6);
  await lib.pumpFrames(cdp, 1200);
  out.ctrlF = {
    listeners: await cdp.evaluate('window.__p17eKeys'),
    ptyEcho: await cdp.evaluate(
      `JSON.stringify(String(window.__p17dTermText ?? '').slice(${mark}))`
    ),
    column: await cdp.evaluate(TERM_COLUMN),
  };
  out.ctrlF.bell = out.ctrlF.ptyEcho.includes('\\u0007');
  out.shotSearch = await lib.shot(cdp, `${tag}-ctrl-f-search-bar`);
  // Esc in the search box closes it; then Esc inside `cat -v` reaches the program.
  await pressKey(cdp, 'Escape');
  await lib.pumpFrames(cdp, 800);
  out.afterEscInSearch = await cdp.evaluate(TERM_COLUMN);
  await ctrlKey(cdp, 'u', 21);
  await termType(cdp, 'cat -v');
  const mark2 = await cdp.evaluate('String(window.__p17dTermText ?? "").length');
  await pressKey(cdp, 'Escape');
  await lib.pumpFrames(cdp, 600);
  await pressKey(cdp, 'Enter', { text: '\r' });
  await lib.pumpFrames(cdp, 1200);
  out.esc = {
    ptyEcho: await cdp.evaluate(
      `JSON.stringify(String(window.__p17dTermText ?? '').slice(${mark2}))`
    ),
    column: await cdp.evaluate(TERM_COLUMN),
    button: await cdp.evaluate(TERMINAL_BUTTON),
  };
  out.esc.reachedCat = /\^\[/.test(out.esc.ptyEcho);
  out.shotEsc = await lib.shot(cdp, `${tag}-esc-reaches-program`);
  await ctrlKey(cdp, 'c', 3);
  await lib.pumpFrames(cdp, 600);
  cdp.close();
  save(tag, out);
}

// ---- terminal in front, the current file clicked again in the tree -----------------------------

const OCCUPANT = `(() => {
  const shown = (n) => { if (!n) return false; for (let x = n; x; x = x.parentElement) { const cs = getComputedStyle(x); if (cs.visibility === 'hidden' || cs.display === 'none') return false; } const r = n.getBoundingClientRect(); return r.width > 0 && r.right <= innerWidth + 1; };
  const term = document.querySelector('[data-testid="terminal-column"]');
  const editorTabs = [...document.querySelectorAll('div.h-10.shrink-0.overflow-hidden.border-b')].find(shown);
  return {
    terminal: shown(term),
    editor: !!editorTabs,
    editorTabTexts: editorTabs ? [...editorTabs.querySelectorAll('div.group')].map((t) => (t.innerText || '').trim()) : [],
    terminalButton: document.querySelector('button[data-session-terminal]')?.getAttribute('data-session-terminal') ?? null,
  };
})()`;
const clickRail = (label) => `(() => {
  const b = [...document.querySelectorAll('button')].find((n) => n.offsetParent !== null && n.getBoundingClientRect().x < 44 && (n.getAttribute('aria-label') || n.getAttribute('title') || '').trim() === ${JSON.stringify(label)});
  if (!b) return false;
  b.click();
  return true;
})()`;
const CLICK_README_IN_TREE = `(() => {
  const n = [...document.querySelectorAll('[role="treeitem"], [data-path], div, span')].filter((x) => x.offsetParent !== null && x.getBoundingClientRect().x < 330 && (x.innerText || '').trim() === 'README.md').pop();
  if (!n) return false;
  n.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  n.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  return true;
})()`;

async function reveal(tag = 'e3-reveal') {
  const cdp = await attach(30_000);
  const out = { steps: [] };
  const step = async (name, extra = {}) => {
    await lib.pumpFrames(cdp, 1200);
    const o = await cdp.evaluate(OCCUPANT);
    out.steps.push({ name, ...extra, ...o, shot: await lib.shot(cdp, `${tag}-${name}`) });
  };
  // 1. README.md opened from the tree: the file is the current tab.
  out.fileRail = await cdp.evaluate(clickRail('文件'));
  await lib.pumpFrames(cdp, 1500);
  out.click1 = await cdp.evaluate(CLICK_README_IN_TREE);
  await step('1-readme-open');
  // 2. The terminal in front of it.
  if ((await cdp.evaluate(TERMINAL_BUTTON))?.state !== 'open') {
    await cdp.evaluate(CLICK_TERMINAL_BUTTON);
  } else {
    await cdp.evaluate(CLICK_TERMINAL_BUTTON);
    await lib.pumpFrames(cdp, 600);
    if (!(await cdp.evaluate(OCCUPANT)).terminal) await cdp.evaluate(CLICK_TERMINAL_BUTTON);
  }
  await lib.pumpFrames(cdp, 2500);
  await step('2-terminal-in-front');
  // 3. Click README.md in the tree again (it is already the current tab).
  out.click2 = await cdp.evaluate(CLICK_README_IN_TREE);
  await step('3-readme-clicked-again');
  // Back to the chat list; the shell stays (closing it is not part of this check).
  out.chatRail = await cdp.evaluate(clickRail('聊天'));
  await lib.pumpFrames(cdp, 800);
  cdp.close();
  save(tag, out);
}

// ---- toasts ------------------------------------------------------------------------------------

const ADD_TOAST = (title, type, description = '') => `
  const m = await import(/* @vite-ignore */ '/components/ui/toast.tsx');
  const id = m.toastManager.add({ title: ${JSON.stringify(title)}, description: ${JSON.stringify(description)}, type: ${JSON.stringify(type)} });
  return id;`;

async function toastLife(cdp, evalAsync, title, type, { hoverFor = 0 } = {}) {
  await evalAsync(
    ADD_TOAST(title, type, 'P1-7e 复核用的测试提示（经应用自己的 toastManager 加入）'),
    {
      label: 'add toast',
    }
  );
  const t0 = Date.now();
  let hoverDone = !hoverFor;
  let movedAway = null;
  const samples = [];
  while (Date.now() - t0 < 30_000) {
    await lib.pumpFrames(cdp, 200);
    const now = (await cdp.evaluate(TOASTS_NOW)).filter((x) => x.title === title);
    const visible = now.some((x) => x.visibility !== 'hidden');
    samples.push({ dt: Date.now() - t0, visible });
    if (!hoverDone && visible) {
      const r = now[0].rect;
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: r.x + Math.round(r.w / 2),
        y: r.y + Math.round(r.h / 2),
      });
      hoverDone = true;
      samples.push({ dt: Date.now() - t0, hovering: true });
    }
    if (hoverFor && !movedAway && Date.now() - t0 > hoverFor) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 700, y: 300 });
      movedAway = Date.now() - t0;
      samples.push({ dt: movedAway, movedAway: true });
    }
    if (!visible && Date.now() - t0 > 500) break;
  }
  const goneAt = samples.filter((s) => s.visible === false).at(0)?.dt ?? null;
  return {
    title,
    type,
    goneAt,
    movedAway,
    samples: samples.filter(
      (s, i) => i === 0 || s.hovering || s.movedAway || s.visible !== samples[i - 1].visible
    ),
  };
}

async function toast(tag = 'e3-toast') {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_RECORDERS);
  const evalAsync = makeEval(cdp);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 700, y: 300 });
  const out = {};
  out.success = await toastLife(cdp, evalAsync, 'E3 成功提示', 'success');
  out.error = await toastLife(cdp, evalAsync, 'E3 错误提示', 'error');
  out.hover = await toastLife(cdp, evalAsync, 'E3 悬停提示', 'success', { hoverFor: 9000 });
  // Five at once: three show, the rest hidden (and not clickable).
  for (let i = 1; i <= 5; i += 1) {
    await evalAsync(ADD_TOAST(`E3 叠放 ${i}`, 'info'), { label: 'add stacked' });
    await sleep(120);
  }
  await lib.pumpFrames(cdp, 700);
  out.stack = await cdp.evaluate(TOASTS_NOW);
  out.stackVisible = out.stack.filter((x) => x.visibility !== 'hidden').length;
  out.avoid = await cdp.evaluate(`(() => {
    const a = document.querySelector('[data-toast-avoid]');
    const r = a ? a.getBoundingClientRect() : null;
    return r ? { top: Math.round(r.top), bottom: Math.round(r.bottom) } : null;
  })()`);
  out.lowestToastBottom = Math.max(
    ...out.stack.filter((x) => x.visibility !== 'hidden').map((x) => x.rect.bottom)
  );
  out.gapAboveComposer = out.avoid ? out.avoid.top - out.lowestToastBottom : null;
  out.shotStack = await lib.shot(cdp, `${tag}-stack-of-five-three-shown`);
  await sleep(7000);
  await lib.pumpFrames(cdp, 600);
  out.afterStack = await cdp.evaluate(TOASTS_NOW);
  cdp.close();
  save(tag, out);
}

// ---- goal: no 「已挂起」 flash after resume ---------------------------------------------------------

const GOAL_BAR = `(() => {
  const g = document.querySelector('[data-testid="goal-bar"]');
  if (!g || g.offsetParent === null) return null;
  return { state: g.getAttribute('data-state'), text: (g.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 200) };
})()`;
const goalButton = (label) => `(() => {
  const goal = document.querySelector('[data-testid="goal-bar"]');
  if (!goal) return 'no goal bar';
  const b = [...goal.querySelectorAll('button')].find((n) => n.getAttribute('aria-label') === ${JSON.stringify(label)} || (n.innerText || '').trim() === ${JSON.stringify(label)});
  if (!b) return 'no button ' + ${JSON.stringify(label)};
  if (b.disabled) return 'disabled';
  b.click();
  return 'clicked';
})()`;

async function goalWatch(cdp, evalAsync, sid, until, timeoutMs, everyMs = 40) {
  const t0 = Date.now();
  const trace = [];
  let last = '';
  while (Date.now() - t0 < timeoutMs) {
    const g = await cdp.evaluate(GOAL_BAR);
    const st = await lib.turnStatus(evalAsync, sid);
    const key = JSON.stringify({ g, s: st.status });
    if (key !== last) {
      trace.push({
        dt: Date.now() - t0,
        status: st.status,
        goal: g ? `${g.state} | ${g.text}` : null,
      });
      last = key;
    }
    if (until?.(g, st)) break;
    await sleep(everyMs);
  }
  return trace;
}

async function goal() {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_RECORDERS);
  const evalAsync = makeEval(cdp);
  const sid = await newChat(cdp, evalAsync);
  await sleep(1500);
  const out = { sid, gear: await setGear(cdp, '全自动') };
  await sendText(cdp, '/goal P0-GOAL-PAUSE: run a slow check, then finish.');
  await sleep(700);
  const still = await cdp.evaluate(`document.querySelector('textarea')?.value ?? ''`);
  if (still.trim().startsWith('/goal')) await pressKey(cdp, 'Enter');
  out.untilRunning = await goalWatch(
    cdp,
    evalAsync,
    sid,
    (g) => g?.state === 'running',
    60_000,
    250
  );
  // Let round 1's slow command start.
  for (let i = 0; i < 40; i += 1) {
    const calls = await bashCalls(evalAsync, sid);
    if (calls.some((c) => /sleep/.test(c.cmd) && !c.settled)) break;
    await sleep(300);
  }
  out.pause = await cdp.evaluate(goalButton('暂停'));
  out.untilPaused = await goalWatch(
    cdp,
    evalAsync,
    sid,
    (g, st) => g?.state === 'paused' && !BUSY.includes(st.status),
    30_000,
    150
  );
  await sleep(1500);
  out.shotPaused = await lib.shot(cdp, 'e3-goal-1-paused');
  // An in-page sampler (every 16 ms, on change) so the first half second after the
  // click is covered too: a CDP round trip here takes up to ~0.5 s.
  await cdp.evaluate(`(() => {
    window.__p17eGoal = [];
    const t0 = Date.now();
    let last = '';
    clearInterval(window.__p17eGoalTimer);
    window.__p17eGoalTimer = setInterval(() => {
      const g = document.querySelector('[data-testid="goal-bar"]');
      const v = g ? (g.getAttribute('data-state') + ' | ' + (g.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 120)) : null;
      if (v !== last) { window.__p17eGoal.push({ dt: Date.now() - t0, v }); last = v; }
      if (Date.now() - t0 > 20000) clearInterval(window.__p17eGoalTimer);
    }, 16);
    return true;
  })()`);
  out.resume = await cdp.evaluate(goalButton('继续'));
  out.afterResume = await goalWatch(
    cdp,
    evalAsync,
    sid,
    (g, st) => g?.state === 'complete' && !BUSY.includes(st.status),
    60_000,
    30
  );
  await sleep(1500);
  out.inPage = await cdp.evaluate('window.__p17eGoal');
  out.suspendedSeen = [...out.afterResume, ...out.inPage].filter((x) =>
    /已挂起|suspended/.test(x.goal ?? x.v ?? '')
  );
  out.shotDone = await lib.shot(cdp, 'e3-goal-2-resumed-complete');
  out.transcript = (await cdp.evaluate(TRANSCRIPT)).slice(-1200);
  cdp.close();
  save('e3-goal-resume', out);
}

// ---- contrast, both themes ---------------------------------------------------------------------

async function contrast(...suffixes) {
  const cdp = await attach(30_000);
  const evalAsync = makeEval(cdp);
  const out = { chats: [] };
  for (const theme of ['light', 'dark']) {
    out[`theme-${theme}`] = await lib.setTheme(cdp, theme);
    await sleep(1000);
    for (const suffix of suffixes) {
      const entry = { theme, suffix, open: await openChat(cdp, evalAsync, suffix) };
      await cdp.evaluate(lib.EXPAND_WORK_GROUPS);
      await sleep(800);
      entry.contrast = await cdp.evaluate(CONTRAST);
      entry.shot = await shot(cdp, `e3-contrast-${theme}-${suffix}`);
      out.chats.push(entry);
    }
  }
  out.back = await lib.setTheme(cdp, 'light');
  // Summary: the lowest icon ratio per theme, and each card title.
  out.summary = out.chats.map((c) => ({
    theme: c.theme,
    suffix: c.suffix,
    minIcon: Math.min(...c.contrast.rows.map((r) => r.icon?.ratio ?? 99)),
    iconOpacities: [...new Set(c.contrast.rows.map((r) => r.icon?.opacity))],
    cardTitle: c.contrast.cardTitle
      ? { ratio: c.contrast.cardTitle.ratio, cls: c.contrast.cardTitle.cls }
      : null,
  }));
  cdp.close();
  save('e3-contrast', out);
}

/** Esc inside a program (`cat -v`) reaches it; typed with a real click into the terminal first. */
async function termEsc(tag = 'e3-terminal-esc') {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_TERM_RECORDER);
  const out = { column: await cdp.evaluate(TERM_COLUMN) };
  const at = await cdp.evaluate(
    centerOf(
      `[...document.querySelectorAll('[data-column-terminal]')].find((n) => !n.classList.contains('invisible'))?.querySelector('.xterm-screen')`
    )
  );
  out.at = at;
  if (at) await e7.realClick(cdp, at);
  await lib.pumpFrames(cdp, 600);
  out.focus = await cdp.evaluate(TERM_COLUMN);
  const mark0 = await cdp.evaluate('String(window.__p17dTermText ?? "").length');
  await cdp.send('Input.insertText', { text: 'cat -v' });
  await pressKey(cdp, 'Enter', { text: '\r' });
  await lib.pumpFrames(cdp, 1200);
  out.started = await cdp.evaluate(
    `JSON.stringify(String(window.__p17dTermText ?? '').slice(${mark0}))`
  );
  const mark = await cdp.evaluate('String(window.__p17dTermText ?? "").length');
  await pressKey(cdp, 'Escape');
  await lib.pumpFrames(cdp, 600);
  await pressKey(cdp, 'Enter', { text: '\r' });
  await lib.pumpFrames(cdp, 1200);
  out.ptyEcho = await cdp.evaluate(
    `JSON.stringify(String(window.__p17dTermText ?? '').slice(${mark}))`
  );
  out.reachedCat = /\^\[/.test(out.ptyEcho);
  out.after = await cdp.evaluate(TERM_COLUMN);
  out.shot = await lib.shot(cdp, `${tag}-reaches-cat`);
  await ctrlKey(cdp, 'c', 3);
  await lib.pumpFrames(cdp, 600);
  cdp.close();
  save(tag, out);
}

/** A fresh live failure card (P1-GATE) measured in both themes. */
async function cardContrast() {
  const cdp = await attach(30_000);
  const evalAsync = makeEval(cdp);
  const sid = await newChat(cdp, evalAsync);
  await sleep(1500);
  const out = { sid };
  await sendText(cdp, 'P1-GATE: a failure card for the contrast check.');
  out.card = await waitFor(
    cdp,
    `[...document.querySelectorAll('[role="alert"]')].some((n) => n.offsetParent !== null && /公司网关/.test(n.innerText || ''))`,
    60_000
  );
  await sleep(1500);
  for (const theme of ['light', 'dark']) {
    out[`theme-${theme}`] = await lib.setTheme(cdp, theme);
    await sleep(1000);
    const c = await cdp.evaluate(CONTRAST);
    out[theme] = { cardTitle: c.cardTitle, cardBody: c.cardBody, cardText: c.cardText };
    out[`shot-${theme}`] = await shot(cdp, `e3-contrast-card-title-${theme}`);
  }
  await lib.setTheme(cdp, 'light');
  await cdp.evaluate(lib.typeIntoComposer(''));
  cdp.close();
  save('e3-contrast-card', out);
}

const items = {
  jobs,
  drag,
  term,
  reveal,
  toast,
  goal,
  contrast,
  cardcontrast: cardContrast,
  termesc: termEsc,
};
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const name = process.argv[2];
  if (!items[name]) {
    console.error(`usage: p1-7e-e3.mjs ${Object.keys(items).join('|')}`);
    process.exit(2);
  }
  await items[name](...process.argv.slice(3));
  process.exit(0);
}
