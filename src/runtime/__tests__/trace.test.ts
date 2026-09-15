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

import { Context } from 'cordis';
import { expect, it } from 'vitest';
import type { RuntimeFileInfo, RuntimeHostIoService, RuntimeReadResult } from '../contracts.ts';
import { TracePlugin, type TracePluginConfig } from '../trace.ts';

const DIR = '/traces';
const RUNS = `${DIR}/runs.jsonl`;

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

  appendFile(path: string, bytes: Uint8Array): Promise<void> {
    this.calls.push(`append ${path}`);
    if (this.failAppend) return Promise.reject(this.failAppend);
    this.files.set(
      path,
      Buffer.concat([this.files.get(path) ?? Buffer.alloc(0), Buffer.from(bytes)])
    );
    return Promise.resolve();
  }
  stat(path: string): Promise<RuntimeFileInfo> {
    this.calls.push(`stat ${path}`);
    const file = this.files.get(path);
    if (!file) return Promise.reject(ioError('ENOENT', `no such file: ${path}`));
    return Promise.resolve({ kind: 'file', size: file.byteLength, mtimeMs: 0 });
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
  readFile(): Promise<RuntimeReadResult> {
    throw new Error('not used');
  }
  writeFile(): Promise<void> {
    throw new Error('not used');
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
  expect(io.files.has(`${DIR}/runs.1.jsonl`)).toBe(false);

  await record(trace, 'c', 4_000);
  // The crossing run starts the new file; the full ones move aside intact.
  expect(lineIds(io, RUNS)).toEqual(['c']);
  expect(lineIds(io, `${DIR}/runs.1.jsonl`)).toEqual(['a', 'b']);
  await trace.flush();
});

it('keeps only the configured number of rotated generations', async () => {
  const io = new FakeIo();
  const trace = tracer(io, { maxFileBytes: 5_000, fileGenerations: 2 });
  for (const label of ['a', 'b', 'c', 'd']) await record(trace, label, 4_000);
  expect(lineIds(io, RUNS)).toEqual(['d']);
  expect(lineIds(io, `${DIR}/runs.1.jsonl`)).toEqual(['c']);
  expect(lineIds(io, `${DIR}/runs.2.jsonl`)).toEqual(['b']);
  // `a` fell off the end rather than accumulating a third generation.
  expect([...io.files.keys()].sort()).toEqual([`${DIR}/runs.1.jsonl`, `${DIR}/runs.2.jsonl`, RUNS]);
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
  expect(io.files.has(`${DIR}/runs.1.jsonl`)).toBe(false);
  // The next run rotates it away instead of appending to an already-over file.
  await record(trace, 'next', 10);
  expect(lineIds(io, RUNS)).toEqual(['next']);
  expect(lineIds(io, `${DIR}/runs.1.jsonl`)).toEqual(['huge']);
  await trace.flush();
});

it('measures the file on disk, so a new process inherits its predecessor size', async () => {
  const io = new FakeIo();
  io.files.set(RUNS, Buffer.alloc(900, 'x'));
  const trace = tracer(io, { maxFileBytes: 500, fileGenerations: 1 });
  await record(trace, 'fresh', 10);
  expect(lineIds(io, RUNS)).toEqual(['fresh']);
  expect(io.files.get(`${DIR}/runs.1.jsonl`)?.byteLength).toBe(900);
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
