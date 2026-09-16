/**
 * T024 — the two ceilings `runs.jsonl` never had.
 *
 * Trace persistence was append-only with no upper bound anywhere: the file grew
 * for the life of the trace directory, and `TracePlugin.runs` kept every trace
 * the process ever produced alive in memory (permissions-12's second half).
 * Neither had a test, because neither had a limit to assert.
 *
 * Everything here drives the plugin through a fake host IO rather than the real
 * filesystem, so a rotation can be watched one rename at a time and a failing
 * rename does not need a read-only directory to reproduce.
 */

import { fork } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from 'cordis';
import { expect, it } from 'vitest';
import type {
  RuntimeFileInfo,
  RuntimeHostIoService,
  RuntimeReadOptions,
  RuntimeReadResult,
  RuntimeWriteOptions,
} from '../contracts.ts';
import { TracePlugin, type TracePluginConfig } from '../trace.ts';

const DIR = '/traces';
/**
 * Every path this file both hands to the plugin and looks up in the fake's
 * `files` map has to be built the same way the plugin builds it. A literal
 * `/traces/runs.jsonl` is the same string on POSIX but not on Windows, where
 * the plugin's own `join` produces `/traces\runs.jsonl` — the test would then
 * read an empty map and believe nothing was ever written.
 */
const tracePath = (...segments: string[]): string => join(DIR, ...segments);
const RUNS = tracePath('runs.jsonl');

function ioError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** In-memory stand-in for the host's IO service; only the trace path is used. */
class FakeIo implements RuntimeHostIoService {
  readonly files = new Map<string, Buffer>();
  readonly calls: string[] = [];
  /** Path → error thrown on the next call of that operation. */
  failAppend?: Error;
  failRename?: Error;
  /** Fires once, inside the next `stat`. See {@link FakeIo.stat}. */
  onStat?: () => Promise<void>;

  appendFile(path: string, bytes: Uint8Array): Promise<void> {
    this.calls.push(`append ${path}`);
    if (this.failAppend) return Promise.reject(this.failAppend);
    this.files.set(
      path,
      Buffer.concat([this.files.get(path) ?? Buffer.alloc(0), Buffer.from(bytes)])
    );
    return Promise.resolve();
  }
  async stat(path: string): Promise<RuntimeFileInfo> {
    this.calls.push(`stat ${path}`);
    const file = this.files.get(path);
    // Runs after the size is read and before the caller sees it: the instant a
    // second worker gets to act on the same oversized file.
    const hook = this.onStat;
    this.onStat = undefined;
    await hook?.();
    if (!file) throw ioError('ENOENT', `no such file: ${path}`);
    return { kind: 'file', size: file.byteLength, mtimeMs: 0 };
  }
  rename(from: string, to: string): Promise<void> {
    this.calls.push(`rename ${from} -> ${to}`);
    if (this.failRename) return Promise.reject(this.failRename);
    const file = this.files.get(from);
    if (!file) return Promise.reject(ioError('ENOENT', `no such file: ${from}`));
    this.files.delete(from);
    this.files.set(to, file);
    return Promise.resolve();
  }
  unlink(path: string): Promise<void> {
    this.calls.push(`unlink ${path}`);
    if (!this.files.delete(path)) return Promise.reject(ioError('ENOENT', `no such file: ${path}`));
    return Promise.resolve();
  }
  readFile(path: string, options: RuntimeReadOptions): Promise<RuntimeReadResult> {
    this.calls.push(`read ${path}`);
    const file = this.files.get(path);
    if (!file) return Promise.reject(ioError('ENOENT', `no such file: ${path}`));
    const truncated = file.byteLength > options.maxBytes;
    return Promise.resolve({
      bytes: truncated ? file.subarray(0, options.maxBytes) : file,
      truncated,
      source: 'direct',
    });
  }
  writeFile(path: string, bytes: Uint8Array, options?: RuntimeWriteOptions): Promise<void> {
    this.calls.push(`write ${path}`);
    // `createOnly` is the whole mutual exclusion the rotation lock rests on, so
    // the stand-in has to refuse an existing name the way the real one does.
    if (options?.createOnly && this.files.has(path))
      return Promise.reject(ioError('EEXIST', `file already exists: ${path}`));
    this.files.set(path, Buffer.from(bytes));
    return Promise.resolve();
  }
  realpath(): Promise<string> {
    throw new Error('not used');
  }
  readDirectory(): AsyncIterable<{ name: string; kind: RuntimeFileInfo['kind'] }> {
    throw new Error('not used');
  }
  mkdir(): Promise<void> {
    throw new Error('not used');
  }
  rmdir(): Promise<void> {
    throw new Error('not used');
  }
}

