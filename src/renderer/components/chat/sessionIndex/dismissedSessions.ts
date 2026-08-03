/**
 * Run-scoped registry of sessions the user removed from the nav (Close, and
 * Archive's renderer-only fallback). Extracted out of `useSessionIndex.ts` in
 * round-5 so the two consumers that must NOT depend on a React hook module can
 * read it:
 *
 * - `stores/chatSessions.ts` (red-line store) — its `sendMessage` guard would
 *   otherwise close an import cycle `chatSessions → useSessionIndex →
 *   chatSessions`.
 * - `workspace-shell/useSyncChatWorkspaceTree.ts` — must not re-seed a live
 *   session after the user emptied the nav.
 *
 * This module deliberately has no imports at all: it is a leaf, so importing
 * it can never introduce a cycle.
 *
 * Why module-scoped and intentionally not persisted:
 *
 * - Close keeps the index entry untouched (see `closeSessionAndRemoveRow`),
 *   so without this list the very next `refresh()` would re-seed the row
 *   straight back from `session-index.json`.
 * - A reload starts a fresh run: a persisted session reappears by design.
 *   Permanent removal is Archive, which flips the index's `archived` bit.
 */

const dismissedSessionIds = new Set<string>();

/** Record a row the user removed in this run. */
export function markSessionDismissed(sessionId: string): void {
  dismissedSessionIds.add(sessionId);
}

/** Lift a dismissal (un-archive) so the row may return on the next refresh. */
export function undismissSession(sessionId: string): void {
  dismissedSessionIds.delete(sessionId);
}

/** True when this exact session was removed from the nav in this run. */
export function isSessionDismissed(sessionId: string): boolean {
  return dismissedSessionIds.has(sessionId);
}

/**
 * True once ANY row was dismissed in this run. Used as "the user has taken
 * control of the nav" — auto-seeding a session behind their back is only safe
 * before that (see `useSyncChatWorkspaceTree`).
 */
export function hasDismissedSessions(): boolean {
  return dismissedSessionIds.size > 0;
}

/**
 * Drop rows dismissed in this run from a freshly merged session list.
 * Structurally typed (only `id` is read) so the leaf stays import-free.
 * Returns the input array untouched when nothing was dismissed.
 */
export function dropDismissedSessions<T extends { id: string }>(sessions: T[]): T[] {
  if (dismissedSessionIds.size === 0) {
    return sessions;
  }
  return sessions.filter((session) => !dismissedSessionIds.has(session.id));
}

/** Test seam / reload hook — the dismissal list is per app run only. */
export function resetDismissedSessionRows(): void {
  dismissedSessionIds.clear();
}
