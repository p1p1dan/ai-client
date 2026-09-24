/**
 * ij-lib.mjs — shared helpers for the 2026-09-24 interject / branch bar /
 * timeline / loop-guard GUI point-check.
 *
 * Built on the existing toolkit rather than from scratch:
 *   - CDP driver, ENTER_MAIN_SURFACE : scripts/h21-cdp.mjs
 *   - evalAsync (stash-on-window)    : batch-h pointcheck/tools/pc-lib.mjs
 *   - start / window wait / store reads: batch-i artifacts/pointcheck/lib.mjs
 *
 * CDP discipline (handbook §1.4): every injected snippet is a self-contained
 * IIFE; long promises are never awaited through Runtime.evaluate (evalAsync
 * parks the result on window and polls); the store is imported as
 * '/stores/chatSessions.ts', never through '/@fs/'.
 *
 * Process discipline: nothing here ever runs `pkill -f`. The app is stopped by
 * the pid recorded at start plus a /proc sweep whose needles are assembled at
 * runtime, so no needle ever sits verbatim in a live command line (a shell
 * whose own command line matches the needle would otherwise kill itself).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { makeEval } from '/home/ai/code/ai-client/docs/plantree/plans/runtime-hardening/evidence/batch-h-devbox-pointcheck-2026-09-19/pointcheck/tools/pc-lib.mjs';
import { Cdp, ENTER_MAIN_SURFACE, sleep } from '/home/ai/code/ai-client/scripts/h21-cdp.mjs';

export { sleep, ENTER_MAIN_SURFACE };

export const REPO = '/home/ai/code/ai-client';
export const TOOLS = path.dirname(fileURLToPath(import.meta.url));
/**
 * Output root. `IJ_OUT=<subdir>` (added for the T128 re-check, 2026-09-24)
 * writes shots/ and data/ under `<evidence dir>/<subdir>/` so a later round
 * reuses every step script without overwriting the first round's evidence.
 */
export const EVID = path.join(path.dirname(TOOLS), process.env.IJ_OUT ?? '');
export const SHOTS = path.join(EVID, 'shots');
export const DATA = path.join(EVID, 'data');
export const RUN = '/tmp/ij';
export const WS_REPO = '/tmp/ij/repo';
export const WS_PLAIN = '/tmp/ij/plain';
export const PORT = 9222;
export const GW_PORT = 18124;
export const GW_LOG = '/tmp/ij/gw-requests.jsonl';
export const DEV_LOG = '/tmp/ij/dev.log';
export const APP_PID_FILE = '/tmp/ij/app.pid';
export const GW_PID_FILE = '/tmp/ij/gw.pid';
/**
 * Isolated dev profile (AICLIENT_PROFILE=ijpc). The default `dev` profile's
 * vault is `enc: safeStorage`, and on 2026-09-24 the GNOME `login` keyring was
 * LOCKED (auto-login does not unlock it): Electron's main thread blocked on the
 * Secret Service unlock and CDP never answered. A throwaway profile plus
 * `--password-store=basic` never touches the keyring nor the user's real vault,
 * and its model catalog holds nothing but the fake gateway.
 */
// `IJ_PROFILE` overrides the throwaway profile name (T128 re-check used `ijrc`).
export const PROFILE = process.env.IJ_PROFILE ?? 'ijpc';
export const STATE_ROOT = `/home/ai/.pilab/jyw-ai-client-${PROFILE}`;
export const USER_DATA = `/home/ai/.config/jyw-ai-client-${PROFILE}`;
export const FAKE_MODEL = 'probe-fake/fake-sonnet';

export const stamp = () => new Date().toISOString();

export async function connect(timeoutMs = 240_000) {
  const cdp = await Cdp.attach(PORT, timeoutMs);
  cdp.collectRendererProblems();
  const evalAsync = makeEval(cdp, 'ij');
  return { cdp, evalAsync };
}

export function save(name, value) {
  fs.mkdirSync(DATA, { recursive: true });
  const file = path.join(DATA, name);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return path.relative(EVID, file);
}

export async function shot(cdp, name) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(SHOTS, name);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  return path.relative(EVID, file);
}

// ---------------------------------------------------------------- processes

export function pidsMatching(...needles) {
  const out = [];
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    let cmd;
    try {
      cmd = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8').replace(/\0/g, ' ');
    } catch {
      continue;
    }
    if (needles.every((n) => cmd.includes(n)))
      out.push({ pid: Number(entry), cmd: cmd.slice(0, 160) });
  }
  return out;
}

