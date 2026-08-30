import { type AgentWireName, sessionAgent } from '@shared/types/agentWire';
import type { SessionIndexEntry } from '@shared/types/sessionIndex';
import { useCallback, useEffect, useState } from 'react';
import { type ChatSession, type ChatWorkspace, useChatSessionsStore } from '@/stores/chatSessions';
import { markSessionsLive, markSessionsRetired } from '@/stores/sessionRetirement';
import { dropDismissedSessions, markSessionDismissed, undismissSession } from './dismissedSessions';
import { mergeSessionIndex, recentSessionIdsFromIndex } from './sessionIndexMerge';

/**
 * Team-side hydrator wiring the Main-side SessionIndex (C-07) into the live
 * chat session list (T-02). Mount reads `chat.listSessions`, folds entries
 * into the red-line store's `sessions` (preserving live runtime fields),
 * refreshes `recentSessionIds`, and exposes `refresh` for callers to re-run
 * after close / rename / archive mutations.
 *
 * Does NOT touch chatSessions.ts — writes via the store's setState bridge.
 */

export interface UseSessionIndexResult {
  /** Imperatively re-read the index (after a mutation lands). */
  refresh: () => Promise<void>;
  /** True while the initial hydration is in flight. */
  loading: boolean;
  /** Last index error message (null when healthy). */
  error: string | null;
}

/** Store slice `applySessionIndexRefresh` reads. */
export interface SessionIndexRefreshInput {
  sessions: ChatSession[];
  workspaces: ChatWorkspace[];
}

/** Store patch `applySessionIndexRefresh` produces. */
export interface SessionIndexRefreshPatch {
  sessions: ChatSession[];
  recentSessionIds: string[];
}

/**
 * The whole body of a refresh as a pure function: merge the persisted index
 * over the live list, drop the rows the user removed in this run, and re-derive
 * the Recent order.
 *
 * Extracted (same split as `archiveSessionIndexEntry` / `renameSessionIndexEntry`)
 * because the dismissal step is the load-bearing one — without it the very next
 * refresh resurrects every closed row, and inside a hook body vitest (node env,
 * `.ts` only) could not reach it. `useSessionIndex` below is now a thin shell
 * around this call.
 */
export function applySessionIndexRefresh(
  entries: SessionIndexEntry[],
  state: SessionIndexRefreshInput
): SessionIndexRefreshPatch {
  const merged = mergeSessionIndex(state.sessions, entries, {
    workspaces: state.workspaces,
    seedStatus: 'idle',
  });
  // Rows the user removed in this run must not be resurrected by the very
  // next refresh (Close leaves the index entry in place on purpose).
  const sessions = dropDismissedSessions(merged.sessions);
  return { sessions, recentSessionIds: recentSessionIdsFromIndex(sessions, 20) };
}

export function useSessionIndex(): UseSessionIndexResult {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const entries = await window.electronAPI.chat.listSessions();
      useChatSessionsStore.setState(
        applySessionIndexRefresh(entries, useChatSessionsStore.getState())
      );
    } catch (err) {
      // Persisting/listing is best-effort: never block the UI when the index
      // is unavailable. Surface the message so T-09 diagnostics can show it.
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Defer to mount so the LeftNav / tree hooks hydrate first (workspaces
    // must be available for path→workspaceId mapping). A microtask is enough.
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      void refresh();
    });
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  return { refresh, loading, error };
}

/**
 * The rename action/IPC itself, extracted from `useSessionIndexMutations` so
 * non-hook callers (T-27 round-3's first-message auto-title wiring in
 * `stores/chatSessionActions.ts`) can reuse the exact same call instead of
 * opening a second path to `window.electronAPI.chat.renameSession`.
 * `onRenamed` runs only after the IPC confirms success — the manual
 * LeftNav rename flow passes its `refresh()` (full session-index refetch);
 * other callers may pass a cheaper targeted store update instead.
 */
export async function renameSessionIndexEntry(
  sessionId: string,
  title: string,
  onRenamed: () => Promise<void>
): Promise<boolean> {
  try {
    const ok = await window.electronAPI.chat.renameSession({ sessionId, title });
    if (ok) await onRenamed();
    return ok;
  } catch {
    return false;
  }
}

