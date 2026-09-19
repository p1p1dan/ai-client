#!/usr/bin/env node
/**
 * m47-m05-m06.mjs — the last three MODEL point-checks, in ONE app start.
 *
 *   MODEL-47  GUI turn -> embedded TUI turn -> back to GUI; the session JSONL is
 *             read before and after and the entry chain compared (04-model.md:88).
 *   MODEL-5   rename the chat in the GUI, then look at what the pi CLI shows for
 *             the same JSONL (04-model.md:80).
 *   MODEL-6   import a real Claude Code conversation and keep talking in it
 *             (04-model.md:78).
 *
 * ## Shape
 *
 * Staged through `PC_STAGES`, like `m49-policy.mjs`, with everything learned so
 * far written to `m47-state.json` after every stage, so a stage that dies can be
 * re-run against the app that is still up (page globals survive a new CDP
 * attach — only a reload would clear them).
 *
 * `driveTurn` is the m49 one: idle right after Send is a lie, so it waits for
 * busy FIRST and then for three consecutive idle reads. Approval cards are
 * photographed BEFORE they are clicked, and answered 直接允许 (allow once, no
 * session memory) because every card this batch can raise is a repo file read.
 *
 * ## Two things that are deliberately real clicks
 *
 * `bh-tui.mjs` says the GUI/TUI segmented control cannot be driven from CDP; the
 * batch-E handbook says `Input.dispatchMouseEvent` worked 11/11. This probe
 * settles it: `pressButton` tries a real CDP mouse sequence first, records
 * whether `aria-pressed` flipped, and only then falls back to `.click()` and,
 * last, to the preload bridge. Whatever it used is recorded in the state file.
 *
 * The import list's per-session checkbox is a Base UI checkbox inside a
 * `<label>`, where it renders as a span and swallows `.click()`. It is therefore
 * only ever toggled with a real mouse event on the row.
 *
 * Never `stopDevApp()` / `pkill -f`: this batch stops Electron via /proc.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  Cdp,
  DEBUG_PORT,
  ENTER_MAIN_SURFACE,
  sleep,
  startDevApp,
} from '/home/ai/code/ai-client/scripts/h21-cdp.mjs';
import {
  ALLOW_TEXT,
  CLICK_SEND,
  EXPAND_WORK_GROUPS,
  PERMISSION_CARD,
  SEND_READY,
  enterApp,
  makeEval,
  shoot,
  typeIntoComposer,
  writeJson,
} from './pc-lib.mjs';

const BASE =
  process.env.PC_OUT_DIR ??
  '/home/ai/code/ai-client/docs/plantree/plans/runtime-hardening/evidence/batch-h-devbox-pointcheck-2026-09-19/pointcheck';
const OUT47 = path.join(BASE, 'model-47');
const OUT05 = path.join(BASE, 'model-05');
const OUT06 = path.join(BASE, 'model-06');
const STATE_FILE = path.join(BASE, 'm47-m05-m06-state.json');
const SESSIONS_DIR = '/home/ai/.pilab/jyw-ai-client-dev/pi-agent/sessions';
const SESSION_INDEX = '/home/ai/.config/jyw-ai-client-dev/session-index.json';
const PI_CLI_MARK = 'pi-coding-agent/dist/bundle/cli.js';

const STAGES = new Set((process.env.PC_STAGES ?? '').split(',').filter(Boolean));
const BUSY = ['starting', 'running', 'stopping', 'waiting_permission', 'waiting_question'];

const NEW_NAME = process.env.PC_NEW_NAME ?? '点验重命名-0919';
const IMPORT_PROJECT_PATH = process.env.PC_IMPORT_PROJECT ?? '/home/ai/code/ai-client';
const IMPORT_SESSION_ID = process.env.PC_IMPORT_SESSION ?? '4a9250fb-7947-4a9a-b4fa-a353624fab08';

const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
const saveState = () => writeJson(BASE, path.basename(STATE_FILE), state);
const now = () => Date.now();

// --- node-side file reads ----------------------------------------------------

const STRIP_ANSI = (s) =>
  s
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\u001b[()][B0]/g, '')
    .replace(/\u001b[=>]/g, '');

const OSC_OF = (s) => {
  const out = [];
  const re = /\u001b\](\d+);([^\u0007\u001b]*)(?:\u0007|\u001b\\)/g;
  let m;
  while ((m = re.exec(s))) out.push({ code: m[1], text: m[2] });
  return out;
};

/**
 * Imported conversations are somebody else's transcript. Anything this probe
 * copies into the evidence tree goes through here first, so a key-shaped string
 * in the source can only ever be reported as a hit count.
 */
const SECRET_SHAPE = /(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|gho_[A-Za-z0-9]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|Bearer\s+[A-Za-z0-9._-]{8,}|AKIA[0-9A-Z]{12,})/g;
const redact = (s) => (s == null ? s : String(s).replace(SECRET_SHAPE, '<redacted-secret-shape>'));
const secretHits = (s) => (String(s ?? '').match(SECRET_SHAPE) ?? []).length;
const safe = (value) => JSON.parse(redact(JSON.stringify(value)));

/** Every line of a session JSONL, reduced to the fields the criterion asks about. */
function chainOf(file) {
  if (!fs.existsSync(file)) return { exists: false, lines: 0, entries: [] };
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim());
  const entries = lines.map((line, i) => {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      return { index: i, unparsed: true, head: line.slice(0, 60) };
    }
    const content = o.message?.content ?? o.content;
    let text = '';
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content))
      text = content
        .map((b) => b?.text ?? b?.thinking ?? (b?.name ? `<${b.type}:${b.name}>` : `<${b?.type}>`))
        .join(' ');
    else if (o.data?.name) text = String(o.data.name);
    return {
      index: i,
      type: o.type ?? null,
      kind: o.kind ?? null,
      id: o.id ?? null,
      parentId: o.parentId ?? null,
      role: o.message?.role ?? o.role ?? null,
      customType: o.customType ?? null,
      textHead: redact(String(text).replace(/\s+/g, ' ').slice(0, 60)),
      bytes: line.length,
    };
  });
  return { exists: true, file, bytes: raw.length, lines: lines.length, headerRaw: lines[0], entries };
}

/** The 04-model.md:88 header question: does line 1 satisfy v4 AND v3 at once. */
function headerVerdict(headerRaw) {
  if (!headerRaw) return null;
  let h;
  try {
    h = JSON.parse(headerRaw);
  } catch {
    return { parsed: false, raw: headerRaw };
  }
  return {
    parsed: true,
    keys: Object.keys(h),
    v4: h.kind === 'header' && h.version === 4,
    v3: h.type === 'session' && typeof h.timestamp === 'string',
    raw: headerRaw,
  };
}

