#!/usr/bin/env node
/**
 * p1-7e-items.mjs — drivers for the GUI re-check of the P1-7e fixes
 * (groups e1–e5, decisions 137–144), 2026-09-30.
 *
 * Uses p1-7e-gui.mjs (same CDP port, privacy-checked shots into ../shots,
 * results into ../results). The helpers below are copies of the batch 1–3
 * helpers (evidence/p1-7d-gui-2026-09-30/tools), adapted where P1-7e changed
 * the UI they read: the placeholder title shows as 「新建对话」, the tree
 * dialog's role labels are Chinese, a draft chip's remove button is
 * 「移除 …」, and the sidebar has an 「正在活动」 section (so one chat can have
 * two rows). The old drivers are not imported (their `lib` writes to the old
 * evidence directory).
 *
 *   P17D_SCRATCH=/tmp/aiclient-p17e node p1-7e-items.mjs <item> [args]
 *
 * Every item prints a JSON result and writes it to ../results/<name>.json.
 * Chats are named by the last characters of their id (`<suffix>`).
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../../../../..');
const { lib } = await import(path.join(here, 'p1-7e-gui.mjs'));
const { attach, makeEval, sendText, waitTurn, STORE, sleep, scrub } = lib;

// ---- shared helpers ------------------------------------------------------------------

const BUSY = ['starting', 'running', 'stopping', 'waiting_permission', 'waiting_question'];

async function shot(cdp, name, { bottom = true } = {}) {
  if (bottom) {
    await cdp.evaluate(lib.SCROLL_BOTTOM);
    await sleep(400);
  }
  return lib.shot(cdp, name);
}

/** A screenshot taken right away: the privacy check, then one capture (no frame pumping). */
async function fastShot(cdp, name) {
  const text = await cdp.evaluate(lib.PAGE_PRIVACY_TEXT);
  const hits = lib.privacyHits(text);
  if (hits.length) throw new Error(`privacy check failed (${hits.join(', ')}); ${name} not saved`);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(lib.outDir, 'shots', `${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  lib.log(`fast shot shots/${name}.png`);
  return `shots/${name}.png`;
}

const resultsDir = path.join(lib.outDir, 'results');
function save(name, value) {
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(
    path.join(resultsDir, `${name}.json`),
    `${JSON.stringify(scrub(value), null, 2)}\n`
  );
  console.log(JSON.stringify(scrub(value), null, 2).slice(0, 6000));
}

const activeSid = (evalAsync) =>
  evalAsync(`${STORE} return s.activeSessionId;`, { label: 'active sid' });

const sessionInfo = (evalAsync, sid) =>
  evalAsync(
    `${STORE}
     const x = s.sessions.find((r) => r.id === ${JSON.stringify(sid)});
     return x ? { id: x.id, title: x.title, status: x.status, updatedAt: x.updatedAt ?? null,
       hostBound: (s.hostBoundSessionIds ?? []).includes(x.id), messages: (s.messages[x.id] ?? []).length } : null;`,
    { label: 'session info' }
  );

const allSessions = (evalAsync) =>
  evalAsync(
    `${STORE}
     return s.sessions.map((x) => ({ id: x.id, title: x.title, status: x.status, updatedAt: x.updatedAt ?? null,
       hostBound: (s.hostBoundSessionIds ?? []).includes(x.id), workspaceId: x.workspaceId ?? null, messages: (s.messages[x.id] ?? []).length }));`,
    { label: 'all sessions' }
  );

const NEW_CHAT = `(() => {
  const b = [...document.querySelectorAll('button')].filter((n) => (n.innerText || n.getAttribute('aria-label') || '').trim() === '新建对话' && n.offsetParent !== null);
  if (!b.length) return false;
  b[b.length - 1].click();
  return true;
})()`;

/** The sidebar's 「新建」 button (top of the sidebar). */
const CLICK_NEW = `(() => {
  const b = [...document.querySelectorAll('aside button')].find((n) => n.offsetParent !== null && (n.innerText || '').trim() === '新建');
  if (!b) return null;
  const title = b.getAttribute('title');
  b.click();
  return title;
})()`;

async function newChat(cdp, evalAsync) {
  const before = await activeSid(evalAsync);
  const clicked = await cdp.evaluate(CLICK_NEW);
  if (clicked === null) await cdp.evaluate(NEW_CHAT);
  for (let i = 0; i < 30; i += 1) {
    await sleep(300);
    const now = await activeSid(evalAsync);
    if (now && now !== before) return now;
  }
  // 「新建」 reuses the active chat when it is still empty (create-or-reuse).
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

const KEY_CODES = {
  Enter: 13,
  Escape: 27,
  Tab: 9,
  ArrowDown: 40,
  ArrowUp: 38,
  f: 70,
  q: 81,
  a: 65,
};
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

async function ctrlKey(cdp, letter, code) {
  const upper = letter.toUpperCase();
  const base = {
    key: letter,
    code: `Key${upper}`,
    windowsVirtualKeyCode: upper.charCodeAt(0),
    modifiers: 2,
  };
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    ...base,
    text: String.fromCharCode(code),
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

const COMPOSER = `(() => {
  const ta = document.querySelector('textarea');
  const chips = [...document.querySelectorAll('button[aria-label^="移除 "], button[aria-label^="Remove "]')].filter((b) => b.offsetParent !== null).map((b) => b.getAttribute('aria-label'));
  return ta ? { value: ta.value, placeholder: ta.getAttribute('placeholder'), disabled: ta.disabled, chips } : null;
})()`;

const bashCalls = (evalAsync, sid) =>
  evalAsync(
    `${STORE}
     const msgs = s.messages[${JSON.stringify(sid)}] ?? [];
     const blocks = msgs.flatMap((m) => m.blocks ?? []);
     return blocks.filter((b) => b.type === 'tool_call').map((c) => ({ id: c.toolCallId, name: c.toolName, cmd: String(c.toolInput?.command ?? c.toolInput?.pattern ?? c.toolInput?.path ?? '').slice(0, 80),
       settled: blocks.some((r) => r.type === 'tool_result' && r.toolCallId === c.toolCallId) }));`,
    { label: 'tool calls' }
  );

const roles = (evalAsync, sid) =>
  evalAsync(
    `${STORE}
     return (s.messages[${JSON.stringify(sid)}] ?? []).map((m) => m.role + ':' + (m.blocks ?? []).map((b) => b.type + (b.type === 'text' ? '(' + String(b.text ?? '').slice(0, 50) + ')' : '')).join(','));`,
    { label: 'roles' }
  );

const lastAssistantText = (evalAsync, sid) =>
  evalAsync(
    `${STORE}
     const msgs = s.messages[${JSON.stringify(sid)}] ?? [];
     const last = [...msgs].reverse().find((m) => m.role === 'assistant');
     return (last?.blocks ?? []).filter((b) => b.type === 'text').map((b) => String(b.text ?? '')).join('');`,
    { label: 'assistant text' }
  );

const toastsSince = (cdp, mark) =>
  cdp.evaluate(`(window.__p17dToasts ?? []).slice(${Number(mark)})`);
const toastMark = (cdp) => cdp.evaluate('(window.__p17dToasts ?? []).length');

/** Toasts on screen now: text, whether hidden, and their box. */
const TOASTS_NOW = `(() => {
  const rect = (n) => { const r = n.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom) }; };
  // Each toast is a [data-slot="toast"] root (toast.tsx).
  return [...document.querySelectorAll('[data-slot="toast"]')].map((root) => {
    const t = root.querySelector('[data-slot="toast-title"]');
    const cs = getComputedStyle(root);
    return { title: (t?.innerText || '').trim(), text: (root.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 240), visibility: cs.visibility, opacity: cs.opacity, pointerEvents: cs.pointerEvents, rect: rect(root) };
  });
})()`;

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

/**
 * Open a chat by id (or id suffix) through its sidebar row. P1-7e: the row's
 * title attribute is the DISPLAYED title (a placeholder `New chat` shows as
 * 「新建对话」), and a chat can have a second row in 「正在活动」; every
 * matching row is tried until the store's active chat is ours.
 */
async function openChat(cdp, evalAsync, idOrSuffix) {
  let out = await openChatOnce(cdp, evalAsync, idOrSuffix);
  if (out?.error === 'no row') {
    // P1-7e (decision 137 §4): a folder lists 8 rows; the chat may be behind 「查看更多（N）」.
    out.expanded = await cdp.evaluate(`(() => {
      const bs = [...document.querySelectorAll('aside button')].filter((b) => b.offsetParent !== null && /^查看更多/.test((b.innerText || '').trim()));
      for (const b of bs) b.click();
      return bs.length;
    })()`);
    await sleep(600);
    out = { ...(await openChatOnce(cdp, evalAsync, idOrSuffix)), viaViewMore: out.expanded };
  }
  return out;
}

async function openChatOnce(cdp, evalAsync, idOrSuffix) {
  const out = await evalAsync(
    `${STORE}
     const target = s.sessions.find((x) => x.id === ${JSON.stringify(idOrSuffix)}) ?? s.sessions.find((x) => x.id.endsWith(${JSON.stringify(idOrSuffix)}));
     if (!target) return { error: 'no session' };
     if (s.activeSessionId === target.id) return { id: target.id, active: target.id, already: true };
     const placeholder = ['New chat', 'Live Agent Host'].includes(target.title);
     const shown = placeholder ? '新建对话' : target.title;
     const rows = [...document.querySelectorAll('aside [role="button"][title]')].filter((n) => n.offsetParent !== null && n.getAttribute('title') === shown);
     if (!rows.length) return { error: 'no row', title: shown };
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
    { label: 'open chat' }
  );
  await sleep(1500);
  await lib.pumpFrames(cdp, 300);
  return out;
}

