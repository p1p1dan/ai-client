import { resolveAgentWireName } from '@shared/types/agentWire';
import type { SessionIndexEntry } from '@shared/types/sessionIndex';
import { canonicalPathKey } from '@shared/utils/path';
import { workspacePathMatchRank } from '@/components/chat/composerTarget';
import type { ChatSession, ChatWorkspace } from '@/stores/chatSessions';
import { fallbackSessionTitle } from './sessionTitle';

/**
 * Team-side merge of persisted SessionIndex into the live session list (T-02).
 *
 * Why a pure function: the red-line `chatSessions` store stays untouched. The
 * team track keeps a single shape — `ChatSession[]` — so this reducer joins
 * Main-side `SessionIndexEntry[]` (persisted across restarts) with whatever
 * the running UI already shows (live status, host-bound flag, runtime id).
 *
 * Merge rules:
 * - Match by sessionId.
 * - Persisted entry never overwrites UI-side runtime fields (status,
 *   runtimeIdentity once Host has bound a fresh one) — those are live and
 *   authoritative during a turn. Persisted `runtimeIdentity` is a fallback
 *   used only when the UI sentence has no runtime identity yet.
 * - Persisted title wins over UI title *when non-empty* (the user may have
 *   renamed it; the UI seed value is a placeholder). `recordCreated` persists
 *   an empty title until an explicit rename, so an empty persisted value must
 *   never clobber the UI seed — otherwise every row renders blank after a
 *   restart and the LeftNav title search matches nothing.
 * - Persisted updatedAt is taken as max(prev, entry.updatedAt) so the recent
 *   ordering hint stays monotonic.
 * - New entries (persisted, no live sentence) seed as `idle` with status
 *   disconnected only when explicitly requested (resume flow will flip it).
 * - Archived entries are filtered out of the live list entirely (they live
 *   only in the persisted index and can be un-archived later).
 * - S2 (b): this is the ONE place a persisted `agent` is read into a live row.
 *   Only an explicit `pi` slug survives; a missing binding predates the field
 *   (it meant Claude back then) and an unknown one was written by a newer
 *   build, so both are hidden rather than guessed into Pi execution. Main
 *   agrees — `assertPiCompatibleIndexRow` refuses to start the same rows — so
 *   showing them would only offer the user a chat that cannot run. The disk
 *   side stays exactly as written: normalizing on load would put a default
 *   into Main's in-memory map, and `flush()` writes the whole map, so the next
 *   unrelated rename would stamp `agent` onto every legacy row — a compatible
 *   read turned into an irreversible write migration. Coverage lives in
 *   `agentBindingMerge.test.ts`.
 */

/**
 * Last-resort display title for a persisted entry that has no title and no UI
 * sentence to fall back to. Short id suffix keeps rows distinguishable so the
 * user can locate one and rename it.
 *
 * R4 fix: moved into `sessionTitle.ts` (the single source shared with its
 * recognizer counterpart, `isPlaceholderTitle`) — re-exported here as a thin
 * forward so existing imports of `fallbackSessionTitle` from this module
 * keep working unchanged.
 */
export { fallbackSessionTitle };

export interface MergeResult {
  sessions: ChatSession[];
  /** Sessions the live list had but the persisted index dropped — stale UI. */
  orphaned: ChatSession[];
}