function diffChains(before, after) {
  const beforeIds = new Set(before.entries.map((e) => e.id).filter(Boolean));
  const added = after.entries.filter((e) => !e.id || !beforeIds.has(e.id));
  const idCount = new Map();
  for (const e of after.entries) if (e.id) idCount.set(e.id, (idCount.get(e.id) ?? 0) + 1);
  const textCount = new Map();
  for (const e of after.entries)
    if (e.textHead && e.textHead.length > 12)
      textCount.set(e.textHead, (textCount.get(e.textHead) ?? 0) + 1);
  // Is the after-chain still one single parent->child strand, in file order?
  //
  // `kind` cannot be part of this test: the GUI worker stamps every line with
  // `kind:'entry'` (plus `lane` / `seq`) and the pi CLI writes none of the
  // three, so a `kind === 'entry'` guard would silently skip exactly the lines
  // the TUI contributed — the ones this criterion is about.
  const chainBreaks = [];
  for (let i = 2; i < after.entries.length; i += 1) {
    const prev = after.entries[i - 1];
    const cur = after.entries[i];
    if (cur.parentId !== prev.id) chainBreaks.push({ index: i, parentId: cur.parentId, prevId: prev.id });
  }
  return {
    linesBefore: before.lines,
    linesAfter: after.lines,
    addedLines: added.length,
    added,
    duplicateIds: [...idCount].filter(([, n]) => n > 1).map(([id, n]) => ({ id, n })),
    duplicateTextHeads: [...textCount].filter(([, n]) => n > 1).map(([t, n]) => ({ textHead: t, n })),
    headerUnchanged: before.headerRaw === after.headerRaw,
    chainBreaks,
  };
}

/**
 * The embedded pi is NOT a `node …/cli.js` process on this build.
 *
 * It is the Electron binary re-executed as node (`ELECTRON_RUN_AS_NODE`), and
 * pi overwrites its own argv with the padded string `pi` within a second of
 * starting — so both halves of the obvious filter (exe is node, cmdline holds
 * `cli.js`) are wrong after the fact. What is stable is the parentage: it is a
 * direct child of the Electron main process that is not one of Chromium's
 * `--type=` helpers. `readProc` is therefore called on EVERY new child as soon
 * as it appears, which is the only window in which the real argv exists.
 */
function readProc(pid) {
  const out = { pid: Number(pid) };
  try {
    out.exe = fs.readlinkSync(`/proc/${pid}/exe`);
  } catch {
    return null;
  }
  try {
    out.argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
  } catch {
    out.argv = null;
  }
  try {
    out.comm = fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
  } catch {
    /* gone */
  }
  try {
    out.cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    /* not readable */
  }
  try {
    out.ppid = Number(fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1).split(' ')[1]);
  } catch {
    /* gone */
  }
  out.looksLikePi =
    out.comm === 'pi' ||
    (out.argv ?? []).join(' ').includes(PI_CLI_MARK) ||
    (out.argv ?? []).join(' ').trim() === 'pi';
  return out;
}

function electronMainPid() {
  for (const pid of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    let exe;
    try {
      exe = fs.readlinkSync(`/proc/${pid}/exe`);
    } catch {
      continue;
    }
    if (!exe.endsWith('/electron/dist/electron')) continue;
    let argv = '';
    try {
      argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    } catch {
      continue;
    }
    if (argv.includes('--type=')) continue;
    if (!argv.includes('remote-debugging-port')) continue;
    return Number(pid);
  }
  return null;
}

function childrenOfMain(mainPid) {
  const out = [];
  for (const pid of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    const p = readProc(pid);
    if (!p || p.ppid !== mainPid) continue;
    if ((p.argv ?? []).join(' ').includes('--type=')) continue;
    out.push(p);
  }
  return out;
}

/** Every pi-looking child alive right now. */
function scanPi() {
  const main = electronMainPid();
  if (!main) return [];
  return childrenOfMain(main).filter((p) => p.looksLikePi);
}

/**
 * Catch the spawn. Polls fast, because the argv is only real for about a
 * second; whatever it saw first is kept verbatim as `argvAtFirstSight`.
 */
async function watchForPi(ms = 25_000) {
  const main = electronMainPid();
  if (!main) return [];
  const before = new Set(childrenOfMain(main).map((p) => p.pid));
  const seen = new Map();
  const deadline = now() + ms;
  let firstAt = null;
  while (now() < deadline) {
    for (const p of childrenOfMain(main)) {
      if (before.has(p.pid)) continue;
      if (!seen.has(p.pid)) {
        seen.set(p.pid, { ...p, argvAtFirstSight: p.argv, firstSeenMs: now() });
        firstAt ??= now();
      } else {
        const rec = seen.get(p.pid);
        rec.argvLatest = p.argv;
        rec.commLatest = p.comm;
      }
    }
    if (firstAt && now() - firstAt > 5000) break;
    await sleep(120);
  }
  return [...seen.values()];
}

function lockState(sessionFile) {
  const lock = `${sessionFile}.writer.lock`;
  const dir = path.dirname(sessionFile);
  const base = path.basename(sessionFile);
  const listing = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(base))
    .map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return { file: f, size: st.size, mtime: new Date(st.mtimeMs).toISOString() };
    });
  return {
    lockPath: lock,
    lockExists: fs.existsSync(lock),
    lockBody: fs.existsSync(lock) ? fs.readFileSync(lock, 'utf8').slice(0, 300) : null,
    listing,
  };
}

function indexRowOf(sessionId) {
  try {
    const rows = JSON.parse(fs.readFileSync(SESSION_INDEX, 'utf8'));
    return rows.find((r) => r.sessionId === sessionId) ?? null;
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
}

/** What pi's own `getSessionName()` would return: last `session_info`.name. */
function simulateGetSessionName(file) {
  if (!fs.existsSync(file)) return { file, exists: false, name: null };
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
  let name = null;
  const hits = [];
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let o;
    try {
      o = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (o.type === 'session_info') {
      hits.push({ index: i, name: o.name ?? null });
      if (name === null) name = o.name ?? null;
    }
    if (o.type === 'custom' && o.customType && /name/i.test(String(o.customType)))
      hits.push({ index: i, customType: o.customType, data: o.data });
  }
  const nameMentions = lines
    .map((l, i) => ({ i, l }))
    .filter(({ l }) => /session_info|"name"/.test(l))
    .map(({ i, l }) => ({ index: i, head: l.slice(0, 200) }));
  return { file, exists: true, name, sessionInfoEntries: hits, nameMentions };
}

// --- CDP plumbing ------------------------------------------------------------

if (STAGES.has('start')) {
  const child = startDevApp();
  state.started = { pid: child.pid, at: new Date().toISOString() };
  saveState();
  console.log(`dev app started pid=${child.pid}`);
}

const cdp = await Cdp.attach(DEBUG_PORT, 240_000);
cdp.collectRendererProblems();
const evalAsync = makeEval(cdp, 'm47');

const rectOf = (expr) => `(() => {
  const node = ${expr};
  if (!node) return null;
  node.scrollIntoView({ block: 'center', inline: 'center' });
  const r = node.getBoundingClientRect();
  return {
    x: Math.round(r.left + r.width / 2),
    y: Math.round(r.top + r.height / 2),
    w: Math.round(r.width),
    h: Math.round(r.height),
    text: (node.innerText || node.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 80),
    ariaPressed: node.getAttribute ? node.getAttribute('aria-pressed') : null,
  };
})()`;

async function realMouseAt(x, y, { clickCount = 1 } = {}) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  for (let i = 1; i <= clickCount; i += 1) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      buttons: 1,
      clickCount: i,
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      buttons: 0,
      clickCount: i,
    });
    if (i < clickCount) await sleep(60);
  }
}

