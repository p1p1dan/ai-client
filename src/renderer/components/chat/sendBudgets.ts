/**
 * F2 (2026-08-18 watchdog redesign): the renderer's send-wait budgets, split
 * out of `attachmentLimits.ts` so the attachment half and the timing half can
 * be re-measured independently. Pure module — no timer, no store, no React.
 *
 * Pi WorkerSlot is the only verdict-holder. The renderer budget merely stops
 * a local wait after prolonged silence; it never synthesizes a terminal event,
 * aborts another slot, or revives a legacy Host watchdog.
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
