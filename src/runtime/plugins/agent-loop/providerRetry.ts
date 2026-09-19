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
 * ## Where this file's job ends
 *
 * Events from a stream that already started are forwarded unchanged. That is a
 * division of labour, not a limit on recovery: replacing a half-streamed
 * assistant message needs the loop's message state, which this file does not
 * have, so mid-stream recovery lives in `streamRecovery.ts` and is driven by
 * whichever loop owns the transcript.
 *
 * The two phases share ONE budget (decision 029 clause 4, PI-Desktop's rule).
 * `claim` is the single gate both go through, so a turn that fails once before
 * the stream opens and twice after it has spent three retries — not three plus
 * three. The budget does not reset at the phase boundary and does not double.
 *
 * The earlier wording here said the parent loop deliberately took only
 * pre-stream failures. Decision 029 overturned that: a stream cut by the new
 * body timeout is exactly a mid-stream failure, and leaving it terminal would
 * have made the timeout a regression rather than a fix.
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

/**
 * The retry schedule: wait 3s, then 10s, then 30s.
 *
 * User ruling 2026-09-11 — retries were too frequent. The old shape was a
 * doubling formula per budget (1s/2s/4s/8s for gateway faults, 2s upward with
 * jitter for rate limits), which starts pounding a struggling upstream one
 * second after it first failed. An explicit ladder replaces both: it says the
 * schedule outright instead of asking a reader to evaluate `initial * 2 ** n`,
 * and changing the pacing is now editing three numbers rather than reasoning
 * about a base, a cap and an exponent at once.
 *
 * Both budgets share it. A gateway 503 and a 429 are different faults with
 * different bookkeeping (see the two counters below), but neither is a reason
 * to retry faster than the user asked for.
 */
export const PROVIDER_RETRY_DELAYS_MS: readonly number[] = [3_000, 10_000, 30_000];

/**
 * Retries allowed per budget — one per rung, so the ladder's last value is also
 * the last wait rather than a floor the loop keeps re-using.
 *
 * Each budget gets its own count: a 429 burst and a later gateway fault in the
 * same run may not borrow from each other.
 */
export const PROVIDER_RATE_LIMIT_MAX_RETRIES = PROVIDER_RETRY_DELAYS_MS.length;
export const PROVIDER_TRANSIENT_MAX_RETRIES = PROVIDER_RETRY_DELAYS_MS.length;

/**
 * Rate-limit waits keep positive jitter; gateway-fault waits do not.
 *
 * A 429 burst hits every session at once, so an un-jittered schedule marches
 * them all back in lockstep and re-creates the burst. A single failed request
 * to a 503 gateway has nothing to de-synchronize from, and a predictable
 * schedule is easier to read in a trace.
 */
export const PROVIDER_RATE_LIMIT_JITTER_FACTOR = 0.25;

/** Keep an outage bounded even when the server asks for an unusable delay. */
export const PROVIDER_RATE_LIMIT_MAX_DELAY_MS = 30_000;
export const PROVIDER_SETUP_MAX_RETRY_DELAY_MS = 30_000;

/** The wait for one attempt, before jitter. Past the last rung, stay there. */
function ladderDelayMs(attempt: number): number {
  const index = Math.min(PROVIDER_RETRY_DELAYS_MS.length - 1, Math.max(0, Math.floor(attempt) - 1));
  return PROVIDER_RETRY_DELAYS_MS[index] as number;
}

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

/** Which half of a turn an attempt belonged to; see the module note. */
export type ProviderAttemptPhase = 'request' | 'stream';

/**
 * One provider request, opened.
 *
 * `attempt` is the ordinal of the REQUEST — 1 is the first one a turn makes —
 * and deliberately not the retry number that `claim` returns (there, 1 is the
 * first RE-try, i.e. request 2). Two counters, because the two answer different
 * questions: "how many times did we go out to the network" is what a duration
 * log is about, and "how much of the allowance is left" is what the banner
 * shows.
 */
export interface ProviderAttemptNote {
  attempt: number;
  phase: ProviderAttemptPhase;
  /** Epoch ms. Absolute so a consumer can time it against its own clock. */
  startedAt: number;
}

/** The same attempt, closed. */
export interface ProviderAttemptOutcome extends ProviderAttemptNote {
  durationMs: number;
  /** `streaming`: the provider answered and the stream is live. */
  outcome: 'streaming' | 'failed';
  /** HTTP status captured off the response, when the upstream answered at all. */
  status?: number;
  /** Classification code, on a failure. */
  code?: string;
}

export interface ProviderRetryController {
  /** Claim one retry from the shared per-run budget; the attempt number, or undefined when spent. */
  claim: (error: ClassifiedProviderError) => number | undefined;
  /** Headers captured from the failed HTTP response, if any. */
  headers: () => Readonly<Record<string, string>> | undefined;
  /** Status captured even when the provider body omits the HTTP code. */
  status: () => number | undefined;
  /**
   * Open an attempt on the shared ordinal, and announce it.
   *
   * On the budget rather than on each caller so the request phase and the
   * stream phase number the same turn's requests in one sequence: "attempt 3
   * failed" has to mean the third request this turn made, whichever phase cut
   * it.
   */
  beginAttempt: (phase: ProviderAttemptPhase) => ProviderAttemptNote;
  /**
   * The most recent attempt this budget opened.
   *
   * `streamRecovery.ts` reads it: a stream that dies halfway belongs to a
   * request this budget already opened, and the recovery has to be able to say
   * how long that request had been running before it broke.
   */
  lastAttempt: () => ProviderAttemptNote | undefined;
  /**
   * The provider's own stream reported an error on this attempt.
   *
   * The discriminator `streamRecovery.ts` cannot do without. pi's `Agent` turns
   * EVERY throw inside its loop into an assistant message with
   * `stopReason: "error"` — a session file that could not be appended to, a
   * compaction checkpoint that failed to persist, a listener that threw — so
   * "the last message failed" is not the same question as "the provider
   * failed". Re-asking a request because the local disk is full would spend the
   * whole ladder on something a second attempt cannot fix, and would do it
   * while the user watches a banner promising recovery.
   *
   * Set from the error EVENT as it is forwarded, not from the stream's result,
   * so it is true before pi can emit the `message_end` that a caller classifies.
   * Reset when the next attempt opens.
   */
  providerStreamFailed: () => boolean;
  /** Called by the retry wrapper as it forwards a provider error event. */
  noteProviderStreamFailure: () => void;
  /** Close an attempt opened by {@link beginAttempt}. */
  settleAttempt: (
    note: ProviderAttemptNote,
    outcome: { outcome: ProviderAttemptOutcome['outcome']; status?: number; code?: string }
  ) => void;
  /**
   * About to wait `delayMs` before retry `attempt`.
   *
   * `status` is the HTTP code captured from the failed response when there was
   * one, because the user-facing wording turns on it: an upstream that answered
   * `503` is a different diagnosis from a socket that never connected, and the
   * banner says so. Undefined for a transport-level failure.
   *
   * `retryAt` and `attemptStartedAt` are absolute epoch milliseconds, which is
   * what makes the banner's countdown LIVE instead of a number frozen at the
   * moment the event was drawn (decision 029 clause 3): the renderer recomputes
   * `retryAt - now` every second and switches wording when it reaches zero.
   * `delayMs` stays alongside them because it is the figure the log line and the
   * trace state, and deriving it back out of two timestamps would be worse.
   */
  onRetry?: (input: {
    error: ClassifiedProviderError;
    attempt: number;
    delayMs: number;
    status?: number;
    /** Epoch ms when the attempt that just failed was opened. */
    attemptStartedAt: number;
    /** Epoch ms when the next attempt will be made. */
    retryAt: number;
  }) => void;
  /** A retried request produced its first event, so the wait is over. */
  onRetrySettled?: () => void;
  /** Test hook; production uses the abortable timer below. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Test hook; production reads the wall clock. */
  now?: () => number;
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
 * Server delay first, then the ladder plus positive jitter. Header values are
 * capped so a stale or hostile value cannot hold a turn open.
 */
export function providerRateLimitDelayMs(
  attempt: number,
  headers?: Readonly<Record<string, string>>,
  now = Date.now(),
  random = Math.random()
): number {
  const serverDelay = serverRetryDelayMs(headers, PROVIDER_RATE_LIMIT_MAX_DELAY_MS, now);
  if (serverDelay !== undefined) return serverDelay;

  const base = ladderDelayMs(attempt);
  const jitter = Math.min(1, Math.max(0, random));
  return Math.min(
    PROVIDER_RATE_LIMIT_MAX_DELAY_MS,
    Math.ceil(base + base * PROVIDER_RATE_LIMIT_JITTER_FACTOR * jitter)
  );
}

/**
 * The ladder, unjittered: 3s, 10s, 30s. A gateway that states its own
 * `Retry-After` wins outright — including a delay shorter than our floor,
 * because the gateway knows when it will be ready again.
 */
export function providerSetupRetryDelayMs(
  attempt: number,
  headers?: Readonly<Record<string, string>>,
  now = Date.now()
): number {
  const serverDelay = serverRetryDelayMs(headers, PROVIDER_SETUP_MAX_RETRY_DELAY_MS, now);
  if (serverDelay !== undefined) return serverDelay;
  return ladderDelayMs(attempt);
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
    onRetrySettled?: ProviderRetryController['onRetrySettled'];
    sleep?: ProviderRetryController['sleep'];
    now?: () => number;
    /** Every provider request this budget covers, opened and closed. */
    onAttempt?: (note: ProviderAttemptNote) => void;
    onAttemptSettled?: (outcome: ProviderAttemptOutcome) => void;
  } = {}
): ProviderRetryBudget {
  let status: number | undefined;
  let headers: Record<string, string> | undefined;
  let rateLimitAttempts = 0;
  let transientAttempts = 0;
  let attempts = 0;
  let lastAttempt: ProviderAttemptNote | undefined;
  let providerStreamFailed = false;
  const now = options.now ?? Date.now;

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
      beginAttempt: (phase) => {
        const note: ProviderAttemptNote = { attempt: ++attempts, phase, startedAt: now() };
        lastAttempt = note;
        providerStreamFailed = false;
        options.onAttempt?.(note);
        return note;
      },
      lastAttempt: () => lastAttempt,
      providerStreamFailed: () => providerStreamFailed,
      noteProviderStreamFailure: () => {
        providerStreamFailed = true;
      },
      settleAttempt: (note, outcome) => {
        options.onAttemptSettled?.({
          ...note,
          ...outcome,
          durationMs: Math.max(0, now() - note.startedAt),
        });
      },
      ...(options.onRetry ? { onRetry: options.onRetry } : {}),
      ...(options.onRetrySettled ? { onRetrySettled: options.onRetrySettled } : {}),
      ...(options.sleep ? { sleep: options.sleep } : {}),
      now,
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

  let waiting = false;
  void (async () => {
    for (;;) {
      // maxRetries: 0 — the SDK's own ladder is what made a failed request
      // take 110s in the P0 live smoke; this layer owns the schedule.
      const note = controller.beginAttempt('request');
      const inner = createStream({ ...options, maxRetries: 0 });
      let sawStart = false;
      let settled = false;
      let retry: { error: ClassifiedProviderError; attempt: number } | undefined;

      for await (const event of inner) {
        if (event.type === 'start') {
          sawStart = true;
          // Closed at `start` rather than at the end of the stream: what this
          // attempt's duration measures is how long the provider took to answer
          // at all, which is the number the idle timeout is set against. How
          // long the ANSWER then takes is the model's business, not a fault.
          const startStatus = controller.status();
          controller.settleAttempt(note, {
            outcome: 'streaming',
            ...(startStatus !== undefined ? { status: startStatus } : {}),
          });
          settled = true;
          // The request the last wait was for is now streaming. Announced here
          // rather than after the loop because that is the moment the wait
          // stops being true, and anything reporting it to a user has to stop
          // saying it then and not when the turn eventually ends.
          if (waiting) {
            waiting = false;
            controller.onRetrySettled?.();
          }
        }
        if (!sawStart && event.type === 'error' && event.reason === 'error') {
          const errorMessage =
            typeof event.error.errorMessage === 'string' ? event.error.errorMessage : event.error;
          const error = classifyProviderError(errorMessage, controller.status());
          const status = controller.status();
          controller.settleAttempt(note, {
            outcome: 'failed',
            code: error.code,
            ...(status !== undefined ? { status } : {}),
          });
          settled = true;
          const attempt = controller.claim(error);
          if (attempt !== undefined) {
            retry = { error, attempt };
            break;
          }
        }
        if (event.type === 'error' && event.reason === 'error') {
          // Marked as we FORWARD it, not when the stream settles: pi may emit
          // `message_end` off this very event, and the flag has to be readable
          // by whoever classifies that message.
          controller.noteProviderStreamFailure();
        }
        const forwarded =
          event.type === 'error' && event.reason === 'error' && controller.status() === 429
            ? { ...event, error: normalizeRateLimitMessage(event.error) }
            : event;
        outer.push(forwarded);
      }

      if (!retry) {
        const result = await inner.result();
        // A stream that neither started nor claimed a retry still made a
        // request, and the point of the attempt log is that no request goes
        // unaccounted for.
        if (!settled) {
          const endStatus = controller.status();
          controller.settleAttempt(note, {
            outcome: 'failed',
            ...(result.stopReason === 'error' ? { code: 'PROVIDER_ERROR' } : {}),
            ...(endStatus !== undefined ? { status: endStatus } : {}),
          });
        }
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
      waiting = true;
      const status = controller.status();
      const failedAt = (controller.now ?? Date.now)();
      controller.onRetry?.({
        error: retry.error,
        attempt: retry.attempt,
        delayMs,
        ...(status !== undefined ? { status } : {}),
        attemptStartedAt: note.startedAt,
        retryAt: failedAt + delayMs,
      });
      await sleep(delayMs, options.signal);
    }
  })().catch((error) => {
    const aborted =
      options.signal?.aborted || (error instanceof Error && error.name === 'AbortError');
    const message = setupErrorMessage(model, error, Boolean(aborted));
    // The provider path is what threw, so a caller may treat this as its
    // failure. An abort is not one, and `claimStreamRetry` never asks about a
    // message whose stop reason is `aborted`.
    if (!aborted) controller.noteProviderStreamFailure();
    outer.push({
      type: 'error',
      reason: message.stopReason === 'aborted' ? 'aborted' : 'error',
      error: message,
    });
    outer.end(message);
  });

  return outer;
}