/** Electron processes that belong to this repo's dev app (needles built at runtime). */
export function appProcesses() {
  const electron = ['elec', 'tron'].join('');
  const repoTag = ['ai-', 'client'].join('');
  const devWrapper = ['scripts/', 'dev.js'].join('');
  const vite = ['electron', '-vite'].join('');
  const seen = new Map();
  for (const p of [
    ...pidsMatching(electron, repoTag),
    ...pidsMatching(devWrapper),
    ...pidsMatching(vite),
  ])
    seen.set(p.pid, p);
  return [...seen.values()];
}

export const workerPids = () =>
  pidsMatching(['utility-sub-type=node.mojom', '.NodeService'].join('')).map((p) => p.pid);

export function startApp({
  openPath = WS_REPO,
  envFile = '/tmp/ij/dev.env.pc',
  extraEnv = {},
  extraArgs = ['--password-store=basic'],
} = {}) {
  fs.mkdirSync(RUN, { recursive: true });
  const fd = fs.openSync(DEV_LOG, 'w');
  const env = {
    ...process.env,
    ...extraEnv,
    DISPLAY: process.env.DISPLAY ?? ':0',
    no_proxy: [process.env.no_proxy, 'localhost,127.0.0.1,::1'].filter(Boolean).join(','),
    AICLIENT_RUNTIME_TRACE_DIR: '/tmp/ij/trace',
    AICLIENT_PROFILE: PROFILE,
  };
  if (envFile) env.AICLIENT_DEV_ENV_FILE = envFile;
  const child = spawn(
    'node',
    [
      path.join(REPO, 'scripts/dev.js'),
      `--open-path=${openPath}`,
      `--remote-debugging-port=${PORT}`,
      ...extraArgs,
    ],
    { cwd: REPO, stdio: ['ignore', fd, fd], detached: true, env }
  );
  child.unref();
  fs.writeFileSync(APP_PID_FILE, String(child.pid));
  return child.pid;
}

/**
 * Ready = CDP answers with an http page target. The dev-log line
 * 「Showing main window」 is only printed on the did-finish-load / timeout
 * FALLBACK paths (MainWindow.ts:259); when `ready-to-show` wins nothing is
 * logged at all, so the line alone is not a readiness signal.
 */
export async function waitForWindow(timeoutMs = 360_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    let text = '';
    try {
      text = fs.readFileSync(DEV_LOG, 'utf8');
    } catch {}
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`, {
        signal: AbortSignal.timeout(4000),
      });
      const targets = await res.json();
      const page = targets.find((t) => t.type === 'page' && /^https?:/.test(t.url ?? ''));
      if (page)
        return {
          ok: true,
          at: stamp(),
          url: page.url,
          fallbackLine: text.includes('Showing main window'),
        };
      last = `targets=${targets.length}`;
    } catch (error) {
      last = String(error.message ?? error);
    }
    await sleep(3000);
  }
  throw new Error(`CDP never exposed a page target (last: ${last})`);
}

export async function stopApp() {
  const report = { wrapper: null, killed: [], leftovers: [] };
  try {
    const pid = Number(fs.readFileSync(APP_PID_FILE, 'utf8'));
    report.wrapper = pid;
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    report.wrapperError = String(error.message ?? error);
  }
  for (let i = 0; i < 20; i += 1) {
    await sleep(1000);
    if (appProcesses().length === 0) break;
  }
  for (const p of appProcesses()) {
    try {
      process.kill(p.pid, 'SIGKILL');
      report.killed.push(p);
    } catch {}
  }
  await sleep(1000);
  report.leftovers = appProcesses();
  return report;
}

export async function startGateway(extra = []) {
  stopGatewaySync();
  const fd = fs.openSync('/tmp/ij/gw.out', 'a');
  const child = spawn(
    'node',
    [path.join(TOOLS, 'ij-gateway.mjs'), '--port', String(GW_PORT), ...extra],
    {
      detached: true,
      stdio: ['ignore', fd, fd],
    }
  );
  child.unref();
  fs.writeFileSync(GW_PID_FILE, String(child.pid));
  for (let i = 0; i < 40; i += 1) {
    await sleep(250);
    try {
      const res = await fetch(`http://127.0.0.1:${GW_PORT}/health`);
      return { ...(await res.json()), spawned: child.pid };
    } catch {}
  }
  throw new Error('gateway did not come up');
}

