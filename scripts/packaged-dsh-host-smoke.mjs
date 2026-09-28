/**
 * Packaged DSH host smoke (dsh-rebase P1-2, decision 017; P1-3a shared host).
 *
 *   node scripts/packaged-dsh-host-smoke.mjs --app-dir <unpacked app>
 *   node scripts/packaged-dsh-host-smoke.mjs --host-dir <dsh-host dir> [--node <node binary>]
 *        [--level 0|1] [--narb dir|default|disabled] [--scratch <dir>] [--report <file>] [--keep]
 *
 * Runs the host exactly as Main's DshHostSupervisor does in a packaged app: the
 * bundled node, `--expose-internals`, `<resources>/dsh-host/host.js`, a private
 * empty launch directory, and Main's own environment rule
 * (`buildDshHostEnvironment`, decision 022) applied to this process's
 * environment with HOME and the temp directories sandboxed. On top of that it
 * `--import`s the repo's probe hooks, which block and record non-loopback
 * connects and record every module, native addon and shared object the host
 * loads. `--narb` picks the native cache: `dir` (the default) is Main's
 * private directory, `default` the loader's own location, `disabled` none.
 *
 *   L0  boot to `ready` over IPC with the host's own pid (composition audit
 *       passed, every row active or disabled), a ping answered with a pong,
 *       `shutdown` answered with `stopped`, exit code 0. The smoke plays
 *       Main's model source (P1-5): every host is sent a model plan first (an
 *       empty one for L0) and asks for its key per request.
 *   L1  one chat session on a channel of the shared host, driven as Main's
 *       supervisor and WorkerSlot drive it (src/shared/types/dshHostProtocol.ts):
 *       worker.bootstrap, one P0-FS turn from the local fake gateway (read,
 *       edit, write, grep, glob and three shell calls: bash, or pwsh on
 *       Windows), one write outside the workspace answered through the approval
 *       card, worker.dispose (its ACK, then `closed`), `shutdown`, exit 0.
 *       The session opens in `ask`, Main's default (P1-6b part 2): the app's
 *       own gate (aiclient-permissions) asks for every write, edit and shell
 *       call, and the smoke answers each card `allow`, as a user would.
 *       Then the load-on-use natives no L1 turn reaches on every platform: the
 *       bundled node loads sharp (with libvips) and runs node-pty (conpty on
 *       Windows, spawn-helper on macOS) straight from the artifact.
 *
 * Both levels also fail on: a module or native addon resolved outside the host
 * directory (a pruning mistake would otherwise fall through to the app's own
 * resources/node_modules), any non-loopback connect or DNS lookup, a new file
 * in the host directory, and a descendant process still alive after exit.
 * Signals only ever go to the exact child this script spawned.
 */

import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// Main's model source, played the way the probes play it (P1-5, decisions 033, 034).
import { fakeGatewayPlan, serveModelPlan } from '../src/dsh-host/tools/lib/hostClient.ts';
// Main's rule itself, loaded by Node's type stripping (the module has no imports).
import { buildDshHostEnvironment } from '../src/main/services/agent-host/dshHostEnvironment.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOKS = path.join(repoRoot, 'src', 'dsh-host', 'tools', 'lib', 'probe-hooks.mjs');
const GATEWAY = path.join(repoRoot, 'src', 'dsh-host', 'tools', 'fake-gateway.mjs');
const isWindows = process.platform === 'win32';
const GENERATION = 1;
/** The one chat session's channel: `c<host generation>-<sequence>`, as the supervisor mints it. */
const CHANNEL = 'c1-1';
const SESSION = 'packaged-smoke';
const PRODUCT_BUNDLES = ['@deepseek-ai/dsh-base', '@aiclient/dsh-app'];
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

function parseArgs(argv) {
  const args = { level: 1, narb: 'dir', keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = () => {
      i += 1;
      if (argv[i] === undefined) throw new Error(`${flag} needs a value`);
      return argv[i];
    };
    if (flag === '--app-dir') args.appDir = path.resolve(value());
    else if (flag === '--host-dir') args.hostDir = path.resolve(value());
    else if (flag === '--node') args.node = path.resolve(value());
    else if (flag === '--level') args.level = Number(value());
    else if (flag === '--narb') args.narb = value();
    else if (flag === '--scratch') args.scratch = path.resolve(value());
    else if (flag === '--report') args.report = path.resolve(value());
    else if (flag === '--keep') args.keep = true;
    else throw new Error(`unknown argument: ${flag}`);
  }
  if (!['default', 'disabled', 'dir'].includes(args.narb)) throw new Error(`--narb ${args.narb}`);
  if (args.level !== 0 && args.level !== 1) throw new Error(`--level ${args.level}`);
  if (args.appDir) {
    const resources =
      process.platform === 'darwin' && args.appDir.endsWith('.app')
        ? path.join(args.appDir, 'Contents', 'Resources')
        : path.join(args.appDir, 'resources');
    args.hostDir ??= path.join(resources, 'dsh-host');
    args.node ??= path.join(resources, 'node-runtime', isWindows ? 'node.exe' : 'node');
  }
  // A source checkout's artifact runs on the fetched runtime (pnpm fetch:node-runtime).
  if (args.hostDir && !args.node) {
    args.node = path.join(repoRoot, 'out-node-runtime', isWindows ? 'node.exe' : 'node');
  }
  if (!args.hostDir || !args.node) throw new Error('pass --app-dir, or --host-dir [--node]');
  return args;
}

