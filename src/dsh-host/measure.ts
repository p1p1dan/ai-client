/**
 * P0-1 measurement driver: DSH host (dsh-base + @aiclient/dsh-app) versus our
 * native worker (out-agent-host/worker.js), both on the same bundled Node.
 *
 *   node measure.ts smoke                 one DSH boot + 1 session + stop, one worker bootstrap + stop
 *   node measure.ts run [--cold 3] [--warm 5] [--worker 5] [--out file.json]
 *   node measure.ts parallel [--n 4]      n engines started at once, one session each
 *   node measure.ts trace [--out file.json]
 *
 * `run` measures spawn -> ready, idle RSS, RSS with 1/2/4 sessions, stop time,
 * and samples each process tree (/proc, 250 ms) for child processes. `trace`
 * repeats one boot of each engine under `strace -f` to list every exec and
 * every write outside the engine's own data directory; its timings are not
 * reported. No model is ever called: sessions are created, never prompted.
 *
 * Every run gets a fresh scratch HOME / TMPDIR / DSH_HOME / workspace under
 * /var/tmp (disk-backed; /tmp is tmpfs here and would count against RAM) and an
 * allowlisted environment, so no credential from the developer's shell leaks in.
 * Measurements wait until no vitest process is running.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import {
  baseEnv,
  captureStderr,
  descendants,
  exitOf,
  launch,
  median,
  parseStrace as parseStraceIn,
  psSnapshot,
  readHookLog,
  round,
  type Sandbox,
  sampleMem,
  sandbox as sandboxIn,
  sleep,
  statusField,
  stopWithin,
  summarizeHooks,
  treeSampler,
  waitMessage,
  waitQuiet,
} from './lib/kit.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const hostEntry = join(here, 'host.ts');
const hooksEntry = join(here, 'lib', 'probe-hooks.mjs');
const workerEntry = join(repoRoot, 'out-agent-host', 'worker.js');
const bundledNode = join(
  repoRoot,
  'out-node-runtime',
  process.platform === 'win32' ? 'node.exe' : 'node'
);

// ---- args ----------------------------------------------------------------

const argv = process.argv.slice(2);
const mode = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'run';
function option(name: string, fallback: string): string {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
}
const nodeBin = option('node', existsSync(bundledNode) ? bundledNode : process.execPath);
const coldRuns = Number(option('cold', '3'));
const warmRuns = Number(option('warm', '5'));
const workerRuns = Number(option('worker', '5'));
const settleIdleMs = Number(option('settle', '8000'));
const idleSamples = Number(option('samples', '10'));
const settleSessionMs = 4000;
const sessionSamples = 5;
const sessionLadder = [1, 2, 4];
const keep = argv.includes('--keep');
const exposeInternals = !argv.includes('--no-expose-internals');
const outFile = option('out', '');
// Extra DSH host environment, e.g. --host-env NARB_DISABLE_NATIVE_CACHE=1.
const extraHostEnv: Record<string, string> = Object.fromEntries(
  argv
    .filter((_, index) => argv[index - 1] === '--host-env')
    .map((pair) => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)])
);
const scratchRoot = join('/var/tmp', `aiclient-dsh-probe-${Date.now()}`);
const sandbox = (label: string, dshHome?: string) => sandboxIn(scratchRoot, label, dshHome);
const parseStrace = (file: string, box: Sandbox) =>
  parseStraceIn(file, box, [here, join(repoRoot, 'out-agent-host')], repoRoot);

// ---- small utils ---------------------------------------------------------

const log = (message: string) => process.stderr.write(`[measure] ${message}\n`);

// ---- page cache ----------------------------------------------------------

function meminfoCachedMb(): number {
  return round(statusField(readFileSync('/proc/meminfo', 'utf8'), 'Cached') / 1024);
}

/**
 * Drop the page cache of every file under `roots` (posix_fadvise DONTNEED; no
 * root needed). Pages still mapped by a live process stay, so the driver must
 * not itself run on the Node binary being evicted.
 */