/** The 显示方式 group's GUI / TUI button, by its label. */
const switchButton = (label) => `[...document.querySelectorAll('div[role="group"] button')]
  .find((b) => (b.innerText || '').trim() === ${JSON.stringify(label)} && b.offsetParent !== null)`;

/**
 * Press one of the two presentation buttons and say HOW it was pressed.
 *
 * Two separate questions, deliberately not conflated:
 *   - did the BUTTON register the press (`aria-pressed` flips)? That is the one
 *     `bh-tui.mjs` and the batch-E handbook disagree about, and it answers in a
 *     few hundred ms;
 *   - did the SURFACE finish switching (`surfaceExpr`)? On this 2-core box the
 *     first xterm mount is a Vite dev-mode dynamic import and can take a minute,
 *     which is long enough to look like a failed click if the two are merged.
 */
async function pressPresentation(label, surfaceExpr, { timeoutMs = 90_000, pressMs = 10_000 } = {}) {
  const attempts = [];
  const before = await cdp.evaluate(rectOf(switchButton(label)));
  if (!before) throw new Error(`no presentation button labelled ${label}`);
  const pressedExpr = `(() => { const n = ${switchButton(label)}; return n ? n.getAttribute('aria-pressed') : null; })()`;
  const pressedBefore = await cdp.evaluate(pressedExpr);

  const waitFlip = async (via) => {
    const t0 = now();
    while (now() - t0 < pressMs) {
      const v = await cdp.evaluate(pressedExpr);
      if (v === 'true') return { via, pressed: true, flippedInMs: now() - t0 };
      await sleep(250);
    }
    return { via, pressed: false };
  };
  const waitSurface = async () => {
    const t0 = now();
    while (now() - t0 < timeoutMs) {
      const ok = await cdp.evaluate(`(() => { try { return ${surfaceExpr} } catch { return false } })()`);
      if (ok) return { surface: true, surfaceInMs: now() - t0 };
      await sleep(1000);
    }
    return { surface: false };
  };

  await realMouseAt(before.x, before.y);
  let flip = await waitFlip('Input.dispatchMouseEvent');
  attempts.push(flip);
  if (!flip.pressed) {
    await cdp.evaluate(`(() => { const n = ${switchButton(label)}; if (!n) throw new Error('gone'); n.click(); return true; })()`);
    flip = await waitFlip('element.click()');
    attempts.push(flip);
  }
  const surface = await waitSurface();
  return {
    label,
    rect: before,
    pressedBefore,
    used: flip.pressed ? flip.via : null,
    flippedInMs: flip.flippedInMs ?? null,
    ...surface,
    attempts,
  };
}

const PRESENTATION_STATE = `(() => {
  const group = [...document.querySelectorAll('div[role="group"]')]
    .find((g) => [...g.querySelectorAll('button')].some((b) => (b.innerText || '').trim() === 'TUI'));
  const buttons = group
    ? [...group.querySelectorAll('button')].map((b) => ({
        text: (b.innerText || '').trim(),
        pressed: b.getAttribute('aria-pressed'),
      }))
    : null;
  return {
    groupLabel: group ? group.getAttribute('aria-label') : null,
    buttons,
    xtermNodes: document.querySelectorAll('.xterm').length,
    xtermRows: document.querySelectorAll('.xterm-rows').length,
    hasComposer: !!document.querySelector('textarea'),
  };
})()`;

const TUI_TEXT = `(() => {
  const rows = document.querySelector('.xterm-rows');
  return rows ? (rows.innerText || '').slice(-4000) : null;
})()`;

const INSTALL_TAP = `(() => {
  if (window.__m47tap) return { already: true, terminals: Object.keys(window.__m47tap.terms) };
  window.__m47tap = { terms: {}, order: [], exits: [], indexed: [] };
  window.__m47tapOff = window.electronAPI.piTui.onData((e) => {
    if (!window.__m47tap.terms[e.terminalId]) {
      window.__m47tap.terms[e.terminalId] = '';
      window.__m47tap.order.push({ id: e.terminalId, at: Date.now() });
    }
    window.__m47tap.terms[e.terminalId] += e.data;
  });
  window.__m47tapOffExit = window.electronAPI.piTui.onExit((e) => window.__m47tap.exits.push(e));
  if (window.electronAPI.piTui.onSessionsIndexed)
    window.__m47tapOffIdx = window.electronAPI.piTui.onSessionsIndexed((e) =>
      window.__m47tap.indexed.push(e)
    );
  return { already: false };
})()`;

const tapState = `(() => ({
  order: window.__m47tap ? window.__m47tap.order : null,
  sizes: window.__m47tap
    ? Object.fromEntries(Object.entries(window.__m47tap.terms).map(([k, v]) => [k, v.length]))
    : null,
  exits: window.__m47tap ? window.__m47tap.exits : null,
  indexed: window.__m47tap ? window.__m47tap.indexed : null,
}))()`;

const tapRead = (tid) => `(() => window.__m47tap?.terms?.[${JSON.stringify(tid)}] ?? null)()`;

// --- store reads -------------------------------------------------------------

const statusOf = (sid) => `
  const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
  return chat.useChatSessionsStore.getState().sessions.find((x) => x.id === ${JSON.stringify(sid)})?.status ?? null;
`;

const sessionMeta = (sid) => `
  const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
  const s = chat.useChatSessionsStore.getState();
  const sid = ${JSON.stringify(sid)} ?? s.activeSessionId;
  const hit = s.sessions.find((x) => x.id === sid) ?? null;
  return {
    sid,
    activeSessionId: s.activeSessionId,
    title: hit?.title ?? null,
    status: hit?.status ?? null,
    runtimeIdentity: hit?.runtimeIdentity ?? null,
    workspacePath: hit?.workspacePath ?? null,
    messageCount: (s.messages[sid] ?? []).length,
  };
`;

