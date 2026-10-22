import { describe, expect, it, vi } from 'vitest';
import {
  buildSideQuestionPrompt,
  buildSideQuestionTranscript,
  SIDE_QUESTION_SYSTEM_PROMPT,
} from '../../../shared/sideQuestion.ts';
import type { HistoryMessage } from '../../../shared/types/sessionHistory.ts';
import {
  isWorkerSideQuestionPayload,
  sanitizeWorkerSideQuestionResult,
  WORKER_RPC_PROTOCOL_VERSION,
  type WorkerRpcRequest,
} from '../../../shared/types/workerRpc.ts';
import { BridgeRpcServer, type BridgeSessionRuntime } from '../bridgeRpcServer.ts';
import type { CompletionChunk, CompletionStreamOptions } from '../completions.ts';
import type { DshRoutedModel } from '../modelRoute.ts';
import { askDshSideQuestion } from '../sideQuestion.ts';

/**
 * Layout 5f (ui-cohesion ruling L6): a side question reads the conversation so
 * far and writes nothing back — the DSH prompt, the one tool-free call, and
 * the server answering it off the request chain (a running turn holds that).
 */

const ROUTED: DshRoutedModel = {
  modelId: 'aiclient-gateway/fake-1',
  selection: { provider: 'aiclient-gateway', model: 'fake-1' },
} as DshRoutedModel;

function message(
  id: string,
  role: HistoryMessage['role'],
  blocks: HistoryMessage['blocks']
): HistoryMessage {
  return { id: `h:${id}`, role, blocks } as HistoryMessage;
}

const CONVERSATION: HistoryMessage[] = [
  message('u1', 'user', [{ type: 'text', id: 'u1:0', text: 'Rename the helper' }]),
  message('a1', 'assistant', [
    { type: 'thinking', id: 'a1:0', text: 'secret scratch work' },
    { type: 'text', id: 'a1:1', text: 'Reading the file first.' },
    {
      type: 'tool_call',
      id: 'a1:2',
      toolCallId: 't1',
      name: 'read',
      input: { path: 'src/a.ts' },
    },
    { type: 'tool_result', id: 'a1:3', toolCallId: 't1', ok: true, output: 'export const a = 1' },
  ]),
];

describe('side question prompt (DSH)', () => {
  it('quotes what was said and the tools, never the thinking', () => {
    const transcript = buildSideQuestionTranscript(CONVERSATION);
    expect(transcript).toContain('User: Rename the helper');
    expect(transcript).toContain('Assistant: Reading the file first.');
    expect(transcript).toContain('[Tool call: read {"path":"src/a.ts"}]');
    expect(transcript).toContain('[Tool result] export const a = 1');
    expect(transcript).not.toContain('secret scratch work');
  });

  it('keeps the newest messages when the conversation is too long', () => {
    const long = Array.from({ length: 50 }, (_, index) =>
      message(`m${index}`, 'user', [{ type: 'text', id: `m${index}:0`, text: `line ${index}` }])
    );
    const transcript = buildSideQuestionTranscript(long, 60);
    expect(transcript.startsWith('[Earlier parts of the conversation are omitted.]')).toBe(true);
    expect(transcript).toContain('line 49');
    expect(transcript).not.toContain('line 0\n');
  });

  it('carries earlier side questions and ends with the question', () => {
    const prompt = buildSideQuestionPrompt({
      transcript: 'User: hi',
      history: [{ question: 'first?', answer: 'one' }],
      question: 'and then?',
    });
    expect(prompt).toContain('<conversation>\nUser: hi\n</conversation>');
    expect(prompt).toContain('Question: first?\nYour answer: one');
    expect(prompt.endsWith('Side question: and then?')).toBe(true);
  });
});

function fakeLlm(chunks: CompletionChunk[], seen: CompletionStreamOptions[] = []) {
  return {
    stream(options: CompletionStreamOptions): AsyncIterable<CompletionChunk> {
      seen.push(options);
      return (async function* () {
        for (const chunk of chunks) yield chunk;
      })();
    },
  };
}