function evictPageCache(roots: string[]) {
  const before = meminfoCachedMb();
  const script = [
    'import os, sys',
    'n = 0',
    'for root in sys.argv[1:]:',
    '    paths = [root] if os.path.isfile(root) else [os.path.join(d, f) for d, _, fs in os.walk(root) for f in fs]',
    '    for p in paths:',
    '        try:',
    '            fd = os.open(p, os.O_RDONLY)',
    '            try:',
    '                os.posix_fadvise(fd, 0, 0, os.POSIX_FADV_DONTNEED)',
    '                n += 1',
    '            finally:',
    '                os.close(fd)',
    '        except OSError:',
    '            pass',
    'print(n)',
  ].join('\n');
  const files = Number(
    execFileSync('python3', ['-c', script, ...roots], { encoding: 'utf8' }).trim()
  );
  return { files, cachedBeforeMb: before, cachedAfterMb: meminfoCachedMb() };
}

// ---- engines -------------------------------------------------------------

interface LaunchOptions {
  box: Sandbox;
  traceFile?: string;
}

async function runDsh(label: string, options: LaunchOptions & { ladder: boolean }) {
  const { box } = options;
  const env = {
    ...baseEnv(box),
    DSH_HOME: box.dshHome,
    DSH_TELEMETRY_DISABLED: '1',
    ...extraHostEnv,
  };
  const command = [
    nodeBin,
    ...(exposeInternals ? ['--expose-internals'] : []),
    '--import',
    hooksEntry,
    hostEntry,
  ];
  const t0 = performance.now();
  const child = launch(command, env, box.workspace, options.traceFile);
  const stderr = captureStderr(child);
  const exited = exitOf(child);
  const sampler = treeSampler(child.pid as number, t0);
  const result: Record<string, unknown> = { label, engine: 'dsh', dshHome: box.dshHome };
  try {
    const ready = await waitMessage(child, (m) => m.type === 'ready', 180_000, `${label} ready`);
    const hostPid = ready.pid as number;
    result.readyMs = round(performance.now() - t0, 0);
    result.hostMarksMs = Object.fromEntries(
      Object.entries(ready.marks as Record<string, number>).map(([key, value]) => [
        key,
        round(value, 0),
      ])
    );
    result.ready = {
      node: ready.node,
      execArgv: ready.execArgv,
      dshRuntimeVersion: ready.dshRuntimeVersion,
      bundles: ready.bundles,
      composition: ready.composition,
      census: ready.census,
    };
    await sleep(settleIdleMs);
    result.idle = await sampleMem(hostPid, idleSamples);
    result.psIdle = psSnapshot(child.pid as number);
    const sessions: Array<Record<string, unknown>> = [];
    const created: string[] = [];
    let requestSeq = 0;
    for (const target of options.ladder ? sessionLadder : [1]) {
      while (created.length < target) {
        const requestId = `create-${++requestSeq}`;
        const started = performance.now();
        child.send({ type: 'create-session', requestId, cwd: box.workspace });
        const reply = await waitMessage(
          child,
          (m) => m.requestId === requestId && m.type === 'session-created',
          60_000,
          `${label} ${requestId}`
        );
        created.push(reply.sessionId as string);
        sessions.push({
          n: created.length,
          createMs: round(performance.now() - started, 0),
          hostCreateMs: round(reply.ms as number, 0),
          route: `${reply.provider}/${reply.model}`,
        });
      }
      await sleep(settleSessionMs);
      const mem = await sampleMem(hostPid, sessionSamples);
      const statsReply = waitMessage(
        child,
        (m) => m.requestId === `stats-${target}`,
        10_000,
        `${label} stats`
      );
      child.send({ type: 'stats', requestId: `stats-${target}` });
      const stats = await statsReply;
      const heap = stats.memory as Record<string, number>;
      sessions.push({
        atSessions: target,
        liveAgents: stats.liveAgents,
        ...mem,
        heapUsedMb: round(heap.heapUsed / 1048576),
        externalMb: round(heap.external / 1048576),
      });
    }
    result.sessions = sessions;
    result.psWithSessions = psSnapshot(child.pid as number);
    const stopStarted = performance.now();
    child.send({ type: 'shutdown' });
    const graceful = await stopWithin(exited, 20_000);
    result.stopMs = round(performance.now() - stopStarted, 0);
    result.stopGraceful = graceful;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    result.exit = await exited;
    await sleep(300);
    const children = sampler.stop();
    result.children = children;
    result.leftoverChildren = children
      .filter((row) => existsSync(`/proc/${row.pid}`))
      .map((row) => row.cmd);
    result.hooks = summarizeHooks(readHookLog(box.hookLog));
    result.stderrTail = stderr().slice(-3000);
  }
  return result;
}

