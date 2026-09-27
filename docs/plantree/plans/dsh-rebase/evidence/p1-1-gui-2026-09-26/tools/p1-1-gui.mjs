#!/usr/bin/env node
/**
 * p1-1-gui.mjs — dev-GUI point-check for dsh-rebase P1-1 (engine cutover).
 *
 * Copied from p0-3-gui.mjs and extended. Steps:
 *
 *   node p1-1-gui.mjs setup           scratch dirs, fake env file, pi-agent config, fake gateway
 *   node p1-1-gui.mjs gateway-start   (re)start the fake gateway alone (no --reset)
 *   node p1-1-gui.mjs gateway-stop    stop the fake gateway by exact pid
 *   node p1-1-gui.mjs launch          `node scripts/dev.js --remote-debugging-port=9222` (detached)
 *   node p1-1-gui.mjs peek            what is on screen, screenshot into the scratch dir
 *   node p1-1-gui.mjs procs           our processes, classified
 *   node p1-1-gui.mjs run1            items 1 and 4 (new DSH session, refusals)
 *   node p1-1-gui.mjs quit            graceful quit through the app's own IPC, then wait for exit
 *   node p1-1-gui.mjs inject-legacy   add a `pi` row + a real-format pi session (app must be stopped)
 *   node p1-1-gui.mjs run2            items 2 and 3 (resume, host crash, legacy read-only)
 *   node p1-1-gui.mjs stop            stop whatever is left, by exact pid (never pkill -f)
 *
 * Isolation: the app runs with HOME=<scratch>/home, so userData, ~/.pilab (and
 * with it DSH_HOME = ~/.pilab/<profile>/dsh-home), the vault and ~/.pi are all
 * scratch copies. AICLIENT_DEV_ENV_FILE points at a scratch env file holding
 * only fake values. Every model request goes to the fake gateway (plan
 * dsh-p0-2) on 127.0.0.1. No AICLIENT_DEV_ENGINE (ignored since P1-1) and no
 * AICLIENT_DSH_HOME (the default home is part of what is checked).
 *
 * CDP mechanics come from scripts/h21-cdp.mjs and the batch-h pc-lib.mjs.
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../../../../..');
const { Cdp, ENTER_MAIN_SURFACE, sleep } = await import(path.join(repoRoot, 'scripts/h21-cdp.mjs'));
const pc = await import(
  path.join(
    repoRoot,
    'docs/plantree/plans/runtime-hardening/evidence/batch-h-devbox-pointcheck-2026-09-19/pointcheck/tools/pc-lib.mjs'
  )
);

const SCRATCH = process.env.P1_1_SCRATCH ?? '/var/tmp/aiclient-p1-1';
const PORT = 9222;
const GATEWAY_PORT = Number(process.env.P1_1_GATEWAY_PORT ?? 18741);
const outDir = path.resolve(here, '..');
const gatewayEntry = path.join(
  repoRoot,
  'docs/plantree/plans/runtime-hardening/evidence/batch-e-devbox-2026-09-17/tools/fake-gateway.mjs'
);
const hostEntry = path.join(repoRoot, 'src/dsh-host/host.ts');
const dirs = {
  home: path.join(SCRATCH, 'home'),
  workspace: path.join(SCRATCH, 'workspace'),
};
const piAgentDir = path.join(dirs.home, '.pi', 'agent');
const envFile = path.join(SCRATCH, 'p1-1.env');
const gatewayLogFile = path.join(SCRATCH, 'gateway.jsonl');
const log = (...args) => console.error('[p1-1-gui]', ...args);

/** Result JSON must not carry the local user name: /home/<name>/ becomes /home/<user>/. */
const userHome = os.userInfo().homedir;
function scrub(value) {
  const text = JSON.stringify(value, null, 2);
  return JSON.parse(text.split(`${userHome}/`).join('/home/<user>/'));
}
function writeResult(name, value) {
  const file = path.join(outDir, name);
  fs.writeFileSync(file, `${JSON.stringify(scrub(value), null, 2)}\n`);
  log(`wrote ${path.relative(repoRoot, file)}`);
}

// ---- processes ----------------------------------------------------------------

function procList() {
  const rows = [];
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cmd = fs
        .readFileSync(`/proc/${entry}/cmdline`, 'utf8')
        .split('\0')
        .filter(Boolean)
        .join(' ');
      const stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      let cwd = null;
      try {
        cwd = fs.readlinkSync(`/proc/${entry}/cwd`);
      } catch {
        // not ours to read
      }
      rows.push({ pid: Number(entry), ppid, cmd, cwd });
    } catch {
      // gone
    }
  }
  return rows;
}

function treeOf(rootPids, rows = procList()) {
  const out = new Set(rootPids);
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows) {
      if (out.has(row.ppid) && !out.has(row.pid)) {
        out.add(row.pid);
        grew = true;
      }
    }
  }
  return [...out];
}

const isDevRoot = (row) =>
  row.cmd.includes(path.join(repoRoot, 'scripts/dev.js')) &&
  row.cmd.includes(`--remote-debugging-port=${PORT}`);
const isGateway = (row) =>
  row.cmd.includes('fake-gateway.mjs') && row.cmd.includes(`--port ${GATEWAY_PORT}`);
/** A DSH host of THIS run: our worktree's entry, launched in our scratch DSH_HOME. */
const isOurHost = (row) => row.cmd.includes(hostEntry) && (row.cwd ?? '').startsWith(SCRATCH);

function ourProcesses(rows = procList()) {
  const mine = rows.filter((row) => row.pid !== process.pid);
  const roots = mine.filter((row) => isDevRoot(row) || isGateway(row)).map((row) => row.pid);
  const tree = treeOf(roots, mine);
  const strays = mine.filter(isOurHost).map((row) => row.pid);
  return [...new Set([...tree, ...strays])];
}

/** Classify the app tree: Electron main, renderers, utility (native worker), DSH hosts. */
function classify(rows = procList()) {
  const pids = new Set(ourProcesses(rows));
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const ours = [...pids].map((pid) => byPid.get(pid)).filter(Boolean);
  const electronMain = ours.filter(
    (row) => /\/electron(\s|$)/.test(row.cmd.split(' --')[0]) && !row.cmd.includes('--type=')
  );
  const nativeWorkers = ours.filter(
    (row) =>
      row.cmd.includes('--type=utility') &&
      row.cmd.includes('--utility-sub-type=node.mojom.NodeService')
  );
  const hosts = ours.filter(isOurHost);
  const hostChildren = ours.filter((row) => hosts.some((h) => h.pid === row.ppid));
  return {
    electronMain: electronMain.map(({ pid, ppid, cmd }) => ({ pid, ppid, cmd: cmd.slice(0, 300) })),
    nativeWorkers: nativeWorkers.map(({ pid, ppid, cmd }) => ({
      pid,
      ppid,
      cmd: cmd.slice(0, 300),
    })),
    dshHosts: hosts.map(({ pid, ppid, cmd, cwd }) => ({ pid, ppid, cmd, cwd })),
    dshHostChildren: hostChildren.map(({ pid, ppid, cmd }) => ({
      pid,
      ppid,
      cmd: cmd.slice(0, 200),
    })),
    all: ours.map(({ pid, ppid, cmd }) => ({ pid, ppid, cmd: cmd.slice(0, 160) })),
  };
}

function pidSet() {
  return new Map(
    procList()
      .filter((row) => ourProcesses().includes(row.pid))
      .map((row) => [row.pid, row])
  );
}

// ---- scratch layout ---------------------------------------------------------------

function findUserDataDir() {
  const config = path.join(dirs.home, '.config');
  if (!fs.existsSync(config)) return null;
  for (const name of fs.readdirSync(config)) {
    const candidate = path.join(config, name);
    if (fs.existsSync(path.join(candidate, 'session-index.json'))) return candidate;
  }
  for (const name of fs.readdirSync(config)) {
    if (name.endsWith('-dev')) return path.join(config, name);
  }
  return null;
}

function findProfileRoot() {
  const pilab = path.join(dirs.home, '.pilab');
  if (!fs.existsSync(pilab)) return null;
  const names = fs.readdirSync(pilab).filter((n) => fs.statSync(path.join(pilab, n)).isDirectory());
  const withHome = names.find((n) => fs.existsSync(path.join(pilab, n, 'dsh-home')));
  return path.join(pilab, withHome ?? names[0] ?? '');
}

function readIndex() {
  const userData = findUserDataDir();
  if (!userData) return { userData: null, rows: [] };
  const file = path.join(userData, 'session-index.json');
  if (!fs.existsSync(file)) return { userData, file, rows: [] };
  return { userData, file, rows: JSON.parse(fs.readFileSync(file, 'utf8')) };
}

/** Every file under dsh-home with its size and birth/modify times (ms since epoch). */
function listDshHome() {
  const root = findProfileRoot();
  const home = root ? path.join(root, 'dsh-home') : null;
  const files = [];
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else {
        try {
          const st = fs.statSync(full);
          files.push({
            path: path.relative(home, full),
            size: st.size,
            birthtimeMs: Math.round(st.birthtimeMs),
            mtimeMs: Math.round(st.mtimeMs),
            mode: (st.mode & 0o777).toString(8),
          });
        } catch {
          // raced
        }
      }
    }
  };
  if (home && fs.existsSync(home)) walk(home, 0);
  return { home, files };
}