function tracer(io: FakeIo, config: Partial<TracePluginConfig> = {}): TracePlugin {
  return new TracePlugin(new Context(), {
    io,
    dir: DIR,
    versionStamp: { config_version: 'test' },
    now: () => 0,
    ...config,
  });
}

/** One finished run whose serialized line is at least `size` bytes. */
async function record(trace: TracePlugin, label: string, size = 0): Promise<void> {
  const run = trace.begin({
    runId: label,
    input: label.padEnd(size, '.'),
    model: 'm',
    provider: 'p',
  });
  await run.finish({ final_output: 'ok', usage: null, success: true });
}

function lineIds(io: FakeIo, path: string): string[] {
  const file = io.files.get(path);
  if (!file) return [];
  return file
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { run_id: string }).run_id);
}

it('rotates runs.jsonl once the next line would cross the byte ceiling', async () => {
  const io = new FakeIo();
  const trace = tracer(io, { maxFileBytes: 9_000, fileGenerations: 2 });
  await record(trace, 'a', 4_000);
  await record(trace, 'b', 4_000);
  expect(lineIds(io, RUNS)).toEqual(['a', 'b']);
  expect(io.files.has(tracePath('runs.1.jsonl'))).toBe(false);

  await record(trace, 'c', 4_000);
  // The crossing run starts the new file; the full ones move aside intact.
  expect(lineIds(io, RUNS)).toEqual(['c']);
  expect(lineIds(io, tracePath('runs.1.jsonl'))).toEqual(['a', 'b']);
  await trace.flush();
});

it('keeps only the configured number of rotated generations', async () => {
  const io = new FakeIo();
  const trace = tracer(io, { maxFileBytes: 5_000, fileGenerations: 2 });
  for (const label of ['a', 'b', 'c', 'd']) await record(trace, label, 4_000);
  expect(lineIds(io, RUNS)).toEqual(['d']);
  expect(lineIds(io, tracePath('runs.1.jsonl'))).toEqual(['c']);
  expect(lineIds(io, tracePath('runs.2.jsonl'))).toEqual(['b']);
  // `a` fell off the end rather than accumulating a third generation.
  expect([...io.files.keys()].sort()).toEqual([
    tracePath('runs.1.jsonl'),
    tracePath('runs.2.jsonl'),
    RUNS,
  ]);
  await trace.flush();
});

it('deletes instead of rotating when no generations are kept', async () => {
  const io = new FakeIo();
  const trace = tracer(io, { maxFileBytes: 5_000, fileGenerations: 0 });
  await record(trace, 'a', 4_000);
  await record(trace, 'b', 4_000);
  expect(lineIds(io, RUNS)).toEqual(['b']);
  expect([...io.files.keys()]).toEqual([RUNS]);
  await trace.flush();
});

it('writes a single oversized trace whole rather than splitting it', async () => {
  const io = new FakeIo();
  const trace = tracer(io, { maxFileBytes: 1_000, fileGenerations: 1 });
  await record(trace, 'huge', 5_000);
  // Nothing to rotate on an empty file, so the line lands complete.
  expect(lineIds(io, RUNS)).toEqual(['huge']);
  expect(io.files.has(tracePath('runs.1.jsonl'))).toBe(false);
  // The next run rotates it away instead of appending to an already-over file.
  await record(trace, 'next', 10);
  expect(lineIds(io, RUNS)).toEqual(['next']);
  expect(lineIds(io, tracePath('runs.1.jsonl'))).toEqual(['huge']);
  await trace.flush();
});

it('measures the file on disk, so a new process inherits its predecessor size', async () => {
  const io = new FakeIo();
  io.files.set(RUNS, Buffer.alloc(900, 'x'));
  const trace = tracer(io, { maxFileBytes: 500, fileGenerations: 1 });
  await record(trace, 'fresh', 10);
  expect(lineIds(io, RUNS)).toEqual(['fresh']);
  expect(io.files.get(tracePath('runs.1.jsonl'))?.byteLength).toBe(900);
  await trace.flush();
});