// ---- small helpers -------------------------------------------------------------

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const log = (message) => process.stderr.write(`[dsh-smoke] ${message}\n`);

function norm(file) {
  let real = file;
  try {
    real = fs.realpathSync.native(file);
  } catch {
    real = path.resolve(file);
  }
  return isWindows ? real.toLowerCase() : real;
}

function within(file, root) {
  const a = norm(file);
  const b = norm(root);
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : `${b}${path.sep}`);
}

function listFiles(root) {
  const out = [];
  const visit = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(path.join(dir, entry.name), childRel);
      else out.push(childRel);
    }
  };
  visit(root, '');
  return out;
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { kind: 'unparsable', line: line.slice(0, 200) };
      }
    });
}

/** Set `name`, first dropping any spelling Windows would treat as the same variable. */
function setEnvVar(env, name, value) {
  if (isWindows) {
    for (const key of Object.keys(env)) {
      if (key.toUpperCase() === name.toUpperCase()) delete env[key];
    }
  }
  env[name] = value;
}

function mkdirPrivate(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!isWindows) fs.chmodSync(dir, 0o700);
  return dir;
}

// ---- process tree ----------------------------------------------------------------

/** pid -> ppid (and a start token on Linux, so a reused pid is not mistaken for ours). */
function processTable() {
  const table = new Map();
  if (process.platform === 'linux') {
    for (const entry of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8');
        const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        table.set(Number(entry), { ppid: Number(rest[1]), start: rest[19] });
      } catch {
        // Exited between readdir and read.
      }
    }
    return table;
  }
  try {
    const text = isWindows
      ? execFileSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.Name)" }',
          ],
          { encoding: 'utf8', windowsHide: true, timeout: 30_000 }
        )
      : execFileSync('ps', ['-A', '-o', 'pid=,ppid=,comm='], { encoding: 'utf8', timeout: 10_000 });
    for (const line of text.split(/\r?\n/)) {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s*(.*)$/);
      if (match) table.set(Number(match[1]), { ppid: Number(match[2]), start: '', name: match[3] });
    }
  } catch {
    // Sampling is best effort; the post-exit check reports what it can.
  }
  return table;
}

function descendantsOf(rootPid, table) {
  const out = [];
  const queue = [rootPid];
  while (queue.length > 0) {
    const parent = queue.shift();
    for (const [pid, row] of table) {
      if (row.ppid === parent && !out.some((item) => item.pid === pid)) {
        out.push({ pid, ...row });
        queue.push(pid);
      }
    }
  }
  return out;
}

/** Remembers every descendant of `pid` seen while the host lives. */
function treeWatcher(pid) {
  const seen = new Map();
  const tick = () => {
    for (const row of descendantsOf(pid, processTable())) {
      if (!seen.has(row.pid)) seen.set(row.pid, row);
    }
  };
  // PowerShell costs about a second per sample; posix sampling is cheap.
  const timer = isWindows ? null : setInterval(tick, process.platform === 'linux' ? 250 : 1000);
  tick();
  return {
    tick,
    stop() {
      if (timer) clearInterval(timer);
      return [...seen.values()];
    },
  };
}

function alive(row) {
  if (process.platform === 'linux') {
    try {
      const stat = fs.readFileSync(`/proc/${row.pid}/stat`, 'utf8');
      return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] === row.start;
    } catch {
      return false;
    }
  }
  try {
    process.kill(row.pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/** Descendants still running after the host exited (Windows keeps parent ids of orphans). */
async function leftovers(hostPid, seen) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const extra = isWindows ? descendantsOf(hostPid, processTable()) : [];
    const rows = [...seen, ...extra.filter((row) => !seen.some((item) => item.pid === row.pid))];
    const living = rows.filter(alive);
    if (living.length === 0) return [];
    if (attempt === 9) return living.map((row) => ({ pid: row.pid, name: row.name ?? '' }));
    await sleep(500);
  }
  return [];
}

// ---- gateway ----------------------------------------------------------------------

async function startGateway(logs) {
  const child = spawn(
    process.execPath,
    [
      GATEWAY,
      '--port',
      '0',
      '--plan',
      'dsh-p0-2',
      '--reset',
      '--state',
      path.join(logs, 'gateway.state.json'),
      '--log',
      path.join(logs, 'gateway.jsonl'),
      '--model-id',
      'fake-1',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
  );
  const port = await new Promise((done, fail) => {
    let text = '';
    const timer = setTimeout(() => fail(new Error('fake gateway did not start in 15 s')), 15_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      text += chunk;
      const match = text.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timer);
        done(Number(match[1]));
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      fail(new Error(`fake gateway exited early (${code})`));
    });
  });
  return { child, port };
}

