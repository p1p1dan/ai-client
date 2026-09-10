import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlSessionRepo } from '@earendil-works/pi-agent-core';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRuntime, type RuntimeBootstrapOptions, type RuntimeHandle } from '../bootstrap.ts';
import { decodeSession } from '../plugins/session/codec.ts';

let dir: string;
const live = new Set<RuntimeHandle>();
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'runtime-session-'));
});
afterEach(async () => {
  for (const runtime of live) await runtime.dispose().catch(() => {});
  live.clear();
  await rm(dir, { recursive: true, force: true });
});
async function runtime(
  mode: 'create' | 'resume' = 'create',
  options: Partial<RuntimeBootstrapOptions> = {}
) {
  const faux = fauxProvider({
    provider: 'test',
    models: [{ id: 'test', name: 'Test', contextWindow: 32_000, maxTokens: 4096 }],
  });
  const handle = await createRuntime({
    providers: [faux.provider],
    env: {},
    traceDir: null,
    tools: { cwd: dir },
    session: { file: join(dir, 'session.jsonl'), cwd: dir, mode },
    ...options,
  });
  live.add(handle);
  return { handle, faux };
}
async function close(handle: RuntimeHandle) {
  live.delete(handle);
  await handle.dispose();
}
const user = (content: string) => ({ role: 'user' as const, content, timestamp: Date.now() });
const text = (value: unknown) => JSON.stringify(value);

