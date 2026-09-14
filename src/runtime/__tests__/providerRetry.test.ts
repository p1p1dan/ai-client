import type { AssistantMessage } from '@earendil-works/pi-ai';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { describe, expect, it, vi } from 'vitest';
import { classifyProviderFailure } from '../plugins/agent-loop/providerErrors.ts';
import {
  captureProviderResponse,
  carriesRetryDelayHeaders,
  classifyProviderError,
  createProviderRetryBudget,
  createProviderRetryStream,
  delayWithAbort,
  PROVIDER_RATE_LIMIT_MAX_DELAY_MS,
  PROVIDER_RATE_LIMIT_MAX_RETRIES,
  PROVIDER_RETRY_DELAYS_MS,
  PROVIDER_SETUP_MAX_RETRY_DELAY_MS,
  PROVIDER_TRANSIENT_MAX_RETRIES,
  providerRateLimitDelayMs,
  providerSetupRetryDelayMs,
} from '../plugins/agent-loop/providerRetry.ts';

/**
 * F4: a gateway 503 used to end the turn on its first try, because pi-ai
 * reports a setup failure as an error EVENT rather than by throwing, and the
 * native runtime had no retry layer of its own. These tests pin the schedule
 * and the budgets without touching a provider.
 */

const model = {
  id: 'model',
  api: 'openai-completions',
  provider: 'provider',
  name: 'Model',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_000,
  maxTokens: 4_000,
  baseUrl: 'https://provider.invalid/v1',
} as any;

const context = { messages: [], tools: [] } as never;

function assistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: 'openai-completions',
    provider: 'provider',
    model: 'model',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'error',
    errorMessage: '503: service unavailable',
    timestamp: Date.now(),
    ...overrides,
  };
}

/** A setup failure: the request never produced a `start` event. */
function failedStream(overrides: Partial<AssistantMessage> = {}) {
  const stream = createAssistantMessageEventStream();
  const error = assistantMessage(overrides);
  queueMicrotask(() => {
    stream.push({ type: 'error', reason: 'error', error });
    stream.end(error);
  });
  return stream;
}

function successfulStream() {
  const stream = createAssistantMessageEventStream();
  const message = assistantMessage({
    content: [{ type: 'text', text: 'recovered' }],
    stopReason: 'stop',
    errorMessage: undefined,
  });
  queueMicrotask(() => {
    stream.push({ type: 'start', partial: message });
    stream.push({ type: 'done', reason: 'stop', message });
    stream.end(message);
  });
  return stream;
}

/** A stream that started and then broke: mid-stream, not our phase. */
function brokenAfterStart() {
  const stream = createAssistantMessageEventStream();
  const error = assistantMessage({ errorMessage: '503: dropped mid-stream' });
  queueMicrotask(() => {
    stream.push({ type: 'start', partial: error });
    stream.push({ type: 'error', reason: 'error', error });
    stream.end(error);
  });
  return stream;
}

function budget(overrides: Parameters<typeof createProviderRetryBudget>[0] = {}) {
  const slept: number[] = [];
  const retries: Array<{ code: string; attempt: number; delayMs: number }> = [];
  const created = createProviderRetryBudget({
    onRetry: ({ error, attempt, delayMs }) => retries.push({ code: error.code, attempt, delayMs }),
    sleep: async (ms) => {
      slept.push(ms);
    },
    ...overrides,
  });
  return { ...created, slept, retries };
}