/**
 * The sidebar as the user sees it: every session row in DOM order with the
 * section it sits in (「正在活动」, 「最近」 or a folder), its run marker, its
 * badges (text and height) and age text; the folder headers with their
 * expanded state and the 「查看更多（N）」 / 「收起」 row under each.
 */
const SIDEBAR = `(() => {
  const aside = [...document.querySelectorAll('aside')].find((a) => a.offsetParent !== null && /仓库列表/.test(a.innerText || ''));
  if (!aside) return null;
  const sectionOf = (n) => {
    for (let x = n.parentElement; x && x !== aside; x = x.parentElement) {
      if (x.tagName !== 'SECTION') continue;
      const head = x.querySelector(':scope > div p, :scope > div span.font-semibold');
      const label = (head?.innerText || '').trim();
      if (label === '正在活动') return 'active';
      if (label === '最近') return 'recent';
      const folder = x.querySelector('span.font-semibold');
      return 'folder:' + ((folder?.innerText || '').trim());
    }
    return 'other';
  };
  const rows = [...aside.querySelectorAll('[role="button"][title]')].filter((n) => n.offsetParent !== null).map((n) => {
    const spinner = n.querySelector('[aria-label="运行中"]');
    const img = n.querySelector('[role="img"][aria-label]');
    const ring = n.querySelector('span[title="正在后台运行"]');
    const spans = [...n.querySelectorAll(':scope > span')];
    const age = spans.find((s) => /tabular-nums/.test(s.className) && /text-right/.test(s.className));
    const titleSpan = n.querySelector(':scope > span.truncate, :scope > span > span.truncate');
    const suffix = n.querySelector(':scope > span > span.shrink-0.text-muted-foreground');
    return {
      section: sectionOf(n),
      title: n.getAttribute('title'),
      shownTitle: (titleSpan?.innerText || '').trim(),
      suffix: suffix ? { text: (suffix.innerText || '').trim(), w: Math.round(suffix.getBoundingClientRect().width), sw: suffix.scrollWidth, cw: suffix.clientWidth } : null,
      titleTruncated: titleSpan ? titleSpan.scrollWidth > titleSpan.clientWidth + 1 : null,
      active: /bg-selection/.test(n.className),
      marker: spinner ? 'spinner' : img ? img.getAttribute('aria-label') : ring ? 'started' : null,
      markerBox: spinner ? Math.round(spinner.getBoundingClientRect().width) : img ? Math.round(img.getBoundingClientRect().width) : null,
      badges: [...n.querySelectorAll('[data-slot="badge"]')].map((b) => ({ text: (b.innerText || '').trim(), h: Math.round(b.getBoundingClientRect().height), fontSize: getComputedStyle(b).fontSize, size: b.getAttribute('data-size') })),
      age: age ? (age.innerText || '').trim() : null,
      h: Math.round(n.getBoundingClientRect().height),
    };
  });
  const sections = [...aside.querySelectorAll('section')].filter((x) => x.offsetParent !== null).map((x) => {
    const p = x.querySelector(':scope > div p');
    const folder = x.querySelector(':scope > div span.font-semibold, :scope > div button span.font-semibold');
    const toggles = [...x.querySelectorAll(':scope > div > button, :scope > div > div > button')].filter((b) => b.offsetParent !== null && /^(查看更多|收起|显示更多)/.test((b.innerText || '').trim())).map((b) => (b.innerText || '').replace(/\\s+/g, '').trim());
    return {
      label: (p?.innerText || folder?.innerText || '').trim(),
      folderOpen: folder ? !!x.querySelector(':scope > div svg.lucide-folder-open') : null,
      rows: x.querySelectorAll(':scope [role="button"][title]').length,
      toggles,
      recentToggle: x.querySelector('button[aria-label="展开最近"], button[aria-label="收起最近"]')?.getAttribute('aria-label') ?? null,
    };
  });
  return { rows, sections, newTitle: [...aside.querySelectorAll('button')].find((b) => (b.innerText || '').trim() === '新建')?.getAttribute('title') ?? null };
})()`;

