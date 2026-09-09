import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createRuntime, type RuntimeHandle } from '../../../../runtime/index';
import {
  fauxAssistantMessage,
  fauxProvider,
} from '../../../../runtime/node_modules/@earendil-works/pi-ai/dist/providers/faux.js';
import type { RuntimeEvent } from '../../../../shared/types/runtimeEvents';
import { NativeSessionIndexAdapter } from '../NativeSessionIndexAdapter';
import { SessionIndexService } from '../SessionIndexService';

let dir = '';
vi.mock('electron', () => ({ app: { getPath: () => dir } }));
const runtimes: RuntimeHandle[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'native-session-index-'));
});
afterEach(async () => {
  for (const r of runtimes.splice(0)) await r.dispose();
  await rm(dir, { recursive: true, force: true });
});
async function client(mode: 'create' | 'resume') {
  const faux = fauxProvider({ provider: 'test', models: [{ id: 'test', name: 'Test' }] });
  const runtime = await createRuntime({
    providers: [faux.provider],
    env: {},
    session: { file: join(dir, 'runtime.jsonl'), cwd: dir, mode },
  });
  runtimes.push(runtime);
  return { runtime, faux };
}
it('creates, runs, reopens and rewinds against the real persisted Main index', async () => {
  const first = await client('create');
  const index = new SessionIndexService();
  const events: RuntimeEvent[] = [];
  let seq = 0;
  const adapter = new NativeSessionIndexAdapter({
    runtime: first.runtime,
    index,
    sessionId: 'logical',
    emit: (e) => events.push(e),
    nextSequence: () => ++seq,
  });
  await adapter.connect('create');
  first.faux.setResponses([fauxAssistantMessage('first reply')]);
  const result = await adapter.run({ prompt: 'original', systemPrompt: 'probe' });
  expect(result.success).toBe(true);
  let indexed = await index.get('logical');
  expect(indexed?.runtimeIdentity).toBe(first.runtime.session?.file);
  expect(indexed?.piLeaf).toEqual(first.runtime.session?.metadata().leaf);
  expect(events.some((e) => e.type === 'session.completed')).toBe(true);
  expect(events.every((e, i) => e.seq === i + 1)).toBe(true);
  const user = first.runtime
    .session!.snapshot()
    .entries.find((e) => e.type === 'message' && e.message.role === 'user')!;
  await adapter.rewind(user.id, true);
  expect((await index.get('logical'))?.piLeaf?.activeEntryId).toBe(user.parentId);
  adapter.disconnect();
  await first.runtime.dispose();
  const second = await client('resume');
  const freshIndex = new SessionIndexService();
  const resumed = new NativeSessionIndexAdapter({
    runtime: second.runtime,
    index: freshIndex,
    sessionId: 'logical',
    emit: (e) => events.push(e),
    nextSequence: () => ++seq,
  });
  await resumed.connect('resume');
  indexed = await freshIndex.get('logical');
  expect(indexed?.piLeaf).toEqual(second.runtime.session!.metadata().leaf);
  const disk = JSON.parse(await readFile(join(dir, 'session-index.json'), 'utf8'));
  expect(disk[0].runtimeIdentity).toBe(indexed?.runtimeIdentity);
  expect(events.some((e) => e.type === 'session.history')).toBe(true);
  resumed.disconnect();
});
it('rejects wrong resume identity before emitting activation', async () => {
  const { runtime } = await client('create');
  const index = new SessionIndexService();
  await index.recordCreated({ sessionId: 'logical', workspacePath: dir, agent: 'pi' });
  await index.bindRuntimeIdentity('logical', '/different.jsonl');
  const emit = vi.fn();
  const adapter = new NativeSessionIndexAdapter({
    runtime,
    index,
    sessionId: 'logical',
    emit,
    nextSequence: () => 1,
  });
  await expect(adapter.connect('resume')).rejects.toThrow('identity mismatch');
  expect(emit).not.toHaveBeenCalled();
  expect((await index.get('logical'))?.runtimeIdentity).toBe('/different.jsonl');
});
it('does not announce success when the leaf index write fails', async () => {
  const { runtime, faux } = await client('create');
  const index = new SessionIndexService();
  const events: RuntimeEvent[] = [];
  const adapter = new NativeSessionIndexAdapter({
    runtime,
    index,
    sessionId: 'logical',
    emit: (e) => events.push(e),
    nextSequence: () => events.length + 1,
  });
  await adapter.connect('create');
  faux.setResponses([fauxAssistantMessage('done')]);
  vi.spyOn(index, 'commitResumed').mockRejectedValue(new Error('index unavailable'));
  await expect(adapter.run({ prompt: 'hello', systemPrompt: 'probe' })).rejects.toThrow(
    'index unavailable'
  );
  expect(events.some((e) => e.type === 'session.completed')).toBe(false);
  expect(events.some((e) => e.type === 'session.failed')).toBe(true);
  adapter.disconnect();
});