function workerEnv(box: Sandbox): Record<string, string> {
  const agentDir = join(box.root, 'agent');
  const traceDir = join(box.root, 'trace');
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  // A provider pointing at the discard port: bootstrap resolves the model, but
  // nothing is ever prompted, so no request is made.
  writeFileSync(
    join(agentDir, 'models.json'),
    JSON.stringify({
      providers: {
        probe: {
          baseUrl: 'http://127.0.0.1:9/v1',
          api: 'openai-completions',
          authHeader: true,
          models: [{ id: 'probe-model', name: 'P0 probe (never called)' }],
        },
      },
    })
  );
  writeFileSync(
    join(agentDir, 'auth.json'),
    JSON.stringify({ probe: { type: 'api_key', key: 'p0-probe-not-a-secret' } })
  );
  return {
    ...baseEnv(box),
    PI_CODING_AGENT_DIR: agentDir,
    AICLIENT_RUNTIME_AGENT_DIR: agentDir,
    AICLIENT_RUNTIME_TRACE_DIR: traceDir,
    AICLIENT_PI_TRUST_PROJECT_CONFIG: '0',
    AICLIENT_PI_WORKER_GENERATION: '1',
  };
}

const workerRequest = (requestId: string, type: string, payload: unknown) => ({
  protocolVersion: 1,
  kind: 'request',
  generation: 1,
  requestId,
  type,
  payload,
});

const workerBootstrap = (label: string, box: Sandbox) =>
  workerRequest('bootstrap', 'worker.bootstrap', {
    logicalSessionId: `p0-probe-${label}`,
    cwd: box.workspace,
    model: 'probe/probe-model',
    effort: 'low',
    tier: 'fullopen',
  });

async function runWorker(label: string, options: LaunchOptions) {
  const { box } = options;
  const env = workerEnv(box);
  const command = [nodeBin, '--import', hooksEntry, workerEntry];
  const t0 = performance.now();
  const child = launch(command, env, box.workspace, options.traceFile);
  const stderr = captureStderr(child);
  const exited = exitOf(child);
  const sampler = treeSampler(child.pid as number, t0);
  const result: Record<string, unknown> = { label, engine: 'native-worker' };
  const request = workerRequest;
  try {
    child.send(workerBootstrap(label, box));
    const reply = await waitMessage(
      child,
      (m) => m.kind === 'response' && m.requestId === 'bootstrap',
      120_000,
      `${label} bootstrap`
    );
    if (reply.ok !== true)
      throw new Error(`bootstrap failed: ${JSON.stringify(reply).slice(0, 500)}`);
    result.readyMs = round(performance.now() - t0, 0);
    const workerPid = options.traceFile
      ? descendants(child.pid as number)[0]
      : (child.pid as number);
    await sleep(settleIdleMs);
    result.idle = await sampleMem(workerPid, idleSamples);
    result.psIdle = psSnapshot(child.pid as number);
    const stopStarted = performance.now();
    child.send(request('dispose', 'worker.dispose', { reason: 'app-shutdown' }));
    const graceful = await stopWithin(exited, 20_000);
    result.stopMs = round(performance.now() - stopStarted, 0);
    result.stopGraceful = graceful;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    result.exit = await exited;
    await sleep(300);
    const children = sampler.stop();
    result.children = children;
    result.leftoverChildren = children
      .filter((row) => existsSync(`/proc/${row.pid}`))
      .map((row) => row.cmd);
    result.hooks = summarizeHooks(readHookLog(box.hookLog));
    result.stderrTail = stderr().slice(-3000);
  }
  return result;
}

