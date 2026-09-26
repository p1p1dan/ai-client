/**
 * P0-4 node-side probe for the TEC/TSD-encrypted Windows machine (dsh-rebase plan).
 *
 *   node.exe p0-4-probe.ts --work <dir> --marker <text> --out <report.json>
 *            [--gateway <fake-gateway.mjs>] [--git-bash <bash.exe>] [--skip-pnpm]
 *            [--log <file>] [--make-markers] [--self-clean]
 *   node.exe p0-4-probe.ts --control --work <dir> --marker <text> --out <report.json>
 *            [--port 18484] [--shell pwsh|bash]     (official DSH Desktop control group)
 *
 * Runs under the app's bundled node.exe (the whitelisted carrier) and drives the
 * DSH host of this kit. `--work` is a fresh directory inside the encrypted policy
 * directory; `run-p0-4.ps1` creates it and writes the marker files with
 * PowerShell before calling this script:
 *
 *   <work>\marker.txt, <work>\ws-on\{marker,edit-target}.txt, <work>\ws-off\{...}
 *
 * each holding `--marker`. Every check compares what came back with that
 * marker, so a result is plaintext / ciphertext (`%TSD-Header-###%`) / other,
 * not just success. Model turns go only to the local fake gateway this script
 * starts (plan dsh-p0-2); the probe hooks block every non-loopback connect of
 * the host. The only other network user is pnpm during the plugin install,
 * which is skipped when the registry is unreachable.
 *
 * Output: one JSON report (`--out`) with `checks[]` (id, status, observed),
 * `inspect[]` (files for the PowerShell side to head-check) and `cleanup[]`
 * (paths created outside `--work`); the last two also go to `<out>.inspect.json`. The script deletes nothing unless
 * `--self-clean` (Linux dry run); on Windows run-p0-4.ps1 cleans after its
 * head checks. `--make-markers` writes the marker files itself (Linux dry run,
 * where there is no PowerShell and no encryption).
 */

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';
import { captureStderr, exitOf, round, sleep, stopWithin, waitMessage } from './lib/kit.ts';

const here = dirname(fileURLToPath(import.meta.url));
const isWin = process.platform === 'win32';
const TSD_MAGIC = '%TSD-Header-###%';
const PLUGIN = 'dsh-office-tools@1.0.4';
const REGISTRY = 'https://registry.npmjs.org/';
const FS_STEPS = 12;

// ---- arguments -------------------------------------------------------------

const argv = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};
const flag = (name: string) => argv.includes(`--${name}`);
const required = (name: string): string => {
  const value = option(name);
  if (value === undefined || value === '') {
    process.stderr.write(`[p0-4] --${name} is required\n`);
    process.exit(2);
  }
  return value;
};

const work = resolve(required('work'));
const marker = required('marker');
const outFile = resolve(required('out'));
const gatewayEntry =
  option('gateway') ??
  [
    join(here, '..', 'gateway', 'fake-gateway.mjs'),
    join(
      here,
      '..',
      '..',
      'docs/plantree/plans/runtime-hardening/evidence/batch-e-devbox-2026-09-17/tools/fake-gateway.mjs'
    ),
  ].find((file) => existsSync(file)) ??
  '';
const hostEntry = join(here, 'host.ts');
const hooksUrl = pathToFileURL(join(here, 'lib', 'probe-hooks.mjs')).href;
const pnpmCli = join(here, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs');
const skipPnpm = flag('skip-pnpm');
const logs = join(work, 'logs');
const dshHome = join(work, 'dsh-home');
const hostCwd = join(work, 'host-cwd');
const t0 = performance.now();
const logFile = option('log');
const log = (message: string) => {
  const line = `[p0-4 ${round((performance.now() - t0) / 1000, 1)}s] ${message}\n`;
  process.stderr.write(line);
  if (logFile) {
    try {
      appendFileSync(logFile, line);
    } catch {
      // The console copy is enough.
    }
  }
};

// ---- report ----------------------------------------------------------------

type Status = 'pass' | 'fail' | 'skip' | 'info' | 'error';
interface Check {
  id: string;
  group: string;
  title: string;
  status: Status;
  observed: string;
  detail?: unknown;
}
const checks: Check[] = [];
const inspect: Array<{ path: string; role: string }> = [];
const cleanup: string[] = [];
const report: Record<string, unknown> = {
  probe: 'dsh-rebase P0-4',
  startedAt: new Date().toISOString(),
  platform: `${process.platform}-${process.arch}`,
  node: process.version,
  execPath: process.execPath,
  work,
  marker,
  checks,
  inspect,
  cleanup,
};

function check(
  id: string,
  group: string,
  title: string,
  status: Status,
  observed: string,
  detail?: unknown
) {
  checks.push({ id, group, title, status, observed, ...(detail === undefined ? {} : { detail }) });
  log(`${status.toUpperCase().padEnd(5)} ${id} ${title}: ${observed}`);
}

function saveReport() {
  report.finishedAt = new Date().toISOString();
  report.elapsedS = round((performance.now() - t0) / 1000, 1);
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
  // Small side file for the PowerShell half: what to head-check and delete.
  writeFileSync(
    outFile.replace(/\.json$/, '.inspect.json'),
    `${JSON.stringify({ inspect, cleanup, work }, null, 2)}\n`
  );
}

// ---- content classification -------------------------------------------------

type Seen = 'plaintext' | 'ciphertext' | 'other' | 'missing';

/** Plaintext when the expected text is there, ciphertext when the TSD header is. */
function classify(content: string | Buffer | undefined, expect: string): Seen {
  if (content === undefined) return 'missing';
  const text = Buffer.isBuffer(content) ? content.toString('latin1') : content;
  if (text.includes(expect)) return 'plaintext';
  if (text.includes(TSD_MAGIC)) return 'ciphertext';
  return 'other';
}

const clip = (value: unknown, max = 160) => {
  const text =
    value !== null && typeof value === 'object' && !(value instanceof Error)
      ? JSON.stringify(value)
      : String(value ?? '');
  return JSON.stringify(text.slice(0, max)).replace(/^"|"$/g, '');
};

function nodeRead(path: string): Buffer | undefined {
  try {
    return readFileSync(path);
  } catch {
    return undefined;
  }
}

function seenCheck(
  id: string,
  group: string,
  title: string,
  content: string | Buffer | undefined,
  expect: string
) {
  const seen = classify(content, expect);
  const text = Buffer.isBuffer(content) ? content.toString('latin1') : (content ?? '');
  check(id, group, title, seen === 'plaintext' ? 'pass' : 'fail', `${seen}: ${clip(text)}`);
  return seen;
}

// ---- environment -----------------------------------------------------------

const SCRUB = /(API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i;

/** The user's environment minus credentials and DSH / probe knobs, plus ours. */
function hostEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/^(DSH_|NARB_|AICLIENT_)/i.test(key) || SCRUB.test(key)) continue;
    env[key] = value;
  }
  return {
    ...env,
    DSH_HOME: dshHome,
    DSH_TELEMETRY_DISABLED: '1',
    AICLIENT_DSH_GATEWAY_URL: `http://127.0.0.1:${gatewayPort}`,
    AICLIENT_DSH_GATEWAY_KEY: 'p0-4-fake-gateway-key',
    AICLIENT_PROBE_EVENT_LOG: join(logs, 'events.jsonl'),
    AICLIENT_PROBE_HOOK_LOG: join(logs, 'hooks.jsonl'),
    AICLIENT_DSH_PNPM_CLI: pnpmCli,
    ...extra,
  };
}

