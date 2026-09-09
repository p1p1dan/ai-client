/**
 * Provider retry layer for the request phase.
 *
 * Ported from PI-Desktop `packages/agent-runtime/src/provider-retry.ts`
 * (`948ee676`), with the per-run budget that PI-Desktop keeps on its runtime
 * class turned into `createProviderRetryBudget` here.
 *
 * ## Why this exists
 *
 * pi-ai returns a setup failure (the request never produced a `start` event)
 * as an error EVENT rather than by throwing, so without this wrapper a
 * gateway 503 ends the turn on the first try — that is the behaviour the
 * Windows field pass reported. The SDK's own ladder is not a substitute: the
 * P0 live smoke measured a single failed request at 110s, which is why the
 * inner stream is always created with `maxRetries: 0` and this layer owns the
 * schedule.
 *
 * ## What it does NOT do
 *
 * Events from a stream that already started are forwarded unchanged. Replacing
 * a half-streamed assistant message is mid-stream recovery, which needs the
 * loop's message state, and PI-Desktop keeps that outside this file too.
 */

import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  createAssistantMessageEventStream,
  type FetchFunction,
  type Model,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import { type ClassifiedProviderError, classifyProviderFailure } from './providerErrors.ts';

/** Retries allowed after the first rate-limited request. */
export const PROVIDER_RATE_LIMIT_MAX_RETRIES = 5;
export const PROVIDER_RATE_LIMIT_INITIAL_DELAY_MS = 2_000;
export const PROVIDER_RATE_LIMIT_JITTER_FACTOR = 0.25;
/** Keep an outage bounded even when the server asks for an unusable delay. */
export const PROVIDER_RATE_LIMIT_MAX_DELAY_MS = 30_000;
/**
 * Non-rate-limit transient failures wait 1s, 2s, 4s, then 8s. Plain doubling:
 * an upstream outage gets visibly more room each attempt while the whole
 * sequence stays under 15 seconds.
 */
export const PROVIDER_SETUP_RETRY_INITIAL_DELAY_MS = 1_000;
export const PROVIDER_SETUP_MAX_RETRY_DELAY_MS = 8_000;
/**
 * Retries allowed after the first non-rate-limit transient failure, for five
 * provider attempts in total. Gateway faults (502/503/504, dropped sockets)
 * routinely need more than one attempt, so they share one bounded per-run
 * budget the way rate limits do.
 */
export const PROVIDER_TRANSIENT_MAX_RETRIES = 4;

/**
 * Codes that may claim the shared non-429 budget. Codes outside this set stay
 * terminal even when `retriable` is set, because they are repaired by a
 * different path than re-sending the same request.
 */
const TRANSIENT_RETRY_CODES = new Set([
  'NETWORK_ERROR',
  'TIMEOUT',
  'STREAM_FAILED',
  'PROVIDER_ERROR',
]);

export function isTransientProviderRetryCode(code: string): boolean {
  return TRANSIENT_RETRY_CODES.has(code);
}

/**
 * Statuses whose response headers can carry a usable retry delay. Gateway 5xx
 * and 408/409 often ship `Retry-After`, so keeping their headers lets a
 * transient retry honour server pacing instead of guessing a backoff.
 */
export function carriesRetryDelayHeaders(status: number | undefined): boolean {
  if (status === undefined) return false;
  return status === 429 || status === 408 || status === 409 || status >= 500;
}

export interface ProviderResponseSnapshot {
  status: number;
  headers: Record<string, string>;
}