/**
 * R5 D2 — index-only session registration (`chat:registerSession`). Records
 * the session in `session-index.json` without starting the Agent Host, so a
 * brand-new chat can be renamed/archived before its first message.
 *
 * Never throws and never rejects: indexing is best-effort, and the lazy
 * `chat.createSession` on first send stays as the fallback (`recordCreated`
 * upserts, so both orders converge on one entry).
 *
 * S2 (b): this is the ONE write path that reaches the index BEFORE the Host
 * ever runs, so the binding has to travel with it. Without it, archiving a
 * never-sent session writes a row with no `agent`, and the next
 * `mergeSessionIndex` materializes that row as Claude Code — silently
 * rewriting a binding that is supposed to be fixed for the session's life.
 * Read here rather than taken as an argument so no future caller can omit it.
 */
export async function registerSessionIndexEntry(
  sessionId: string,
  workspacePath: string
): Promise<boolean> {
  if (!workspacePath) {
    // An empty-path seed workspace has no cwd to record — the Composer
    // refuses to send against it anyway.
    return false;
  }
  const chat = typeof window === 'undefined' ? undefined : window.electronAPI?.chat;
  if (!chat?.registerSession) {
    return false;
  }
  try {
    const agent = agentForSession(sessionId);
    return await chat.registerSession({
      sessionId,
      workspacePath,
      // Omitted, never sent as `undefined`: `recordCreated` reads
      // `input.agent ?? existing?.agent`, so leaving the key out preserves
      // whatever the row already has instead of proposing a value.
      ...(agent ? { agent } : {}),
    });
  } catch {
    return false;
  }
}

/**
 * The run-scoped dismissal registry now lives in the import-free leaf module
 * `dismissedSessions.ts` (the red-line store and the tree-sync hook need it
 * without importing this hook module). Re-exported here so existing callers
 * and tests keep their import path.
 */
export {
  dropDismissedSessions,
  hasDismissedSessions,
  isSessionDismissed,
  markSessionDismissed,
  resetDismissedSessionRows,
  undismissSession,
} from './dismissedSessions';

/**
 * The agent a LIVE row is bound to, for the index writes that happen before
 * any Host event could report it.
 *
 * `undefined` when the row is gone from the store: the caller then omits the
 * key entirely, and `recordCreated` keeps the persisted value. Guessing here
 * would be the very overwrite this function exists to prevent.
 */
function agentForSession(sessionId: string): AgentWireName | undefined {
  const session = useChatSessionsStore.getState().sessions.find((item) => item.id === sessionId);
  return session ? sessionAgent(session) : undefined;
}

function workspacePathForSession(sessionId: string): string | null {
  const state = useChatSessionsStore.getState();
  const session = state.sessions.find((item) => item.id === sessionId);
  if (!session) {
    return null;
  }
  return state.workspaces.find((ws) => ws.id === session.workspaceId)?.path ?? null;
}

/**
 * True when the session exists ONLY in the renderer: the Agent Host has never
 * bound it and it carries no persisted runtime identity. Same criterion as
 * `computeEverHostBound` in `useComposerTarget.ts`. Read fresh off the store
 * at the decision point (never from a snapshot taken before an await) — that
 * is what makes it a TOCTOU guard rather than a stale hint.
 */
function isLiveOnlySession(sessionId: string): boolean {
  const state = useChatSessionsStore.getState();
  if (state.hostBoundSessionIds.includes(sessionId)) {
    return false;
  }
  const session = state.sessions.find((item) => item.id === sessionId);
  return session != null && session.runtimeIdentity == null;
}

function isHostBound(sessionId: string): boolean {
  return useChatSessionsStore.getState().hostBoundSessionIds.includes(sessionId);
}

/** Detach a runtime session without waiting on (or caring about) the result. */
function detachRuntime(sessionId: string): void {
  try {
    void Promise.resolve(window.electronAPI.chat.closeSession({ sessionId })).catch(() => {});
  } catch {
    // Host not running / channel unavailable — nothing to detach.
  }
}

