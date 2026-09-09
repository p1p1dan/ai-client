import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createRuntime, type RuntimeHandle } from '../bootstrap.ts';

let dir: string;
const handles: RuntimeHandle[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'session-navigation-'));
});
afterEach(async () => {
  for (const handle of handles) await handle.dispose();
  handles.length = 0;
  await rm(dir, { recursive: true, force: true });
});
async function runtime(file = join(dir, 'session.jsonl'), mode: 'create' | 'resume' = 'create') {
  const faux = fauxProvider({ provider: 'test', models: [{ id: 'test', name: 'Test' }] });
  const handle = await createRuntime({
    providers: [faux.provider],
    env: {},
    session: { file, cwd: dir, mode },
  });
  handles.push(handle);
  return { handle, faux };
}
it('persists branch switching and rewind-before-user without deleting either branch', async () => {
  const { handle, faux } = await runtime();
  faux.setResponses([
    fauxAssistantMessage('answer one'),
    fauxAssistantMessage('answer two'),
    fauxAssistantMessage('alternate answer'),
  ]);
  await handle.run({ prompt: 'one', systemPrompt: 'probe' });
  await handle.run({ prompt: 'two', systemPrompt: 'probe' });
  const entries = handle.session!.snapshot().entries.filter((entry) => entry.type === 'message');
  const secondUser = entries[2];
  await expect(handle.session!.rewind(secondUser.id, false)).rejects.toMatchObject({
    code: 'session_confirmation_required',
  });
  const rewound = await handle.session!.rewind(secondUser.id, true);
  expect(rewound.editorText).toBe('two');
  expect(rewound.leaf.activeEntryId).toBe(entries[1].id);
  await handle.run({ prompt: 'alternate', systemPrompt: 'probe' });
  expect(
    handle.session!.tree().nodes.filter((entry) => entry.entryType === 'message')
  ).toHaveLength(6);
  expect(
    handle
      .session!.history()
      .map((m) => JSON.stringify(m))
      .join('')
  ).not.toContain('answer two');
  await handle.session!.navigate(entries[3].id);
  await handle.session!.label(entries[3].id, 'original branch');
  await handle.session!.rename('branch demo');
  await handle.dispose();
  const reopened = await runtime(handle.session!.file, 'resume');
  expect(reopened.handle.session!.metadata().title).toBe('branch demo');
  expect(
    reopened.handle.session!.tree().nodes.find((node) => node.id === entries[3].id)?.label
  ).toBe('original branch');
  expect(JSON.stringify(reopened.handle.session!.snapshot().messages)).toContain('answer two');
  expect(JSON.stringify(reopened.handle.session!.snapshot().messages)).not.toContain(
    'alternate answer'
  );
});
it('forks an independent file and preserves source bytes and active leaf', async () => {
  const { handle, faux } = await runtime();
  faux.setResponses([fauxAssistantMessage('source answer')]);
  await handle.run({ prompt: 'source', systemPrompt: 'probe' });
  const source = handle.session!;
  const before = await readFile(source.file, 'utf8');
  const sourceMeta = source.metadata();
  const target = join(dir, 'fork.jsonl');
  const forkMeta = await source.fork(target, sourceMeta.leaf.activeEntryId!);
  expect(forkMeta.id).not.toBe(sourceMeta.id);
  expect(await readFile(source.file, 'utf8')).toBe(before);
  expect(source.metadata()).toEqual(sourceMeta);
  const fork = await runtime(target, 'resume');
  fork.faux.setResponses([fauxAssistantMessage('fork only')]);
  await fork.handle.run({ prompt: 'new path', systemPrompt: 'probe' });
  expect(await readFile(source.file, 'utf8')).toBe(before);
  expect(JSON.stringify(fork.handle.session!.snapshot().messages)).toContain('fork only');
  expect(JSON.parse((await readFile(target, 'utf8')).split('\n')[0]).parentSessionId).toBe(
    sourceMeta.id
  );
});
it('rejects navigation during an active run', async () => {
  const { handle, faux } = await runtime();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  faux.setResponses([
    async () => {
      await gate;
      return fauxAssistantMessage('done');
    },
  ]);
  const run = handle.run({ prompt: 'hi', systemPrompt: 'probe' });
  await expect(handle.session!.navigate(null)).rejects.toMatchObject({ code: 'runtime_busy' });
  release();
  expect((await run).success).toBe(true);
});

