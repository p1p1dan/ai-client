/**
 * Who drives a chat call: a window, or (issue #25) a remote client that is not
 * a window at all. The chat handlers need two things from either — an owner id
 * to claim sessions under, and a signal when that owner goes away so its
 * claims are released.
 */
export interface ChatCaller {
  /**
   * Owner id for `WorkerManager` claims. A window uses its webContents id
   * (positive); a remote caller takes one from `allocateRemoteOwnerId`
   * (negative), so the two never collide. Absent when the caller cannot be
   * identified, which claims nothing.
   */
  readonly ownerId: number | undefined;
  /** Runs `listener` once when the caller is gone; absent when it cannot tell. */
  readonly onGone?: (listener: () => void) => void;
}

let lastRemoteOwnerId = 0;

/** A fresh owner id for a remote caller, never reused within this process. */
export function allocateRemoteOwnerId(): number {
  lastRemoteOwnerId -= 1;
  return lastRemoteOwnerId;
}
