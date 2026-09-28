/**
 * dsh-rebase P1-4a experiment (plan P1-4 §8, decision 030): what Main's
 * preview of a large DSH session costs the shared host — `readPage`, i.e. the
 * stub, `sessionQuery.observeSession`, the projection and one page.
 *
 *   (cd src/dsh-host && ../../out-node-runtime/node tools/read-page-probe.ts
 *      [--turns 500] [--hosts 3] [--out file.json] [--keep])
 *
 * The session is synthetic and realistic in shape: `--turns` turns of 1.0.x's
 * own format (a prompt; a step that thinks, says a line and calls `read`; the
 * result; a closing answer — 4 messages a turn, 2000 at the default), cloned
 * from the corpus file `v4-basic.jsonl` with generated prose of ordinary
 * entropy (so the zstd log on disk is not unrealistically small), converted by
 * P1-9's converter and admitted into a real host as a seed (`agents.create`,
 * the migration's path) through the test-only probe bundle. No model is
 * called; the fake gateway only stands by.
 *
 * Then `--hosts` fresh hosts, each reading the closed session first thing:
 *   - host 1 times one bare `observeSession` first (the probe's `observe-stat`),
 *     then `readPage`, which now finds DSH's prepared-session cache warm;
 *   - the others time `readPage` first (the whole cold path), then again (warm);
 *   - the last one then opens the session on a channel (a resume: the bridge's
 *     cache folds the log) and reads the live session.
 * For each read: the host's own time (`page.ms`), the round trip, the host's
 * RSS right before and its peak during the read (/proc, every 5 ms), and the
 * heap and RSS after a forced GC (what stays: DSH keeps up to 5 prepared
 * sessions). Waits until no vitest process runs and needs 900 MB available.
 * Signals only ever go to a ChildProcess this script spawned.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { convertPiSessionBytes } from '../../shared/legacyPiSession/convert/index.ts';
import { BYPASS_PERMISSIONS, fakeGatewayPlan, HostClient, type Message } from './lib/hostClient.ts';
import {
  baseEnv,
  captureStderr,
  exitOf,
  readMem,
  round,
  sandbox,
  sleep,
  waitQuiet,
} from './lib/kit.ts';
import { installProbeBundle } from './lib/probe-bundle.ts';

const here = dirname(fileURLToPath(import.meta.url));
const hostDir = resolve(here, '..');
const repoRoot = resolve(hostDir, '..', '..');
const hostEntry = join(hostDir, 'host.ts');
const hooksEntry = join(here, 'lib', 'probe-hooks.mjs');
const gatewayEntry = join(here, 'fake-gateway.mjs');
const TEMPLATE = join(
  repoRoot,
  'src',
  'shared',
  '__tests__',
  'fixtures',
  'legacy-pi',
  'v4-basic.jsonl'
);
const bundledNode = join(repoRoot, 'out-node-runtime', 'node');
const nodeBin = existsSync(bundledNode) ? bundledNode : process.execPath;
const MIN_AVAILABLE_MB = 900;
const LOGICAL = 'read-page-probe';
const DSH_ID = `aiclient-${LOGICAL}`;

const argv = process.argv.slice(2);
function option(name: string, fallback: string): string {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
}
const turns = Number(option('turns', '500'));
const hostCount = Math.max(2, Number(option('hosts', '3')));
const outFile = option('out', '');
const keep = argv.includes('--keep');

function availableMb(): number {
  const match = readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+)/m);
  return match ? Number(match[1]) / 1024 : Number.NaN;
}

/** A deterministic, well-formed UUID for entry `n` of kind `k`. */
function uuid(k: number, n: number): string {
  return `00000000-0000-4000-8000-${(k * 1_000_000 + n).toString(16).padStart(12, '0')}`;
}

const WORDS = (
  'the a build test file error module function value session history page host read ' +
  'write cache index render timeline message tool result step turn model prompt answer ' +
  'context summary branch commit merge review patch diff config setting option path ' +
  'workspace project source target output input stream buffer event queue worker slot ' +
  'channel lock stub log frame record header schema field type string number array ' +
  'object promise async await return throw catch finally import export class method ' +
  'interface declare const let var if else for while switch case break continue new ' +
  'delete this super extends implements private public static readonly abstract enum'
).split(' ');

/** Deterministic prose of ordinary entropy (an LCG over a word list). */
function prose(seed: number, chars: number): string {
  let state = (seed * 2654435761) >>> 0 || 1;
  let text = '';
  while (text.length < chars) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const word = WORDS[state % WORDS.length] as string;
    text += state % 11 === 0 ? `${word}. ` : state % 29 === 0 ? `${word}\n` : `${word} `;
  }
  return text.slice(0, chars);
}

