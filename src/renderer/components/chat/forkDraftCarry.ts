/**
 * T-27 fix: forking onto a new target must not clear the composer's
 * in-flight attachment drafts — only an actual session *switch away from a
 * fork's source* clears them. This is a plain in-memory flag rather than
 * store state because it only needs to survive the single render tick
 * between `createChatSessionOnWorkspace` (in `useComposerTarget.ts`) and the
 * `activeSessionId`-keyed reset effect in `ChatComposer.tsx` that would
 * otherwise wipe the drafts.
 */

let carrySessionId: string | null = null;

/** Mark that the next session-switch effect for `sessionId` came from a fork. */
export function markForkDraftCarry(sessionId: string): void {
  carrySessionId = sessionId;
}

/**
 * Consume the mark for `sessionId` if it matches: clears the mark and
 * returns true. Returns false — without touching a mark set for a different
 * session — otherwise.
 */
export function consumeForkDraftCarry(sessionId: string): boolean {
  if (carrySessionId !== sessionId) {
    return false;
  }
  carrySessionId = null;
  return true;
}

/** Test-only: reset module state between test cases. */
export function resetForkDraftCarry(): void {
  carrySessionId = null;
}
