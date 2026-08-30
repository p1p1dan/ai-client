/**
 * Run-scoped tombstones for sessions removed by workspace-tree synchronization.
 * A late Host event may arrive after the renderer pruned the row; adjacent
 * stores consult this leaf registry so that frame cannot recreate hidden state.
 */
const retiredSessionIds = new Set<string>();

export function markSessionsRetired(sessionIds: readonly string[]): void {
  for (const sessionId of sessionIds) retiredSessionIds.add(sessionId);
}

export function markSessionsLive(sessionIds: readonly string[]): void {
  for (const sessionId of sessionIds) retiredSessionIds.delete(sessionId);
}

export function isSessionRetired(sessionId: string | null | undefined): boolean {
  return sessionId != null && retiredSessionIds.has(sessionId);
}

export function resetSessionRetirementForTests(): void {
  retiredSessionIds.clear();
}
