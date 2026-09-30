#!/usr/bin/env node
/**
 * p1-7d-gui.mjs — dev-GUI point-check for dsh-rebase P1-7d (checklist sections A and B).
 *
 * Derived from evidence/p1-1-gui-2026-09-26/tools/p1-1-gui.mjs. Differences:
 *   - the fake gateway is the maintained `src/dsh-host/tools/fake-gateway.mjs`
 *     (`--plan dsh-p0-2`, which has the P1-* markers), not the archived copy;
 *   - scratch lives under /tmp (HOME and workspace), see SCRATCH;
 *   - the local model catalog has `fake-1` and an image-capable `fake-vision`
 *     (`input: ['text','image']`), for A7;
 *   - the steps are generic building blocks (eval / send / wait / shot …) so
 *     each checklist item can be driven by hand, plus a few timed items
 *     (a2, a6, b4-kill) that need a precise moment;
 *   - every screenshot passes a privacy check first (no /home/, host name or
 *     user@host text on the page), and lands in ../shots/.
 *
 * Batch 2 (sections C, D, E; driven by p1-7d-items-cde.mjs) added, without
 * changing any batch-1 step:
 *   - a scratch ~/.bash_profile and ~/.bashrc setting PS1='$ ', so the
 *     right-column terminal's prompt never shows a user or host name;
 *   - a recorder of every pty byte the renderer receives (`__p17dTermText`),
 *     which the privacy check scans too: xterm paints on a WebGL canvas, so
 *     the terminal's text is not in `document.body.innerText`;
 *   - `bounds <w> <h>` (window size: CDP `Browser.setWindowBounds` first;
 *     Electron has no `Browser.getWindowForTarget`, so in practice the real
 *     window is resized with `window.resizeTo`, and only if that does not
 *     take, `Emulation.setDeviceMetricsOverride`) and `theme <light|dark>`
 *     (the settings store's own `setTheme`);
 *   - `pumpFrames` (lib) and `front`: on this box the app window gets no
 *     frames while it is not composited (requestAnimationFrame measured at 0/s,
 *     `Page.bringToFront` does not help), so xterm never mounts and layouts
 *     driven by ResizeObserver lag; every `Page.captureScreenshot` forces a
 *     frame, so a loop of 4×4-pixel captures keeps ~25 frames/s going. `shot`
 *     now pumps 0.8 s of frames before it captures.
 *
 *   node p1-7d-gui.mjs setup            scratch dirs, fake env, model catalog, gateway (--reset)
 *   node p1-7d-gui.mjs gateway-start    start the gateway alone (no --reset)
 *   node p1-7d-gui.mjs gateway-stop     stop the gateway by exact pid
 *   node p1-7d-gui.mjs launch           dev.js with --remote-debugging-port=9222 (detached)
 *   node p1-7d-gui.mjs enter            zh UI, welcome entry, dismiss dialogs, install recorders
 *   node p1-7d-gui.mjs peek             visible buttons / body text, screenshot into scratch
 *   node p1-7d-gui.mjs procs            our processes, classified (pids only for the report)
 *   node p1-7d-gui.mjs shot <name>      privacy-checked screenshot into ../shots/<name>.png
 *   node p1-7d-gui.mjs js '<expr>'      synchronous Runtime.evaluate, prints the value
 *   node p1-7d-gui.mjs page '<body>'    async page body (may `await`, must `return`), prints the value
 *   node p1-7d-gui.mjs pagef <file>     same, body read from a file
 *   node p1-7d-gui.mjs send '<text>'    type into the composer and click 「发送消息」
 *   node p1-7d-gui.mjs wait [sid]       busy, then three idle reads
 *   node p1-7d-gui.mjs state            store: active session, sessions, statuses
 *   node p1-7d-gui.mjs expand           open every settled work group (<details>)
 *   node p1-7d-gui.mjs kill-host        SIGKILL the one DSH host of this run (exact pid)
 *   node p1-7d-gui.mjs bounds <w> <h>   resize the window (see batch 2 above)
 *   node p1-7d-gui.mjs theme <name>     light | dark, through the settings store
 *   node p1-7d-gui.mjs front            raise the window (Page.bringToFront), print the frame rate
 *   node p1-7d-gui.mjs quit             graceful quit (app IPC + confirm), wait for exit
 *   node p1-7d-gui.mjs stop             stop what is left, by exact pid (never pkill)
 *
 * Isolation: HOME=<scratch>/home, so userData, ~/.pilab (DSH_HOME), the vault and
 * ~/.pi are scratch copies. AICLIENT_DEV_ENV_FILE points at a scratch env file with
 * fake values only. Every model request goes to the fake gateway on 127.0.0.1.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../../../../..');
const { Cdp, ENTER_MAIN_SURFACE, sleep } = await import(path.join(repoRoot, 'scripts/h21-cdp.mjs'));

const SCRATCH = process.env.P17D_SCRATCH ?? '/tmp/aiclient-p17d';
const PORT = 9222;
const GATEWAY_PORT = Number(process.env.P17D_GATEWAY_PORT ?? 18742);
const outDir = path.resolve(here, '..');
const shotsDir = path.join(outDir, 'shots');
const gatewayEntry = path.join(repoRoot, 'src/dsh-host/tools/fake-gateway.mjs');
const hostEntry = path.join(repoRoot, 'src/dsh-host/host.ts');
const dirs = {
  home: path.join(SCRATCH, 'home'),
  workspace: path.join(SCRATCH, 'workspace'),
};
const piAgentDir = path.join(dirs.home, '.pi', 'agent');
const envFile = path.join(SCRATCH, 'p1-7d.env');
const gatewayLogFile = path.join(SCRATCH, 'gateway.jsonl');
const log = (...args) => console.error('[p1-7d-gui]', ...args);

// ---- privacy --------------------------------------------------------------------

const userHome = os.userInfo().homedir;
const hostName = os.hostname();
const userName = os.userInfo().username;
function scrubText(text) {
  return String(text)
    .split(`${userHome}/`)
    .join('<HOME>/')
    .split(userHome)
    .join('<HOME>')
    .split(hostName)
    .join('<host>')
    .split(`${userName}@`)
    .join('<user>@');
}
function scrub(value) {
  return JSON.parse(scrubText(JSON.stringify(value ?? null)));
}
function writeResult(name, value) {
  const file = path.join(outDir, name);
  fs.writeFileSync(file, `${JSON.stringify(scrub(value), null, 2)}\n`);
  log(`wrote ${path.relative(repoRoot, file)}`);
}

/**
 * Text a screenshot could show: body text, field values, visible titles, and
 * (batch 2) every byte a pty sent this page since `enter`, because xterm's
 * WebGL canvas keeps the terminal's text out of the DOM.
 */
