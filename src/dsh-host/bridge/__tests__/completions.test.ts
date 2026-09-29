import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DSH_COMPLETION_CANCELLED,
  DSH_COMPLETION_FAILED,
  DSH_COMPLETION_TIMEOUT,
  DSH_COMPLETION_UNAVAILABLE,
  type DshHostCompleteRequest,
  type DshHostToMainMessage,
  isDshHostCompleted,
  isDshHostCompletionDelta,
} from '../../../shared/types/dshHostProtocol.ts';
import {
  COMPLETION_SYSTEM_PROMPT,
  type CompletionChunk,
  type CompletionLlm,
  type CompletionStreamOptions,
  DshCompletions,
} from '../completions.ts';
import { DshModelRouter } from '../modelRoute.ts';
import { TEST_PLAN } from './testPlan.ts';

/**
 * dsh-rebase P1-15 (decisions 039, 125) — the host's one-shot completions
 * against a fake `ctx.llm`: no DSH package, no process. The route comes from
 * the real router over the bridge's test plan, as a completion. The real
 * engine is exercised by the shared-host integration test.
 */

/** A stream the test feeds chunk by chunk; it ends when `end` is called or the signal aborts. */
class FakeStream implements AsyncIterable<CompletionChunk> {
  private readonly queue: CompletionChunk[] = [];
  private wake: (() => void) | null = null;
  private ended = false;
  private failure: Error | null = null;
  returned = false;

  constructor(signal: AbortSignal) {
    signal.addEventListener('abort', () => {
      this.push({
        type: 'finish',
        reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'aborted' } },
      });
    });
  }

  push(chunk: CompletionChunk): void {
    this.queue.push(chunk);
    this.wake?.();
  }

  end(): void {
    this.ended = true;
    this.wake?.();
  }

  fail(error: Error): void {
    this.failure = error;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<CompletionChunk> {
    try {
      for (;;) {
        const next = this.queue.shift();
        if (next) {
          yield next;
          continue;
        }
        if (this.failure) throw this.failure;
        if (this.ended) return;
        await new Promise<void>((done) => {
          this.wake = done;
        });
        this.wake = null;
      }
    } finally {
      this.returned = true;
    }
  }
}

function harness(options: { llm?: boolean } = {}) {
  const sent: DshHostToMainMessage[] = [];
  const calls: CompletionStreamOptions[] = [];
  const streams: FakeStream[] = [];
  const log = vi.fn();
  const llm: CompletionLlm = {
    stream(request) {
      calls.push(request);
      const stream = new FakeStream(request.signal);
      streams.push(stream);
      return stream;
    },
  };
  const router = new DshModelRouter(() => TEST_PLAN);
  const completions = new DshCompletions({
    llm: () => (options.llm === false ? undefined : llm),
    route: (model, effort) => router.completion(model, effort),
    send: (message) => sent.push(message),
    log,
    now: () => 0,
  });
  const answers = () => sent.filter(isDshHostCompleted);
  const deltas = () => sent.filter(isDshHostCompletionDelta);
  return { completions, sent, calls, streams, log, answers, deltas };
}

function request(patch: Partial<DshHostCompleteRequest> = {}): DshHostCompleteRequest {
  return {
    host: 'complete',
    id: 1,
    purpose: 'commit-message',
    prompt: 'Summarize this diff.',
    timeoutMs: 30_000,
    ...patch,
  };
}

const text = (value: string): CompletionChunk => ({ type: 'text-delta', text: value });
const stop: CompletionChunk = { type: 'finish', reason: { kind: 'stop' } };

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((done) => setImmediate(done));
}

afterEach(() => {
  vi.useRealTimers();
});