/**
 * One-process-per-session topology measured directly: `n` engines started at
 * once, each brought to one live session. DSH hosts share one (pre-warmed)
 * DSH_HOME, as per-session hosts of one installation would.
 */
async function runParallel(engine: 'dsh' | 'worker', n: number, sharedDshHome?: string) {
  const t0 = performance.now();
  const procs = Array.from({ length: n }, (_, index) => {
    const label = `parallel-${engine}-${index + 1}`;
    const box = sandbox(label, engine === 'dsh' ? sharedDshHome : undefined);
    const command =
      engine === 'dsh'
        ? [nodeBin, '--expose-internals', '--import', hooksEntry, hostEntry]
        : [nodeBin, '--import', hooksEntry, workerEntry];
    const env =
      engine === 'dsh'
        ? { ...baseEnv(box), DSH_HOME: box.dshHome, DSH_TELEMETRY_DISABLED: '1' }
        : workerEnv(box);
    const child = launch(command, env, box.workspace);
    return { label, box, child, stderr: captureStderr(child), exited: exitOf(child) };
  });
  const result: Record<string, unknown> = { engine, n };
  try {
    const readyMs = await Promise.all(
      procs.map(async ({ label, box, child }) => {
        if (engine === 'worker') {
          child.send(workerBootstrap(label, box));
          const reply = await waitMessage(
            child,
            (m) => m.requestId === 'bootstrap',
            180_000,
            `${label} bootstrap`
          );
          if (reply.ok !== true) throw new Error(`${label} bootstrap failed`);
          return round(performance.now() - t0, 0);
        }
        await waitMessage(child, (m) => m.type === 'ready', 180_000, `${label} ready`);
        child.send({ type: 'create-session', requestId: 'p1', cwd: box.workspace });
        await waitMessage(
          child,
          (m) => m.requestId === 'p1' && m.type === 'session-created',
          60_000,
          `${label} session`
        );
        return round(performance.now() - t0, 0);
      })
    );
    result.perProcessReadyWithSessionMs = readyMs;
    result.allReadyWithSessionMs = Math.max(...readyMs);
    await sleep(settleIdleMs);
    const mems = await Promise.all(
      procs.map(({ child }) => sampleMem(child.pid as number, sessionSamples))
    );
    result.perProcessRssMb = mems.map((mem) => mem.rssMedianMb);
    result.totalRssMb = round(mems.reduce((sum, mem) => sum + mem.rssMedianMb, 0));
    result.totalPssMb = round(mems.reduce((sum, mem) => sum + mem.pssMedianMb, 0));
    result.totalSwapMb = round(mems.reduce((sum, mem) => sum + mem.swapMedianMb, 0));
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  } finally {
    for (const { child } of procs) {
      if (!child.connected) continue;
      child.send(
        engine === 'dsh'
          ? { type: 'shutdown' }
          : workerRequest('dispose', 'worker.dispose', { reason: 'app-shutdown' })
      );
    }
    await Promise.all(procs.map(({ exited }) => stopWithin(exited, 20_000)));
    for (const { child } of procs) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    result.exits = await Promise.all(procs.map(({ exited }) => exited));
    result.stderrTails = procs
      .map(({ stderr }) => stderr().slice(-800))
      .filter((text) => text.trim() !== '');
  }
  return result;
}

// ---- main ----------------------------------------------------------------

