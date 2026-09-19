import { englishTranslate, type Translate } from '@shared/i18n';
import type { SessionRetryInfo } from '@shared/types/runtimeEvents';

/**
 * T-33: the timeline's transport-retry banner ("not stuck — the CLI is
 * retrying"), rendered at the top of the in-flight turn's body and above the
 * pending turn head.
 *
 * This is deliberately the THIRD `SessionRetryInfo` formatter, not a merge of
 * the other two — each serves a different surface contract and unifying them
 * would couple those contracts:
 *  - `attachments.ts` `composerSendingLine` appends a terse ` · Network retry
 *    N/M` suffix INSIDE the ticking status line (a1 batch, pinned word for
 *    word by `attachments.test.ts`);
 *  - `contextSurfaceModel.ts` `formatRetryLabel` is the Context panel's
 *    full-diagnostic one-liner (raw `delayMs` in ms, error label always).
 * The banner is the user-facing reassurance surface: it is the only one that
 * turns `delayMs` into a human "next attempt in Ns".
 *
 * No store import, no React import — the whole gate and every field-degradation
 * combination is assertable in vitest's node environment.
 *
 * Field absence is SENTINEL-shaped, not `undefined`-shaped: the Host's
 * `eventNormalizer.ts` (`api_retry` branch) defensively fills every missing
 * field with `0` / `null` / `'unknown'` before the event ever crosses IPC, so
 * "missing" here means `attempt < 1`, `maxRetries < 1`, `delayMs <= 0`,
 * `errorStatus === null`, `error === ''`. The `Partial` input shape keeps the
 * `undefined` combinations covered anyway — the renderer should not trust the
 * wire more than it has to (A06: never render a segment whose datum is absent).
 */

export interface RetryBannerInput {
  /** `ChatSession.retry`, read off the red-line store (never written here). */
  retry: Partial<SessionRetryInfo> | null | undefined;
  /**
   * `isTurnInFlight(status)`-family predicate (or literally `true` for the
   * pending head, whose existence IS the in-flight proof). A completed session
   * cannot be mid-retry, whatever a stale store field claims.
   */
  inFlight: boolean;
  /**
   * Output progressed AFTER this retry payload was first observed (the
   * caller snapshots the turn's progress stamp — block count + streamed
   * characters — when the `retry` reference changes; MessageTimeline's
   * `progressStampAtRetry`). Output resuming is what disproves a retry: the
   * store only clears `retry` on the NEXT `session.status` without a
   * payload, which streaming does not emit, so without this gate the banner
   * would outlive the retry it reports.
   *
   * Two earlier cuts, both overturned in Codex review: "the turn has any
   * blocks" was monotonic (one pre-retry tool call suppressed every later
   * mid-turn retry), and "block count grew" missed recovery that appends
   * into an existing text block. Characters are counted for exactly that
   * reason.
   */
  outputSinceRetry: boolean;
  /**
   * T093: whole-second wall clock for the live countdown — MessageTimeline's
   * `useSecondsTick`, the same one the turn head counts with.
   *
   * Absent (or `STATIC_NOW_MS`, the non-ticking turn's sentinel) means "no
   * clock here", and the banner then prints the one-shot `delayMs` duration it
   * was handed. That is what every build before T093 did, and it is still the
   * right answer for a worker that sends no `retryAt`.
   */
  nowMs?: number | null;
  /**
   * Display name of the delegate behind `retry.delegationId`, when the
   * subagent store knows one (`MessageTimeline` resolves it through the lane
   * index). The id itself is never printed: a uuid tells a reader nothing the
   * word "subagent" does not already say.
   */
  delegateName?: string | null;
}

export interface RetryBannerView {
  /** e.g. `Network retry 2/10 — the turn is still running`. */
  title: string;
  /** e.g. `Next attempt in 8s · unknown`; `null` when no segment survives. */
  detail: string | null;
}

/**
 * T093 / decision 029 clause 3 — where the next attempt stands, right now.
 *
 * `countdown` is derived live from `retryAt - nowMs`; `due` is that same
 * subtraction having reached zero, i.e. the attempt is being made as the user
 * reads the line; `static` is the pre-T093 shape, a duration measured once by
 * whoever sent the event. The three are distinguished rather than collapsed
 * into a formatted string because the WORDS differ ("in 8s" vs "now"), and a
 * caller that only has the static duration must not be made to word it as a
 * countdown it is not actually running.
 */
export type RetryCountdown =
  | { kind: 'countdown'; remainingMs: number }
  | { kind: 'due' }
  | { kind: 'static'; delayMs: number };

/**
 * Fold the retry payload plus a clock reading into the countdown state.
 *
 * `null` means "say nothing about timing" — the same degradation rule the rest
 * of this module follows: the normalizer's missing-`delayMs` sentinel is `0`,
 * and a `0` printed as `0s` would claim an instant retry that is not happening.
 *
 * Shared with the turn head's status line (`attachments.ts`), so the banner and
 * the line one row below it cannot count different seconds.
 */
export function deriveRetryCountdown(
  retry: Pick<Partial<SessionRetryInfo>, 'retryAt' | 'delayMs'> | null | undefined,
  nowMs?: number | null
): RetryCountdown | null {
  if (!retry) return null;
  const retryAt = positiveMs(retry.retryAt);
  const now = positiveMs(nowMs);
  if (retryAt !== null && now !== null) {
    const remainingMs = retryAt - now;
    return remainingMs > 0 ? { kind: 'countdown', remainingMs } : { kind: 'due' };
  }
  const delayMs = positiveMs(retry.delayMs);
  return delayMs === null ? null : { kind: 'static', delayMs };
}

