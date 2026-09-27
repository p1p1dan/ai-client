/**
 * Decision 046 rule 3 — "this conversation was ended", told to the composer.
 *
 * `endSessionRuntime` runs outside React, but part of what ending has to reset
 * lives inside `ChatComposer`: its send latch (an in-flight handshake for the
 * ended session), its stop latch, and its pending-reply watch. Those are
 * component-local refs, so the store cannot reach them; this one-way signal can.
 * The composer subscribes for its lifetime and resets only what belongs to the
 * named session.
 *
 * Pure module (no `window`, no React), so the node-env suite covers it.
 */

export type SessionEndedListener = (sessionId: string) => void;

const listeners = new Set<SessionEndedListener>();

/** Notify every subscriber that `sessionId`'s conversation was ended. */
export function announceSessionEnded(sessionId: string): void {
  // Snapshot: a listener may unsubscribe while being notified.
  for (const listener of [...listeners]) {
    try {
      listener(sessionId);
    } catch (err) {
      // One faulty subscriber must not keep the rest from resetting.
      console.error('[sessionEndSignal] listener threw', err);
    }
  }
}

/** Subscribe; returns an idempotent unsubscribe. */
export function onSessionEnded(listener: SessionEndedListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