function versions() {
  const read = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const lock = read(join(here, 'package-lock.json')) as {
    packages: Record<string, { version?: string }>;
  };
  const pinned = Object.fromEntries(
    Object.entries(lock.packages)
      .filter(
        ([path]) =>
          path.startsWith('node_modules/@deepseek-ai/') &&
          !path.slice('node_modules/'.length).includes('node_modules/')
      )
      .map(([path, entry]) => [path.slice('node_modules/'.length), entry.version])
  );
  const distinctDsh = [
    ...new Set(
      Object.entries(pinned)
        .filter(([name]) => name.startsWith('@deepseek-ai/dsh'))
        .map(([, version]) => version)
    ),
  ];
  return {
    nodeBin,
    node: execFileSync(nodeBin, ['--version'], { encoding: 'utf8' }).trim(),
    driverNode: process.version,
    kernel: os.release(),
    cpus: os.cpus().length,
    memTotalMb: round(os.totalmem() / 1048576, 0),
    dshPackageCount: Object.keys(pinned).length,
    dshVersionsDistinct: distinctDsh,
    vendor: Object.fromEntries(
      Object.entries(pinned).filter(([name]) => !name.startsWith('@deepseek-ai/dsh'))
    ),
    worker: existsSync(workerEntry) ? workerEntry : 'missing: run pnpm build:agent-host',
  };
}

function summarize(runs: Array<Record<string, unknown>>) {
  const ok = runs.filter((run) => run.error === undefined);
  const pick = (fn: (run: Record<string, unknown>) => number | undefined) =>
    ok
      .map(fn)
      .filter((value): value is number => typeof value === 'number' && !Number.isNaN(value));
  const idle = pick((run) => (run.idle as { rssMedianMb: number } | undefined)?.rssMedianMb);
  const at = (n: number) =>
    pick(
      (run) =>
        (run.sessions as Array<{ atSessions?: number; rssMedianMb?: number }> | undefined)?.find(
          (row) => row.atSessions === n
        )?.rssMedianMb
    );
  const firstCreate = pick(
    (run) =>
      (run.sessions as Array<{ n?: number; createMs?: number }> | undefined)?.find(
        (row) => row.n === 1
      )?.createMs
  );
  return {
    runs: runs.length,
    failed: runs.length - ok.length,
    readyMsMedian: median(pick((run) => run.readyMs as number)),
    readyMsAll: pick((run) => run.readyMs as number),
    idleRssMbMedian: idle.length ? median(idle) : undefined,
    idleRssMbAll: idle,
    firstSessionCreateMsMedian: firstCreate.length ? median(firstCreate) : undefined,
    rssAt1MbMedian: at(1).length ? median(at(1)) : undefined,
    rssAt2MbMedian: at(2).length ? median(at(2)) : undefined,
    rssAt4MbMedian: at(4).length ? median(at(4)) : undefined,
    stopMsMedian: median(pick((run) => run.stopMs as number)),
  };
}