describe('provider failure classification', () => {
  it.each([
    ['429: too many requests', 'PROVIDER_RATE_LIMITED', true],
    ['503: service unavailable', 'PROVIDER_ERROR', true],
    ['529: overloaded_error', 'PROVIDER_ERROR', true],
    ['502: bad gateway', 'PROVIDER_ERROR', true],
    ['408: request timeout', 'TIMEOUT', true],
    ['fetch failed', 'NETWORK_ERROR', true],
    ['401: invalid api key', 'PROVIDER_UNAUTHORIZED', false],
    ['403: forbidden', 'PROVIDER_UNAUTHORIZED', false],
    // loop-model-04: pi-ai's own words for a key that is not there, thrown
    // before a request exists. It carries no status and used to reach the
    // retriable bucket, costing the user 43 seconds of local failures.
    ['No API key for provider: gateway', 'PROVIDER_UNAUTHORIZED', false],
    ['404: unknown model', 'MODEL_NOT_CONFIGURED', false],
    ['413: payload too large', 'CONTEXT_TOO_LARGE', false],
    ['400: prompt is too long', 'CONTEXT_TOO_LARGE', false],
    ['400: unsupported parameter', 'PROVIDER_ERROR', false],
  ])('classifies %s', (message, code, retriable) => {
    const classified = classifyProviderFailure(message);
    expect(classified.code).toBe(code);
    expect(classified.retriable).toBe(retriable);
  });

  it('keeps an aborted turn terminal', () => {
    const error = Object.assign(new Error('Request aborted'), { name: 'AbortError' });
    expect(classifyProviderFailure(error)).toMatchObject({
      code: 'TURN_ABORTED',
      retriable: false,
    });
  });

  it('redacts credentials out of the recorded message', () => {
    const classified = classifyProviderFailure(
      '500: {"authorization": "Bearer sk-secret-value", "api_key": "sk-other"}'
    );
    expect(classified.message).not.toContain('sk-secret-value');
    expect(classified.message).not.toContain('sk-other');
    expect(classified.message).toContain('[REDACTED]');
  });

  it('trusts a captured 429 over a generic body', () => {
    // Some adapters answer a rate-limited request with `fetch failed`.
    expect(classifyProviderError('fetch failed', 429)).toMatchObject({
      code: 'PROVIDER_RATE_LIMITED',
      retriable: true,
    });
    // But a captured 429 must not resurrect a terminal classification.
    expect(classifyProviderError('401: invalid api key', 429)).toMatchObject({
      code: 'PROVIDER_UNAUTHORIZED',
      retriable: false,
    });
  });
});