export function stopGatewaySync() {
  try {
    const pid = Number(fs.readFileSync(GW_PID_FILE, 'utf8'));
    process.kill(pid, 'SIGTERM');
    return pid;
  } catch {
    return null;
  }
}

/** Every gateway log line since `fromLine` (0-based count of lines already seen). */
export function gwLines(fromLine = 0) {
  let text = '';
  try {
    text = fs.readFileSync(GW_LOG, 'utf8');
  } catch {
    return { lines: [], total: 0 };
  }
  const all = text
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  return { lines: all.slice(fromLine), total: all.length };
}
export const gwMark = () => gwLines(0).total;

// ---------------------------------------------------------------- page helpers

export const STORE_IMPORT = `const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');`;

export const sessionState = (sid) => `
  ${STORE_IMPORT}
  const s = chat.useChatSessionsStore.getState();
  const sid = ${JSON.stringify(sid)} ?? s.activeSessionId;
  const x = s.sessions.find((v) => v.id === sid);
  const msgs = s.messages[sid] ?? [];
  return { t: new Date().toISOString(), sid, status: x?.status ?? null, title: x?.title ?? null,
    workspaceId: x?.workspaceId ?? null, msgs: msgs.length, active: s.activeSessionId,
    hostBound: s.hostBoundSessionIds.includes(sid) };
`;

export const activeSid = `
  ${STORE_IMPORT}
  return chat.useChatSessionsStore.getState().activeSessionId;
`;

export const messagesOf = (sid) => `
  ${STORE_IMPORT}
  const s = chat.useChatSessionsStore.getState();
  const msgs = s.messages[${JSON.stringify(sid)}] ?? [];
  const clip = (v, n) => (v == null ? undefined : String(v).slice(0, n));
  return msgs.map((m) => ({
    id: m.id, role: m.role, stopCause: m.stopCause ?? null, stopReason: m.stopReason ?? null,
    text: clip(m.content, 200),
    blocks: (m.blocks ?? []).map((b) => ({
      type: b.type, toolName: b.toolName, toolOk: b.toolOk, status: b.status,
      text: clip(b.text, 160),
      toolInput: b.toolInput === undefined ? undefined : clip(JSON.stringify(b.toolInput), 200),
      toolOutput: b.toolOutput === undefined ? undefined : clip(JSON.stringify(b.toolOutput), 200),
    })),
  }));
`;

export const typeInto = (text) => `(() => {
  const ta = document.querySelector('textarea');
  if (!ta) throw new Error('no composer textarea');
  ta.focus();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, ${JSON.stringify(text)});
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  return { len: ta.value.length, placeholder: ta.getAttribute('placeholder') };
})()`;

export const COMPOSER = `(() => {
  const vis = (n) => n.offsetParent !== null;
  const ta = document.querySelector('textarea');
  return {
    t: new Date().toISOString(),
    value: ta ? ta.value : null,
    placeholder: ta ? ta.getAttribute('placeholder') : null,
    buttons: [...document.querySelectorAll('button[aria-label]')].filter(vis)
      .map((b) => ({ label: b.getAttribute('aria-label'), disabled: b.disabled === true }))
      .filter((b) => /发送|停止|队列|立刻|Send|Stop|Queue/.test(b.label)),
    notices: [...document.querySelectorAll('[role="status"],[role="alert"]')].filter(vis)
      .map((n) => (n.innerText || n.getAttribute('aria-label') || '').trim()).filter(Boolean).slice(0, 12),
  };
})()`;

/** Press Enter (optionally with Ctrl) in the composer through real CDP key events. */
export async function pressEnter(cdp, { ctrl = false } = {}) {
  await cdp.evaluate(
    `(() => { const ta = document.querySelector('textarea'); ta && ta.focus(); return !!ta; })()`
  );
  const base = {
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
    modifiers: ctrl ? 2 : 0,
  };
  if (ctrl)
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'Control',
      code: 'ControlLeft',
      windowsVirtualKeyCode: 17,
      modifiers: 2,
    });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    ...base,
    ...(ctrl ? {} : { text: '\r', unmodifiedText: '\r' }),
  });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  if (ctrl)
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Control',
      code: 'ControlLeft',
      windowsVirtualKeyCode: 17,
      modifiers: 0,
    });
  return stamp();
}