/** The one place either surface turns a {@link RetryCountdown} into words. */
export function retryCountdownLabel(
  countdown: RetryCountdown | null,
  t: Translate = englishTranslate
): string | null {
  if (countdown === null) return null;
  // Past the instant: the request is out again and nothing is being waited for,
  // so a countdown frozen at `0s` would be the lie this whole change exists to
  // remove.
  if (countdown.kind === 'due') return t('Retrying now…');
  const ms = countdown.kind === 'countdown' ? countdown.remainingMs : countdown.delayMs;
  return t('Next attempt in {{delay}}', { delay: formatRetryDelay(ms) });
}

/**
 * Folds the session's transport-retry state into the banner view, or `null`
 * for "render nothing" — no empty box, mirroring `deriveTurnHeadModel`'s
 * `T | null` shape.
 */
export function deriveRetryBanner(
  input: RetryBannerInput,
  t: Translate = englishTranslate
): RetryBannerView | null {
  if (!input.retry || !input.inFlight || input.outputSinceRetry) return null;

  const attempt = positiveInt(input.retry.attempt);
  const maxRetries = positiveInt(input.retry.maxRetries);
  // A ceiling without an attempt number is unreportable ("retry ?/10"), so the
  // count segment degrades attempt-first.
  const counts =
    attempt === null ? null : maxRetries === null ? String(attempt) : `${attempt}/${maxRetries}`;

  const segments: string[] = [];
  // T093: live when the payload carries `retryAt` AND a clock was handed in;
  // the old one-shot duration otherwise. Both shapes come out of the same
  // function so the wording can only be written once.
  const countdown = retryCountdownLabel(deriveRetryCountdown(input.retry, input.nowMs), t);
  if (countdown !== null) segments.push(countdown);
  const error =
    typeof input.retry.error === 'string' && input.retry.error !== '' ? input.retry.error : null;
  const errorStatus =
    typeof input.retry.errorStatus === 'string' && input.retry.errorStatus !== ''
      ? input.retry.errorStatus
      : null;
  // Same `error status` ordering the Context panel prints, so the two surfaces
  // never disagree about the same failure.
  if (error !== null) {
    segments.push(errorStatus === null ? error : `${error} ${errorStatus}`);
  } else if (errorStatus !== null) {
    segments.push(errorStatus);
  }

  return {
    // Round-10 inspection ④: an HTTP status means the UPSTREAM answered with
    // an error (user's live case: 503 "No available accounts") — calling that
    // a "network" problem misdirects the diagnosis. Status present → upstream
    // wording; status null (transport-layer failure, the normalizer's
    // sentinel) → the original network wording.
    //
    // T067 (D21): four catalog keys rather than two templates plus `+`. The
    // count is a PARAMETER ('2' or '2/10'), and its presence or absence picks
    // the key — Chinese cannot take an English sentence with a hole punched in
    // the middle of it, and the composer one line below has been saying
    // 「正在重试 · 1/3」 in Chinese the whole time this banner said it in
    // English.
    // T093: a delegate's provider call is retried under the same session as
    // the main conversation's, and the two used to word themselves
    // identically — a fan-out stuck in a gateway outage read as the main turn
    // being stuck. The prefix says whose request this is before it says what
    // happened to it.
    title: withDelegatePrefix(
      t,
      buildTitle(t, errorStatus, counts),
      input.retry.delegationId,
      input.delegateName
    ),
    detail: segments.length > 0 ? segments.join(' · ') : null,
  };
}

/**
 * Prefix the title with whose request this is, when it is not the main
 * conversation's.
 *
 * Name-first, falling back to the bare noun: `delegationId` proves a delegate
 * is involved, but the lane that knows its NAME may not exist yet (a retry can
 * precede the delegate's first event, and lanes are evicted under pressure).
 * Printing the id instead would be worse than printing nothing — it is a uuid.
 */
function withDelegatePrefix(
  t: Translate,
  title: string,
  delegationId: string | undefined,
  delegateName: string | null | undefined
): string {
  const id = typeof delegationId === 'string' ? delegationId.trim() : '';
  if (id === '') return title;
  const name = typeof delegateName === 'string' ? delegateName.trim() : '';
  const who = name === '' ? t('A subagent') : t('Subagent {{name}}', { name });
  return `${who} · ${title}`;
}

/** The 2x2 of "upstream status or not" x "countable attempt or not". */
function buildTitle(t: Translate, errorStatus: string | null, counts: string | null): string {
  if (errorStatus === null) {
    return counts === null
      ? t('Network retry — the turn is still running')
      : t('Network retry {{counts}} — the turn is still running', { counts });
  }
  return counts === null
    ? t('Upstream error {{status}} — retrying, the turn is still running', { status: errorStatus })
    : t('Upstream error {{status}} — retrying {{counts}}, the turn is still running', {
        status: errorStatus,
        counts,
      });
}

/** `attempt`/`maxRetries` are 1-based; the normalizer's missing-field sentinel is `0`. */
function positiveInt(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? value : null;
}

/**
 * A millisecond reading that is worth doing arithmetic with.
 *
 * `0` is rejected on both inputs and for the same reason on each: it is the
 * normalizer's "field absent" sentinel for `delayMs`, and it is
 * `STATIC_NOW_MS` — the constant every turn but the in-flight one is handed —
 * for the clock. Neither is an instant.
 */
function positiveMs(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/** Sub-second backoffs exist (first retry can be ~500ms) — never print `0s`. */
function formatRetryDelay(delayMs: number): string {
  if (delayMs < 1000) return '<1s';
  return `${Math.round(delayMs / 1000)}s`;
}