describe('retry delays', () => {
  it('allows three retries per budget, and no more', () => {
    // Pinned as literals, not read off the ladder's length: the two budget
    // tests below assert `PROVIDER_*_MAX_RETRIES + 1` attempts, which passes
    // for any value the constant happens to hold. This is the one place the
    // COUNT is stated, so a silent change to it fails here.
    expect(PROVIDER_TRANSIENT_MAX_RETRIES).toBe(3);
    expect(PROVIDER_RATE_LIMIT_MAX_RETRIES).toBe(3);
    // 3 + 10 + 30: what a user waits before a persistent outage is reported.
    expect(PROVIDER_RETRY_DELAYS_MS.reduce((total, ms) => total + ms, 0)).toBe(43_000);
  });

  it('walks the 3s / 10s / 30s ladder and stays on the last rung', () => {
    // User ruling 2026-09-11: retries were too frequent. The numbers are the
    // spec, so they are spelled out here rather than derived from the exported
    // array — a test that recomputes the schedule from the same constant the
    // code uses would pass no matter what the schedule became.
    expect(providerSetupRetryDelayMs(1)).toBe(3_000);
    expect(providerSetupRetryDelayMs(2)).toBe(10_000);
    expect(providerSetupRetryDelayMs(3)).toBe(30_000);
    expect(providerSetupRetryDelayMs(9)).toBe(30_000);
    expect(PROVIDER_SETUP_MAX_RETRY_DELAY_MS).toBe(30_000);
  });

  it('honours Retry-After in seconds, milliseconds, and HTTP-date', () => {
    const now = Date.parse('2026-09-09T10:00:00Z');
    expect(providerSetupRetryDelayMs(1, { 'retry-after': '3' }, now)).toBe(3_000);
    // A server delay wins even when it is shorter than our own floor.
    expect(providerSetupRetryDelayMs(4, { 'retry-after': '0.5' }, now)).toBe(500);
    expect(providerRateLimitDelayMs(1, { 'retry-after-ms': '1500' }, now)).toBe(1_500);
    expect(
      providerRateLimitDelayMs(1, { 'retry-after': 'Wed, 09 Sep 2026 10:00:05 GMT' }, now)
    ).toBe(5_000);
    // Precedence: milliseconds before seconds.
    expect(providerRateLimitDelayMs(1, { 'retry-after-ms': '900', 'retry-after': '30' }, now)).toBe(
      900
    );
  });

  it('caps a hostile Retry-After instead of holding the turn open', () => {
    const now = Date.now();
    expect(providerRateLimitDelayMs(1, { 'retry-after': '86400' }, now)).toBe(
      PROVIDER_RATE_LIMIT_MAX_DELAY_MS
    );
    expect(providerSetupRetryDelayMs(1, { 'retry-after': '86400' }, now)).toBe(
      PROVIDER_SETUP_MAX_RETRY_DELAY_MS
    );
  });

  it('adds positive jitter on top of the same ladder for rate limits', () => {
    expect(providerRateLimitDelayMs(1, undefined, Date.now(), 0)).toBe(3_000);
    expect(providerRateLimitDelayMs(1, undefined, Date.now(), 1)).toBe(3_750);
    expect(providerRateLimitDelayMs(2, undefined, Date.now(), 0)).toBe(10_000);
    // The cap and the last rung are both 30s, so a fully jittered last wait is
    // clamped rather than reaching 37.5s.
    expect(providerRateLimitDelayMs(3, undefined, Date.now(), 1)).toBe(30_000);
  });

  it('only keeps headers from statuses that carry a delay', () => {
    expect(carriesRetryDelayHeaders(429)).toBe(true);
    expect(carriesRetryDelayHeaders(503)).toBe(true);
    expect(carriesRetryDelayHeaders(408)).toBe(true);
    expect(carriesRetryDelayHeaders(200)).toBe(false);
    expect(carriesRetryDelayHeaders(undefined)).toBe(false);
  });
});