/** Right-click a sidebar row (by displayed title; `index` picks among duplicates, -1 = last). */
async function rightClickRow(cdp, title, index = -1) {
  const box = await cdp.evaluate(`(() => {
    const rows = [...document.querySelectorAll('aside [role="button"][title]')].filter((n) => n.offsetParent !== null && n.getAttribute('title') === ${JSON.stringify(title)});
    const row = rows.at(${index});
    if (!row) return null;
    row.scrollIntoView({ block: 'center' });
    const r = row.getBoundingClientRect();
    return { x: Math.round(r.x + 60), y: Math.round(r.y + r.height / 2), rows: rows.length };
  })()`);
  if (!box) return null;
  await lib.pumpFrames(cdp, 300);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: box.x,
    y: box.y,
    button: 'right',
    buttons: 2,
    clickCount: 1,
  });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: box.x,
    y: box.y,
    button: 'right',
    buttons: 0,
    clickCount: 1,
  });
  await sleep(700);
  return box;
}

async function realClick(cdp, at, button = 'left') {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: at.x,
    y: at.y,
    button,
    buttons: button === 'left' ? 1 : 2,
    clickCount: 1,
  });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: at.x,
    y: at.y,
    button,
    buttons: 0,
    clickCount: 1,
  });
}

const centerOf = (selectorExpr) => `(() => {
  const n = ${selectorExpr};
  if (!n) return null;
  n.scrollIntoView?.({ block: 'nearest' });
  const r = n.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
})()`;

/** Where focus is, and the sidebar's rename field if one is open. */
const RENAME_FOCUS = `(() => {
  const a = document.activeElement;
  const fields = [...document.querySelectorAll('aside input')].filter((n) => n.offsetParent !== null && n.getAttribute('placeholder') !== '搜索会话');
  return { active: a ? a.tagName + (a.tagName === 'INPUT' ? ':' + a.value.slice(0, 60) : a.tagName === 'TEXTAREA' ? ':composer' : '') : null,
           fields: fields.map((n) => ({ value: n.value.slice(0, 60), focused: n === a })) };
})()`;

/**
 * Rename through the row's context menu, the way a user does it; the focus is
 * sampled for `holdMs` before anything is typed (issue 26: the field used to
 * lose focus to the composer 1–3 ms after it appeared). `finish` is 'enter'
 * or 'escape'. Never types unless the rename field holds focus.
 */
