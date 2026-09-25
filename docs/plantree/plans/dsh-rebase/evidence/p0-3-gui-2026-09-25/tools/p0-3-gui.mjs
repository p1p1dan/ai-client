#!/usr/bin/env node
/**
 * p0-3-gui.mjs — dev-GUI point-check for the P0-3 DSH bridge.
 *
 *   node p0-3-gui.mjs setup     scratch dirs, fake env file, fake gateway (detached)
 *   node p0-3-gui.mjs launch    `node scripts/dev.js --remote-debugging-port=9222` (detached)
 *   node p0-3-gui.mjs state     attach CDP, enter the app, print what is on screen
 *   node p0-3-gui.mjs run       the three cases + screenshots
 *   node p0-3-gui.mjs stop      stop the app tree and the gateway (walks /proc, never pkill -f)
 *
 * Isolation: the app runs with HOME=<scratch>/home, so its userData, ~/.pilab
 * profile, vault and ~/.pi are all scratch copies, and with AICLIENT_DEV_ENV_FILE
 * pointing at a scratch env file that holds only fake values (the real dev.env
 * is never read). The workspace is <scratch>/workspace. Every model request
 * goes to the fake gateway (plan dsh-p0-2) on 127.0.0.1.
 *
 * CDP mechanics come from scripts/h21-cdp.mjs and the batch-h pc-lib.mjs.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
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

const SCRATCH = process.env.P0_3_SCRATCH ?? '/var/tmp/aiclient-p0-3';
const PORT = 9222;
const GATEWAY_PORT = Number(process.env.P0_3_GATEWAY_PORT ?? 18733);
const shotsDir = path.resolve(here, '..');
const gatewayEntry = path.join(
  repoRoot,
  'docs/plantree/plans/runtime-hardening/evidence/batch-e-devbox-2026-09-17/tools/fake-gateway.mjs'
);
const dirs = {
  home: path.join(SCRATCH, 'home'),
  workspace: path.join(SCRATCH, 'workspace'),
  outside: path.join(SCRATCH, 'outside'),
  dshHome: path.join(SCRATCH, 'dsh-home'),
  piAgent: path.join(SCRATCH, 'pi-agent'),
};
const envFile = path.join(SCRATCH, 'p0-3.env');
const log = (...args) => console.error('[p0-3-gui]', ...args);

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
      rows.push({ pid: Number(entry), ppid, cmd });
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

function ourProcesses() {
  const rows = procList().filter((row) => row.pid !== process.pid);
  const roots = rows
    .filter(
      (row) =>
        (row.cmd.includes('scripts/dev.js') &&
          row.cmd.includes(`--remote-debugging-port=${PORT}`)) ||
        (row.cmd.includes('fake-gateway.mjs') && row.cmd.includes(`--port ${GATEWAY_PORT}`))
    )
    .map((row) => row.pid);
  const tree = treeOf(roots, rows);
  // Engines whose parent already went away still carry our scratch DSH_HOME in their cwd tree.
  const strays = rows
    .filter((row) => row.cmd.includes(path.join(repoRoot, 'src/dsh-host/host.ts')))
    .map((row) => row.pid);
  return [...new Set([...tree, ...strays])];
}

// ---- steps ------------------------------------------------------------------------

function setup() {
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(dirs.workspace, 'README.md'),
    '# P0-3 scratch workspace\n\nThrowaway; the DSH bridge point-check runs its tools here.\n'
  );
  // Local pi config for the "use this machine's configuration" route: one fake model.
  fs.writeFileSync(
    path.join(dirs.piAgent, 'models.json'),
    `${JSON.stringify(
      {
        providers: {
          p0fake: {
            baseUrl: `http://127.0.0.1:${GATEWAY_PORT}`,
            api: 'anthropic-messages',
            models: [{ id: 'fake-1', name: 'P0-3 fake model' }],
          },
        },
      },
      null,
      2
    )}\n`
  );
  fs.writeFileSync(
    path.join(dirs.piAgent, 'auth.json'),
    `${JSON.stringify({ p0fake: { type: 'api_key', key: 'p0-3-fake-key' } }, null, 2)}\n`
  );
  // Fake values only. dev.js requires an ANTHROPIC token to be present.
  fs.writeFileSync(
    envFile,
    [
      '# P0-3 GUI point-check: fake values only, never a real credential.',
      `ANTHROPIC_BASE_URL=http://127.0.0.1:${GATEWAY_PORT}`,
      'ANTHROPIC_AUTH_TOKEN=p0-3-fake-token',
      'AICLIENT_MANAGED_CREDENTIALS=0',
      'AICLIENT_DEFAULT_TEST_MODEL=p0fake/fake-1',
      `PI_CODING_AGENT_DIR=${dirs.piAgent}`,
      'AICLIENT_DEV_ENGINE=dsh',
      `AICLIENT_DSH_HOME=${dirs.dshHome}`,
      `AICLIENT_DSH_GATEWAY_URL=http://127.0.0.1:${GATEWAY_PORT}`,
      'AICLIENT_DSH_GATEWAY_KEY=p0-3-fake-key',
      '',
    ].join('\n')
  );
  const gatewayLog = fs.openSync(path.join(SCRATCH, 'gateway.out'), 'a');
  const gateway = spawn(
    process.execPath,
    [
      gatewayEntry,
      '--port',
      String(GATEWAY_PORT),
      '--plan',
      'dsh-p0-2',
      '--reset',
      '--state',
      path.join(SCRATCH, 'gateway.state.json'),
      '--log',
      path.join(SCRATCH, 'gateway.jsonl'),
      '--model-id',
      'fake-1',
    ],
    { detached: true, stdio: ['ignore', gatewayLog, gatewayLog] }
  );
  gateway.unref();
  log(`scratch ${SCRATCH}; gateway pid ${gateway.pid} on ${GATEWAY_PORT}`);
}

function launch() {
  const logFd = fs.openSync(path.join(SCRATCH, 'dev.log'), 'w');
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

async function stop() {
  // dev.js first: its own shutdown walks and stops the Electron tree. Killing
  // an engine before Electron would make WorkerManager respawn it.
  const devRoots = procList()
    .filter(
      (row) =>
        row.cmd.includes('scripts/dev.js') && row.cmd.includes(`--remote-debugging-port=${PORT}`)
    )
    .map((row) => row.pid);
  for (const pid of devRoots) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // gone
    }
  }
  await sleep(8000);
  const pids = ourProcesses();
  log(`stopping ${pids.length} remaining processes`);
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // gone
    }
  }
  await sleep(6000);
  const left = ourProcesses();
  for (const pid of left) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // gone
    }
  }
  await sleep(500);
  log(`left after SIGKILL: ${JSON.stringify(ourProcesses())}`);
}

async function attach() {
  const cdp = await Cdp.attach(PORT, 300_000);
  cdp.collectRendererProblems();
  return cdp;
}

async function enter(cdp) {
  // A fresh scratch profile starts in English; the recipes (and the screenshots
  // the users read) are Chinese, so switch the UI language first.
  const evalAsync = pc.makeEval(cdp, 'p03lang');
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
  // Late dialogs (migration prompt, announcement) — click through whatever is open.
  for (let i = 0; i < 12; i += 1) {
    const open = await cdp.evaluate(`document.querySelectorAll('[role="dialog"]').length`);
    if (!open) break;
    await cdp.evaluate(`(() => {
      const labels = ['以后再说', '知道了', '我知道了', '关闭', 'Got it', 'Later', 'Close'];
      const hit = [...document.querySelectorAll('[role="dialog"] button')]
        .find((b) => (labels.includes((b.innerText || '').trim()) || labels.includes(b.getAttribute('aria-label') || '')) && b.offsetParent !== null);
      if (hit) hit.click();
      return !!hit;
    })()`);
    await sleep(1200);
  }
  return entered;
}

const evalStore = (cdp) => pc.makeEval(cdp, 'p03');

async function activeSession(evalAsync) {
  return evalAsync(
    `const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
     const s = chat.useChatSessionsStore.getState();
     return { active: s.activeSessionId, sessions: s.sessions.map((x) => ({ id: x.id, status: x.status, title: x.title })) };`,
    { label: 'active session' }
  );
}

/**
 * The turn is over after busy (or, for a turn faster than one poll, after the
 * transcript grew past `before`), then three consecutive idle reads.
 */
