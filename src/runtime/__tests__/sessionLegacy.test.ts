import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildSessionContext } from '@earendil-works/pi-agent-core';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRuntime, type RuntimeHandle } from '../bootstrap.ts';
import { branchEntries, decodeSession } from '../plugins/session/codec.ts';
import { convertLegacySession, prepareSessionConfig } from '../plugins/session/legacy.ts';

let dir: string;
const runtimes: RuntimeHandle[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'legacy-session-'));
});
afterEach(async () => {
  for (const r of runtimes) await r.dispose();
  runtimes.length = 0;
  await rm(dir, { recursive: true, force: true });
});
const stamp = '2026-09-09T00:00:00Z';
function legacy(tier: string) {
  return `${[
    { type: 'session', version: 3, id: 'legacy-session', timestamp: stamp, cwd: dir, tier },
    {
      type: 'message',
      id: 'u',
      parentId: null,
      timestamp: stamp,
      message: { role: 'user', content: 'OLD_TASK', timestamp: Date.parse(stamp) },
    },
    {
      type: 'message',
      id: 'a',
      parentId: 'u',
      timestamp: stamp,
      message: fauxAssistantMessage('OLD_REPLY'),
    },
  ]
    .map((row) => JSON.stringify(row))
    .join('\n')}\n`;
}
describe('P3-3 legacy session compatibility', () => {
  it.each([
    ['readonly', 'plan', 'ask'],
    ['pragmatic', 'agent', 'ask'],
    ['handsoff', 'agent', 'accept-edits'],
    ['fullopen', 'agent', 'auto'],
  ])('resumes %s as %s/%s and preserves the legacy file', async (tier, mode, gear) => {
    const file = join(dir, 'old.jsonl');
    const before = legacy(tier);
    await writeFile(file, before);
    const faux = fauxProvider({ provider: 'test', models: [{ id: 'test', name: 'Test' }] });
    faux.setResponses([
      (context) => {
        expect(JSON.stringify(context.messages)).toContain('OLD_REPLY');
        return fauxAssistantMessage('NEW_REPLY');
      },
    ]);
    const runtime = await createRuntime({
      env: {},
      providers: [faux.provider],
      tools: { cwd: dir },
      session: { file, cwd: dir, mode: 'resume' },
    });
    runtimes.push(runtime);
    expect(runtime.permissions?.mode).toBe(mode);
    expect(runtime.permissions?.gear).toBe(gear);
    expect(runtime.session?.file).toBe(`${file}.native-v4.jsonl`);
    expect((await runtime.run({ prompt: 'continue', systemPrompt: 'probe' })).success).toBe(true);
    expect(await readFile(file, 'utf8')).toBe(before);
    expect(runtime.session?.metadata().sourceFile).toBe(file);
  });
  it('converts all six actual P2-0 v3 baseline transcripts including compaction', async () => {
    const baseline = resolve(
      'docs/plantree/plans/runtime-evolution/evidence/p2-0/baseline-20260908'
    );
    let checkpoints = 0;
    for (const id of ['B01', 'B02', 'B03', 'B04', 'B05', 'B06']) {
      const folder = join(baseline, id, 'sessions');
      const file = join(folder, (await readdir(folder)).find((name) => name.endsWith('.jsonl'))!);
      const source = await readFile(file, 'utf8');
      const converted = decodeSession(convertLegacySession(source, dir, file, true));
      const originalMessages = source
        .split('\n')
        .filter(Boolean)
        .map((row) => JSON.parse(row))
        .filter((row) => row.type === 'message');
      expect(converted.entries.filter((row) => row.type === 'message')).toHaveLength(
        originalMessages.length
      );
      expect(buildSessionContext(branchEntries(converted)).messages.length).toBeGreaterThan(0);
      checkpoints += converted.entries.filter((row) => row.type === 'compaction').length;
      const faux = fauxProvider({
        provider: 'test',
        models: [{ id: 'test', name: 'Test', contextWindow: 1_000_000 }],
      });
      faux.setResponses([
        (context) => {
          expect(context.messages.length).toBeGreaterThan(1);
          return fauxAssistantMessage(`RESUMED_${id}`);
        },
      ]);
      const target = join(dir, `${id}.jsonl`);
      const runtime = await createRuntime({
        env: {},
        providers: [faux.provider],
        session: {
          file: target,
          sourceFile: file,
          cwd: dir,
          mode: 'import',
          allowWorkspaceRelocation: true,
        },
      });
      runtimes.push(runtime);
      expect(
        (await runtime.run({ prompt: 'offline resume probe', systemPrompt: 'probe' })).success
      ).toBe(true);
      expect(JSON.stringify(runtime.session!.snapshot().messages)).toContain(`RESUMED_${id}`);
      await runtime.dispose();
      const reopened = await createRuntime({
        env: {},
        providers: [faux.provider],
        session: { file: target, cwd: dir, mode: 'resume' },
      });
      runtimes.push(reopened);
      expect(JSON.stringify(reopened.session!.snapshot().messages)).toContain(`RESUMED_${id}`);
      await reopened.dispose();
      expect(await readFile(file, 'utf8')).toBe(source);
    }
    expect(checkpoints).toBeGreaterThan(0);
  });
  it('imports PI-Desktop canonical messages and retained compaction tail', () => {
    const rows = [
      { type: 'session', schema: 1, sessionId: 'desktop', createdAt: stamp },
      {
        type: 'message',
        id: 'u',
        role: 'user',
        blocks: [{ type: 'text', text: 'desktop task' }],
        createdAt: stamp,
      },
      {
        type: 'message',
        id: 'a',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'desktop answer' }],
        createdAt: stamp,
      },
      {
        type: 'compaction',
        id: 'c',
        summary: 'desktop summary',
        throughMessageId: 'a',
        tokensBefore: 100,
        retainedTail: [{ role: 'user', content: 'kept task', timestamp: 1 }],
        createdAt: stamp,
      },
    ];
    const doc = decodeSession(
      convertLegacySession(
        rows.map((row) => JSON.stringify(row)).join('\n'),
        dir,
        '/source/desktop.jsonl'
      )
    );
    expect(doc.entries).toHaveLength(3);
    expect(JSON.stringify(buildSessionContext(branchEntries(doc)).messages)).toContain(
      'desktop summary'
    );
    expect(JSON.stringify(buildSessionContext(branchEntries(doc)).messages)).toContain('kept task');
  });
  it('preserves PI-Desktop tool call/result identity, usage and subagent separation', () => {
    const rows = [
      { type: 'session', schema: 1, sessionId: 'desktop', createdAt: stamp },
      {
        type: 'message',
        id: 'u',
        role: 'user',
        blocks: [{ type: 'text', text: 'task' }],
        createdAt: stamp,
      },
      {
        type: 'message',
        id: 'a',
        role: 'assistant',
        blocks: [],
        meta: { usage: { inputTokens: 40, outputTokens: 5, cacheReadTokens: 100 } },
        createdAt: stamp,
      },
      {
        type: 'message',
        id: 't',
        role: 'tool',
        toolName: 'read',
        blocks: [
          {
            type: 'tool_call',
            callId: 'call-1',
            name: 'read',
            args: { path: 'file' },
            result: { content: [{ type: 'text', text: 'file contents' }] },
          },
        ],
        createdAt: stamp,
      },
      {
        type: 'message',
        id: 'delegate',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'DELEGATE_PRIVATE' }],
        meta: { parentToolCallId: 'call-1' },
        createdAt: stamp,
      },
    ];
    const doc = decodeSession(
      convertLegacySession(rows.map((r) => JSON.stringify(r)).join('\n'), dir, '/desktop.jsonl')
    );
    const messages = buildSessionContext(branchEntries(doc)).messages;
    expect(messages.filter((m) => m.role === 'toolResult')).toHaveLength(1);
    expect(JSON.stringify(messages)).toContain('call-1');
    expect(JSON.stringify(messages)).toContain('file contents');
    expect(JSON.stringify(messages)).not.toContain('DELEGATE_PRIVATE');
    expect(messages.find((m) => m.role === 'assistant')).toMatchObject({
      usage: { input: 40, output: 5, cacheRead: 100, totalTokens: 145 },
      content: [{ type: 'toolCall', id: 'call-1' }],
    });
    expect(JSON.stringify(doc.entries)).toContain('DELEGATE_PRIVATE');
  });
  it.each([
    1, 2,
  ])('upgrades Pi v%s tree/legacy hook messages without losing custom content', (version) => {
    const rows = [
      { type: 'session', version, id: 'old', timestamp: stamp, cwd: dir },
      {
        type: 'message',
        ...(version === 2 ? { id: 'u', parentId: null } : {}),
        timestamp: stamp,
        message: { role: 'user', content: 'hello', timestamp: 1 },
      },
      {
        type: 'message',
        ...(version === 2 ? { id: 'c', parentId: 'u' } : {}),
        timestamp: stamp,
        message: {
          role: 'hookMessage',
          customType: 'extension',
          content: 'custom content',
          timestamp: 2,
        },
      },
    ];
    const doc = decodeSession(
      convertLegacySession(rows.map((r) => JSON.stringify(r)).join('\n'), dir, '/old.jsonl')
    );
    expect(doc.entries).toHaveLength(2);
    expect(JSON.stringify(buildSessionContext(branchEntries(doc)).messages)).toContain(
      'custom content'
    );
    expect(doc.entries[1]).toMatchObject({ message: { role: 'custom' } });
  });
});