describe('P3-1 JSONL session / P2-4 durable compaction', () => {
  it('restores message-owned diffs after the workspace content has changed', async () => {
    const { handle, faux } = await runtime('create', { permissions: { gear: 'auto' } });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('write', { path: 'review.txt', content: 'pong\n' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage(
        [fauxToolCall('write', { path: 'review.txt', content: 'pong\nabc\n' })],
        { stopReason: 'toolUse' }
      ),
      fauxAssistantMessage('done'),
    ]);
    expect((await handle.run({ prompt: 'write twice', systemPrompt: 'probe' })).success).toBe(true);
    const history = handle.session!.history();
    const changes = history.flatMap((message) =>
      message.blocks.filter((block) => block.type === 'tool_result').map((block) => block.review)
    );
    expect(changes).toHaveLength(2);
    expect(changes[0]).toMatchObject({ status: 'added', patch: '@@ -0,0 +1,1 @@\n+pong' });
    expect(changes[1]).toMatchObject({ status: 'modified', patch: '@@ -1,1 +1,2 @@\n pong\n+abc' });
    await close(handle);
    await writeFile(join(dir, 'review.txt'), 'external change');
    const resumed = await runtime('resume');
    expect(resumed.handle.session!.history()).toEqual(history);
  });
  it('keeps messages between runs and after close/resume', async () => {
    const { handle, faux } = await runtime();
    faux.setResponses([
      fauxAssistantMessage('FIRST_REPLY'),
      (context) => {
        expect(text(context.messages)).toContain('FIRST_TASK');
        expect(text(context.messages)).toContain('FIRST_REPLY');
        return fauxAssistantMessage('SECOND_REPLY');
      },
    ]);
    await handle.run({ prompt: 'FIRST_TASK', systemPrompt: 'probe' });
    await handle.run({ prompt: 'SECOND_TASK', systemPrompt: 'probe' });
    const before = handle.session?.snapshot();
    await close(handle);
    const next = await runtime('resume');
    expect(next.handle.session?.snapshot().entries).toEqual(before?.entries);
    next.faux.setResponses([
      (context) => {
        expect(text(context.messages)).toContain('SECOND_REPLY');
        return fauxAssistantMessage('THIRD_REPLY');
      },
    ]);
    expect((await next.handle.run({ prompt: 'THIRD_TASK', systemPrompt: 'probe' })).success).toBe(
      true
    );
    expect(
      next.handle.session?.snapshot().entries.filter((entry) => entry.type === 'message')
    ).toHaveLength(6);
  });

  it.each([
    'summary',
    'fresh_window',
  ] as const)('restores %s checkpoints without deleting the full transcript', async (family) => {
    const { handle, faux } = await runtime('create', { context: { family } });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('new_context', {})], { stopReason: 'toolUse' }),
      ...(family === 'summary' ? [fauxAssistantMessage('FIRST_SUMMARY')] : []),
      fauxAssistantMessage('AFTER_CHECKPOINT'),
    ]);
    expect((await handle.run({ prompt: 'ORIGINAL_TASK', systemPrompt: 'probe' })).success).toBe(
      true
    );
    const first = handle.session?.snapshot();
    expect(first?.checkpoint?.retainedTail).toHaveLength(1);
    expect(first?.entries.filter((entry) => entry.type === 'message')).toHaveLength(4);
    expect(text(first?.entries)).toContain('new_context');
    expect(text(first?.messages)).not.toContain('toolCall');
    await close(handle);
    const next = await runtime('resume', { context: { family } });
    expect(next.handle.session?.snapshot()).toEqual(first);
    let summaryInput = '';
    next.faux.setResponses([
      (context) => {
        expect(text(context.messages)).toContain('AFTER_CHECKPOINT');
        return fauxAssistantMessage([fauxToolCall('new_context', {})], { stopReason: 'toolUse' });
      },
      ...(family === 'summary'
        ? [
            (context: { messages: unknown[] }) => {
              summaryInput = text(context.messages);
              return fauxAssistantMessage('SECOND_SUMMARY');
            },
          ]
        : []),
      fauxAssistantMessage('DONE'),
    ]);
    expect((await next.handle.run({ prompt: 'NEXT_TASK', systemPrompt: 'probe' })).success).toBe(
      true
    );
    if (family === 'summary') {
      expect(summaryInput).toContain('<previous-summary>');
      expect(summaryInput).toContain('FIRST_SUMMARY');
      expect(next.handle.session?.snapshot().checkpoint?.usage).toBeDefined();
    }
    expect(
      next.handle.session?.snapshot().entries.filter((entry) => entry.type === 'compaction')
    ).toHaveLength(2);
  });

  it('compacts old history before a new input and retains that new input', async () => {
    const { handle, faux } = await runtime('create', { context: { family: 'fresh_window' } });
    await handle.session?.appendMessage(user('OLD_HISTORY'.repeat(6_000)));
    faux.setResponses([
      (context) => {
        expect(text(context.messages)).not.toContain('OLD_HISTORY');
        expect(text(context.messages)).toContain('NEW_TASK');
        return fauxAssistantMessage('done');
      },
    ]);
    const result = await handle.run({ prompt: 'NEW_TASK', systemPrompt: 'probe' });
    expect(result.success).toBe(true);
    expect(handle.session?.snapshot().checkpoint).toBeDefined();
    expect(text(handle.session?.snapshot().entries)).toContain('OLD_HISTORY');
  });

  it('opens its output with the official Pi v4 reader', async () => {
    const { handle, faux } = await runtime();
    faux.setResponses([fauxAssistantMessage('persisted')]);
    await handle.run({ prompt: 'hello', systemPrompt: 'probe' });
    const snapshot = handle.session?.snapshot();
    await close(handle);
    const env = new NodeExecutionEnv({ cwd: dir });
    const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: dir });
    if (!snapshot) throw new Error('session missing');
    const session = await repo.open({
      id: snapshot.id,
      path: join(dir, 'session.jsonl'),
      cwd: dir,
      createdAt: 0,
      modifiedAt: 0,
      sourceFormat: 4,
    });
    expect(await session.findEntries({ order: 'oldestFirst' })).toEqual(snapshot?.entries);
  });

  it('reads entries and a checkpoint produced by the official Pi writer', async () => {
    const env = new NodeExecutionEnv({ cwd: dir });
    const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: join(dir, 'official') });
    const official = await repo.create({ cwd: dir });
    await official.appendMessage(user('SDK_TASK'));
    await official.appendEntry(
      {
        type: 'compaction',
        id: 'sdk-cp',
        summary: 'SDK_SUMMARY',
        retainedTail: [user('SDK_RETAINED')],
        tokensBefore: 120,
      },
      'main'
    );
    await official.appendMessage(JSON.parse(JSON.stringify(fauxAssistantMessage('SDK_REPLY'))));
    const metadata = await official.getMetadata();
    const { handle, faux } = await runtime('resume', {
      session: { file: metadata.path, cwd: dir, mode: 'resume' },
    });
    faux.setResponses([
      (context) => {
        expect(text(context.messages)).toContain('SDK_SUMMARY');
        expect(text(context.messages)).toContain('SDK_RETAINED');
        expect(text(context.messages)).not.toContain('SDK_TASK');
        return fauxAssistantMessage('native reply');
      },
    ]);
    expect((await handle.run({ prompt: 'continue', systemPrompt: 'probe' })).success).toBe(true);
    expect(handle.session?.snapshot().checkpoint?.id).toBe('sdk-cp');
  });

  it('does not issue the next request if the compaction entry cannot be persisted', async () => {
    const { handle, faux } = await runtime('create', { context: { family: 'fresh_window' } });
    const append = handle.hostIo.appendFile.bind(handle.hostIo);
    vi.spyOn(handle.hostIo, 'appendFile').mockImplementation(async (path, bytes, options) => {
      if (text(Buffer.from(bytes).toString()).includes('compaction'))
        throw new Error('checkpoint write failed');
      await append(path, bytes, options);
    });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('new_context', {})], { stopReason: 'toolUse' }),
    ]);
    const result = await handle.run({ prompt: 'keep this task', systemPrompt: 'probe' });
    expect(result.success).toBe(false);
    expect(faux.state.callCount).toBe(1);
    expect(handle.session?.snapshot().checkpoint).toBeUndefined();
    expect(
      handle.session?.snapshot().entries.filter((entry) => entry.type === 'message')
    ).toHaveLength(3);
  });

  it('rejects an overlapping run without losing the active run', async () => {
    const { handle, faux } = await runtime();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    faux.setResponses([
      async () => {
        await gate;
        return fauxAssistantMessage('first');
      },
    ]);
    const first = handle.run({ prompt: 'first', systemPrompt: 'probe' });
    await expect(handle.run({ prompt: 'second', systemPrompt: 'probe' })).rejects.toMatchObject({
      code: 'runtime_busy',
    });
    release();
    expect((await first).success).toBe(true);
    expect(
      handle.session?.snapshot().entries.filter((entry) => entry.type === 'message')
    ).toHaveLength(2);
  });

  it('rejects a file over the read limit and keeps the original bytes', async () => {
    const { handle } = await runtime();
    await handle.session?.appendMessage(user('x'.repeat(2_000)));
    await close(handle);
    const file = join(dir, 'session.jsonl');
    const before = await readFile(file);
    await expect(
      runtime('resume', { session: { file, cwd: dir, mode: 'resume', maxBytes: 1_000 } })
    ).rejects.toThrow();
    expect(await readFile(file)).toEqual(before);
  });

  it('rejects another writer and permits resume after dispose', async () => {
    const { handle } = await runtime();
    await expect(runtime('resume')).rejects.toMatchObject({ code: 'session_locked' });
    await close(handle);
    const next = await runtime('resume');
    expect(next.handle.session?.snapshot().entries).toEqual([]);
  });

  it('never overwrites a session on create', async () => {
    const { handle } = await runtime();
    const file = join(dir, 'session.jsonl');
    await close(handle);
    const before = await readFile(file, 'utf8');
    await expect(runtime()).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(file, 'utf8')).toBe(before);
  });

  it('repairs only a torn trailing JSON fragment before further append', async () => {
    const { handle } = await runtime();
    await handle.session?.appendMessage(user('kept'));
    await close(handle);
    const file = join(dir, 'session.jsonl');
    await appendFile(file, '{"kind":"entry","seq":');
    const next = await runtime('resume');
    await next.handle.session?.appendMessage(user('next'));
    const doc = decodeSession(await readFile(file, 'utf8'));
    expect(doc.entries).toHaveLength(2);
    expect(doc.seq).toBe(2);
  });

  it('recovers a crash inside a multibyte character at the torn tail', async () => {
    const { handle } = await runtime();
    await handle.session?.appendMessage(user('intact'));
    await close(handle);
    const file = join(dir, 'session.jsonl');
    await appendFile(
      file,
      Buffer.concat([Buffer.from('{"kind":"entry","text":"'), Buffer.from('中').subarray(0, 2)])
    );
    const next = await runtime('resume');
    expect(next.handle.session?.snapshot().entries).toHaveLength(1);
    await next.handle.session?.appendMessage(user('after repair'));
    expect(decodeSession(await readFile(file, 'utf8')).entries).toHaveLength(2);
  });

  it('rejects corrupt complete lines and unsupported old formats without rewriting them', async () => {
    const { handle } = await runtime();
    await close(handle);
    const file = join(dir, 'session.jsonl');
    await appendFile(file, '{broken}\n');
    const corrupt = await readFile(file, 'utf8');
    await expect(runtime('resume')).rejects.toMatchObject({ code: 'session_invalid' });
    expect(await readFile(file, 'utf8')).toBe(corrupt);
    const legacy = '{"type":"session","version":3,"id":"old"}\n';
    await writeFile(file, legacy);
    await expect(runtime('resume')).rejects.toMatchObject({ code: 'session_legacy_invalid' });
    expect(await readFile(file, 'utf8')).toBe(legacy);
  });

  it('keeps the last acknowledged state and poisons writes after disk failure', async () => {
    const { handle } = await runtime();
    const writes = vi.spyOn(handle.hostIo, 'appendFile').mockRejectedValue(new Error('disk full'));
    await expect(handle.session?.appendMessage(user('lost'))).rejects.toThrow('disk full');
    await expect(handle.session?.appendMessage(user('must not append'))).rejects.toThrow(
      'disk full'
    );
    expect(handle.session?.snapshot().entries).toHaveLength(0);
    expect(writes).toHaveBeenCalledTimes(1);
  });

  it('returns failure when message persistence fails before model execution', async () => {
    const { handle, faux } = await runtime();
    faux.setResponses([]);
    vi.spyOn(handle.hostIo, 'appendFile').mockRejectedValue(new Error('disk full'));
    const result = await handle.run({ prompt: 'hello', systemPrompt: 'probe' });
    expect(result.success).toBe(false);
    expect(faux.state.callCount).toBe(0);
  });

  it('does not replay an interrupted tool when resuming', async () => {
    const { handle } = await runtime();
    await handle.session?.appendMessage(user('work'));
    await handle.session?.appendMessage(
      fauxAssistantMessage([fauxToolCall('bash', { command: 'touch danger' }, { id: 'pending' })], {
        stopReason: 'toolUse',
      })
    );
    await close(handle);
    const next = await runtime('resume');
    next.faux.setResponses([
      (context) => {
        expect(text(context.messages)).toContain('effects are unknown');
        return fauxAssistantMessage('inspect first');
      },
    ]);
    const result = await next.handle.run({ prompt: 'continue', systemPrompt: 'probe' });
    expect(result.success).toBe(true);
    expect(result.trace.steps.some((step) => step.type === 'tool')).toBe(false);
  });
});