it('never rotates when the ceiling is disabled', async () => {
  const io = new FakeIo();
  const trace = tracer(io, { maxFileBytes: 0, fileGenerations: 3 });
  for (const label of ['a', 'b', 'c']) await record(trace, label, 4_000);
  expect(lineIds(io, RUNS)).toEqual(['a', 'b', 'c']);
  expect(io.calls.some((call) => call.startsWith('rename'))).toBe(false);
  await trace.flush();
});

it('still writes the trace when rotation fails, and says so', async () => {
  const io = new FakeIo();
  const trace = tracer(io, { maxFileBytes: 5_000, fileGenerations: 1 });
  await record(trace, 'a', 4_000);
  io.failRename = ioError('EACCES', 'permission denied');
  const run = trace.begin({ runId: 'b', input: 'b'.padEnd(4_000, '.'), model: 'm', provider: 'p' });
  const written = await run.finish({ final_output: 'ok', usage: null, success: true });
  // The record survives the housekeeping failure...
  expect(lineIds(io, RUNS)).toEqual(['a', 'b']);
  // ...and the failure is still reported through the existing channel.
  expect(written.persistence_error?.code).toBe('trace_rotate_failed');
  await expect(trace.flush()).rejects.toThrow(/rotation failed/);
});

it('reports an append failure exactly as before', async () => {
  const io = new FakeIo();
  const trace = tracer(io, { maxFileBytes: 5_000, fileGenerations: 1 });
  io.failAppend = ioError('EISDIR', 'illegal operation on a directory');
  const run = trace.begin({ runId: 'a', input: 'a', model: 'm', provider: 'p' });
  const written = await run.finish({ final_output: 'ok', usage: null, success: true });
  expect(written.persistence_error?.code).toBe('trace_write_failed');
  await expect(trace.flush()).rejects.toThrow(/illegal operation/);
});

it('caps the in-memory mirror by count, dropping the oldest', async () => {
  const io = new FakeIo();
  const trace = tracer(io, { dir: null, maxMemoryRuns: 3 });
  for (const label of ['a', 'b', 'c', 'd', 'e']) await record(trace, label);
  expect(trace.runs.map((entry) => entry.run_id)).toEqual(['c', 'd', 'e']);
  expect(trace.evictedRuns).toBe(2);
});

it('caps the in-memory mirror by bytes as well as by count', async () => {
  const io = new FakeIo();
  const trace = tracer(io, { dir: null, maxMemoryRuns: 1000, maxMemoryBytes: 10_000 });
  for (const label of ['a', 'b', 'c']) await record(trace, label, 4_000);
  // Two runs of this size fit, three do not — the count ceiling would have let
  // all three through.
  expect(trace.runs.map((entry) => entry.run_id)).toEqual(['b', 'c']);
  expect(trace.evictedRuns).toBe(1);
});

it('keeps the newest run even when it alone exceeds the byte ceiling', async () => {
  const io = new FakeIo();
  const trace = tracer(io, { dir: null, maxMemoryBytes: 1_000 });
  await record(trace, 'a', 50);
  await record(trace, 'enormous', 5_000);
  expect(trace.runs.map((entry) => entry.run_id)).toEqual(['enormous']);
  expect(trace.evictedRuns).toBe(1);
});

const ROTATE_LOCK = tracePath('runs.rotate.lock');

/** A rotation lock as another worker would have left it. */
function rotationLock(owner: { pid: number; token: string; acquiredAt: number }): Buffer {
  return Buffer.from(JSON.stringify({ host: hostname(), ...owner }));
}

it('rotates once when a second worker crosses the ceiling at the same moment', async () => {
  const io = new FakeIo();
  io.files.set(RUNS, Buffer.alloc(900, 'x'));
  const mine = tracer(io, { maxFileBytes: 500, fileGenerations: 2 });
  // The peer worker: a plugin instance of its own, which is all a second
  // process is as far as this file is concerned — its appends are serialized
  // against its own runs and nobody else's.
  const peer = tracer(io, { maxFileBytes: 500, fileGenerations: 2, rotationLockWaitMs: 0 });
  io.onStat = async () => {
    await record(peer, 'peer', 10);
  };

  await record(mine, 'mine', 10);
  await mine.flush();
  await peer.flush();

  // concurrency-03 — a second pass over the same generations would push the
  // 900-byte file all the way to runs.2 and leave runs.1 holding only what
  // arrived after it: one generation retired a whole cycle early, and a hole
  // where readers count backwards from runs.1.
  expect(io.files.has(tracePath('runs.2.jsonl'))).toBe(false);
  const rotated = io.files.get(tracePath('runs.1.jsonl'))?.toString('utf8') ?? '';
  expect(rotated.startsWith('x'.repeat(900))).toBe(true);
  expect(rotated).toContain('"run_id":"peer"');
  expect(lineIds(io, RUNS)).toEqual(['mine']);
});