describe('DshCompletions — the call (P1-15)', () => {
  it('streams one tool-free request on the plan’s default model, and answers the text and our id', async () => {
    const h = harness();
    h.completions.start(request({ stream: true }));
    await settle();
    expect(h.calls).toHaveLength(1);
    const call = h.calls[0] as CompletionStreamOptions;
    expect(call).toMatchObject({
      provider: 'aiclient-gateway',
      model: 'fake-1',
      system: COMPLETION_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Summarize this diff.' }] }],
    });
    // No tools, no session, no effort for a model that offers none.
    expect(Object.keys(call).sort()).toEqual(['messages', 'model', 'provider', 'signal', 'system']);
    const stream = h.streams[0] as FakeStream;
    stream.push({ type: 'block-start' });
    stream.push({ type: 'reasoning-delta', text: 'thinking…' });
    stream.push(text('feat: '));
    stream.push(text('add a thing'));
    stream.push({ type: 'usage' });
    stream.push(stop);
    await settle();
    expect(h.deltas().map((delta) => delta.text)).toEqual(['feat: ', 'add a thing']);
    expect(h.answers()).toEqual([
      {
        host: 'completed',
        id: 1,
        ok: true,
        text: 'feat: add a thing',
        model: 'aiclient-gateway/fake-1',
        ms: 0,
      },
    ]);
    // Deltas come before the answer, nothing after it.
    expect(h.sent.at(-1)).toMatchObject({ host: 'completed' });
    expect(h.completions.size).toBe(0);
  });

  it('sends no delta unless the request asked, and still answers the whole text', async () => {
    const h = harness();
    h.completions.start(request());
    await settle();
    const stream = h.streams[0] as FakeStream;
    stream.push(text('fix/'));
    stream.push(text('thing'));
    stream.push({ type: 'finish', reason: { kind: 'max-tokens' } });
    await settle();
    expect(h.deltas()).toEqual([]);
    expect(h.answers()).toMatchObject([{ ok: true, text: 'fix/thing' }]);
  });

  it('routes the chosen model as a completion: the chosen effort goes, off and none send none', async () => {
    const h = harness();
    h.completions.start(request({ id: 1, model: 'thinker/deep-1', effort: 'high' }));
    h.completions.start(request({ id: 2, model: 'thinker/deep-1', effort: 'off' }));
    h.completions.start(request({ id: 3, model: 'thinker/deep-1' }));
    // Outside the vocabulary (the renderer's Automatic), and one the model lacks.
    h.completions.start(request({ id: 4, model: 'thinker/deep-1', effort: 'default' }));
    h.completions.start(request({ id: 5, model: 'thinker/deep-1', effort: 'xhigh' }));
    await settle();
    expect(h.calls.map((call) => [call.provider, call.model, call.reasoningEffort])).toEqual([
      ['thinker~2', 'deep-1', 'high'],
      ['thinker~2', 'deep-1', undefined],
      ['thinker~2', 'deep-1', undefined],
      ['thinker~2', 'deep-1', undefined],
      ['thinker~2', 'deep-1', undefined],
    ]);
    for (const stream of h.streams) {
      stream.push(stop);
    }
    await settle();
    expect(h.answers().map((answer) => answer.model)).toEqual(Array(5).fill('thinker/deep-1'));
  });

  it('refuses a model the plan does not serve with MODEL_NOT_CONFIGURED, before any request', async () => {
    const h = harness();
    h.completions.start(request({ model: 'gone/model-9' }));
    await settle();
    expect(h.calls).toEqual([]);
    expect(h.answers()).toMatchObject([
      {
        ok: false,
        error: { code: 'MODEL_NOT_CONFIGURED', message: expect.stringContaining('gone/model-9') },
      },
    ]);
  });

  it('answers completion_unavailable on a host without an LLM service', async () => {
    const h = harness({ llm: false });
    h.completions.start(request());
    await settle();
    expect(h.answers()).toMatchObject([{ ok: false, error: { code: DSH_COMPLETION_UNAVAILABLE } }]);
  });
});