export async function pressKey(cdp, key, code, vk) {
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key,
    code,
    windowsVirtualKeyCode: vk,
  });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
}

/** Real mouse click at an element's centre (for Base UI controls that listen to pointer events). */
export async function mouseClickAt(cdp, x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    clickCount: 1,
  });
  await sleep(40);
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button: 'left',
    clickCount: 1,
  });
}

export const clickLabel = (label) => `(() => {
  const b = [...document.querySelectorAll('button[aria-label]')]
    .find((n) => n.getAttribute('aria-label') === ${JSON.stringify(label)} && n.offsetParent !== null);
  if (!b) return { ok: false, why: 'not found' };
  if (b.disabled) return { ok: false, why: 'disabled' };
  b.click();
  return { ok: true, at: new Date().toISOString() };
})()`;

export const TRANSCRIPT_VP = `(() => {
  const vps = [...document.querySelectorAll('[data-slot="scroll-area-viewport"]')].filter((v) => v.offsetParent !== null);
  let best = null, bw = -1;
  for (const v of vps) { const w = v.getBoundingClientRect().width; if (w > bw) { bw = w; best = v; } }
  return best;
})()`;

/** Per turn: the process group's open state and head, and a text digest. */
export const TURNS = `(() => {
  const vp = ${TRANSCRIPT_VP};
  const root = vp ?? document;
  return [...root.querySelectorAll('section[data-turn-id]')].map((sec) => {
    const details = [...sec.querySelectorAll(':scope details')].map((d) => ({
      open: d.open,
      summary: (d.querySelector(':scope > summary')?.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 120),
    }));
    const text = (sec.innerText || '').trim().replace(/\\s+/g, ' ');
    return { id: sec.getAttribute('data-turn-id'), head: text.slice(0, 160), tail: text.slice(-240), details };
  });
})()`;

/** Click the summary of the process group in the turn whose text contains `needle`. */
export const toggleTurnGroup = (needle) => `(() => {
  const vp = ${TRANSCRIPT_VP};
  const sec = [...(vp ?? document).querySelectorAll('section[data-turn-id]')]
    .find((s) => (s.innerText || '').includes(${JSON.stringify(needle)}));
  if (!sec) return { ok: false, why: 'no turn' };
  const d = sec.querySelector('details');
  if (!d) return { ok: false, why: 'no details' };
  const before = d.open;
  d.querySelector(':scope > summary').click();
  return { ok: true, before };
})()`;

export const QUEUE_STRIP = `(() => {
  const vis = (n) => n.offsetParent !== null;
  const rows = [...document.querySelectorAll('div[role="button"]')].filter(vis)
    .filter((n) => /^\\s*\\d+/.test(n.innerText || '') && n.className.includes('h-7'));
  return rows.map((r) => ({
    text: (r.innerText || '').trim().replace(/\\s+/g, ' '),
    marker: [...r.querySelectorAll('span[title]')].map((s) => ({ title: s.getAttribute('title'), text: (s.innerText || '').trim() })),
  }));
})()`;

export const FAILURE_TEXT = `(() => {
  const vp = ${TRANSCRIPT_VP};
  const text = (vp ?? document.body).innerText || '';
  const hits = text.split('\\n').filter((l) => /重复调用|已中断|失败|出错|错误/.test(l)).slice(0, 12);
  return hits;
})()`;

/**
 * Wait for a turn: first BUSY, then three consecutive idle reads (batch-h
 * `driveTurn`'s rule — "idle right after Send is a lie").
 */
export async function driveTurn(
  evalAsync,
  sid,
  { timeoutMs = 300_000, busyGraceMs = 60_000, onTick } = {}
) {
  const busy = new Set([
    'starting',
    'running',
    'stopping',
    'waiting_permission',
    'waiting_question',
  ]);
  const t0 = Date.now();
  const trail = [];
  let sawBusy = false;
  let idle = 0;
  while (Date.now() - t0 < timeoutMs) {
    const st = await evalAsync(sessionState(sid), { label: 'status' });
    if (trail.at(-1)?.status !== st.status)
      trail.push({ status: st.status, atMs: Date.now() - t0, t: st.t });
    if (busy.has(st.status ?? 'idle')) {
      sawBusy = true;
      idle = 0;
    } else if (sawBusy) {
      idle += 1;
      if (idle >= 3) return { ok: true, trail, ms: Date.now() - t0 };
    } else if (Date.now() - t0 > busyGraceMs) return { ok: false, reason: 'never busy', trail };
    if (onTick) {
      const stop = await onTick(st, Date.now() - t0);
      if (stop) return { ok: true, early: stop, trail, ms: Date.now() - t0 };
    }
    await sleep(700);
  }
  return { ok: false, reason: 'timeout', trail };
}