function gatewayLog() {
  if (!fs.existsSync(gatewayLogFile)) return [];
  return fs
    .readFileSync(gatewayLogFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { unparsed: line.slice(0, 200) };
      }
    });
}

// ---- steps ------------------------------------------------------------------------

function writeScratchConfig() {
  for (const dir of [...Object.values(dirs), piAgentDir]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(
    path.join(dirs.workspace, 'README.md'),
    '# P1-1 scratch workspace\n\nThrowaway; the DSH engine point-check runs its tools here.\n'
  );
  // Local pi config for the "use this machine's configuration" entry: one fake model.
  fs.writeFileSync(
    path.join(piAgentDir, 'models.json'),
    `${JSON.stringify(
      {
        providers: {
          p0fake: {
            baseUrl: `http://127.0.0.1:${GATEWAY_PORT}`,
            api: 'anthropic-messages',
            models: [{ id: 'fake-1', name: 'P1-1 fake model' }],
          },
        },
      },
      null,
      2
    )}\n`
  );
  fs.writeFileSync(
    path.join(piAgentDir, 'auth.json'),
    `${JSON.stringify({ p0fake: { type: 'api_key', key: 'p1-1-fake-key' } }, null, 2)}\n`
  );
  // Fake values only. dev.js requires an ANTHROPIC token to be present.
  fs.writeFileSync(
    envFile,
    [
      '# P1-1 GUI point-check: fake values only, never a real credential.',
      `ANTHROPIC_BASE_URL=http://127.0.0.1:${GATEWAY_PORT}`,
      'ANTHROPIC_AUTH_TOKEN=p1-1-fake-token',
      'AICLIENT_MANAGED_CREDENTIALS=0',
      'AICLIENT_DEFAULT_TEST_MODEL=p0fake/fake-1',
      `PI_CODING_AGENT_DIR=${piAgentDir}`,
      `AICLIENT_DSH_GATEWAY_URL=http://127.0.0.1:${GATEWAY_PORT}`,
      'AICLIENT_DSH_GATEWAY_KEY=p1-1-fake-key',
      '',
    ].join('\n')
  );
}

function gatewayStart({ reset }) {
  const running = procList().filter(isGateway);
  if (running.length) {
    log(`gateway already running: ${running.map((r) => r.pid).join(',')}`);
    return running[0].pid;
  }
  const gatewayOut = fs.openSync(path.join(SCRATCH, 'gateway.out'), 'a');
  const gateway = spawn(
    process.execPath,
    [
      gatewayEntry,
      '--port',
      String(GATEWAY_PORT),
      '--plan',
      'dsh-p0-2',
      ...(reset ? ['--reset'] : []),
      '--state',
      path.join(SCRATCH, 'gateway.state.json'),
      '--log',
      gatewayLogFile,
      '--model-id',
      'fake-1',
    ],
    { detached: true, stdio: ['ignore', gatewayOut, gatewayOut] }
  );
  gateway.unref();
  log(`gateway pid ${gateway.pid} on ${GATEWAY_PORT}`);
  return gateway.pid;
}

async function gatewayStop() {
  const running = procList().filter(isGateway);
  for (const row of running) {
    try {
      process.kill(row.pid, 'SIGTERM');
    } catch {
      // gone
    }
  }
  for (let i = 0; i < 20 && procList().some(isGateway); i += 1) await sleep(200);
  const left = procList().filter(isGateway);
  log(`gateway stopped: ${running.map((r) => r.pid).join(',') || '(none)'}; left ${left.length}`);
  return running.map((r) => r.pid);
}