describe('DshCompletions — failures', () => {
  it('maps DSH’s failure code to ours and keeps DSH’s code and sentence', async () => {
    const h = harness();
    h.completions.start(request({ id: 1 }));
    h.completions.start(request({ id: 2 }));
    h.completions.start(request({ id: 3 }));
    await settle();
    const [first, second, third] = h.streams as [FakeStream, FakeStream, FakeStream];
    first.push({
      type: 'finish',
      reason: {
        kind: 'error',
        failure: { code: 'MISSING_CREDENTIAL', message: 'no key for the route' },
      },
    });
    second.push(text('partial'));
    second.push({
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'slow down' } },
    });
    third.push({
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'SOMETHING_NEW', message: 'a new class' } },
    });
    await settle();
    const byId = h.answers().sort((a, b) => a.id - b.id);
    expect(byId.map((answer) => [answer.id, answer.ok, answer.error, answer.text])).toEqual([
      [
        1,
        false,
        {
          code: 'CREDENTIALS_UNAVAILABLE',
          message: 'no key for the route',
          dshCode: 'MISSING_CREDENTIAL',
        },
        undefined,
      ],
      [
        2,
        false,
        { code: 'PROVIDER_RATE_LIMITED', message: 'slow down', dshCode: 'RATE_LIMIT' },
        undefined,
      ],
      [
        3,
        false,
        { code: DSH_COMPLETION_FAILED, message: 'a new class', dshCode: 'SOMETHING_NEW' },
        undefined,
      ],
    ]);
  });

  it('answers completion_failed when the stream throws, or ends without a finish', async () => {
    const h = harness();
    h.completions.start(request({ id: 1 }));
    h.completions.start(request({ id: 2 }));
    await settle();
    (h.streams[0] as FakeStream).fail(new Error('adapter blew up'));
    (h.streams[1] as FakeStream).end();
    await settle();
    expect(h.answers().map((answer) => [answer.id, answer.error])).toEqual([
      [1, { code: DSH_COMPLETION_FAILED, message: 'adapter blew up' }],
      [2, { code: DSH_COMPLETION_FAILED, message: 'the model stream ended without a finish' }],
    ]);
  });
});

describe('DshCompletions — cancel, timeout and disposal', () => {
  it('cancel answers at once, aborts the request and drops whatever still streams', async () => {
    const h = harness();
    h.completions.start(request({ stream: true }));
    await settle();
    const stream = h.streams[0] as FakeStream;
    stream.push(text('Looks '));
    await settle();
    h.completions.cancel(1);
    // Answered synchronously, before the provider noticed.
    expect(h.answers()).toMatchObject([
      { id: 1, ok: false, error: { code: DSH_COMPLETION_CANCELLED } },
    ]);
    expect(h.calls[0]?.signal.aborted).toBe(true);
    stream.push(text('good'));
    stream.push(stop);
    await settle();
    expect(h.answers()).toHaveLength(1);
    expect(h.deltas().map((delta) => delta.text)).toEqual(['Looks ']);
    expect(stream.returned).toBe(true);
    // Unknown and repeated cancels are ignored.
    h.completions.cancel(1);
    h.completions.cancel(99);
    expect(h.answers()).toHaveLength(1);
  });

  it('gives up after the request’s deadline: completion_timeout, and the request is aborted', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.completions.start(request({ timeoutMs: 5_000 }));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(h.answers()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.answers()).toMatchObject([{ ok: false, error: { code: DSH_COMPLETION_TIMEOUT } }]);
    expect(h.calls[0]?.signal.aborted).toBe(true);
    expect(h.completions.size).toBe(0);
  });

  it('drops a second request under an id still running, without answering it', async () => {
    const h = harness();
    h.completions.start(request());
    h.completions.start(request({ prompt: 'another' }));
    await settle();
    expect(h.calls).toHaveLength(1);
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining('already running'));
    (h.streams[0] as FakeStream).push(stop);
    await settle();
    expect(h.answers()).toHaveLength(1);
  });

  it('dispose aborts and answers every running completion; later requests are refused', async () => {
    const h = harness();
    h.completions.start(request({ id: 1 }));
    h.completions.start(request({ id: 2 }));
    await settle();
    h.completions.dispose();
    expect(h.answers().map((answer) => [answer.id, answer.error?.code])).toEqual([
      [1, DSH_COMPLETION_UNAVAILABLE],
      [2, DSH_COMPLETION_UNAVAILABLE],
    ]);
    expect(h.calls.every((call) => call.signal.aborted)).toBe(true);
    h.completions.start(request({ id: 3 }));
    expect(h.answers().at(-1)).toMatchObject({
      id: 3,
      error: { code: DSH_COMPLETION_UNAVAILABLE },
    });
    expect(h.calls).toHaveLength(2);
  });
});