// ---- host ---------------------------------------------------------------------------

function startHost(ctx, label, extraEnv, plan, key) {
  const child = spawn(
    ctx.node,
    [
      '--expose-internals',
      '--import',
      pathToFileURL(HOOKS).href,
      path.join(ctx.hostDir, 'host.js'),
    ],
    {
      cwd: ctx.hostCwd,
      env: { ...ctx.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    }
  );
  // The host composes nothing before its plan; keys are asked for per request.
  const served = serveModelPlan(child, plan, key);
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-200_000);
  });
  child.stdout.resume();
  const exited = new Promise((done) =>
    child.once('exit', (code, signal) => done({ code, signal }))
  );
  const watcher = treeWatcher(child.pid);
  return {
    label,
    child,
    exited,
    watcher,
    served,
    stderr: () => stderr,
    started: Date.now(),
  };
}

function waitIpc(host, predicate, timeoutMs, what) {
  return new Promise((done, fail) => {
    const timer = setTimeout(() => {
      cleanup();
      fail(new Error(`${host.label}: timed out after ${timeoutMs} ms waiting for ${what}`));
    }, timeoutMs);
    const onMessage = (message) => {
      if (message?.type === 'fatal') {
        cleanup();
        fail(new Error(`${host.label}: fatal ${message.message}`));
      } else if (predicate(message)) {
        cleanup();
        done(message);
      }
    };
    const onExit = (code, signal) => {
      cleanup();
      fail(new Error(`${host.label}: exited (${code}, ${signal}) waiting for ${what}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      host.child.off('message', onMessage);
      host.child.off('exit', onExit);
    };
    host.child.on('message', onMessage);
    host.child.on('exit', onExit);
  });
}

/** `shutdown`, answered by `stopped` before the host disconnects. */
function requestShutdown(host, timeoutMs) {
  const stopped = waitIpc(host, (m) => m?.type === 'stopped', timeoutMs, 'stopped').catch(
    (error) => ({ error: String(error) })
  );
  host.child.send({ type: 'shutdown' });
  return stopped;
}

async function ping(host, id) {
  const answer = waitIpc(host, (m) => m?.host === 'pong' && m.id === id, 15_000, 'pong');
  host.child.send({ host: 'ping', id });
  return answer;
}

async function stopHost(host, timeoutMs) {
  const exit = await Promise.race([host.exited, sleep(timeoutMs).then(() => null)]);
  if (exit === null) {
    host.child.kill('SIGKILL');
    return { ...(await host.exited), forced: true };
  }
  return exit;
}

/** One chat session: worker RPC inside `{ch, rpc}` envelopes of one channel. */
class WorkerClient {
  constructor(child, ch) {
    this.child = child;
    this.ch = ch;
    this.seq = 0;
    this.events = [];
    this.waiters = new Set();
    this.permissions = [];
    this.autoAllow = true;
    this.closed = false;
    child.on('message', (message) => {
      if (message?.host === 'closed' && message.ch === ch) this.closed = true;
      const rpc = message?.ch === ch ? message.rpc : undefined;
      if (rpc?.kind === 'event' && rpc.type === 'runtime.event') {
        this.events.push(rpc.payload);
        if (rpc.payload?.type === 'permission.requested' && this.autoAllow) {
          const payload = rpc.payload.payload ?? {};
          this.permissions.push({ toolName: payload.toolName, permissionId: payload.permissionId });
          void this.call('worker.permission.respond', {
            logicalSessionId: SESSION,
            permissionId: payload.permissionId,
            decision: 'allow',
          });
        }
      }
      for (const wake of [...this.waiters]) wake();
    });
  }

  call(type, payload, timeoutMs = 60_000) {
    const requestId = `smoke-${++this.seq}`;
    return new Promise((done, fail) => {
      const timer = setTimeout(() => {
        this.child.off('message', onMessage);
        fail(new Error(`${type} timed out`));
      }, timeoutMs);
      const onMessage = (message) => {
        const rpc = message?.ch === this.ch ? message.rpc : undefined;
        if (rpc?.kind !== 'response' || rpc.requestId !== requestId) return;
        clearTimeout(timer);
        this.child.off('message', onMessage);
        done(rpc);
      };
      this.child.on('message', onMessage);
      this.child.send({
        ch: this.ch,
        rpc: {
          protocolVersion: 1,
          kind: 'request',
          generation: GENERATION,
          requestId,
          type,
          payload,
        },
      });
    });
  }

  /** Resolves once the host has sent `closed` for this channel. */
  untilClosed(timeoutMs) {
    return this.until(() => this.closed, timeoutMs);
  }

  until(predicate, timeoutMs) {
    if (predicate(this.events)) return Promise.resolve(true);
    return new Promise((done) => {
      const timer = setTimeout(() => {
        this.waiters.delete(check);
        done(false);
      }, timeoutMs);
      const check = () => {
        if (!predicate(this.events)) return;
        clearTimeout(timer);
        this.waiters.delete(check);
        done(true);
      };
      this.waiters.add(check);
    });
  }
}

const payloadOf = (event) => event?.payload ?? {};

async function runTurn(client, label, text, timeoutMs) {
  const requestId = `turn-${label}`;
  const from = client.events.length;
  const sent = await client.call('worker.send', {
    logicalSessionId: SESSION,
    requestId,
    attemptId: `attempt-${label}`,
    text,
  });
  if (!sent.ok) throw new Error(`worker.send ${label}: ${JSON.stringify(sent.error)}`);
  const idle = await client.until(
    (events) =>
      events
        .slice(from)
        .some(
          (e) =>
            e.type === 'session.status' &&
            payloadOf(e).status === 'idle' &&
            e.requestId === requestId
        ),
    timeoutMs
  );
  const events = client.events.slice(from);
  const names = new Map(
    events
      .filter((e) => e.type === 'tool.started')
      .map((e) => [payloadOf(e).toolCallId, payloadOf(e).name])
  );
  const tools = events
    .filter((e) => e.type === 'tool.completed')
    .map((e) => {
      const p = payloadOf(e);
      const text = String(p.output ?? p.error ?? '');
      return { name: names.get(p.toolCallId) ?? '?', ok: p.ok === true, text };
    });
  const assistant = new Set(
    events
      .filter((e) => e.type === 'message.started' && payloadOf(e).role === 'assistant')
      .map((e) => payloadOf(e).messageId)
  );
  const reply = events
    .filter((e) => e.type === 'message.delta' && assistant.has(payloadOf(e).messageId))
    .map((e) => String(payloadOf(e).text))
    .join('');
  return {
    idle,
    completed: events.some((e) => e.type === 'session.completed'),
    tools,
    reply: reply.slice(0, 400),
    permissions: events
      .filter((e) => e.type === 'permission.requested')
      .map((e) => payloadOf(e).toolName),
    resolved: events
      .filter((e) => e.type === 'permission.resolved')
      .map((e) => payloadOf(e).decision),
    errors: events
      .filter((e) => e.type === 'session.error' || e.type === 'error')
      .map((e) => payloadOf(e)),
  };
}

// ---- levels ---------------------------------------------------------------------------

async function level0(ctx) {
  const host = startHost(ctx, 'L0', {}, fakeGatewayPlan({ routes: [] }), {});
  const result = { label: 'L0' };
  try {
    const ready = await waitIpc(host, (m) => m?.type === 'ready', 180_000, 'ready');
    host.watcher.tick();
    result.readyMs = Date.now() - host.started;
    result.ready = {
      pid: ready.pid,
      spawnedPid: host.child.pid,
      node: ready.node,
      execPath: ready.execPath,
      artifact: ready.artifact,
      bundles: ready.bundles,
      skippedPlugins: ready.skippedPlugins,
      census: ready.census,
      composition: ready.composition,
      marks: ready.marks,
      revision: ready.revision,
      routeDiagnostics: ready.routeDiagnostics,
    };
    result.pong = await ping(host, 1);
    result.stopped = await requestShutdown(host, 30_000);
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }
  result.exit = await stopHost(host, 30_000);
  result.leftovers = await leftovers(host.child.pid, host.watcher.stop());
  result.stderrTail = host.stderr().slice(-3000);
  return result;
}

async function level1(ctx, gateway) {
  // One route to the local fake, and its fake key per request (P1-5).
  const plan = fakeGatewayPlan({ baseUrl: `http://127.0.0.1:${gateway.port}` });
  const host = startHost(ctx, 'L1', {}, plan, 'packaged-smoke-fake-key');
  const client = new WorkerClient(host.child, CHANNEL);
  const result = { label: 'L1' };
  const marker = `P12-MARKER-${randomBytes(4).toString('hex')}`;
  const token = randomBytes(3).toString('hex');
  const shell = isWindows ? 'pwsh' : 'bash';
  const outsideFile = path.join(ctx.outside, 'approved.txt');
  try {
    // As the supervisor does: the channel opens once the host is ready.
    const ready = await waitIpc(host, (m) => m?.type === 'ready', 180_000, 'ready');
    result.readyMs = Date.now() - host.started;
    host.watcher.tick();
    result.ready = {
      pid: ready.pid,
      spawnedPid: host.child.pid,
      execPath: ready.execPath,
      artifact: ready.artifact,
      bundles: ready.bundles,
      census: ready.census,
      revision: ready.revision,
      routeDiagnostics: ready.routeDiagnostics,
    };
    result.planRevision = plan.revision;
    const boot = await client.call(
      'worker.bootstrap',
      { logicalSessionId: SESSION, cwd: ctx.workspace },
      180_000
    );
    result.bootstrap = boot.ok
      ? { bootstrapped: boot.result?.bootstrapped }
      : { error: boot.error };
    if (!boot.ok) throw new Error(`worker.bootstrap: ${JSON.stringify(boot.error)}`);

    fs.writeFileSync(path.join(ctx.workspace, 'marker.txt'), `${marker} plaintext line\n`);
    fs.writeFileSync(path.join(ctx.workspace, 'edit-target.txt'), `${marker} edit target\n`);
    const params = { tag: 'l1', dir: ctx.workspace, marker, token, shell };
    result.fs = await runTurn(client, 'fs', `P0-FS ${JSON.stringify(params)}`, 240_000);
    host.watcher.tick();
    const read = (name) => {
      try {
        return fs.readFileSync(path.join(ctx.workspace, name), 'utf8');
      } catch {
        return null;
      }
    };
    result.fs.files = {
      written: read(`dsh-written-${token}.txt`),
      shellWritten: read(`shell-written-${token}.txt`),
      edited: read('edit-target.txt'),
    };
    result.fs.marker = marker;
    result.fs.token = token;
    result.fs.shell = shell;
    // A card the user answers, not a pre-approved path.
    result.approval = await runTurn(
      client,
      'approval',
      `P0-APPROVAL: write outside, path=${outsideFile}`,
      120_000
    );
    result.approval.fileWritten = fs.existsSync(outsideFile);
    result.autoAnswered = client.permissions;
    const disposed = await client.call('worker.dispose', { reason: 'slot-dispose' }, 60_000);
    result.dispose = disposed.ok ? disposed.result : { error: disposed.error };
    result.channelClosed = await client.untilClosed(15_000);
    result.stopped = await requestShutdown(host, 30_000);
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }
  result.credentials = {
    requests: host.served.requests.length,
    outcomes: [...new Set(host.served.requests.map((item) => item.outcome))],
  };
  result.exit = await stopHost(host, 30_000);
  result.leftovers = await leftovers(host.child.pid, host.watcher.stop());
  result.stderrTail = host.stderr().slice(-3000);
  return result;
}

// ---- natives no turn reaches ---------------------------------------------------------------

/**
 * sharp + libvips (read_image needs an image-capable route the P1 gateway model
 * does not declare) and node-pty (the shell tool does not use a PTY on Linux),
 * loaded by the bundled node from the artifact with the same hooks.
 */
async function nativeProbe(ctx) {
  const script = `
    import { createRequire } from 'node:module';
    const req = createRequire(${JSON.stringify(path.join(ctx.hostDir, 'package.json'))});
    const out = {};
    const sharp = req('sharp');
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#336699' } }).png().toBuffer();
    out.sharp = { pngBytes: png.length, libvips: sharp.versions?.vips ?? null };
    const pty = req('node-pty');
    const [file, args] = process.platform === 'win32'
      ? [process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'echo pty-ok']]
      : ['/bin/sh', ['-c', 'echo pty-ok']];
    out.pty = await new Promise((done) => {
      let text = '';
      const term = pty.spawn(file, args, { cols: 80, rows: 10, cwd: ${JSON.stringify(ctx.workspace)}, env: process.env });
      const timer = setTimeout(() => { try { term.kill(); } catch {} done({ text, timedOut: true }); }, 20000);
      term.onData((chunk) => { text += chunk; });
      term.onExit(({ exitCode }) => { clearTimeout(timer); done({ text: text.slice(-200), exitCode }); });
    });
    process.stdout.write(JSON.stringify(out));
  `;
  const hookLog = path.join(path.dirname(ctx.hookLog), 'natives-hooks.jsonl');
  const child = spawn(
    ctx.node,
    ['--import', pathToFileURL(HOOKS).href, '--input-type=module', '-e', script],
    {
      cwd: ctx.workspace,
      env: { ...ctx.env, AICLIENT_PROBE_HOOK_LOG: hookLog },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }
  );
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  const exited = new Promise((done) =>
    child.once('exit', (code, signal) => done({ code, signal }))
  );
  const watcher = treeWatcher(child.pid);
  const exit = await Promise.race([exited, sleep(60_000).then(() => null)]);
  if (exit === null) child.kill('SIGKILL');
  const result = { exit: exit ?? { ...(await exited), forced: true }, hookLog };
  try {
    Object.assign(result, JSON.parse(stdout));
  } catch {
    result.error = `no result: ${stdout.slice(-300)} ${stderr}`;
  }
  result.leftovers = await leftovers(child.pid, watcher.stop());
  return result;
}

// ---- analysis ------------------------------------------------------------------------------

function narbRoot(ctx) {
  if (ctx.narb === 'disabled') return null;
  if (ctx.narb === 'dir') return ctx.narbDir;
  if (isWindows)
    return path.join(ctx.env.LOCALAPPDATA ?? '', 'node-addon-native-custom-loader', 'native-cache');
  const uid = typeof process.getuid === 'function' ? String(process.getuid()) : 'nouid';
  return path.join(ctx.env.TMPDIR, `node-addon-native-custom-loader-${uid}`, 'native-cache');
}

/**
 * The program a spawn record runs. With a user systemd session (Main's
 * environment carries XDG_RUNTIME_DIR and DBus, decision 022) DSH launches a
 * tool as `systemd-run … -- <runner> -- <tool argv>`: the tool is the first
 * word after the second `--` (the tool's own argv may hold more).
 */
function toolOf(record) {
  const args = Array.isArray(record.args) ? record.args : [];
  const first = args.indexOf('--');
  const second = first < 0 ? -1 : args.indexOf('--', first + 1);
  return /(^|[\\/])systemd-run$/.test(String(record.file ?? '')) && second >= 0
    ? args[second + 1]
    : record.file;
}

function analyzeHooks(ctx, hostNatives, extraLogs = []) {
  const records = [ctx.hookLog, ...extraLogs].flatMap((file) => readJsonl(file));
  const modules = records.filter((r) => r.kind === 'module').map((r) => r.url);
  const outsideModules = [];
  const otherSchemes = new Set();
  for (const url of modules) {
    if (url.startsWith('node:')) continue;
    if (!url.startsWith('file:')) {
      otherSchemes.add(url.slice(0, url.indexOf(':')));
      continue;
    }
    const file = fileURLToPath(url);
    if (!within(file, ctx.hostDir)) outsideModules.push(file);
  }
  const root = narbRoot(ctx);
  const dlopen = [...new Set(records.filter((r) => r.kind === 'dlopen').map((r) => r.filename))];
  const nativeVerdicts = dlopen.map((file) => {
    const clean = file.replace(/^\\\\\?\\/, '');
    if (within(clean, ctx.hostDir)) return { file: clean, where: 'host' };
    if (root && within(clean, root)) {
      let digest = null;
      try {
        digest = sha256(clean);
      } catch {
        // Gone already; judged as unverified below.
      }
      return {
        file: clean,
        where: hostNatives.has(digest) ? 'narb-cache' : 'narb-cache-unverified',
      };
    }
    return { file: clean, where: 'outside' };
  });
  const shared = records.filter((r) => r.kind === 'shared-objects').flatMap((r) => r.list ?? []);
  const sharedOutside = [
    ...new Set(
      shared.filter(
        (file) =>
          /\.node$|libvips|koffi|conpty|pty/i.test(file) &&
          !within(file, ctx.hostDir) &&
          !(root && within(file, root))
      )
    ),
  ];
  const spawns = records
    .filter((r) => r.kind === 'spawn' || r.kind === 'spawn-sync')
    .map((r) => ({
      file: r.file,
      target: toolOf(r),
      args: Array.isArray(r.args) ? r.args.slice(0, 4) : undefined,
    }));
  const rg = spawns.filter((item) => /(^|[\\/])rg(\.exe)?$/i.test(String(item.target ?? '')));
  return {
    moduleCount: modules.length,
    outsideModules,
    otherSchemes: [...otherSchemes],
    moduleHooks: !records.some((r) => r.kind === 'module-hooks-unavailable'),
    natives: nativeVerdicts,
    sharedObjectsOutside: sharedOutside,
    netBlocked: records.filter((r) => r.kind === 'net-blocked').map((r) => `${r.host}:${r.port}`),
    dnsLookups: [
      ...new Set(
        records
          .filter((r) => r.kind === 'dns-lookup')
          .map((r) => r.hostname)
          .filter((h) => !LOOPBACK.has(h))
      ),
    ],
    ripgrep: rg.map((item) => item.target),
    spawnedExecutables: [...new Set(spawns.map((item) => item.file))].slice(0, 30),
  };
}

function verdictFor(ctx, report) {
  const v = {};
  const l0 = report.L0;
  if (l0) {
    v.l0Ready = l0.ready !== undefined && !l0.error;
    v.l0ReadyOwnPid = l0.ready?.pid !== undefined && l0.ready.pid === l0.ready.spawnedPid;
    v.l0Packaged = l0.ready?.artifact?.form === 'packaged';
    v.l0Composition =
      JSON.stringify(l0.ready?.bundles) === JSON.stringify(PRODUCT_BUNDLES) &&
      Array.isArray(l0.ready?.census?.inactive) &&
      l0.ready.census.inactive.length === 0;
    v.l0BundledNode =
      l0.ready?.execPath !== undefined && norm(l0.ready.execPath) === norm(ctx.node);
    v.l0Pong =
      l0.pong?.host === 'pong' &&
      Array.isArray(l0.pong.channels) &&
      l0.pong.channels.length === 0 &&
      l0.pong.rssMb > 0;
    v.l0EmptyPlan =
      typeof l0.ready?.revision === 'string' && JSON.stringify(l0.ready?.routeDiagnostics) === '[]';
    v.l0Stopped = l0.stopped?.type === 'stopped';
    v.l0ExitedZero = l0.exit?.code === 0 && !l0.exit?.forced;
    v.l0NoLeftovers = (l0.leftovers ?? []).length === 0;
  }
  const l1 = report.L1;
  if (l1) {
    const fsTurn = l1.fs ?? {};
    const tools = fsTurn.tools ?? [];
    const used = new Set(tools.map((tool) => tool.name));
    const shell = fsTurn.shell;
    const marker = fsTurn.marker ?? '\u0000';
    const toolText = (name) =>
      tools
        .filter((tool) => tool.name === name)
        .map((tool) => tool.text)
        .join('\n');
    v.l1Bootstrapped = l1.bootstrap?.bootstrapped === true && !l1.error;
    v.l1ReadyOwnPid = l1.ready?.pid !== undefined && l1.ready.pid === l1.ready.spawnedPid;
    v.l1Packaged = l1.ready?.artifact?.form === 'packaged';
    v.l1RunsPlan =
      l1.ready?.revision === l1.planRevision && JSON.stringify(l1.ready?.routeDiagnostics) === '[]';
    v.l1KeysPulledPerRequest =
      (l1.credentials?.requests ?? 0) > 0 &&
      JSON.stringify(l1.credentials?.outcomes) === '["served"]';
    v.l1FsTurnIdle = fsTurn.idle === true && fsTurn.completed === true;
    v.l1FsTools = ['read', 'edit', 'write', 'grep', 'glob', shell].every((name) => used.has(name));
    // The P0-FS script: read x4, edit, write, grep, glob, three shell calls, read.
    v.l1FsToolsOk = tools.length >= 12 && tools.every((tool) => tool.ok);
    v.l1ReadSawMarker = toolText('read').includes(marker);
    v.l1GrepSawMarker = toolText('grep').includes(marker);
    v.l1ShellSawMarker = toolText(shell).includes(marker);
    v.l1FilesWritten =
      String(fsTurn.files?.written).includes(`WRITTEN-${fsTurn.token}`) &&
      String(fsTurn.files?.shellWritten).includes(`SHELL-${fsTurn.token}`) &&
      String(fsTurn.files?.edited).includes(`EDITED-${fsTurn.token}`);
    v.l1FsReplied = String(fsTurn.reply).includes('P0-FS l1 finished.');
    // P1-6b part 2: the packaged host's own gate asked, and every card came back.
    v.l1GateAskedEachChange =
      ['edit', 'write', shell].every((name) => (fsTurn.permissions ?? []).includes(name)) &&
      (fsTurn.resolved ?? []).length === (fsTurn.permissions ?? []).length &&
      (fsTurn.resolved ?? []).every((decision) => decision === 'allow');
    v.l1ApprovalRoundTrip =
      (l1.approval?.permissions ?? []).includes('write') &&
      (l1.approval?.resolved ?? []).includes('allow') &&
      l1.approval?.fileWritten === true &&
      l1.approval?.idle === true;
    v.l1Disposed = l1.dispose !== undefined && !l1.dispose.error;
    v.l1ChannelClosed = l1.channelClosed === true;
    v.l1Stopped = l1.stopped?.type === 'stopped';
    v.l1ExitedZero = l1.exit?.code === 0 && !l1.exit?.forced;
    v.l1NoLeftovers = (l1.leftovers ?? []).length === 0;
    v.l1RipgrepFromArtifact =
      report.hooks.ripgrep.length > 0 &&
      report.hooks.ripgrep.every((file) => within(file, ctx.hostDir));
    const natives = report.natives ?? {};
    v.nativesSharpLoaded =
      natives.sharp?.pngBytes > 0 && typeof natives.sharp?.libvips === 'string';
    v.nativesPtyRan = String(natives.pty?.text).includes('pty-ok') && natives.pty?.exitCode === 0;
    v.nativesExitedZero = natives.exit?.code === 0 && (natives.leftovers ?? []).length === 0;
  }
  const hooks = report.hooks;
  v.moduleHooksActive = hooks.moduleHooks && hooks.moduleCount > 0;
  v.modulesInsideHost = hooks.outsideModules.length === 0;
  v.nativesInsideHost =
    hooks.natives.length > 0 &&
    hooks.natives.every((item) => item.where === 'host' || item.where === 'narb-cache');
  v.sharedObjectsInsideHost = hooks.sharedObjectsOutside.length === 0;
  v.noNetwork = hooks.netBlocked.length === 0 && hooks.dnsLookups.length === 0;
  v.hostDirUnchanged = report.hostDir.added.length === 0 && report.hostDir.removed.length === 0;
  const narb = hooks.natives.find((item) => /node-addon-require-builtin/.test(item.file));
  v.narbForm =
    narb !== undefined &&
    (ctx.narb === 'disabled'
      ? narb.where === 'host'
      : narb.where === 'narb-cache' && within(narb.file, narbRoot(ctx)));
  return v;
}

// ---- main --------------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const file of [path.join(args.hostDir, 'host.js'), args.node, HOOKS, GATEWAY]) {
    if (!fs.existsSync(file)) throw new Error(`missing ${file}`);
  }
  const base = process.platform === 'linux' && fs.existsSync('/var/tmp') ? '/var/tmp' : os.tmpdir();
  const scratch = mkdirPrivate(
    args.scratch ?? fs.mkdtempSync(path.join(base, 'aiclient-dsh-smoke-'))
  );
  const dirs = Object.fromEntries(
    [
      'home',
      'tmp',
      'appdata',
      'localappdata',
      'dsh-home',
      'host-cwd',
      'workspace',
      'outside',
      'logs',
      'narb-cache',
    ].map((name) => [name, mkdirPrivate(path.join(scratch, name))])
  );
  // Main's rule (decision 022) over this process's environment, with HOME and
  // the temp directories moved into the scratch tree first.
  const inherited = { ...process.env };
  const sandboxed = {
    HOME: dirs.home,
    TMPDIR: dirs.tmp,
    TEMP: dirs.tmp,
    TMP: dirs.tmp,
    ...(isWindows
      ? { USERPROFILE: dirs.home, APPDATA: dirs.appdata, LOCALAPPDATA: dirs.localappdata }
      : {}),
  };
  for (const [name, value] of Object.entries(sandboxed)) setEnvVar(inherited, name, value);
  const env = buildDshHostEnvironment({
    dshHome: dirs['dsh-home'],
    nativeCacheDir: dirs['narb-cache'],
    isPackaged: true,
    env: inherited,
  });
  // The smoke's own instrumentation: app-internal names, which Main's rule strips.
  Object.assign(env, {
    AICLIENT_PROBE_HOOK_LOG: path.join(dirs.logs, 'hooks.jsonl'),
    AICLIENT_PROBE_MODULE_LOG: '1',
  });
  if (args.narb !== 'dir') delete env.NARB_NATIVE_CACHE_DIR;
  if (args.narb === 'disabled') env.NARB_DISABLE_NATIVE_CACHE = '1';

  const ctx = {
    hostDir: args.hostDir,
    node: args.node,
    dshHome: dirs['dsh-home'],
    hostCwd: dirs['host-cwd'],
    workspace: dirs.workspace,
    outside: dirs.outside,
    hookLog: env.AICLIENT_PROBE_HOOK_LOG,
    env,
    narb: args.narb,
    narbDir: dirs['narb-cache'],
  };
  const before = new Set(listFiles(args.hostDir));
  const hostNatives = new Set(
    [...before]
      .filter((rel) => /\.node$/.test(rel))
      .map((rel) => sha256(path.join(args.hostDir, ...rel.split('/'))))
  );
  const report = {
    smoke: 'packaged-dsh-host',
    level: args.level,
    narb: args.narb,
    platform: `${process.platform}-${process.arch}`,
    hostDir: { path: args.hostDir, files: before.size },
    node: {
      path: args.node,
      version: execFileSync(args.node, ['--version'], { encoding: 'utf8' }).trim(),
    },
    scratch,
    startedAt: new Date().toISOString(),
  };
  log(
    `host ${args.hostDir} on ${args.node} (${report.node.version}), level ${args.level}, NARB ${args.narb}`
  );

  let gateway;
  try {
    report.L0 = await level0(ctx);
    log(
      `L0: ready ${report.L0.readyMs ?? '-'} ms, exit ${JSON.stringify(report.L0.exit)}${report.L0.error ? `, ${report.L0.error}` : ''}`
    );
    if (args.level >= 1) {
      gateway = await startGateway(dirs.logs);
      report.L1 = await level1(ctx, gateway);
      log(
        `L1: ${report.L1.fs?.tools?.length ?? 0} tool calls, exit ${JSON.stringify(report.L1.exit)}${report.L1.error ? `, ${report.L1.error}` : ''}`
      );
      report.natives = await nativeProbe(ctx);
      log(
        `natives: sharp ${JSON.stringify(report.natives.sharp ?? null)}, pty ${JSON.stringify(report.natives.pty?.exitCode ?? null)}${report.natives.error ? `, ${report.natives.error}` : ''}`
      );
    }
  } finally {
    gateway?.child.kill();
  }
  const after = new Set(listFiles(args.hostDir));
  report.hostDir.added = [...after].filter((rel) => !before.has(rel)).slice(0, 20);
  report.hostDir.removed = [...before].filter((rel) => !after.has(rel)).slice(0, 20);
  report.hooks = analyzeHooks(ctx, hostNatives, report.natives ? [report.natives.hookLog] : []);
  report.verdict = verdictFor(ctx, report);
  report.ok = Object.values(report.verdict).every(Boolean);
  report.finishedAt = new Date().toISOString();

  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (args.report) {
    fs.mkdirSync(path.dirname(args.report), { recursive: true });
    fs.writeFileSync(args.report, json);
  }
  const failed = Object.entries(report.verdict)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  log(
    `${report.ok ? 'PASS' : 'FAIL'} — ${Object.keys(report.verdict).length} checks${failed.length ? `, failed: ${failed.join(', ')}` : ''}`
  );
  process.stdout.write(
    `${JSON.stringify({ ok: report.ok, failed, report: args.report ?? null })}\n`
  );
  if (!args.keep) fs.rmSync(scratch, { recursive: true, force: true });
  else log(`kept ${scratch}`);
  process.exitCode = report.ok ? 0 : 1;
}

try {
  await main();
} catch (error) {
  log(`ERROR ${error instanceof Error ? error.stack : error}`);
  process.exitCode = 2;
}
