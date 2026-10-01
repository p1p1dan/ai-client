#!/usr/bin/env node
/**
 * p1-5-gw.mjs — CDP driver for the P1-5 real-gateway run (R1–R10), 2026-09-30.
 *
 * Attaches to the dev app the user already started and logged in to
 * (company login, isolated HOME /tmp/aiclient-real-gw/home, CDP port 9222).
 * It never launches, quits or restarts the app, never starts a gateway, and
 * never calls a gateway itself: every model request goes through the app's own
 * UI (composer send, Git panel completions).
 *
 * Privacy: every value printed or saved passes `scrub` (e-mail addresses, URLs
 * other than loopback, IPv4 addresses, key/Bearer/JWT shapes, request ids,
 * the real home, host name and user name). Screenshots refuse any page whose
 * text contains `@`.
 *
 * Request budget: every model request this driver makes is appended to
 * requests.jsonl in the results directory (`count` prints the running total).
 * The results directory defaults to ../results/; set P15_RESULTS_DIR to keep
 * it outside the repo, and P15_REQUEST_BUDGET to cap a follow-up round.
 *
 *   node p1-5-gw.mjs peek | state | catalog | js '<expr>' | page '<body>' | count
 *   node p1-5-gw.mjs <item> [args]      see `items` at the bottom
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../../../../..');
const { Cdp, sleep } = await import(path.join(repoRoot, 'scripts/h21-cdp.mjs'));

const PORT = 9222;
const SCRATCH = '/tmp/aiclient-real-gw';
const outDir = path.resolve(here, '..');
// Raw results stay out of the public repo: point P15_RESULTS_DIR at a local directory.
const resultsDir = process.env.P15_RESULTS_DIR
  ? path.resolve(process.env.P15_RESULTS_DIR)
  : path.join(outDir, 'results');
const shotsDir = process.env.P15_RESULTS_DIR
  ? path.join(resultsDir, 'shots')
  : path.join(outDir, 'shots');
const requestsFile = path.join(resultsDir, 'requests.jsonl');
// A follow-up round gets its own ledger and a smaller cap (P15_REQUEST_BUDGET).
const REQUEST_BUDGET = Number(process.env.P15_REQUEST_BUDGET) || 60;

// ---- privacy ------------------------------------------------------------------------

const userHome = os.userInfo().homedir;
const hostName = os.hostname();
const userName = os.userInfo().username;
/** Extra literal strings to blank out (e.g. the management endpoint's host, learned in-page). */
const secretsToBlank = new Set();

