/**
 * a4 (2026-07-30 net-visibility batch): one-shot "time to first productive
 * event" watchdog.
 *
 * Distinct from claudeRuntime.ts's existing C-14 stall watchdog, which
 * re-arms on every productive event and tolerates up to
 * DEFAULT_STALL_TIMEOUT_MS (120s) of silence BETWEEN them (a long-running
 * tool call must not be killed). This watchdog only ever cares about the gap
 * between queryFn() returning and the FIRST productive event of the turn —
 * the exact gap a `system/api_retry` loop (or a dead spawn) fills with
 * nothing useful. Its budget is intentionally much shorter (30-35s, always
 * below the renderer's SEND_BASE_TIMEOUT_MS of 45s — see
 * attachmentLimits.ts's INVARIANT comment) so the Host's precise failure
 * reaches the UI before the Composer's generic timeout fallback does.
 *
 * Pulled out of claudeRuntime.ts as a small, pure, injectable-timer class so
 * the arm/markProductive/dispose state machine can be unit tested without
 * spinning up a fake SDK stream or waiting on real timers.
 */

export type TimerHandle = ReturnType<typeof setTimeout>;

export interface TtftWatchdogOptions {
  /** <= 0 disables the watchdog entirely (arm() becomes a no-op). */
  timeoutMs: number;
  /** Fired at most once, only if markProductive() never ran first. */
  onTimeout: () => void;
  /** Test seam — defaults to the real global timer functions. */
  setTimeoutFn?: (callback: () => void, ms: number) => TimerHandle;
  clearTimeoutFn?: (handle: TimerHandle) => void;
}

/**
 * One-shot watchdog: arm() once per turn, markProductive() on the first
 * productive event (permanently disarms — it never fires again this turn),
 * dispose() in a `finally` so a turn that finishes fast never leaves a
 * dangling timer.
 */
export class TtftWatchdog {
  private readonly timeoutMs: number;
  private readonly onTimeout: () => void;
  private readonly setTimeoutFn: (callback: () => void, ms: number) => TimerHandle;
  private readonly clearTimeoutFn: (handle: TimerHandle) => void;
  private handle: TimerHandle | null = null;
  private satisfied = false;
  private firedFlag = false;

  constructor(opts: TtftWatchdogOptions) {
    this.timeoutMs = opts.timeoutMs;
    this.onTimeout = opts.onTimeout;
    this.setTimeoutFn = opts.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = opts.clearTimeoutFn ?? clearTimeout;
  }

  /** Start the one-shot timer. No-op when already satisfied/fired/disabled. */
  arm(): void {
    if (this.timeoutMs <= 0) return;
    if (this.satisfied || this.firedFlag || this.handle) return;
    this.handle = this.setTimeoutFn(() => {
      this.handle = null;
      if (this.satisfied) return;
      this.firedFlag = true;
      this.onTimeout();
    }, this.timeoutMs);
  }

  /** Call on the turn's first productive event — clears and permanently disarms. */
  markProductive(): void {
    this.satisfied = true;
    if (this.handle) {
      this.clearTimeoutFn(this.handle);
      this.handle = null;
    }
  }

  /**
   * F1 (round-2 review fix): re-schedule after a policy decision NOT to
   * treat this timeout as a failure (still parked on a permission/question,
   * or the available evidence does not yet support blaming transport — see
   * claudeRuntime.ts's onTimeout). Unlike arm(), this bypasses the
   * "already fired" guard so the SAME turn can be checked again on the next
   * window; hasFired is reset to false since onTimeout never actually
   * committed to failing the turn this time.
   */
  rearm(): void {
    if (this.timeoutMs <= 0 || this.satisfied) return;
    this.firedFlag = false;
    if (this.handle) {
      this.clearTimeoutFn(this.handle);
    }
    this.handle = this.setTimeoutFn(() => {
      this.handle = null;
      if (this.satisfied) return;
      this.firedFlag = true;
      this.onTimeout();
    }, this.timeoutMs);
  }

  /**
   * R7 (round-2 iteration-2 review): clear `firedFlag` WITHOUT re-arming a
   * timer — for the case where `onTimeout` already fired but declined to
   * treat it as a failure because the turn is being torn down for an
   * unrelated reason (e.g. an explicit Stop landed in the same tick). The
   * wrapper sets `firedFlag` before calling `onTimeout`; without this, that
   * stale `true` would mislabel a later, genuine stall failure with the
   * TTFT message (`stallErrorMessage()` picks its branch off `hasFired`).
   * Unlike `rearm()`, this does not schedule anything — the turn is already
   * ending, so there is nothing left to watch.
   */
  resetFired(): void {
    this.firedFlag = false;
  }

  /** Clear any pending timer without marking the turn as productive (e.g. turn ended). */
  dispose(): void {
    if (this.handle) {
      this.clearTimeoutFn(this.handle);
      this.handle = null;
    }
  }

  /** Whether onTimeout has already fired this turn. */
  get hasFired(): boolean {
    return this.firedFlag;
  }
}