it('rolls back navigation, holds the operation across index commit and cleans failed forks', async () => {
  const { runtime, faux } = await client('create');
  const index = new SessionIndexService();
  const adapter = new NativeSessionIndexAdapter({
    runtime,
    index,
    sessionId: 'logical',
    emit: () => {},
    nextSequence: () => 1,
  });
  await adapter.connect('create');
  faux.setResponses([fauxAssistantMessage('original')]);
  await adapter.run({ prompt: 'task', systemPrompt: 'probe' });
  const before = runtime.session!.metadata();
  let rejectCommit = (_error: Error) => {};
  let entered = () => {};
  const entering = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const commit = vi.spyOn(index, 'commitPiLeaf').mockImplementation(() => {
    entered();
    return new Promise((_resolve, reject) => {
      rejectCommit = reject;
    });
  });
  const navigation = adapter.navigate(null);
  const failure = expect(navigation).rejects.toThrow('index write failed');
  await entering;
  await expect(adapter.run({ prompt: 'concurrent' })).rejects.toThrow('busy');
  await expect(adapter.navigate(null)).rejects.toThrow('busy');
  rejectCommit(new Error('index write failed'));
  await failure;
  expect(runtime.session!.metadata().leaf).toEqual(before.leaf);
  expect((await index.get('logical'))?.piLeaf).toEqual(before.leaf);
  commit.mockRestore();
  const fork = join(dir, 'fork.jsonl');
  const createForked = vi
    .spyOn(index, 'createForked')
    .mockRejectedValue(new Error('index unavailable'));
  await expect(adapter.fork(fork, before.leaf.activeEntryId!, 'fork-logical')).rejects.toThrow(
    'index unavailable'
  );
  await expect(readFile(fork)).rejects.toMatchObject({ code: 'ENOENT' });
  createForked.mockRestore();
  await adapter.fork(fork, before.leaf.activeEntryId!, 'fork-logical');
  expect((await index.get('fork-logical'))?.runtimeIdentity).toBe(fork);
  expect(runtime.session!.metadata().leaf).toEqual(before.leaf);
  await adapter.rename('renamed');
  expect((await index.get('logical'))?.title).toBe('renamed');
  expect(runtime.session!.metadata().title).toBe('renamed');
  adapter.disconnect();
});
it('restores the legacy index binding if migration activation cannot commit', async () => {
  const source = join(dir, 'legacy.jsonl');
  await writeFile(
    source,
    `${JSON.stringify({ type: 'session', version: 3, id: 'old', timestamp: new Date().toISOString(), cwd: dir })}\n`
  );
  const faux = fauxProvider({ provider: 'test', models: [{ id: 'test', name: 'Test' }] });
  const runtime = await createRuntime({
    env: {},
    providers: [faux.provider],
    session: { file: source, cwd: dir, mode: 'resume' },
  });
  runtimes.push(runtime);
  const index = new SessionIndexService();
  await index.recordCreated({ sessionId: 'logical', agent: 'pi', workspacePath: dir });
  await index.bindRuntimeIdentity('logical', source);
  const emit = vi.fn();
  const adapter = new NativeSessionIndexAdapter({
    runtime,
    index,
    sessionId: 'logical',
    emit,
    nextSequence: () => 1,
  });
  const commit = vi.spyOn(index, 'commitResumed').mockRejectedValue(new Error('index failed'));
  await expect(adapter.connect('resume')).rejects.toThrow('index failed');
  expect((await index.get('logical'))?.runtimeIdentity).toBe(source);
  expect(emit).not.toHaveBeenCalled();
  commit.mockRestore();
  await adapter.connect('resume');
  expect((await index.get('logical'))?.runtimeIdentity).toBe(runtime.session!.file);
  adapter.disconnect();
});
it('pages native history using the existing newest-first offset contract', async () => {
  const { runtime } = await client('create');
  for (let i = 0; i < 7; i++)
    await runtime.session!.appendMessage({ role: 'user', content: `m${i}`, timestamp: Date.now() });
  const index = new SessionIndexService();
  const events: RuntimeEvent[] = [];
  const adapter = new NativeSessionIndexAdapter({
    runtime,
    index,
    sessionId: 'logical',
    emit: (event) => events.push(event),
    nextSequence: () => events.length + 1,
  });
  await adapter.connect('import');
  const newest = adapter.history('page-1', 0, 3);
  const older = adapter.history('page-2', 3, 3);
  expect(newest).toMatchObject({ totalCount: 7, limit: 3, offset: 0, hasMore: true });
  expect(JSON.stringify(newest.messages)).toContain('m6');
  expect(JSON.stringify(newest.messages)).not.toContain('m0');
  expect(JSON.stringify(older.messages)).toContain('m1');
  expect(adapter.history('page-3', 0, 999).limit).toBe(500);
  adapter.disconnect();
});

it('restores both index memory and transcript title after a failed rename write', async () => {
  const { runtime } = await client('create');
  let fail = false;
  const index = new SessionIndexService({
    writeAtomically: async (path, data) => {
      if (fail) throw new Error('rename disk failure');
      await writeFile(path, JSON.stringify(data));
    },
  });
  const adapter = new NativeSessionIndexAdapter({
    runtime,
    index,
    sessionId: 'logical',
    emit: () => {},
    nextSequence: () => 1,
  });
  await adapter.connect('create');
  await adapter.rename('original title');
  await index.get('logical');
  fail = true;
  await expect(adapter.rename('rejected title')).rejects.toThrow('rename disk failure');
  expect(runtime.session!.metadata().title).toBe('original title');
  expect((await index.get('logical'))?.title).toBe('original title');
  fail = false;
  await index.setArchived('logical', true);
  const disk = JSON.parse(await readFile(join(dir, 'session-index.json'), 'utf8'));
  expect(disk[0].title).toBe('original title');
  adapter.disconnect();
});