export function mergeSessionIndex(
  prevSessions: ChatSession[],
  entries: SessionIndexEntry[],
  options: {
    workspaces: ChatWorkspace[];
    /** Initial status for sessions not yet live-bound (default 'idle'). */
    seedStatus?: ChatSession['status'];
  }
): MergeResult {
  const seedStatus = options.seedStatus ?? 'idle';
  const byId = new Map(prevSessions.map((session) => [session.id, session] as const));
  // Round-6 review M3: key by canonical path (raw keys missed `/aaa/` vs
  // `/aaa` and case drift) and prefer the registered-folder identity when one
  // directory backs two workspaces (D2's parent `worktree` entry + own
  // `main`) — the previous last-write-wins Map made a persisted session's
  // folder flip with repository registration order across restarts. The real
  // fix is persisting workspaceId in the index (backlog), not just path.
  const workspacesByPath = new Map<string, ChatWorkspace>();
  for (const ws of options.workspaces) {
    const key = canonicalPathKey(ws.path);
    const existing = workspacesByPath.get(key);
    if (!existing || workspacePathMatchRank(ws.kind) < workspacePathMatchRank(existing.kind)) {
      workspacesByPath.set(key, ws);
    }
  }

  const next: ChatSession[] = [];
  const seenIds = new Set<string>();
  const orphans: ChatSession[] = [];

  for (const entry of entries) {
    if (entry.archived) {
      // Archived entries stay in the index only — drop the live mirror too.
      // The user explicitly archived; the nav must not show it again unless
      // un-archived.
      seenIds.add(entry.sessionId);
      continue;
    }
    // A persisted runtime outside this build's Pi-only vocabulary is hidden.
    // Explicit Claude/Codex rows must not survive through the live-only tail
    // pass, where they could otherwise be treated as a fresh Pi session.
    const agent = resolveAgentWireName(entry.agent);
    if (!agent) {
      if (entry.agent === 'claude-code' || entry.agent === 'codex') {
        seenIds.add(entry.sessionId);
      }
      continue;
    }
    const existing = byId.get(entry.sessionId);
    const workspace = workspacesByPath.get(canonicalPathKey(entry.workspacePath));
    const projectId = existing?.projectId ?? workspace?.projectId ?? '';
    const workspaceId = existing?.workspaceId ?? workspace?.id ?? '';

    if (existing) {
      seenIds.add(existing.id);
      next.push({
        ...existing,
        // Persisted title is authoritative only when non-empty; an unnamed
        // persisted entry must not blank out the UI seed title.
        title: entry.title || existing.title || fallbackSessionTitle(entry.sessionId),
        projectId: projectId || existing.projectId,
        workspaceId: workspaceId || existing.workspaceId,
        runtimeIdentity: existing.runtimeIdentity ?? entry.runtimeIdentity,
        // A binding already on the live row wins: it came from the runtime's
        // own `session.created` echo this run, which is the only report of
        // what is actually running. The persisted value is the fallback.
        agent: existing.agent ?? agent,
        updatedAt:
          typeof entry.updatedAt === 'number' && entry.updatedAt > existing.updatedAt
            ? entry.updatedAt
            : existing.updatedAt,
      });
      continue;
    }

    if (!workspaceId) {
      // No workspace context to host this session — skip but also stash as
      // orphaned so the caller can decide (e.g. drop, or surface a warning).
      orphans.push({
        id: entry.sessionId,
        projectId,
        workspaceId,
        title: entry.title || fallbackSessionTitle(entry.sessionId),
        status: seedStatus,
        updatedAt: entry.updatedAt,
        runtimeIdentity: entry.runtimeIdentity,
        agent,
      });
      continue;
    }

    next.push({
      id: entry.sessionId,
      projectId,
      workspaceId,
      title: entry.title || fallbackSessionTitle(entry.sessionId),
      status: seedStatus,
      updatedAt: entry.updatedAt,
      runtimeIdentity: entry.runtimeIdentity,
      agent,
    });
  }

  // Safety net for live-only sessions (created in this app run, not yet
  // persisted): keep them so a fresh "New" session cannot vanish between
  // index refreshes. A never-sent chat has no index entry at all (R5 round-2
  // reverted the eager `chat:registerSession` on create), so this branch is
  // the ONLY thing keeping such a row visible until its first send.
  //
  // It does not block removal: Archive/Close drop the session from
  // `prevSessions` before the next refresh, and the run-scoped dismissal list
  // (`dismissedSessions.ts`) is applied on top, so a row the user removed is
  // never resurrected here.
  for (const session of prevSessions) {
    if (seenIds.has(session.id)) continue;
    next.push(session);
  }

  return { sessions: next, orphaned: orphans };
}

/**
 * Sessions to show under Recent — updatedAt desc, archived excluded. Returns
 * ids so callers map back to whatever live sessions exist after merge.
 */
export function recentSessionIdsFromIndex(sessions: ChatSession[], limit = 20): string[] {
  return [...sessions]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit)
    .map((session) => session.id);
}