/** `turns` turns of v4-basic's first turn, re-keyed, with generated text, as 1.0.x JSONL. */
function syntheticSession(cwd: string): { bytes: Buffer; messages: number } {
  const lines = readFileSync(TEMPLATE, 'utf8').split('\n').filter(Boolean);
  const header = { ...JSON.parse(lines[0] as string), cwd };
  // Lines 5-8 of the corpus file: prompt, thinking + text + read call, result, answer.
  const template = lines.slice(4, 8).map((line) => JSON.parse(line) as Message);
  const out = [JSON.stringify(header)];
  let seq = 0;
  let parentId: string | null = null;
  let time = Number(header.createdAt) + 1000;
  for (let turn = 0; turn < turns; turn += 1) {
    template.forEach((entry, index) => {
      seq += 1;
      time += 250;
      const id = uuid(index + 1, turn);
      const message = structuredClone(entry.message) as Message;
      const callId = `call-read-${turn}`;
      const salt = turn * 8 + index * 2;
      if (message.role === 'user') {
        message.content = [{ type: 'text', text: `Turn ${turn}. ${prose(salt, 240)}` }];
      } else if (message.role === 'toolResult') {
        message.toolCallId = callId;
        message.content = [{ type: 'text', text: prose(salt, 1800) }];
      } else if (Array.isArray(message.content)) {
        message.content = (message.content as Message[]).map((block, position) => {
          if (block.type === 'toolCall') return { ...block, id: callId };
          if (block.type === 'thinking') return { ...block, thinking: prose(salt + position, 400) };
          if (block.type === 'text') return { ...block, text: prose(salt + position + 1, 700) };
          return block;
        });
      }
      message.timestamp = time;
      out.push(JSON.stringify({ ...entry, message, id, seq, parentId, timestamp: time }));
      parentId = id;
    });
  }
  return { bytes: Buffer.from(`${out.join('\n')}\n`), messages: turns * template.length };
}

async function startGateway(root: string): Promise<{ child: ChildProcess; port: number }> {
  const child = spawn(
    nodeBin,
    [gatewayEntry, '--port', '0', '--plan', 'dsh-p0-2', '--reset', '--model-id', 'fake-1'].concat([
      '--state',
      join(root, 'gateway.state.json'),
      '--log',
      join(root, 'gateway.jsonl'),
    ]),
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  const port = await new Promise<number>((done, fail) => {
    let text = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      text += chunk;
      const match = text.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) done(Number(match[1]));
    });
    setTimeout(() => fail(new Error('fake gateway did not start')), 15_000);
  });
  child.stderr?.resume();
  return { child, port };
}

interface Host {
  child: ChildProcess;
  client: HostClient;
  stderr: () => string;
  exited: Promise<unknown>;
}

/** RSS right before, peak during (5 ms samples) and the answer of one read. */
async function measuredRead(host: Host, stubFile: string) {
  const pid = host.child.pid as number;
  const beforeKb = readMem(pid).rssKb;
  let peakKb = beforeKb;
  const timer = setInterval(() => {
    try {
      peakKb = Math.max(peakKb, readMem(pid).rssKb);
    } catch {
      // Host gone; the read reports it.
    }
  }, 5);
  try {
    const reply = await host.client.readPage({ stubFile, logicalSessionId: LOGICAL });
    peakKb = Math.max(peakKb, readMem(pid).rssKb);
    const page = reply.page as { messages?: unknown[]; totalCount?: number } | undefined;
    return {
      ok: reply.ok,
      ...(reply.error ? { error: reply.error } : {}),
      hostMs: reply.ms,
      roundTripMs: reply.roundTripMs,
      rssBeforeMb: round(beforeKb / 1024),
      rssPeakDeltaMb: round((peakKb - beforeKb) / 1024),
      pageMessages: page?.messages?.length,
      totalCount: page?.totalCount,
    };
  } finally {
    clearInterval(timer);
  }
}

async function mem(host: Host) {
  const answer = await host.client.probe('mem', { gc: true });
  return {
    rssMb: round(Number((answer.memoryUsage as Message).rss) / 1048576),
    heapUsedMb: round(Number((answer.heap as Message).usedHeapSize) / 1048576),
  };
}

function logBytes(dshHome: string): number {
  let total = 0;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (full.includes(DSH_ID)) total += statSync(full).size;
    }
  };
  walk(join(dshHome, 'sessions'));
  return total;
}