async function waitTurn(evalAsync, sessionId, before, timeoutMs = 120_000) {
  const busy = new Set([
    'starting',
    'running',
    'stopping',
    'waiting_permission',
    'waiting_question',
  ]);
  const deadline = Date.now() + timeoutMs;
  let seenBusy = false;
  let idleReads = 0;
  let last = null;
  while (Date.now() < deadline) {
    last = await evalAsync(
      `const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
       const s = chat.useChatSessionsStore.getState();
       const sid = ${JSON.stringify(sessionId)} ?? s.activeSessionId;
       const session = s.sessions.find((x) => x.id === sid);
       return { sid, status: session?.status ?? null, pendingPermissions: s.pendingPermissions.length,
                messages: (s.messages[sid] ?? []).length };`,
      { label: 'turn status' }
    );
    if (busy.has(last.status) || last.messages > before + 1) seenBusy = true;
    if (busy.has(last.status)) {
      idleReads = 0;
    } else if (seenBusy) {
      idleReads += 1;
      if (idleReads >= 3) return { settled: true, ...last };
    }
    await sleep(700);
  }
  return { settled: false, ...last };
}

async function messageCount(evalAsync) {
  return evalAsync(
    `const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
     const s = chat.useChatSessionsStore.getState();
     return (s.messages[s.activeSessionId] ?? []).length;`,
    { label: 'message count' }
  );
}

