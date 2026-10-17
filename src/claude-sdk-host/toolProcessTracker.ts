/**
 * What a running shell tool call has started, sampled in the background (README §11.2 #52).
 *
 * Windows: the CLI's interrupt leaves a Bash call's children running (processTree.ts), so
 * Stop has to know what the call started before it interrupts. Taking that sample in Stop
 * held Stop up for as long as the Windows process query took, and on GitHub's Windows
 * runners that was the whole timeout, every time (runs 39002273416, 39003481072). So the
 * sampling moves here: it starts when a Bash or PowerShell call starts, repeats while the
 * call runs (back to back at first, since the first sample usually predates the shell
 * itself, then every few seconds), and Stop takes the latest sample, waiting only briefly
 * for one in flight. A slow query only ever delays the background.
 */

import type { ProcessRow } from './processTree.ts';

/**
 * Pause after the n-th sample before the next; the last entry repeats. Dense for the first
 * seconds: a command's shell can take seconds to appear on a loaded machine (measured 3.9 s
 * with the test suite running beside it), and until a sample has seen that shell, Stop has
 * nothing to look up in Git Bash's table. A sample costs about 0.4 s of PowerShell.
 */
export const TRACK_GAPS_MS: readonly number[] = [
  0, 0, 500, 500, 1_000, 1_000, 1_000, 1_000, 2_000, 3_000,
];

/** One sample: the rows of the call, or undefined when the sample itself failed. */
export type CollectToolProcesses = () => Promise<ProcessRow[] | undefined>;

export class ToolProcessTracker {
  private readonly collect: CollectToolProcesses;
  private readonly gapsMs: readonly number[];
  private rows: ProcessRow[] = [];
  private inFlight: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private tracking = false;
  private samples = 0;

  constructor(collect: CollectToolProcesses, gapsMs: readonly number[] = TRACK_GAPS_MS) {
    this.collect = collect;
    this.gapsMs = gapsMs;
  }

  get active(): boolean {
    return this.tracking;
  }

  /** Starts sampling now; a tracker already running keeps its schedule. */
  start(): void {
    if (this.tracking) return;
    this.tracking = true;
    this.samples = 0;
    if (!this.inFlight) this.sample();
  }

  /** Ends sampling and forgets the rows: the call is over, nothing of it is left to reap. */
  stop(): void {
    this.tracking = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.rows = [];
  }

  /**
   * The latest successful sample. One in flight is waited for at most `waitMs`, so a
   * call that started just before Stop is still seen; a sample is never started here.
   */
  async latest(waitMs: number): Promise<ProcessRow[]> {
    if (this.inFlight && waitMs > 0) {
      await Promise.race([this.inFlight, new Promise((resolve) => setTimeout(resolve, waitMs))]);
    }
    return this.rows;
  }

  private sample(): void {
    this.inFlight = this.collect()
      .then(
        (rows) => {
          // A failed sample keeps the previous rows: stale rows are harmless to `reap`
          // (it checks each one is still the same process), missing rows are a leak.
          if (rows && this.tracking) this.rows = rows;
        },
        () => {}
      )
      .finally(() => {
        this.inFlight = null;
        this.samples += 1;
        if (!this.tracking) return;
        const gap = this.gapsMs[Math.min(this.samples - 1, this.gapsMs.length - 1)] ?? 0;
        this.timer = setTimeout(() => {
          this.timer = null;
          this.sample();
        }, gap);
      });
  }
}