async function gatewayHealthy(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/health`);
      if (res.ok) return await res.json();
    } catch {
      // not up yet
    }
    await sleep(250);
  }
  return null;
}

async function setup() {
  writeScratchConfig();
  gatewayStart({ reset: true });
  log(`scratch ${SCRATCH}; health ${JSON.stringify(await gatewayHealthy())}`);
}

function launch() {
  const logFd = fs.openSync(path.join(SCRATCH, 'dev.log'), 'a');
  fs.writeSync(logFd, `\n===== launch ${new Date().toISOString()} =====\n`);
  const keep = [
    'PATH',
    'LANG',
    'DISPLAY',
    'WAYLAND_DISPLAY',
    'XAUTHORITY',
    'XDG_RUNTIME_DIR',
    'DBUS_SESSION_BUS_ADDRESS',
    'XDG_SESSION_TYPE',
    'USER',
    'LOGNAME',
    'SHELL',
    'TERM',
  ];
  const env = Object.fromEntries(
    keep.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]])
  );
  Object.assign(env, {
    HOME: dirs.home,
    AICLIENT_DEV_ENV_FILE: envFile,
    no_proxy: 'localhost,127.0.0.1,::1',
    NO_PROXY: 'localhost,127.0.0.1,::1',
  });
  const child = spawn(
    'node',
    [
      path.join(repoRoot, 'scripts/dev.js'),
      `--open-path=${dirs.workspace}`,
      `--remote-debugging-port=${PORT}`,
    ],
    { cwd: repoRoot, env, detached: true, stdio: ['ignore', logFd, logFd] }
  );
  child.unref();
  log(`dev.js pid ${child.pid}; log ${path.join(SCRATCH, 'dev.log')}`);
}

/** Wait until nothing of the app tree is left (the gateway is not part of it). */
async function waitAppGone(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let left = [];
  while (Date.now() < deadline) {
    const rows = procList();
    left = ourProcesses(rows).filter((pid) => {
      const row = rows.find((r) => r.pid === pid);
      return row && !isGateway(row);
    });
    if (left.length === 0) return [];
    await sleep(500);
  }
  return left;
}

async function stop({ keepGateway = false } = {}) {
  // dev.js first: its own shutdown walks and stops the Electron tree. Killing
  // an engine before Electron would make WorkerManager respawn it.
  const devRoots = procList()
    .filter(isDevRoot)
    .map((row) => row.pid);
  for (const pid of devRoots) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // gone
    }
  }
  await sleep(8000);
  const survivors = () =>
    ourProcesses().filter((pid) => {
      const row = procList().find((r) => r.pid === pid);
      return row && (!keepGateway || !isGateway(row));
    });
  let pids = survivors();
  log(`stopping ${pids.length} remaining processes: ${pids.join(',')}`);
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // gone
    }
  }
  await sleep(6000);
  pids = survivors();
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // gone
    }
  }
  await sleep(500);
  const left = survivors();
  log(`left after SIGKILL: ${JSON.stringify(left)}`);
  return left;
}

async function attach() {
  const cdp = await Cdp.attach(PORT, 300_000);
  cdp.collectRendererProblems();
  return cdp;
}

async function dismissDialogs(cdp) {
  const closed = [];
  for (let i = 0; i < 12; i += 1) {
    const open = await cdp.evaluate(`document.querySelectorAll('[role="dialog"]').length`);
    if (!open) break;
    const hit = await cdp.evaluate(`(() => {
      const labels = ['以后再说', '知道了', '我知道了', '关闭', 'Got it', 'Later', 'Close'];
      const hit = [...document.querySelectorAll('[role="dialog"] button')]
        .find((b) => (labels.includes((b.innerText || '').trim()) || labels.includes(b.getAttribute('aria-label') || '')) && b.offsetParent !== null);
      if (hit) hit.click();
      return hit ? (hit.innerText || hit.getAttribute('aria-label') || '').trim() : null;
    })()`);
    if (hit) closed.push(hit);
    await sleep(1200);
  }
  return closed;
}

async function enter(cdp) {
  // A fresh scratch profile starts in English; switch the UI to Chinese first.
  const evalAsync = pc.makeEval(cdp, 'p11lang');
  const language = await evalAsync(
    `const m = await import(/* @vite-ignore */ '/stores/settings/index.ts');
     const store = m.useSettingsStore;
     if (store.getState().language !== 'zh') store.getState().setLanguage('zh');
     return store.getState().language;`,
    { label: 'set language zh' }
  );
  await sleep(1500);
  log(`ui language ${language}`);
  const entered = await pc.enterApp(cdp, ENTER_MAIN_SURFACE);
  const dialogs = await dismissDialogs(cdp);
  return { ...entered, dialogs };
}

async function waitVisible(cdp) {
  await cdp.waitFor(
    `document.visibilityState === 'visible' && (document.getElementById('root')?.innerText.length ?? 0) > 20`,
    { timeoutMs: 60_000, label: 'window painted' }
  );
}

async function shot(cdp, name) {
  await waitVisible(cdp);
  await pc.shoot(cdp, outDir, name);
  return name;
}

/** What is on screen right now, without clicking anything. */
async function peek() {
  const cdp = await attach();
  const out = await cdp.evaluate(`(() => ({
    url: location.href,
    textarea: !!document.querySelector('textarea'),
    dialogs: document.querySelectorAll('[role="dialog"]').length,
    buttons: [...document.querySelectorAll('button')].filter((b) => b.offsetParent !== null)
      .map((b) => ((b.innerText || b.getAttribute('aria-label') || '').trim() + (b.disabled ? ' [disabled]' : '')).slice(0, 40)),
    body: document.body.innerText.slice(0, 2500),
  }))()`);
  fs.mkdirSync(path.join(SCRATCH, 'peek'), { recursive: true });
  await pc.shoot(cdp, path.join(SCRATCH, 'peek'), `peek-${Date.now()}.png`);
  cdp.close();
  console.log(JSON.stringify({ ...out, problems: cdp.problems.slice(0, 10) }, null, 2));
}

const evalStore = (cdp) => pc.makeEval(cdp, 'p11');

async function storeState(evalAsync) {
  return evalAsync(
    `const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
     const s = chat.useChatSessionsStore.getState();
     return {
       active: s.activeSessionId,
       lastError: s.lastError ?? null,
       workspaces: s.workspaces.map((w) => ({ id: w.id, path: w.path, name: w.name })),
       sessions: s.sessions.map((x) => ({ id: x.id, status: x.status, title: x.title, agent: x.agent ?? null,
         runtimeIdentity: x.runtimeIdentity ?? null, workspaceId: x.workspaceId, unbound: !!x.unbound,
         messages: (s.messages[x.id] ?? []).length })),
     };`,
    { label: 'store state' }
  );
}

/** Enter the app and report what is there, without sending anything. */
async function enterStep() {
  const cdp = await attach();
  const entered = await enter(cdp);
  const evalAsync = evalStore(cdp);
  const out = {
    entered,
    store: await storeState(evalAsync),
    buttons:
      await cdp.evaluate(`[...document.querySelectorAll('button')].filter((b) => b.offsetParent !== null)
      .map((b) => ((b.innerText || b.getAttribute('aria-label') || '').trim() + (b.disabled ? ' [disabled]' : '')).slice(0, 40))`),
    body: (await cdp.evaluate('document.body.innerText')).slice(0, 2500),
    problems: cdp.problems.slice(0, 10),
  };
  await shot(cdp, '00-entered.png');
  cdp.close();
  console.log(JSON.stringify(scrub(out), null, 2));
}

// ---- page instrumentation ------------------------------------------------------------

/** Record every RuntimeEvent and every toast the page shows, from now on. */
const INSTALL_RECORDERS = `(() => {
  if (window.__p11Installed) return 'already';
  window.__p11Installed = true;
  window.__p11Events = [];
  window.__p11Toasts = [];
  const trim = (v, n) => {
    try {
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      return s && s.length > n ? s.slice(0, n) + '…' : s;
    } catch { return String(v); }
  };
  window.electronAPI.chat.onRuntimeEvent((event) => {
    const p = event.payload;
    const summary = event.type === 'message.delta' || event.type === 'thinking.delta'
      ? { len: String(p?.text ?? p?.delta ?? '').length }
      : trim(p, 500);
    window.__p11Events.push({ t: Date.now(), type: event.type, sessionId: event.sessionId,
      requestId: event.requestId, payload: summary });
    if (window.__p11Events.length > 5000) window.__p11Events.splice(0, 1000);
  });
  const seen = new Set();
  setInterval(() => {
    for (const title of document.querySelectorAll('[data-slot="toast-title"]')) {
      let root = title;
      for (let i = 0; i < 4 && root.parentElement; i += 1) {
        root = root.parentElement;
        if (root.querySelector('[data-slot="toast-description"]')) break;
      }
      const desc = root.querySelector('[data-slot="toast-description"]')?.innerText ?? '';
      const key = (title.innerText || '') + '|' + desc;
      if (seen.has(key)) continue;
      seen.add(key);
      window.__p11Toasts.push({ t: Date.now(), title: title.innerText, description: desc });
    }
  }, 120);
  return 'installed';
})()`;

const eventsSince = (cdp, mark) =>
  cdp.evaluate(`(window.__p11Events ?? []).slice(${Number(mark)})`);
const eventMark = (cdp) => cdp.evaluate('(window.__p11Events ?? []).length');
const toastsSince = (cdp, mark) =>
  cdp.evaluate(`(window.__p11Toasts ?? []).slice(${Number(mark)})`);
const toastMark = (cdp) => cdp.evaluate('(window.__p11Toasts ?? []).length');

/** A compact per-type count plus the non-delta events, for the result files. */
function eventDigest(events) {
  const counts = {};
  for (const e of events) counts[e.type] = (counts[e.type] ?? 0) + 1;
  const key = events.filter((e) => e.type !== 'message.delta' && e.type !== 'thinking.delta');
  return { counts, events: key };
}

const COMPOSER_STATE = `(() => {
  const ta = document.querySelector('textarea');
  const send = [...document.querySelectorAll('button[aria-label]')].find((n) => n.getAttribute('aria-label') === '发送消息');
  return {
    value: ta ? ta.value : null,
    textareaDisabled: ta ? ta.disabled : null,
    sendDisabled: send ? send.disabled : null,
    placeholder: ta ? ta.getAttribute('placeholder') : null,
  };
})()`;

const VISIBLE_BUTTONS = `[...document.querySelectorAll('button')].filter((b) => b.offsetParent !== null)
  .map((b) => ((b.innerText || b.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ') + (b.disabled ? ' [disabled]' : '')).slice(0, 50))`;

// ---- turn helpers -----------------------------------------------------------------------

const BUSY = ['starting', 'running', 'stopping', 'waiting_permission', 'waiting_question'];

/**
 * The turn is over after busy (or, for a turn faster than one poll, after the
 * transcript grew past `before`), then three consecutive non-busy reads.
 */
async function waitTurn(evalAsync, sessionId, before, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let seenBusy = false;
  let idleReads = 0;
  let last = null;
  const statuses = [];
  while (Date.now() < deadline) {
    last = await evalAsync(
      `const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
       const s = chat.useChatSessionsStore.getState();
       const sid = ${JSON.stringify(sessionId)} ?? s.activeSessionId;
       const session = s.sessions.find((x) => x.id === sid);
       return { sid, status: session?.status ?? null, pendingPermissions: s.pendingPermissions.length,
                messages: (s.messages[sid] ?? []).length, lastError: s.lastError ?? null };`,
      { label: 'turn status' }
    );
    if (statuses.at(-1)?.status !== last.status)
      statuses.push({ t: Date.now(), status: last.status });
    if (BUSY.includes(last.status) || last.messages > before + 1) seenBusy = true;
    if (BUSY.includes(last.status)) {
      idleReads = 0;
    } else if (seenBusy) {
      idleReads += 1;
      if (idleReads >= 3) return { settled: true, ...last, statuses };
    }
    await sleep(500);
  }
  return { settled: false, ...last, statuses };
}

async function messageCount(evalAsync, sessionId) {
  return evalAsync(
    `const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
     const s = chat.useChatSessionsStore.getState();
     return (s.messages[${JSON.stringify(sessionId)} ?? s.activeSessionId] ?? []).length;`,
    { label: 'message count' }
  );
}

async function send(cdp, text) {
  await cdp.evaluate(pc.typeIntoComposer(text));
  await cdp.waitFor(pc.SEND_READY, { timeoutMs: 30_000, label: 'send ready' });
  const at = Date.now();
  await cdp.evaluate(pc.CLICK_SEND);
  return at;
}

const lastAssistantText = (evalAsync, sessionId) =>
  evalAsync(
    `const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
     const s = chat.useChatSessionsStore.getState();
     const msgs = s.messages[${JSON.stringify(sessionId)} ?? s.activeSessionId] ?? [];
     const last = [...msgs].reverse().find((m) => m.role === 'assistant');
     return (last?.blocks ?? []).filter((b) => b.type === 'text').map((b) => String(b.text ?? '')).join('');`,
    { label: 'assistant text' }
  );

const toolState = (evalAsync, sessionId, afterCount = 0) =>
  evalAsync(
    `const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
     const s = chat.useChatSessionsStore.getState();
     const msgs = (s.messages[${JSON.stringify(sessionId)} ?? s.activeSessionId] ?? []).slice(${Number(afterCount)});
     const blocks = msgs.flatMap((m) => m.blocks ?? []);
     const call = [...blocks].reverse().find((b) => b.type === 'tool_call' && b.toolName === 'bash');
     if (!call) return null;
     const result = blocks.find((b) => b.type === 'tool_result' && b.toolCallId === call.toolCallId);
     return { callId: call.toolCallId ?? call.id, command: String(call.toolInput?.command ?? '').slice(0, 120),
              settled: !!result, ok: result?.toolOk ?? null,
              output: result ? String(JSON.stringify(result.toolOutput ?? '')).slice(0, 200) : null };`,
    { label: 'tool state' }
  );

/** The sidebar row for a session, clicked like a user would (resumes on activation). */
async function openSession(cdp, evalAsync, sessionId) {
  return pc.switchTo(cdp, evalAsync, sessionId);
}

/** Host processes whose open descriptors name this session's DSH directory. */
function hostsHoldingSession(sessionId) {
  const needle = `aiclient-${sessionId}`;
  const out = [];
  for (const row of procList().filter(isOurHost)) {
    let hits = 0;
    try {
      for (const fd of fs.readdirSync(`/proc/${row.pid}/fd`)) {
        try {
          if (fs.readlinkSync(`/proc/${row.pid}/fd/${fd}`).includes(needle)) hits += 1;
        } catch {
          // closed meanwhile
        }
      }
    } catch {
      // gone
    }
    out.push({ pid: row.pid, ppid: row.ppid, fdHits: hits });
  }
  return out;
}

function sessionFiles(sessionId) {
  const root = findProfileRoot();
  if (!root) return { profileRoot: null };
  const home = path.join(root, 'dsh-home');
  const stub = path.join(home, 'aiclient-sessions', `aiclient-${sessionId}.dsh.json`);
  let logFile = null;
  const sessionsDir = path.join(home, 'sessions');
  if (fs.existsSync(sessionsDir)) {
    for (const cwdDir of fs.readdirSync(sessionsDir)) {
      const candidate = path.join(
        sessionsDir,
        cwdDir,
        `aiclient-${sessionId}`,
        'session.v4.jsonl.zstd'
      );
      if (fs.existsSync(candidate)) logFile = candidate;
    }
  }
  const statOf = (file) => {
    if (!file || !fs.existsSync(file)) return null;
    const st = fs.statSync(file);
    return {
      file,
      size: st.size,
      birthtimeMs: Math.round(st.birthtimeMs),
      mtimeMs: Math.round(st.mtimeMs),
    };
  };
  return { profileRoot: root, home, stub: statOf(stub), log: statOf(logFile) };
}

// ---- item 1: a new chat session runs on DSH ------------------------------------------------

async function item1() {
  const cdp = await attach();
  const results = { step: 'item1', startedAt: new Date().toISOString() };
  results.entered = await enter(cdp);
  results.recorders = await cdp.evaluate(INSTALL_RECORDERS);
  const evalAsync = evalStore(cdp);
  const before = await storeState(evalAsync);
  const sid = before.active;
  results.sessionId = sid;
  results.before = {
    store: before,
    procs: classify(),
    indexRows: readIndex().rows,
    dshHome: listDshHome(),
    gatewayRequests: gatewayLog().length,
  };
  const pidsBefore = new Set(ourProcesses());

  // Watch the disk and /proc from before the click until the first text is painted.
  const firstSeen = {};
  const watch = setInterval(() => {
    const now = Date.now();
    try {
      const files = sessionFiles(sid);
      if (files.log && !firstSeen.log) firstSeen.log = now;
      if (files.stub && !firstSeen.stub) firstSeen.stub = now;
      if (!firstSeen.host) {
        const host = procList().find((row) => isOurHost(row) && !pidsBefore.has(row.pid));
        if (host) firstSeen.host = now;
      }
    } catch {
      // raced with a write
    }
  }, 50);

  const em = await eventMark(cdp);
  const sendAt = await send(cdp, 'P0-STREAM: 请用流式方式回复一段文字。');
  let firstTextAt = null;
  const firstTextDeadline = Date.now() + 90_000;
  while (Date.now() < firstTextDeadline) {
    if ((await lastAssistantText(evalAsync, sid)).length > 0) {
      firstTextAt = Date.now();
      break;
    }
    await sleep(80);
  }
  const filesAtFirstText = sessionFiles(sid);
  const samples = [];
  for (let i = 0; i < 12; i += 1) {
    samples.push((await lastAssistantText(evalAsync, sid)).length);
    if (i === 4) await shot(cdp, '01-stream-mid.png');
    await sleep(200);
  }
  clearInterval(watch);
  const turn = await waitTurn(
    evalAsync,
    sid,
    before.sessions.find((s) => s.id === sid)?.messages ?? 0
  );
  await shot(cdp, '01-stream-done.png');
  const events = await eventsSince(cdp, em);

  const procsAfter = classify();
  const rows = procList();
  const newPids = ourProcesses(rows)
    .filter((pid) => !pidsBefore.has(pid))
    .map((pid) => rows.find((r) => r.pid === pid))
    .filter(Boolean)
    .map(({ pid, ppid, cmd, cwd }) => ({ pid, ppid, cmd: cmd.slice(0, 300), cwd }));
  const index = readIndex();
  const row = index.rows.find((r) => r.sessionId === sid) ?? null;
  const files = sessionFiles(sid);
  const stubContent = files.stub ? JSON.parse(fs.readFileSync(files.stub.file, 'utf8')) : null;
  const expectedIdentity = files.profileRoot
    ? path.join(files.profileRoot, 'dsh-home', 'aiclient-sessions', `aiclient-${sid}.dsh.json`)
    : null;
  const gw = gatewayLog();
  const firstRequest = gw.slice(results.before.gatewayRequests)[0] ?? null;
  results.stream = {
    sendAt,
    firstSeen,
    firstTextAt,
    firstRequestAt: firstRequest?.time ? Date.parse(firstRequest.time) : null,
    firstRequest,
    filesAtFirstText,
    order: {
      logBeforeFirstText: !!(firstSeen.log && firstTextAt && firstSeen.log < firstTextAt),
      stubBeforeFirstText: !!(firstSeen.stub && firstTextAt && firstSeen.stub < firstTextAt),
      logBirthBeforeStubBirth:
        files.log && files.stub ? files.log.birthtimeMs <= files.stub.birthtimeMs : null,
      logBirthBeforeFirstText:
        files.log && firstTextAt ? files.log.birthtimeMs < firstTextAt : null,
    },
    samples,
    turn,
    reply: await lastAssistantText(evalAsync, sid),
    events: eventDigest(events),
  };
  results.process = {
    after: procsAfter,
    newPids,
    dshHostSpawnedByElectronMain: procsAfter.dshHosts.map((h) => ({
      pid: h.pid,
      ppid: h.ppid,
      parentIsElectronMain: procsAfter.electronMain.some((m) => m.pid === h.ppid),
      cmd: h.cmd,
      cwd: h.cwd,
    })),
    nativeWorkersAfter: procsAfter.nativeWorkers,
  };
  results.index = {
    file: index.file,
    row,
    expectedIdentity,
    identityMatches: row?.runtimeIdentity === expectedIdentity,
    agentIsDsh: row?.agent === 'dsh',
    stub: files.stub,
    stubContent,
    log: files.log,
  };

  // P0-TOOL: the tool row goes from running to settled.
  const beforeTool = await messageCount(evalAsync, sid);
  const emTool = await eventMark(cdp);
  await send(cdp, 'P0-TOOL: 列一下工作区（点验工具行）。');
  const toolSamples = [];
  let runningSeen = null;
  let runningShot = null;
  const toolDeadline = Date.now() + 60_000;
  while (Date.now() < toolDeadline) {
    const state = await toolState(evalAsync, sid, beforeTool);
    if (state) {
      if (toolSamples.at(-1)?.settled !== state.settled)
        toolSamples.push({ t: Date.now(), ...state });
      if (!state.settled && !runningSeen) {
        runningSeen = { t: Date.now(), ...state };
        const domRunning = await cdp.evaluate(`document.body.innerText.includes('运行中')`);
        await pc.shoot(cdp, outDir, '02-tool-running.png');
        runningShot = {
          domShowedRunning: domRunning,
          afterShot: await toolState(evalAsync, sid, beforeTool),
        };
      }
      if (state.settled) break;
    }
    await sleep(40);
  }
  const toolTurn = await waitTurn(evalAsync, sid, beforeTool);
  const expanded = await cdp.evaluate(pc.EXPAND_WORK_GROUPS);
  await sleep(800);
  await shot(cdp, '02-tool-settled.png');
  results.tool = {
    samples: toolSamples,
    runningSeen,
    runningShot,
    turn: toolTurn,
    settled: await toolState(evalAsync, sid, beforeTool),
    expanded,
    reply: await lastAssistantText(evalAsync, sid),
    events: eventDigest(await eventsSince(cdp, emTool)),
  };
  results.procsAfterTool = classify();
  results.store = await evalAsync(pc.storeSummary(sid), { label: 'store summary' });
  results.gatewayAfter = gatewayLog().slice(results.before.gatewayRequests);
  results.problems = cdp.problems.slice(0, 40);
  writeResult('p1-1-item1-result.json', results);
  cdp.close();
  console.log(
    JSON.stringify(
      scrub({
        sessionId: sid,
        stream: { ...results.stream, events: results.stream.events.counts },
        process: results.process,
        index: results.index,
        tool: { ...results.tool, events: results.tool.events.counts },
      }),
      null,
      2
    )
  );
}

// ---- item 4: the paths P1-1 refuses on purpose ------------------------------------------

const DIALOG_SNAPSHOT = `(() => {
  const d = document.querySelector('[role="dialog"]');
  if (!d) return null;
  const forks = [...d.querySelectorAll('button[aria-label="从这里分叉"]')];
  return {
    text: d.innerText.slice(0, 1500),
    forkButtons: forks.length,
    forkEnabled: forks.filter((b) => !b.disabled).length,
    buttons: [...d.querySelectorAll('button')].map((b) => ((b.innerText || b.getAttribute('aria-label') || '').trim() + (b.disabled ? ' [disabled]' : '')).slice(0, 40)),
  };
})()`;

const DRAFTS = `[...document.querySelectorAll('button[aria-label^="Remove "]')].map((b) => b.getAttribute('aria-label'))`;

const PRESENTATION = `(() => {
  const pick = (label) => [...document.querySelectorAll('button')].find((b) => (b.innerText || '').trim() === label && b.offsetParent !== null);
  const gui = pick('GUI');
  const tui = pick('TUI');
  return { gui: gui?.getAttribute('aria-pressed') ?? null, tui: tui?.getAttribute('aria-pressed') ?? null,
           xterm: !!document.querySelector('.xterm') };
})()`;

/** The card that holds the visible 「继续」 button, if any. */
const FAILURE_CARD = `(() => {
  const b = [...document.querySelectorAll('button')].find((n) => (n.innerText || '').trim() === '继续' && n.offsetParent !== null);
  if (!b) return null;
  let card = b;
  for (let i = 0; i < 6 && card.parentElement; i += 1) {
    card = card.parentElement;
    if ((card.innerText || '').length > 20) break;
  }
  return { text: (card.innerText || '').slice(0, 800), continueDisabled: b.disabled, continueTitle: b.getAttribute('title') };
})()`;

async function observe(cdp, evalAsync, sid, ms) {
  const deadline = Date.now() + ms;
  const trace = [];
  while (Date.now() < deadline) {
    const s = await evalAsync(
      `const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
       const st = chat.useChatSessionsStore.getState();
       const session = st.sessions.find((x) => x.id === ${JSON.stringify(sid)});
       return { status: session?.status ?? null, lastError: st.lastError ?? null,
                messages: (st.messages[${JSON.stringify(sid)}] ?? []).length };`,
      { label: 'observe' }
    );
    const c = await cdp.evaluate(COMPOSER_STATE);
    const drafts = await cdp.evaluate(DRAFTS);
    const row = {
      status: s.status,
      lastError: s.lastError,
      messages: s.messages,
      composer: c.value,
      drafts,
    };
    const prev = trace.at(-1);
    const { t: _t, ...prevRow } = prev ?? {};
    if (!prev || JSON.stringify(prevRow) !== JSON.stringify(row)) {
      trace.push({ t: Date.now(), ...row });
    }
    await sleep(300);
  }
  return trace;
}

async function item4() {
  const cdp = await attach();
  const results = { step: 'item4', startedAt: new Date().toISOString() };
  results.recorders = await cdp.evaluate(INSTALL_RECORDERS);
  const evalAsync = evalStore(cdp);
  const st = await storeState(evalAsync);
  const sid = st.active;
  const session = st.sessions.find((s) => s.id === sid);
  const stubPath = session?.runtimeIdentity ?? null;
  results.session = session;

  // 4-pre: a slow tool row, so "running" is on screen long enough to be seen.
  {
    const before = await messageCount(evalAsync, sid);
    await send(cdp, 'P0-SLOWTOOL: 跑一个慢命令（点验运行中的工具行）。');
    let running = null;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      running = await toolState(evalAsync, sid, before);
      if (running && !running.settled) break;
      await sleep(100);
    }
    await sleep(1500);
    const domRunning = await cdp.evaluate(`document.body.innerText.includes('运行中')`);
    await shot(cdp, '03-slowtool-running.png');
    const turn = await waitTurn(evalAsync, sid, before);
    const expanded = await cdp.evaluate(pc.EXPAND_WORK_GROUPS);
    await sleep(800);
    await shot(cdp, '03-slowtool-settled.png');
    results.slowTool = {
      running,
      domRunning,
      turn,
      settled: await toolState(evalAsync, sid, before),
      expanded,
    };
    log(
      `slow tool: running=${!!running} domRunning=${domRunning} settled=${results.slowTool.settled?.settled}`
    );
  }

  // 4a: fork. The branch dialog, then the API itself.
  {
    const opened = await cdp.evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find((n) => (n.innerText || '').trim() === '会话分支' && n.offsetParent !== null);
      if (!b) return { ok: false, reason: 'no button' };
      if (b.disabled) return { ok: false, reason: 'disabled' };
      b.click();
      return { ok: true };
    })()`);
    await sleep(3000);
    const dialog = await cdp.evaluate(DIALOG_SNAPSHOT);
    await shot(cdp, '04-fork-branch-dialog.png');
    let uiFork = null;
    if (dialog?.forkEnabled > 0) {
      await cdp.evaluate(`(() => {
        const b = [...document.querySelectorAll('[role="dialog"] button[aria-label="从这里分叉"]')].find((n) => !n.disabled);
        b.click();
        return true;
      })()`);
      await sleep(3000);
      uiFork = await cdp.evaluate(DIALOG_SNAPSHOT);
      await shot(cdp, '04-fork-ui-refused.png');
    }
    const tree = await evalAsync(
      `try {
         const r = await window.electronAPI.chat.getSessionTree({ sessionId: ${JSON.stringify(sid)}, requestSequence: 90001 });
         return { ok: true, totalNodes: r.snapshot?.totalNodes, returnedNodes: r.snapshot?.returnedNodes, sessionKey: r.sessionKey };
       } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }`,
      { label: 'getSessionTree' }
    );
    const api = await evalAsync(
      `try {
         const r = await window.electronAPI.chat.forkSession({ sessionId: ${JSON.stringify(sid)}, entryId: 'p1-1-probe-entry' });
         return { ok: true, result: r };
       } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }`,
      { label: 'forkSession' }
    );
    await cdp.evaluate(`(() => {
      const b = [...document.querySelectorAll('[role="dialog"] button')].find((n) => (n.innerText || '').trim() === '关闭');
      if (b) b.click();
      return !!b;
    })()`);
    await sleep(800);
    results.fork = { opened, dialog, uiFork, tree, api };
    log(`fork: dialog forkButtons=${dialog?.forkButtons} api=${JSON.stringify(api).slice(0, 200)}`);
  }

  // 4b: an image pasted into the composer, then sent.
  {
    const gwBefore = gatewayLog().length;
    const tm = await toastMark(cdp);
    const em = await eventMark(cdp);
    const pidsBefore = new Set(ourProcesses());
    const paste = await evalAsync(
      `const c = document.createElement('canvas');
       c.width = 64; c.height = 48;
       const g = c.getContext('2d');
       g.fillStyle = '#c0392b'; g.fillRect(0, 0, 64, 48);
       g.fillStyle = '#ffffff'; g.fillText('P1-1', 12, 28);
       const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
       const file = new File([blob], 'p1-1-probe.png', { type: 'image/png' });
       const dt = new DataTransfer();
       dt.items.add(file);
       const ta = document.querySelector('textarea');
       ta.focus();
       const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
       const dispatched = ta.dispatchEvent(ev);
       return { bytes: blob.size, dispatched, defaultPrevented: ev.defaultPrevented };`,
      { label: 'paste image' }
    );
    let drafts = [];
    for (let i = 0; i < 30 && drafts.length === 0; i += 1) {
      await sleep(200);
      drafts = await cdp.evaluate(DRAFTS);
    }
    await shot(cdp, '05-attachment-draft.png');
    const text = 'P1-1 带图发送点验：这条消息带一张图片，预期被明确拒绝。';
    await cdp.evaluate(pc.typeIntoComposer(text));
    await sleep(400);
    const sendState = await cdp.evaluate(COMPOSER_STATE);
    let clicked = null;
    try {
      await cdp.waitFor(pc.SEND_READY, { timeoutMs: 10_000, label: 'send ready (attachment)' });
      await cdp.evaluate(pc.CLICK_SEND);
      clicked = Date.now();
    } catch (error) {
      clicked = `not sent: ${error.message}`;
    }
    const trace = await observe(cdp, evalAsync, sid, 12_000);
    await shot(cdp, '05-attachment-refused.png');
    const rows = procList();
    results.attachment = {
      paste,
      draftsAfterPaste: drafts,
      composerBeforeSend: sendState,
      clicked,
      trace,
      toasts: await toastsSince(cdp, tm),
      events: eventDigest(await eventsSince(cdp, em)),
      composerAfter: await cdp.evaluate(COMPOSER_STATE),
      draftsAfter: await cdp.evaluate(DRAFTS),
      gatewayRequestsDuringAttempt: gatewayLog().length - gwBefore,
      newProcesses: ourProcesses(rows)
        .filter((pid) => !pidsBefore.has(pid))
        .map((pid) => rows.find((r) => r.pid === pid)?.cmd.slice(0, 160)),
      bodyHasUnsupported: await cdp.evaluate(
        `(() => { const t = document.body.innerText; return { attachments: /attachment|附件/i.test(t), unsupported: /not bridged|不支持|WORKER_DSH_UNSUPPORTED/.test(t) }; })()`
      ),
    };
    log(
      `attachment: drafts=${drafts.length} toasts=${JSON.stringify(results.attachment.toasts).slice(0, 300)}`
    );
    // Leave the composer clean for the next case.
    await cdp.evaluate(
      `(() => { for (const b of document.querySelectorAll('button[aria-label^="Remove "]')) b.click(); return true; })()`
    );
    await cdp.evaluate(pc.typeIntoComposer(''));
    await sleep(600);
  }

  // 4c: a DSH chat cannot be handed to the pi TUI.
  {
    const support = await evalAsync(
      `return await window.electronAPI.piTui.sessionSupport(${JSON.stringify(stubPath)});`,
      { label: 'piTui.sessionSupport' }
    );
    const tm = await toastMark(cdp);
    const pidsBefore = new Set(ourProcesses());
    const before = await cdp.evaluate(PRESENTATION);
    const clicked = await cdp.evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find((n) => (n.innerText || '').trim() === 'TUI' && n.offsetParent !== null);
      if (!b) return false;
      b.click();
      return true;
    })()`);
    await sleep(2500);
    const after = await cdp.evaluate(PRESENTATION);
    await shot(cdp, '06-tui-refused.png');
    const rows = procList();
    results.tui = {
      stubPath,
      support,
      clicked,
      before,
      after,
      toasts: await toastsSince(cdp, tm),
      newProcesses: ourProcesses(rows)
        .filter((pid) => !pidsBefore.has(pid))
        .map((pid) => rows.find((r) => r.pid === pid)?.cmd.slice(0, 160)),
      stubAfter:
        stubPath && fs.existsSync(stubPath) ? JSON.parse(fs.readFileSync(stubPath, 'utf8')) : null,
    };
    log(`tui: support=${JSON.stringify(support)} toasts=${JSON.stringify(results.tui.toasts)}`);
  }

  // 4d: a failed turn (gateway down), then the card's 「继续」.
  {
    const stopped = await gatewayStop();
    const before = await messageCount(evalAsync, sid);
    const em = await eventMark(cdp);
    const tm = await toastMark(cdp);
    const prompt = 'P0-STREAM: 网关已停止，这一轮预期失败。';
    await send(cdp, prompt);
    const turn = await waitTurn(evalAsync, sid, before, 120_000);
    await sleep(1500);
    const failed = {
      turn,
      card: await cdp.evaluate(FAILURE_CARD),
      composer: await cdp.evaluate(COMPOSER_STATE),
      store: await storeState(evalAsync),
      events: eventDigest(await eventsSince(cdp, em)),
    };
    await shot(cdp, '07-failed-card.png');
    gatewayStart({ reset: false });
    const health = await gatewayHealthy();
    const gwCount = gatewayLog().length;
    const em2 = await eventMark(cdp);
    const tm2 = await toastMark(cdp);
    const clicked = await cdp.evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find((n) => (n.innerText || '').trim() === '继续' && n.offsetParent !== null);
      if (!b) return { ok: false, reason: 'no 继续 button' };
      if (b.disabled) return { ok: false, reason: 'disabled', title: b.getAttribute('title') };
      b.click();
      return { ok: true };
    })()`);
    const trace = await observe(cdp, evalAsync, sid, 6000);
    await shot(cdp, '07-continue-retry-unavailable.png');
    const afterContinue = {
      clicked,
      trace,
      toasts: await toastsSince(cdp, tm2),
      composer: await cdp.evaluate(COMPOSER_STATE),
      card: await cdp.evaluate(FAILURE_CARD),
      events: eventDigest(await eventsSince(cdp, em2)),
      gatewayRequestsDuringRetry: gatewayLog().length - gwCount,
    };
    // The session must still take a normal turn.
    const beforeOk = await messageCount(evalAsync, sid);
    await send(cdp, 'P0-STREAM: 失败之后再来一轮（确认会话仍可用）。');
    const okTurn = await waitTurn(evalAsync, sid, beforeOk);
    await sleep(800);
    await shot(cdp, '07-after-failure-turn.png');
    results.failure = {
      gatewayStopped: stopped,
      prompt,
      failed,
      failureToasts: await toastsSince(cdp, tm),
      gatewayRestarted: health,
      afterContinue,
      nextTurn: { turn: okTurn, reply: await lastAssistantText(evalAsync, sid) },
    };
    log(
      `failure: status=${turn.status} card=${!!failed.card} continue=${JSON.stringify(clicked)} next=${okTurn.status}`
    );
  }

  results.procs = classify();
  results.store = await evalAsync(pc.storeSummary(sid), { label: 'store summary' });
  results.problems = cdp.problems.slice(0, 60);
  writeResult('p1-1-item4-result.json', results);
  cdp.close();
  console.log(
    JSON.stringify(
      scrub({
        slowTool: results.slowTool,
        fork: results.fork,
        attachment: { ...results.attachment, events: results.attachment.events.counts },
        tui: results.tui,
        failure: {
          ...results.failure,
          failed: {
            ...results.failure.failed,
            store: undefined,
            events: results.failure.failed.events,
          },
        },
      }),
      null,
      2
    )
  );
}

/**
 * 4d again, only for the picture: the 「继续」 toast lives about five seconds,
 * and item4 took its screenshot after the six-second trace.
 */
async function continueShot() {
  const cdp = await attach();
  await cdp.evaluate(INSTALL_RECORDERS);
  const evalAsync = evalStore(cdp);
  const sid = (await storeState(evalAsync)).active;
  await gatewayStop();
  const before = await messageCount(evalAsync, sid);
  await send(cdp, 'P0-STREAM: 网关又停了，这一轮也预期失败（为「继续」截图）。');
  const turn = await waitTurn(evalAsync, sid, before, 120_000);
  await sleep(1200);
  gatewayStart({ reset: false });
  await gatewayHealthy();
  const tm = await toastMark(cdp);
  const clicked = await cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((n) => (n.innerText || '').trim() === '继续' && n.offsetParent !== null);
    if (!b || b.disabled) return false;
    b.click();
    return true;
  })()`);
  let toasts = [];
  for (let i = 0; i < 20 && toasts.length === 0; i += 1) {
    await sleep(100);
    toasts = await toastsSince(cdp, tm);
  }
  await sleep(300);
  await shot(cdp, '07-continue-toast.png');
  const composer = await cdp.evaluate(COMPOSER_STATE);
  const out = { turn, clicked, toasts, composer };
  writeResult('p1-1-continue-shot.json', out);
  cdp.close();
  console.log(JSON.stringify(scrub(out), null, 2));
}