it('restores checkpoint, model, thinking and D14 permissions of the selected branch', async () => {
  const faux = fauxProvider({
    provider: 'test',
    models: [
      { id: 'first', name: 'First' },
      { id: 'second', name: 'Second' },
    ],
  });
  const file = join(dir, 'state.jsonl');
  const handle = await createRuntime({
    env: {},
    providers: [faux.provider],
    tools: { cwd: dir },
    session: { file, cwd: dir, mode: 'create' },
  });
  handles.push(handle);
  const session = handle.session!;
  await session.appendEntry({ type: 'model_change', provider: 'test', modelId: 'second' });
  await session.appendEntry({ type: 'thinking_level_change', thinkingLevel: 'high' });
  await session.appendEntry({
    type: 'custom',
    customType: 'aiclient.permissions',
    data: { mode: 'plan', gear: 'ask' },
  });
  await session.appendMessage({ role: 'user', content: 'old task', timestamp: 1 });
  await session.appendMessage({
    ...fauxAssistantMessage('old answer'),
    provider: 'test',
    model: 'second',
  });
  const checkpoint = await session.appendCompaction({
    summary: 'SAVED_CONTEXT',
    retainedTail: [],
    tokensBefore: 100,
  });
  await session.navigate(null);
  await session.appendEntry({ type: 'model_change', provider: 'test', modelId: 'first' });
  await session.appendEntry({ type: 'thinking_level_change', thinkingLevel: 'off' });
  await session.appendEntry({
    type: 'custom',
    customType: 'aiclient.permissions',
    data: { mode: 'agent', gear: 'auto' },
  });
  await session.navigate(checkpoint.id);
  expect(handle.permissions).toMatchObject({ mode: 'plan', gear: 'ask' });
  await handle.dispose();
  const reopened = await createRuntime({
    env: {},
    providers: [faux.provider],
    tools: { cwd: dir },
    session: { file, cwd: dir, mode: 'resume' },
  });
  handles.push(reopened);
  expect(reopened.session!.snapshot()).toMatchObject({
    model: { modelId: 'second' },
    thinkingLevel: 'high',
    checkpoint: { id: checkpoint.id },
  });
  expect(reopened.permissions).toMatchObject({ mode: 'plan', gear: 'ask' });
  faux.setResponses([
    (context) => {
      expect(JSON.stringify(context.messages)).toContain('SAVED_CONTEXT');
      return { ...fauxAssistantMessage('restored'), provider: 'test', model: 'second' };
    },
  ]);
  const result = await reopened.run({ prompt: 'continue', systemPrompt: 'probe' });
  expect(result.success).toBe(true);
  expect(result.trace.model).toBe('second');
  expect(reopened.session!.snapshot().thinkingLevel).toBe('high');
});
it('protects a fork opened by another writer and cleans failed fork creation', async () => {
  const { handle, faux } = await runtime();
  faux.setResponses([fauxAssistantMessage('answer')]);
  await handle.run({ prompt: 'task', systemPrompt: 'probe' });
  const source = handle.session!;
  const before = await readFile(source.file, 'utf8');
  const fork = await source.fork(join(dir, 'fork.jsonl'), source.metadata().leaf.activeEntryId!);
  const opened = await runtime(fork.file, 'resume');
  await expect(source.discardFork(fork.file, fork.id)).rejects.toMatchObject({
    code: 'session_locked',
  });
  await opened.handle.dispose();
  await source.discardFork(fork.file, fork.id);
  await expect(readFile(fork.file)).rejects.toMatchObject({ code: 'ENOENT' });
  const write = handle.hostIo.writeFile.bind(handle.hostIo);
  const target = join(dir, 'failed-fork.jsonl');
  vi.spyOn(handle.hostIo, 'writeFile').mockImplementation((path, bytes, options) => {
    if (path === target && !options?.createOnly) return Promise.reject(new Error('disk full'));
    return write(path, bytes, options);
  });
  await expect(source.fork(target, source.metadata().leaf.activeEntryId!)).rejects.toThrow(
    'disk full'
  );
  await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(`${target}.writer.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(source.file, 'utf8')).toBe(before);
  await expect(source.navigate('missing')).rejects.toMatchObject({
    code: 'session_entry_not_found',
  });
  await source.navigate(null);
  expect(source.snapshot().messages).toEqual([]);
});

it('waits for an in-flight fork before disposal releases IO and writer locks', async () => {
  const { handle, faux } = await runtime();
  faux.setResponses([fauxAssistantMessage('answer')]);
  await handle.run({ prompt: 'task', systemPrompt: 'probe' });
  const source = handle.session!;
  const target = join(dir, 'closing-fork.jsonl');
  let entered = () => {};
  let release = () => {};
  const entering = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const write = handle.hostIo.writeFile.bind(handle.hostIo);
  vi.spyOn(handle.hostIo, 'writeFile').mockImplementation(async (path, bytes, options) => {
    if (path === target && !options?.createOnly) {
      entered();
      await gate;
    }
    return write(path, bytes, options);
  });
  const fork = source.fork(target, source.metadata().leaf.activeEntryId!);
  await entering;
  let closed = false;
  const closing = handle.dispose().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  expect(closed).toBe(false);
  release();
  await fork;
  await closing;
  await expect(readFile(`${target}.writer.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(`${source.file}.writer.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
  const reopened = await runtime(target, 'resume');
  expect(JSON.stringify(reopened.handle.session!.snapshot().messages)).toContain('answer');
});