async function send(cdp, text) {
  await cdp.evaluate(pc.typeIntoComposer(text));
  await cdp.waitFor(pc.SEND_READY, { timeoutMs: 30_000, label: 'send ready' });
  await cdp.evaluate(pc.CLICK_SEND);
}

async function state() {
  const cdp = await attach();
  const entered = await enter(cdp);
  const evalAsync = evalStore(cdp);
  await cdp.evaluate(pc.typeIntoComposer('P0 probe: send readiness check'));
  await sleep(800);
  const sendReadyWithText = await cdp.evaluate(pc.SEND_READY);
  await cdp.evaluate(pc.typeIntoComposer(''));
  const out = {
    entered,
    session: await activeSession(evalAsync),
    sendReadyWithText,
    dialogs: await cdp.evaluate(`document.querySelectorAll('[role="dialog"]').length`),
    body: (await cdp.evaluate('document.body.innerText')).slice(0, 1500),
    problems: cdp.problems.slice(0, 10),
  };
  await pc.shoot(cdp, shotsDir, '00-entered.png');
  cdp.close();
  console.log(JSON.stringify(out, null, 2));
}

async function run() {
  const cdp = await attach();
  await enter(cdp);
  const evalAsync = evalStore(cdp);
  const results = {};
  const summary = async (sid) => evalAsync(pc.storeSummary(sid), { label: 'store summary' });

  // Case 1: streamed text. Sample the painted assistant text while it grows.
  let before = await messageCount(evalAsync);
  await send(cdp, 'P0-STREAM: 请用流式方式回复一段文字。');
  const assistantTextLength = () =>
    evalAsync(
      `const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
       const s = chat.useChatSessionsStore.getState();
       const msgs = s.messages[s.activeSessionId] ?? [];
       const last = [...msgs].reverse().find((m) => m.role === 'assistant');
       return (last?.blocks ?? []).filter((b) => b.type === 'text').map((b) => String(b.text ?? '')).join('').length;`,
      { label: 'stream sample' }
    );
  // The first message also boots the engine; start sampling at the first painted text.
  const firstTextDeadline = Date.now() + 60_000;
  while (Date.now() < firstTextDeadline && (await assistantTextLength()) === 0) await sleep(100);
  const samples = [];
  for (let i = 0; i < 12; i += 1) {
    samples.push(await assistantTextLength());
    if (i === 4) await pc.shoot(cdp, shotsDir, '01-stream-mid.png');
    await sleep(200);
  }
  const active = (await activeSession(evalAsync)).active;
  results.stream = { samples, turn: await waitTurn(evalAsync, active, before) };
  await pc.shoot(cdp, shotsDir, '01-stream-done.png');

  // Case 2: one tool row, running then settled (bash sleeps 5 s in the middle).
  before = await messageCount(evalAsync);
  await send(cdp, 'P0-SLOWTOOL: 跑一个慢命令。');
  const toolState = () =>
    evalAsync(
      `const chat = await import(/* @vite-ignore */ '/stores/chatSessions.ts');
       const s = chat.useChatSessionsStore.getState();
       const blocks = (s.messages[s.activeSessionId] ?? []).flatMap((m) => m.blocks ?? []);
       const call = [...blocks].reverse().find((b) => b.type === 'tool_call' && b.toolName === 'bash');
       if (!call) return null;
       const result = blocks.find((b) => b.type === 'tool_result' && b.toolCallId === call.toolCallId);
       return { callId: call.toolCallId ?? call.id, settled: !!result, ok: result?.toolOk ?? null };`,
      { label: 'tool state' }
    );
  const runningDeadline = Date.now() + 60_000;
  let running = null;
  while (Date.now() < runningDeadline) {
    running = await toolState();
    if (running && !running.settled) break;
    await sleep(150);
  }
  await sleep(600);
  await pc.shoot(cdp, shotsDir, '02-tool-running.png');
  results.tool = {
    running,
    turn: await waitTurn(evalAsync, active, before),
    settled: await toolState(),
  };
  results.tool.expanded = await cdp.evaluate(pc.EXPAND_WORK_GROUPS);
  await sleep(800);
  await pc.shoot(cdp, shotsDir, '02-tool-settled.png');

  // Case 3a: approval card, allow.
  const allowTarget = path.join(dirs.outside, 'allowed.txt');
  before = await messageCount(evalAsync);
  await send(cdp, `P0-APPROVAL: 在工作区外写一个文件 path=${allowTarget}`);
  const card = await cdp.waitFor(pc.PERMISSION_CARD, {
    timeoutMs: 60_000,
    label: 'permission card',
  });
  await pc.shoot(cdp, shotsDir, '03-approval-card.png');
  await cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((n) => (n.innerText || '').trim() === '直接允许' && n.offsetParent !== null);
    b.click();
    return true;
  })()`);
  results.allow = {
    card,
    turn: await waitTurn(evalAsync, active, before),
    written: fs.existsSync(allowTarget),
  };
  await cdp.evaluate(pc.EXPAND_WORK_GROUPS);
  await sleep(800);
  await pc.shoot(cdp, shotsDir, '03-approval-allowed.png');

  // Case 3b: approval card, deny.
  const denyTarget = path.join(dirs.outside, 'denied.txt');
  before = await messageCount(evalAsync);
  await send(cdp, `P0-APPROVAL: 再在工作区外写一个文件 path=${denyTarget}`);
  const denyCard = await cdp.waitFor(pc.PERMISSION_CARD, {
    timeoutMs: 60_000,
    label: 'permission card (deny)',
  });
  await cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((n) => (n.innerText || '').trim() === '直接拒绝' && n.offsetParent !== null);
    b.click();
    return true;
  })()`);
  results.deny = {
    card: denyCard,
    turn: await waitTurn(evalAsync, active, before),
    written: fs.existsSync(denyTarget),
  };
  await cdp.evaluate(pc.EXPAND_WORK_GROUPS);
  await sleep(800);
  await pc.shoot(cdp, shotsDir, '04-approval-denied.png');

  results.store = await summary(active);
  results.problems = cdp.problems.slice(0, 20);
  pc.writeJson(shotsDir, 'p0-3-gui-result.json', results);
  cdp.close();
  console.log(JSON.stringify({ ...results, store: undefined }, null, 2));
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
    body: document.body.innerText.slice(0, 1500),
  }))()`);
  await pc.shoot(cdp, path.join(SCRATCH, 'peek'), `peek-${Date.now()}.png`);
  cdp.close();
  console.log(JSON.stringify({ ...out, problems: cdp.problems.slice(0, 10) }, null, 2));
}

const step = process.argv[2];
if (step === 'peek') await peek();
else if (step === 'setup') setup();
else if (step === 'launch') launch();
else if (step === 'state') await state();
else if (step === 'run') await run();
else if (step === 'stop') await stop();
else {
  console.error('usage: p0-3-gui.mjs setup|launch|state|peek|run|stop');
  process.exit(2);
}
// The CDP WebSocket keeps the event loop alive after close(); detached children are unref'd.
process.exit(0);
