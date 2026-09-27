/**
 * Decision 046 rule 2 — the cancel signal for one `runSend` attempt.
 *
 * `runSend`'s generation counter can only be READ between awaits, so a Stop
 * pressed while `ensureHost` / `createSession` / `resumeSession` / `chat.send`
 * was still pending did nothing until that IPC came back — a full worker
 * bootstrap at best, never at worst — and the composer's send latch stayed
 * closed the whole time (evidence H3b). Every handshake await races this
 * signal instead: `cancel()` settles the race at once with `SEND_CANCELLED`,
 * and whatever the IPC resolves or rejects with afterwards is dropped.
 *
 * Pure module (no `window`, no React), so the node-env suite covers it.
 */

export const SEND_CANCELLED: unique symbol = Symbol('send-cancelled');
export type SendCancelled = typeof SEND_CANCELLED;

export interface SendCancellation {
  /** True once `cancel()` has run. Checked by the polling waits between steps. */
  readonly cancelled: boolean;
  /** Idempotent. Wakes every pending `race` with `SEND_CANCELLED`. */
  cancel(): void;
  /**
   * `work`'s own result while not cancelled; `SEND_CANCELLED` the moment
   * `cancel()` runs (or at once if it already has). A rejection BEFORE the
   * cancel propagates as usual; one after it is observed and ignored, so a late
   * IPC failure can neither surface as an unhandled rejection nor run the
   * caller's error handling for an attempt that no longer exists.
   */
  race<T>(work: Promise<T>): Promise<T | SendCancelled>;
}

export function createSendCancellation(): SendCancellation {
  let cancelled = false;
  const waiters = new Set<() => void>();
  return {
    get cancelled() {
      return cancelled;
    },
    cancel() {
      if (cancelled) return;
      cancelled = true;
      for (const wake of [...waiters]) wake();
      waiters.clear();
    },
    race<T>(work: Promise<T>): Promise<T | SendCancelled> {
      return new Promise<T | SendCancelled>((resolve, reject) => {
        const wake = () => resolve(SEND_CANCELLED);
        if (cancelled) wake();
        else waiters.add(wake);
        // Attached unconditionally: settling an already-settled promise is a
        // no-op, which is exactly how a late result is discarded.
        work.then(
          (value) => {
            waiters.delete(wake);
            resolve(value);
          },
          (error: unknown) => {
            waiters.delete(wake);
            reject(error);
          }
        );
      });
    },
  };
}