export interface ProviderRetryController {
  /** Claim one retry from the shared per-run budget; the attempt number, or undefined when spent. */
  claim: (error: ClassifiedProviderError) => number | undefined;
  /** Headers captured from the failed HTTP response, if any. */
  headers: () => Readonly<Record<string, string>> | undefined;
  /** Status captured even when the provider body omits the HTTP code. */
  status: () => number | undefined;
  onRetry?: (input: { error: ClassifiedProviderError; attempt: number; delayMs: number }) => void;
  /** Test hook; production uses the abortable timer below. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Trust a captured HTTP 429 over provider error wording. Some adapters return
 * a generic body (or `fetch failed`) even though the response status is rate
 * limiting. Explicit non-retryable classifications stay terminal.
 */
export function classifyProviderError(
  error: unknown,
  providerStatus?: number
): ClassifiedProviderError {
  const classified = classifyProviderFailure(error);
  if (
    providerStatus === 429 &&
    classified.code !== 'PROVIDER_RATE_LIMITED' &&
    classified.retriable
  ) {
    return {
      ...classified,
      code: 'PROVIDER_RATE_LIMITED',
      retriable: true,
      details: { ...classified.details, providerStatus },
    };
  }
  return classified;
}

function headerValue(
  headers: Readonly<Record<string, string>> | undefined,
  name: string
): string | undefined {
  if (!headers) return undefined;
  return Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
}

function boundedServerDelay(value: number, maxDelayMs: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(maxDelayMs, Math.max(0, Math.ceil(value)));
}

/**
 * The server's requested delay, in order of precedence: provider
 * milliseconds, `Retry-After` seconds, then `Retry-After` HTTP-date.
 */
function serverRetryDelayMs(
  headers: Readonly<Record<string, string>> | undefined,
  maxDelayMs: number,
  now: number
): number | undefined {
  const retryAfterMs = headerValue(headers, 'retry-after-ms');
  if (retryAfterMs !== undefined && retryAfterMs.trim() !== '') {
    const parsed = Number.parseFloat(retryAfterMs);
    if (!Number.isNaN(parsed)) return boundedServerDelay(parsed, maxDelayMs);
  }

  const retryAfter = headerValue(headers, 'retry-after');
  if (retryAfter !== undefined && retryAfter.trim() !== '') {
    const seconds = Number.parseFloat(retryAfter);
    if (!Number.isNaN(seconds)) return boundedServerDelay(seconds * 1_000, maxDelayMs);
    const dateMs = Date.parse(retryAfter) - now;
    if (!Number.isNaN(dateMs)) return boundedServerDelay(dateMs, maxDelayMs);
  }
  return undefined;
}

/**
 * Server delay first, then exponential backoff with positive jitter. Header
 * values are capped so a stale or hostile value cannot hold a turn open.
 */
export function providerRateLimitDelayMs(
  attempt: number,
  headers?: Readonly<Record<string, string>>,
  now = Date.now(),
  random = Math.random()
): number {
  const serverDelay = serverRetryDelayMs(headers, PROVIDER_RATE_LIMIT_MAX_DELAY_MS, now);
  if (serverDelay !== undefined) return serverDelay;

  const safeAttempt = Math.max(1, Math.floor(attempt));
  const base = PROVIDER_RATE_LIMIT_INITIAL_DELAY_MS * 2 ** (safeAttempt - 1);
  const jitter = Math.min(1, Math.max(0, random));
  return Math.min(
    PROVIDER_RATE_LIMIT_MAX_DELAY_MS,
    Math.ceil(base + base * PROVIDER_RATE_LIMIT_JITTER_FACTOR * jitter)
  );
}

/**
 * Plain doubling: 1s, 2s, 4s, 8s. A gateway that states its own `Retry-After`
 * wins outright — including a delay shorter than our floor, because the
 * gateway knows when it will be ready again.
 *
 * No jitter here on purpose: a predictable schedule is easier to reason about
 * for a single failed request, and these retries are not synchronized across
 * sessions the way a rate-limit burst is.
 */
export function providerSetupRetryDelayMs(
  attempt: number,
  headers?: Readonly<Record<string, string>>,
  now = Date.now()
): number {
  const serverDelay = serverRetryDelayMs(headers, PROVIDER_SETUP_MAX_RETRY_DELAY_MS, now);
  if (serverDelay !== undefined) return serverDelay;
  const safeAttempt = Math.max(1, Math.floor(attempt));
  const base = PROVIDER_SETUP_RETRY_INITIAL_DELAY_MS * 2 ** (safeAttempt - 1);
  return Math.min(PROVIDER_SETUP_MAX_RETRY_DELAY_MS, base);
}

export function delayWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abortError = () => Object.assign(new Error('Request aborted'), { name: 'AbortError' });
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timeout);
      reject(abortError());
    };
    const timeout = setTimeout(
      () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      },
      Math.max(0, ms)
    );
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Capture HTTP status and headers, including from failed responses that
 * pi-ai's `onResponse` callback does not surface.
 */
export function captureProviderResponse(
  fetchFn: FetchFunction | undefined,
  onResponse: (response?: ProviderResponseSnapshot) => void
): FetchFunction {
  const baseFetch = fetchFn ?? globalThis.fetch;
  return async (input, init) => {
    // Clear the previous response before a new fetch: if this request fails
    // before headers arrive, a prior 429 must not classify the new failure.
    onResponse();
    const response = await baseFetch(input, init);
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    onResponse({ status: response.status, headers });
    return response;
  };
}

export interface ProviderRetryBudget {
  /** Wrap the per-request options so a failed response's status/headers are captured. */
  requestOptions: (options?: SimpleStreamOptions) => SimpleStreamOptions;
  controller: ProviderRetryController;
}

/**
 * One retry budget per logical run.
 *
 * Rate limits and other transient faults hold separate counters: a run that
 * survived a 429 burst should still get its full allowance for a later
 * gateway fault, and neither may borrow from the other.
 */