it('appends without rotating while another worker holds the directory lock', async () => {
  const io = new FakeIo();
  io.files.set(RUNS, Buffer.alloc(900, 'x'));
  io.files.set(
    ROTATE_LOCK,
    rotationLock({ pid: process.pid, token: 'peer', acquiredAt: Date.now() })
  );
  const trace = tracer(io, { maxFileBytes: 500, fileGenerations: 2, rotationLockWaitMs: 0 });

  await record(trace, 'mine', 10);
  // Losing the race for the lock is housekeeping deferred, not a failure: the
  // peer is rotating, and the next run finds the fresh file.
  await trace.flush();
  expect(io.files.has(tracePath('runs.1.jsonl'))).toBe(false);
  expect(io.files.get(RUNS)?.toString('utf8')).toContain('"run_id":"mine"');
  expect(JSON.parse(io.files.get(ROTATE_LOCK)?.toString('utf8') ?? '{}').token).toBe('peer');
});

it('drops a rotation lock stranded by a crash and releases its own', async () => {
  const io = new FakeIo();
  io.files.set(RUNS, Buffer.alloc(900, 'x'));
  io.files.set(
    ROTATE_LOCK,
    // Same pid, so liveness alone would call it held; a rotation is a handful
    // of renames, so an age like this can only be debris.
    rotationLock({ pid: process.pid, token: 'stranded', acquiredAt: Date.now() - 600_000 })
  );
  const trace = tracer(io, { maxFileBytes: 500, fileGenerations: 2 });

  await record(trace, 'mine', 10);
  await trace.flush();
  expect(io.files.get(tracePath('runs.1.jsonl'))?.byteLength).toBe(900);
  expect(lineIds(io, RUNS)).toEqual(['mine']);
  // Released rather than left for the next worker to time out on.
  expect(io.files.has(ROTATE_LOCK)).toBe(false);
});

it('loses no run when two processes rotate one directory between them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'trace-race-'));
  try {
    const runs = 6;
    await Promise.all([
      raceTrace(dir, 'alpha', runs, 5_000, 3),
      raceTrace(dir, 'beta', runs, 5_000, 3),
    ]);

    const written = (await readdir(dir)).filter((name) => /^runs(\.\d+)?\.jsonl$/.test(name));
    const ids: string[] = [];
    for (const name of written) {
      const content = await readFile(join(dir, name), 'utf8');
      for (const line of content.split('\n').filter(Boolean)) {
        // A torn or interleaved append shows up here first: the line either
        // parses as one run or it does not exist.
        ids.push((JSON.parse(line) as { run_id: string }).run_id);
      }
    }
    expect(ids.sort()).toEqual(
      [
        ...Array.from({ length: runs }, (_, i) => `alpha-${i}`),
        ...Array.from({ length: runs }, (_, i) => `beta-${i}`),
      ].sort()
    );
    // Generations stay contiguous: a double rotation is visible as runs.2
    // existing while runs.1 does not.
    for (let index = written.length - 1; index >= 1; index--)
      expect(written).toContain(`runs.${index}.jsonl`);
    // Neither process left its lock behind.
    expect((await readdir(dir)).filter((name) => name.endsWith('.lock'))).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);

/** Start one real trace writer and resolve when it has written everything. */
function raceTrace(
  dir: string,
  label: string,
  count: number,
  maxFileBytes: number,
  generations: number
): Promise<void> {
  const script = fileURLToPath(new URL('./fixtures/traceRace.ts', import.meta.url));
  const child = fork(
    script,
    [dir, label, String(count), String(maxFileBytes), String(generations)],
    // Type stripping, the way every other `.ts` child in this repo is started.
    { execArgv: ['--experimental-strip-types'], stdio: 'inherit' }
  );
  return new Promise<void>((resolve, reject) => {
    child.on('message', (message: unknown) => {
      // Released together, so the two processes reach the ceiling at the same
      // time instead of queueing behind each other's startup.
      if (message === 'ready') return void child.send('go');
      if (message === 'done') return void resolve();
    });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`writer exited ${code}`))
    );
  });
}