const messagesOf = (sid) => `
  const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
  const s = chat.useChatSessionsStore.getState();
  const sid = ${JSON.stringify(sid)};
  const clip = (v, n) => (v == null ? undefined : String(v).slice(0, n));
  const msgs = s.messages[sid] ?? [];
  return {
    messageCount: msgs.length,
    messages: msgs.map((m) => ({
      id: m.id,
      role: m.role,
      blocks: (m.blocks ?? []).map((b) => ({
        type: b.type,
        toolName: b.toolName,
        textLen: b.text == null ? undefined : String(b.text).length,
        textHead: clip(b.text, 120),
      })),
    })),
    lastAssistant: (() => {
      for (let i = msgs.length - 1; i >= 0; i -= 1) {
        if (msgs[i].role !== 'assistant') continue;
        return (msgs[i].blocks ?? [])
          .filter((b) => b.type === 'text')
          .map((b) => String(b.text ?? ''))
          .join('')
          .trim();
      }
      return '';
    })(),
  };
`;

// --- turn driving ------------------------------------------------------------

let cardShots = 0;
async function answerCard(dir) {
  const card = await cdp.evaluate(PERMISSION_CARD).catch(() => null);
  if (!card) return null;
  const shot = await shoot(cdp, dir, `permission-card-${++cardShots}.png`).catch(() => null);
  const clicked = await cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')]
      .find((n) => (n.innerText || '').trim() === ${JSON.stringify(ALLOW_TEXT)} && n.offsetParent !== null);
    if (!b) return null;
    b.click();
    return (b.innerText || '').trim();
  })()`);
  return { at: new Date().toISOString(), clicked, card, screenshot: shot };
}

async function driveTurn(sid, dir, { timeoutMs = 600_000, busyGraceMs = 120_000 } = {}) {
  const t0 = now();
  const busy = new Set(BUSY);
  const cards = [];
  const trail = [];
  let sawBusy = false;
  let idleStreak = 0;
  while (now() - t0 < timeoutMs) {
    const status = await evalAsync(statusOf(sid), { label: 'status poll' });
    if (trail[trail.length - 1]?.status !== status) trail.push({ status, atMs: now() - t0 });
    if (busy.has(status ?? 'idle')) {
      sawBusy = true;
      idleStreak = 0;
    } else if (sawBusy) {
      idleStreak += 1;
      if (idleStreak >= 3) return { ok: true, sawBusy, idleAtMs: now() - t0, status, trail, cards };
    } else if (now() - t0 > busyGraceMs) {
      return { ok: false, reason: 'never went busy', sawBusy, status, trail, cards };
    }
    const answered = await answerCard(dir);
    if (answered) {
      cards.push(answered);
      console.log(`  card answered: ${String(answered.card.text).replace(/\n/g, ' | ').slice(0, 140)}`);
    }
    await sleep(1200);
  }
  return { ok: false, reason: 'timeout', sawBusy, trail, cards };
}

async function send(prompt) {
  await cdp.evaluate(typeIntoComposer(prompt));
  await cdp.waitFor(SEND_READY, { timeoutMs: 120_000, label: 'send button ready' });
  const t0 = now();
  await cdp.evaluate(CLICK_SEND);
  return t0;
}

async function guiTurn(key, sid, prompt, dir) {
  console.log(`[${key}] sending: ${prompt.slice(0, 50)}`);
  const t0 = await send(prompt);
  const drive = await driveTurn(sid, dir);
  const totalMs = now() - t0;
  console.log(`[${key}] ok=${drive.ok} in ${Math.round(totalMs / 1000)}s, cards=${drive.cards.length}`);
  await sleep(2500);
  await cdp.evaluate(EXPAND_WORK_GROUPS);
  await sleep(900);
  const msgs = safe(await evalAsync(messagesOf(sid), { label: `${key}: messages` }));
  const record = {
    key,
    prompt,
    sessionId: sid,
    turnMs: totalMs,
    drive: { ok: drive.ok, reason: drive.reason ?? null, trail: drive.trail },
    cards: drive.cards,
    messageCount: msgs.messageCount,
    reply: msgs.lastAssistant,
    blocks: msgs.messages,
  };
  (state.turns ??= {})[key] = {
    prompt,
    turnMs: totalMs,
    ok: drive.ok,
    cards: drive.cards.length,
    messageCount: msgs.messageCount,
    reply: msgs.lastAssistant.slice(0, 900),
  };
  saveState();
  return record;
}

async function newSession() {
  await cdp.evaluate(`(() => {
    const hits = [...document.querySelectorAll('button[aria-label="新建对话"]')].filter((b) => b.offsetParent !== null);
    if (hits.length === 0) throw new Error('no 新建对话 button');
    hits[hits.length - 1].click();
    return true;
  })()`);
  await sleep(2500);
  return evalAsync(sessionMeta(null), { label: 'meta after new session' });
}

// --- stages ------------------------------------------------------------------

try {
  state.probe = 'm47-m05-m06.mjs';
  state.criteria = ['MODEL-47', 'MODEL-5', 'MODEL-6'];
  (state.runs ??= []).push({ stages: [...STAGES], startedAt: new Date().toISOString() });

  if (STAGES.has('enter')) {
    state.entry = await enterApp(cdp, ENTER_MAIN_SURFACE);
    state.tapInstalled = await cdp.evaluate(INSTALL_TAP);
    console.log(`entered: ${JSON.stringify(state.entry)} tap ${JSON.stringify(state.tapInstalled)}`);
    saveState();
  }

  // ---------- MODEL-47 -------------------------------------------------------

  if (STAGES.has('s')) {
    const fresh = await newSession();
    if (!fresh.sid) throw new Error('no active session after 新建对话');
    state.S = fresh.sid;
    state.sAtCreate = fresh;
    saveState();
    console.log(`S = ${fresh.sid} (${JSON.stringify(fresh)})`);
  }

  if (STAGES.has('t1')) {
    const rec = await guiTurn(
      't1',
      state.S,
      '用一句话说明这个仓库 package.json 里 name 字段的值是什么。',
      OUT47
    );
    writeJson(OUT47, 'model-47-turn1.json', rec);
    const meta = await evalAsync(sessionMeta(state.S), { label: 'meta after t1' });
    state.sMeta = meta;
    state.sessionFile = meta.runtimeIdentity;
    saveState();
    console.log(`session file = ${state.sessionFile}`);
  }

  if (STAGES.has('before')) {
    const file = state.sessionFile;
    const chain = chainOf(file);
    fs.writeFileSync(path.join(OUT47, 'model-47-jsonl-before.txt'), fs.readFileSync(file, 'utf8'));
    writeJson(OUT47, 'model-47-chain-before.json', {
      ...chain,
      header: headerVerdict(chain.headerRaw),
    });
    state.before = {
      lines: chain.lines,
      bytes: chain.bytes,
      header: headerVerdict(chain.headerRaw),
      lock: lockState(file),
    };
    saveState();
    console.log(`before: ${chain.lines} lines, header v4=${state.before.header.v4} v3=${state.before.header.v3}`);
  }

  if (STAGES.has('tui')) {
    await cdp.evaluate(INSTALL_TAP);
    const tapBefore = await cdp.evaluate(tapState);
    const beforeState = await cdp.evaluate(PRESENTATION_STATE);
    const piBefore = scanPi();
    const press = await pressPresentation(
      'TUI',
      `document.querySelectorAll('.xterm').length > 0`,
      { timeoutMs: 40_000 }
    );
    const piProcs = await watchForPi(30_000);
    await sleep(6000);
    const afterState = await cdp.evaluate(PRESENTATION_STATE);
    const tapAfter = await cdp.evaluate(tapState);
    const newTerms = (tapAfter.order ?? []).filter(
      (t) => !(tapBefore.order ?? []).some((b) => b.id === t.id)
    );
    state.tui1 = {
      pressedVia: press.used,
      press,
      presentationBefore: beforeState,
      presentationAfter: afterState,
      piBefore,
      piProcs,
      terminals: tapAfter.order,
      newTerminals: newTerms,
      terminalSizes: tapAfter.sizes,
    };
    state.terminalId = newTerms[newTerms.length - 1]?.id ?? tapAfter.order?.at(-1)?.id ?? null;
    saveState();
    writeJson(OUT47, 'model-47-switch-to-tui.json', state.tui1);
    await shoot(cdp, OUT47, 'model-47-tui-open.png');
    console.log(
      `TUI press via ${press.used}; terminals ${JSON.stringify(newTerms)}; pi pids ${piProcs.map((p) => p.pid).join(',')}`
    );
  }

  if (STAGES.has('tuifallback')) {
    // Only reached when the real click did not open a terminal: same channel the
    // button calls, recorded as a fallback so the report cannot confuse the two.
    const tid = `m47-fallback-${Date.now()}`;
    const piBefore = scanPi();
    const watch = watchForPi(60_000);
    await cdp.evaluate(`(() => {
      window.electronAPI.piTui
        .open({ terminalId: ${JSON.stringify(tid)}, cwd: '/home/ai/code/ai-client', cols: 120, rows: 30, sessionFile: ${JSON.stringify(state.sessionFile)} })
        .then((r) => { window.__m47open = r; })
        .catch((e) => { window.__m47open = { error: String(e) }; });
      return true;
    })()`);
    await cdp.waitFor('!!window.__m47open', { timeoutMs: 60_000, label: 'piTui.open (fallback)' });
    const piProcs = await watch;
    state.tui1Fallback = {
      terminalId: tid,
      open: await cdp.evaluate('window.__m47open'),
      piBefore,
      piProcs,
      note: 'preload bridge, used only to catch the spawn-window argv',
    };
    saveState();
    await sleep(4000);
    await cdp.evaluate(
      `(() => { window.electronAPI.piTui.dispose(${JSON.stringify(tid)}); return true; })()`
    );
    await sleep(5000);
    state.tui1Fallback.piAfterDispose = scanPi();
    saveState();
    console.log(`fallback open: ${JSON.stringify(state.tui1Fallback.open)}`);
  }

  if (STAGES.has('tuisync')) {
    // The terminal only appears in the tap once pi writes its first frame, which
    // can be after the switch stage has already finished measuring.
    await cdp.evaluate(INSTALL_TAP);
    const tap = await cdp.evaluate(tapState);
    state.terminalId = tap.order?.at(-1)?.id ?? state.terminalId ?? null;
    state.tuiSync = { tap, presentation: await cdp.evaluate(PRESENTATION_STATE), piNow: scanPi() };
    saveState();
    console.log(`terminalId=${state.terminalId}; pi ${JSON.stringify(state.tuiSync.piNow)}`);
  }

  if (STAGES.has('tuiturn')) {
    const tid = state.terminalId;
    if (!tid) throw new Error('no terminal id captured');
    const before = (await cdp.evaluate(tapRead(tid))) ?? '';
    const message = process.env.PC_TUI_MSG ?? '再用一句话说明 version 字段的值。';
    await cdp.evaluate(
      `(() => { window.electronAPI.piTui.write(${JSON.stringify(tid)}, ${JSON.stringify(message)}); return true; })()`
    );
    await sleep(1500);
    await cdp.evaluate(
      `(() => { window.electronAPI.piTui.write(${JSON.stringify(tid)}, '\\r'); return true; })()`
    );
    // Wait for the pty stream to go quiet for 12s, or 4 minutes, whichever first.
    const t0 = now();
    let last = -1;
    let quietSince = null;
    while (now() - t0 < 240_000) {
      const len = await cdp.evaluate(`(() => (window.__m47tap?.terms?.[${JSON.stringify(tid)}] ?? '').length)()`);
      if (len !== last) {
        last = len;
        quietSince = now();
      } else if (quietSince && now() - quietSince > 12_000) break;
      await sleep(1500);
    }
    const raw = (await cdp.evaluate(tapRead(tid))) ?? '';
    const delta = raw.slice(before.length);
    fs.writeFileSync(path.join(OUT47, 'model-47-tui-output.txt'), STRIP_ANSI(delta));
    fs.writeFileSync(path.join(OUT47, 'model-47-tui-output-full.txt'), STRIP_ANSI(raw));
    writeJson(OUT47, 'model-47-tui-osc.json', {
      oscAtStartup: OSC_OF(before),
      oscInTurn: OSC_OF(delta),
    });
    state.tuiTurn = {
      terminalId: tid,
      message,
      bytesBefore: before.length,
      bytesAfter: raw.length,
      elapsedMs: now() - t0,
      oscAtStartup: OSC_OF(before),
      screenText: await cdp.evaluate(TUI_TEXT),
    };
    state.tuiStartupRaw = before.length;
    saveState();
    await shoot(cdp, OUT47, 'model-47-tui-turn.png');
    console.log(`TUI turn: +${raw.length - before.length} bytes in ${Math.round((now() - t0) / 1000)}s`);
    console.log(STRIP_ANSI(delta).split('\n').slice(-25).join('\n'));
  }

  if (STAGES.has('tuipoke')) {
    // Send a bare Enter — used only when the TUI turn stalled on a prompt.
    const tid = state.terminalId;
    const before = (await cdp.evaluate(tapRead(tid))) ?? '';
    await cdp.evaluate(
      `(() => { window.electronAPI.piTui.write(${JSON.stringify(tid)}, ${JSON.stringify(process.env.PC_POKE ?? '\r')}); return true; })()`
    );
    await sleep(20_000);
    const raw = (await cdp.evaluate(tapRead(tid))) ?? '';
    fs.appendFileSync(path.join(OUT47, 'model-47-tui-output.txt'), `\n--- poke ---\n${STRIP_ANSI(raw.slice(before.length))}`);
    console.log(STRIP_ANSI(raw.slice(before.length)).split('\n').slice(-30).join('\n'));
  }

  if (STAGES.has('gui')) {
    const press = await pressPresentation('GUI', `!!document.querySelector('textarea')`, {
      timeoutMs: 60_000,
    });
    await sleep(4000);
    // The timeline only settles once reloadSession has replayed the file.
    const t0 = now();
    let stable = 0;
    let last = -1;
    while (now() - t0 < 120_000) {
      const meta = await evalAsync(sessionMeta(state.S), { label: 'meta while reloading' });
      if (meta.messageCount === last) stable += 1;
      else {
        last = meta.messageCount;
        stable = 0;
      }
      if (stable >= 3 && last > 0) break;
      await sleep(1500);
    }
    state.gui1 = {
      pressedVia: press.used,
      press,
      presentationAfter: await cdp.evaluate(PRESENTATION_STATE),
      messageCountAfterReload: last,
      piAfter: scanPi(),
    };
    saveState();
    console.log(`GUI press via ${press.used}; messages ${last}; pi left ${state.gui1.piAfter.length}`);
  }

  if (STAGES.has('after')) {
    const file = state.sessionFile;
    const before = JSON.parse(fs.readFileSync(path.join(OUT47, 'model-47-chain-before.json'), 'utf8'));
    const chain = chainOf(file);
    fs.writeFileSync(path.join(OUT47, 'model-47-jsonl-after.txt'), fs.readFileSync(file, 'utf8'));
    writeJson(OUT47, 'model-47-chain-after.json', {
      ...chain,
      header: headerVerdict(chain.headerRaw),
    });
    const diff = diffChains(before, chain);
    writeJson(OUT47, 'model-47-diff.json', diff);
    await cdp.evaluate(EXPAND_WORK_GROUPS);
    await sleep(1200);
    const shot = await shoot(cdp, OUT47, 'model-47-timeline.png');
    const msgs = await evalAsync(messagesOf(state.S), { label: 'messages after reload' });
    state.after = {
      lines: chain.lines,
      header: headerVerdict(chain.headerRaw),
      diff: {
        addedLines: diff.addedLines,
        duplicateIds: diff.duplicateIds,
        duplicateTextHeads: diff.duplicateTextHeads,
        headerUnchanged: diff.headerUnchanged,
        chainBreaks: diff.chainBreaks,
      },
      lock: lockState(file),
      timelineShot: shot,
      storeMessages: msgs.messages,
    };
    saveState();
    console.log(
      `after: ${chain.lines} lines (+${diff.addedLines}), dupIds ${diff.duplicateIds.length}, chainBreaks ${diff.chainBreaks.length}`
    );
  }

  if (STAGES.has('t3')) {
    const rec = await guiTurn(
      't3',
      state.S,
      '这两个字段合起来写成 name@version 是什么？',
      OUT47
    );
    writeJson(OUT47, 'model-47-turn3.json', rec);
    const chain = chainOf(state.sessionFile);
    state.t3 = {
      lines: chain.lines,
      lock: lockState(state.sessionFile),
      header: headerVerdict(chain.headerRaw),
    };
    writeJson(OUT47, 'model-47-chain-turn3.json', { ...chain, header: state.t3.header });
    saveState();
  }

  // ---------- MODEL-5 --------------------------------------------------------

  if (STAGES.has('rename')) {
    const indexBefore = indexRowOf(state.S);
    const jsonlBefore = simulateGetSessionName(state.sessionFile);
    // Double-click the sidebar row with a REAL mouse: `onDoubleClick` is on the
    // context-menu trigger, and a synthetic click never produces one.
    const row = await cdp.evaluate(
      rectOf(`[...document.querySelectorAll('[role="button"][title]')]
        .find((n) => n.offsetParent !== null && n.getAttribute('title') === ${JSON.stringify(indexBefore?.title ?? state.sMeta?.title ?? '')})`)
    );
    let via = null;
    if (row) {
      await realMouseAt(row.x, row.y, { clickCount: 2 });
      await sleep(1200);
      const editing = await cdp.evaluate(
        `(() => !!document.querySelector('input[class*="h-6"]') || !!document.activeElement?.matches?.('input'))()`
      );
      if (editing) {
        await cdp.evaluate(`(() => {
          const input = document.activeElement?.matches?.('input')
            ? document.activeElement
            : document.querySelector('input[class*="h-6"]');
          if (!input) throw new Error('no rename input');
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(input, ${JSON.stringify(NEW_NAME)});
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          return input.value;
        })()`);
        via = 'double-click + Enter';
      }
    }
    await sleep(2500);
    let indexAfter = indexRowOf(state.S);
    if (indexAfter?.title !== NEW_NAME) {
      // Same IPC the menu item calls, recorded as a fallback.
      await evalAsync(
        `await window.electronAPI.chat.renameSession({ sessionId: ${JSON.stringify(state.S)}, title: ${JSON.stringify(NEW_NAME)} });
         const m = await import(/* @vite-ignore */ '/components/chat/sessionIndex/useSessionIndex.ts');
         if (m.refreshSessionIndexNow) await m.refreshSessionIndexNow();
         return true;`,
        { label: 'rename via preload bridge' }
      ).catch((error) => {
        state.renameBridgeError = String(error?.message ?? error);
      });
      await sleep(2500);
      indexAfter = indexRowOf(state.S);
      via = via ? `${via} (no effect) -> preload chat.renameSession` : 'preload chat.renameSession';
    }
    const jsonlAfter = simulateGetSessionName(state.sessionFile);
    state.rename = {
      via,
      newName: NEW_NAME,
      rowRect: row,
      indexTitleBefore: indexBefore?.title ?? null,
      indexTitleAfter: indexAfter?.title ?? null,
      jsonlBefore,
      jsonlAfter,
      storeTitle: (await evalAsync(sessionMeta(state.S), { label: 'meta after rename' })).title,
    };
    saveState();
    writeJson(OUT05, 'model-05-rename.json', state.rename);
    await shoot(cdp, OUT05, 'model-05-rename-in-gui.png');
    console.log(
      `rename via ${via}: index title ${JSON.stringify(indexBefore?.title)} -> ${JSON.stringify(indexAfter?.title)}; jsonl name ${JSON.stringify(jsonlAfter.name)}`
    );
  }

  if (STAGES.has('tuidispose')) {
    // MODEL-5 has to be asked of a COLD pi. Re-entering the terminal only
    // resumes the suspended process, which has held its SessionManager (and
    // therefore its session name) in memory since before the rename — a warm
    // resume could not tell "pi cannot see the new name" apart from "pi has not
    // looked again". Disposing is a probe action, not something the GUI does on
    // this path, and is recorded as such.
    const before = scanPi();
    await cdp.evaluate(
      `(() => { window.electronAPI.piTui.dispose(${JSON.stringify(state.terminalId)}); return true; })()`
    );
    await sleep(6000);
    state.tuiDispose = { terminalId: state.terminalId, piBefore: before, piAfter: scanPi() };
    saveState();
    console.log(`disposed ${state.terminalId}: pi ${before.length} -> ${state.tuiDispose.piAfter.length}`);
  }

  if (STAGES.has('tuiname')) {
    const tid = state.terminalId;
    const before = (await cdp.evaluate(tapRead(tid))) ?? '';
    await cdp.evaluate(
      `(() => { window.electronAPI.piTui.write(${JSON.stringify(tid)}, '/name'); return true; })()`
    );
    await sleep(1200);
    await cdp.evaluate(
      `(() => { window.electronAPI.piTui.write(${JSON.stringify(tid)}, '\\r'); return true; })()`
    );
    await sleep(8000);
    const raw = (await cdp.evaluate(tapRead(tid))) ?? '';
    const delta = raw.slice(before.length);
    fs.writeFileSync(path.join(OUT05, 'model-05-pi-name-command.txt'), STRIP_ANSI(delta));
    const shot = await shoot(cdp, OUT05, 'model-05-rename-in-pi.png');
    state.piNameCommand = { command: '/name', bytes: delta.length, stripped: STRIP_ANSI(delta).slice(-1500), screenshot: shot };
    saveState();
    console.log(STRIP_ANSI(delta).split('\n').slice(-30).join('\n'));
  }

  if (STAGES.has('tui2')) {
    await cdp.evaluate(INSTALL_TAP);
    const tapBefore = await cdp.evaluate(tapState);
    // The watch has to be running BEFORE the press: `pressPresentation` waits
    // for the surface, and by the time it returns pi has already rewritten its
    // own argv to the padded string `pi`.
    const watch = watchForPi(60_000);
    const press = await pressPresentation('TUI', `document.querySelectorAll('.xterm').length > 0`, {
      timeoutMs: 60_000,
    });
    const piProcs = await watch;
    await sleep(15_000);
    const tapAfter = await cdp.evaluate(tapState);
    const newTerms = (tapAfter.order ?? []).filter(
      (t) => !(tapBefore.order ?? []).some((b) => b.id === t.id)
    );
    const tid = newTerms.at(-1)?.id ?? state.terminalId;
    const raw = (await cdp.evaluate(tapRead(tid))) ?? '';
    const prevLen = tapBefore.sizes?.[tid] ?? 0;
    const delta = raw.slice(prevLen);
    fs.writeFileSync(path.join(OUT05, 'model-05-tui-startup.txt'), STRIP_ANSI(delta));
    const shot = await shoot(cdp, OUT05, 'model-05-tui-fresh-open.png');
    state.tui2 = {
      pressedVia: press.used,
      terminalId: tid,
      reusedTerminal: !newTerms.length,
      piProcs,
      oscTitles: OSC_OF(delta),
      screenText: await cdp.evaluate(TUI_TEXT),
      screenshot: shot,
      bytes: delta.length,
    };
    saveState();
    writeJson(OUT05, 'model-05-tui.json', state.tui2);
    console.log(`TUI2 via ${press.used}; OSC ${JSON.stringify(state.tui2.oscTitles)}`);
    console.log(String(state.tui2.screenText ?? '').split('\n').slice(0, 25).join('\n'));
  }

  if (STAGES.has('gui2')) {
    const press = await pressPresentation('GUI', `!!document.querySelector('textarea')`, {
      timeoutMs: 60_000,
    });
    await sleep(5000);
    state.gui2 = { pressedVia: press.used, piAfter: scanPi() };
    saveState();
    console.log(`back to GUI via ${press.used}`);
  }

  // ---------- MODEL-6 --------------------------------------------------------

  if (STAGES.has('import')) {
    await evalAsync(
      `const m = await import(/* @vite-ignore */ '/stores/settingsIntent.ts');
       m.useSettingsIntentStore.getState().requestSettings('migration');
       return true;`,
      { label: 'open settings on migration' }
    );
    await sleep(4000);
    const projects = await cdp.evaluate(`(() => {
      return [...document.querySelectorAll('p[title]')]
        .filter((p) => p.offsetParent !== null)
        .map((p) => ({ title: p.getAttribute('title'), text: (p.closest('button')?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 120) }));
    })()`);
    state.importProjects = projects;
    const open = await cdp.evaluate(
      rectOf(`[...document.querySelectorAll('p[title]')]
        .filter((p) => p.offsetParent !== null && p.getAttribute('title') === ${JSON.stringify(IMPORT_PROJECT_PATH)})
        .map((p) => p.closest('button'))[0]`)
    );
    if (!open) throw new Error(`no import project row for ${IMPORT_PROJECT_PATH}`);
    await realMouseAt(open.x, open.y);
    await cdp.waitFor(`document.body.innerText.includes('全选') || document.body.innerText.includes('Select all')`, {
      timeoutMs: 60_000,
      label: 'import session list',
    });
    await sleep(2500);
    const rowExpr = `[...document.querySelectorAll('label')]
      .find((l) => (l.innerText || '').includes(${JSON.stringify(IMPORT_SESSION_ID)}))`;
    const row = await cdp.evaluate(rectOf(rowExpr));
    if (!row) throw new Error(`no import row for ${IMPORT_SESSION_ID}`);
    await realMouseAt(row.x, row.y);
    await sleep(1200);
    const selected = await cdp.evaluate(`(() => {
      const l = ${rowExpr};
      if (!l) return null;
      const box = l.querySelector('[data-slot="checkbox"]');
      return { state: box?.getAttribute('data-checked') ?? box?.getAttribute('aria-checked') ?? null, cls: box?.className?.slice?.(0, 40) ?? null, buttonText: [...document.querySelectorAll('button')].map((b) => (b.innerText || '').trim()).filter((t) => t.includes('导入') || t.includes('Import')) };
    })()`);
    state.importSelection = { projects, row, selected };
    saveState();
    const importBtn = await cdp.evaluate(
      rectOf(`[...document.querySelectorAll('button')]
        .find((b) => !b.disabled && b.offsetParent !== null && /导入所选|Import selected/.test((b.innerText || '').trim()))`)
    );
    if (!importBtn) throw new Error(`import button not enabled; selection was ${JSON.stringify(selected)}`);
    const filesBefore = new Set(fs.readdirSync(SESSIONS_DIR));
    await realMouseAt(importBtn.x, importBtn.y);
    await cdp.waitFor(`/已导入|Imported \\d/.test(document.body.innerText)`, {
      timeoutMs: 180_000,
      label: 'import report line',
    });
    await sleep(3000);
    const filesAfter = fs.readdirSync(SESSIONS_DIR).filter((f) => !filesBefore.has(f));
    const reportLine = await cdp.evaluate(`(() => {
      const hit = [...document.querySelectorAll('p')].find((p) => /已导入|Imported \\d/.test(p.innerText || ''));
      return hit ? hit.innerText.trim() : null;
    })()`);
    state.import = {
      projectPath: IMPORT_PROJECT_PATH,
      sourceSessionId: IMPORT_SESSION_ID,
      sourceFile: `/home/ai/.claude/projects/-home-ai-code-ai-client/${IMPORT_SESSION_ID}.jsonl`,
      sourceBytes: fs.statSync(`/home/ai/.claude/projects/-home-ai-code-ai-client/${IMPORT_SESSION_ID}.jsonl`).size,
      // Reported as a count only: the source transcript is not this batch's to
      // copy, and a key-shaped string in it must not be re-typed into evidence.
      sourceSecretShapeHits: secretHits(
        fs.readFileSync(`/home/ai/.claude/projects/-home-ai-code-ai-client/${IMPORT_SESSION_ID}.jsonl`, 'utf8')
      ),
      importButton: importBtn,
      reportLine,
      newFiles: filesAfter,
      importedFile: filesAfter.find((f) => f.startsWith('import-claude-code-')) ?? null,
    };
    saveState();
    await shoot(cdp, OUT06, 'model-06-import-report.png');
    console.log(`import: ${reportLine}; new files ${JSON.stringify(filesAfter)}`);
  }

  if (STAGES.has('importopen')) {
    const file = path.join(SESSIONS_DIR, state.import.importedFile);
    const chain = chainOf(file);
    fs.writeFileSync(path.join(OUT06, 'model-06-imported-chain.txt'), JSON.stringify(chain.entries, null, 1));
    writeJson(OUT06, 'model-06-imported-head.json', {
      file,
      bytes: chain.bytes,
      lines: chain.lines,
      header: headerVerdict(chain.headerRaw),
      firstEntries: chain.entries.slice(0, 8),
      simulatedName: simulateGetSessionName(file),
    });
    // Close settings, then pick the imported chat out of the store by its file.
    await cdp.evaluate(`(() => {
      const b = [...document.querySelectorAll('button[aria-label]')]
        .find((n) => /关闭|Close/.test(n.getAttribute('aria-label') ?? '') && n.offsetParent !== null);
      if (b) b.click();
      return !!b;
    })()`);
    await sleep(1500);
    await cdp.evaluate(`(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true; })()`);
    await sleep(1500);
    const picked = await evalAsync(
      `const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
       const s = chat.useChatSessionsStore.getState();
       const hit = s.sessions.find((x) => (x.runtimeIdentity ?? '').includes(${JSON.stringify(state.import.importedFile)}));
       if (!hit) return { found: false, sessions: s.sessions.slice(0, 5).map((x) => ({ id: x.id, title: x.title })) };
       return { found: true, id: hit.id, title: hit.title, runtimeIdentity: hit.runtimeIdentity };`,
      { label: 'find imported session' }
    );
    if (!picked.found) throw new Error(`imported chat not in store: ${JSON.stringify(picked)}`);
    // The SIDEBAR row, not `selectSession`: only the row goes through
    // `useActivateSession`, which resumes a chat that has no timeline in memory
    // yet. A bare `selectSession` leaves an imported chat showing zero messages.
    const rowRect = await cdp.evaluate(
      rectOf(`[...document.querySelectorAll('[role="button"][title]')]
        .find((n) => n.offsetParent !== null && n.getAttribute('title') === ${JSON.stringify(picked.title)})`)
    );
    if (rowRect) await realMouseAt(rowRect.x, rowRect.y);
    else
      await evalAsync(
        `const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
         chat.useChatSessionsStore.getState().selectSession(${JSON.stringify(picked.id)});
         return true;`,
        { label: 'selectSession fallback' }
      );
    picked.openedVia = rowRect ? 'sidebar row (real mouse)' : 'store.selectSession';
    await sleep(3000);
    state.importedSessionId = picked.id;
    state.importedPick = picked;
    saveState();
    // The transcript is rebuilt from disk; wait for it to stop growing.
    const t0 = now();
    let stable = 0;
    let last = -1;
    while (now() - t0 < 120_000) {
      const meta = await evalAsync(sessionMeta(picked.id), { label: 'imported meta' });
      if (meta.messageCount === last) stable += 1;
      else {
        last = meta.messageCount;
        stable = 0;
      }
      if (stable >= 3 && last > 0) break;
      await sleep(1500);
    }
    await cdp.evaluate(EXPAND_WORK_GROUPS);
    await sleep(1200);
    const msgs = safe(await evalAsync(messagesOf(picked.id), { label: 'imported messages' }));
    state.importedTimeline = {
      messageCount: msgs.messageCount,
      emptyBlocks: msgs.messages.flatMap((m) =>
        (m.blocks ?? [])
          .filter((b) => b.type === 'text' && (b.textLen ?? 0) === 0)
          .map(() => ({ id: m.id, role: m.role }))
      ),
      blockTypes: msgs.messages.reduce((acc, m) => {
        for (const b of m.blocks ?? []) acc[b.type] = (acc[b.type] ?? 0) + 1;
        return acc;
      }, {}),
      messages: msgs.messages,
    };
    saveState();
    writeJson(OUT06, 'model-06-timeline.json', state.importedTimeline);
    await shoot(cdp, OUT06, 'model-06-imported-open.png');
    console.log(`imported chat ${picked.id} "${picked.title}" — ${msgs.messageCount} messages`);
  }

  if (STAGES.has('importturn')) {
    const rec = await guiTurn(
      'm06',
      state.importedSessionId,
      '上面这段对话在讨论什么问题？用两三句话概括，并指出对话里提到的一个具体文件名或命令。',
      OUT06
    );
    writeJson(OUT06, 'model-06-turn.json', rec);
    const shot = await shoot(cdp, OUT06, 'model-06-import-continue.png');
    state.m06Turn = { turnMs: rec.turnMs, reply: rec.reply, screenshot: shot };
    saveState();
    console.log(`reply:\n${rec.reply.slice(0, 1200)}`);
  }
} catch (error) {
  state.error = String(error?.stack ?? error?.message ?? error);
  console.error('probe failed:', state.error);
  process.exitCode = 1;
} finally {
  try {
    state.rendererProblems = cdp.problems.slice(0, 20);
  } catch {
    /* socket gone */
  }
  state.finishedAt = new Date().toISOString();
  console.log(`state → ${saveState()}`);
  cdp.close();
  // The CDP socket keeps the loop alive after `close()` on this Node build, so
  // every stage would otherwise hang on exit with all its work already done.
  setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
}