function listDir(dir: string | undefined): string[] {
  if (!dir) return [];
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Every file below `dir` (depth-limited), for session logs, spill files and plugins. */
function walk(dir: string, depth = 8, out: string[] = []): string[] {
  if (depth < 0) return out;
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, depth - 1, out);
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

function narbDefaultRoot(): string {
  if (isWin && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, 'node-addon-native-custom-loader', 'native-cache');
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'unknown';
  return join(os.tmpdir(), `node-addon-native-custom-loader-${uid}`, 'native-cache');
}

// ---- gateway ---------------------------------------------------------------

let gatewayPort = 0;
let gatewayChild: ChildProcess | undefined;
const gatewayLog = join(logs, 'gateway.jsonl');

async function startGateway(port = 0) {
  const child = spawn(
    process.execPath,
    [
      gatewayEntry,
      '--port',
      String(port),
      '--plan',
      'dsh-p0-2',
      '--reset',
      '--state',
      join(logs, 'gateway.state.json'),
      '--log',
      gatewayLog,
      '--model-id',
      'fake-1',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
  );
  gatewayChild = child;
  gatewayPort = await new Promise<number>((done, fail) => {
    let text = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      text += chunk;
      const match = text.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) done(Number(match[1]));
    });
    child.once('exit', (code) => fail(new Error(`fake gateway exited early (${code})`)));
    setTimeout(() => fail(new Error('fake gateway did not start in 15 s')), 15_000);
  });
}

function gatewayLines(): Array<Record<string, unknown>> {
  const text = nodeRead(gatewayLog)?.toString('utf8') ?? '';
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return { unparsable: line.slice(0, 200) };
      }
    });
}

const decisionOf = (line: Record<string, unknown>) => String(line.decision ?? '');

async function waitForGateway(prefix: string, timeoutMs: number) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (gatewayLines().some((line) => decisionOf(line).startsWith(prefix))) return true;
    await sleep(250);
  }
  return false;
}

// ---- hosts -----------------------------------------------------------------

interface Host {
  label: string;
  child: ChildProcess;
  stderr: () => string;
  exited: Promise<{ code: number | null; signal: string | null }>;
  ready?: Record<string, unknown>;
  readyMs?: number;
}
const liveHosts = new Set<Host>();
let requestSeq = 0;

async function call(
  host: Host,
  type: string,
  payload: Record<string, unknown> = {},
  timeoutMs = 60_000
): Promise<Record<string, unknown>> {
  const requestId = `r${++requestSeq}`;
  const reply = waitMessage(
    host.child,
    (m) => m.requestId === requestId,
    timeoutMs,
    `${host.label} ${type}`
  );
  host.child.send({ type, requestId, ...payload });
  return reply;
}