async function renameViaMenu(
  cdp,
  title,
  name,
  { finish = 'enter', holdMs = 1500, index = -1 } = {}
) {
  const box = await rightClickRow(cdp, title, index);
  if (!box) return { error: 'no row', title };
  const menu = await cdp.evaluate(
    `[...document.querySelectorAll('[role=menuitem]')].filter((n) => n.offsetParent !== null).map((n) => (n.innerText || '').trim())`
  );
  const item = await cdp.evaluate(
    centerOf(
      `[...document.querySelectorAll('[role=menuitem]')].find((n) => n.offsetParent !== null && /^重命名/.test((n.innerText || '').trim()))`
    )
  );
  if (!item) return { error: 'no rename item', menu };
  await realClick(cdp, item);
  const trace = [];
  const t0 = Date.now();
  while (Date.now() - t0 < holdMs) {
    await lib.pumpFrames(cdp, 100);
    const f = await cdp.evaluate(RENAME_FOCUS);
    trace.push({ dt: Date.now() - t0, ...f });
  }
  const now = await cdp.evaluate(RENAME_FOCUS);
  const focusedField = now.fields.find((f) => f.focused);
  let typed = null;
  if (focusedField) {
    await cdp.evaluate(`(() => { document.activeElement.select?.(); return true; })()`);
    await cdp.send('Input.insertText', { text: name });
    await sleep(200);
    typed = await cdp.evaluate(RENAME_FOCUS);
    await pressKey(cdp, finish === 'escape' ? 'Escape' : 'Enter');
  }
  await sleep(900);
  const lostFocusAt = trace.find((x) => !x.fields.some((f) => f.focused));
  return {
    menu,
    focusHeldWholeTime: !lostFocusAt,
    firstLoss: lostFocusAt ?? null,
    traceSamples: trace.length,
    traceFirst: trace[0] ?? null,
    traceLast: trace.at(-1) ?? null,
    typed,
    finish,
    after: await cdp.evaluate(RENAME_FOCUS),
  };
}

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
  { timeoutMs = 120_000, neverBusyMs = 25_000, onTick = null } = {}
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
    if (onTick) await onTick(st, Date.now() - started);
    if (st.status === 'waiting_permission') {
      const card = await cdp.evaluate(CARD_ALLOW);
      if (card) cards.push({ dt: Date.now() - started, card });
    }
    if (BUSY.includes(st.status)) {
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

const TOOL_ROWS_DOM = `(() => {
  const rows = [...document.querySelectorAll('[class*="group/row"]')].filter((n) => n.offsetParent !== null);
  return rows.map((r) => {
    const svg = r.querySelector('svg');
    const cls = svg ? (svg.getAttribute('class') || '') : '';
    return {
      text: (r.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 200),
      icon: (cls.match(/lucide-[a-z0-9-]+/g) || []).filter((c) => c !== 'lucide-icon').join(' '),
      iconClass: cls.split(' ').filter((c) => /opacity|text-/.test(c)).join(' '),
      slots: [...r.querySelectorAll('[data-slot^="tool-row"]')].map((s) => s.getAttribute('data-slot') + '=' + (s.innerText || '').trim()),
    };
  });
})()`;

const clickToolRow = (needle) => `(() => {
  const rows = [...document.querySelectorAll('[class*="group/row"]')].filter((n) => n.offsetParent !== null && (n.innerText || '').includes(${JSON.stringify(needle)}));
  const r = rows[rows.length - 1];
  if (!r) return false;
  r.click();
  return true;
})()`;

/** The box a row opens into (its row plus body), scrolled to the middle. */
const ROW_BOX = (needle) => `(() => {
  const r = [...document.querySelectorAll('[class*="group/row"]')].filter((n) => n.offsetParent !== null && (n.innerText || '').includes(${JSON.stringify(needle)})).pop();
  if (!r) return null;
  let box = r;
  for (let i = 0; i < 4 && box.parentElement; i += 1) { box = box.parentElement; if ((box.innerText || '').length > (r.innerText || '').length + 10) break; }
  box.scrollIntoView({ block: 'center' });
  const t = box.innerText || '';
  return { head: t.slice(0, 700), tail: t.slice(-300), length: t.length };
})()`;

const LIVE_OUTPUT = `(() => {
  const n = [...document.querySelectorAll('[data-testid="live-tool-output"]')].filter((x) => x.offsetParent !== null).pop();
  if (!n) return null;
  const pre = n.querySelector('pre');
  return { head: (n.querySelector('p')?.innerText || '').trim(), text: (pre?.innerText || '').slice(-300) };
})()`;

/** Contrast of tool-row icons and verbs and of the last failure card (see batch 2's D5). */
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
  const measure = (n, label) => { if (!n) return null; const cs = getComputedStyle(n); const bg = bgOf(n); const fg = parse(cs.color); const op = opacityOf(n) * (fg[3] ?? 1); return { label, ratio: ratio(blend(fg, op, bg), bg), fg: cs.color, opacity: Math.round(op * 100) / 100, bg: 'rgb(' + bg.slice(0, 3).map(Math.round).join(',') + ')', cls: String(n.getAttribute('class') || '').split(' ').filter((c) => /opacity|text-/.test(c)).join(' ') }; };
  const rows = [...document.querySelectorAll('[class*="group/row"]')].filter((n) => n.offsetParent !== null);
  const out = [];
  for (const r of rows.slice(0, 40)) {
    const text = (r.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
    const svg = r.querySelector('svg');
    out.push({ text, icon: svg ? measure(svg, 'icon') : null, verb: measure(r.querySelector('span'), 'verb') });
  }
  const card = [...document.querySelectorAll('[role="alert"]')].filter((n) => n.offsetParent !== null).pop();
  const cardTitle = card ? measure(card.querySelector('p'), 'card title') : null;
  const cardBody = card ? measure(card.querySelectorAll('p')[1], 'card body') : null;
  return { theme: document.documentElement.className, rows: out, cardTitle, cardBody, cardText: card ? (card.innerText || '').slice(0, 200) : null };
})()`;

const PASTE_NOTES = `const file = new File(['Meeting notes\\nFILE-MARKER-NOTES: ship the P1-7e re-check.\\n'], 'notes.txt', { type: 'text/plain' });
  const dt = new DataTransfer();
  dt.items.add(file);
  const ta = document.querySelector('textarea');
  ta.focus();
  const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
  ta.dispatchEvent(ev);
  return { defaultPrevented: ev.defaultPrevented };`;

const pastePng = (width, height, name) => `
  const c = document.createElement('canvas');
  c.width = ${width}; c.height = ${height};
  const g = c.getContext('2d');
  g.fillStyle = '#2c7be5'; g.fillRect(0, 0, ${width}, ${height});
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  const file = new File([blob], ${JSON.stringify(name)}, { type: 'image/png' });
  const dt = new DataTransfer();
  dt.items.add(file);
  const ta = document.querySelector('textarea');
  ta.focus();
  const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
  const dispatched = ta.dispatchEvent(ev);
  return { bytes: blob.size, dispatched, defaultPrevented: ev.defaultPrevented };`;

const WORK_LINES = `[...new Set([...document.querySelectorAll('*')].filter((n) => n.offsetParent !== null && n.children.length <= 3 && /^(已工作|✻|思考)/.test((n.innerText || '').trim()) && (n.innerText || '').length < 80).map((n) => (n.innerText || '').replace(/\\s+/g, ' ').trim()))]`;

const MENU_ITEMS = `[...document.querySelectorAll('[role=menuitem],[role=menuitemradio],[role=option],[role=menuitemcheckbox],[role=group] > [role=presentation], [data-slot="menu-group-label"]')]
  .filter((n) => n.offsetParent !== null)
  .map((n) => ({ role: n.getAttribute('role') ?? n.getAttribute('data-slot'), checked: n.getAttribute('aria-checked'), text: (n.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 100), title: n.getAttribute('title') }))`;
const clickMenuItem = (prefix) => `(() => {
  const m = [...document.querySelectorAll('[role=menuitem],[role=menuitemradio],[role=option],[role=menuitemcheckbox]')]
    .find((n) => n.offsetParent !== null && (n.innerText || '').replace(/\\s+/g, ' ').trim().startsWith(${JSON.stringify(prefix)}));
  if (!m) return false;
  m.click();
  return true;
})()`;
const MODEL_TRIGGER_EXPR = `(() => {
  const ta = document.querySelector('textarea');
  let box = ta;
  for (let i = 0; i < 6 && box?.parentElement; i += 1) box = box.parentElement;
  return [...(box ?? document).querySelectorAll('button')].find((n) => n.offsetParent !== null && /^(Automatic|自动|fake-|P1-7)/.test((n.innerText || '').trim()));
})()`;
const MODEL_TRIGGER = `(() => { const b = ${MODEL_TRIGGER_EXPR}; return b ? { text: (b.innerText || '').trim(), aria: b.getAttribute('aria-label'), title: b.getAttribute('title') } : null; })()`;

async function pickModel(cdp, modelId) {
  const opened = await cdp.evaluate(
    `(() => { const b = ${MODEL_TRIGGER_EXPR}; if (!b) return null; b.click(); return (b.innerText || '').trim(); })()`
  );
  await sleep(700);
  await cdp.evaluate(clickMenuItem('其他模型'));
  await sleep(700);
  const items = await cdp.evaluate(MENU_ITEMS);
  const picked = await cdp.evaluate(clickMenuItem(modelId));
  await sleep(900);
  await pressKey(cdp, 'Escape');
  await sleep(400);
  return { opened, items, picked, trigger: await cdp.evaluate(MODEL_TRIGGER) };
}

// Session tree dialog (「会话分支」).
const OPEN_TREE = `(() => {
  const b = [...document.querySelectorAll('button')].find((n) => (n.innerText || n.getAttribute('aria-label') || '').trim() === '会话分支' && n.offsetParent !== null);
  if (!b) return 'no button';
  if (b.disabled) return 'disabled';
  b.click();
  return 'clicked';
})()`;
const TREE_NODES = `(() => {
  const d = [...document.querySelectorAll('[data-slot="dialog-popup"]')].filter((n) => n.getAttribute('data-open') !== null).pop();
  if (!d) return null;
  const rows = [...d.querySelectorAll('button[aria-label="回退到这里"]')].map((b) => b.parentElement);
  return {
    header: (d.innerText || '').split('\\n').slice(0, 3).join(' | '),
    text: (d.innerText || '').slice(0, 2000),
    nodes: rows.map((r, i) => {
      const rewind = r.querySelector('button[aria-label="回退到这里"]');
      const fork = r.querySelector('button[aria-label="从这里分叉"]');
      return { i, text: (r.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 140),
        selected: /bg-selection/.test(r.className), rewindDisabled: rewind?.disabled ?? null, forkDisabled: fork?.disabled ?? null };
    }),
  };
})()`;
const treeClick = (index, label) => `(() => {
  const d = [...document.querySelectorAll('[data-slot="dialog-popup"]')].filter((n) => n.getAttribute('data-open') !== null).pop();
  const rows = [...d.querySelectorAll('button[aria-label="回退到这里"]')].map((b) => b.parentElement);
  const b = rows[${index}]?.querySelector('button[aria-label=${JSON.stringify(label)}]');
  if (!b) return 'no button';
  if (b.disabled) return 'disabled';
  b.click();
  return 'clicked';
})()`;
const CLOSE_TREE = `(() => {
  const d = [...document.querySelectorAll('[data-slot="dialog-popup"]')].filter((n) => n.getAttribute('data-open') !== null).pop();
  const b = d && [...d.querySelectorAll('button')].find((n) => (n.innerText || '').trim() === '关闭');
  if (b) b.click();
  return !!b;
})()`;
const DIALOG = `(() => {
  const d = [...document.querySelectorAll('[data-slot="alert-dialog-popup"], [data-slot="dialog-popup"]')].filter((n) => n.getAttribute('data-open') !== null).pop();
  if (!d) return null;
  return { role: d.getAttribute('role'), text: (d.innerText || '').slice(0, 600),
    buttons: [...d.querySelectorAll('button')].map((b) => ((b.innerText || b.getAttribute('aria-label') || '').trim() + (b.disabled ? ' [disabled]' : ''))) };
})()`;
const dialogButton = (label) => `(() => {
  const d = [...document.querySelectorAll('[data-slot="alert-dialog-popup"], [data-slot="dialog-popup"]')].filter((n) => n.getAttribute('data-open') !== null).pop();
  if (!d) return 'no dialog';
  const b = [...d.querySelectorAll('button')].find((n) => (n.innerText || '').trim() === ${JSON.stringify(label)});
  if (!b) return 'no button';
  if (b.disabled) return 'disabled';
  b.click();
  return 'clicked';
})()`;
const OPEN_DIALOGS = `[...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].filter((d) => d.getAttribute('data-open') !== null).map((d) => ({ role: d.getAttribute('role'), text: (d.innerText || '').slice(0, 2500), buttons: [...d.querySelectorAll('button')].filter((b) => b.offsetParent !== null).map((b) => (b.innerText || b.getAttribute('aria-label') || '').trim()) }))`;

async function openTree(cdp) {
  const r = await cdp.evaluate(OPEN_TREE);
  let nodes = null;
  for (let i = 0; i < 30; i += 1) {
    await sleep(300);
    nodes = await cdp.evaluate(TREE_NODES);
    if (nodes?.nodes.length) break;
  }
  return { open: r, ...nodes };
}

const userTexts = (evalAsync, sid) =>
  evalAsync(
    `${STORE}
     return (s.messages[${JSON.stringify(sid)}] ?? []).map((m) => m.role + ': ' + (m.blocks ?? []).filter((b) => b.type === 'text').map((b) => String(b.text ?? '').slice(0, 60)).join(''));`,
    { label: 'texts' }
  );

/** A settled turn: send, then busy and three idle reads. */
async function turn(cdp, evalAsync, sid, text, opts = {}) {
  await sendText(cdp, text);
  return waitTurn(evalAsync, sid, opts);
}

/** Every line of the page that names the chat engine (the host status ribbon), sampled in the page. */
const INSTALL_BANNER_SAMPLER = `(() => {
  if (window.__p17eBanner) return 'already';
  window.__p17eBanner = [];
  const seen = new Set();
  setInterval(() => {
    const t = document.body.innerText || '';
    for (const line of t.split('\\n')) {
      const s = line.trim();
      if (!/对话引擎|Live Agent Host|Pi session|chat engine/.test(s) || s.length > 160) continue;
      if (seen.has(s)) continue;
      seen.add(s);
      window.__p17eBanner.push({ t: Date.now(), line: s });
    }
  }, 150);
  return 'installed';
})()`;

// ---- e1 + e4: the first start --------------------------------------------------------------

/**
 * Right after `enter` on a fresh HOME: 「最近」 folded, no 「正在活动」, the
 * landing chat shown as 「新建对话」 (not 「Live Agent Host」), the composer's
 * placeholder, the session bar title.
 */
async function first(tag = 'first-start') {
  const cdp = await attach(30_000);
  await cdp.evaluate(lib.INSTALL_RECORDERS);
  await cdp.evaluate(INSTALL_BANNER_SAMPLER);
  const evalAsync = makeEval(cdp);
  await lib.pumpFrames(cdp, 800);
  const out = {
    sidebar: await cdp.evaluate(SIDEBAR),
    sessions: await allSessions(evalAsync),
    active: await activeSid(evalAsync),
    composer: await cdp.evaluate(COMPOSER),
    storage: await cdp.evaluate(`localStorage.getItem('aiclient-sidebar-recent-collapsed')`),
    liveAgentHostAnywhere: await cdp.evaluate(
      `document.body.innerText.includes('Live Agent Host')`
    ),
    headerText: await cdp.evaluate(
      `(document.querySelector('[class*="@container"].h-9') ?? document.querySelector('header'))?.innerText?.slice(0, 200) ?? null`
    ),
    bodyHead: await cdp.evaluate(`document.body.innerText.slice(0, 600)`),
  };
  out.shot = await shot(cdp, `e1-${tag}`, { bottom: false });
  cdp.close();
  save(tag, out);
}

/** Toggle 「最近」 through its own chevron (a real click), then read the state. */
async function recentToggle(tag = 'e1-recent-toggle') {
  const cdp = await attach(30_000);
  const out = { before: await cdp.evaluate(SIDEBAR) };
  const at = await cdp.evaluate(
    centerOf(
      `document.querySelector('aside button[aria-label="展开最近"], aside button[aria-label="收起最近"]')`
    )
  );
  out.at = at;
  if (at) await realClick(cdp, at);
  await sleep(800);
  out.after = await cdp.evaluate(SIDEBAR);
  out.storage = await cdp.evaluate(`localStorage.getItem('aiclient-sidebar-recent-collapsed')`);
  out.shot = await shot(cdp, tag, { bottom: false });
  cdp.close();
  save(tag, out);
}

/** Model menu, slash menu, @ popover, placeholder (e4). */
async function e4menus(tag = 'e4-menus') {
  const cdp = await attach(30_000);
  const evalAsync = makeEval(cdp);
  const out = {
    trigger: await cdp.evaluate(MODEL_TRIGGER),
    composer: await cdp.evaluate(COMPOSER),
  };
  // Model menu.
  out.openMenu = await cdp.evaluate(
    `(() => { const b = ${MODEL_TRIGGER_EXPR}; if (!b) return null; b.click(); return true; })()`
  );
  await sleep(900);
  out.menu = await cdp.evaluate(MENU_ITEMS);
  out.menuText = await cdp.evaluate(
    `[...document.querySelectorAll('[role="menu"]')].filter((n) => n.offsetParent !== null).map((n) => (n.innerText || '').slice(0, 1500))`
  );
  out.shotMenu = await shot(cdp, `${tag}-model-menu`, { bottom: false });
  // Hover each effort item for its tooltip (title attribute or a tooltip popup).
  out.effortTitles = await cdp.evaluate(
    `[...document.querySelectorAll('[role=menuitemradio], [role=menuitem]')].filter((n) => n.offsetParent !== null).map((n) => ({ text: (n.innerText || '').replace(/\\s+/g, ' ').trim(), title: n.getAttribute('title') ?? n.querySelector('[title]')?.getAttribute('title') ?? null }))`
  );
  const eff = await cdp.evaluate(
    centerOf(
      `[...document.querySelectorAll('[role=menuitemradio]')].find((n) => n.offsetParent !== null && /^中/.test((n.innerText || '').trim()))`
    )
  );
  if (eff) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: eff.x, y: eff.y });
    await lib.pumpFrames(cdp, 1500);
    out.tooltip = await cdp.evaluate(
      `[...document.querySelectorAll('[data-slot="tooltip-popup"], [role="tooltip"]')].filter((n) => n.offsetParent !== null).map((n) => (n.innerText || '').trim())`
    );
    out.shotEffortHover = await lib.shot(cdp, `${tag}-effort-hover`);
  }
  await pressKey(cdp, 'Escape');
  await sleep(600);
  // Slash menu.
  await cdp.evaluate(lib.typeIntoComposer(''));
  await cdp.evaluate(`(() => { document.querySelector('textarea').focus(); return true; })()`);
  await cdp.send('Input.insertText', { text: '/' });
  await sleep(1200);
  // The slash popup: the smallest visible box holding both /archive and /compact.
  out.slash = await cdp.evaluate(`(() => {
    const boxes = [...document.querySelectorAll('div, ul')].filter((n) => n.offsetParent !== null && /\\/archive/.test(n.innerText || '') && /\\/compact/.test(n.innerText || '') && !/仓库列表/.test(n.innerText || ''));
    boxes.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
    return boxes[0] ? (boxes[0].innerText || '').split('\\n').map((s) => s.trim()).filter(Boolean) : null;
  })()`);
  out.shotSlash = await shot(cdp, `${tag}-slash`, { bottom: false });
  await pressKey(cdp, 'Escape');
  await cdp.evaluate(lib.typeIntoComposer(''));
  await sleep(400);
  // @ popover.
  await cdp.evaluate(`(() => { document.querySelector('textarea').focus(); return true; })()`);
  await cdp.send('Input.insertText', { text: '@' });
  await sleep(1500);
  out.atFooter = await cdp.evaluate(`(() => {
    const boxes = [...document.querySelectorAll('div')].filter((n) => n.offsetParent !== null && /导航|Navigate/.test(n.innerText || '') && (n.innerText || '').length < 400);
    boxes.sort((a, b) => (b.innerText || '').length - (a.innerText || '').length);
    const pop = boxes.find((n) => !/执行 ·/.test(n.innerText || ''));
    return pop ? (pop.innerText || '').split('\\n').map((s) => s.trim()).filter(Boolean) : null;
  })()`);
  out.shotAt = await shot(cdp, `${tag}-at`, { bottom: false });
  await pressKey(cdp, 'Escape');
  await cdp.evaluate(lib.typeIntoComposer(''));
  await sleep(300);
  out.active = await activeSid(evalAsync);
  cdp.close();
  save(tag, out);
}

/**
 * Quit through the app's own path (app.quit + the confirm dialog's 「退出」)
 * while a MutationObserver records every line naming the chat engine: the
 * engine ribbon's 「已停止」 state is documented as reachable when the app
 * shuts down. Stops reading when the page goes away.
 */
async function quitwatch(tag = 'e4-ribbon-at-quit') {
  const cdp = await attach(30_000);
  const out = { lines: [], shots: [] };
  await cdp.evaluate(`(() => {
    window.__p17eRibbon = [];
    const seen = new Set();
    const scan = () => {
      for (const line of (document.body.innerText || '').split('\\n')) {
        const s = line.trim();
        if (!/对话引擎|chat engine|Pi session/.test(s) || s.length > 160 || seen.has(s)) continue;
        seen.add(s);
        window.__p17eRibbon.push({ t: Date.now(), line: s });
      }
    };
    new MutationObserver(scan).observe(document.body, { childList: true, subtree: true, characterData: true });
    return true;
  })()`);
  // A page that goes away mid-call leaves the CDP promise pending forever (run 1
  // of this re-check lost its result that way): every call gets a deadline.
  const within = (p, ms = 1500) =>
    Promise.race([
      p,
      new Promise((_, reject) => setTimeout(() => reject(new Error('cdp timeout')), ms)),
    ]);
  const save0 = () => save(tag, out);
  process.on('beforeExit', save0);
  await cdp.evaluate(`(() => { window.electronAPI.app.quit(); return true; })()`);
  const t0 = Date.now();
  let confirmed = false;
  while (Date.now() - t0 < 30_000) {
    try {
      if (!confirmed) {
        confirmed = await within(
          cdp.evaluate(`(() => {
          const b = [...document.querySelectorAll('button')].find((n) => (n.innerText || '').trim() === '退出' && n.offsetParent !== null);
          if (!b) return false;
          b.click();
          return true;
        })()`)
        );
        if (confirmed) out.confirmedAt = Date.now() - t0;
      }
      const lines = await within(cdp.evaluate('window.__p17eRibbon'));
      if (lines.length > out.lines.length) {
        out.lines = lines.map((l) => ({ dt: l.t - t0, line: l.line }));
        if (out.shots.length < 2)
          out.shots.push(await within(fastShot(cdp, `${tag}-${out.shots.length + 1}`), 3000));
      }
    } catch (error) {
      out.pageGoneAt = Date.now() - t0;
      out.pageGoneWith = String(error.message ?? error).slice(0, 120);
      break;
    }
    await sleep(40);
  }
  try {
    cdp.close();
  } catch {
    // the page is gone
  }
  process.off('beforeExit', save0);
  save(tag, out);
}

/** As early as the page exists: record every line naming the chat engine (read later with `js window.__p17eRibbon`). */
async function bootwatch() {
  const cdp = await attach(600_000);
  await cdp.waitFor(`!!document.body`, { timeoutMs: 120_000, label: 'body' });
  const r = await cdp.evaluate(`(() => {
    if (window.__p17eRibbon) return 'already';
    window.__p17eRibbon = [];
    const t0 = Date.now();
    const seen = new Set();
    const scan = () => {
      for (const line of (document.body?.innerText || '').split('\\n')) {
        const s = line.trim();
        if (!/对话引擎|chat engine|Pi session|Live Agent Host/.test(s) || s.length > 160 || seen.has(s)) continue;
        seen.add(s);
        window.__p17eRibbon.push({ dt: Date.now() - t0, line: s });
      }
    };
    new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    return 'installed';
  })()`);
  cdp.close();
  console.log(r);
}

// ---- dispatch --------------------------------------------------------------------------------

const items = {
  first,
  'recent-toggle': recentToggle,
  e4menus,
  quitwatch,
  bootwatch,
};

export const e7 = {
  shot,
  fastShot,
  save,
  activeSid,
  sessionInfo,
  allSessions,
  newChat,
  setGear,
  pressKey,
  ctrlKey,
  waitFor,
  clickButtonText,
  CLICK_STOP,
  TRANSCRIPT,
  COMPOSER,
  bashCalls,
  roles,
  lastAssistantText,
  toastMark,
  toastsSince,
  TOASTS_NOW,
  hostPids,
  killOneHost,
  openChat,
  SIDEBAR,
  rightClickRow,
  realClick,
  centerOf,
  RENAME_FOCUS,
  renameViaMenu,
  CARD_ALLOW,
  turnAllowing,
  TOOL_ROWS_DOM,
  clickToolRow,
  ROW_BOX,
  LIVE_OUTPUT,
  CONTRAST,
  PASTE_NOTES,
  pastePng,
  WORK_LINES,
  MENU_ITEMS,
  clickMenuItem,
  MODEL_TRIGGER,
  pickModel,
  OPEN_TREE,
  TREE_NODES,
  treeClick,
  CLOSE_TREE,
  DIALOG,
  dialogButton,
  OPEN_DIALOGS,
  openTree,
  userTexts,
  turn,
  INSTALL_BANNER_SAMPLER,
  BUSY,
  repoRoot,
  spawn,
  crypto,
};

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const name = process.argv[2];
  if (!items[name]) {
    console.error(`usage: p1-7e-items.mjs ${Object.keys(items).join('|')}`);
    process.exit(2);
  }
  await items[name](...process.argv.slice(3));
  process.exit(0);
}
