/**
 * F2 (2026-08-18 watchdog redesign): the renderer's send-wait budgets, split
 * out of `attachmentLimits.ts` so the attachment half and the timing half can
 * be re-measured independently. Pure module — no timer, no store, no React.
 *
 * REVERSED INVARIANT. This replaces the old "the renderer speaks first" block
 * that used to sit on `SEND_TIMEOUT_CEILING_MS`:
 *
 *   HOST_TTFT_TIMEOUT_MS (32s) < HOST_STALL_TIMEOUT_MS (195s)
 *     < SEND_SILENCE_CEILING_MS (300s) <= SEND_WAIT_LOOP_BOUND_MS (30min)
 *
 * It is NOT "three watchdogs ordered by size". It is two separate statements:
 *
 *  1. The first two are two SEGMENTS OF ONE turn lifeline, both inside the
 *     Host: TTFT covers the span before the first productive event, the
 *     rolling stall watchdog covers everything after it.
 *  2. The third does NOT compete with the stall watchdog over the same span.
 *     `runSend`'s main wait predicate releases on the FIRST 'assistant'
 *     signal, and `classifyAssistantProgress` counts permission / question /
 *     tool / thinking frames as that signal — so the renderer's budget is
 *     semantically a TTFT table and never lives long enough to reach the
 *     stall watchdog's territory. It has to exceed 195s only because the one
 *     shape that DOES keep the renderer waiting that long — a Host that
 *     emitted `system/init` and then went permanently silent — is terminated
 *     by the STALL watchdog, and the Host has to be the one to speak.
 *
 * Direction, therefore: the HOST is the only verdict-holder, and the renderer
 * reaching its ceiling says nothing at all about whether the turn is alive.
 *
 * §12 verification first: __tests__/sendBudgets.test.ts.
 */

/**
 * F2 (2026-08-18): the renderer's SILENCE ceiling — NOT a verdict.
 * Reset by ANY liveness frame for this session (see classifyTurnLiveness).
 * Expiry means only "this renderer stops waiting locally"; the turn is not
 * dead and nobody has said it is. User-locked value.
 */
export const SEND_SILENCE_CEILING_MS = 300_000;

/**
 * F2 (2026-08-18, decision D6): absolute upper bound of the 50ms polling
 * loop, so an endless liveness stream (stderr chatter / retry storm) cannot
 * keep it alive forever. NOT a third watchdog and NOT a verdict: expiry does
 * EXACTLY what a silence expiry does (the 'ceiling' branch). Aligned with
 * CODEX_TURN_START_TIMEOUT_MS (codexRuntime.ts) so the two programs stop
 * disagreeing by 40x.
 */
export const SEND_WAIT_LOOP_BOUND_MS = 1_800_000;

/**
 * Documentation mirror of claudeRuntime.ts's DEFAULT_STALL_TIMEOUT_MS. It
 * cannot be imported (`src/agent-host` is a separate program), so `[C-03]`
 * locks it against the Host SOURCE TEXT. The predecessor of this comment
 * claimed a unit-test lock that only ever compared the two mirrors against
 * each other — they could drift from the Host together and stay green.
 */
export const HOST_STALL_TIMEOUT_MS = 195_000;

/**
 * Documentation mirror of claudeRuntime.ts's DEFAULT_TTFT_TIMEOUT_MS (the
 * "time to first productive event" watchdog). Same cross-program constraint
 * and the same source-text lock as HOST_STALL_TIMEOUT_MS above.
 */
export const HOST_TTFT_TIMEOUT_MS = 32_000;

/**
 * A resettable wait budget for one send.
 *
 * `runSend`'s wait used to be a FIXED deadline (`Date.now() - start < timeoutMs`)
 * with zero reset conditions — a turn could be visibly retrying upstream, with
 * `session.status(running, retry 1/10)` frames arriving, and the budget would
 * still elapse on schedule. That is the defect this type exists to remove:
 * every liveness frame pushes the silence deadline forward, and only the
 * absolute loop bound is immovable.
 */
export interface SendWaitBudget {
  /** Record a liveness frame. Monotonic — a stale timestamp never rewinds it. */
  markLiveness(nowMs: number): void;
  isExpired(nowMs: number): boolean;
  lastLivenessAtMs(): number;
}

/**
 * Time is a parameter, never read from the clock inside — so the whole budget
 * is assertable without a fake timer, and `[I-1]`'s frame sequence can be
 * replayed at arbitrary sample points.
 *
 * The two overrides exist for tests (20~100ms instead of 300s); production
 * always takes the defaults.
 */
export function createSendWaitBudget(
  startedAtMs: number,
  opts?: { silenceCeilingMs?: number; loopBoundMs?: number }
): SendWaitBudget {
  const silenceCeilingMs = opts?.silenceCeilingMs ?? SEND_SILENCE_CEILING_MS;
  const loopBoundMs = opts?.loopBoundMs ?? SEND_WAIT_LOOP_BOUND_MS;
  let lastLivenessAt = startedAtMs;
  return {
    markLiveness(nowMs: number): void {
      if (nowMs > lastLivenessAt) lastLivenessAt = nowMs;
    },
    isExpired(nowMs: number): boolean {
      return nowMs - lastLivenessAt >= silenceCeilingMs || nowMs - startedAtMs >= loopBoundMs;
    },
    lastLivenessAtMs(): number {
      return lastLivenessAt;
    },
  };
}