async function main(): Promise<number> {
  await waitQuiet();
  const available = availableMb();
  if (available < MIN_AVAILABLE_MB) {
    process.stderr.write(`[read-page] only ${Math.round(available)} MB available; not starting\n`);
    return 2;
  }
  const scratchRoot = join('/var/tmp', `aiclient-dsh-read-page-${Date.now()}`);
  mkdirSync(scratchRoot, { recursive: true, mode: 0o700 });
  const box = sandbox(scratchRoot, 'run');
  const hostCwd = join(box.root, 'host-cwd');
  mkdirSync(hostCwd, { recursive: true, mode: 0o700 });
  installProbeBundle(box.dshHome);
  const report: Record<string, unknown> = {
    node: nodeBin,
    turns,
    hosts: hostCount,
    availableMb: round(available),
  };

  const source = syntheticSession(box.workspace);
  const converted = convertPiSessionBytes(source.bytes, {
    sourceFile: join(box.root, 'synthetic.jsonl'),
    cwd: box.workspace,
  });
  if (!converted.ok) throw new Error(`conversion failed: ${JSON.stringify(converted.failure)}`);
  report.session = {
    sourceBytes: source.bytes.length,
    messages: source.messages,
    seedEvents: converted.seed.length,
    seedJsonBytes: JSON.stringify(converted.seed).length,
  };

  const gateway = await startGateway(box.root);
  const env = {
    ...baseEnv(box),
    DSH_HOME: box.dshHome,
    DSH_TELEMETRY_DISABLED: '1',
    AICLIENT_DSH_PROBE_ROW: '0',
  };
  // P1-5: Main's model source, played — one route to the gateway, a fake key per request.
  const plan = fakeGatewayPlan({ baseUrl: `http://127.0.0.1:${gateway.port}` });
  const live: Host[] = [];
  const startHost = async (label: string): Promise<Host> => {
    const child = spawn(
      nodeBin,
      ['--expose-internals', '--expose-gc', '--import', hooksEntry, hostEntry],
      { cwd: hostCwd, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }
    );
    const host = {
      child,
      client: new HostClient(child, { requestPrefix: `read-page-${label}` }),
      stderr: captureStderr(child),
      exited: exitOf(child),
    };
    host.client.configure(plan, 'p1-4a-fake-key');
    live.push(host);
    const ready = await host.client.control(
      (m) => m.type === 'ready' || m.type === 'fatal',
      180_000
    );
    if (ready?.type !== 'ready') throw new Error(`${label}: no ready ${JSON.stringify(ready)}`);
    return host;
  };
  const stopHost = async (host: Host) => {
    host.client.send({ type: 'shutdown' });
    await Promise.race([host.exited, sleep(15_000)]);
    if (host.child.exitCode === null && host.child.signalCode === null) host.child.kill('SIGKILL');
    await host.exited;
  };
  const stubFile = join(box.dshHome, 'aiclient-sessions', `${DSH_ID}.dsh.json`);
  try {
    const seeder = await startHost('seed');
    const seeded = await seeder.client.probe(
      'seed',
      { sessionId: DSH_ID, cwd: box.workspace, events: converted.seed },
      300_000
    );
    report.seedMs = seeded.ms;
    await stopHost(seeder);
    report.logBytesOnDisk = logBytes(box.dshHome);
    mkdirSync(dirname(stubFile), { recursive: true, mode: 0o700 });
    const stub = {
      engine: 'dsh',
      version: 1,
      dshSessionId: DSH_ID,
      logicalSessionId: LOGICAL,
      cwd: box.workspace,
      createdAt: Date.now(),
    };
    writeFileSync(stubFile, `${JSON.stringify(stub, null, 2)}\n`);

    const runs: unknown[] = [];
    for (let index = 1; index <= hostCount; index += 1) {
      const host = await startHost(`h${index}`);
      await sleep(500);
      const run: Record<string, unknown> = { host: index, idle: await mem(host) };
      if (index === 1) {
        run.bareObserveFirst = await host.client.probe('observe-stat', { sessionId: DSH_ID });
        run.readAfterObserve = await measuredRead(host, stubFile);
      } else {
        run.coldRead = await measuredRead(host, stubFile);
        run.warmRead = await measuredRead(host, stubFile);
      }
      run.afterReads = await mem(host);
      if (index === hostCount) {
        const ch = host.client.openChannel();
        const started = performance.now();
        await host.client.request(ch, 'worker.bootstrap', {
          logicalSessionId: LOGICAL,
          cwd: box.workspace,
          sessionFile: stubFile,
          permissions: BYPASS_PERMISSIONS,
        });
        run.resumeBootstrapMs = Math.round(performance.now() - started);
        run.afterResume = await mem(host);
        run.liveReads = [await measuredRead(host, stubFile), await measuredRead(host, stubFile)];
        run.bareObserveLive = await host.client.probe('observe-stat', { sessionId: DSH_ID });
        await host.client.request(ch, 'worker.dispose', { reason: 'slot-dispose' });
      }
      runs.push(run);
      await stopHost(host);
    }
    report.runs = runs;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    report.stderrTail = live.at(-1)?.stderr().slice(-3000);
  } finally {
    for (const host of live) {
      if (host.child.exitCode === null && host.child.signalCode === null)
        host.child.kill('SIGKILL');
      await host.exited;
    }
    gateway.child.kill('SIGTERM');
  }
  const json = `${JSON.stringify(report, null, 2)}\n`.split(scratchRoot).join('<scratch>');
  if (outFile) writeFileSync(outFile, json);
  process.stdout.write(json);
  if (!keep) rmSync(scratchRoot, { recursive: true, force: true });
  return report.error ? 1 : 0;
}

process.exitCode = await main();
