/**
 * Issue #11: the managed model catalog was synced exactly once, at startup.
 *
 * `regenerateFromVault()` runs at boot and `PiModelConfigService.sync` answers
 * from its ten-minute cache, so a machine that stays open for a week keeps the
 * list it fetched on day one. Nothing else in the process ever asked again:
 * the renderer's own refresh (`ComposerModelTrigger`'s `onOpenChange`) re-reads
 * the catalog from MAIN, which is the same record, so opening the menu could
 * not repair it either. The only way to see a model an administrator enabled
 * since was the manual 「立即同步」 button, which forces.
 *
 * This mirrors what the update check already does (`services/updater`), for the
 * same reason and with the same shape: a long interval, plus a catch-up on
 * window focus that is rate-limited so alt-tabbing is not a request per second.
 * The two numbers differ from the updater's only because the catalog is the
 * cheaper question and the one that goes stale faster.
 *
 * ## Why this is its own module
 *
 * `main/index.ts` cannot be imported under vitest (module-load-time `electron`
 * side effects — see `managedCredentialsStartup.ts`'s header). This module
 * imports `electron` only for the `BrowserWindow` type, so every decision here
 * — when a focus event earns a sync, when a sync is skipped because the route
 * is off — is testable in the node environment.
 */

import type { BrowserWindow } from 'electron';

/** Every hour. The freshness window below is what keeps this from firing on a sleeping machine. */
export const CATALOG_SYNC_INTERVAL_MS = 60 * 60 * 1000;

/**
 * A focus-triggered sync only counts as news if the last ATTEMPT is older than
 * this. Shorter than the service's own ten-minute freshness window on purpose:
 * that window is about not re-fetching, this one is about not even asking, and
 * an ask that the cache absorbs is still a wasted round trip through IPC.
 */
export const CATALOG_SYNC_FOCUS_MIN_INTERVAL_MS = 15 * 60 * 1000;

export interface CatalogSyncSchedulerOptions {
  /** Runs one sync. `syncManagedPiModels` — non-forced, so the TTL still applies. */
  sync: () => Promise<unknown>;
  /** Logged, never thrown: a failed background sync must not take the app down. */
  onError?: (error: unknown) => void;
  intervalMs?: number;
  focusMinIntervalMs?: number;
  /** Injected so tests do not depend on the wall clock. */
  now?: () => number;
}

/**
 * One scheduler for the whole process, started once from `main/index.ts`.
 *
 * Not tied to a window's lifetime the way the updater is: the catalog belongs
 * to no window, and on Linux/Windows the app outlives every window it opens
 * (closing the last one quits, but `cleanup()` on the way out is enough).
 */
export class CatalogSyncScheduler {
  private intervalId: NodeJS.Timeout | null = null;
  private window: BrowserWindow | null = null;
  private lastAttemptAt = 0;
  private running = false;
  private readonly sync: () => Promise<unknown>;
  private readonly onError: (error: unknown) => void;
  private readonly intervalMs: number;
  private readonly focusMinIntervalMs: number;
  private readonly now: () => number;
  private readonly focus = () => {
    if (this.now() - this.lastAttemptAt < this.focusMinIntervalMs) return;
    void this.run();
  };

  constructor(options: CatalogSyncSchedulerOptions) {
    this.sync = options.sync;
    this.onError =
      options.onError ??
      ((error: unknown) => console.warn('[pi-models] scheduled sync failed:', error));
    this.intervalMs = options.intervalMs ?? CATALOG_SYNC_INTERVAL_MS;
    this.focusMinIntervalMs = options.focusMinIntervalMs ?? CATALOG_SYNC_FOCUS_MIN_INTERVAL_MS;
    this.now = options.now ?? Date.now;
  }

  /**
   * Begins the schedule against `window`.
   *
   * `lastAttemptAt` starts at 0 rather than "now": startup already synced
   * (`regenerateFromVault`), so the first focus event would earn a second
   * fetch — and `sync`'s own ten-minute cache makes that cheap and silent. It
   * is worth it, because "the user came back after lunch" is exactly the
   * moment the list is most likely wrong.
   */
  start(window: BrowserWindow): void {
    if (this.intervalId) return;
    this.window = window;
    window.on('focus', this.focus);
    this.intervalId = setInterval(() => void this.run(), this.intervalMs);
  }

  stop(): void {
    if (this.intervalId) clearInterval(this.intervalId);
    this.intervalId = null;
    this.window?.off('focus', this.focus);
    this.window = null;
  }

  /**
   * One sync, deduplicated and never rejecting.
   *
   * A slow sync that overlaps the next tick must not stack: the second call
   * returns immediately rather than queueing behind the first, because the
   * work is idempotent and the newest result is the one worth having.
   */
  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.lastAttemptAt = this.now();
    try {
      await this.sync();
    } catch (error) {
      this.onError(error);
    } finally {
      this.running = false;
    }
  }
}

export const catalogSyncScheduler = new CatalogSyncScheduler({
  // Imported lazily so this module stays free of the service's own import graph
  // — the scheduler is started at a point in startup where the rest of `Main`
  // is already loading, and a static import would pull `net.fetch` wiring into
  // every test that touches the class.
  sync: async () => {
    const { syncManagedPiModels } = await import('./index');
    return syncManagedPiModels();
  },
});