describe('askDshSideQuestion', () => {
  it('one tool-free call on the session model; the answer is the text', async () => {
    const seen: CompletionStreamOptions[] = [];
    const onUsage = vi.fn();
    const result = await askDshSideQuestion({
      llm: fakeLlm(
        [
          { type: 'text-delta', text: 'It is ' },
          { type: 'text-delta', text: 'a.ts' },
          { type: 'usage', usage: { input: 10 } },
          { type: 'finish', reason: { kind: 'stop' } },
        ],
        seen
      ),
      routed: ROUTED,
      messages: CONVERSATION,
      question: 'Which file?',
      signal: new AbortController().signal,
      onUsage,
    });
    expect(result).toEqual({ text: 'It is a.ts' });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.model).toBe('fake-1');
    expect(seen[0]?.system).toBe(SIDE_QUESTION_SYSTEM_PROMPT);
    expect(seen[0]?.messages).toHaveLength(1);
    expect(seen[0]?.messages[0]?.content[0]?.text).toContain('Side question: Which file?');
    expect(onUsage).toHaveBeenCalledWith({ input: 10 });
  });

  it('an empty answer is no answer; a failed call is an error', async () => {
    const empty = await askDshSideQuestion({
      llm: fakeLlm([{ type: 'finish', reason: { kind: 'stop' } }]),
      routed: ROUTED,
      messages: [],
      question: 'q',
      signal: new AbortController().signal,
    });
    expect(empty).toEqual({ text: null });
    await expect(
      askDshSideQuestion({
        llm: fakeLlm([
          { type: 'finish', reason: { kind: 'error', failure: { code: 'X', message: 'down' } } },
        ]),
        routed: ROUTED,
        messages: [],
        question: 'q',
        signal: new AbortController().signal,
      })
    ).rejects.toMatchObject({ code: 'X', message: 'down' });
  });

  it('an aborted call is cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      askDshSideQuestion({
        llm: fakeLlm([]),
        routed: ROUTED,
        messages: [],
        question: 'q',
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ code: 'WORKER_SIDE_QUESTION_CANCELLED' });
  });
});

describe('side question payloads', () => {
  it('guards the request and clamps the answer', () => {
    const base = { logicalSessionId: 'l', questionId: 'q1', question: 'why?' };
    expect(isWorkerSideQuestionPayload(base)).toBe(true);
    expect(isWorkerSideQuestionPayload({ ...base, question: '  ' })).toBe(false);
    expect(isWorkerSideQuestionPayload({ ...base, questionId: '' })).toBe(false);
    expect(
      isWorkerSideQuestionPayload({ ...base, history: [{ question: 'a', answer: 'b' }] })
    ).toBe(true);
    expect(isWorkerSideQuestionPayload({ ...base, history: [{ question: 'a' }] })).toBe(false);
    expect(sanitizeWorkerSideQuestionResult({ text: 'ok' })).toEqual({ text: 'ok' });
    expect(sanitizeWorkerSideQuestionResult({ text: '  ' })).toEqual({ text: null });
    expect(sanitizeWorkerSideQuestionResult({ text: 3 })).toBeNull();
  });
});

function request(requestId: string, type: string, payload: unknown, generation = 3) {
  return {
    protocolVersion: WORKER_RPC_PROTOCOL_VERSION,
    kind: 'request',
    generation,
    requestId,
    type,
    payload,
  } satisfies WorkerRpcRequest;
}