describe('createProviderRetryStream', () => {
  it('retries a 503 setup failure and forwards the recovered stream', async () => {
    const { controller, slept, retries } = budget();
    let attempts = 0;
    const stream = createProviderRetryStream(
      model,
      context,
      {},
      () => {
        attempts += 1;
        return attempts <= 2 ? failedStream() : successfulStream();
      },
      controller
    );

    const events: string[] = [];
    for await (const event of stream) events.push(event.type);
    const result = await stream.result();

    expect(attempts).toBe(3);
    expect(slept).toEqual([3_000, 10_000]);
    expect(retries.map((entry) => entry.code)).toEqual(['PROVIDER_ERROR', 'PROVIDER_ERROR']);
    // The consumer never sees the failed attempts, only the stream that worked.
    expect(events).toEqual(['start', 'done']);
    expect(result.stopReason).toBe('stop');
  });

  it('disables the SDK ladder so this layer owns the schedule', async () => {
    const { controller } = budget();
    const seen: Array<number | undefined> = [];
    const stream = createProviderRetryStream(
      model,
      context,
      { maxRetries: 7 },
      (options) => {
        seen.push(options.maxRetries);
        return successfulStream();
      },
      controller
    );
    for await (const _event of stream) void _event;
    expect(seen).toEqual([0]);
  });

  it('does not retry a terminal failure', async () => {
    const { controller, slept } = budget();
    let attempts = 0;
    const stream = createProviderRetryStream(
      model,
      context,
      {},
      () => {
        attempts += 1;
        return failedStream({ errorMessage: '401: invalid api key' });
      },
      controller
    );
    const result = await stream.result();
    expect(attempts).toBe(1);
    expect(slept).toEqual([]);
    expect(result.errorMessage).toBe('401: invalid api key');
  });

  it('stops after the transient budget is spent', async () => {
    const { controller, slept } = budget();
    let attempts = 0;
    const stream = createProviderRetryStream(
      model,
      context,
      {},
      () => {
        attempts += 1;
        return failedStream();
      },
      controller
    );
    const result = await stream.result();
    expect(attempts).toBe(PROVIDER_TRANSIENT_MAX_RETRIES + 1);
    expect(slept).toHaveLength(PROVIDER_TRANSIENT_MAX_RETRIES);
    expect(result.stopReason).toBe('error');
  });

  it('gives rate limits their own budget and normalizes the message', async () => {
    const { controller, slept } = budget();
    let attempts = 0;
    const stream = createProviderRetryStream(
      model,
      context,
      {},
      () => {
        attempts += 1;
        return failedStream({ errorMessage: 'too many requests' });
      },
      controller
    );
    const result = await stream.result();
    expect(attempts).toBe(PROVIDER_RATE_LIMIT_MAX_RETRIES + 1);
    expect(slept).toHaveLength(PROVIDER_RATE_LIMIT_MAX_RETRIES);
    expect(result.errorMessage).toBe('too many requests');
  });

  it('leaves a stream that already started to the loop', async () => {
    const { controller, slept } = budget();
    let attempts = 0;
    const stream = createProviderRetryStream(
      model,
      context,
      {},
      () => {
        attempts += 1;
        return brokenAfterStart();
      },
      controller
    );
    const events: string[] = [];
    for await (const event of stream) events.push(event.type);
    expect(attempts).toBe(1);
    expect(slept).toEqual([]);
    expect(events).toEqual(['start', 'error']);
  });

  it('reports an abort during the backoff as an aborted turn', async () => {
    const abort = new AbortController();
    const created = createProviderRetryBudget({
      sleep: async () => {
        throw Object.assign(new Error('Request aborted'), { name: 'AbortError' });
      },
    });
    const stream = createProviderRetryStream(
      model,
      context,
      { signal: abort.signal },
      () => failedStream(),
      created.controller
    );
    abort.abort();
    const result = await stream.result();
    expect(result.stopReason).toBe('aborted');
  });
});

describe('response capture', () => {
  it('records the status and lowercased headers, and clears them per request', async () => {
    const snapshots: Array<{ status: number; headers: Record<string, string> } | undefined> = [];
    const fetchFn = captureProviderResponse(
      vi
        .fn()
        .mockResolvedValue(
          new Response('', { status: 429, headers: { 'Retry-After': '2' } })
        ) as never,
      (response) => snapshots.push(response)
    );
    await fetchFn('https://provider.invalid/v1/chat' as never, undefined as never);
    // Cleared first: a prior 429 must not classify the next failure.
    expect(snapshots[0]).toBeUndefined();
    expect(snapshots[1]).toMatchObject({ status: 429, headers: { 'retry-after': '2' } });
  });

  it('keeps delay headers only for statuses that carry them', async () => {
    const created = createProviderRetryBudget();
    const respond = (status: number) =>
      vi
        .fn()
        .mockResolvedValue(new Response('', { status, headers: { 'retry-after': '2' } })) as never;

    const ok = created.requestOptions({ fetch: respond(200) });
    await (ok.fetch as never as typeof fetch)('https://provider.invalid');
    expect(created.controller.status()).toBe(200);
    expect(created.controller.headers()).toBeUndefined();

    const unavailable = created.requestOptions({ fetch: respond(503) });
    await (unavailable.fetch as never as typeof fetch)('https://provider.invalid');
    expect(created.controller.status()).toBe(503);
    expect(created.controller.headers()).toMatchObject({ 'retry-after': '2' });
  });

  it('rejects a pending backoff as soon as the run is aborted', async () => {
    const abort = new AbortController();
    const pending = delayWithAbort(10_000, abort.signal);
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
