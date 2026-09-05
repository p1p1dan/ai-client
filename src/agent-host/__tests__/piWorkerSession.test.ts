import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeEventDraft } from '../../shared/types/runtimeEvents.ts';
import type { PermissionPluginDecision } from '../permissionPlugin.ts';
import { PiWorkerSession } from '../piWorkerSession.ts';
import { createPiSdkStub } from './fixtures/piSdkStub.ts';

const GATED: PermissionPluginDecision = {
  additionalExtensionPaths: ['/bundle/pi-permission-system'],
  reason: 'bundled',
  gated: true,
};

function createSession(
  stub: ReturnType<typeof createPiSdkStub>,
  events: RuntimeEventDraft[],
  sessionFile?: string
) {
  return new PiWorkerSession({
    logicalSessionId: 'logical-1',
    cwd: '/repo',
    ...(sessionFile ? { sessionFile } : {}),
    model: 'glm/glm-5',
    effort: 'high',
    projectTrusted: false,
    emit: (event) => events.push(event),
    loadSdk: async () => stub.sdk,
    decidePermissionGate: () => GATED,
    log: () => undefined,
  });
}

describe('PiWorkerSession', () => {
  it('bootstraps exactly one Pi AgentSession and returns the managed runtime identity', async () => {
    const stub = createPiSdkStub();
    const events: RuntimeEventDraft[] = [];
    const session = createSession(stub, events);

    const [first, duplicate] = await Promise.all([session.bootstrap(), session.bootstrap()]);

    expect(first).toEqual(duplicate);
    expect(stub.sessions).toHaveLength(1);
    expect(first).toMatchObject({
      bootstrapped: true,
      logicalSessionId: 'logical-1',
      piSessionId: 'pi-/repo',
      cwd: '/repo',
      agentDir: '/tmp/pi-agent',
      sessionFile: '/repo/session.jsonl',
      model: 'glm/glm-5',
      effort: 'high',
      projectTrusted: false,
      permissionGate: 'bundled',
    });
    expect(events).toEqual([]);

    await session.dispose();
    await session.dispose();
    expect(stub.sessionFor('/repo')).toMatchObject({ disposed: true });
  });

  it('opens one exact file and returns its active-branch initial history page', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiclient-worker-resume-'));
    const sessionFile = join(dir, 'session.jsonl');
    await writeFile(sessionFile, '{"type":"session","id":"pi-resumed","cwd":"/repo"}\n', 'utf8');
    const stub = createPiSdkStub({
      openedSession: {
        cwd: '/repo',
        sessionId: 'pi-resumed',
        sessionFile,
        branch: [
          {
            type: 'message',
            id: 'u1',
            message: { role: 'user', content: [{ type: 'text', text: 'restored' }] },
          },
        ],
      },
    });
    const events: RuntimeEventDraft[] = [];
    const session = createSession(stub, events, sessionFile);
    try {
      await expect(session.bootstrap()).resolves.toMatchObject({
        piSessionId: 'pi-resumed',
        sessionFile,
        initialHistory: {
          logicalSessionId: 'logical-1',
          sessionFile,
          workspacePath: '/repo',
          page: {
            messages: [{ id: 'h:u1', entryId: 'u1', role: 'user' }],
            offset: 0,
            totalCount: 1,
            hasMore: false,
          },
        },
      });
      await expect(
        session.history({ logicalSessionId: 'logical-1', offset: 1, limit: 20 })
      ).resolves.toMatchObject({
        page: { messages: [], offset: 1, limit: 20, totalCount: 1, hasMore: false },
      });
    } finally {
      await session.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails missing and cross-cwd resume targets before creating any AgentSession', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aiclient-worker-invalid-resume-'));
    const missing = join(dir, 'missing.jsonl');
    const missingStub = createPiSdkStub();
    await expect(createSession(missingStub, [], missing).bootstrap()).rejects.toMatchObject({
      code: 'WORKER_SESSION_FILE_NOT_FOUND',
    });
    expect(missingStub.sessions).toEqual([]);

    const crossCwd = join(dir, 'cross.jsonl');
    await writeFile(crossCwd, '{"type":"session","id":"pi-other","cwd":"/other"}\n', 'utf8');
    const crossStub = createPiSdkStub();
    await expect(createSession(crossStub, [], crossCwd).bootstrap()).rejects.toMatchObject({
      code: 'WORKER_SESSION_CWD_MISMATCH',
    });
    expect(crossStub.sessions).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });

  it('admits send before a held prompt settles and preserves attachments/model/effort', async () => {
    const stub = createPiSdkStub({ manualPrompt: true });
    const events: RuntimeEventDraft[] = [];
    const session = createSession(stub, events);
    await session.bootstrap();

    await expect(
      session.startSend({
        logicalSessionId: 'logical-1',
        requestId: 'turn-1',
        attemptId: 'attempt-1',
        text: 'hello',
        model: 'dan/deepseek-v4',
        effort: 'xhigh',
        attachments: [
          { kind: 'text', mediaType: 'text/plain', data: 'document', name: 'notes.txt' },
          { kind: 'image', mediaType: 'image/png', data: 'base64-image' },
        ],
      })
    ).resolves.toEqual({ accepted: true, requestId: 'turn-1' });

    const piSession = stub.sessionFor('/repo');
    expect(piSession?.prompts).toEqual([
      {
        text: 'hello\n\n--- notes.txt ---\ndocument',
        options: { images: [{ type: 'image', data: 'base64-image', mimeType: 'image/png' }] },
      },
    ]);
    expect(piSession?.model).toMatchObject({ provider: 'dan', id: 'deepseek-v4' });
    expect(piSession?.thinkingLevels).toContain('xhigh');
    expect(events.at(-1)).toMatchObject({
      type: 'session.status',
      requestId: 'turn-1',
      payload: { status: 'running' },
    });

    piSession?.emit({
      type: 'message_start',
      message: { role: 'user', content: [{ type: 'text', text: 'expanded SDK prompt' }] },
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'message.started',
        requestId: 'turn-1',
        payload: {
          messageId: 'user-logical-1-1',
          role: 'user',
          attemptId: 'attempt-1',
          attachments: [
            { kind: 'text', mediaType: 'text/plain', name: 'notes.txt' },
            { kind: 'image', mediaType: 'image/png' },
          ],
        },
      })
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'message.delta',
        payload: expect.objectContaining({ text: 'hello' }),
      })
    );
  });

  it('projects thinking, prose, tools, custom rows, and prose-after-boundary in source order', async () => {
    const stub = createPiSdkStub({ manualPrompt: true });
    const events: RuntimeEventDraft[] = [];
    const session = createSession(stub, events);
    await session.startSend({
      logicalSessionId: 'logical-1',
      requestId: 'turn-1',
      attemptId: 'attempt-1',
      text: 'go',
    });
    const pi = stub.sessionFor('/repo');

    pi?.emit({ type: 'agent_start' });
    pi?.emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_delta', delta: 'plan' },
    });
    pi?.emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'before' },
    });
    pi?.emit({
      type: 'message_end',
      message: { role: 'assistant', stopReason: 'toolUse' },
    });
    pi?.emit({
      type: 'tool_execution_start',
      toolCallId: 'tool-1',
      toolName: 'read',
      args: { path: 'a.ts' },
    });
    pi?.emit({
      type: 'tool_execution_update',
      toolCallId: 'tool-1',
      toolName: 'read',
      args: { path: 'b.ts' },
    });
    pi?.emit({
      type: 'tool_execution_end',
      toolCallId: 'tool-1',
      toolName: 'read',
      result: { content: 'done' },
      isError: false,
    });
    const toJson = vi.fn(() => ({ leaked: true }));
    pi?.emit({
      type: 'message_end',
      message: {
        role: 'custom',
        customType: 'extension.note',
        content: [{ type: 'text', text: 'visible' }],
        details: { count: 1, factory: () => 'not serializable', toJSON: toJson },
      },
    });
    pi?.emit({
      type: 'message_end',
      message: {
        role: 'custom',
        customType: 'extension.hidden',
        content: 'hidden',
        display: false,
      },
    });
    pi?.emit({
      type: 'entry_appended',
      entry: { type: 'custom', customType: 'extension.entry', data: { ok: true } },
    });
    pi?.emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'after' },
    });
    pi?.emit({ type: 'agent_settled' });

    const relevant = events.filter((event) =>
      [
        'thinking.started',
        'thinking.delta',
        'thinking.completed',
        'message.delta',
        'tool.started',
        'tool.updated',
        'tool.completed',
        'custom.message',
        'custom.entry',
        'session.completed',
      ].includes(event.type)
    );
    expect(relevant.map((event) => event.type)).toEqual([
      'thinking.started',
      'thinking.delta',
      'thinking.completed',
      'message.delta',
      'tool.started',
      'tool.updated',
      'tool.completed',
      'custom.message',
      'custom.entry',
      'message.delta',
      'session.completed',
    ]);
    expect(events).not.toContainEqual(
      expect.objectContaining({
        type: 'custom.message',
        payload: expect.objectContaining({ customType: 'extension.hidden' }),
      })
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'custom.message',
        payload: expect.objectContaining({
          customType: 'extension.note',
          content: expect.stringContaining('"count": 1'),
        }),
      })
    );
    expect(toJson).not.toHaveBeenCalled();
    const messageIds = events.flatMap((event) =>
      event.type === 'message.started' && event.payload.role === 'assistant'
        ? [event.payload.messageId]
        : []
    );
    expect(new Set(messageIds).size).toBe(messageIds.length);
    expect(messageIds).toHaveLength(2);
  });

  it('uses cumulative snapshots first and falls back to deltas without dropping or duplicating text', async () => {
    const stub = createPiSdkStub({ manualPrompt: true });
    const events: RuntimeEventDraft[] = [];
    const session = createSession(stub, events);
    await session.startSend({
      logicalSessionId: 'logical-1',
      requestId: 'turn-stream',
      attemptId: 'attempt-stream',
      text: 'go',
    });
    const pi = stub.sessionFor('/repo');

    pi?.emit({
      type: 'message_update',
      message: { role: 'assistant', content: [] },
      assistantMessageEvent: { type: 'text_delta', delta: 'ha' },
    });
    pi?.emit({
      type: 'message_update',
      message: { role: 'assistant', content: [] },
      assistantMessageEvent: { type: 'text_delta', delta: 'ha' },
    });
    pi?.emit({
      type: 'message_update',
      message: { role: 'assistant', content: [{ type: 'text', text: 'haha' }] },
      assistantMessageEvent: { type: 'text_end', content: 'haha' },
    });
    for (const text of ['haha!', 'haha!!']) {
      pi?.emit({
        type: 'message_update',
        message: { role: 'assistant', content: [{ type: 'text', text }] },
        assistantMessageEvent: { type: 'text_delta', delta: '!' },
      });
    }
    pi?.emit({
      type: 'message_update',
      message: { role: 'assistant', content: [{ type: 'text', text: 'haha' }] },
      assistantMessageEvent: { type: 'text_end', content: 'haha' },
    });
    pi?.emit({
      type: 'message_update',
      message: { role: 'assistant', content: [{ type: 'text', text: 'haha!!' }] },
      assistantMessageEvent: { type: 'toolcall_delta', delta: '{"path":"secret"}' },
    });

    const chunks = events.flatMap((event) =>
      event.type === 'message.delta' ? [event.payload.text] : []
    );
    expect(chunks).toEqual(['ha', 'ha', '!', '!']);
    expect(chunks.join('')).toBe('haha!!');
    expect(chunks.join('')).not.toContain('secret');
  });

  it('stop drains helpers and emits exactly one stopped terminal', async () => {
    const stub = createPiSdkStub({ manualPrompt: true });
    const events: RuntimeEventDraft[] = [];
    const session = createSession(stub, events);
    await session.startSend({
      logicalSessionId: 'logical-1',
      requestId: 'turn-stop',
      attemptId: 'attempt-stop',
      text: 'hold',
    });

    await expect(session.stop({ logicalSessionId: 'logical-1', reason: 'user' })).resolves.toEqual({
      stopped: true,
    });
    stub.sessionFor('/repo')?.emit({
      type: 'message_end',
      message: { role: 'assistant', stopReason: 'aborted', errorMessage: 'aborted' },
    });
    stub.sessionFor('/repo')?.emit({ type: 'agent_settled' });

    expect(stub.sessionFor('/repo')).toMatchObject({
      aborted: true,
      queueCleared: true,
      compactionAborted: true,
      branchSummaryAborted: true,
      bashAborted: true,
    });
    expect(
      events.filter((event) =>
        ['session.completed', 'session.failed', 'session.stopped'].includes(event.type)
      )
    ).toEqual([expect.objectContaining({ type: 'session.stopped', requestId: 'turn-stop' })]);
    expect(events.at(-1)).toMatchObject({ type: 'session.status', payload: { status: 'idle' } });
    await expect(session.stop({ logicalSessionId: 'logical-1', reason: 'user' })).resolves.toEqual({
      stopped: false,
    });
  });

  it('abort failure emits one failed terminal instead of claiming stopped', async () => {
    const stub = createPiSdkStub({ manualPrompt: true, abortError: 'abort transport failed' });
    const events: RuntimeEventDraft[] = [];
    const session = createSession(stub, events);
    await session.startSend({
      logicalSessionId: 'logical-1',
      requestId: 'turn-abort-fail',
      attemptId: 'attempt-abort-fail',
      text: 'go',
    });

    await expect(
      session.stop({ logicalSessionId: 'logical-1', reason: 'user' })
    ).rejects.toMatchObject({ code: 'WORKER_STOP_FAILED' });
    expect(
      events.filter((event) =>
        ['session.completed', 'session.failed', 'session.stopped'].includes(event.type)
      )
    ).toEqual([
      expect.objectContaining({
        type: 'session.failed',
        requestId: 'turn-abort-fail',
        payload: { error: 'Failed to stop Pi session: abort transport failed' },
      }),
    ]);
  });

  it('turn failure emits one failed terminal and ignores late events', async () => {
    const stub = createPiSdkStub({ promptError: 'provider unavailable' });
    const events: RuntimeEventDraft[] = [];
    const session = createSession(stub, events);
    await session.startSend({
      logicalSessionId: 'logical-1',
      requestId: 'turn-fail',
      attemptId: 'attempt-fail',
      text: 'go',
    });
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === 'session.failed')).toBe(true);
    });
    stub.sessionFor('/repo')?.emit({ type: 'agent_settled' });
    expect(events.filter((event) => event.type === 'session.failed')).toHaveLength(1);
    expect(events.some((event) => event.type === 'session.completed')).toBe(false);
  });

  describe('reload after the Pi TUI wrote to the same file', () => {
    async function openedSessionFixture() {
      const dir = await mkdtemp(join(tmpdir(), 'aiclient-worker-reload-'));
      const sessionFile = join(dir, 'session.jsonl');
      await writeFile(sessionFile, '{"type":"session","id":"pi-shared","cwd":"/repo"}\n', 'utf8');
      const openedSession = {
        cwd: '/repo',
        sessionId: 'pi-shared',
        sessionFile,
        branch: [
          {
            type: 'message',
            id: 'gui-1',
            message: { role: 'user', content: [{ type: 'text', text: 'from the GUI' }] },
          },
        ] as unknown[],
      };
      return { dir, sessionFile, openedSession };
    }

    it('picks up entries appended by the terminal and re-binds the approval UI', async () => {
      const { dir, sessionFile, openedSession } = await openedSessionFixture();
      const stub = createPiSdkStub({ openedSession });
      const session = createSession(stub, [], sessionFile);
      try {
        await session.bootstrap();
        const beforeSwitch = stub.sessionFor('/repo');

        // What the Pi TUI does while the GUI worker sits idle: the file grows,
        // and nothing tells the worker — its SessionManager read the file once.
        openedSession.branch.push({
          type: 'message',
          id: 'tui-1',
          message: { role: 'assistant', content: [{ type: 'text', text: 'from the TUI' }] },
        });

        // Proof the read is stale without a reload: same call, old answer.
        await expect(session.history({ logicalSessionId: 'logical-1' })).resolves.toMatchObject({
          page: { totalCount: 1 },
        });

        await expect(
          session.reload({ logicalSessionId: 'logical-1', sessionFile })
        ).resolves.toMatchObject({
          logicalSessionId: 'logical-1',
          sessionFile,
          workspacePath: '/repo',
          history: {
            page: {
              messages: [{ id: 'h:gui-1' }, { id: 'h:tui-1' }],
              totalCount: 2,
            },
          },
        });

        // The runtime replaced the session object. Two things that survive a
        // stale reference silently would break here: history now reads through
        // the NEW manager, and the approval UI is bound to the NEW session —
        // without the rebind every later permission request would be stranded.
        const afterSwitch = stub.sessionFor('/repo');
        expect(afterSwitch).not.toBe(beforeSwitch);
        expect(beforeSwitch?.disposed).toBe(true);
        expect(afterSwitch?.boundUiContext).toBeDefined();
        await expect(session.history({ logicalSessionId: 'logical-1' })).resolves.toMatchObject({
          page: { totalCount: 2 },
        });
      } finally {
        await session.dispose();
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('refuses to reload a file this worker does not own', async () => {
      const { dir, sessionFile, openedSession } = await openedSessionFixture();
      const stub = createPiSdkStub({ openedSession });
      const session = createSession(stub, [], sessionFile);
      try {
        await session.bootstrap();
        await expect(
          session.reload({ logicalSessionId: 'logical-1', sessionFile: '/elsewhere/other.jsonl' })
        ).rejects.toMatchObject({ code: 'WORKER_RELOAD_IDENTITY_MISMATCH' });
      } finally {
        await session.dispose();
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('reports a failed re-open as retryable so the slot can be replaced', async () => {
      const { dir, sessionFile, openedSession } = await openedSessionFixture();
      const stub = createPiSdkStub({ openedSession, switchSessionError: 'disk went away' });
      const session = createSession(stub, [], sessionFile);
      try {
        await session.bootstrap();
        await expect(
          session.reload({ logicalSessionId: 'logical-1', sessionFile })
        ).rejects.toMatchObject({ code: 'WORKER_RELOAD_FAILED', retryable: true });
      } finally {
        await session.dispose();
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('refuses to reload mid-turn rather than pulling the file out from under it', async () => {
      const { dir, sessionFile, openedSession } = await openedSessionFixture();
      const stub = createPiSdkStub({ openedSession, manualPrompt: true });
      const session = createSession(stub, [], sessionFile);
      try {
        await session.startSend({
          logicalSessionId: 'logical-1',
          requestId: 'turn-1',
          attemptId: 'attempt-1',
          text: 'go',
        });
        await expect(
          session.reload({ logicalSessionId: 'logical-1', sessionFile })
        ).rejects.toMatchObject({ code: 'WORKER_SESSION_BUSY', retryable: true });
      } finally {
        stub.finishPrompt('/repo');
        await session.dispose();
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  // T38-a/T38-c: the two producers the Run surface waits on. Both are read off
  // events the worker already subscribes to — no new SDK surface, no polling.
  describe('usage and tool-status producers (T38)', () => {
    const TURN_USAGE = {
      input: 12_000,
      output: 480,
      cacheRead: 9_000,
      cacheWrite: 1_200,
      totalTokens: 22_680,
      cost: { total: 0.0504 },
    };

    async function runTurn(
      stub: ReturnType<typeof createPiSdkStub>,
      events: RuntimeEventDraft[],
      emit: (pi: NonNullable<ReturnType<typeof stub.sessionFor>>) => void
    ) {
      const session = createSession(stub, events);
      await session.startSend({
        logicalSessionId: 'logical-1',
        requestId: 'turn-1',
        attemptId: 'attempt-1',
        text: 'go',
      });
      const pi = stub.sessionFor('/repo');
      if (!pi) throw new Error('stub session missing');
      emit(pi);
      return session;
    }

    it('emits one usage.updated per turn_end, carrying totals and context occupancy', async () => {
      const stub = createPiSdkStub({
        manualPrompt: true,
        contextUsage: { tokens: 21_400, contextWindow: 200_000, percent: 10.7 },
      });
      const events: RuntimeEventDraft[] = [];
      const session = await runTurn(stub, events, (pi) => {
        pi.emit({ type: 'agent_start' });
        pi.emit({ type: 'turn_end', message: { role: 'assistant', usage: TURN_USAGE } });
      });

      expect(events.filter((event) => event.type === 'usage.updated')).toEqual([
        {
          type: 'usage.updated',
          sessionId: 'logical-1',
          requestId: 'turn-1',
          payload: {
            input: 12_000,
            output: 480,
            cacheRead: 9_000,
            cacheWrite: 1_200,
            totalTokens: 22_680,
            costUsd: 0.0504,
            context: { tokens: 21_400, contextWindow: 200_000, percent: 10.7 },
          },
        },
      ]);

      stub.finishPrompt('/repo');
      await session.dispose();
    });

    it('reports each tool-calling turn separately and never doubles the last one on agent_end', async () => {
      const stub = createPiSdkStub({ manualPrompt: true });
      const events: RuntimeEventDraft[] = [];
      const session = await runTurn(stub, events, (pi) => {
        pi.emit({ type: 'agent_start' });
        pi.emit({ type: 'turn_end', message: { role: 'assistant', usage: TURN_USAGE } });
        pi.emit({
          type: 'turn_end',
          message: { role: 'assistant', usage: { ...TURN_USAGE, output: 900 } },
        });
        // `agent_end` carries the whole message list, including the assistant
        // message the second `turn_end` already reported.
        pi.emit({
          type: 'agent_end',
          willRetry: false,
          messages: [{ role: 'assistant', usage: { ...TURN_USAGE, output: 900 } }],
        });
        pi.emit({ type: 'agent_settled' });
      });

      const usage = events.filter((event) => event.type === 'usage.updated');
      expect(usage).toHaveLength(2);
      expect(usage.map((event) => (event.payload as { output: number }).output)).toEqual([
        480, 900,
      ]);

      await session.dispose();
    });

    it('stays silent when the turn carried no usage at all', async () => {
      const stub = createPiSdkStub({ manualPrompt: true });
      const events: RuntimeEventDraft[] = [];
      const session = await runTurn(stub, events, (pi) => {
        pi.emit({ type: 'turn_end', message: { role: 'assistant' } });
      });

      expect(events.filter((event) => event.type === 'usage.updated')).toEqual([]);

      stub.finishPrompt('/repo');
      await session.dispose();
    });

    it('still reports the turn totals when getContextUsage throws or is absent', async () => {
      for (const options of [{ contextUsageThrows: 'branch mid-write' }, {}]) {
        const stub = createPiSdkStub({ manualPrompt: true, ...options });
        const events: RuntimeEventDraft[] = [];
        const session = await runTurn(stub, events, (pi) => {
          pi.emit({ type: 'turn_end', message: { role: 'assistant', usage: TURN_USAGE } });
        });

        const [usage] = events.filter((event) => event.type === 'usage.updated');
        expect(usage?.payload).toMatchObject({ input: 12_000, output: 480 });
        expect(usage?.payload).not.toHaveProperty('context');

        stub.finishPrompt('/repo');
        await session.dispose();
      }
    });

    it('forwards the newest line of a tool partialResult as a clamped status', async () => {
      const stub = createPiSdkStub({ manualPrompt: true });
      const events: RuntimeEventDraft[] = [];
      const session = await runTurn(stub, events, (pi) => {
        pi.emit({
          type: 'tool_execution_start',
          toolCallId: 'tool-1',
          toolName: 'fetch',
          args: {},
        });
        pi.emit({
          type: 'tool_execution_update',
          toolCallId: 'tool-1',
          toolName: 'fetch',
          args: {},
          partialResult: { content: 'Resolving…\nDownloaded 3/12\n' },
        });
        pi.emit({
          type: 'tool_execution_update',
          toolCallId: 'tool-1',
          toolName: 'fetch',
          args: {},
          partialResult: { content: `${'x'.repeat(200)}` },
        });
        // A structured progress object with no text at all: "no status" is not
        // an empty one, and a serialized object is not a progress report.
        pi.emit({
          type: 'tool_execution_update',
          toolCallId: 'tool-1',
          toolName: 'fetch',
          args: {},
          partialResult: { details: { bytes: 12 } },
        });
      });

      const statuses = events
        .filter((event) => event.type === 'tool.updated')
        .map((event) => (event.payload as { status?: string }).status);
      expect(statuses).toEqual([`Downloaded 3/12`, `${'x'.repeat(120)}…`, undefined]);

      stub.finishPrompt('/repo');
      await session.dispose();
    });
  });

  it('rejects mismatched sessions, concurrent sends, and bootstrap after disposal', async () => {
    const stub = createPiSdkStub({ manualPrompt: true });
    const session = createSession(stub, []);
    await session.startSend({
      logicalSessionId: 'logical-1',
      requestId: 'turn-1',
      attemptId: 'attempt-1',
      text: 'go',
    });
    await expect(
      session.startSend({
        logicalSessionId: 'logical-1',
        requestId: 'turn-2',
        attemptId: 'attempt-2',
        text: 'again',
      })
    ).rejects.toMatchObject({ code: 'WORKER_SESSION_BUSY', retryable: true });
    await expect(session.stop({ logicalSessionId: 'other', reason: 'user' })).rejects.toMatchObject(
      { code: 'WORKER_SESSION_MISMATCH' }
    );
    await session.dispose();
    await expect(session.bootstrap()).rejects.toMatchObject({ code: 'WORKER_SESSION_DISPOSED' });
  });
});