const PAGE_PRIVACY_TEXT = `(() => {
  const parts = [document.body.innerText];
  for (const n of document.querySelectorAll('textarea, input')) parts.push(n.value || '');
  if (typeof window.__p17dTermText === 'string') parts.push(window.__p17dTermText);
  return parts.join('\\n');
})()`;

/** Batch 2: keep the last 256 KB of pty output the renderer received (idempotent). */
const INSTALL_TERM_RECORDER = `(() => {
  if (window.__p17dTermInstalled) return 'already';
  const api = window.electronAPI?.terminal;
  if (!api?.onData) return 'no terminal api';
  window.__p17dTermInstalled = true;
  window.__p17dTermText = '';
  api.onData((event) => {
    window.__p17dTermText = (window.__p17dTermText + String(event?.data ?? '')).slice(-262144);
  });
  return 'installed';
})()`;

function privacyHits(text) {
  const hits = [];
  if (text.includes('/home/')) hits.push('/home/');
  if (text.includes(hostName)) hits.push('hostname');
  if (text.includes(`${userName}@`)) hits.push('user@');
  if (text.includes(userHome)) hits.push('home dir');
  return hits;
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
  row.cmd.includes(gatewayEntry) && row.cmd.includes(`--port ${GATEWAY_PORT}`);
/** A DSH host of THIS run: our worktree's entry, launched in our scratch DSH_HOME. */
const isOurHost = (row) => row.cmd.includes(hostEntry) && (row.cwd ?? '').startsWith(SCRATCH);

function ourProcesses(rows = procList()) {
  const mine = rows.filter((row) => row.pid !== process.pid);
  const roots = mine.filter((row) => isDevRoot(row) || isGateway(row)).map((row) => row.pid);
  const tree = treeOf(roots, mine);
  const strays = mine.filter(isOurHost).map((row) => row.pid);
  return [...new Set([...tree, ...strays])];
}

function classify(rows = procList()) {
  const pids = new Set(ourProcesses(rows));
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const ours = [...pids].map((pid) => byPid.get(pid)).filter(Boolean);
  const electronMain = ours.filter(
    (row) => /\/electron(\s|$)/.test(row.cmd.split(' --')[0]) && !row.cmd.includes('--type=')
  );
  const hosts = ours.filter(isOurHost);
  const hostChildren = ours.filter((row) => hosts.some((h) => h.pid === row.ppid));
  return {
    devRoot: ours.filter(isDevRoot).map(({ pid }) => pid),
    gateway: ours.filter(isGateway).map(({ pid }) => pid),
    electronMain: electronMain.map(({ pid, ppid }) => ({ pid, ppid })),
    dshHosts: hosts.map(({ pid, ppid, cwd }) => ({ pid, ppid, cwd })),
    dshHostChildren: hostChildren.map(({ pid, ppid, cmd }) => ({
      pid,
      ppid,
      cmd: cmd.slice(0, 160),
    })),
    count: ours.length,
  };
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

/** A session's DSH stub and log, with size and times. */
function sessionFiles(sessionId) {
  const root = findProfileRoot();
  if (!root) return { profileRoot: null };
  const home = path.join(root, 'dsh-home');
  const stub = path.join(home, 'aiclient-sessions', `aiclient-${sessionId}.dsh.json`);
  const logs = [];
  const sessionsDir = path.join(home, 'sessions');
  if (fs.existsSync(sessionsDir)) {
    for (const cwdDir of fs.readdirSync(sessionsDir)) {
      const dir = path.join(sessionsDir, cwdDir, `aiclient-${sessionId}`);
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) logs.push(path.join(dir, name));
    }
  }
  const statOf = (file) => {
    if (!file || !fs.existsSync(file)) return null;
    const st = fs.statSync(file);
    return {
      file: path.relative(home, file),
      size: st.size,
      mtimeMs: Math.round(st.mtimeMs),
    };
  };
  return { stub: statOf(stub), logs: logs.map(statOf) };
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

// ---- setup / gateway / launch -------------------------------------------------------

function writeScratchConfig() {
  for (const dir of [...Object.values(dirs), piAgentDir]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(
    path.join(dirs.workspace, 'README.md'),
    '# P1-7d scratch workspace\n\nThrowaway; the GUI point-check runs its tools here.\n'
  );
  // Batch 2: the right-column terminal runs `bash -i -l` in this HOME. The
  // system bashrc's PS1 is `\u@\h:\w\$ `; these run after it and replace it.
  const bashPrompt = [
    '# P1-7d scratch shell: a prompt with no user or host name in it.',
    "export PS1='$ '",
    'unset PROMPT_COMMAND',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dirs.home, '.bashrc'), bashPrompt);
  fs.writeFileSync(path.join(dirs.home, '.bash_profile'), bashPrompt);
  fs.writeFileSync(
    path.join(piAgentDir, 'models.json'),
    `${JSON.stringify(
      {
        providers: {
          p0fake: {
            baseUrl: `http://127.0.0.1:${GATEWAY_PORT}`,
            api: 'anthropic-messages',
            models: [
              {
                id: 'fake-1',
                name: 'P1-7d fake model',
                contextWindow: 200000,
                maxTokens: 8192,
              },
              {
                id: 'fake-vision',
                name: 'P1-7d fake vision model',
                contextWindow: 200000,
                maxTokens: 8192,
                input: ['text', 'image'],
              },
            ],
          },
        },
      },
      null,
      2
    )}\n`
  );
  fs.writeFileSync(
    path.join(piAgentDir, 'auth.json'),
    `${JSON.stringify({ p0fake: { type: 'api_key', key: 'p1-7d-fake-key' } }, null, 2)}\n`
  );
  fs.writeFileSync(
    envFile,
    [
      '# P1-7d GUI point-check: fake values only, never a real credential.',
      `ANTHROPIC_BASE_URL=http://127.0.0.1:${GATEWAY_PORT}`,
      'ANTHROPIC_AUTH_TOKEN=p1-7d-fake-token',
      'AICLIENT_MANAGED_CREDENTIALS=0',
      'AICLIENT_DEFAULT_TEST_MODEL=p0fake/fake-1',
      `PI_CODING_AGENT_DIR=${piAgentDir}`,
      `AICLIENT_DSH_GATEWAY_URL=http://127.0.0.1:${GATEWAY_PORT}`,
      'AICLIENT_DSH_GATEWAY_KEY=p1-7d-fake-key',
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
  fs.writeFileSync(path.join(SCRATCH, 'gateway.pid'), String(gateway.pid));
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
  if (procList().some(isDevRoot)) throw new Error('an instance is already running');
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
    DISPLAY: process.env.DISPLAY ?? ':0',
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
  fs.writeFileSync(path.join(SCRATCH, 'dev.pid'), String(child.pid));
  log(`dev.js pid ${child.pid}; log ${path.join(SCRATCH, 'dev.log')}`);
}

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