async function main() {
  mkdirSync(scratchRoot, { recursive: true, mode: 0o700 });
  log(`scratch ${scratchRoot}; node ${nodeBin}`);
  const report: Record<string, unknown> = {
    probe: 'P0-1 dsh host',
    startedAt: new Date().toISOString(),
    mode,
    settings: { settleIdleMs, idleSamples, settleSessionMs, sessionSamples, sessionLadder },
    versions: versions(),
  };
  if (mode === 'smoke') {
    await waitQuiet();
    report.smoke = await runDsh('smoke', { box: sandbox('smoke'), ladder: false });
    report.smokeWorker = await runWorker('smoke-worker', { box: sandbox('smoke-worker') });
  } else if (mode === 'run') {
    const cold: Array<Record<string, unknown>> = [];
    const warm: Array<Record<string, unknown>> = [];
    const worker: Array<Record<string, unknown>> = [];
    let warmHome: string | undefined;
    for (let i = 1; i <= coldRuns; i += 1) {
      await waitQuiet();
      log(`dsh cold ${i}/${coldRuns}`);
      const box = sandbox(`dsh-cold-${i}`);
      warmHome ??= box.dshHome;
      cold.push(await runDsh(`dsh-cold-${i}`, { box, ladder: true }));
    }
    for (let i = 1; i <= warmRuns; i += 1) {
      await waitQuiet();
      log(`dsh warm ${i}/${warmRuns}`);
      warm.push(
        await runDsh(`dsh-warm-${i}`, { box: sandbox(`dsh-warm-${i}`, warmHome), ladder: true })
      );
    }
    for (let i = 1; i <= workerRuns; i += 1) {
      await waitQuiet();
      log(`worker ${i}/${workerRuns}`);
      worker.push(await runWorker(`worker-${i}`, { box: sandbox(`worker-${i}`) }));
    }
    report.dsh = { cold, warm, coldSummary: summarize(cold), warmSummary: summarize(warm) };
    report.worker = { runs: worker, summary: summarize(worker) };
  } else if (mode === 'diskcold') {
    // Page-cache-cold starts (first launch after a reboot). Run this driver on a
    // different Node binary than --node, or the engine binary stays mapped.
    if (realpathSync(process.execPath) === realpathSync(nodeBin)) {
      throw new Error('diskcold: run measure.ts with a different node than --node');
    }
    const n = Number(option('n', '3'));
    const engineNode = realpathSync(nodeBin);
    const dshRoots = [
      engineNode,
      join(here, 'node_modules'),
      join(here, 'bundle'),
      hostEntry,
      hooksEntry,
    ];
    const workerRoots = [engineNode, join(repoRoot, 'out-agent-host'), hooksEntry];
    const runs: Array<Record<string, unknown>> = [];
    for (let i = 1; i <= n; i += 1) {
      await waitQuiet();
      const dshEvict = evictPageCache(dshRoots);
      const dsh = await runDsh(`diskcold-dsh-${i}`, {
        box: sandbox(`diskcold-dsh-${i}`),
        ladder: false,
      });
      runs.push({
        engine: 'dsh',
        i,
        evict: dshEvict,
        readyMs: dsh.readyMs,
        marks: dsh.hostMarksMs,
        error: dsh.error,
      });
      await waitQuiet();
      const workerEvict = evictPageCache(workerRoots);
      const worker = await runWorker(`diskcold-worker-${i}`, {
        box: sandbox(`diskcold-worker-${i}`),
      });
      runs.push({
        engine: 'worker',
        i,
        evict: workerEvict,
        readyMs: worker.readyMs,
        error: worker.error,
      });
    }
    report.diskcold = runs;
  } else if (mode === 'parallel') {
    const n = Number(option('n', '4'));
    // Pre-warm one DSH_HOME so the parallel hosts measure steady-state boots.
    await waitQuiet();
    const warmBox = sandbox('parallel-warmup');
    const warmup = await runDsh('parallel-warmup', { box: warmBox, ladder: false });
    const runs: Array<Record<string, unknown>> = [{ warmupError: warmup.error }];
    for (const engine of ['dsh', 'worker'] as const) {
      await waitQuiet();
      log(`parallel ${engine} x${n}`);
      runs.push(await runParallel(engine, n, warmBox.dshHome));
    }
    report.parallel = runs;
  } else if (mode === 'trace') {
    await waitQuiet();
    const dshBox = sandbox('trace-dsh');
    const dshTrace = join(dshBox.root, 'strace.log');
    const dsh = await runDsh('trace-dsh', { box: dshBox, ladder: true, traceFile: dshTrace });
    await waitQuiet();
    const workerBox = sandbox('trace-worker');
    const workerTrace = join(workerBox.root, 'strace.log');
    const worker = await runWorker('trace-worker', { box: workerBox, traceFile: workerTrace });
    report.trace = {
      dsh: {
        error: dsh.error,
        children: dsh.children,
        hooks: dsh.hooks,
        strace: parseStrace(dshTrace, dshBox),
      },
      worker: {
        error: worker.error,
        children: worker.children,
        hooks: worker.hooks,
        strace: parseStrace(workerTrace, workerBox),
      },
    };
  } else {
    throw new Error(`unknown mode ${mode}`);
  }
  report.finishedAt = new Date().toISOString();
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (outFile) writeFileSync(outFile, text);
  process.stdout.write(text);
  if (!keep) rmSync(scratchRoot, { recursive: true, force: true });
  else log(`kept ${scratchRoot}`);
}

await main();