async function quit() {
  const before = classify();
  const cdp = await attach();
  const em = await eventMark(cdp).catch(() => 0);
  // A quit asks for confirmation first (「确认退出 / 确定要退出应用吗？」): the
  // same path a user takes, so answer it the way a user would.
  const dialogOpen = await cdp.evaluate(
    `[...document.querySelectorAll('button')].some((n) => (n.innerText || '').trim() === '退出' && n.offsetParent !== null)`
  );
  if (!dialogOpen) await cdp.evaluate(`(() => { window.electronAPI.app.quit(); return true; })()`);
  let confirmed = false;
  for (let i = 0; i < 20 && !confirmed; i += 1) {
    confirmed = await cdp
      .evaluate(`(() => {
        const b = [...document.querySelectorAll('button')].find((n) => (n.innerText || '').trim() === '退出' && n.offsetParent !== null);
        if (!b) return false;
        b.click();
        return true;
      })()`)
      .catch(() => false);
    if (!confirmed) await sleep(500);
  }
  const askedAt = Date.now();
  log(`quit confirmed=${confirmed}`);
  cdp.close();
  const left = await waitAppGone(90_000);
  const rows = procList();
  const out = {
    askedAt,
    goneAfterMs: left.length === 0 ? Date.now() - askedAt : null,
    before: {
      electronMain: before.electronMain,
      dshHosts: before.dshHosts,
      nativeWorkers: before.nativeWorkers,
    },
    left: left.map((pid) => rows.find((r) => r.pid === pid)).filter(Boolean),
    strayHosts: rows.filter(isOurHost).map(({ pid, ppid, cmd }) => ({ pid, ppid, cmd })),
    gatewayStillUp: rows.some(isGateway),
    dshHome: listDshHome(),
    index: readIndex().rows,
    eventMarkAtQuit: em,
  };
  writeResult(`p1-1-quit-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, out);
  console.log(
    JSON.stringify(
      scrub({ ...out, dshHome: out.dshHome.files.length, index: out.index.length }),
      null,
      2
    )
  );
}

const LEGACY_TITLE = '旧 pi 会话（P1-1 只读点验）';
const LEGACY_FIXTURE =
  'docs/plantree/plans/runtime-hardening/evidence/batch-e-devbox-2026-09-17/dev-D/dev-30-sessionA-before-tui.jsonl';

/** A `pi` row naming a real-format pi session, written while the app is down. */
function injectLegacy() {
  const rows = procList();
  if (rows.some(isDevRoot) || classify(rows).electronMain.length) {
    throw new Error('the app is still running; quit it first');
  }
  const index = readIndex();
  if (!index.file) throw new Error('no session-index.json yet');
  if (index.rows.some((r) => r.title === LEGACY_TITLE)) {
    console.log('legacy row already present');
    return;
  }
  const legacyId = crypto.randomUUID();
  const source = path.join(repoRoot, LEGACY_FIXTURE);
  const lines = fs.readFileSync(source, 'utf8').split('\n');
  const headerBefore = JSON.parse(lines[0]);
  // The v4 reader ignores the header cwd; it is rewritten only so the scratch
  // copy names no real directory.
  const headerAfter = { ...headerBefore, cwd: dirs.workspace };
  lines[0] = JSON.stringify(headerAfter);
  const sessionsDir = path.join(piAgentDir, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  const target = path.join(sessionsDir, `${legacyId}.jsonl`);
  fs.writeFileSync(target, lines.join('\n'));
  fs.copyFileSync(index.file, `${index.file}.before-legacy-inject`);
  const row = {
    sessionId: legacyId,
    runtimeIdentity: target,
    agent: 'pi',
    workspacePath: dirs.workspace,
    title: LEGACY_TITLE,
    model: 'p0fake/fake-1',
    updatedAt: Date.now() - 60_000,
    archived: false,
  };
  fs.writeFileSync(index.file, JSON.stringify([...index.rows, row]));
  const out = {
    legacyId,
    fixture: LEGACY_FIXTURE,
    target,
    headerBefore,
    headerAfter,
    entries: lines.filter(Boolean).length,
    row,
  };
  writeResult('p1-1-legacy-inject.json', out);
  console.log(JSON.stringify(scrub(out), null, 2));
}

// ---- items 2 and 3: after a full restart ------------------------------------------------

async function run2() {
  const cdp = await attach();
  const results = { step: 'run2', startedAt: new Date().toISOString() };
  results.entered = await enter(cdp);
  results.recorders = await cdp.evaluate(INSTALL_RECORDERS);
  const evalAsync = evalStore(cdp);
  const start = await storeState(evalAsync);
  results.start = { store: start, procs: classify(), index: readIndex().rows };
  const dsh = start.sessions.find((s) => s.agent === 'dsh' && s.runtimeIdentity);
  const legacy = start.sessions.find((s) => s.agent === 'pi');
  results.dshSession = dsh ?? null;
  results.legacySession = legacy ?? null;
  if (!dsh) throw new Error(`no DSH session in the store: ${JSON.stringify(start.sessions)}`);
  const sid = dsh.id;

  // 2a: open the DSH chat after the restart and run one more turn.
  {
    const pidsBefore = new Set(ourProcesses());
    const em = await eventMark(cdp);
    const opened = await openSession(cdp, evalAsync, sid);
    const trace = await observe(cdp, evalAsync, sid, 8000);
    const shotName = await shot(cdp, '08-restart-resumed.png');
    const rows = procList();
    const resumed = {
      opened,
      trace,
      events: eventDigest(await eventsSince(cdp, em)),
      composer: await cdp.evaluate(COMPOSER_STATE),
      newProcesses: ourProcesses(rows)
        .filter((pid) => !pidsBefore.has(pid))
        .map((pid) => rows.find((r) => r.pid === pid))
        .filter(Boolean)
        .map(({ pid, ppid, cmd }) => ({ pid, ppid, cmd: cmd.slice(0, 200) })),
      screenshot: shotName,
    };
    const before = await messageCount(evalAsync, sid);
    const em2 = await eventMark(cdp);
    const gw = gatewayLog().length;
    await send(
      cdp,
      'P0-RECALL {"markers":["aiclient-bridge 流式回复","bridge tool row ok","slow tool done"]} 重启后继续一轮：检查模型还能看到之前的内容。'
    );
    const turn = await waitTurn(evalAsync, sid, before);
    await sleep(800);
    await shot(cdp, '08-restart-turn-done.png');
    const rows2 = procList();
    results.restart = {
      resumed,
      turn,
      reply: await lastAssistantText(evalAsync, sid),
      events: eventDigest(await eventsSince(cdp, em2)),
      gateway: gatewayLog().slice(gw),
      hosts: classify(rows2).dshHosts,
      holding: hostsHoldingSession(sid),
      nativeWorkers: classify(rows2).nativeWorkers,
    };
    log(`2a: status=${turn.status} reply=${results.restart.reply.slice(0, 80)}`);
  }

  // 2b: kill this session's host (exact pid) while a slow tool runs.
  {
    const holding = hostsHoldingSession(sid);
    const target = holding.find((h) => h.fdHits > 0) ?? (holding.length === 1 ? holding[0] : null);
    if (!target) throw new Error(`cannot tell which host holds ${sid}: ${JSON.stringify(holding)}`);
    const before = await messageCount(evalAsync, sid);
    const em = await eventMark(cdp);
    const tm = await toastMark(cdp);
    await send(cdp, 'P0-SLOWTOOL: 跑一个慢命令（点验：运行中杀掉宿主）。');
    let running = null;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      running = await toolState(evalAsync, sid, before);
      if (running && !running.settled) break;
      await sleep(60);
    }
    const runningAt = Date.now();
    await pc.shoot(cdp, outDir, '09-crash-tool-running.png');
    const hostRow = procList().find((r) => r.pid === target.pid);
    const killAt = Date.now();
    let killed = false;
    if (hostRow && isOurHost(hostRow)) {
      process.kill(target.pid, 'SIGKILL');
      killed = true;
    }
    log(`2b: killed host ${target.pid} (${killed}) ${killAt - runningAt} ms after the running row`);
    // Watch the store and /proc while WorkerManager reacts.
    const timeline = [];
    const watchUntil = Date.now() + 30_000;
    let lastKey = '';
    while (Date.now() < watchUntil) {
      const s = await evalAsync(
        `const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
         const st = chat.useChatSessionsStore.getState();
         const session = st.sessions.find((x) => x.id === ${JSON.stringify(sid)});
         return { status: session?.status ?? null, lastError: st.lastError ?? null,
                  messages: (st.messages[${JSON.stringify(sid)}] ?? []).length };`,
        { label: 'crash watch' }
      );
      const hosts = procList()
        .filter(isOurHost)
        .map((r) => r.pid);
      const tool = await toolState(evalAsync, sid, before);
      const row = { ...s, hosts, tool: tool ? { settled: tool.settled, ok: tool.ok } : null };
      const key = JSON.stringify(row);
      if (key !== lastKey) {
        timeline.push({ t: Date.now(), ...row });
        lastKey = key;
      }
      await sleep(300);
    }
    await sleep(500);
    await shot(cdp, '09-crash-after-kill.png');
    const crashEvents = await eventsSince(cdp, em);
    const afterKill = {
      target,
      killed,
      killAt,
      running,
      timeline,
      events: eventDigest(crashEvents),
      toasts: await toastsSince(cdp, tm),
      composer: await cdp.evaluate(COMPOSER_STATE),
      card: await cdp.evaluate(FAILURE_CARD),
      bodyTail: (await cdp.evaluate(pc.TRANSCRIPT_TEXT)).slice(-1500),
      hosts: classify().dshHosts.map(({ pid, ppid }) => ({ pid, ppid })),
      orphanSleep: procList()
        .filter((r) => /(^|\s)sleep 5(\s|$)/.test(r.cmd))
        .map(({ pid, ppid, cmd }) => ({ pid, ppid, cmd })),
    };
    // The session must take another turn.
    const before2 = await messageCount(evalAsync, sid);
    const em2 = await eventMark(cdp);
    let nextTurn;
    try {
      await send(cdp, 'P0-STREAM: 宿主被杀、自动重启之后再来一轮。');
      nextTurn = await waitTurn(evalAsync, sid, before2);
    } catch (error) {
      nextTurn = { error: String(error.message ?? error) };
    }
    await sleep(800);
    await shot(cdp, '09-crash-next-turn.png');
    results.crash = {
      afterKill,
      nextTurn,
      nextReply: await lastAssistantText(evalAsync, sid),
      nextEvents: eventDigest(await eventsSince(cdp, em2)),
      hostsAfter: classify().dshHosts.map(({ pid, ppid }) => ({ pid, ppid })),
      holdingAfter: hostsHoldingSession(sid),
    };
    log(`2b: next turn ${JSON.stringify(nextTurn).slice(0, 200)}`);
  }

  // 3: the legacy pi chat is viewable, and a send in it is refused and bounced back.
  if (legacy) {
    const lid = legacy.id;
    const pidsBefore = new Set(ourProcesses());
    const em = await eventMark(cdp);
    const tm = await toastMark(cdp);
    const gw = gatewayLog().length;
    const opened = await openSession(cdp, evalAsync, lid);
    const trace = await observe(cdp, evalAsync, lid, 6000);
    const preview = await evalAsync(
      `const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
       const st = chat.useChatSessionsStore.getState();
       const msgs = st.messages[${JSON.stringify(lid)}] ?? [];
       return msgs.map((m) => ({ role: m.role, text: (m.blocks ?? []).filter((b) => b.type === 'text').map((b) => String(b.text ?? '')).join('').slice(0, 120) }));`,
      { label: 'legacy preview' }
    );
    const bodyText = await cdp.evaluate(pc.TRANSCRIPT_TEXT);
    await shot(cdp, '10-legacy-preview.png');
    const beforeSend = {
      opened,
      trace,
      preview,
      readonlyCard: bodyText.includes('迁移前只能查看'),
      transcript: bodyText.slice(0, 1500),
      composer: await cdp.evaluate(COMPOSER_STATE),
      events: eventDigest(await eventsSince(cdp, em)),
    };
    const em2 = await eventMark(cdp);
    const text = 'P1-1 旧会话只读点验：这条消息应被退回输入框。';
    let sent = null;
    try {
      sent = await send(cdp, text);
    } catch (error) {
      sent = `not sent: ${error.message}`;
    }
    const trace2 = await observe(cdp, evalAsync, lid, 8000);
    const bodyText2 = await cdp.evaluate(pc.TRANSCRIPT_TEXT);
    await shot(cdp, '10-legacy-send-refused.png');
    const rows = procList();
    const composerAfter = await cdp.evaluate(COMPOSER_STATE);
    results.legacy = {
      sessionId: lid,
      beforeSend,
      sent,
      trace: trace2,
      readonlyCard: bodyText2.includes('迁移前只能查看'),
      transcriptAfter: bodyText2.slice(0, 2000),
      composerAfter,
      textBackInComposer: composerAfter.value === text,
      toasts: await toastsSince(cdp, tm),
      events: eventDigest(await eventsSince(cdp, em2)),
      gatewayRequests: gatewayLog().length - gw,
      newProcesses: ourProcesses(rows)
        .filter((pid) => !pidsBefore.has(pid))
        .map((pid) => rows.find((r) => r.pid === pid))
        .filter(Boolean)
        .map(({ pid, ppid, cmd }) => ({ pid, ppid, cmd: cmd.slice(0, 200) })),
      indexRow: readIndex().rows.find((r) => r.sessionId === lid) ?? null,
      fileStillIntact: fs.existsSync(legacy.runtimeIdentity)
        ? fs.readFileSync(legacy.runtimeIdentity, 'utf8').split('\n').filter(Boolean).length
        : null,
    };
    log(`3: card=${results.legacy.readonlyCard} back=${results.legacy.textBackInComposer}`);
  }

  results.procs = classify();
  results.problems = cdp.problems.slice(0, 80);
  writeResult('p1-1-run2-result.json', results);
  cdp.close();
  console.log(
    JSON.stringify(
      scrub({
        dsh: results.dshSession,
        legacy: results.legacySession,
        restart: {
          ...results.restart,
          events: results.restart.events.counts,
          resumed: { ...results.restart.resumed, events: results.restart.resumed.events.counts },
        },
        crash: results.crash,
        legacyResult: results.legacy,
      }),
      null,
      2
    )
  );
}

/**
 * Click a sidebar row by title the way a user does. The same chat is listed
 * under 最近 and under its folder, so pc.switchTo (which insists on exactly one
 * match) falls back to `selectSession`, which never activates a resume or a
 * preview; here the first visible match is clicked instead.
 */
async function clickRow(cdp, evalAsync, sessionId, title) {
  const clicked = await cdp.evaluate(`(() => {
    const rows = [...document.querySelectorAll('[role="button"][title]')]
      .filter((n) => n.offsetParent !== null && n.getAttribute('title') === ${JSON.stringify(title)});
    if (rows.length === 0) return { ok: false, matches: 0 };
    rows[0].click();
    return { ok: true, matches: rows.length };
  })()`);
  let active = null;
  for (let i = 0; i < 20; i += 1) {
    active = (await storeState(evalAsync)).active;
    if (active === sessionId) break;
    await sleep(300);
  }
  return { ...clicked, activeSessionId: active };
}

const PAGE_FACTS = `(() => {
  const body = document.body.innerText;
  const errorBox = [...document.querySelectorAll('div, p, pre')]
    .filter((n) => n.offsetParent !== null && n.children.length === 0 && /^Error: /.test((n.innerText || '').trim()))
    .map((n) => n.innerText.trim().slice(0, 400));
  return {
    readonlyCard: body.includes('迁移前只能查看'),
    readonlyCardText: (() => {
      const hit = [...document.querySelectorAll('div')].find((n) => n.offsetParent !== null && (n.innerText || '').startsWith('迁移前只能查看'));
      return hit ? hit.innerText.slice(0, 400) : null;
    })(),
    errorBox,
    composerButtons: (() => {
      const ta = document.querySelector('textarea');
      let box = ta;
      for (let i = 0; i < 5 && box?.parentElement; i += 1) box = box.parentElement;
      return box ? [...box.querySelectorAll('button')].filter((b) => b.offsetParent !== null)
        .map((b) => ((b.innerText || '').trim() || b.getAttribute('aria-label') || b.getAttribute('title') || '?') + (b.disabled ? ' [disabled]' : '')) : [];
    })(),
  };
})()`;

async function run3() {
  const cdp = await attach();
  const results = { step: 'run3', startedAt: new Date().toISOString() };
  results.entered = await enter(cdp);
  results.recorders = await cdp.evaluate(INSTALL_RECORDERS);
  const evalAsync = evalStore(cdp);
  const start = await storeState(evalAsync);
  results.start = { store: start, procs: classify() };
  const legacy = start.sessions.find((s) => s.agent === 'pi');
  const dsh = start.sessions.find((s) => s.agent === 'dsh' && s.runtimeIdentity);

  // 3, from a fresh start: click the legacy chat, look, then send in it.
  if (legacy) {
    const lid = legacy.id;
    const pidsBefore = new Set(ourProcesses());
    const gw = gatewayLog().length;
    const em = await eventMark(cdp);
    const tm = await toastMark(cdp);
    const opened = await clickRow(cdp, evalAsync, lid, legacy.title);
    const trace = await observe(cdp, evalAsync, lid, 6000);
    const preview = await evalAsync(
      `const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
       const st = chat.useChatSessionsStore.getState();
       return (st.messages[${JSON.stringify(lid)}] ?? []).map((m) => ({ role: m.role,
         text: (m.blocks ?? []).filter((b) => b.type === 'text').map((b) => String(b.text ?? '')).join('').slice(0, 120) }));`,
      { label: 'legacy preview' }
    );
    const factsBefore = await cdp.evaluate(PAGE_FACTS);
    await shot(cdp, '10-legacy-preview.png');
    const eventsBefore = eventDigest(await eventsSince(cdp, em));
    const em2 = await eventMark(cdp);
    const text = 'P1-1 旧会话只读点验：这条消息应被退回输入框。';
    let sent = null;
    try {
      sent = await send(cdp, text);
    } catch (error) {
      sent = `not sent: ${error.message}`;
    }
    const trace2 = await observe(cdp, evalAsync, lid, 8000);
    const factsAfter = await cdp.evaluate(PAGE_FACTS);
    await shot(cdp, '10-legacy-send-refused.png');
    const composerAfter = await cdp.evaluate(COMPOSER_STATE);
    const rows = procList();
    results.legacy = {
      sessionId: lid,
      opened,
      trace,
      preview,
      factsBefore,
      eventsBefore,
      sent,
      trace2,
      factsAfter,
      composerAfter,
      textBackInComposer: composerAfter.value === text,
      toasts: await toastsSince(cdp, tm),
      eventsAfter: eventDigest(await eventsSince(cdp, em2)),
      gatewayRequests: gatewayLog().length - gw,
      newProcesses: ourProcesses(rows)
        .filter((pid) => !pidsBefore.has(pid))
        .map((pid) => rows.find((r) => r.pid === pid))
        .filter(Boolean)
        .map(({ pid, ppid, cmd }) => ({ pid, ppid, cmd: cmd.slice(0, 200) })),
      fileLines: fs.existsSync(legacy.runtimeIdentity)
        ? fs.readFileSync(legacy.runtimeIdentity, 'utf8').split('\n').filter(Boolean).length
        : null,
      indexRow: readIndex().rows.find((r) => r.sessionId === lid) ?? null,
    };
    log(
      `3: preview=${preview.length} card=${factsAfter.readonlyCard} back=${results.legacy.textBackInComposer}`
    );
  }

  // 2a, the user's way: click the DSH chat after the restart.
  if (dsh) {
    const sid = dsh.id;
    const pidsBefore = new Set(ourProcesses());
    const em = await eventMark(cdp);
    const opened = await clickRow(cdp, evalAsync, sid, dsh.title);
    const trace = await observe(cdp, evalAsync, sid, 10_000);
    const facts = await cdp.evaluate(PAGE_FACTS);
    await shot(cdp, '08-restart-click-resumed.png');
    const rows = procList();
    const resumed = {
      opened,
      trace,
      facts,
      events: eventDigest(await eventsSince(cdp, em)),
      newProcesses: ourProcesses(rows)
        .filter((pid) => !pidsBefore.has(pid))
        .map((pid) => rows.find((r) => r.pid === pid))
        .filter(Boolean)
        .map(({ pid, ppid, cmd }) => ({ pid, ppid, cmd: cmd.slice(0, 200) })),
      timelineMessages: await messageCount(evalAsync, sid),
    };
    const before = await messageCount(evalAsync, sid);
    const em2 = await eventMark(cdp);
    await send(cdp, 'P0-TOOL: 第二次重启后点开会话再跑一轮工具。');
    const turn = await waitTurn(evalAsync, sid, before);
    await cdp.evaluate(pc.EXPAND_WORK_GROUPS);
    await sleep(800);
    await shot(cdp, '08-restart-click-turn-done.png');
    results.restartClick = {
      resumed,
      turn,
      reply: await lastAssistantText(evalAsync, sid),
      tool: await toolState(evalAsync, sid, before),
      events: eventDigest(await eventsSince(cdp, em2)),
      hosts: classify().dshHosts.map(({ pid, ppid }) => ({ pid, ppid })),
      nativeWorkers: classify().nativeWorkers,
    };
    log(`2a-click: timeline=${resumed.timelineMessages} status=${turn.status}`);
  }

  results.procs = classify();
  results.problems = cdp.problems.slice(0, 80);
  writeResult('p1-1-run3-result.json', results);
  cdp.close();
  console.log(
    JSON.stringify(scrub({ legacy: results.legacy, restartClick: results.restartClick }), null, 2)
  );
}

const step = process.argv[2];
const steps = {
  setup,
  enter: enterStep,
  item1,
  item4,
  run3,
  'continue-shot': continueShot,
  quit,
  'inject-legacy': injectLegacy,
  run2,
  'gateway-start': async () => {
    gatewayStart({ reset: false });
    log(`health ${JSON.stringify(await gatewayHealthy())}`);
  },
  'gateway-stop': gatewayStop,
  launch,
  peek,
  procs: async () => console.log(JSON.stringify(scrub(classify()), null, 2)),
  stop: () => stop(),
};
if (!steps[step]) {
  console.error(`usage: p1-1-gui.mjs ${Object.keys(steps).join('|')}`);
  process.exit(2);
}
await steps[step]();
// The CDP WebSocket keeps the event loop alive after close(); detached children are unref'd.
process.exit(0);