describe('BridgeRpcServer — worker.sideQuestion (layout 5f)', () => {
  const notCalled = () => {
    throw new Error('not expected');
  };
  function serve(overrides: Partial<BridgeSessionRuntime>) {
    const messages: Array<Record<string, unknown>> = [];
    const runtime = new Proxy(
      {
        bootstrap: async () => ({
          bootstrapped: true,
          logicalSessionId: 'logical-1',
          piSessionId: 'pi-1',
          cwd: '/repo',
          agentDir: '/a',
          sessionFile: '/s',
          leaf: { activeEntryId: null, fileTailEntryId: null },
          projectTrusted: false,
          permissionGate: 'bundled',
        }),
        dispose: async () => undefined,
        ...overrides,
      } as Partial<BridgeSessionRuntime>,
      { get: (target, key: string) => target[key as keyof BridgeSessionRuntime] ?? notCalled }
    ) as BridgeSessionRuntime;
    const server = new BridgeRpcServer({
      port: { postMessage: (message) => messages.push(message as Record<string, unknown>) },
      generation: 3,
      projectTrusted: false,
      createRuntime: () => runtime,
    });
    const answer = (requestId: string) =>
      messages.find((item) => item.requestId === requestId) as
        | { ok: boolean; result?: unknown; error?: { code: string } }
        | undefined;
    return { server, answer };
  }
  const QUESTION = { logicalSessionId: 'logical-1', questionId: 'q1', question: 'what now?' };

  it('is answered while a request holds the chain, and is cancelled by id', async () => {
    let finishSend: () => void = () => undefined;
    const signals: AbortSignal[] = [];
    const { server, answer } = serve({
      startSend: () =>
        new Promise((resolve) => {
          finishSend = () => resolve({ accepted: true, requestId: 'send' });
        }),
      sideQuestion: async (input, signal) => {
        signals.push(signal);
        if (input.questionId === 'q1') return { text: 'answer' };
        return new Promise((_resolve, reject) => {
          if (signal.aborted) reject(new Error('aborted'));
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
      },
    });
    server.receive(
      request('boot', 'worker.bootstrap', { logicalSessionId: 'logical-1', cwd: '/repo' })
    );
    await vi.waitFor(() => expect(answer('boot')).toBeDefined());
    server.receive(
      request('send', 'worker.send', {
        logicalSessionId: 'logical-1',
        requestId: 'send',
        attemptId: 'a',
        text: 'go',
      })
    );
    server.receive(request('side', 'worker.sideQuestion', QUESTION));
    await vi.waitFor(() =>
      expect(answer('side')).toMatchObject({ ok: true, result: { text: 'answer' } })
    );
    expect(answer('send')).toBeUndefined();

    server.receive(request('slow', 'worker.sideQuestion', { ...QUESTION, questionId: 'q2' }));
    server.receive(
      request('cancel', 'worker.sideQuestion.cancel', {
        logicalSessionId: 'logical-1',
        questionId: 'q2',
      })
    );
    expect(answer('cancel')).toMatchObject({ ok: true, result: { cancelled: true } });
    await vi.waitFor(() => expect(answer('slow')).toMatchObject({ ok: false }));
    expect(signals[1]?.aborted).toBe(true);
    finishSend();
  });

  it('refuses another generation, a bad payload, and a worker not bootstrapped', () => {
    const { server, answer } = serve({});
    server.receive(request('early', 'worker.sideQuestion', QUESTION));
    expect(answer('early')).toMatchObject({
      ok: false,
      error: { code: 'WORKER_NOT_BOOTSTRAPPED' },
    });
    server.receive(request('stale', 'worker.sideQuestion', QUESTION, 2));
    expect(answer('stale')).toMatchObject({
      ok: false,
      error: { code: 'WORKER_STALE_GENERATION' },
    });
    server.receive(request('bad', 'worker.sideQuestion', { logicalSessionId: 'logical-1' }));
    expect(answer('bad')).toMatchObject({ ok: false, error: { code: 'WORKER_INVALID_PAYLOAD' } });
    server.receive(
      request('none', 'worker.sideQuestion.cancel', {
        logicalSessionId: 'logical-1',
        questionId: 'x',
      })
    );
    expect(answer('none')).toMatchObject({ ok: true, result: { cancelled: false } });
  });

  it('dispose aborts the side questions in flight', async () => {
    let seen: AbortSignal | undefined;
    const { server, answer } = serve({
      sideQuestion: (_input, signal) => {
        seen = signal;
        return new Promise(() => undefined);
      },
    });
    server.receive(
      request('boot', 'worker.bootstrap', { logicalSessionId: 'logical-1', cwd: '/repo' })
    );
    await vi.waitFor(() => expect(answer('boot')).toBeDefined());
    server.receive(request('side', 'worker.sideQuestion', QUESTION));
    await vi.waitFor(() => expect(seen).toBeDefined());
    server.receive(request('dispose', 'worker.dispose', { reason: 'slot-dispose' }));
    await vi.waitFor(() => expect(answer('dispose')).toBeDefined());
    expect(seen?.aborted).toBe(true);
  });
});
