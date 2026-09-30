#!/usr/bin/env node
/**
 * p1-7d-items-cde.mjs — batch 2 of the P1-7d GUI point-check: checklist
 * sections C (background jobs / subagents windows, live output), D (tool rows,
 * failure cards, both themes) and E (the right-column terminal).
 *
 * Same scratch, CDP port and privacy-checked shots as p1-7d-gui.mjs (whose
 * `lib` this uses); batch 1's p1-7d-items.mjs is untouched.
 *
 *   P17D_SCRATCH=/tmp/aiclient-p17d2 node p1-7d-items-cde.mjs <item> [args]
 *
 *   c12 | c1drag | c3 | c4 | c5 | c6            section C (c5 also shoots D2's Stop row)
 *   d1 | d2 | d3 | d4 [key|server|network|all] | d5 <suffix>=<shot>[@<row text>] …
 *   rowshot <suffix> <row text> <shot> [<result>]   open one row of one chat and shoot it
 *   e1 | e2 | e3 <suffix> | e4 <suffix> | e5 <suffix> | e6 <suffixA> <suffixB> | e6keys <suffix>
 *   worktimes <other suffix> | reclaim <suffix>  the work-line finding (results X1-*)
 *
 * Chats are named by the last characters of their id (`<suffix>`), as in batch 1.
 * Every item prints a JSON result and writes it to ../results/<ID>.json.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { lib } = await import(path.join(here, 'p1-7d-gui.mjs'));
const { attach, makeEval, sendText, waitTurn, STORE, sleep, scrub } = lib;

// ---- shared helpers (the batch-1 ones this file needs, copied) -------------------

async function shot(cdp, name, { bottom = true } = {}) {
  if (bottom) {
    await cdp.evaluate(lib.SCROLL_BOTTOM);
    await sleep(400);
  }
  return lib.shot(cdp, name);
}

const resultsDir = path.join(lib.outDir, 'results');
function save(name, value) {
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(
    path.join(resultsDir, `${name}.json`),
    `${JSON.stringify(scrub(value), null, 2)}\n`
  );
  console.log(JSON.stringify(scrub(value), null, 2));
}

const activeSid = (evalAsync) =>
  evalAsync(`${STORE} return s.activeSessionId;`, { label: 'active sid' });

const NEW_CHAT = `(() => {
  const b = [...document.querySelectorAll('button')].filter((n) => (n.innerText || n.getAttribute('aria-label') || '').trim() === '新建对话' && n.offsetParent !== null);
  if (!b.length) return false;
  b[b.length - 1].click();
  return true;
})()`;

async function newChat(cdp, evalAsync) {
  const before = await activeSid(evalAsync);
  await cdp.evaluate(NEW_CHAT);
  for (let i = 0; i < 30; i += 1) {
    await sleep(300);
    const now = await activeSid(evalAsync);
    if (now && now !== before) return now;
  }
  // 「新建对话」 reuses the active chat when it is still empty (create-or-reuse).
  const empty = await evalAsync(
    `${STORE} return (s.messages[s.activeSessionId] ?? []).length === 0;`,
    { label: 'active empty' }
  );
  if (empty) return before;
  throw new Error('new chat did not become active');
}

/** Permission gear through the composer's own menu (full auto confirms inside the menu). */
async function setGear(cdp, label) {
  const GEAR = `[...document.querySelectorAll('button')].find((n) => /^(执行|规划) · /.test((n.innerText || '').trim()) && n.offsetParent !== null)`;
  const current = await cdp.evaluate(
    `(() => { const b = ${GEAR}; return b ? b.innerText.trim() : null; })()`
  );
  if (current?.endsWith(label)) return current;
  await cdp.evaluate(`(() => { ${GEAR}.click(); return true; })()`);
  await sleep(700);
  await cdp.evaluate(`(() => {
    const m = [...document.querySelectorAll('[role="menuitemradio"]')].find((n) => n.offsetParent !== null && (n.innerText || '').startsWith(${JSON.stringify(label)}));
    if (!m) return false;
    m.click();
    return true;
  })()`);
  await sleep(700);
  await cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((n) => (n.innerText || '').trim() === '应用' && n.offsetParent !== null);
    if (b) b.click();
    return !!b;
  })()`);
  await sleep(900);
  await cdp.evaluate(
    `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`
  );
  return cdp.evaluate(`(() => { const b = ${GEAR}; return b ? b.innerText.trim() : null; })()`);
}

const KEY_CODES = { Enter: 13, Escape: 27, Tab: 9, ArrowDown: 40, ArrowUp: 38, f: 70, q: 81 };
async function pressKey(cdp, key, { ctrl = false, shift = false, text } = {}) {
  const base = {
    key,
    code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
    windowsVirtualKeyCode: KEY_CODES[key] ?? 0,
    nativeVirtualKeyCode: KEY_CODES[key] ?? 0,
    modifiers: (ctrl ? 2 : 0) | (shift ? 8 : 0),
  };
  await cdp.send('Input.dispatchKeyEvent', {
    type: text ? 'keyDown' : 'rawKeyDown',
    ...base,
    ...(text ? { text, unmodifiedText: text } : {}),
  });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

async function waitFor(cdp, expr, timeoutMs = 60_000, everyMs = 150) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await cdp.evaluate(expr);
    if (v) return v;
    await sleep(everyMs);
  }
  return null;
}

const clickButtonText = (text) => `(() => {
  const b = [...document.querySelectorAll('button')].find((n) => n.offsetParent !== null && !n.disabled &&
    ((n.innerText || '').trim() === ${JSON.stringify(text)} || (n.innerText || '').trim().startsWith(${JSON.stringify(`${text}\n`)})));
  if (!b) return false;
  b.click();
  return true;
})()`;

const CLICK_STOP = `(() => {
  const b = [...document.querySelectorAll('button[aria-label]')].find((n) => n.getAttribute('aria-label') === '停止当前回合' && n.offsetParent !== null);
  if (!b) return false;
  b.click();
  return true;
})()`;

const TRANSCRIPT = `(() => {
  const viewports = [...document.querySelectorAll('[data-slot="scroll-area-viewport"]')].filter((v) => v.offsetParent !== null && !/仓库列表/.test(v.innerText || ''));
  let best = null;
  for (const v of viewports) if (!best || (v.innerText || '').length > (best.innerText || '').length) best = v;
  return (best ?? document.body).innerText.replace(/\\n{2,}/g, '\\n').slice(-4000);
})()`;

const bashCalls = (evalAsync, sid) =>
  evalAsync(
    `${STORE}
     const msgs = s.messages[${JSON.stringify(sid)}] ?? [];
     const blocks = msgs.flatMap((m) => m.blocks ?? []);
     return blocks.filter((b) => b.type === 'tool_call').map((c) => ({ id: c.toolCallId, name: c.toolName, cmd: String(c.toolInput?.command ?? '').slice(0, 60),
       settled: blocks.some((r) => r.type === 'tool_result' && r.toolCallId === c.toolCallId) }));`,
    { label: 'bash calls' }
  );

const hostPids = () =>
  lib
    .procList()
    .filter(lib.isOurHost)
    .map((r) => r.pid);

function killOneHost() {
  const pids = hostPids();
  if (pids.length !== 1)
    throw new Error(`expected exactly one host, found ${JSON.stringify(pids)}`);
  const pid = pids[0];
  if (!(pid > 1)) throw new Error('refusing pid <= 1');
  process.kill(pid, 'SIGKILL');
  return pid;
}

async function openBySuffix(_cdp, evalAsync, suffix) {
  const out = await evalAsync(
    `${STORE}
     const target = s.sessions.find((x) => x.id.endsWith(${JSON.stringify(suffix)}));
     if (!target) return { error: 'no session' };
     if (s.activeSessionId === target.id) return { id: target.id, active: target.id, already: true };
     const rows = [...document.querySelectorAll('[role="button"][title]')].filter((n) => n.offsetParent !== null && n.getAttribute('title') === target.title);
     if (!rows.length) return { error: 'no row', title: target.title };
     // Several chats can share a title (「New chat」): try each row until ours is active.
     let tried = 0;
     for (const row of rows) {
       tried += 1;
       row.click();
       for (let i = 0; i < 8; i += 1) {
         await new Promise((r) => setTimeout(r, 250));
         if (chat.useChatSessionsStore.getState().activeSessionId === target.id) break;
       }
       if (chat.useChatSessionsStore.getState().activeSessionId === target.id) break;
     }
     return { id: target.id, active: chat.useChatSessionsStore.getState().activeSessionId, tried };`,
    { label: 'open by suffix' }
  );
  await sleep(1500);
  return out;
}

/** The session bar's right-hand group: terminal, jobs and subagents toggles. */
const SESSION_BAR = `(() => {
  const bar = [...document.querySelectorAll('div')].find((d) => /@container/.test(d.className) && /\\bh-9\\b/.test(d.className) && d.offsetParent !== null);
  const rect = (n) => { if (!n) return null; const r = n.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  const describe = (b) => {
    const label = [...b.querySelectorAll('span')].find((s) => /hidden/.test(s.className) || s.className.includes('max-xl'));
    const badge = b.querySelector('[data-slot="badge"]') ?? [...b.querySelectorAll('span')].find((s) => /rounded-full/.test(s.className) && /\\d/.test(s.innerText || ''));
    const cs = badge ? getComputedStyle(badge) : null;
    return {
      key: b.getAttribute('data-subwindow') ?? b.getAttribute('data-session-terminal') ?? null,
      text: (b.innerText || '').trim().replace(/\\s+/g, ' '),
      title: b.getAttribute('title'),
      pressed: b.getAttribute('aria-pressed'),
      disabled: b.disabled,
      labelVisible: label ? getComputedStyle(label).display !== 'none' : null,
      badge: badge ? { text: badge.innerText.trim(), bg: cs.backgroundColor, color: cs.color, rect: rect(badge) } : null,
      dot: !!b.querySelector('span.rounded-full.bg-status-running'),
      rect: rect(b),
    };
  };
  const buttons = bar ? [...bar.querySelectorAll('button')].filter((b) => b.offsetParent !== null) : [];
  return {
    bar: rect(bar),
    buttons: buttons.map(describe),
  };
})()`;

const clickBarToggle = (key) => `(() => {
  const b = document.querySelector('button[data-subwindow="${key}"]');
  if (!b) return false;
  b.click();
  return true;
})()`;

/** Where the floating windows sit, and what they must not cover. */
const SUBWINDOWS = `(() => {
  const rect = (n) => { if (!n) return null; const r = n.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom) }; };
  const layer = document.querySelector('[data-testid="session-subwindows"]');
  const win = (key) => {
    const n = document.querySelector('[data-testid="subwindow-' + key + '"]');
    if (!n) return null;
    return {
      rect: rect(n),
      dragged: n.getAttribute('data-dragged'),
      text: (n.innerText || '').replace(/\\n+/g, ' | ').slice(0, 1500),
      rows: [...n.querySelectorAll('[data-testid="job-row"], [data-testid="subagent-row"]')].map((r) => ({
        status: r.getAttribute('data-status'),
        text: (r.innerText || '').replace(/\\n+/g, ' | ').slice(0, 300),
        buttons: [...r.querySelectorAll('button')].map((b) => (b.innerText || '').trim()),
      })),
      output: [...n.querySelectorAll('[data-testid="job-output"]')].map((o) => ({ head: (o.querySelector('p')?.innerText || ''), len: (o.querySelector('pre')?.innerText || '').length, tail: (o.querySelector('pre')?.innerText || '').slice(-120) })),
      header: [...n.querySelectorAll('button[aria-label]')].map((b) => b.getAttribute('aria-label')),
    };
  };
  return {
    layer: rect(layer),
    jobs: win('jobs'),
    agents: win('agents'),
    goalBar: rect(document.querySelector('[data-testid="goal-bar"]')),
    todoCard: rect(document.querySelector('[data-testid="todo-card"]')),
    composer: rect(document.querySelector('textarea')?.closest('form') ?? document.querySelector('textarea')),
  };
})()`;

/** A window's title row (the drag handle): its centre in page coordinates. */
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

async function drag(cdp, from, dx, dy) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
  await mouse(cdp, 'mousePressed', from.x, from.y);
  const steps = 8;
  for (let i = 1; i <= steps; i += 1) {
    await mouse(cdp, 'mouseMoved', from.x + (dx * i) / steps, from.y + (dy * i) / steps);
    await sleep(40);
  }
  await mouse(cdp, 'mouseReleased', from.x + dx, from.y + dy);
}

async function doubleClick(cdp, at) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
  await mouse(cdp, 'mousePressed', at.x, at.y, { clickCount: 1 });
  await mouse(cdp, 'mouseReleased', at.x, at.y, { clickCount: 1 });
  await mouse(cdp, 'mousePressed', at.x, at.y, { clickCount: 2 });
  await mouse(cdp, 'mouseReleased', at.x, at.y, { clickCount: 2 });
}

/** Click a button inside a job / subagent row, by its visible text. */
const clickRowButton = (rowSelector, index, text) => `(() => {
  const rows = [...document.querySelectorAll(${JSON.stringify(rowSelector)})];
  const row = rows[${index} < 0 ? rows.length + ${index} : ${index}];
  if (!row) return 'no row';
  const b = [...row.querySelectorAll('button')].find((n) => (n.innerText || '').trim() === ${JSON.stringify(text)});
  if (!b) return 'no button';
  b.click();
  return 'clicked';
})()`;

const AUTO_HEADS = `[...document.querySelectorAll('[data-testid="auto-turn-head"]')].filter((n) => n.offsetParent !== null).map((n) => ({ text: (n.innerText || '').replace(/\\s+/g, ' ').trim(), title: n.getAttribute('title') ?? n.querySelector('[title]')?.getAttribute('title') ?? null }))`;

/**
 * Wait for the turn like `waitTurn`, answering 「直接允许」 on every approval
 * card on the way: the ticker's `$(seq …)` / `$i` make DSH's gate ask even in
 * 全自动 (decision 129, the reason line says so), which is by design.
 */
const CARD_ALLOW = `(() => {
  const b = [...document.querySelectorAll('button')].find((n) => n.offsetParent !== null && (n.innerText || '').trim() === '直接允许');
  if (!b) return null;
  let card = b;
  for (let i = 0; i < 6 && card.parentElement; i += 1) card = card.parentElement;
  const text = (card.innerText || '').replace(/\\n+/g, ' | ').slice(0, 400);
  b.click();
  return text;
})()`;

async function turnAllowing(
  cdp,
  evalAsync,
  sid,
  { timeoutMs = 120_000, neverBusyMs = 25_000 } = {}
) {
  const started = Date.now();
  const cards = [];
  let seenBusy = false;
  let idle = 0;
  const statuses = [];
  while (Date.now() - started < timeoutMs) {
    const st = await lib.turnStatus(evalAsync, sid);
    if (statuses.at(-1)?.status !== st.status)
      statuses.push({ dt: Date.now() - started, status: st.status });
    if (st.status === 'waiting_permission') {
      const card = await cdp.evaluate(CARD_ALLOW);
      if (card) cards.push({ dt: Date.now() - started, card });
    }
    if (
      ['starting', 'running', 'stopping', 'waiting_permission', 'waiting_question'].includes(
        st.status
      )
    ) {
      seenBusy = true;
      idle = 0;
    } else if (seenBusy) {
      idle += 1;
      if (idle >= 3) return { settled: true, status: st.status, statuses, cards };
    } else if (Date.now() - started > neverBusyMs) {
      return { settled: false, neverBusy: true, status: st.status, statuses, cards };
    }
    await sleep(400);
  }
  return { settled: false, statuses, cards };
}

// ---- C1 + C2: the jobs window, its output, stop ------------------------------------

async function c12() {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_RECORDERS);
  const evalAsync = makeEval(cdp);
  const sid = await newChat(cdp, evalAsync);
  await sleep(1500);
  const out = { sid, gear: await setGear(cdp, '全自动') };
  // Both windows closed first (their open state outlives a chat switch).
  for (const key of ['jobs', 'agents']) {
    const open = await cdp.evaluate(
      `document.querySelector('[data-testid="subwindow-${key}"]') !== null`
    );
    if (open) await cdp.evaluate(clickBarToggle(key));
  }
  await sleep(500);
  out.barBefore = await cdp.evaluate(SESSION_BAR);
  await sendText(cdp, 'P1-JOBKILL: start a ticker in the background.');
  out.turn = await turnAllowing(cdp, evalAsync, sid);
  await sleep(1000);
  out.barRunning = await cdp.evaluate(SESSION_BAR);
  out.shotBadge = await shot(cdp, 'C1-bar-badge');
  // Open the window.
  out.opened = await cdp.evaluate(clickBarToggle('jobs'));
  await sleep(1200);
  out.windowAtRest = await cdp.evaluate(SUBWINDOWS);
  out.barWithWindow = await cdp.evaluate(SESSION_BAR);
  out.shotWindow = await shot(cdp, 'C1-jobs-window', { bottom: false });
  // Drag it by the title row, then double-click to put it back.
  const from = await cdp.evaluate(TITLE_ROW_CENTER('jobs'));
  out.dragFrom = from;
  if (from) {
    await drag(cdp, from, -380, 160);
    await sleep(600);
    out.windowDragged = await cdp.evaluate(SUBWINDOWS);
    out.shotDragged = await shot(cdp, 'C1-jobs-window-dragged', { bottom: false });
    const at = await cdp.evaluate(TITLE_ROW_CENTER('jobs'));
    await doubleClick(cdp, at);
    await sleep(600);
    out.windowRestored = await cdp.evaluate(SUBWINDOWS);
    out.shotRestored = await shot(cdp, 'C1-jobs-window-restored', { bottom: false });
  }
  // C2: open the ticker's output and watch it grow.
  out.expand = await cdp.evaluate(clickRowButton('[data-testid="job-row"]', 0, '输出'));
  const growth = [];
  for (let i = 0; i < 8; i += 1) {
    await sleep(700);
    const w = await cdp.evaluate(SUBWINDOWS);
    growth.push({ t: Date.now(), output: w.jobs?.output ?? null });
  }
  out.outputGrowth = growth;
  out.shotOutput = await shot(cdp, 'C2-ticker-output', { bottom: false });
  // Stop it.
  const tm = await cdp.evaluate('(window.__p17dToasts ?? []).length');
  out.stop = await cdp.evaluate(clickRowButton('[data-testid="job-row"]', 0, '停止'));
  const trace = [];
  let last = '';
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    const w = await cdp.evaluate(SUBWINDOWS);
    const st = await lib.turnStatus(evalAsync, sid);
    const row = { status: st.status, rows: w.jobs?.rows ?? null };
    const key = JSON.stringify(row);
    if (key !== last) {
      trace.push({ dt: Date.now() - started, ...row });
      last = key;
    }
    await sleep(250);
  }
  out.stopTrace = trace;
  out.wakeTurn = await waitTurn(evalAsync, sid, { neverBusyMs: 3000 });
  await sleep(800);
  out.windowAfterStop = await cdp.evaluate(SUBWINDOWS);
  out.barAfterStop = await cdp.evaluate(SESSION_BAR);
  out.shotStopped = await shot(cdp, 'C2-ticker-stopped', { bottom: false });
  await cdp.evaluate(lib.EXPAND_WORK_GROUPS);
  await sleep(600);
  out.autoHeads = await cdp.evaluate(AUTO_HEADS);
  out.transcript = await cdp.evaluate(TRANSCRIPT);
  out.toasts = await cdp.evaluate(`(window.__p17dToasts ?? []).slice(${tm})`);
  out.shotWake = await shot(cdp, 'C2-wake-turn-head');
  cdp.close();
  save('C1-C2', out);
}

/**
 * C1, the drag in detail: a drag that starts from the stacked place moves the
 * window by one pointer step only; a second drag, from the dragged place, moves
 * it all the way. Each pointer step is logged.
 */
async function c1drag() {
  const cdp = await attach(30_000);
  const out = {};
  const open = await cdp.evaluate(
    `document.querySelector('[data-testid="subwindow-jobs"]') !== null`
  );
  if (!open) await cdp.evaluate(clickBarToggle('jobs'));
  await sleep(800);
  const at0 = await cdp.evaluate(TITLE_ROW_CENTER('jobs'));
  if (at0) await doubleClick(cdp, at0);
  await sleep(600);
  const rectOf = async () => (await cdp.evaluate(SUBWINDOWS)).jobs;
  out.start = await rectOf();
  const stepwise = async (dx, dy, steps) => {
    const from = await cdp.evaluate(TITLE_ROW_CENTER('jobs'));
    const log = [];
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
    await mouse(cdp, 'mousePressed', from.x, from.y);
    for (let i = 1; i <= steps; i += 1) {
      await mouse(cdp, 'mouseMoved', from.x + (dx * i) / steps, from.y + (dy * i) / steps);
      await sleep(60);
      const w = await rectOf();
      log.push({ step: i, x: w.rect.x, y: w.rect.y, dragged: w.dragged });
    }
    await mouse(cdp, 'mouseReleased', from.x + dx, from.y + dy);
    await sleep(300);
    const w = await rectOf();
    return { from, dx, dy, steps: log, end: { x: w.rect.x, y: w.rect.y, dragged: w.dragged } };
  };
  out.firstDrag = await stepwise(-380, 160, 8);
  out.shotFirst = await lib.shot(cdp, 'C1-drag-first');
  out.secondDrag = await stepwise(-200, 100, 8);
  out.shotSecond = await lib.shot(cdp, 'C1-drag-second');
  const at = await cdp.evaluate(TITLE_ROW_CENTER('jobs'));
  await doubleClick(cdp, at);
  await sleep(600);
  out.afterDoubleClick = await rectOf();
  cdp.close();
  save('C1-drag', out);
}

// ---- C3 (+ C6): two jobs, stop all, then the host dies under two more ---------------

async function startTickers(cdp, evalAsync, sid, n, tag) {
  const turns = [];
  for (let i = 1; i <= n; i += 1) {
    await sendText(cdp, `P1-JOBKILL: start ticker ${tag}-${i} in the background.`);
    turns.push(await turnAllowing(cdp, evalAsync, sid));
    await sleep(600);
  }
  return turns;
}

async function c3() {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_RECORDERS);
  const evalAsync = makeEval(cdp);
  const sid = await newChat(cdp, evalAsync);
  await sleep(1500);
  const out = { sid, gear: await setGear(cdp, '全自动') };
  // Phase A: two tickers, 「全部停止」, confirm.
  out.startA = await startTickers(cdp, evalAsync, sid, 2, 'a');
  const isOpen = await cdp.evaluate(
    `document.querySelector('[data-testid="subwindow-jobs"]') !== null`
  );
  if (!isOpen) await cdp.evaluate(clickBarToggle('jobs'));
  await sleep(1000);
  out.windowTwoRunning = await cdp.evaluate(SUBWINDOWS);
  out.barTwoRunning = await cdp.evaluate(SESSION_BAR);
  out.shotTwo = await shot(cdp, 'C3-two-running', { bottom: false });
  out.clickStopAll = await cdp.evaluate(`(() => {
    const b = document.querySelector('[data-testid="subwindow-jobs"] button[aria-label="全部停止"]');
    if (!b) return false;
    b.click();
    return true;
  })()`);
  await sleep(900);
  out.confirm = await cdp.evaluate(`(() => {
    const d = [...document.querySelectorAll('[role="alertdialog"]')].find((n) => n.getAttribute('data-open') !== null);
    return d ? { text: (d.innerText || '').replace(/\\n+/g, ' | '), buttons: [...d.querySelectorAll('button')].map((b) => (b.innerText || '').trim()) } : null;
  })()`);
  out.shotConfirm = await shot(cdp, 'C3-stop-all-confirm', { bottom: false });
  out.confirmed = await cdp.evaluate(`(() => {
    const d = [...document.querySelectorAll('[role="alertdialog"]')].find((n) => n.getAttribute('data-open') !== null);
    const b = d && [...d.querySelectorAll('button')].find((n) => (n.innerText || '').trim() === '全部停止');
    if (!b) return false;
    b.click();
    return true;
  })()`);
  await sleep(4000);
  out.windowAfterStopAll = await cdp.evaluate(SUBWINDOWS);
  out.shotAfterStopAll = await shot(cdp, 'C3-after-stop-all', { bottom: false });
  // Let the wake-up turns (one per stopped ticker) settle.
  out.wakeTurns = await waitTurn(evalAsync, sid, { neverBusyMs: 4000 });
  await sleep(3000);
  out.wakeTurns2 = await waitTurn(evalAsync, sid, { neverBusyMs: 4000 });
  // Phase B: two more tickers, then SIGKILL the host (exact pid).
  out.startB = await startTickers(cdp, evalAsync, sid, 2, 'b');
  await sleep(800);
  out.windowBeforeKill = await cdp.evaluate(SUBWINDOWS);
  out.shotBeforeKill = await shot(cdp, 'C3-before-host-kill', { bottom: false });
  out.hostsBefore = hostPids();
  const killAt = Date.now();
  out.killed = killOneHost();
  const trace = [];
  let last = '';
  const shots = {};
  while (Date.now() - killAt < 30_000) {
    const w = await cdp.evaluate(SUBWINDOWS);
    const st = await lib.turnStatus(evalAsync, sid);
    const row = {
      status: st.status,
      hosts: hostPids().length,
      rows: (w.jobs?.rows ?? []).map((r) => `${r.status} | ${r.text} | ${r.buttons.join(',')}`),
      count: w.jobs?.text?.split(' | ').slice(1, 2)[0] ?? null,
    };
    const key = JSON.stringify(row);
    if (key !== last) {
      trace.push({ dt: Date.now() - killAt, ...row });
      last = key;
    }
    const lost = (w.jobs?.rows ?? []).some((r) => r.status === 'lost');
    if (lost && !shots.lost)
      shots.lost = await shot(cdp, 'C3-after-host-kill-lost', { bottom: false });
    await sleep(250);
  }
  out.killTrace = trace;
  out.killShots = shots;
  out.windowAfterKill = await cdp.evaluate(SUBWINDOWS);
  out.barAfterKill = await cdp.evaluate(SESSION_BAR);
  out.shotAfterKill = await shot(cdp, 'C3-after-host-kill', { bottom: false });
  out.orphanTickers = lib
    .procList()
    .filter((r) => /seq 1 600/.test(r.cmd) && r.cmd.length < 300)
    .map((r) => ({ pid: r.pid, ppid: r.ppid }));
  cdp.close();
  save('C3', out);
}

// ---- C4: the subagents window ---------------------------------------------------------

async function c4() {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_RECORDERS);
  const evalAsync = makeEval(cdp);
  const sid = await newChat(cdp, evalAsync);
  await sleep(1500);
  const out = { sid, gear: await setGear(cdp, '全自动') };
  // Jobs window closed, subagents window open, before the turn starts.
  const openState = await cdp.evaluate(`({
    jobs: document.querySelector('[data-testid="subwindow-jobs"]') !== null,
    agents: document.querySelector('[data-testid="subwindow-agents"]') !== null })`);
  if (openState.jobs) await cdp.evaluate(clickBarToggle('jobs'));
  if (!openState.agents) await cdp.evaluate(clickBarToggle('agents'));
  await sleep(800);
  out.emptyWindow = await cdp.evaluate(SUBWINDOWS);
  out.shotEmpty = await shot(cdp, 'C4-agents-window-empty', { bottom: false });
  await sendText(cdp, 'P1-SUBCONT: delegate to a continuable subagent.');
  const trace = [];
  const shots = {};
  let last = '';
  const started = Date.now();
  let idleReads = 0;
  let seenBusy = false;
  while (Date.now() - started < 90_000) {
    const w = await cdp.evaluate(SUBWINDOWS);
    const bar = await cdp.evaluate(SESSION_BAR);
    const st = await lib.turnStatus(evalAsync, sid);
    const agentsBtn = bar.buttons.find((b) => b.key === 'agents');
    const row = {
      status: st.status,
      badge: agentsBtn?.badge?.text ?? null,
      rows: (w.agents?.rows ?? []).map((r) => `${r.status} | ${r.text} | ${r.buttons.join(',')}`),
    };
    const key = JSON.stringify(row);
    if (key !== last) {
      trace.push({ dt: Date.now() - started, ...row });
      last = key;
    }
    const running = (w.agents?.rows ?? []).some((r) => r.status === 'running');
    if (running && !shots.running)
      shots.running = await shot(cdp, 'C4-subagent-running', { bottom: false });
    if (['starting', 'running', 'stopping'].includes(st.status)) {
      seenBusy = true;
      idleReads = 0;
    } else if (seenBusy) {
      idleReads += 1;
      // The wake-ups come after idle gaps; stop once the final answer is in.
      const text = await cdp.evaluate(TRANSCRIPT);
      if (idleReads >= 6 && /Both runs of the subagent reported back/.test(text)) break;
    }
    await sleep(100);
  }
  out.trace = trace;
  out.runningShots = shots;
  await sleep(1000);
  out.windowDone = await cdp.evaluate(SUBWINDOWS);
  out.barDone = await cdp.evaluate(SESSION_BAR);
  out.shotDone = await shot(cdp, 'C4-agents-window-done', { bottom: false });
  // 「定位」: scroll to the delegating row and mark it.
  await cdp.evaluate(`(() => {
    const v = [...document.querySelectorAll('[data-slot="scroll-area-viewport"]')].filter((x) => x.offsetParent !== null && !/仓库列表/.test(x.innerText || ''));
    let best = null; for (const x of v) if (!best || (x.innerText || '').length > (best.innerText || '').length) best = x;
    if (best) best.scrollTop = best.scrollHeight;
    return true;
  })()`);
  await sleep(500);
  out.locate = await cdp.evaluate(clickRowButton('[data-testid="subagent-row"]', 0, '定位'));
  await sleep(450);
  out.located = await cdp.evaluate(`(() => {
    const n = document.querySelector('[data-tool-call-id][data-located]');
    if (!n) return null;
    const r = n.getBoundingClientRect();
    return { top: Math.round(r.top), h: Math.round(r.height), bg: getComputedStyle(n).backgroundColor, text: (n.innerText || '').slice(0, 200) };
  })()`);
  out.shotLocate = await lib.shot(cdp, 'C4-locate');
  await sleep(1600);
  out.locatedAfter = await cdp.evaluate(
    `document.querySelector('[data-tool-call-id][data-located]') !== null`
  );
  // The lane: open the delegation row and look for 「续聊 · 时间」.
  out.laneOpen = await cdp.evaluate(`(() => {
    const row = document.querySelector('[data-tool-call-id]');
    if (!row) return 'no delegation row';
    const t = [...row.querySelectorAll('button, [role="button"], summary')].find((n) => n.offsetParent !== null);
    if (!t) return 'no toggle';
    t.click();
    return (t.innerText || t.getAttribute('aria-label') || '').trim().slice(0, 80);
  })()`);
  await sleep(900);
  out.lane = await cdp.evaluate(`(() => {
    const row = document.querySelector('[data-tool-call-id]');
    return row ? (row.innerText || '').replace(/\\n+/g, ' | ').slice(0, 1500) : null;
  })()`);
  await cdp.evaluate(
    `(() => { const n = [...document.querySelectorAll('*')].find((x) => x.children.length === 0 && /^续聊/.test((x.innerText || '').trim()) && x.offsetParent !== null); if (n) n.scrollIntoView({ block: 'center' }); return !!n; })()`
  );
  await sleep(500);
  out.shotLane = await lib.shot(cdp, 'C4-lane-continued');
  out.transcript = await cdp.evaluate(TRANSCRIPT);
  cdp.close();
  save('C4', out);
}

// ---- C6: a narrow window keeps the icons and the counts ------------------------------

async function c6() {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_RECORDERS);
  const evalAsync = makeEval(cdp);
  const sid = await newChat(cdp, evalAsync);
  await sleep(1500);
  const out = { sid, gear: await setGear(cdp, '全自动') };
  await sendText(cdp, 'P1-JOBKILL: start a ticker in the background (C6).');
  out.turn = await turnAllowing(cdp, evalAsync, sid);
  await sleep(800);
  const widths = [
    [1400, 900],
    [1280, 800],
    [1279, 800],
    [1200, 800],
    [1024, 768],
  ];
  out.sizes = [];
  for (const [w, h] of widths) {
    const bounds = await lib.setBounds(cdp, w, h);
    await sleep(900);
    const bar = await cdp.evaluate(SESSION_BAR);
    out.sizes.push({
      requested: [w, h],
      via: bounds.via ?? null,
      error: bounds.pageError ?? null,
      browserError: bounds.browserError ?? null,
      viewport: bounds.viewport,
      bar: bar.bar,
      buttons: bar.buttons.map((b) => ({
        key: b.key,
        title: b.title,
        text: b.text,
        labelVisible: b.labelVisible,
        badge: b.badge?.text ?? null,
        w: b.rect.w,
      })),
    });
    // The main window's minimum width is SHELL_MIN_WIDTH (1244), so 1200 and
    // 1024 are viewport overrides (`via` says which); 1280 / 1279 are real.
    if (w === 1280) out.shot1280 = await shot(cdp, 'C6-width-1280', { bottom: false });
    if (w === 1279) out.shot1279 = await shot(cdp, 'C6-narrow-1279', { bottom: false });
    if (w === 1200) out.shot1200 = await shot(cdp, 'C6-narrow-1200-emulated', { bottom: false });
  }
  out.restored = (await lib.setBounds(cdp, 1400, 900)).viewport;
  cdp.close();
  save('C6', out);
}

// ---- C5 (+ D2 stop): a running command's live output and clock ------------------------

const TOOL_ROWS_DOM = `(() => {
  const rows = [...document.querySelectorAll('[class*="group/row"]')].filter((n) => n.offsetParent !== null);
  return rows.map((r) => {
    const svg = r.querySelector('svg');
    const cls = svg ? (svg.getAttribute('class') || '') : '';
    const cs = getComputedStyle(r);
    return {
      text: (r.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 200),
      icon: (cls.match(/lucide-[a-z0-9-]+/g) || []).filter((c) => c !== 'lucide-icon').join(' '),
      color: cs.color,
      red: /text-destructive/.test(r.className),
      slots: [...r.querySelectorAll('[data-slot^="tool-row"]')].map((s) => s.getAttribute('data-slot') + '=' + (s.innerText || '').trim()),
    };
  });
})()`;

/** Click the last visible tool row whose text contains `needle` (opens its body). */
const clickToolRow = (needle) => `(() => {
  const rows = [...document.querySelectorAll('[class*="group/row"]')].filter((n) => n.offsetParent !== null && (n.innerText || '').includes(${JSON.stringify(needle)}));
  const r = rows[rows.length - 1];
  if (!r) return false;
  r.click();
  return true;
})()`;

const LIVE_OUTPUT = `(() => {
  const n = [...document.querySelectorAll('[data-testid="live-tool-output"]')].filter((x) => x.offsetParent !== null).pop();
  if (!n) return null;
  const pre = n.querySelector('pre');
  return { head: (n.querySelector('p')?.innerText || '').trim(), text: (pre?.innerText || '').slice(-300),
           atBottom: pre ? pre.scrollHeight - pre.scrollTop - pre.clientHeight < 8 : null };
})()`;

async function c5() {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_RECORDERS);
  const evalAsync = makeEval(cdp);
  const sid = await newChat(cdp, evalAsync);
  await sleep(1500);
  const out = { sid, gear: await setGear(cdp, '全自动') };
  // 1. P0-SLOWTOOL: two lines five seconds apart, so the tail visibly grows.
  await sendText(cdp, 'P0-SLOWTOOL: run a slow command.');
  const call1 = await waitFor(
    cdp,
    `(() => [...document.querySelectorAll('[class*="group/row"]')].some((n) => n.offsetParent !== null && /slow tool/.test(n.innerText || '')))()`,
    30_000,
    100
  );
  out.slowRowSeen = !!call1;
  await sleep(300);
  out.slowClick = await cdp.evaluate(clickToolRow('slow tool'));
  const samples = [];
  for (let i = 0; i < 14; i += 1) {
    samples.push({
      t: Date.now(),
      live: await cdp.evaluate(LIVE_OUTPUT),
      rows: (await cdp.evaluate(TOOL_ROWS_DOM)).map((r) => r.text),
    });
    if (i === 2) out.shotSlowEarly = await shot(cdp, 'C5-live-output-first-line');
    if (i === 12) out.shotSlowLate = await shot(cdp, 'C5-slowtool-settled');
    await sleep(500);
  }
  out.slowSamples = samples;
  out.slowTurn = await waitTurn(evalAsync, sid);
  // 2. P0-SLEEPTOOL (the checklist's case): the clock 「Ns · 2m 后转后台」, then Stop.
  await sendText(cdp, 'P0-SLEEPTOOL {"token":"c5","seconds":40} run a long command.');
  await waitFor(
    cdp,
    `(() => [...document.querySelectorAll('[class*="group/row"]')].some((n) => n.offsetParent !== null && /sleep-tool c5|Run a long command|sleep 40/.test(n.innerText || '')))()`,
    30_000,
    100
  );
  await sleep(400);
  out.sleepClick = await cdp.evaluate(clickToolRow('sleep'));
  const clock = [];
  for (let i = 0; i < 6; i += 1) {
    await sleep(2000);
    const rows = await cdp.evaluate(TOOL_ROWS_DOM);
    clock.push({
      t: Date.now(),
      row: rows.filter((r) => /sleep/.test(r.text)).pop() ?? null,
      live: await cdp.evaluate(LIVE_OUTPUT),
    });
    if (i === 5) out.shotClock = await shot(cdp, 'C5-sleeptool-clock');
  }
  out.clock = clock;
  // D2: Stop while it runs.
  out.stopClicked = await cdp.evaluate(CLICK_STOP);
  out.stopTurn = await waitTurn(evalAsync, sid, { neverBusyMs: 3000 });
  await sleep(1000);
  await cdp.evaluate(lib.EXPAND_WORK_GROUPS);
  await sleep(600);
  out.rowsAfterStop = await cdp.evaluate(TOOL_ROWS_DOM);
  out.shotStopped = await shot(cdp, 'D2-shell-stopped');
  cdp.close();
  save('C5', out);
}

// ---- D: tool rows, failure cards, both themes -----------------------------------------

/**
 * Contrast of what a tool row paints: the icon (currentColor at the icon's
 * own opacity), the verb, the neutral trailing words (outcome, background
 * job, exit code) and the failure card's title and body, each against the
 * colour actually behind it. Colours are resolved by painting them on a
 * canvas, so oklch / oklab / color-mix all come back as sRGB.
 */
const CONTRAST = `(() => {
  const cv = document.createElement('canvas'); cv.width = cv.height = 1;
  const g = cv.getContext('2d', { willReadFrequently: true });
  const rgba = (css) => { g.clearRect(0, 0, 1, 1); g.fillStyle = '#000'; g.fillStyle = css; g.fillRect(0, 0, 1, 1); const d = g.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
  const parse = (css) => { const m = /^rgba?\\(([^)]+)\\)$/.exec(css); if (m) { const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; } const a = /\\/\\s*([0-9.]+)\\)$/.exec(css); const c = rgba(css); return a ? [c[0], c[1], c[2], Number(a[1])] : c; };
  const bgOf = (n) => { let x = n; const layers = []; while (x && x !== document.documentElement) { const c = parse(getComputedStyle(x).backgroundColor); if (c[3] > 0) layers.push(c); if (c[3] >= 1) break; x = x.parentElement; } if (!layers.length || layers[layers.length - 1][3] < 1) layers.push(parse(getComputedStyle(document.body).backgroundColor)); let out = layers.pop(); while (layers.length) { const t = layers.pop(); out = [0, 1, 2].map((i) => t[i] * t[3] + out[i] * (1 - t[3])).concat(1); } return out; };
  const blend = (fg, a, bg) => [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a));
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return Math.round(((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)) * 100) / 100; };
  const opacityOf = (n) => { let o = 1; for (let x = n; x && x !== document.body; x = x.parentElement) o *= Number(getComputedStyle(x).opacity); return o; };
  const measure = (n, label) => { if (!n) return null; const cs = getComputedStyle(n); const bg = bgOf(n); const fg = parse(cs.color); const op = opacityOf(n) * (fg[3] ?? 1); return { label, ratio: ratio(blend(fg, op, bg), bg), fg: cs.color, opacity: Math.round(op * 100) / 100, bg: 'rgb(' + bg.slice(0, 3).map(Math.round).join(',') + ')' }; };
  const rows = [...document.querySelectorAll('[class*="group/row"]')].filter((n) => n.offsetParent !== null);
  const out = [];
  for (const r of rows.slice(0, 40)) {
    const text = (r.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
    const svg = r.querySelector('svg');
    const icon = svg ? measure(svg, 'icon') : null;
    const verb = measure(r.querySelector('span'), 'verb');
    const trailing = [...r.querySelectorAll('[data-slot^="tool-row-"]')].map((n) => measure(n, n.getAttribute('data-slot')));
    out.push({ text, icon, verb, trailing });
  }
  const card = [...document.querySelectorAll('[role="alert"]')].filter((n) => n.offsetParent !== null).pop();
  const cardTitle = card ? measure(card.querySelector('p'), 'card title') : null;
  const cardBody = card ? measure(card.querySelectorAll('p')[1], 'card body') : null;
  return { theme: document.documentElement.className, rows: out, cardTitle, cardBody };
})()`;

const PASTE_NOTES = `const file = new File(['Meeting notes\\nFILE-MARKER-NOTES: ship the P1-7d point-check.\\n'], 'notes.txt', { type: 'text/plain' });
  const dt = new DataTransfer();
  dt.items.add(file);
  const ta = document.querySelector('textarea');
  ta.focus();
  const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
  ta.dispatchEvent(ev);
  return { defaultPrevented: ev.defaultPrevented };`;

/** The box a row opens into (its row plus body), scrolled to the middle. */
const ROW_BOX = (needle) => `(() => {
  const r = [...document.querySelectorAll('[class*="group/row"]')].filter((n) => n.offsetParent !== null && (n.innerText || '').includes(${JSON.stringify(needle)})).pop();
  if (!r) return null;
  let box = r;
  for (let i = 0; i < 4 && box.parentElement; i += 1) { box = box.parentElement; if ((box.innerText || '').length > (r.innerText || '').length + 10) break; }
  box.scrollIntoView({ block: 'center' });
  const t = box.innerText || '';
  return { head: t.slice(0, 500), tail: t.slice(-300), length: t.length };
})()`;

async function d1() {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_RECORDERS);
  const evalAsync = makeEval(cdp);
  const sid = await newChat(cdp, evalAsync);
  await sleep(1500);
  const out = { sid, gear: await setGear(cdp, '全自动'), turns: {} };
  await sendText(cdp, 'P0-TOOL: list the workspace.');
  out.turns.tool = await turnAllowing(cdp, evalAsync, sid);
  out.paste = await evalAsync(PASTE_NOTES, { label: 'paste notes.txt' });
  await sleep(1200);
  await cdp.evaluate(lib.typeIntoComposer('P1-FILEREAD: read the attached notes.'));
  await cdp.waitFor(lib.SEND_READY, { timeoutMs: 20_000, label: 'send ready (file)' });
  await cdp.evaluate(lib.CLICK_SEND);
  out.turns.fileread = await turnAllowing(cdp, evalAsync, sid);
  await sendText(cdp, 'P1-PERM-SEARCH: glob and grep the workspace.');
  out.turns.search = await turnAllowing(cdp, evalAsync, sid);
  // P0-JOBS: catch the background row while it is live.
  await sendText(cdp, 'P0-JOBS: run a background ticker and collect it.');
  const live = [];
  const started = Date.now();
  let seenBusy = false;
  let idle = 0;
  while (Date.now() - started < 90_000) {
    const st = await lib.turnStatus(evalAsync, sid);
    if (st.status === 'waiting_permission') {
      const card = await cdp.evaluate(CARD_ALLOW);
      if (card) live.push({ dt: Date.now() - started, card });
    }
    const rows = (await cdp.evaluate(TOOL_ROWS_DOM)).filter((r) => /后台|tick-/.test(r.text));
    if (rows.length) {
      const key = JSON.stringify(rows.map((r) => r.text));
      if (live.at(-1)?.key !== key) live.push({ dt: Date.now() - started, key });
      if (!out.shotJobsLive && rows.some((r) => /后台 · bash-/.test(r.text)))
        out.shotJobsLive = await shot(cdp, 'D1-jobs-row-live');
    }
    if (['starting', 'running', 'stopping', 'waiting_permission'].includes(st.status)) {
      seenBusy = true;
      idle = 0;
    } else if (seenBusy) {
      idle += 1;
      if (idle >= 3) break;
    }
    await sleep(200);
  }
  out.jobsLive = live;
  await cdp.evaluate(lib.EXPAND_WORK_GROUPS);
  await sleep(900);
  out.rows = await cdp.evaluate(TOOL_ROWS_DOM);
  out.contrast = await cdp.evaluate(CONTRAST);
  await cdp.evaluate(
    `(() => { const n = [...document.querySelectorAll('[class*="group/row"]')].find((x) => x.offsetParent !== null); if (n) n.scrollIntoView({ block: 'start' }); return !!n; })()`
  );
  await sleep(500);
  out.shotTop = await lib.shot(cdp, 'D1-tool-rows-top');
  out.shotBottom = await shot(cdp, 'D1-tool-rows-bottom');
  out.transcript = await cdp.evaluate(TRANSCRIPT);
  cdp.close();
  save('D1', out);
}

/** D2: a shell row's body, a non-zero exit, and P0-FS's rows (read / edit / write / grep / glob / bash). */
async function d2() {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_RECORDERS);
  const evalAsync = makeEval(cdp);
  const sid = await newChat(cdp, evalAsync);
  await sleep(1500);
  const out = { sid, gear: await setGear(cdp, '全自动') };
  // marker.txt and edit-target.txt do not exist: the reads fail, and `cat marker.txt` exits 1.
  await sendText(
    cdp,
    'P0-FS {"dir":".","marker":"D2MARK","token":"d2","tag":"d2","shell":"bash"} walk the file tools.'
  );
  out.turn = await turnAllowing(cdp, evalAsync, sid, { timeoutMs: 180_000 });
  await cdp.evaluate(lib.EXPAND_WORK_GROUPS);
  await sleep(900);
  out.rows = await cdp.evaluate(TOOL_ROWS_DOM);
  out.contrast = await cdp.evaluate(CONTRAST);
  out.shotRows = await shot(cdp, 'D2-fs-rows');
  out.openCat = await cdp.evaluate(clickToolRow("cat 'marker.txt'"));
  await sleep(800);
  out.catBody = await cdp.evaluate(ROW_BOX("cat 'marker.txt'"));
  await sleep(500);
  out.shotExit = await lib.shot(cdp, 'D2-shell-exit-code');
  out.openSpill = await cdp.evaluate(clickToolRow('spill-line'));
  await sleep(900);
  out.spillBody = await cdp.evaluate(ROW_BOX('spill-line'));
  await sleep(500);
  out.shotSpill = await lib.shot(cdp, 'D2-shell-large-output');
  cdp.close();
  save('D2', out);
}

/** D3: the todo_write rows of P0-GOAL-COMPLETE, opened. */
async function d3() {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_RECORDERS);
  const evalAsync = makeEval(cdp);
  const sid = await newChat(cdp, evalAsync);
  await sleep(1500);
  const out = { sid, gear: await setGear(cdp, '全自动') };
  await sendText(cdp, 'P0-GOAL-COMPLETE: write progress.txt in the workspace, then verify it.');
  const started = Date.now();
  while (Date.now() - started < 150_000) {
    const st = await lib.turnStatus(evalAsync, sid);
    if (st.status === 'waiting_permission') await cdp.evaluate(CARD_ALLOW);
    const goal = await cdp.evaluate(
      `(() => { const g = document.querySelector('[data-testid="goal-bar"]'); return g ? (g.innerText || '').replace(/\\s+/g, ' ') : null; })()`
    );
    if (goal && /已完成/.test(goal) && !['running', 'starting'].includes(st.status)) {
      out.goal = goal;
      break;
    }
    await sleep(500);
  }
  await sleep(1500);
  await cdp.evaluate(lib.EXPAND_WORK_GROUPS);
  await sleep(900);
  out.allRows = (await cdp.evaluate(TOOL_ROWS_DOM)).map((r) => `${r.icon} | ${r.text}`);
  out.opened = await cdp.evaluate(`(() => {
    const rows = [...document.querySelectorAll('[class*="group/row"]')].filter((n) => n.offsetParent !== null && /^规划/.test((n.innerText || '').trim()));
    for (const r of rows) r.click();
    return rows.length;
  })()`);
  await sleep(900);
  out.bodies = await cdp.evaluate(`(() => {
    const rows = [...document.querySelectorAll('[class*="group/row"]')].filter((n) => n.offsetParent !== null && /^规划/.test((n.innerText || '').trim()));
    return rows.map((r) => { let box = r; for (let i = 0; i < 4 && box.parentElement; i += 1) { box = box.parentElement; if ((box.innerText || '').length > (r.innerText || '').length + 5) break; } return (box.innerText || '').slice(0, 400); });
  })()`);
  await cdp.evaluate(
    `(() => { const r = [...document.querySelectorAll('[class*="group/row"]')].filter((n) => n.offsetParent !== null && /^规划/.test((n.innerText || '').trim())).pop(); if (r) r.scrollIntoView({ block: 'center' }); return !!r; })()`
  );
  await sleep(500);
  out.shotTodo = await lib.shot(cdp, 'D3-todo-rows-expanded');
  cdp.close();
  save('D3', out);
}

const FAILURE_CARD = `(() => {
  const c = [...document.querySelectorAll('[role="alert"]')].filter((n) => n.offsetParent !== null).pop();
  if (!c) return null;
  return { text: (c.innerText || '').replace(/\\n+/g, ' | ').slice(0, 800), svg: c.querySelectorAll('svg').length,
           buttons: [...c.querySelectorAll('button')].map((b) => (b.innerText || '').trim()) };
})()`;

async function failTurn(cdp, evalAsync, prompt, { timeoutMs = 150_000 } = {}) {
  const sid = await newChat(cdp, evalAsync);
  await sleep(1500);
  const sentAt = await sendText(cdp, prompt);
  const trace = [];
  let last = '';
  while (Date.now() - sentAt < timeoutMs) {
    const st = await lib.turnStatus(evalAsync, sid);
    const card = await cdp.evaluate(FAILURE_CARD);
    const retry = await cdp.evaluate(
      `(() => { const t = document.body.innerText; const i = t.indexOf('网络重试中'); return i >= 0 ? t.slice(i, i + 40).replace(/\\n/g, ' ') : null; })()`
    );
    const row = { status: st.status, card: card?.text?.slice(0, 80) ?? null, retry };
    const key = JSON.stringify(row);
    if (key !== last) {
      trace.push({ dt: Date.now() - sentAt, ...row });
      last = key;
    }
    if (card && !['starting', 'running', 'stopping'].includes(st.status)) break;
    await sleep(400);
  }
  await sleep(1500);
  return { sid, trace, card: await cdp.evaluate(FAILURE_CARD) };
}

const SYNTHETIC_429 = (sidExpr) => `${STORE}
  const sid = ${sidExpr};
  const before = s.sessions.find((x) => x.id === sid);
  window.__p17dRateBackup = { runtimeError: before.runtimeError ?? null, runtimeErrorCode: before.runtimeErrorCode ?? null };
  chat.useChatSessionsStore.setState((st) => ({ sessions: st.sessions.map((x) => x.id === sid ? { ...x, runtimeErrorCode: 'PROVIDER_RATE_LIMITED', runtimeError: '429 rate_limit_error: synthetic, for the point-check (the fake gateway has no 429 marker)' } : x) }));
  await new Promise((r) => setTimeout(r, 800));
  return window.__p17dRateBackup;`;

const RESTORE_429 = (sidExpr) => `${STORE}
  const sid = ${sidExpr};
  const b = window.__p17dRateBackup;
  chat.useChatSessionsStore.setState((st) => ({ sessions: st.sessions.map((x) => x.id === sid ? { ...x, runtimeErrorCode: b.runtimeErrorCode, runtimeError: b.runtimeError } : x) }));
  await new Promise((r) => setTimeout(r, 500));
  return { runtimeErrorCode: chat.useChatSessionsStore.getState().sessions.find((x) => x.id === sid)?.runtimeErrorCode ?? null };`;

async function d4(which = 'all') {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_RECORDERS);
  const evalAsync = makeEval(cdp);
  const out = {};
  if (which === 'all' || which === 'key') {
    out.key = await failTurn(cdp, evalAsync, 'P1-ECHOKEY: the upstream refuses the key.');
    out.key.shot = await shot(cdp, 'D4-card-key');
    out.key.contrast = await cdp.evaluate(CONTRAST);
  }
  if (which === 'all' || which === 'server') {
    out.server = await failTurn(cdp, evalAsync, 'P1-FAIL: this request fails upstream.');
    out.server.shot = await shot(cdp, 'D4-card-server-error');
    out.server.contrast = await cdp.evaluate(CONTRAST);
    // Rate limiting: the fake gateway has no 429 marker and src/ is not to be
    // touched, so the card is rendered from this chat's own store entry with
    // the code DSH sends for it (`PROVIDER_RATE_LIMITED`), then put back.
    const sidExpr = JSON.stringify(out.server.sid);
    out.rate = { backup: await evalAsync(SYNTHETIC_429(sidExpr), { label: 'synthetic 429' }) };
    out.rate.card = await cdp.evaluate(FAILURE_CARD);
    out.rate.shot = await shot(cdp, 'D4-card-rate-limited-synthetic');
    out.rate.restored = await evalAsync(RESTORE_429(sidExpr), { label: 'restore' });
  }
  if (which === 'all' || which === 'network') {
    out.gatewayStopped = await lib.gatewayStop();
    out.network = await failTurn(cdp, evalAsync, 'P0-STREAM: the gateway is down for this one.', {
      timeoutMs: 240_000,
    });
    out.network.shot = await shot(cdp, 'D4-card-network');
    out.network.contrast = await cdp.evaluate(CONTRAST);
    out.gatewayRestarted = lib.gatewayStart({ reset: false });
    out.gatewayHealth = await lib.gatewayHealthy();
  }
  cdp.close();
  save(which === 'all' ? 'D4' : `D4-${which}`, out);
}

/**
 * D5: the D1–D4 chats again in the dark theme (light, the default, is what the
 * D1–D4 shots show). Args: `<suffix>=<shot>[@<row text to centre>]`; a shot
 * name containing `rate` gets the synthetic 429 card first.
 */
async function d5(...pairs) {
  const cdp = await attach(30_000);
  const evalAsync = makeEval(cdp);
  const out = { theme: await lib.setTheme(cdp, 'dark'), shots: [] };
  await sleep(1500);
  for (const pair of pairs) {
    const [suffix, rest] = pair.split('=');
    const [name, anchor] = rest.split('@');
    const entry = { suffix, name, open: await openBySuffix(cdp, evalAsync, suffix) };
    out.shots.push(entry);
    await cdp.evaluate(lib.EXPAND_WORK_GROUPS);
    await sleep(800);
    if (name.includes('rate'))
      entry.synthetic = await evalAsync(SYNTHETIC_429('s.activeSessionId'), { label: '429 dark' });
    if (anchor) {
      entry.opened = await cdp.evaluate(clickToolRow(anchor));
      await sleep(700);
      entry.box = await cdp.evaluate(ROW_BOX(anchor));
      await sleep(500);
    }
    entry.contrast = await cdp.evaluate(CONTRAST);
    entry.file = anchor ? await lib.shot(cdp, name) : await shot(cdp, name);
    if (name.includes('rate'))
      entry.restored = await evalAsync(RESTORE_429('s.activeSessionId'), { label: 'restore dark' });
  }
  out.back = await lib.setTheme(cdp, 'light');
  cdp.close();
  save('D5', out);
}

/** Open a chat by id suffix, open the row whose text has `needle`, shoot it: `rowshot <suffix> <needle> <shot> [<result name>]`. */
async function rowshot(suffix, needle, name, resultName) {
  const cdp = await attach(30_000);
  const evalAsync = makeEval(cdp);
  const out = { suffix, needle, open: await openBySuffix(cdp, evalAsync, suffix) };
  await cdp.evaluate(lib.EXPAND_WORK_GROUPS);
  await sleep(800);
  out.clicked = await cdp.evaluate(clickToolRow(needle));
  await sleep(900);
  out.box = await cdp.evaluate(ROW_BOX(needle));
  out.row = (await cdp.evaluate(TOOL_ROWS_DOM)).filter((r) => r.text.includes(needle));
  await sleep(500);
  out.shot = await lib.shot(cdp, name);
  cdp.close();
  save(resultName ?? name, out);
}

/**
 * Found during D5: a turn's 「已工作 N 秒」 and 「完成于 HH:MM」 are gone after
 * the chat is left and opened again. One turn, then away to `<other suffix>`
 * and back, reading the work line each time.
 */
const WORK_LINES = `[...document.querySelectorAll('*')].filter((n) => n.offsetParent !== null && n.children.length <= 3 && /^(已工作|✻)/.test((n.innerText || '').trim()) && (n.innerText || '').length < 80).map((n) => (n.innerText || '').replace(/\\s+/g, ' ').trim())`;

async function worktimes(otherSuffix) {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_RECORDERS);
  const evalAsync = makeEval(cdp);
  const sid = await newChat(cdp, evalAsync);
  await sleep(1500);
  const out = { sid };
  await sendText(cdp, 'P0-STREAM: 一轮短回答（看切走再切回后「已工作 / 完成于」还在不在）。');
  out.turn = await waitTurn(evalAsync, sid);
  await sleep(1000);
  out.live = [...new Set(await cdp.evaluate(WORK_LINES))];
  out.shotLive = await shot(cdp, 'X1-work-line-live');
  out.away = await openBySuffix(cdp, evalAsync, otherSuffix);
  await sleep(1500);
  out.back = await openBySuffix(cdp, evalAsync, sid.slice(-7));
  await sleep(2000);
  out.afterSwitch = [...new Set(await cdp.evaluate(WORK_LINES))];
  out.shotAfter = await shot(cdp, 'X1-work-line-after-switch');
  cdp.close();
  save('X1-work-line', out);
}

/** X1, second half: push `<suffix>`'s chat out of the worker pool (six new chats), then open it again. */
async function reclaim(suffix, count = '6') {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_RECORDERS);
  const evalAsync = makeEval(cdp);
  const out = { suffix, before: null, fillers: [] };
  out.open1 = await openBySuffix(cdp, evalAsync, suffix);
  out.before = [...new Set(await cdp.evaluate(WORK_LINES))];
  for (let i = 1; i <= Number(count); i += 1) {
    const sid = await newChat(cdp, evalAsync);
    await sleep(1200);
    await sendText(cdp, `P0-STREAM: filler ${i}（把前面的对话挤出容量）。`);
    const turn = await waitTurn(evalAsync, sid);
    out.fillers.push({ sid, settled: turn.settled });
  }
  out.status = await evalAsync(
    `${STORE} const x = s.sessions.find((y) => y.id.endsWith(${JSON.stringify(suffix)})); return { status: x.status, hostBound: s.hostBoundSessionIds.includes(x.id) };`,
    { label: 'status' }
  );
  out.open2 = await openBySuffix(cdp, evalAsync, suffix);
  await sleep(3000);
  out.after = [...new Set(await cdp.evaluate(WORK_LINES))];
  out.statusAfter = await evalAsync(
    `${STORE} const x = s.sessions.find((y) => y.id.endsWith(${JSON.stringify(suffix)})); return { status: x.status, hostBound: s.hostBoundSessionIds.includes(x.id), keys: Object.keys((s.messages[x.id] ?? [])[1] ?? {}) };`,
    { label: 'status after' }
  );
  out.shot = await shot(cdp, 'X1-work-line-after-reclaim');
  cdp.close();
  save('X1-reclaim', out);
}

// ---- E: the right-column terminal ------------------------------------------------------

const TERMINAL_BUTTON = `(() => {
  const b = document.querySelector('button[data-session-terminal]');
  if (!b) return null;
  return { state: b.getAttribute('data-session-terminal'), title: b.getAttribute('title'), aria: b.getAttribute('aria-label'),
           wrapperTitle: b.parentElement?.getAttribute('title') ?? null, disabled: b.disabled, pressed: b.getAttribute('aria-pressed'),
           dot: !!b.querySelector('span.rounded-full'), text: (b.innerText || '').trim() };
})()`;

const CLICK_TERMINAL_BUTTON = `(() => { const b = document.querySelector('button[data-session-terminal]'); if (!b || b.disabled) return false; b.click(); return true; })()`;

/** The right column: who shows, and the terminal's chrome. */
const RIGHT_COLUMN = `(() => {
  const rect = (n) => { if (!n) return null; const r = n.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  const vis = (n) => !!n && n.offsetParent !== null && n.getBoundingClientRect().width > 0;
  const col = document.querySelector('[data-testid="terminal-column"]');
  const tab = document.querySelector('[data-testid="terminal-column-tab"]');
  const close = tab?.querySelector('button');
  const dirRow = col ? [...col.querySelectorAll('div')].find((d) => /会话目录/.test(d.innerText || '') && d.children.length <= 3) : null;
  const layers = [...document.querySelectorAll('[data-column-terminal]')].map((n) => ({ key: n.getAttribute('data-column-terminal').slice(-40), shown: !n.classList.contains('invisible') }));
  const editorTabs = [...document.querySelectorAll('[role="tab"]')].filter((t) => vis(t) && t.getBoundingClientRect().x > 400).map((t) => ({ text: (t.innerText || '').trim().slice(0, 40), rect: rect(t) }));
  const review = [...document.querySelectorAll('section, div')].find((n) => vis(n) && /^(审阅|会话审阅)/.test((n.getAttribute('aria-label') || '')));
  const search = col ? [...col.querySelectorAll('input')].filter(vis).map((i) => ({ placeholder: i.getAttribute('placeholder'), focused: document.activeElement === i })) : [];
  const active = document.activeElement;
  return {
    terminal: vis(col) ? { rect: rect(col), tab: tab ? { text: (tab.innerText || '').trim(), rect: rect(tab) } : null,
      close: close ? { aria: close.getAttribute('aria-label'), title: close.getAttribute('title') } : null,
      dir: dirRow ? (dirRow.innerText || '').replace(/\\s+/g, ' ').trim() : null, xterm: !!col.querySelector('.xterm'), layers, search } : (col ? { hidden: true, rect: rect(col), layers } : null),
    editorTabs,
    review: review ? { label: review.getAttribute('aria-label'), rect: rect(review) } : null,
    focusInTerminal: !!(col && active && col.contains(active)),
    activeElement: active ? (active.tagName + '.' + String(active.className).slice(0, 40)) : null,
    viewport: { w: innerWidth, h: innerHeight },
  };
})()`;

/** Type into the visible column terminal (xterm's helper textarea), then Enter. */
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

const termTail = (cdp, n = 400) =>
  cdp.evaluate(
    `String(window.__p17dTermText ?? '').replace(/\\x1b\\[[0-9;?]*[A-Za-z]/g, '').replace(/\\x1b\\][^\\x07]*\\x07/g, '').slice(-${n})`
  );

/** Shells of this run: `bash -i -l` whose cwd is in the scratch dir. */
const termShells = () =>
  lib
    .procList()
    .filter(
      (r) => /(^|\/)bash( |$)/.test(r.cmd.split(' ')[0]) && (r.cwd ?? '').startsWith(lib.SCRATCH)
    )
    .map((r) => ({ pid: r.pid, cwd: r.cwd.slice(lib.SCRATCH.length) }));

async function e1() {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_RECORDERS);
  await cdp.evaluate(lib.INSTALL_TERM_RECORDER);
  const evalAsync = makeEval(cdp);
  const sid = await newChat(cdp, evalAsync);
  await sleep(1500);
  const out = { sid, shellsBefore: termShells() };
  out.size1440 = await lib.setBounds(cdp, 1440, 900);
  out.buttonBefore = await cdp.evaluate(TERMINAL_BUTTON);
  out.opened = await cdp.evaluate(CLICK_TERMINAL_BUTTON);
  out.framesAfterOpen = await lib.pumpFrames(cdp, 4000);
  out.xtermMounted = await cdp.evaluate(
    `document.querySelector('[data-testid="terminal-column"] .xterm') !== null`
  );
  out.typed = await termType(cdp, 'echo P1-7D-TERM-$((6*7)); pwd');
  await sleep(800);
  out.column1440 = await cdp.evaluate(RIGHT_COLUMN);
  out.buttonOpen = await cdp.evaluate(TERMINAL_BUTTON);
  out.termTail = await termTail(cdp);
  out.shellsOpen = termShells();
  out.shot1440 = await lib.shot(cdp, 'E1-terminal-1440x900');
  out.size1280 = await lib.setBounds(cdp, 1280, 720);
  await sleep(800);
  out.column1280 = await cdp.evaluate(RIGHT_COLUMN);
  out.shot1280 = await lib.shot(cdp, 'E1-terminal-1280x720');
  out.back = (await lib.setBounds(cdp, 1400, 900)).viewport;
  cdp.close();
  save('E1', out);
}

async function e2() {
  const cdp = await attach(30_000);
  const evalAsync = makeEval(cdp);
  const out = {};
  // The sidebar's 「新建临时对话」 and the session bar's 「+」 on a folderless chat call this action.
  out.created = await evalAsync(
    `const m = await import(/* @vite-ignore */ '/stores/chatSessionActions.ts');
     m.createOrReuseUnboundChatSession();
     await new Promise((r) => setTimeout(r, 1500));
     ${STORE.replace('const s =', 'const s2 =')}
     const x = s2.sessions.find((y) => y.id === s2.activeSessionId);
     return { id: x.id, unbound: !!x.unbound, workspaceId: x.workspaceId ?? null };`,
    { label: 'unbound chat' }
  );
  await sleep(1000);
  out.button = await cdp.evaluate(TERMINAL_BUTTON);
  out.clicked = await cdp.evaluate(CLICK_TERMINAL_BUTTON);
  await sleep(800);
  out.column = await cdp.evaluate(RIGHT_COLUMN);
  // Hover the wrapper: the reason is its native title (not in a page screenshot).
  const box = await cdp.evaluate(
    `(() => { const b = document.querySelector('button[data-session-terminal]'); const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`
  );
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
  await sleep(1500);
  out.shot = await lib.shot(cdp, 'E2-unbound-terminal-disabled');
  cdp.close();
  save('E2', out);
}

async function e3(suffix) {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_TERM_RECORDER);
  const evalAsync = makeEval(cdp);
  const out = { open: await openBySuffix(cdp, evalAsync, suffix) };
  out.buttonStart = await cdp.evaluate(TERMINAL_BUTTON);
  if (out.buttonStart?.state !== 'open') {
    await cdp.evaluate(CLICK_TERMINAL_BUTTON);
    await lib.pumpFrames(cdp, 2500);
  }
  out.shells0 = termShells();
  await termType(cdp, 'echo E3-BEFORE-HIDE');
  // 1. Hide with the button: the shell keeps running, the button gets a dot.
  out.hide = await cdp.evaluate(CLICK_TERMINAL_BUTTON);
  await lib.pumpFrames(cdp, 1000);
  out.buttonHidden = await cdp.evaluate(TERMINAL_BUTTON);
  out.columnHidden = await cdp.evaluate(RIGHT_COLUMN);
  out.shellsHidden = termShells();
  out.shotHidden = await lib.shot(cdp, 'E3-terminal-hidden-dot');
  // 2. Show it again: the same shell (its earlier output is still there).
  out.show = await cdp.evaluate(CLICK_TERMINAL_BUTTON);
  await lib.pumpFrames(cdp, 1200);
  await termType(cdp, 'echo E3-AFTER-SHOW $$');
  out.buttonShown = await cdp.evaluate(TERMINAL_BUTTON);
  out.shellsShown = termShells();
  out.tailShown = await termTail(cdp, 300);
  out.shotShown = await lib.shot(cdp, 'E3-terminal-shown-again');
  // 3. `exit` ends it.
  await termType(cdp, 'exit');
  await lib.pumpFrames(cdp, 1500);
  out.buttonAfterExit = await cdp.evaluate(TERMINAL_BUTTON);
  out.columnAfterExit = await cdp.evaluate(RIGHT_COLUMN);
  out.shellsAfterExit = termShells();
  out.shotAfterExit = await lib.shot(cdp, 'E3-after-exit');
  // 4. Open again, then × ends it.
  await cdp.evaluate(CLICK_TERMINAL_BUTTON);
  await lib.pumpFrames(cdp, 2500);
  out.shellsReopened = termShells();
  out.closeClicked = await cdp.evaluate(
    `(() => { const b = document.querySelector('[data-testid="terminal-column-tab"] button[aria-label="关闭终端"]'); if (!b) return false; b.click(); return true; })()`
  );
  await lib.pumpFrames(cdp, 1500);
  out.buttonAfterClose = await cdp.evaluate(TERMINAL_BUTTON);
  out.columnAfterClose = await cdp.evaluate(RIGHT_COLUMN);
  out.shellsAfterClose = termShells();
  out.shotAfterClose = await lib.shot(cdp, 'E3-after-close-x');
  cdp.close();
  save('E3', out);
}

/** Who is on screen in the right column (visibility-aware), and the two tab bars' geometry. */
const OCCUPANT = `(() => {
  const shown = (n) => { if (!n) return false; for (let x = n; x; x = x.parentElement) { const cs = getComputedStyle(x); if (cs.visibility === 'hidden' || cs.display === 'none') return false; } const r = n.getBoundingClientRect(); return r.width > 0 && r.right <= innerWidth + 1; };
  const rect = (n) => { if (!n) return null; const r = n.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  const term = document.querySelector('[data-testid="terminal-column"]');
  const termBar = term?.querySelector(':scope > div');
  const review = document.querySelector('section[aria-label="审阅"]');
  const editorTabs = [...document.querySelectorAll('div.h-10.shrink-0.overflow-hidden.border-b')].find(shown);
  const editorPath = editorTabs?.nextElementSibling;
  const termPath = termBar?.nextElementSibling;
  return {
    terminal: shown(term), review: shown(review), editor: !!editorTabs,
    editorTabTexts: editorTabs ? [...editorTabs.querySelectorAll('div.group')].map((t) => (t.innerText || '').trim()) : [],
    geometry: {
      terminalBar: shown(term) ? rect(termBar) : null, terminalPathRow: shown(term) ? rect(termPath) : null,
      editorBar: rect(editorTabs), editorPathRow: editorTabs ? rect(editorPath) : null,
      reviewHead: shown(review) ? rect(review.querySelector(':scope > div')) : null,
    },
    filesButtonInTerminalBar: !!term?.querySelector('button[aria-label="文件"]'),
    terminalButton: document.querySelector('button[data-session-terminal]')?.getAttribute('data-session-terminal') ?? null,
  };
})()`;

const clickRail = (label) => `(() => {
  const b = [...document.querySelectorAll('button')].find((n) => n.offsetParent !== null && n.getBoundingClientRect().x < 44 && (n.getAttribute('aria-label') || n.getAttribute('title') || '').trim() === ${JSON.stringify(label)});
  if (!b) return false;
  b.click();
  return true;
})()`;

async function e4(suffix) {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_TERM_RECORDER);
  const evalAsync = makeEval(cdp);
  const out = { open: await openBySuffix(cdp, evalAsync, suffix), steps: [] };
  const step = async (name, extra = {}) => {
    await lib.pumpFrames(cdp, 1200);
    const o = await cdp.evaluate(OCCUPANT);
    out.steps.push({ name, ...extra, ...o });
    out.steps.at(-1).shot = await lib.shot(cdp, `E4-${name}`);
  };
  // 1. Terminal in front.
  if ((await cdp.evaluate(TERMINAL_BUTTON))?.state !== 'open') {
    await cdp.evaluate(CLICK_TERMINAL_BUTTON);
    await lib.pumpFrames(cdp, 3000);
  }
  await step('1-terminal');
  // 2. Open README.md from the file tree (rail 「文件」), then back to the chat list.
  out.fileRail = await cdp.evaluate(clickRail('文件'));
  await lib.pumpFrames(cdp, 1500);
  out.treeItems = await cdp.evaluate(
    `[...document.querySelectorAll('[role="treeitem"], [data-path], [title]')].filter((n) => n.offsetParent !== null && /README\\.md/.test(n.innerText || n.getAttribute('title') || '')).slice(0, 5).map((n) => n.tagName + ' ' + (n.getAttribute('role') || '') + ' ' + (n.innerText || n.getAttribute('title') || '').trim().slice(0, 40))`
  );
  out.fileClicked = await cdp.evaluate(`(() => {
    const n = [...document.querySelectorAll('[role="treeitem"], [data-path], div, span')].filter((x) => x.offsetParent !== null && x.getBoundingClientRect().x < 330 && (x.innerText || '').trim() === 'README.md').pop();
    if (!n) return false;
    n.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    n.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    return true;
  })()`);
  await lib.pumpFrames(cdp, 2000);
  out.chatRail = await cdp.evaluate(clickRail('聊天'));
  await lib.pumpFrames(cdp, 1200);
  // Decision 128 rule 10: opening a file sends the terminal behind the files (not ended).
  await step('2-file-opened-terminal-steps-back');
  // 3. Open the review: on top of everything.
  out.reviewClicked = await cdp.evaluate(
    `(() => { const b = [...document.querySelectorAll('button[title="审阅"]')].find((n) => n.offsetParent !== null); if (!b) return false; b.click(); return true; })()`
  );
  await step('3-review-on-top');
  // 4. Close the review: what was under it (the files).
  out.reviewClosed = await cdp.evaluate(
    `(() => { const b = [...document.querySelectorAll('button[title="审阅"]')].find((n) => n.offsetParent !== null); if (!b) return false; b.click(); return true; })()`
  );
  await step('4-review-closed-files-shown');
  // 5. The terminal button brings the same shell to the front, over the files.
  out.front = await cdp.evaluate(CLICK_TERMINAL_BUTTON);
  await step('5-terminal-front-over-files');
  // 6. × on its tab: the files come back as they were, and the shell ends.
  out.closeX = await cdp.evaluate(
    `(() => { const b = document.querySelector('[data-testid="terminal-column-tab"] button[aria-label="关闭终端"]'); if (!b) return false; b.click(); return true; })()`
  );
  await step('6-terminal-closed-files-back');
  out.shells = termShells();
  cdp.close();
  save('E4', out);
}

/** E5: the session bar with the right column open, at 1400×900 and at the widest this screen allows. */
async function e5(suffix) {
  const cdp = await attach(30_000);
  const evalAsync = makeEval(cdp);
  const out = { open: await openBySuffix(cdp, evalAsync, suffix), sizes: [] };
  if ((await cdp.evaluate(TERMINAL_BUTTON))?.state !== 'open') {
    await cdp.evaluate(CLICK_TERMINAL_BUTTON);
    await lib.pumpFrames(cdp, 3000);
  }
  const screen = await cdp.evaluate('({ w: screen.availWidth, h: screen.availHeight })');
  for (const [w, h] of [
    [1400, 900],
    [screen.w, screen.h],
  ]) {
    const b = await lib.setBounds(cdp, w, h);
    await lib.pumpFrames(cdp, 1500);
    const bar = await cdp.evaluate(SESSION_BAR);
    const occ = await cdp.evaluate(OCCUPANT);
    const col = await cdp.evaluate(
      `(() => { const c = document.querySelector('[data-testid="terminal-column"]'); const r = c.getBoundingClientRect(); return { x: Math.round(r.x), w: Math.round(r.width) }; })()`
    );
    out.sizes.push({
      requested: [w, h],
      via: b.via,
      viewport: b.viewport,
      bar: bar.bar,
      barRight: bar.bar.x + bar.bar.w,
      terminalColumn: col,
      overlap: bar.bar.x + bar.bar.w > col.x,
      buttons: bar.buttons.map((x) => ({
        key: x.key ?? x.title,
        labelVisible: x.labelVisible,
        right: x.rect.x + x.rect.w,
      })),
      terminalBar: occ.geometry.terminalBar,
    });
    out.sizes.at(-1).shot = await lib.shot(cdp, `E5-bar-with-right-column-${w}`);
  }
  out.back = (await lib.setBounds(cdp, 1400, 900)).viewport;
  cdp.close();
  save('E5', out);
}

/** E6: two chats in one folder share the shell; focus on switching back; Ctrl+F; Esc reaches the shell. */
async function e6(suffixA, suffixB) {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_TERM_RECORDER);
  const evalAsync = makeEval(cdp);
  const out = { a: await openBySuffix(cdp, evalAsync, suffixA) };
  if ((await cdp.evaluate(TERMINAL_BUTTON))?.state !== 'open') {
    await cdp.evaluate(CLICK_TERMINAL_BUTTON);
    await lib.pumpFrames(cdp, 3000);
  }
  await termType(cdp, 'echo E6-FROM-A pid=$$');
  out.shellsA = termShells();
  out.layersA = (await cdp.evaluate(RIGHT_COLUMN)).terminal?.layers ?? null;
  // Switch to B (same folder).
  out.b = await openBySuffix(cdp, evalAsync, suffixB);
  await lib.pumpFrames(cdp, 1500);
  out.buttonB = await cdp.evaluate(TERMINAL_BUTTON);
  out.columnB = await cdp.evaluate(RIGHT_COLUMN);
  await termType(cdp, 'echo E6-FROM-B pid=$$');
  out.shellsB = termShells();
  out.tailB = await termTail(cdp, 200);
  out.shotB = await lib.shot(cdp, 'E6-same-shell-in-chat-b');
  // Back to A: the terminal takes focus.
  await cdp.evaluate(`(() => { document.activeElement?.blur?.(); return true; })()`);
  out.a2 = await openBySuffix(cdp, evalAsync, suffixA);
  await lib.pumpFrames(cdp, 1500);
  out.focusAfterSwitchBack = (await cdp.evaluate(RIGHT_COLUMN)).focusInTerminal;
  out.activeAfterSwitchBack = (await cdp.evaluate(RIGHT_COLUMN)).activeElement;
  // Ctrl+F while the terminal shows: its search bar.
  await termType(cdp, '', { enter: false });
  await pressKey(cdp, 'f', { ctrl: true });
  await lib.pumpFrames(cdp, 1200);
  out.searchAfterCtrlF = (await cdp.evaluate(RIGHT_COLUMN)).terminal?.search ?? null;
  out.globalSearchOpen = await cdp.evaluate(
    `[...document.querySelectorAll('[role="dialog"]')].filter((d) => d.getAttribute('data-open') !== null).map((d) => (d.innerText || '').slice(0, 80))`
  );
  out.shotSearch = await lib.shot(cdp, 'E6-ctrl-f-terminal-search');
  // Close the search (Escape inside it), then Esc inside a program: `cat -v` prints it as ^[.
  await pressKey(cdp, 'Escape');
  await lib.pumpFrames(cdp, 800);
  out.searchAfterEsc = (await cdp.evaluate(RIGHT_COLUMN)).terminal?.search ?? null;
  await termType(cdp, 'cat -v');
  await pressKey(cdp, 'Escape');
  await lib.pumpFrames(cdp, 600);
  await pressKey(cdp, 'Enter', { text: '\r' });
  await lib.pumpFrames(cdp, 1200);
  out.columnAfterEsc = await cdp.evaluate(RIGHT_COLUMN);
  out.tailAfterEsc = await termTail(cdp, 160);
  out.escReachedShell = /\^\[/.test(out.tailAfterEsc);
  out.shotEsc = await lib.shot(cdp, 'E6-esc-reaches-shell');
  // End `cat` (Ctrl+D) so the shell is back at its prompt.
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'd',
    code: 'KeyD',
    windowsVirtualKeyCode: 68,
    modifiers: 2,
    text: '\u0004',
  });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'd',
    code: 'KeyD',
    windowsVirtualKeyCode: 68,
    modifiers: 2,
  });
  await lib.pumpFrames(cdp, 800);
  out.tailEnd = await termTail(cdp, 80);
  cdp.close();
  save('E6', out);
}

/**
 * E6, the two keys on their own (the e6 run's Esc check was spoilt: its Ctrl+F
 * opened nothing, so the Esc meant for the search bar reached bash as Meta).
 * Ctrl+F with focus in the terminal: which keydown listeners see it, what the
 * pty got, whether the search bar opened. Then Esc inside `cat -v`.
 */
async function e6keys(suffix) {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_TERM_RECORDER);
  const evalAsync = makeEval(cdp);
  const out = { open: await openBySuffix(cdp, evalAsync, suffix) };
  if ((await cdp.evaluate(TERMINAL_BUTTON))?.state !== 'open') {
    await cdp.evaluate(CLICK_TERMINAL_BUTTON);
    await lib.pumpFrames(cdp, 3000);
  }
  await termType(cdp, '', { enter: false });
  await cdp.evaluate(`(() => {
    window.__p17dKeys = [];
    window.addEventListener('keydown', (e) => window.__p17dKeys.push({ capture: e.key, ctrl: e.ctrlKey }), true);
    window.addEventListener('keydown', (e) => window.__p17dKeys.push({ bubble: e.key, ctrl: e.ctrlKey }), false);
    return true;
  })()`);
  const mark = await cdp.evaluate('String(window.__p17dTermText ?? "").length');
  await pressKey(cdp, 'f', { ctrl: true });
  await lib.pumpFrames(cdp, 1200);
  out.ctrlF = {
    listeners: await cdp.evaluate('window.__p17dKeys'),
    ptyEcho: await cdp.evaluate(
      `JSON.stringify(String(window.__p17dTermText ?? '').slice(${mark}))`
    ),
    searchInputs: await cdp.evaluate(
      `[...document.querySelectorAll('[data-testid="terminal-column"] input')].map((i) => i.getAttribute('placeholder'))`
    ),
  };
  out.shotCtrlF = await lib.shot(cdp, 'E6-ctrl-f-no-search-bar');
  // Ctrl+U clears the line bash may hold, then `cat -v`, Esc, Enter: cat prints ^[.
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'u',
    code: 'KeyU',
    windowsVirtualKeyCode: 85,
    modifiers: 2,
    text: '\u0015',
  });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'u',
    code: 'KeyU',
    windowsVirtualKeyCode: 85,
    modifiers: 2,
  });
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
    column: (await cdp.evaluate(RIGHT_COLUMN)).terminal ? 'terminal still shown' : 'terminal gone',
    button: (await cdp.evaluate(TERMINAL_BUTTON))?.state ?? null,
  };
  out.esc.reachedCat = /\^\[/.test(out.esc.ptyEcho);
  out.shotEsc = await lib.shot(cdp, 'E6-esc-reaches-shell');
  // Ctrl+C ends `cat`; the shell stays.
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'c',
    code: 'KeyC',
    windowsVirtualKeyCode: 67,
    modifiers: 2,
    text: '\u0003',
  });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'c',
    code: 'KeyC',
    windowsVirtualKeyCode: 67,
    modifiers: 2,
  });
  await lib.pumpFrames(cdp, 800);
  out.shells = termShells();
  cdp.close();
  save('E6-keys', out);
}

// ---- dispatch ----------------------------------------------------------------------------

const items = {
  c12,
  c1drag,
  c3,
  c4,
  c5,
  c6,
  d1,
  d2,
  d3,
  d4,
  d5,
  rowshot,
  worktimes,
  reclaim,
  e1,
  e2,
  e3,
  e4,
  e5,
  e6,
  e6keys,
};
export const cde = {
  shot,
  save,
  newChat,
  setGear,
  pressKey,
  waitFor,
  clickButtonText,
  openBySuffix,
  SESSION_BAR,
  SUBWINDOWS,
  TOOL_ROWS_DOM,
  TRANSCRIPT,
  bashCalls,
  hostPids,
  killOneHost,
  clickToolRow,
  clickBarToggle,
  activeSid,
};
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const name = process.argv[2];
  if (!items[name]) {
    console.error(`usage: p1-7d-items-cde.mjs ${Object.keys(items).join('|')}`);
    process.exit(2);
  }
  await items[name](...process.argv.slice(3));
  process.exit(0);
}
