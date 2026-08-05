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
   * The turn already produced at least one block. Arriving tokens disprove the
   * retry — the store only clears `retry` on the NEXT `session.status` without
   * a payload, which streaming does not emit, so without this gate the banner
   * would outlive the retry it reports. Same precedence rule that makes
   * `turnStatus.ts` rank `streaming` above `retrying`.
   */
  hasBlocks: boolean;
}

export interface RetryBannerView {
  /** e.g. `Network retry 2/10 — the turn is still running`. */
  title: string;
  /** e.g. `Next attempt in 8s · unknown`; `null` when no segment survives. */
  detail: string | null;
}

/**
 * Folds the session's transport-retry state into the banner view, or `null`
 * for "render nothing" — no empty box, mirroring `deriveTurnHeadModel`'s
 * `T | null` shape.
 */
export function deriveRetryBanner(input: RetryBannerInput): RetryBannerView | null {
  if (!input.retry || !input.inFlight || input.hasBlocks) return null;

  const attempt = positiveInt(input.retry.attempt);
  const maxRetries = positiveInt(input.retry.maxRetries);
  // A ceiling without an attempt number is unreportable ("retry ?/10"), so the
  // count segment degrades attempt-first.
  const counts =
    attempt === null ? '' : maxRetries === null ? ` ${attempt}` : ` ${attempt}/${maxRetries}`;

  const segments: string[] = [];
  const delayMs = input.retry.delayMs;
  if (typeof delayMs === 'number' && Number.isFinite(delayMs) && delayMs > 0) {
    segments.push(`Next attempt in ${formatRetryDelay(delayMs)}`);
  }
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
    title: `Network retry${counts} — the turn is still running`,
    detail: segments.length > 0 ? segments.join(' · ') : null,
  };
}

/** `attempt`/`maxRetries` are 1-based; the normalizer's missing-field sentinel is `0`. */
function positiveInt(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? value : null;
}

/** Sub-second backoffs exist (first retry can be ~500ms) — never print `0s`. */
function formatRetryDelay(delayMs: number): string {
  if (delayMs < 1000) return '<1s';
  return `${Math.round(delayMs / 1000)}s`;
}