/**
 * Remove a session row from the live store. Renderer-only surgery via the
 * external-setState bridge (the red-line `chatSessions.ts` stays untouched),
 * mirroring `touchLiveUpdatedAt` below.
 *
 * Hands `activeSessionId` over to the adjacent row — the one that slides into
 * the removed row's slot, else the previous row — and falls back to `null`,
 * which is the Composer's empty state (`composerBarClass('empty')`), when the
 * list is now empty. Per-session leftovers (timeline, host binding, parked
 * permission/question, history error) are dropped with the row so nothing
 * keeps pointing at a session the user can no longer reach.
 */
function removeSessionRow(sessionId: string): void {
  const state = useChatSessionsStore.getState();
  const index = state.sessions.findIndex((item) => item.id === sessionId);
  if (index < 0) {
    return;
  }

  markSessionsRetired([sessionId]);
  const sessions = state.sessions.filter((item) => item.id !== sessionId);
  const neighbour = sessions[index] ?? sessions[index - 1];
  const messages = { ...state.messages };
  delete messages[sessionId];
  const historyErrors = { ...state.historyErrors };
  delete historyErrors[sessionId];

  useChatSessionsStore.setState({
    sessions,
    activeSessionId:
      state.activeSessionId === sessionId ? (neighbour?.id ?? null) : state.activeSessionId,
    recentSessionIds: state.recentSessionIds.filter((id) => id !== sessionId),
    hostBoundSessionIds: state.hostBoundSessionIds.filter((id) => id !== sessionId),
    messages,
    historyErrors,
    pendingPermissions: state.pendingPermissions.filter((item) => item.sessionId !== sessionId),
    pendingQuestion: state.pendingQuestion?.sessionId === sessionId ? null : state.pendingQuestion,
  });
}

async function callArchive(sessionId: string, archived: boolean): Promise<boolean> {
  try {
    return await window.electronAPI.chat.archiveSession({ sessionId, archived });
  } catch {
    return false;
  }
}

/**
 * Archive semantics (R5 D2): "remove from the nav for good".
 *
 * `chat.archiveSession` returns false when the session has no
 * `session-index.json` entry at all — the normal state of a chat created in
 * the sidebar that has never sent a message. Before D2 that made the click a
 * true no-op. The ladder now is:
 *
 * 1. Ask Main to flip the archived bit.
 * 2. On false, self-heal: register the missing index entry
 *    (`recordCreated`, no Host start) and retry exactly ONCE. One retry only
 *    — a second failure means the index is unwritable, not racing.
 * 3. Still false → the row is live-only (no Host binding, no runtime
 *    identity), i.e. there is no server-side truth to preserve, so honour the
 *    click renderer-side and drop the row.
 *
 * A session that got bound to the Host *while* this round-trip was in flight
 * fails the step-3 live-only test (it is re-read fresh from the store, after
 * the awaits) and the call returns false with the row intact: hiding a row
 * whose runtime is actually running would be worse than a visible no-op.
 * The mirrored race — the archive lands first, then the in-flight first-send
 * binds the Host — is closed on the success path, which detaches ANY runtime
 * the Host still holds for this session (round-2 A2) and drops the row before
 * the refresh (round-2 A1).
 *
 * Un-archiving (`archived === false`) never takes the ladder: a missing entry
 * has nothing to un-archive, and inventing one would resurrect a ghost row.
 */