function launchHost(label: string, extraEnv: Record<string, string>): Host {
  const child = spawn(process.execPath, ['--expose-internals', '--import', hooksUrl, hostEntry], {
    cwd: hostCwd,
    env: hostEnv(extraEnv),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  const host: Host = { label, child, stderr: captureStderr(child), exited: exitOf(child) };
  liveHosts.add(host);
  return host;
}

async function startHost(label: string, extraEnv: Record<string, string> = {}): Promise<Host> {
  const started = performance.now();
  const host = launchHost(label, extraEnv);
  try {
    host.ready = await waitMessage(
      host.child,
      (m) => m.type === 'ready',
      180_000,
      `${label} ready`
    );
  } catch (error) {
    await stopHost(host);
    throw Object.assign(new Error(String(error)), { stderr: host.stderr().slice(-3000) });
  }
  host.readyMs = round(performance.now() - started, 0);
  log(`${label} ready in ${host.readyMs} ms`);
  return host;
}

async function stopHost(host: Host) {
  if (!liveHosts.has(host)) return { graceful: true };
  liveHosts.delete(host);
  if (host.child.connected) host.child.send({ type: 'shutdown' });
  const graceful = await stopWithin(host.exited, 20_000);
  if (host.child.exitCode === null && host.child.signalCode === null) host.child.kill();
  const exit = await stopWithin(host.exited, 5_000);
  return { graceful, exited: exit, stderrTail: host.stderr().slice(-3000) };
}

// ---- checks: boot and native cache -------------------------------------------

/** Whether `file` lies under `root`; Windows paths compare case-insensitively. */
function samePrefix(file: string, root: string) {
  const norm = (path: string) => {
    const full = resolve(path.replace(/^\\\\\?\\/, ''));
    return isWin ? full.toLowerCase() : full;
  };
  return norm(file).startsWith(norm(root));
}

async function bootCheck(
  id: string,
  title: string,
  extraEnv: Record<string, string>,
  cacheRoot: string | undefined
): Promise<Host | undefined> {
  let host: Host;
  try {
    host = await startHost(id, extraEnv);
  } catch (error) {
    check(id, 'boot', title, 'fail', `宿主没起来：${clip(error, 300)}`, {
      stderr: (error as { stderr?: string }).stderr,
    });
    return undefined;
  }
  const natives = ((await call(host, 'natives')).sharedObjects as string[]) ?? [];
  const narb = natives.filter((file) => /node-addon-require-builtin/i.test(file));
  const census = (host.ready?.census ?? {}) as { active?: number; inactive?: string[] };
  const inactive = census.inactive ?? [];
  const fromCache = cacheRoot !== undefined && narb.some((file) => samePrefix(file, cacheRoot));
  for (const file of narb) {
    if (cacheRoot !== undefined && samePrefix(file, cacheRoot)) {
      inspect.push({ path: file, role: `${id}: NARB 缓存副本` });
    }
  }
  const where =
    narb.length === 0
      ? '未见 node-addon-require-builtin'
      : cacheRoot === undefined
        ? `原地加载 ${narb[0]}`
        : fromCache
          ? `从缓存副本加载 ${narb[0]}`
          : `缓存未生效，静默回退到原地加载 ${narb[0]}`;
  const status: Status =
    narb.length === 0 || inactive.length > 0 ? 'fail' : cacheRoot && !fromCache ? 'info' : 'pass';
  check(
    id,
    'boot',
    title,
    status,
    `ready ${host.readyMs} ms；${where}；未激活行 ${inactive.length}`,
    {
      census,
      natives,
      execArgv: host.ready?.execArgv,
      dshRuntimeVersion: host.ready?.dshRuntimeVersion,
    }
  );
  return host;
}

// ---- checks: DSH file tools and shell through the fake gateway ---------------

interface FsRun {
  sessionId: string;
  token: string;
  calls: Array<{ name: string; input: unknown; isError?: boolean; result?: string }>;
  finished: boolean;
  idle?: unknown;
  permission?: unknown;
}

async function fsSession(host: Host, tag: 'on' | 'off', dir: string, shell: string) {
  const token = `${tag.toUpperCase()}${randomBytes(3).toString('hex')}`;
  const created = await call(host, 'create-session', { cwd: dir });
  const sessionId = String(created.sessionId);
  const run: FsRun = { sessionId, token, calls: [], finished: false };
  if (tag === 'off') {
    run.permission = (
      await call(host, 'command', { sessionId, line: '/permission danger-full-access' })
    ).result;
  }
  const params = { tag, dir, marker, token, shell };
  await call(host, 'prompt', { sessionId, text: `P0-FS ${JSON.stringify(params)}` });
  await waitForGateway(`FS:${tag} `, 60_000);
  run.idle = await call(host, 'wait-idle', { sessionId, timeoutMs: 300_000 }, 310_000).catch(
    (error) => ({ error: String(error) })
  );
  collectFs(tag, run);
  return run;
}

/** Fill `run` from the gateway log: the request that carried the most results. */
function collectFs(tag: string, run: FsRun) {
  const lines = gatewayLines().filter((line) => decisionOf(line).startsWith(`FS:${tag} `));
  let best: Record<string, unknown> | undefined;
  for (const line of lines) {
    const count = Array.isArray(line.calls) ? line.calls.length : -1;
    const bestCount = Array.isArray(best?.calls) ? (best.calls as unknown[]).length : -1;
    if (count >= bestCount) best = line;
  }
  run.calls = (best?.calls as FsRun['calls']) ?? [];
  run.finished = lines.some((line) => decisionOf(line).endsWith(` s${FS_STEPS}`));
}

const FS_MODES: Record<string, { group: string; mode: string }> = {
  on: { group: 'fs-sandbox-on', mode: '沙箱开' },
  off: { group: 'fs-sandbox-off', mode: '沙箱关' },
  ctrl: { group: 'fs-control', mode: '官方 DSH Desktop' },
};

function evaluateFs(tag: string, dir: string, shell: string, run: FsRun) {
  const { group, mode } = FS_MODES[tag];
  const T = run.token;
  const steps: Array<[string, number, string | null, string]> = [
    ['read', 0, marker, 'DSH read 读加密文件'],
    ['read-edit-target', 1, marker, 'DSH read 读待改的加密文件'],
    ['edit', 2, null, 'DSH edit 改加密文件'],
    ['read-after-edit', 3, `EDITED-${T}`, 'edit 后 DSH read 回读'],
    ['write', 4, null, 'DSH write 新建文件'],
    ['read-after-write', 5, `WRITTEN-${T}`, 'write 后 DSH read 回读'],
    ['grep', 6, 'edit-target.txt', 'DSH grep 按标记串搜到加密文件'],
    ['glob', 7, 'edit-target.txt', 'DSH glob 列出文件'],
    ['shell-read', 8, marker, `DSH ${shell} 工具读加密文件`],
    ['shell-write', 9, null, `DSH ${shell} 工具写文件`],
    ['shell-spill', 10, 'spill-line', `DSH ${shell} 大输出`],
    ['read-shell-written', 11, `SHELL-${T}`, `DSH read 回读 ${shell} 写的文件`],
  ];
  for (const [name, index, expect, title] of steps) {
    const id = `F-${tag}-${name}`;
    const call = run.calls[index];
    if (call === undefined || call.result === undefined) {
      check(id, group, `${mode}：${title}`, 'error', '回合没走到这一步', {
        finished: run.finished,
        idle: run.idle,
      });
      continue;
    }
    if (expect === null) {
      check(
        id,
        group,
        `${mode}：${title}`,
        call.isError ? 'fail' : 'pass',
        `${call.isError ? '工具报错' : '成功'}：${clip(call.result)}`,
        { input: call.input }
      );
      continue;
    }
    const seen = classify(call.result, expect);
    check(
      id,
      group,
      `${mode}：${title}`,
      seen === 'plaintext' ? 'pass' : 'fail',
      `${seen}: ${clip(call.result)}`,
      {
        input: call.input,
        isError: call.isError,
        ...(name === 'grep' || name === 'glob' || name === 'shell-spill'
          ? { result: call.result }
          : {}),
      }
    );
  }
  // What the host left on disk, read back by node.exe itself.
  const files: Array<[string, string]> = [
    ['edit-target.txt', `EDITED-${T}`],
    [`dsh-written-${T}.txt`, `WRITTEN-${T}`],
    [`shell-written-${T}.txt`, `SHELL-${T}`],
  ];
  const seen = files.map(([name, expect]) => {
    const path = join(dir, name);
    inspect.push({ path, role: `F-${tag}: ${name}` });
    return `${name}=${classify(nodeRead(path), expect)}`;
  });
  inspect.push({ path: join(dir, 'marker.txt'), role: `F-${tag}: marker.txt（前提）` });
  check(
    `F-${tag}-node-verify`,
    group,
    `${mode}：node.exe 直接回读工具产物`,
    seen.every((item) => item.endsWith('=plaintext')) ? 'pass' : 'fail',
    seen.join('，')
  );
  if (run.permission !== undefined) {
    check(
      `F-${tag}-permission`,
      group,
      `${mode}：切到 danger-full-access`,
      'info',
      clip(run.permission, 300)
    );
  }
}

/**
 * Windows: did the ACL sandbox actually touch the workspace root? A confined
 * spawn grants the root a standing ACE for its capability SID `S-1-4-x-y` plus
 * a Low mandatory label (`(NW)`); both survive the session. The SID string is
 * locale-independent, so only it decides; the label is reported alongside.
 */
function aclCheck(tag: 'on' | 'off', dir: string) {
  if (!isWin) return;
  const { group, mode } = FS_MODES[tag];
  const icacls = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe');
  const out = spawnSync(icacls, [dir], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
  const text = String(out.stdout ?? '');
  const capability = text.match(/S-1-4-\d+-\d+(-\d+)?/)?.[0];
  const label = /\(NW\)/.test(text);
  const observed = `能力 SID ACE ${capability ?? '无'}；完整性标签 ${label ? '有' : '无'}`;
  check(
    `F-${tag}-acl`,
    group,
    `${mode}：工作区根目录上的 ACL 沙箱授权（icacls）`,
    out.status !== 0 ? 'error' : tag === 'on' ? (capability ? 'pass' : 'fail') : 'info',
    out.status !== 0 ? `icacls exit ${out.status}：${clip(out.stderr || out.error)}` : observed,
    { icacls: text.slice(0, 2000) }
  );
}

// ---- checks: session log, write lock, resume ---------------------------------

function sessionFiles(sessionId: string) {
  return walk(dshHome).filter((file) => file.includes(sessionId) && /\.jsonl(\.zstd)?$/.test(file));
}

function decodeSessionFile(file: string): string | undefined {
  const raw = nodeRead(file);
  if (raw === undefined) return undefined;
  if (!file.endsWith('.zstd')) return raw.toString('utf8');
  // One zstd frame per append; the one-shot decoder stops after the first, so
  // split on the frame magic and widen a slice whenever a split was spurious.
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const starts: number[] = [];
  for (let at = raw.indexOf(magic); at >= 0; at = raw.indexOf(magic, at + 1)) starts.push(at);
  if (starts.length === 0) return raw.toString('latin1');
  let text = '';
  let from = 0;
  for (let next = 1; next <= starts.length; next += 1) {
    const end = next < starts.length ? starts[next] : raw.length;
    try {
      text += zstdDecompressSync(raw.subarray(starts[from], end)).toString('utf8');
      from = next;
    } catch {
      if (next === starts.length) text += raw.subarray(starts[from]).toString('latin1');
    }
  }
  return text;
}

async function lockAndResume(hostA: Host, sessionId: string) {
  let hostB: Host | undefined;
  try {
    hostB = await startHost('lock-b');
  } catch (error) {
    check('L-host-b', 'session', '第二个宿主启动', 'fail', clip(error, 300));
    return;
  }
  try {
    let contested: string;
    try {
      await call(hostB, 'resume-session', { sessionId }, 60_000);
      contested = 'resumed';
    } catch (error) {
      contested = String(error);
    }
    check(
      'L-lock-held',
      'session',
      '写锁：会话被 A 持有时 B 打不开',
      /already owned|AlreadyOwned|EBUSY/i.test(contested) ? 'pass' : 'fail',
      contested === 'resumed' ? '第二个宿主居然打开了同一会话' : clip(contested, 300)
    );
    await call(hostA, 'close-session', { sessionId });
    let resumed: string;
    try {
      const answer = await call(hostB, 'resume-session', { sessionId }, 60_000);
      resumed = `ok ${round(Number(answer.ms), 0)} ms`;
    } catch (error) {
      resumed = `error ${String(error)}`;
    }
    check(
      'L-lock-released',
      'session',
      '写锁：A 关闭后 B 能恢复同一会话',
      resumed.startsWith('ok') ? 'pass' : 'fail',
      clip(resumed, 300)
    );
    if (!resumed.startsWith('ok')) return;
    await call(hostB, 'prompt', {
      sessionId,
      text: `P0-RECALL ${JSON.stringify({ marker })}`,
    });
    const answered = await waitForGateway('RECALL:', 60_000);
    await call(hostB, 'wait-idle', { sessionId, timeoutMs: 60_000 }, 70_000).catch(() => undefined);
    const recall = gatewayLines().find((line) => decisionOf(line).startsWith('RECALL:'));
    check(
      'L-recall',
      'session',
      '恢复后的会话历史里仍有明文标记串',
      decisionOf(recall ?? {}).startsWith('RECALL:present') ? 'pass' : 'fail',
      answered ? decisionOf(recall ?? {}) : '网关没收到恢复后的请求'
    );
    await call(hostB, 'close-session', { sessionId }).catch(() => undefined);
  } finally {
    const stopped = await stopHost(hostB);
    report.hostB = stopped;
  }
}

function checkSessionLog(sessionId: string) {
  const files = sessionFiles(sessionId);
  const seen = files.map((file) => {
    inspect.push({ path: file, role: 'S: 会话日志' });
    const text = decodeSessionFile(file);
    return { file, seen: classify(text, marker), bytes: nodeRead(file)?.length ?? 0 };
  });
  check(
    'S-log-plaintext',
    'session',
    '会话日志落盘后由 node.exe 解码，含明文标记串',
    seen.some((row) => row.seen === 'plaintext') ? 'pass' : 'fail',
    files.length === 0
      ? `DSH_HOME 下没找到会话 ${sessionId} 的日志`
      : seen.map((row) => `${row.file.slice(dshHome.length)}=${row.seen}`).join('，'),
    seen
  );
}

// ---- checks: PTY, spill, pnpm -------------------------------------------------

function powershellExe(): string | undefined {
  if (!isWin) return undefined;
  const path = join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
  return existsSync(path) ? path : undefined;
}

function pwsh7Exe(): string | undefined {
  if (!isWin) return undefined;
  const path = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe');
  return existsSync(path) ? path : undefined;
}

function gitBashExe(): string | undefined {
  const given = option('git-bash');
  if (given) return existsSync(given) ? given : undefined;
  if (!isWin) return existsSync('/bin/bash') ? '/bin/bash' : undefined;
  const candidates = [
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Git', 'bin', 'bash.exe'),
  ];
  return candidates.find((file) => existsSync(file));
}

async function ptyCheck(host: Host) {
  const target = join(work, 'marker.txt');
  const ps = powershellExe();
  const argvPty = isWin
    ? [
        ps ?? 'powershell.exe',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-Content -Raw -LiteralPath '${target.replace(/'/g, "''")}'`,
      ]
    : ['/bin/sh', '-c', `cat '${target.replace(/'/g, "'\\''")}'`];
  try {
    const answer = await call(
      host,
      'terminal',
      { argv: argvPty, cwd: work, timeoutMs: 30_000 },
      45_000
    );
    const outcome = answer.outcome as {
      settled?: boolean;
      exitCode?: number | null;
      error?: string;
    };
    const output = String(answer.output ?? '');
    const natives = ((await call(host, 'natives')).sharedObjects as string[]) ?? [];
    const pty = natives.filter((file) => /conpty|pty\.node/i.test(file));
    check(
      'P-pty-spawn',
      'pty',
      'node-pty / conpty 起终端进程',
      outcome.settled && outcome.exitCode === 0 ? 'pass' : 'fail',
      `exit ${outcome.exitCode ?? outcome.error ?? '超时'}；已加载 ${pty.map((file) => file.split(/[\\/]/).pop()).join(', ') || '无 pty 模块'}`,
      { outcome, natives: pty }
    );
    seenCheck(
      'P-pty-read',
      'pty',
      `终端里的 ${isWin ? 'PowerShell' : 'sh'} 读加密文件`,
      output,
      marker
    );
  } catch (error) {
    check('P-pty-spawn', 'pty', 'node-pty / conpty 起终端进程', 'fail', clip(error, 300));
  }
}

function spillCheck(host: Host, tempBefore: Set<string>, tokens: string[]) {
  const unsafe = host.stderr().match(/spill-local: skipped unsafe[^\n]*/g) ?? [];
  const roots = listDir(os.tmpdir())
    .filter((name) => name.startsWith('dsh-spill-') && !tempBefore.has(name))
    .map((name) => join(os.tmpdir(), name));
  const files = roots.flatMap((root) => walk(root, 6));
  const spilled = files.filter((file) => {
    const text = nodeRead(file)?.toString('latin1') ?? '';
    return tokens.some((token) => text.includes(token)) || text.includes(TSD_MAGIC);
  });
  for (const file of spilled) inspect.push({ path: file, role: 'SP: spill 文件' });
  const spillSeen = spilled.map((file) => classify(nodeRead(file), 'spill-line'));
  const status: Status =
    unsafe.length > 0 || spillSeen.some((seen) => seen !== 'plaintext')
      ? 'fail'
      : spilled.length > 0
        ? 'pass'
        : 'info';
  check(
    'SP-spill-root',
    'spill',
    '%TEMP% 下 spill 根目录可用，大输出落盘后 node.exe 读回明文',
    status,
    unsafe.length > 0
      ? unsafe.join(' | ')
      : `新 spill 根 ${roots.length} 个，含本次大输出的文件 ${spilled.length} 个${spilled.length === 0 ? '（大输出没有落到 spill，或已被清理）' : ''}`,
    {
      roots,
      spilled: spilled.map((file) => ({
        file,
        seen: classify(nodeRead(file), 'spill-line'),
        bytes: nodeRead(file)?.length ?? 0,
      })),
    }
  );
}

async function pnpmCheck(host: Host) {
  if (skipPnpm) {
    check('G-pnpm-install', 'plugin', 'pnpm 装社区插件', 'skip', '按参数跳过（-SkipPnpm）');
    return;
  }
  const probe = spawnSync(
    process.execPath,
    [pnpmCli, 'view', PLUGIN, 'version', '--registry', REGISTRY],
    { cwd: hostCwd, env: hostEnv(), encoding: 'utf8', timeout: 45_000, windowsHide: true }
  );
  if (probe.status !== 0 || !String(probe.stdout).includes('1.0.4')) {
    check(
      'G-pnpm-install',
      'plugin',
      'pnpm 装社区插件',
      'skip',
      `连不上 npm 源，按离线跳过：${clip(probe.stderr || probe.error?.message || probe.stdout, 240)}`
    );
    return;
  }
  const localBefore = new Set(listDir(process.env.LOCALAPPDATA));
  try {
    const answer = await call(
      host,
      'install-bundle',
      { spec: PLUGIN, registry: REGISTRY },
      600_000
    );
    const manifests = walk(dshHome, 10).filter((file) =>
      /[\\/]dsh-office-tools[\\/]package\.json$/.test(file)
    );
    const seen = manifests.map((file) => {
      inspect.push({ path: file, role: 'G: 已装插件的 package.json' });
      try {
        return JSON.parse(nodeRead(file)?.toString('utf8') ?? '').name === 'dsh-office-tools'
          ? 'plaintext'
          : 'other';
      } catch {
        return classify(nodeRead(file), 'dsh-office-tools');
      }
    });
    check(
      'G-pnpm-install',
      'plugin',
      'pnpm 装社区插件，装好的文件 node.exe 读回明文',
      seen.length > 0 && seen.every((item) => item === 'plaintext') ? 'pass' : 'fail',
      manifests.length === 0 ? '装完没找到 dsh-office-tools/package.json' : seen.join('，'),
      {
        result: answer.result,
        manifests,
        newLocalAppData: listDir(process.env.LOCALAPPDATA).filter((name) => !localBefore.has(name)),
      }
    );
  } catch (error) {
    check('G-pnpm-install', 'plugin', 'pnpm 装社区插件', 'fail', clip(error, 400));
  }
}

// ---- checks: shells spawned directly by node.exe ------------------------------

function directShell(label: string, file: string | undefined, kind: 'bash' | 'powershell') {
  const idBase = `D-${label}`;
  if (file === undefined) {
    check(`${idBase}-read`, 'subprocess', `${label} 直接读加密文件`, 'skip', '本机没有这个程序');
    return;
  }
  const token = randomBytes(3).toString('hex');
  const source = join(work, 'marker.txt');
  const target = join(work, `sub-${label}-${token}.txt`);
  const line = `${marker} ${label.toUpperCase()}-${token}`;
  const bashPath = (path: string) => `'${path.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`;
  const psPath = (path: string) => `'${path.replace(/'/g, "''")}'`;
  const args =
    kind === 'bash'
      ? {
          read: ['-c', `cat ${bashPath(source)}`],
          write: ['-c', `printf '%s\\n' '${line}' > ${bashPath(target)}`],
        }
      : {
          read: [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `Get-Content -Raw -LiteralPath ${psPath(source)}`,
          ],
          write: [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `Set-Content -LiteralPath ${psPath(target)} -Value '${line}' -Encoding ASCII`,
          ],
        };
  const run = (list: string[]) =>
    spawnSync(file, list, { cwd: work, encoding: 'buffer', timeout: 30_000, windowsHide: true });
  const read = run(args.read);
  seenCheck(`${idBase}-read`, 'subprocess', `${label} 直接读加密文件`, read.stdout, marker);
  const write = run(args.write);
  inspect.push({ path: target, role: `${idBase}: ${label} 写的文件` });
  const back = nodeRead(target);
  check(
    `${idBase}-write`,
    'subprocess',
    `${label} 写文件，node.exe 读回`,
    write.status === 0 && classify(back, `${label.toUpperCase()}-${token}`) === 'plaintext'
      ? 'pass'
      : 'fail',
    `exit ${write.status}；node 读回 ${classify(back, `${label.toUpperCase()}-${token}`)}: ${clip(back?.toString('latin1'))}`,
    { stderr: write.stderr?.toString('utf8').slice(0, 400), exe: file }
  );
}

// ---- main ------------------------------------------------------------------

function makeMarkers() {
  for (const dir of [work, join(work, 'ws-on'), join(work, 'ws-off'), join(work, 'ws-ctrl')]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'marker.txt'), `${marker} plaintext line\n`);
    if (dir !== work) writeFileSync(join(dir, 'edit-target.txt'), `${marker} edit target\n`);
  }
}