function scrubText(text) {
  let s = String(text);
  for (const needle of secretsToBlank) if (needle) s = s.split(needle).join('<gw-host>');
  s = s.split(`${userHome}/`).join('<HOME>/').split(userHome).join('<HOME>');
  if (hostName) s = s.split(hostName).join('<host>');
  s = s.split(`${userName}@`).join('<user>@');
  // Addresses AND bare `@domain` suffixes (the sign-up page lists the accepted company domains).
  s = s.replace(
    /[A-Za-z0-9._%+-]*@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
    '<email-or-domain>'
  );
  // A cut-off suffix (text sliced before its TLD) is still a company domain.
  s = s.replace(/@[A-Za-z0-9][A-Za-z0-9.-]{2,}/g, '@<domain>');
  s = s.replace(/https?:\/\/[^\s"'<>)\]]+/g, (url) =>
    /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])([:/]|$)/.test(url) ? url : '<url>'
  );
  s = s.replace(/\b(?!127\.0\.0\.1\b)(\d{1,3}\.){3}\d{1,3}\b/g, '<ip>');
  s = s.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer <redacted>');
  s = s.replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '<key-shape>');
  s = s.replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, '<jwt-shape>');
  s = s.replace(/(request[_ -]?id["'\s:=]+)[A-Za-z0-9_-]{6,}/gi, '$1<redacted>');
  s = s.replace(/\breq_[A-Za-z0-9]{8,}\b/g, '<request-id>');
  // Gateway-side session / trace ids inside provider error bodies.
  s = s.replace(/\bsess_[A-Za-z0-9_]{6,}/g, '<gw-session-id>');
  s = s.replace(/((?:trace|span|correlation)[_ -]?id["'\s:=]+)[A-Za-z0-9_-]{6,}/gi, '$1<redacted>');
  s = s.replace(
    /\b[a-z0-9-]+(\.[a-z0-9-]+)*\.(com|cn|cc|net|org|io|ai|cloud|xyz|top|site|tech|co|me|info|biz|internal|local|lan|corp)\b/gi,
    '<host>'
  );
  return s;
}
/** Scrub every string inside a value (keys included); scrubbing JSON text would break its escapes. */
function scrub(value) {
  if (typeof value === 'string') return scrubText(value);
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [scrubText(k), scrub(v)]));
  }
  return value ?? null;
}

/** Text a screenshot could show: body text and every field value. */
const PAGE_PRIVACY_TEXT = `(() => {
  const parts = [document.body.innerText];
  for (const n of document.querySelectorAll('textarea, input')) parts.push(n.value || '');
  for (const n of document.querySelectorAll('[title], [aria-label]')) parts.push((n.getAttribute('title') || '') + ' ' + (n.getAttribute('aria-label') || ''));
  return parts.join('\\n');
})()`;

function privacyHits(raw) {
  const text = String(raw).split(`${SCRATCH}/home`).join('<scratch-home>');
  const hits = [];
  if (text.includes('@')) hits.push('@');
  if (text.includes('/home/')) hits.push('/home/');
  if (hostName && text.includes(hostName)) hits.push('hostname');
  if (text.includes(userHome)) hits.push('home dir');
  for (const needle of secretsToBlank) if (needle && text.includes(needle)) hits.push('gw host');
  return hits;
}

// ---- results / request ledger ---------------------------------------------------------

function save(name, value) {
  fs.mkdirSync(resultsDir, { recursive: true });
  const clean = scrub(value);
  fs.writeFileSync(path.join(resultsDir, `${name}.json`), `${JSON.stringify(clean, null, 2)}\n`);
  console.log(JSON.stringify(clean, null, 2).slice(0, 8000));
  return clean;
}

function requestsSoFar() {
  if (!fs.existsSync(requestsFile)) return [];
  return fs
    .readFileSync(requestsFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/** Refuse a request that would exceed the budget; otherwise log it and return its number. */
function spendRequest(entry) {
  const done = requestsSoFar();
  if (done.length + 1 > REQUEST_BUDGET) {
    throw new Error(`request budget exhausted (${done.length}/${REQUEST_BUDGET})`);
  }
  fs.mkdirSync(resultsDir, { recursive: true });
  const row = { n: done.length + 1, at: new Date().toISOString(), ...scrub(entry) };
  fs.appendFileSync(requestsFile, `${JSON.stringify(row)}\n`);
  return row.n;
}

// ---- CDP --------------------------------------------------------------------------------

async function attach(timeoutMs = 30_000) {
  const cdp = await Cdp.attach(PORT, timeoutMs);
  cdp.collectRendererProblems();
  return cdp;
}

let slot = 0;
function makeEval(cdp, prefix = 'p15gw') {
  return async function evalAsync(body, { timeoutMs = 120_000, label = 'evalAsync' } = {}) {
    const key = `__${prefix}_${Date.now()}_${slot++}`;
    await cdp.evaluate(`(() => {
      window.${key} = null;
      (async () => { ${body} })()
        .then((value) => { window.${key} = { done: true, value }; })
        .catch((error) => { window.${key} = { done: true, error: String(error?.stack ?? error?.message ?? error) }; });
      return true;
    })()`);
    const out = await cdp.waitFor(`window.${key}?.done ? window.${key} : null`, {
      timeoutMs,
      label,
    });
    await cdp.evaluate(`(() => { delete window.${key}; return true; })()`);
    if (out.error) throw new Error(`${label}: ${out.error}`);
    return out.value;
  };
}

const STORE = `const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
  const s = chat.useChatSessionsStore.getState();`;

/** Learn the management endpoint's host in-page, keep it only in memory for scrubbing. */
async function learnEndpointHost(evalAsync) {
  const host = await evalAsync(
    `const st = await window.electronAPI.piModels.getStatus();
     try { return new URL(st.endpointUrl || st.state?.endpointUrl || '').hostname || null; } catch { return null; }`,
    { label: 'endpoint host' }
  ).catch(() => null);
  if (host) secretsToBlank.add(host);
  return !!host;
}

async function pumpFrames(cdp, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    await cdp
      .send('Page.captureScreenshot', {
        format: 'jpeg',
        quality: 1,
        clip: { x: 0, y: 0, width: 4, height: 4, scale: 1 },
      })
      .catch(() => undefined);
  }
}

async function shot(cdp, name) {
  const text = await cdp.evaluate(PAGE_PRIVACY_TEXT);
  const hits = privacyHits(text);
  if (hits.length) {
    console.error(`[p1-5-gw] shot ${name} refused: page text has ${hits.join(', ')}`);
    return { refused: hits };
  }
  fs.mkdirSync(shotsDir, { recursive: true });
  await pumpFrames(cdp, 800);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(shotsDir, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  return `shots/${name}.png`;
}

// ---- composer / turns -------------------------------------------------------------------

const BUSY = ['starting', 'running', 'stopping', 'waiting_permission', 'waiting_question'];

const typeIntoComposer = (text) => `(() => {
  const ta = document.querySelector('textarea');
  if (!ta) throw new Error('no composer textarea');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, ${JSON.stringify(text)});
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.focus();
  return ta.value.length;
})()`;

const SEND_READY = `(() => {
  const b = [...document.querySelectorAll('button[aria-label]')].find((n) => n.getAttribute('aria-label') === '发送消息');
  return !!b && !b.disabled && b.offsetParent !== null;
})()`;

const CLICK_SEND = `(() => {
  const b = [...document.querySelectorAll('button[aria-label]')].find((n) => n.getAttribute('aria-label') === '发送消息');
  if (!b) throw new Error('no send button');
  if (b.disabled) throw new Error('send button is disabled');
  b.click();
  return true;
})()`;

const CLICK_STOP = `(() => {
  const b = [...document.querySelectorAll('button[aria-label]')].find((n) => n.getAttribute('aria-label') === '停止当前回合' && n.offsetParent !== null);
  if (!b) return false;
  b.click();
  return true;
})()`;

const CARD_ALLOW = `(() => {
  const b = [...document.querySelectorAll('button')].find((n) => n.offsetParent !== null && ['直接允许', '允许', '允许一次'].includes((n.innerText || '').trim()));
  if (!b) return null;
  let card = b;
  for (let i = 0; i < 6 && card.parentElement; i += 1) card = card.parentElement;
  const text = (card.innerText || '').replace(/\\n+/g, ' | ').slice(0, 300);
  b.click();
  return text;
})()`;

const TRANSCRIPT = `(() => {
  const viewports = [...document.querySelectorAll('[data-slot="scroll-area-viewport"]')].filter((v) => v.offsetParent !== null && !/仓库列表/.test(v.innerText || ''));
  let best = null;
  for (const v of viewports) if (!best || (v.innerText || '').length > (best.innerText || '').length) best = v;
  return (best ?? document.body).innerText.replace(/\\n{2,}/g, '\\n').slice(-2500);
})()`;

async function turnStatus(evalAsync, sid) {
  return evalAsync(
    `${STORE}
     const id = ${JSON.stringify(sid ?? null)} ?? s.activeSessionId;
     const x = s.sessions.find((r) => r.id === id);
     return { sid: id, status: x?.status ?? null, messages: (s.messages[id] ?? []).length, lastError: s.lastError ?? null };`,
    { label: 'turn status' }
  );
}

/**
 * Send is the caller's; this waits for busy, then three idle reads, and
 * measures the first visible assistant text (first-token latency as the UI
 * sees it, sampled every 250 ms). Approval cards are allowed when `allow`.
 */
async function waitTurnTimed(
  cdp,
  evalAsync,
  sid,
  sentAt,
  { timeoutMs = 240_000, neverBusyMs = 30_000, allow = false, onTick = null } = {}
) {
  let seenBusy = false;
  let idle = 0;
  let firstTextAt = null;
  const statuses = [];
  const cards = [];
  let last = null;
  while (Date.now() - sentAt < timeoutMs) {
    last = await evalAsync(
      `${STORE}
       const x = s.sessions.find((r) => r.id === ${JSON.stringify(sid)});
       const msgs = s.messages[${JSON.stringify(sid)}] ?? [];
       const lastA = [...msgs].reverse().find((m) => m.role === 'assistant');
       const text = (lastA?.blocks ?? []).filter((b) => b.type === 'text').map((b) => String(b.text ?? '')).join('');
       return { status: x?.status ?? null, messages: msgs.length, textLen: text.length };`,
      { label: 'turn tick' }
    );
    if (statuses.at(-1)?.status !== last.status)
      statuses.push({ dt: Date.now() - sentAt, status: last.status });
    if (firstTextAt === null && last.textLen > 0 && seenBusy) firstTextAt = Date.now();
    if (onTick) await onTick(last, Date.now() - sentAt);
    if (allow && last.status === 'waiting_permission') {
      const card = await cdp.evaluate(CARD_ALLOW);
      if (card) cards.push({ dt: Date.now() - sentAt, card });
    }
    if (BUSY.includes(last.status)) {
      seenBusy = true;
      idle = 0;
    } else if (seenBusy) {
      idle += 1;
      if (idle >= 3) break;
    } else if (Date.now() - sentAt > neverBusyMs) {
      return { settled: false, neverBusy: true, statuses, cards, last };
    }
    await sleep(250);
  }
  const endedAt = Date.now();
  return {
    settled: idle >= 3,
    statuses,
    cards,
    last,
    // The last idle reads add ~0.75 s; subtract them for the turn's duration.
    durationMs: endedAt - sentAt - (idle >= 3 ? 750 : 0),
    firstTextMs: firstTextAt ? firstTextAt - sentAt : null,
  };
}

/** The outcome of the last turn: assistant text, failure block, tool calls. */
async function turnOutcome(evalAsync, sid) {
  return evalAsync(
    `${STORE}
     const msgs = s.messages[${JSON.stringify(sid)}] ?? [];
     const lastA = [...msgs].reverse().find((m) => m.role === 'assistant');
     const blocks = lastA?.blocks ?? [];
     const all = msgs.flatMap((m) => m.blocks ?? []);
     const text = blocks.filter((b) => b.type === 'text').map((b) => String(b.text ?? '')).join('');
     const thinking = blocks.filter((b) => b.type === 'thinking').map((b) => String(b.text ?? b.thinking ?? '')).join('');
     const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o && o[k] !== undefined).map((k) => [k, o[k]]));
     const failures = msgs.filter((m) => m.failure || m.error).map((m) => pick(m.failure ?? m.error ?? {}, ['kind', 'code', 'category', 'message', 'reason', 'status', 'httpStatus', 'retryable']));
     const errBlocks = all.filter((b) => b.type === 'error' || b.type === 'failure' || b.type === 'notice').map((b) => ({ type: b.type, text: String(b.text ?? b.message ?? '').slice(0, 300), code: b.code ?? b.kind ?? null }));
     const tools = all.filter((b) => b.type === 'tool_call').map((c) => ({ name: c.toolName, input: String(c.toolInput?.command ?? '').slice(0, 80),
       result: (() => { const r = all.find((x) => x.type === 'tool_result' && x.toolCallId === c.toolCallId); return r ? { isError: !!r.isError, text: String(r.text ?? r.output ?? (typeof r.content === 'string' ? r.content : JSON.stringify(r.content ?? '')) ?? '').slice(0, 120) } : null; })() }));
     const x = s.sessions.find((r) => r.id === ${JSON.stringify(sid)});
     return { status: x?.status ?? null, messageCount: msgs.length, roles: msgs.map((m) => m.role), text: text.slice(0, 400), thinkingLen: thinking.length,
       failures, errBlocks, tools, lastError: s.lastError ?? null,
       lastAssistantMeta: lastA ? pick(lastA, ['model', 'provider', 'stopReason', 'status', 'usage']) : null };`,
    { label: 'turn outcome' }
  );
}

const activeSid = (evalAsync) =>
  evalAsync(`${STORE} return s.activeSessionId;`, { label: 'active sid' });

const CLICK_NEW = `(() => {
  const b = [...document.querySelectorAll('aside button')].find((n) => n.offsetParent !== null && (n.innerText || '').trim() === '新建');
  if (!b) return null;
  b.click();
  return true;
})()`;

async function newChat(cdp, evalAsync) {
  const before = await activeSid(evalAsync);
  await cdp.evaluate(CLICK_NEW);
  for (let i = 0; i < 30; i += 1) {
    await sleep(300);
    const now = await activeSid(evalAsync);
    if (now && now !== before) return now;
  }
  const empty = await evalAsync(
    `${STORE} return (s.messages[s.activeSessionId] ?? []).length === 0;`,
    { label: 'active empty' }
  );
  if (empty) return before;
  throw new Error('new chat did not become active');
}

// ---- model menu -------------------------------------------------------------------------

const MODEL_TRIGGER_EXPR = `[...document.querySelectorAll('button[aria-label]')].find((n) => n.offsetParent !== null && /^(模型与思考强度|Model and reasoning effort)/.test(n.getAttribute('aria-label') || ''))`;
const MODEL_TRIGGER = `(() => { const b = ${MODEL_TRIGGER_EXPR}; return b ? { text: (b.innerText || '').replace(/\\s+/g, ' ').trim(), disabled: b.disabled } : null; })()`;
const OPEN_MODEL_MENU = `(() => { const b = ${MODEL_TRIGGER_EXPR}; if (!b) return false; b.click(); return true; })()`;
const MENU_DUMP = `(() => {
  const menus = [...document.querySelectorAll('[role="menu"]')].filter((n) => n.offsetParent !== null);
  return menus.map((m) => ({
    items: [...m.querySelectorAll('[role=menuitem],[role=menuitemradio],[role=menuitemcheckbox]')].filter((n) => n.offsetParent !== null)
      .map((n) => ({ role: n.getAttribute('role'), checked: n.getAttribute('aria-checked'), text: (n.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 80), title: n.getAttribute('title'), sub: n.getAttribute('aria-haspopup') })),
    text: (m.innerText || '').slice(0, 2000),
  }));
})()`;
const clickMenuItemExact = (label, role = null) => `(() => {
  const all = [...document.querySelectorAll('[role=menuitem],[role=menuitemradio],[role=menuitemcheckbox]')].filter((n) => n.offsetParent !== null ${role ? `&& n.getAttribute('role') === ${JSON.stringify(role)}` : ''});
  const m = all.find((n) => (n.innerText || '').replace(/\\s+/g, ' ').trim() === ${JSON.stringify(label)});
  if (!m) return false;
  m.click();
  return true;
})()`;

async function pressEscape(cdp) {
  const base = {
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  };
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

/** Close any open menu and return the trigger text. */
async function closeMenus(cdp) {
  for (let i = 0; i < 3; i += 1) {
    const open = await cdp.evaluate(
      `[...document.querySelectorAll('[role="menu"]')].filter((n) => n.offsetParent !== null).length`
    );
    if (!open) break;
    await pressEscape(cdp);
    await sleep(300);
  }
}

/** The open nested (group) submenu's radio rows. */
const NESTED_ITEMS = `(() => {
  const m = [...document.querySelectorAll('[role="menu"][data-nested][data-open]')].filter((n) => n.offsetParent !== null).pop();
  if (!m) return null;
  return [...m.querySelectorAll('[role=menuitemradio]')].map((n) => ({ text: (n.innerText || '').replace(/\\s+/g, ' ').trim(), checked: n.getAttribute('aria-checked') }));
})()`;
const clickNestedItem = (label) => `(() => {
  const m = [...document.querySelectorAll('[role="menu"][data-nested][data-open]')].filter((n) => n.offsetParent !== null).pop();
  if (!m) return false;
  const r = [...m.querySelectorAll('[role=menuitemradio]')].find((n) => (n.innerText || '').replace(/\\s+/g, ' ').trim() === ${JSON.stringify(label)});
  if (!r) return false;
  r.click();
  return true;
})()`;

async function openRootMenu(cdp) {
  await closeMenus(cdp);
  await cdp.evaluate(OPEN_MODEL_MENU);
  for (let i = 0; i < 20; i += 1) {
    await sleep(150);
    const n = await cdp.evaluate(
      `[...document.querySelectorAll('[role="menu"][data-open]')].filter((n) => n.offsetParent !== null && !n.hasAttribute('data-nested')).length`
    );
    if (n) break;
  }
  await sleep(300);
}

async function openGroup(cdp, group) {
  await openRootMenu(cdp);
  await cdp.evaluate(clickMenuItemExact(group, 'menuitem'));
  for (let i = 0; i < 20; i += 1) {
    await sleep(150);
    const items = await cdp.evaluate(NESTED_ITEMS);
    if (items?.length) return items;
  }
  return null;
}

/** Walk the whole model menu: top-level rows, every group's submenu, the effort rows. */
async function readModelMenu(cdp) {
  await openRootMenu(cdp);
  const top = await cdp.evaluate(MENU_DUMP);
  const groups = (top[0]?.items ?? []).filter((i) => i.sub === 'menu');
  const groupItems = {};
  for (const g of groups) groupItems[g.text] = await openGroup(cdp, g.text);
  await closeMenus(cdp);
  return { top, groupItems };
}

/** Pick a model by its menu label inside its group, then optionally an effort by its label. */
async function pickModel(cdp, { label, group, effort = null }) {
  let picked = false;
  const items = await openGroup(cdp, group);
  if (items) picked = await cdp.evaluate(clickNestedItem(label));
  await sleep(600);
  let effortPicked = null;
  if (effort) {
    await openRootMenu(cdp);
    effortPicked = await cdp.evaluate(clickMenuItemExact(effort, 'menuitemradio'));
    await sleep(600);
  }
  await closeMenus(cdp);
  return { picked, effortPicked, trigger: await cdp.evaluate(MODEL_TRIGGER) };
}

/** The effort rows the root menu offers for the current model. */
async function effortRows(cdp) {
  await openRootMenu(cdp);
  const top = await cdp.evaluate(MENU_DUMP);
  await closeMenus(cdp);
  return (top[0]?.items ?? [])
    .filter((i) => i.role === 'menuitemradio')
    .map((i) => ({ text: i.text, checked: i.checked }));
}

// ---- generic steps ------------------------------------------------------------------------

async function peek() {
  const cdp = await attach();
  const evalAsync = makeEval(cdp);
  await learnEndpointHost(evalAsync);
  const out = await cdp.evaluate(`(() => ({
    url: location.pathname,
    visibility: document.visibilityState,
    textarea: !!document.querySelector('textarea'),
    dialogs: [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].filter((d) => d.getAttribute('data-open') !== null).map((d) => (d.innerText || '').slice(0, 200)),
    buttons: [...document.querySelectorAll('button')].filter((b) => b.offsetParent !== null).map((b) => ((b.innerText || b.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ') + (b.disabled ? ' [disabled]' : '')).slice(0, 50)),
    body: document.body.innerText.slice(0, 2500),
  }))()`);
  out.modelTrigger = await cdp.evaluate(MODEL_TRIGGER);
  cdp.close();
  console.log(JSON.stringify(scrub(out), null, 2));
}

async function state() {
  const cdp = await attach();
  const evalAsync = makeEval(cdp);
  await learnEndpointHost(evalAsync);
  const out = await evalAsync(
    `${STORE}
     return { active: s.activeSessionId, lastError: s.lastError ?? null,
       sessions: s.sessions.map((x) => ({ id: x.id, status: x.status, title: x.title, messages: (s.messages[x.id] ?? []).length })) };`,
    { label: 'state' }
  );
  cdp.close();
  console.log(JSON.stringify(scrub(out), null, 2));
}

async function jsStep(expr) {
  const cdp = await attach();
  const evalAsync = makeEval(cdp);
  await learnEndpointHost(evalAsync);
  const value = await cdp.evaluate(expr);
  cdp.close();
  console.log(JSON.stringify(scrub(value), null, 2));
}

async function pageStep(body) {
  const cdp = await attach();
  const evalAsync = makeEval(cdp);
  await learnEndpointHost(evalAsync);
  const value = await evalAsync(body, { timeoutMs: 300_000 });
  cdp.close();
  console.log(JSON.stringify(scrub(value), null, 2));
}

/** UI language through the settings store's own setter (the p1-7 drivers' labels are zh). */
async function langStep(language = 'zh') {
  const cdp = await attach();
  const evalAsync = makeEval(cdp);
  const out = await evalAsync(
    `const m = await import(/* @vite-ignore */ '/stores/settings/index.ts');
     const store = m.useSettingsStore;
     if (store.getState().language !== ${JSON.stringify(language)}) store.getState().setLanguage(${JSON.stringify(language)});
     await new Promise((r) => setTimeout(r, 800));
     return store.getState().language;`,
    { label: 'language' }
  );
  cdp.close();
  console.log(out);
}

/**
 * R1: the sync state (source, counts, last failure kind — never the endpoint),
 * the renderer's catalog (ids, labels, tags, efforts, input, unavailable), and
 * the model menu as the user sees it. No model request is made.
 */
async function catalogStep(tag = 'r1-catalog') {
  const cdp = await attach();
  const evalAsync = makeEval(cdp);
  await learnEndpointHost(evalAsync);
  const out = await evalAsync(
    `const st = await window.electronAPI.piModels.getStatus();
     const cat = await window.electronAPI.chat.listPiModels();
     return {
       sync: { managed: st.managed, source: st.state?.source, modelCount: st.state?.modelCount, providerCount: st.state?.providerCount,
               syncedAt: st.state?.syncedAt ? new Date(st.state.syncedAt).toISOString() : null, hasError: !!st.state?.error,
               lastFailure: st.lastFailure ? { kind: st.lastFailure.kind, at: new Date(st.lastFailure.at).toISOString() } : null },
       catalog: { source: cat.source, stale: cat.stale, error: cat.error ?? null, fetchedAt: cat.fetchedAt ? new Date(cat.fetchedAt).toISOString() : null,
                  count: cat.models.length, unavailable: cat.unavailable ?? [],
                  models: cat.models.map((m) => ({ id: m.id, label: m.label, tags: m.tags ?? [], reasoning: m.reasoning ?? null, efforts: m.efforts ?? null,
                    input: m.input ?? null, contextWindow: m.contextWindow ?? null, levels: m.thinkingLevelMap ? Object.keys(m.thinkingLevelMap) : null })) },
     };`,
    { label: 'catalog' }
  );
  out.menu = await readModelMenu(cdp);
  out.trigger = await cdp.evaluate(MODEL_TRIGGER);
  cdp.close();
  save(tag, out);
}

/** Re-scrub every saved result (after the scrub rules grew). */
function rescrubStep() {
  const done = [];
  for (const name of fs.readdirSync(resultsDir)) {
    const file = path.join(resultsDir, name);
    if (name.endsWith('.json')) {
      const clean = scrub(JSON.parse(fs.readFileSync(file, 'utf8')));
      fs.writeFileSync(file, `${JSON.stringify(clean, null, 2)}\n`);
      done.push(name);
    } else if (name.endsWith('.jsonl')) {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      fs.writeFileSync(
        file,
        `${lines.map((l) => JSON.stringify(scrub(JSON.parse(l)))).join('\n')}\n`
      );
      done.push(name);
    }
  }
  console.log(`re-scrubbed ${done.length} files`);
}

function countStep() {
  const rows = requestsSoFar();
  console.log(JSON.stringify({ total: rows.length, budget: REQUEST_BUDGET, rows }, null, 2));
}

// ---- exports / dispatch -------------------------------------------------------------------

export const gw = {
  attach,
  makeEval,
  STORE,
  scrub,
  scrubText,
  save,
  shot,
  spendRequest,
  requestsSoFar,
  learnEndpointHost,
  typeIntoComposer,
  SEND_READY,
  CLICK_SEND,
  CLICK_STOP,
  CARD_ALLOW,
  TRANSCRIPT,
  turnStatus,
  waitTurnTimed,
  turnOutcome,
  activeSid,
  newChat,
  MODEL_TRIGGER,
  OPEN_MODEL_MENU,
  MENU_DUMP,
  clickMenuItemExact,
  closeMenus,
  readModelMenu,
  pickModel,
  effortRows,
  openGroup,
  openRootMenu,
  pressEscape,
  pumpFrames,
  PAGE_PRIVACY_TEXT,
  privacyHits,
  sleep,
  BUSY,
  SCRATCH,
  outDir,
  resultsDir,
  repoRoot,
};

const steps = {
  peek,
  state,
  js: () => jsStep(process.argv[3]),
  page: () => pageStep(process.argv[3]),
  count: countStep,
  rescrub: rescrubStep,
  lang: () => langStep(process.argv[3]),
  catalog: () => catalogStep(process.argv[3]),
  menu: async () => {
    const cdp = await attach();
    const out = { menu: await readModelMenu(cdp), trigger: await cdp.evaluate(MODEL_TRIGGER) };
    cdp.close();
    save(process.argv[3] ?? 'model-menu', out);
  },
};

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const step = process.argv[2];
  if (!steps[step]) {
    console.error(`usage: p1-5-gw.mjs ${Object.keys(steps).join('|')}`);
    process.exit(2);
  }
  await steps[step]();
  process.exit(0);
}
