import { describe, expect, it, vi } from 'vitest';
import type { ProcessRow } from '../processTree.ts';
import { ToolProcessTracker } from '../toolProcessTracker.ts';

// Nothing here samples or signals a real process: every collector is a stub and every
// pid is made up (engineering standard, appendix B1).

const T0 = 1_792_000_000_000;

function row(pid: number, name: string): ProcessRow {
  return { pid, ppid: 4000, start: T0, name };
}

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('ToolProcessTracker', () => {
  it('samples as soon as a shell call starts, then again on its schedule', async () => {
    const samples: ProcessRow[][] = [
      [],
      [row(4101, 'bash.exe')],
      [row(4101, 'bash.exe'), row(4102, 'sleep.exe')],
    ];
    const collect = vi.fn(async () => samples[Math.min(collect.mock.calls.length - 1, 2)]);
    const tracker = new ToolProcessTracker(collect, [0, 0, 1_000]);
    tracker.start();
    expect(collect).toHaveBeenCalledTimes(1);
    // The first sample usually predates the shell: the next two follow back to back,
    // the fourth only after the long gap.
    await tick(100);
    expect(collect).toHaveBeenCalledTimes(3);
    expect(await tracker.latest(0)).toEqual(samples[2]);
    tracker.stop();
  });

  it('a sample in flight at Stop is waited for, but only up to the bound', async () => {
    let release: (rows: ProcessRow[]) => void = () => {};
    const collect = vi.fn(
      () =>
        new Promise<ProcessRow[]>((resolve) => {
          release = resolve;
        })
    );
    const tracker = new ToolProcessTracker(collect, [0]);
    tracker.start();
    // Waiting for a sample that stays out: Stop is not held past the bound.
    const started = Date.now();
    expect(await tracker.latest(30)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(500);
    // A sample that lands within the bound is used.
    const waited = tracker.latest(1_000);
    release([row(4201, 'bash.exe')]);
    expect(await waited).toEqual([row(4201, 'bash.exe')]);
    tracker.stop();
  });

  it('keeps the previous rows when a sample fails, and forgets them when the call ends', async () => {
    const answers: Array<ProcessRow[] | undefined> = [[row(4301, 'bash.exe')], undefined];
    const collect = vi.fn(async () => answers[Math.min(collect.mock.calls.length - 1, 1)]);
    const tracker = new ToolProcessTracker(collect, [0, 1_000]);
    tracker.start();
    await tick(5);
    expect(collect).toHaveBeenCalledTimes(2);
    expect(await tracker.latest(0)).toEqual([row(4301, 'bash.exe')]);
    tracker.stop();
    expect(await tracker.latest(0)).toEqual([]);
    expect(tracker.active).toBe(false);
    // No sample is scheduled after stop.
    await tick(10);
    expect(collect).toHaveBeenCalledTimes(2);
  });

  it('a second start while a call is already tracked changes nothing', async () => {
    const collect = vi.fn(async () => [row(4401, 'bash.exe')]);
    const tracker = new ToolProcessTracker(collect, [1_000]);
    tracker.start();
    tracker.start();
    await tick(5);
    expect(collect).toHaveBeenCalledTimes(1);
    expect(tracker.active).toBe(true);
    tracker.stop();
  });
});
