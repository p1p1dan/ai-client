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
    /** Manually invoke the most recently scheduled callback, as if it fired. */
    fireLatest: () => {
      const handles = [...scheduled.keys()];
      const handle = handles[handles.length - 1];
      const entry = scheduled.get(handle);
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

  it('rearm() from inside onTimeout reschedules instead of leaving hasFired true (F1 policy re-arm)', () => {
    const timers = makeFakeTimers();
    const onTimeout = vi.fn();
    let wd!: TtftWatchdog;
    wd = new TtftWatchdog({
      timeoutMs: 30_000,
      onTimeout: () => {
        onTimeout();
        wd.rearm();
      },
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    wd.arm();
    timers.fireLatest();

    expect(onTimeout).toHaveBeenCalledTimes(1);
    // The callback declined to treat this as a real failure — hasFired must
    // read false again.
    expect(wd.hasFired).toBe(false);

    // A second window can still fire for real (proves rearm() actually
    // scheduled a fresh timer rather than leaving the watchdog dead).
    timers.fireLatest();
    expect(onTimeout).toHaveBeenCalledTimes(2);
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