it('reuses the native copy on repeat legacy resume and rejects source drift', async () => {
  const file = join(dir, 'old.jsonl');
  await writeFile(file, legacy('handsoff'));
  const faux = fauxProvider({ provider: 'test', models: [{ id: 'test', name: 'Test' }] });
  const options = {
    env: {},
    providers: [faux.provider],
    session: { file, cwd: dir, mode: 'resume' as const },
  };
  const first = await createRuntime(options);
  runtimes.push(first);
  faux.setResponses([fauxAssistantMessage('NATIVE_ADDITION')]);
  await first.run({ prompt: 'new', systemPrompt: 'probe' });
  const id = first.session!.metadata().id;
  await first.dispose();
  const second = await createRuntime(options);
  runtimes.push(second);
  expect(second.session!.metadata().id).toBe(id);
  expect(JSON.stringify(second.session!.snapshot().messages)).toContain('NATIVE_ADDITION');
  await second.dispose();
  await writeFile(file, legacy('fullopen'));
  await expect(createRuntime(options)).rejects.toMatchObject({
    code: 'session_import_source_changed',
  });
});
it('requires explicit relocation, rejects malformed parents and unknown schemas', () => {
  expect(() => convertLegacySession(legacy('pragmatic'), '/new/workspace', '/source')).toThrow(
    'relocation'
  );
  expect(() =>
    convertLegacySession(
      legacy('pragmatic').replace('"parentId":"u"', '"parentId":"a"'),
      dir,
      '/source'
    )
  ).toThrow('parent');
  expect(() =>
    convertLegacySession(
      JSON.stringify({ type: 'session', schema: 99, createdAt: stamp }),
      dir,
      '/source'
    )
  ).toThrow('schema');
});
it('does not publish partial migration output or leave its lock on write failure', async () => {
  const faux = fauxProvider({ provider: 'test', models: [{ id: 'test', name: 'Test' }] });
  const runtime = await createRuntime({ env: {}, providers: [faux.provider] });
  runtimes.push(runtime);
  const file = join(dir, 'old.jsonl');
  const original = legacy('readonly');
  await writeFile(file, original);
  const write = runtime.hostIo.writeFile.bind(runtime.hostIo);
  vi.spyOn(runtime.hostIo, 'writeFile').mockImplementation(async (path, bytes, options) => {
    if (path.endsWith('.tmp')) {
      await write(path, bytes.subarray(0, 10), options);
      throw new Error('disk full');
    }
    return write(path, bytes, options);
  });
  await expect(
    prepareSessionConfig(runtime.hostIo, { file, cwd: dir, mode: 'resume' })
  ).rejects.toThrow('disk full');
  expect(await readdir(dir)).toEqual(['old.jsonl']);
  expect(await readFile(file, 'utf8')).toBe(original);
});
it('keeps messages after a desktop checkpoint boundary when checkpoints were written last', () => {
  const rows = [
    { type: 'session', schema: 1, sessionId: 'desktop', createdAt: stamp },
    {
      type: 'message',
      id: 'u',
      role: 'user',
      blocks: [{ type: 'text', text: 'old task' }],
      createdAt: stamp,
    },
    {
      type: 'message',
      id: 'a',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'old answer' }],
      createdAt: stamp,
    },
    {
      type: 'message',
      id: 'n',
      role: 'user',
      blocks: [{ type: 'text', text: 'AFTER_CHECKPOINT' }],
      createdAt: stamp,
    },
    {
      type: 'compaction',
      id: 'c',
      summary: 'summary',
      throughMessageId: 'a',
      tokensBefore: 100,
      retainedTail: [],
      createdAt: stamp,
    },
  ];
  const doc = decodeSession(
    convertLegacySession(rows.map((r) => JSON.stringify(r)).join('\n'), dir, '/desktop.jsonl')
  );
  const messages = buildSessionContext(branchEntries(doc)).messages;
  expect(JSON.stringify(messages)).toContain('AFTER_CHECKPOINT');
  expect(JSON.stringify(messages)).not.toContain('old answer');
});