export function createProviderRetryBudget(
  options: {
    onRetry?: ProviderRetryController['onRetry'];
    sleep?: ProviderRetryController['sleep'];
  } = {}
): ProviderRetryBudget {
  let status: number | undefined;
  let headers: Record<string, string> | undefined;
  let rateLimitAttempts = 0;
  let transientAttempts = 0;

  return {
    requestOptions: (streamOptions) => ({
      ...streamOptions,
      fetch: captureProviderResponse(streamOptions?.fetch, (response) => {
        status = response?.status;
        headers = carriesRetryDelayHeaders(response?.status) ? response?.headers : undefined;
      }),
    }),
    controller: {
      claim: (error) => {
        if (!error.retriable) return undefined;
        if (error.code === 'PROVIDER_RATE_LIMITED') {
          if (rateLimitAttempts >= PROVIDER_RATE_LIMIT_MAX_RETRIES) return undefined;
          return ++rateLimitAttempts;
        }
        if (!isTransientProviderRetryCode(error.code)) return undefined;
        if (transientAttempts >= PROVIDER_TRANSIENT_MAX_RETRIES) return undefined;
        return ++transientAttempts;
      },
      headers: () => headers,
      status: () => status,
      ...(options.onRetry ? { onRetry: options.onRetry } : {}),
      ...(options.sleep ? { sleep: options.sleep } : {}),
    },
  };
}

function normalizeRateLimitMessage(message: AssistantMessage): AssistantMessage {
  const errorMessage = message.errorMessage ?? '';
  if (/^\s*429\b/.test(errorMessage)) return message;
  return { ...message, errorMessage: `429: ${errorMessage || 'provider rate limited'}` };
}

function setupErrorMessage(model: Model<Api>, error: unknown, aborted: boolean): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: aborted ? 'aborted' : 'error',
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  };
}

type StreamFactory = (options: SimpleStreamOptions) => AssistantMessageEventStream;

/**
 * Wrap a provider stream so pre-stream failures are retried on our schedule.
 *
 * Only failures seen before the first `start` event are consumed; everything
 * from a started stream is forwarded unchanged.
 */
export function createProviderRetryStream(
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions,
  createStream: StreamFactory,
  controller: ProviderRetryController
): AssistantMessageEventStream {
  // Keep the context in the signature: it stops callers from accidentally
  // building a retry stream around a different request than the provider call.
  void context;
  const outer = createAssistantMessageEventStream();
  const sleep = controller.sleep ?? delayWithAbort;

  void (async () => {
    for (;;) {
      // maxRetries: 0 — the SDK's own ladder is what made a failed request
      // take 110s in the P0 live smoke; this layer owns the schedule.
      const inner = createStream({ ...options, maxRetries: 0 });
      let sawStart = false;
      let retry: { error: ClassifiedProviderError; attempt: number } | undefined;

      for await (const event of inner) {
        if (event.type === 'start') sawStart = true;
        if (!sawStart && event.type === 'error' && event.reason === 'error') {
          const errorMessage =
            typeof event.error.errorMessage === 'string' ? event.error.errorMessage : event.error;
          const error = classifyProviderError(errorMessage, controller.status());
          const attempt = controller.claim(error);
          if (attempt !== undefined) {
            retry = { error, attempt };
            break;
          }
        }
        const forwarded =
          event.type === 'error' && event.reason === 'error' && controller.status() === 429
            ? { ...event, error: normalizeRateLimitMessage(event.error) }
            : event;
        outer.push(forwarded);
      }

      if (!retry) {
        const result = await inner.result();
        outer.end(
          result.stopReason === 'error' && controller.status() === 429
            ? normalizeRateLimitMessage(result)
            : result
        );
        return;
      }

      // The failed event already ended this inner stream. Awaiting its result
      // keeps providers with deferred cleanup from overlapping retries.
      await inner.result();
      const delayMs =
        retry.error.code === 'PROVIDER_RATE_LIMITED'
          ? providerRateLimitDelayMs(retry.attempt, controller.headers())
          : providerSetupRetryDelayMs(retry.attempt, controller.headers());
      controller.onRetry?.({ error: retry.error, attempt: retry.attempt, delayMs });
      await sleep(delayMs, options.signal);
    }
  })().catch((error) => {
    const aborted =
      options.signal?.aborted || (error instanceof Error && error.name === 'AbortError');
    const message = setupErrorMessage(model, error, Boolean(aborted));
    outer.push({
      type: 'error',
      reason: message.stopReason === 'aborted' ? 'aborted' : 'error',
      error: message,
    });
    outer.end(message);
  });

  return outer;
}