export async function waitStatus(evalAsync, sid, predicate, timeoutMs = 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const st = await evalAsync(sessionState(sid), { label: 'status' });
    if (predicate(st)) return { ...st, waitedMs: Date.now() - t0 };
    await sleep(300);
  }
  return null;
}

export async function waitGw(predicate, fromLine, timeoutMs = 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const { lines } = gwLines(fromLine);
    const hit = lines.find(predicate);
    if (hit) return hit;
    await sleep(300);
  }
  return null;
}

export const EXPAND_ALL = `(() => {
  const vp = ${TRANSCRIPT_VP};
  const out = [];
  for (const d of (vp ?? document).querySelectorAll('section[data-turn-id] details')) {
    if (!d.open) { d.querySelector(':scope > summary')?.click(); out.push(true); }
  }
  return out.length;
})()`;

export const scrollToBottom = `(() => { const vp = ${TRANSCRIPT_VP}; if (!vp) return null; vp.scrollTop = vp.scrollHeight; return vp.scrollTop; })()`;

// ---------------------------------------------------------------- added for step scripts

/** Click the sidebar 「新建」 and return the new active session id (may be a draft id). */
export async function newSession(cdp, evalAsync) {
  const before = await evalAsync(activeSid);
  const clicked = await cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((n) => /^(新建|New)$/.test((n.innerText || '').trim()) && n.offsetParent !== null);
    if (!b) return false;
    b.click();
    return true;
  })()`);
  await sleep(1800);
  const after = await evalAsync(activeSid);
  return { clicked, before, after };
}

/** Type + real Enter; returns the session id the store points at after the send landed. */
export async function sendText(cdp, evalAsync, text, { ctrl = false } = {}) {
  await cdp.evaluate(typeInto(text));
  await sleep(250);
  const at = await pressEnter(cdp, { ctrl });
  await sleep(600);
  const sid = await evalAsync(activeSid);
  return { at, sid };
}

/** The queued-message strip, anchored on the queue rows' own markup. */
export const QUEUE_ROWS = `(() => {
  const vis = (n) => n.offsetParent !== null;
  const rows = [...document.querySelectorAll('div[role="button"][tabindex="0"]')].filter(vis)
    .filter((n) => /\\bh-7\\b/.test(n.className) && /bg-muted/.test(n.className));
  return rows.map((r) => ({
    text: (r.innerText || '').trim().replace(/\\s+/g, ' '),
    interjectionMarker: [...r.querySelectorAll('span[title]')].some((s) => /插话|Interject/.test(s.getAttribute('title') || '')),
    markerText: [...r.querySelectorAll('span[title]')].map((s) => (s.innerText || '').trim()).join('|'),
  }));
})()`;

/** Every visible line of the transcript that looks like a tool row (verb + arg), with live text. */
export const toolRowText = (needle) => `(() => {
  const vp = ${TRANSCRIPT_VP};
  const root = vp ?? document.body;
  const cands = [...root.querySelectorAll('button, div, summary')].filter((n) => n.offsetParent !== null)
    .filter((n) => (n.innerText || '').includes(${JSON.stringify(needle)}) && (n.innerText || '').length < 260);
  // smallest element that still contains the needle AND a clock-looking token, else smallest
  cands.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
  const withClock = cands.filter((n) => /\\d+\\s*(s|秒|m|分)/.test(n.innerText || '') && /\\//.test(n.innerText || ''));
  const pick = withClock[0] ?? cands[0];
  return pick ? (pick.innerText || '').trim().replace(/\\s+/g, ' ') : null;
})()`;

export const lanesOf = (sid) => `
  const m = await import(/* @vite-ignore */ '/stores/subagentActivity.ts');
  const s = m.useSubagentActivityStore.getState();
  const sid = ${JSON.stringify(sid)};
  return Object.entries(s.lanes).filter(([, l]) => l.sessionId === sid).map(([key, l]) => ({
    key, agentType: l.agentType, description: l.description, status: l.status, rows: l.rows.length,
  }));
`;
