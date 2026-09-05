/**
 * D08 (U15-c): pure model for the center column's session tabs.
 *
 * "Open" is a THIRD piece of session state, distinct from the two the
 * `chatSessions` store already holds:
 *
 *   sessions[]        — every session this profile knows about (the left dock's list)
 *   activeSessionId   — the one being looked at
 *   openSessionIds    — the ones started in this window, one tab each   ← here
 *
 * The dependency between them is deliberately ONE-WAY: whatever becomes active
 * must be open, but closing a tab says nothing about the session. That is what
 * lets every existing `selectSession(...)` call site (new chat, resume, dock
 * click, fork) open a tab without being touched — see `ensureOpen`.
 *
 * Pure so vitest (node env, `.ts` only) can cover it — `sidebarTree.ts` pattern.
 */

export interface SessionTabInput {
  id: string;
  title: string;
  /** Runtime status; only used to decide the "running" dot. */
  busy: boolean;
  /** No bound folder — the tab carries the same marker the dock row does. */
  unbound: boolean;
}

export interface SessionTab extends SessionTabInput {
  active: boolean;
}

/**
 * Appends `sessionId` if it is not already open. Returns the SAME array when
 * nothing changes so a `set` from this can be a no-op for React.
 *
 * Appends rather than inserts: a tab strip that reorders itself when you click
 * around is the thing every editor learned not to do.
 */
export function ensureOpen(open: readonly string[], sessionId: string | null): readonly string[] {
  if (!sessionId || open.includes(sessionId)) {
    return open;
  }
  return [...open, sessionId];
}

/** Removes one id. Returns the same array when it was not open. */
export function closeTab(open: readonly string[], sessionId: string): readonly string[] {
  if (!open.includes(sessionId)) {
    return open;
  }
  return open.filter((id) => id !== sessionId);
}

/**
 * Which session to look at after closing `sessionId`.
 *
 * Neighbour-first (the tab to the right, then the one to the left), matching
 * every editor's tab behaviour. `null` means nothing is left open — the caller
 * shows the welcome state rather than resurrecting an arbitrary session.
 *
 * Only recomputes when the CLOSED tab was the active one; closing a background
 * tab must not move the user.
 */
export function resolveNextActiveSession(
  open: readonly string[],
  sessionId: string,
  activeSessionId: string | null
): string | null {
  if (activeSessionId !== sessionId) {
    return activeSessionId;
  }
  const index = open.indexOf(sessionId);
  if (index < 0) {
    return activeSessionId;
  }
  const remaining = open.filter((id) => id !== sessionId);
  if (remaining.length === 0) {
    return null;
  }
  // `index` still addresses the tab that was to the RIGHT once the closed one
  // is removed; clamping picks the left neighbour when it was the last tab.
  return remaining[Math.min(index, remaining.length - 1)] ?? null;
}

/**
 * Drops ids whose session no longer exists.
 *
 * Load-bearing, not hygiene: archiving or closing a session removes it from
 * `sessions` while its tab id stays in this list, and a tab whose session
 * cannot be resolved renders as an untitled ghost that cannot be selected.
 */
export function pruneClosedSessions(
  open: readonly string[],
  knownSessionIds: readonly string[]
): readonly string[] {
  const known = new Set(knownSessionIds);
  const kept = open.filter((id) => known.has(id));
  return kept.length === open.length ? open : kept;
}

/**
 * The rendered strip: one entry per open id, in open order, stamped with
 * `active`. Ids with no matching session are skipped (see `pruneClosedSessions`
 * — this is the render-time half of the same guarantee, so a strip can never
 * show a tab the store has not pruned yet).
 */
export function deriveSessionTabs(
  open: readonly string[],
  sessions: readonly SessionTabInput[],
  activeSessionId: string | null
): SessionTab[] {
  const byId = new Map(sessions.map((session) => [session.id, session] as const));
  const tabs: SessionTab[] = [];
  for (const id of open) {
    const session = byId.get(id);
    if (!session) {
      continue;
    }
    tabs.push({ ...session, active: session.id === activeSessionId });
  }
  return tabs;
}