export async function archiveSessionIndexEntry(
  sessionId: string,
  archived: boolean,
  refresh: () => Promise<void>
): Promise<boolean> {
  let ok = await callArchive(sessionId, archived);

  if (!ok && archived) {
    const workspacePath = workspacePathForSession(sessionId);
    if (workspacePath && (await registerSessionIndexEntry(sessionId, workspacePath))) {
      ok = await callArchive(sessionId, archived);
    }
  }

  if (ok) {
    if (archived) {
      // R5 round-2 (A2): detach whenever the Host holds this session, not just
      // when the binding appeared during this round-trip. Archive means "gone
      // from the nav for good", so leaving a running runtime behind with no
      // row to reach it would strand it for the rest of the run.
      if (isHostBound(sessionId)) {
        detachRuntime(sessionId);
      }
      // R5 round-2 (A1): drop the row HERE, before the refresh. The archived
      // bit is persisted and `mergeSessionIndex` drops archived entries, so
      // the refresh would remove the row anyway — but only after an await.
      // Archiving the session the user is currently looking at has to hand
      // `activeSessionId` over synchronously, otherwise the Composer keeps
      // pointing at a dead session for the whole round-trip (and stays there
      // for good if the refresh fails). Idempotent: a no-op when the row is
      // already gone, and the merge discards it either way.
      removeSessionRow(sessionId);
    } else {
      // Un-archiving must also lift a dismissal/tombstone left by an earlier
      // fallback, otherwise the row would stay hidden and reject runtime events
      // for the rest of the run.
      undismissSession(sessionId);
      markSessionsLive([sessionId]);
    }
    await refresh();
    return true;
  }

  if (!archived || !isLiveOnlySession(sessionId)) {
    return false;
  }

  // The bit never landed, so only the run-scoped dismissal keeps the next
  // refresh from re-seeding the row.
  markSessionDismissed(sessionId);
  removeSessionRow(sessionId);
  return true;
}

/**
 * Close semantics (R5 D2, ruling 2): **detach the runtime + drop the row for
 * the rest of this app run**. It deliberately does NOT touch the index's
 * `archived` bit:
 *
 * - A persisted session reappears after a restart. That is the design —
 *   Close is "I'm done with this for now", not "delete".
 * - Permanent removal is Archive, which flips `archived` and keeps the row
 *   out across restarts.
 *
 * Before D2 only the detach half existed: `chat.closeSession` sends
 * `session.close` to the Host and nothing else, so the follow-up `refresh()`
 * re-seeded the very same row from the index and the click read as a no-op
 * for every session, new or persisted. The row is now removed here, and the
 * run-scoped dismissal list keeps the next `refresh()` from resurrecting it.
 *
 * The row leaves the nav even when the detach IPC throws (a Host that is not
 * running has nothing attached anyway); the boolean reports only whether the
 * detach itself was accepted.
 */
export async function closeSessionAndRemoveRow(
  sessionId: string,
  refresh: () => Promise<void>
): Promise<boolean> {
  let detached = true;
  try {
    await window.electronAPI.chat.closeSession({ sessionId });
  } catch {
    detached = false;
  }

  markSessionDismissed(sessionId);
  removeSessionRow(sessionId);
  // Refresh AFTER the removal so survivors' updatedAt is current; the
  // dismissal list keeps the merge from re-adding the row we just dropped.
  await refresh();
  return detached;
}

/**
 * Mutation helpers for rename / archive / close — mirror the Main IPC and
 * refresh the index afterwards so the live list reflects the new state.
 * Bodies live in the non-hook functions above so vitest (node env, `.ts`
 * only) can cover them without a React renderer — same split as
 * `renameSessionIndexEntry`.
 */
export function useSessionIndexMutations(refresh: () => Promise<void>) {
  const rename = useCallback(
    (sessionId: string, title: string): Promise<boolean> =>
      renameSessionIndexEntry(sessionId, title, refresh),
    [refresh]
  );

  const archive = useCallback(
    (sessionId: string, archived: boolean): Promise<boolean> =>
      archiveSessionIndexEntry(sessionId, archived, refresh),
    [refresh]
  );

  const close = useCallback(
    (sessionId: string): Promise<boolean> => closeSessionAndRemoveRow(sessionId, refresh),
    [refresh]
  );

  return { rename, archive, close };
}

/**
 * Bump the live session updatedAt so recent ordering follows activity.
 */
function touchLiveUpdatedAt(sessionId: string, now = Date.now()): void {
  const state = useChatSessionsStore.getState();
  const session = state.sessions.find((item) => item.id === sessionId);
  if (session && session.updatedAt < now) {
    useChatSessionsStore.setState({
      sessions: state.sessions.map((item) =>
        item.id === sessionId ? { ...item, updatedAt: now } : item
      ),
    });
  }
}

export { touchLiveUpdatedAt, type SessionIndexEntry };
