import { describe, expect, it, vi } from 'vitest';
import { TtftWatchdog } from '../ttftWatchdog.ts';

/** Fake timer harness: captures the scheduled callback instead of waiting. */
function makeFakeTimers() {
  let nextHandle = 1;
  const scheduled = new Map<number, { callback: () => void; ms: number }>();
  const cleared: number[] = [];
  return {
    setTimeoutFn: (callback: () => void, ms: number) => {
      const handle = nextHandle;
      nextHandle += 1;
      scheduled.set(handle, { callback, ms });
      return handle as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeoutFn: (handle: ReturnType<typeof setTimeout>) => {
      cleared.push(handle as unknown as number);
      scheduled.delete(handle as unknown as number);
    },
    /** Manually invoke the most recently scheduled callback, as if it fired.
     * The entry is removed FIRST: a one-shot timer is no longer scheduled by
     * the time its callback runs, so `scheduledCount()` stays a faithful
     * "timers still on the clock" reading across a fire. */
    fireLatest: () => {
      const handles = [...scheduled.keys()];
      const handle = handles[handles.length - 1];
      const entry = scheduled.get(handle);
      scheduled.delete(handle);
      entry?.callback();
    },
    scheduledCount: () => scheduled.size,
    clearedCount: () => cleared.length,
  };
}

describe('TtftWatchdog', () => {
  it('fires onTimeout once when armed and never marked productive', () => {
    const timers = makeFakeTimers();
    const onTimeout = vi.fn();
    const wd = new TtftWatchdog({
      timeoutMs: 30_000,
      onTimeout,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    wd.arm();
    expect(timers.scheduledCount()).toBe(1);
    timers.fireLatest();

    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(wd.hasFired).toBe(true);
  });

  it('markProductive before the timer fires clears it and suppresses onTimeout', () => {
    const timers = makeFakeTimers();
    const onTimeout = vi.fn();
    const wd = new TtftWatchdog({
      timeoutMs: 30_000,
      onTimeout,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    wd.arm();
    wd.markProductive();
    expect(timers.clearedCount()).toBe(1);

    // Even if the underlying timer somehow still invoked the callback (real
    // setTimeout would not, since it was cleared) the satisfied flag guards it.
    timers.fireLatest();
    expect(onTimeout).not.toHaveBeenCalled();
    expect(wd.hasFired).toBe(false);
  });

  it('dispose() clears a pending timer without firing onTimeout', () => {
    const timers = makeFakeTimers();
    const onTimeout = vi.fn();
    const wd = new TtftWatchdog({
      timeoutMs: 30_000,
      onTimeout,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    wd.arm();
    wd.dispose();
    expect(timers.clearedCount()).toBe(1);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('timeoutMs <= 0 disables the watchdog — arm() never schedules a timer', () => {
    const timers = makeFakeTimers();
    const onTimeout = vi.fn();
    const wd = new TtftWatchdog({
      timeoutMs: 0,
      onTimeout,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    wd.arm();
    expect(timers.scheduledCount()).toBe(0);

    const negative = new TtftWatchdog({
      timeoutMs: -5,
      onTimeout,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    negative.arm();
    expect(timers.scheduledCount()).toBe(0);
  });

  it('arm() is idempotent — calling it twice does not schedule a second timer', () => {
    const timers = makeFakeTimers();
    const wd = new TtftWatchdog({
      timeoutMs: 30_000,
      onTimeout: () => undefined,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    wd.arm();
    wd.arm();
    expect(timers.scheduledCount()).toBe(1);
  });

  it('rearm() schedules a fresh window and clears hasFired (MECHANISM only)', () => {
    // F2 (2026-08-18) §12.1: the POLICY of when a timeout may re-arm — parked
    // on a prompt, or the one allowed second window for a totally silent spawn
    // — belongs to claudeRuntime's onTimeout and is asserted there
    // (claudeRuntimeOptions.test.ts [E-2] / [E-4] / the two-window case). This
    // class only owes the mechanism: rearm() bypasses the "already fired"
    // guard, resets hasFired, and puts a new timer on the clock.
    const timers = makeFakeTimers();
    const onTimeout = vi.fn();
    const wd = new TtftWatchdog({
      timeoutMs: 30_000,
      onTimeout,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    wd.arm();
    timers.fireLatest();
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(wd.hasFired).toBe(true);

    wd.rearm();
    // The caller declined to treat that window as a real failure — hasFired
    // must read false again, and a fresh timer must be on the clock.
    expect(wd.hasFired).toBe(false);
    expect(timers.scheduledCount()).toBe(1);

    timers.fireLatest();
    expect(onTimeout).toHaveBeenCalledTimes(2);
  });

  it('[TW-1] markDegraded() clears the pending timer, resets hasFired, and permanently disarms', () => {
    // F2 §3.2 + new finding 4: the TTFT phase ended with no evidence of
    // failure. The table closes for good (only the rolling stall watchdog
    // observes from here) AND firedFlag clears, so that a LATER 195s stall
    // failure is reported with the stall wording instead of the TTFT one
    // (stallErrorMessage() picks its branch off hasFired).
    const timers = makeFakeTimers();
    const onTimeout = vi.fn();
    const wd = new TtftWatchdog({
      timeoutMs: 30_000,
      onTimeout,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    wd.arm();
    expect(timers.scheduledCount()).toBe(1);

    wd.markDegraded();

    // (1) the stale `true` that would mislabel a later stall failure is gone
    expect(wd.hasFired).toBe(false);
    // (3) the injected clear ran exactly once
    expect(timers.clearedCount()).toBe(1);
    expect(timers.scheduledCount()).toBe(0);

    // (2) arm() and rearm() are both no-ops from here — permanently disarmed
    wd.arm();
    wd.rearm();
    expect(timers.scheduledCount()).toBe(0);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('[TW-1b] markDegraded() called from inside a fired onTimeout leaves hasFired false and schedules nothing', () => {
    // The real call sequence: the wrapper sets firedFlag BEFORE invoking
    // onTimeout (ttftWatchdog.ts:62/:94) and has already nulled the handle, so
    // markDegraded's job here is purely the flag + the permanent close.
    const timers = makeFakeTimers();
    const onTimeout = vi.fn();
    let wd!: TtftWatchdog;
    wd = new TtftWatchdog({
      timeoutMs: 30_000,
      onTimeout: () => {
        onTimeout();
        wd.markDegraded();
      },
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    wd.arm();
    timers.fireLatest();

    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(wd.hasFired).toBe(false);
    expect(timers.scheduledCount()).toBe(0);

    wd.rearm();
    wd.arm();
    expect(timers.scheduledCount()).toBe(0);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('rearm() is a no-op once markProductive() has satisfied the watchdog', () => {
    const timers = makeFakeTimers();
    const onTimeout = vi.fn();
    const wd = new TtftWatchdog({
      timeoutMs: 30_000,
      onTimeout,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    wd.arm();
    wd.markProductive();
    wd.rearm();
    expect(timers.scheduledCount()).toBe(0);
  });

  it('defaults to the real global setTimeout/clearTimeout when no test seam is given', async () => {
    let fired = false;
    const wd = new TtftWatchdog({
      timeoutMs: 5,
      onTimeout: () => {
        fired = true;
      },
    });
    wd.arm();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fired).toBe(true);
  });
});