/** Exact pids only: dev.js first (its own shutdown walks the Electron tree), then what is left. */
async function stop({ keepGateway = false } = {}) {
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
    if (pid <= 1) continue;
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // gone
    }
  }
  await sleep(6000);
  pids = survivors();
  for (const pid of pids) {
    if (pid <= 1) continue;
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

// ---- CDP ------------------------------------------------------------------------------

async function attach(timeoutMs = 600_000) {
  const cdp = await Cdp.attach(PORT, timeoutMs);
  cdp.collectRendererProblems();
  return cdp;
}

let slot = 0;
function makeEval(cdp, prefix = 'p17d') {
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

async function waitVisible(cdp) {
  await cdp.waitFor(
    `document.visibilityState === 'visible' && (document.getElementById('root')?.innerText.length ?? 0) > 20`,
    { timeoutMs: 60_000, label: 'window painted' }
  );
}

async function shot(cdp, name, { force = false } = {}) {
  await waitVisible(cdp);
  const text = await cdp.evaluate(PAGE_PRIVACY_TEXT);
  const hits = privacyHits(text);
  if (hits.length && !force) {
    const where = hits.map((h) => {
      const needle =
        h === 'hostname'
          ? hostName
          : h === 'user@'
            ? `${userName}@`
            : h === 'home dir'
              ? userHome
              : h;
      const at = text.indexOf(needle);
      return scrubText(text.slice(Math.max(0, at - 60), at + 80));
    });
    throw new Error(
      `privacy check failed (${hits.join(', ')}); not saved: ${JSON.stringify(where)}`
    );
  }
  fs.mkdirSync(shotsDir, { recursive: true });
  // Batch 2: a covered window paints nothing until a capture asks for a frame,
  // and a layout that ResizeObserver drives needs a second frame to show, so
  // run a few frames first (see pumpFrames) or the shot can be one layout old.
  await pumpFrames(cdp, 800);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(shotsDir, name.endsWith('.png') ? name : `${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  log(`shot ${path.relative(outDir, file)}`);
  return path.relative(outDir, file);
}

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
  const b = [...document.querySelectorAll('button[aria-label]')]
    .find((n) => n.getAttribute('aria-label') === '发送消息');
  return !!b && !b.disabled && b.offsetParent !== null;
})()`;

const CLICK_SEND = `(() => {
  const b = [...document.querySelectorAll('button[aria-label]')]
    .find((n) => n.getAttribute('aria-label') === '发送消息');
  if (!b) throw new Error('no send button');
  if (b.disabled) throw new Error('send button is disabled');
  b.click();
  return true;
})()`;

const EXPAND_WORK_GROUPS = `(() => {
  const summaries = [...document.querySelectorAll('details > summary')].filter((s) => s.offsetParent !== null);
  const opened = [];
  for (const s of summaries) {
    const d = s.parentElement;
    const text = (s.innerText || '').trim().replace(/\\s+/g, ' ');
    if (!d.open) { s.click(); opened.push(text.slice(0, 60)); }
  }
  return { summaries: summaries.length, clicked: opened };
})()`;

/** Scroll the transcript (the scroll viewport holding the most turn text) to its end. */
const SCROLL_BOTTOM = `(() => {
  const viewports = [...document.querySelectorAll('[data-slot="scroll-area-viewport"], [data-radix-scroll-area-viewport]')]
    .filter((v) => v.offsetParent !== null && v.scrollHeight > v.clientHeight);
  let best = null;
  for (const v of viewports) {
    const score = (v.innerText || '').length;
    if (!best || score > best.score) best = { v, score };
  }
  if (!best) return false;
  best.v.scrollTop = best.v.scrollHeight;
  return true;
})()`;

const VISIBLE_BUTTONS = `[...document.querySelectorAll('button')].filter((b) => b.offsetParent !== null)
  .map((b) => ((b.innerText || b.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ') + (b.disabled ? ' [disabled]' : '')).slice(0, 50))`;

/** Record every RuntimeEvent and every toast the page shows, from now on. */
const INSTALL_RECORDERS = `(() => {
  if (window.__p17dInstalled) return 'already';
  window.__p17dInstalled = true;
  window.__p17dEvents = [];
  window.__p17dToasts = [];
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
      : trim(p, 400);
    window.__p17dEvents.push({ t: Date.now(), type: event.type, sessionId: event.sessionId, payload: summary });
    if (window.__p17dEvents.length > 4000) window.__p17dEvents.splice(0, 1000);
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
      window.__p17dToasts.push({ t: Date.now(), title: title.innerText, description: desc });
    }
  }, 120);
  return 'installed';
})()`;

async function dismissDialogs(cdp) {
  const closed = [];
  for (let i = 0; i < 14; i += 1) {
    // Base UI keeps a closed popup in the DOM (`data-closed`); only open ones count.
    const open = await cdp.evaluate(
      `[...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].filter((d) => d.getAttribute('data-open') !== null).length`
    );
    if (!open) break;
    const hit = await cdp.evaluate(`(() => {
      const labels = ['以后再说', '知道了', '我知道了', '关闭', '跳过', '稍后', 'Got it', 'Later', 'Close', 'Skip'];
      const hit = [...document.querySelectorAll('[role="dialog"][data-open] button, [role="alertdialog"][data-open] button')]
        .find((b) => (labels.includes((b.innerText || '').trim()) || labels.includes(b.getAttribute('aria-label') || '')) && b.offsetParent !== null);
      if (hit) hit.click();
      return hit ? (hit.innerText || hit.getAttribute('aria-label') || '').trim() : null;
    })()`);
    if (hit) closed.push(hit);
    else break;
    await sleep(1200);
  }
  return closed;
}

async function enter() {
  const cdp = await attach();
  await waitVisible(cdp);
  const evalAsync = makeEval(cdp);
  const language = await evalAsync(
    `const m = await import(/* @vite-ignore */ '/stores/settings/index.ts');
     const store = m.useSettingsStore;
     if (store.getState().language !== 'zh') store.getState().setLanguage('zh');
     return store.getState().language;`,
    { label: 'set language zh' }
  );
  await sleep(1500);
  const entered = await cdp.evaluate(ENTER_MAIN_SURFACE).catch((e) => `ERROR: ${e.message}`);
  await cdp.waitFor(`document.querySelector('textarea') !== null`, {
    timeoutMs: 300_000,
    label: 'composer mounted',
  });
  const dialogs = [];
  for (let round = 0; round < 6; round += 1) {
    await sleep(2000);
    const closed = await dismissDialogs(cdp);
    dialogs.push(...closed);
    if (closed.length === 0 && round >= 2) break;
  }
  const recorders = await cdp.evaluate(INSTALL_RECORDERS);
  const termRecorder = await cdp.evaluate(INSTALL_TERM_RECORDER);
  const out = {
    language,
    entered,
    dialogs,
    recorders,
    termRecorder,
    buttons: await cdp.evaluate(VISIBLE_BUTTONS),
    problems: cdp.problems.slice(0, 10),
  };
  cdp.close();
  console.log(JSON.stringify(scrub(out), null, 2));
}

async function peek() {
  const cdp = await attach();
  const out = await cdp.evaluate(`(() => ({
    url: location.href,
    visibility: document.visibilityState,
    textarea: !!document.querySelector('textarea'),
    dialogs: [...document.querySelectorAll('[role="dialog"]')].map((d) => (d.getAttribute('data-open') !== null ? 'open ' : 'closed ') + (d.innerText || '').slice(0, 120)),
    buttons: ${VISIBLE_BUTTONS},
    body: document.body.innerText.slice(0, 3000),
  }))()`);
  fs.mkdirSync(path.join(SCRATCH, 'peek'), { recursive: true });
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(SCRATCH, 'peek', `peek-${Date.now()}.png`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  cdp.close();
  console.log(
    JSON.stringify(scrub({ ...out, peekShot: file, problems: cdp.problems.slice(0, 10) }), null, 2)
  );
}

const BUSY = ['starting', 'running', 'stopping', 'waiting_permission', 'waiting_question'];

async function turnStatus(evalAsync, sessionId) {
  return evalAsync(
    `${STORE}
     const sid = ${JSON.stringify(sessionId ?? null)} ?? s.activeSessionId;
     const session = s.sessions.find((x) => x.id === sid);
     return { sid, status: session?.status ?? null, messages: (s.messages[sid] ?? []).length,
              lastError: s.lastError ?? null };`,
    { label: 'turn status' }
  );
}

async function waitTurn(
  evalAsync,
  sessionId,
  { timeoutMs = 180_000, before = null, neverBusyMs = 25_000 } = {}
) {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let seenBusy = false;
  let idleReads = 0;
  let last = null;
  const statuses = [];
  while (Date.now() < deadline) {
    last = await turnStatus(evalAsync, sessionId);
    if (statuses.at(-1)?.status !== last.status)
      statuses.push({ t: Date.now(), status: last.status });
    if (BUSY.includes(last.status) || (before !== null && last.messages > before + 1))
      seenBusy = true;
    if (!seenBusy && Date.now() - startedAt > neverBusyMs) {
      return { settled: false, neverBusy: true, ...last, statuses };
    }
    if (BUSY.includes(last.status)) idleReads = 0;
    else if (seenBusy) {
      idleReads += 1;
      if (idleReads >= 3) return { settled: true, ...last, statuses };
    }
    await sleep(500);
  }
  return { settled: false, ...last, statuses };
}

async function sendText(cdp, text) {
  await cdp.evaluate(typeIntoComposer(text));
  await cdp.waitFor(SEND_READY, { timeoutMs: 30_000, label: 'send ready' });
  const at = Date.now();
  await cdp.evaluate(CLICK_SEND);
  return at;
}

async function stateStep() {
  const cdp = await attach();
  const evalAsync = makeEval(cdp);
  const out = await evalAsync(
    `${STORE}
     return {
       active: s.activeSessionId,
       lastError: s.lastError ?? null,
       sessions: s.sessions.map((x) => ({ id: x.id, status: x.status, title: x.title, agent: x.agent ?? null,
         unbound: !!x.unbound, messages: (s.messages[x.id] ?? []).length })),
     };`,
    { label: 'state' }
  );
  cdp.close();
  console.log(JSON.stringify(scrub(out), null, 2));
}

async function quit() {
  const cdp = await attach(30_000);
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
  const left = await waitAppGone(120_000);
  const out = {
    confirmed,
    goneAfterMs: left.length === 0 ? Date.now() - askedAt : null,
    left,
    strayHosts: procList()
      .filter(isOurHost)
      .map(({ pid }) => pid),
    gatewayStillUp: procList().some(isGateway),
  };
  console.log(JSON.stringify(out, null, 2));
}

function killHost() {
  const hosts = procList().filter(isOurHost);
  if (hosts.length !== 1) throw new Error(`expected one host, found ${hosts.map((h) => h.pid)}`);
  const pid = hosts[0].pid;
  if (pid <= 1) throw new Error('refusing to signal pid <= 1');
  process.kill(pid, 'SIGKILL');
  log(`SIGKILL host ${pid}`);
  return pid;
}

// ---- generic steps ------------------------------------------------------------------------

async function jsStep(expr) {
  const cdp = await attach(30_000);
  const value = await cdp.evaluate(expr);
  cdp.close();
  console.log(JSON.stringify(scrub(value), null, 2));
}

async function evalStep(body) {
  const cdp = await attach(30_000);
  const evalAsync = makeEval(cdp);
  const value = await evalAsync(body, { timeoutMs: 300_000 });
  cdp.close();
  console.log(JSON.stringify(scrub(value), null, 2));
}

async function sendStep(text) {
  const cdp = await attach(30_000);
  await cdp.evaluate(INSTALL_RECORDERS);
  const at = await sendText(cdp, text);
  cdp.close();
  console.log(JSON.stringify({ sentAt: at }));
}

async function waitStep(sid) {
  const cdp = await attach(30_000);
  const evalAsync = makeEval(cdp);
  const out = await waitTurn(evalAsync, sid || null);
  cdp.close();
  console.log(JSON.stringify(scrub(out), null, 2));
}

async function shotStep(name, force) {
  const cdp = await attach(30_000);
  const file = await shot(cdp, name, { force: force === '--force' });
  cdp.close();
  console.log(file);
}

/**
 * Register the fake gateway as a user-added AI service, through the same IPC the
 * settings form uses (`userProviders.upsert`). Since P1-5 the model menu and the
 * DSH plan are built from these, not from ~/.pi/agent/models.json. Fake key only.
 */
async function providerStep() {
  const cdp = await attach(30_000);
  const evalAsync = makeEval(cdp);
  const out = await evalAsync(
    `const api = window.electronAPI.userProviders;
     const before = await api.get();
     const existing = before.providers.find((p) => p.name === 'P1-7d fake gateway');
     const saved = await api.upsert({
       ...(existing ? { id: existing.id } : {}),
       name: 'P1-7d fake gateway',
       baseUrl: 'http://127.0.0.1:${GATEWAY_PORT}',
       api: 'anthropic-messages',
       apiKey: 'p1-7d-fake-key',
       models: ['fake-1', 'fake-vision'],
       modelMeta: {
         'fake-1': { contextWindow: 200000, maxTokens: 8192 },
         'fake-vision': { contextWindow: 200000, maxTokens: 8192, input: ['text', 'image'] },
       },
       enabled: true,
     });
     return { saved, after: await api.get() };`,
    { label: 'register fake provider' }
  );
  cdp.close();
  console.log(JSON.stringify(scrub(out), null, 2));
}

async function expandStep() {
  const cdp = await attach(30_000);
  const out = await cdp.evaluate(EXPAND_WORK_GROUPS);
  cdp.close();
  console.log(JSON.stringify(out, null, 2));
}

/**
 * Batch 2: resize the app window. CDP `Browser.setWindowBounds` moves the real
 * window (so CSS breakpoints, container queries and the shell's width rules
 * all see a real size), unlike `Emulation.setDeviceMetricsOverride`, which only
 * fakes the viewport. Tried on the page connection first, then on the browser
 * connection (`/json/version`) with the page's target id; Electron answers
 * neither, so `window.resizeTo` does the real resize.
 */
async function setBounds(cdp, width, height) {
  const out = { requested: { width, height } };
  const call = async (client, params) => {
    const found = await client.send('Browser.getWindowForTarget', params);
    await client.send('Browser.setWindowBounds', {
      windowId: found.windowId,
      bounds: { windowState: 'normal' },
    });
    await sleep(300);
    await client.send('Browser.setWindowBounds', {
      windowId: found.windowId,
      bounds: { width, height },
    });
    await sleep(1200);
    return {
      before: found.bounds,
      after: (await client.send('Browser.getWindowForTarget', params)).bounds,
    };
  };
  try {
    Object.assign(out, await call(cdp, {}), { via: 'Browser.setWindowBounds (page connection)' });
  } catch (pageError) {
    out.pageError = String(pageError.message ?? pageError);
    try {
      const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = targets.find((t) => t.type === 'page' && /^https?:\/\//.test(t.url ?? ''));
      // Minimal request/response over the browser socket (Cdp's own #connect is private).
      const ws = new WebSocket(version.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve);
        ws.addEventListener('error', () => reject(new Error('browser socket error')));
      });
      let id = 0;
      const pending = new Map();
      ws.addEventListener('message', (event) => {
        const frame = JSON.parse(event.data);
        const waiter = pending.get(frame.id);
        if (!waiter) return;
        pending.delete(frame.id);
        if (frame.error) waiter.reject(new Error(frame.error.message));
        else waiter.resolve(frame.result);
      });
      const client = {
        send: (method, params = {}) =>
          new Promise((resolve, reject) => {
            id += 1;
            pending.set(id, { resolve, reject });
            ws.send(JSON.stringify({ id, method, params }));
          }),
      };
      Object.assign(out, await call(client, { targetId: page.id }), {
        via: 'Browser.setWindowBounds (browser connection)',
      });
      ws.close();
    } catch (browserError) {
      out.browserError = String(browserError.message ?? browserError);
      // Electron's DevTools server has no Browser.getWindowForTarget (-32601).
      // `window.resizeTo` does move Electron's real (frameless) window, but on
      // this box (VM, no GPU, window not focused) the renderer's viewport stays
      // at the old size until a frame is produced; a (discarded) screenshot
      // produces one. Then wait for innerWidth/innerHeight.
      await cdp.evaluate(`(() => { window.resizeTo(${width}, ${height}); return true; })()`);
      const deadline = Date.now() + 20_000;
      let seen = null;
      while (Date.now() < deadline) {
        await cdp.send('Page.captureScreenshot', { format: 'png' }).catch(() => undefined);
        seen = await cdp.evaluate('({ w: innerWidth, h: innerHeight })');
        if (seen.w === width && seen.h === height) break;
        await sleep(300);
      }
      if (seen?.w === width && seen?.h === height) {
        await sleep(2000);
        out.via = 'window.resizeTo (the real window)';
      } else {
        // Last resort, the viewport override: media and container queries read
        // it, but it lasts only as long as THIS CDP connection.
        out.resizeToSeen = seen;
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width,
          height,
          deviceScaleFactor: 0,
          mobile: false,
        });
        await sleep(1200);
        out.via = 'Emulation.setDeviceMetricsOverride (viewport only, for this CDP connection)';
      }
    }
  }
  out.viewport = await cdp.evaluate(
    '({ innerWidth, innerHeight, outerWidth, outerHeight, dpr: devicePixelRatio })'
  );
  return out;
}

/** Drop a viewport override `setBounds` fell back to (no-op otherwise). */
async function clearBounds(cdp) {
  await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => undefined);
  await sleep(1000);
  return cdp.evaluate('({ innerWidth, innerHeight })');
}

async function boundsStep(width, height) {
  const cdp = await attach(30_000);
  const out = await setBounds(cdp, Number(width), Number(height));
  cdp.close();
  console.log(JSON.stringify(out, null, 2));
}

/** Batch 2: requestAnimationFrame callbacks in one second (0 = no frames: the window is occluded). */
const RAF_RATE = `(async () => {
  const t0 = performance.now();
  return await new Promise((res) => {
    let c = 0;
    const tick = () => { c += 1; if (performance.now() - t0 < 1000) requestAnimationFrame(tick); else res(c); };
    requestAnimationFrame(tick);
    setTimeout(() => res(c), 1500);
  });
})()`;

/**
 * Batch 2: raise the app window (CDP `Page.bringToFront`). A window another
 * one covers produces no frames on this box: requestAnimationFrame stops,
 * xterm never mounts, and the shell's measured widths lag until something
 * (a screenshot) forces a frame. Returns the frame rate before and after.
 */
async function bringToFront(cdp) {
  const rate = async () =>
    (
      await cdp.send('Runtime.evaluate', {
        expression: RAF_RATE,
        awaitPromise: true,
        returnByValue: true,
      })
    ).result.value;
  const before = await rate();
  await cdp.send('Page.bringToFront').catch(() => undefined);
  await sleep(800);
  return { before, after: await rate(), focus: await cdp.evaluate('document.hasFocus()') };
}

/**
 * Batch 2: keep frames coming for `ms`. Raising the window does not help on
 * this box (the session's screen is not being composited), but every
 * `Page.captureScreenshot` makes the renderer produce a frame, so a loop of
 * 4×4-pixel captures runs requestAnimationFrame and ResizeObserver at about
 * 25 frames a second (measured) — enough for xterm to mount and fit.
 */
async function pumpFrames(cdp, ms) {
  const until = Date.now() + ms;
  let frames = 0;
  while (Date.now() < until) {
    await cdp
      .send('Page.captureScreenshot', {
        format: 'jpeg',
        quality: 1,
        clip: { x: 0, y: 0, width: 4, height: 4, scale: 1 },
      })
      .catch(() => undefined);
    frames += 1;
  }
  return frames;
}

async function frontStep() {
  const cdp = await attach(30_000);
  const out = await bringToFront(cdp);
  cdp.close();
  console.log(JSON.stringify(out, null, 2));
}

/** Batch 2: the app theme, through the settings store's own setter (what the settings page calls). */
async function setTheme(cdp, theme) {
  const evalAsync = makeEval(cdp, 'p17dtheme');
  return evalAsync(
    `const m = await import(/* @vite-ignore */ '/stores/settings/index.ts');
     m.useSettingsStore.getState().setTheme(${JSON.stringify(theme)});
     await new Promise((r) => setTimeout(r, 600));
     return { theme: m.useSettingsStore.getState().theme,
              htmlClass: document.documentElement.className };`,
    { label: `theme ${theme}` }
  );
}

async function themeStep(theme) {
  const cdp = await attach(30_000);
  const out = await setTheme(cdp, theme);
  cdp.close();
  console.log(JSON.stringify(out, null, 2));
}

// ---- exports for item drivers ----------------------------------------------------------------

export const lib = {
  attach,
  makeEval,
  shot,
  sendText,
  waitTurn,
  turnStatus,
  typeIntoComposer,
  SEND_READY,
  CLICK_SEND,
  EXPAND_WORK_GROUPS,
  SCROLL_BOTTOM,
  VISIBLE_BUTTONS,
  INSTALL_RECORDERS,
  STORE,
  procList,
  classify,
  isOurHost,
  isGateway,
  sessionFiles,
  readIndex,
  gatewayLog,
  gatewayStart,
  gatewayStop,
  gatewayHealthy,
  writeResult,
  scrub,
  sleep,
  log,
  dirs,
  SCRATCH,
  outDir,
  killHost,
  // batch 2
  INSTALL_TERM_RECORDER,
  setBounds,
  clearBounds,
  setTheme,
  bringToFront,
  pumpFrames,
  privacyHits,
  PAGE_PRIVACY_TEXT,
};

const step = process.argv[2];
const steps = {
  setup,
  'gateway-start': async () => {
    gatewayStart({ reset: false });
    log(`health ${JSON.stringify(await gatewayHealthy())}`);
  },
  'gateway-stop': gatewayStop,
  launch,
  enter,
  peek,
  procs: async () => console.log(JSON.stringify(scrub(classify()), null, 2)),
  shot: () => shotStep(process.argv[3], process.argv[4]),
  js: () => jsStep(process.argv[3]),
  jsf: () => jsStep(fs.readFileSync(process.argv[3], 'utf8')),
  page: () => evalStep(process.argv[3]),
  pagef: () => evalStep(fs.readFileSync(process.argv[3], 'utf8')),
  send: () => sendStep(process.argv[3]),
  wait: () => waitStep(process.argv[3]),
  state: stateStep,
  expand: expandStep,
  provider: providerStep,
  bottom: () => jsStep(SCROLL_BOTTOM),
  'kill-host': async () => console.log(killHost()),
  bounds: () => boundsStep(process.argv[3], process.argv[4]),
  front: frontStep,
  theme: () => themeStep(process.argv[3]),
  quit,
  stop: () => stop(),
};
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  if (!steps[step]) {
    console.error(`usage: p1-7d-gui.mjs ${Object.keys(steps).join('|')}`);
    process.exit(2);
  }
  await steps[step]();
  // The CDP WebSocket keeps the event loop alive after close(); detached children are unref'd.
  process.exit(0);
}