function hookSpawns() {
  const text = nodeRead(join(logs, 'hooks.jsonl'))?.toString('utf8') ?? '';
  const files = new Map<string, number>();
  for (const line of text.split('\n').filter(Boolean)) {
    try {
      const record = JSON.parse(line) as { kind?: string; file?: string; args?: string[] };
      if (record.kind !== 'spawn' && record.kind !== 'spawn-sync') continue;
      // Runner-wrapped commands: name the program after the last `--` (which
      // shell the pwsh tool used) and whether the ACL sandbox runner wrapped it.
      const args = record.args ?? [];
      const last = args.lastIndexOf('--');
      const target = last >= 0 && args[last + 1] ? ` -> ${args[last + 1]}` : '';
      const acl = args.some((arg) => /sandbox-windows-acl/.test(String(arg))) ? ' [acl]' : '';
      const key = `${record.file} ${args.slice(1, 3).join(' ')}${target}${acl}`.slice(0, 300);
      files.set(key, (files.get(key) ?? 0) + 1);
    } catch {
      // Ignore a torn line.
    }
  }
  return Object.fromEntries(files);
}

async function main() {
  if (flag('make-markers')) makeMarkers();
  for (const dir of [logs, dshHome, hostCwd]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tempBefore = new Set(listDir(os.tmpdir()));
  const localBefore = new Set(listDir(process.env.LOCALAPPDATA));
  const narbDefault = narbDefaultRoot();
  report.env = {
    tmpdir: os.tmpdir(),
    localAppData: process.env.LOCALAPPDATA,
    narbDefaultRoot: narbDefault,
    narbDefaultPreExisting: existsSync(narbDefault),
    gitBash: gitBashExe(),
    powershell: powershellExe(),
    pwsh7: pwsh7Exe(),
    gateway: gatewayEntry,
  };

  // N0: the premise from node.exe's side.
  seenCheck(
    'N0-node-read',
    'premise',
    'node.exe 直接读加密标记文件',
    nodeRead(join(work, 'marker.txt')),
    marker
  );

  await startGateway();
  log(`fake gateway on ${gatewayPort}`);

  // B2 / B3 / B1: three boots over the native-cache knob; B1 stays up as host A.
  const b2 = await bootCheck(
    'B2-narb-off',
    '宿主启动：NARB_DISABLE_NATIVE_CACHE=1（原地加载）',
    { NARB_DISABLE_NATIVE_CACHE: '1' },
    undefined
  );
  if (b2) report.hostB2 = await stopHost(b2);
  const encCache = join(work, 'narb-cache');
  const b3 = await bootCheck(
    'B3-narb-enc-dir',
    '宿主启动：缓存目录放在加密区',
    { NARB_NATIVE_CACHE_DIR: encCache },
    encCache
  );
  if (b3) report.hostB3 = await stopHost(b3);
  const hostA = await bootCheck(
    'B1-narb-default',
    '宿主启动：默认缓存（%LOCALAPPDATA%）',
    {},
    narbDefault
  );
  if (hostA === undefined) {
    check('F-all', 'fs', '工具检查', 'error', '默认配置下宿主没起来，后面的检查全部跳过');
    return;
  }

  const tools = ((await call(hostA, 'tools')).names as string[]) ?? [];
  const shell = tools.includes('pwsh') ? 'pwsh' : 'bash';
  report.tools = tools;
  log(`shell tool: ${shell}; ${tools.length} tools`);

  const runs: Record<string, FsRun> = {};
  for (const tag of ['on', 'off'] as const) {
    const dir = join(work, `ws-${tag}`);
    try {
      runs[tag] = await fsSession(hostA, tag, dir, shell);
      evaluateFs(tag, dir, shell, runs[tag]);
      aclCheck(tag, dir);
    } catch (error) {
      check(
        `F-${tag}`,
        `fs-sandbox-${tag}`,
        `沙箱${tag === 'on' ? '开' : '关'}：工具回合`,
        'error',
        clip(error, 400)
      );
    }
    saveReport();
  }
  report.fsRuns = runs;

  await ptyCheck(hostA);
  spillCheck(
    hostA,
    tempBefore,
    Object.values(runs).map((run) => run.token)
  );
  saveReport();

  if (runs.on) {
    await lockAndResume(hostA, runs.on.sessionId);
    checkSessionLog(runs.on.sessionId);
  } else {
    check('L-lock-held', 'session', '写锁', 'error', '沙箱开的会话没建起来，写锁检查跳过');
  }
  saveReport();

  await pnpmCheck(hostA);
  const natives = ((await call(hostA, 'natives')).sharedObjects as string[]) ?? [];
  check(
    'K-natives',
    'native',
    '宿主 A 加载过的原生模块',
    'info',
    natives.map((file) => file.split(/[\\/]/).pop()).join(', '),
    natives
  );
  report.hostA = await stopHost(hostA);
  report.hostAStderrUnsafeSpill = /spill-local: skipped unsafe/.test(
    String((report.hostA as { stderrTail?: string }).stderrTail ?? '')
  );

  directShell('bash', gitBashExe(), 'bash');
  directShell('powershell', powershellExe(), 'powershell');
  if (isWin) directShell('pwsh7', pwsh7Exe(), 'powershell');

  report.spawns = hookSpawns();
  const created = [
    ...listDir(os.tmpdir())
      .filter(
        (name) =>
          !tempBefore.has(name) &&
          /^(dsh-|node-compile-cache|node-addon-native-custom-loader)/.test(name)
      )
      .map((name) => join(os.tmpdir(), name)),
    ...listDir(process.env.LOCALAPPDATA)
      .filter(
        (name) =>
          !localBefore.has(name) &&
          /^(node-addon-native-custom-loader|pnpm|pnpm-cache|pnpm-state)$/i.test(name)
      )
      .map((name) => join(process.env.LOCALAPPDATA ?? '', name)),
  ];
  cleanup.push(...created);
}

/**
 * Control group (`--control`): the official DSH Desktop drives the same P0-FS
 * script against `<work>\\ws-ctrl`. run-p0-4.ps1 points Desktop's home-level
 * patch at this gateway on a fixed port; the user pastes the prompt printed
 * here. Ends when the script's last step arrives, on Enter, or after 30 min.
 */
async function controlMain() {
  if (flag('make-markers')) makeMarkers();
  mkdirSync(logs, { recursive: true, mode: 0o700 });
  const port = Number(option('port') ?? '18484');
  const dir = join(work, 'ws-ctrl');
  const shell = option('shell') ?? (isWin ? 'pwsh' : 'bash');
  report.mode = 'control';
  seenCheck(
    'N0-node-read',
    'premise',
    'node.exe 直接读加密标记文件',
    nodeRead(join(dir, 'marker.txt')),
    marker
  );
  await startGateway(port);
  const run: FsRun = {
    sessionId: 'dsh-desktop',
    token: `CTRL${randomBytes(3).toString('hex')}`,
    calls: [],
    finished: false,
  };
  const prompt = `P0-FS ${JSON.stringify({ tag: 'ctrl', dir, marker, token: run.token, shell })}`;
  const promptFile = join(dirname(outFile), 'control-prompt.txt');
  writeFileSync(promptFile, `${prompt}\n`);
  report.controlPrompt = prompt;
  process.stdout.write(
    `\n[p0-4] 假网关已在 http://127.0.0.1:${port} 就绪。在 DSH Desktop 里打开工作区\n  ${dir}\n` +
      `选模型「P0 fake model」，发送下面这一整行（也已写入 ${promptFile}）：\n\n${prompt}\n\n` +
      '[p0-4] 跑完后本窗口自动继续；想提前结束就按回车。\n'
  );
  let enter = false;
  process.stdin.on('data', () => {
    enter = true;
  });
  const deadline = performance.now() + 30 * 60_000;
  let seen = 0;
  while (!enter && performance.now() < deadline) {
    collectFs('ctrl', run);
    if (run.calls.length > seen) {
      seen = run.calls.length;
      log(`DSH Desktop 已完成 ${seen} / ${FS_STEPS} 步`);
    }
    if (run.finished) break;
    await sleep(1000);
  }
  process.stdin.pause();
  collectFs('ctrl', run);
  report.fsRuns = { ctrl: run };
  report.gatewayRequests = gatewayLines().map((line) => ({
    seq: line.seq,
    decision: line.decision,
    tool: line.tool,
    auth: line.auth === null ? null : 'present',
    tools: line.tools,
  }));
  if (run.calls.length === 0) {
    check(
      'F-ctrl',
      'fs-control',
      '官方 DSH Desktop：工具回合',
      'error',
      '网关没收到 DSH Desktop 的 P0-FS 请求'
    );
    return;
  }
  evaluateFs('ctrl', dir, shell, run);
}

try {
  if (flag('control')) await controlMain();
  else await main();
} catch (error) {
  check(
    'X-probe',
    'probe',
    '探针自身',
    'error',
    clip(error instanceof Error ? error.stack : error, 800)
  );
} finally {
  for (const host of [...liveHosts]) await stopHost(host);
  gatewayChild?.kill();
  saveReport();
  if (flag('self-clean')) {
    for (const path of cleanup) rmSync(path, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
    log(`self-clean: removed ${work} and ${cleanup.length} temp entries`);
  }
  const counts: Record<string, number> = {};
  for (const item of checks) counts[item.status] = (counts[item.status] ?? 0) + 1;
  log(`done: ${JSON.stringify(counts)}; report ${outFile}`);
  // Nothing should linger; do not wait on stray handles.
  process.exit(0);
}
