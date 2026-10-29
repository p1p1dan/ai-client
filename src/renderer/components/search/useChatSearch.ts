/**
 * Chat search (docs/plantree/plans/chat-search, stage 3): the 「对话」 tab's
 * data. A typed query asks Main's index (`chatSearch.query`); an empty one
 * lists the most recent chats from the renderer's own session store.
 *
 * While Main is still building its index (`indexing` non-null) the results
 * are partial, so the same query is asked again until they are complete.
 */
import type { ChatSearchProgress, ChatSearchScope, ChatSearchSnippet } from '@shared/types';
import { getPathBasename } from '@shared/utils/path';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useChatSessionsStore } from '@/stores/chatSessions';

export type ChatSearchScopeKind = 'all' | 'workspace';

/** One result row: a chat, and where in it the query matched. */
export interface ChatSearchRow {
  sessionId: string;
  title: string;
  titleMatch: boolean;
  workspacePath: string | null;
  /** The repository chip: the workspace folder's name; null for a chat bound to none. */
  repoName: string | null;
  updatedAt: number;
  snippet: ChatSearchSnippet | null;
  hitCount: number;
  messageKeys: readonly string[];
}

/** Rows listed for an empty query. */
export const RECENT_CHAT_LIMIT = 20;
/** Most sessions one query asks for. */
const QUERY_LIMIT = 50;
const DEBOUNCE_MS = 200;
/** How often a query is asked again while the index is being built. */
export const INDEXING_REQUERY_MS = 800;

interface UseChatSearchInput {
  query: string;
  scope: ChatSearchScopeKind;
  /** The current workspace root; the `workspace` scope needs one. */
  currentRoot: string | null;
  /** Off while another tab is showing: nothing is asked. */
  active: boolean;
}

export interface ChatSearchState {
  rows: ChatSearchRow[];
  /** True when `rows` are the recent chats, not search results. */
  recent: boolean;
  indexing: ChatSearchProgress | null;
  loading: boolean;
  failed: boolean;
  selectedIndex: number;
  setSelectedIndex: (index: number) => void;
  moveSelection: (delta: number) => void;
  selectedRow: ChatSearchRow | null;
}

function scopeFor(kind: ChatSearchScopeKind, currentRoot: string | null): ChatSearchScope {
  return kind === 'workspace' && currentRoot
    ? { kind: 'workspace', workspacePath: currentRoot }
    : { kind: 'all' };
}

/** The workspace path a stored session runs in, as the index records it. */
function useSessionPaths(): {
  known: ReadonlySet<string>;
  pathOf: ReadonlyMap<string, string | null>;
  repoOf: ReadonlyMap<string, string | null>;
} {
  const sessions = useChatSessionsStore((state) => state.sessions);
  const workspaces = useChatSessionsStore((state) => state.workspaces);
  return useMemo(() => {
    const workspacePath = new Map(workspaces.map((ws) => [ws.id, ws.path]));
    const pathOf = new Map<string, string | null>();
    const repoOf = new Map<string, string | null>();
    for (const session of sessions) {
      const path = workspacePath.get(session.workspaceId) || null;
      pathOf.set(session.id, path || session.unbound?.workspacePath || null);
      // A chat with no folder runs in a scratch directory whose name means nothing.
      repoOf.set(session.id, path ? getPathBasename(path) : null);
    }
    return { known: new Set(pathOf.keys()), pathOf, repoOf };
  }, [sessions, workspaces]);
}

export function useChatSearch({
  query,
  scope,
  currentRoot,
  active,
}: UseChatSearchInput): ChatSearchState {
  const text = query.trim();
  const sessions = useChatSessionsStore((state) => state.sessions);
  const { known, pathOf, repoOf } = useSessionPaths();
  const effectiveScope = scope === 'workspace' && currentRoot ? 'workspace' : 'all';

  const recentRows = useMemo<ChatSearchRow[]>(() => {
    if (text) return [];
    return sessions
      .filter((session) => effectiveScope === 'all' || pathOf.get(session.id) === currentRoot)
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, RECENT_CHAT_LIMIT)
      .map((session) => ({
        sessionId: session.id,
        title: session.title,
        titleMatch: false,
        workspacePath: pathOf.get(session.id) ?? null,
        repoName: repoOf.get(session.id) ?? null,
        updatedAt: session.updatedAt,
        snippet: null,
        hitCount: 0,
        messageKeys: [],
      }));
  }, [text, sessions, pathOf, repoOf, effectiveScope, currentRoot]);

  const [results, setResults] = useState<{
    key: string;
    rows: ChatSearchRow[];
    indexing: ChatSearchProgress | null;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const requestKey = JSON.stringify([text, effectiveScope, currentRoot]);
  // Bumped on every new question so a late reply cannot land.
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    setFailed(false);
    if (!active || !text) {
      setLoading(false);
      setResults(null);
      return undefined;
    }
    setLoading(true);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = async () => {
      try {
        const result = await window.electronAPI.chatSearch.query({
          text,
          scope: scopeFor(effectiveScope, currentRoot),
          limit: QUERY_LIMIT,
        });
        if (current !== generation.current) return;
        setResults({
          key: requestKey,
          rows: result.sessions.map((session) => ({ ...session, repoName: null })),
          indexing: result.indexing,
        });
        setLoading(false);
        if (result.indexing) timer = setTimeout(() => void ask(), INDEXING_REQUERY_MS);
      } catch {
        if (current !== generation.current) return;
        setLoading(false);
        setFailed(true);
      }
    };
    timer = setTimeout(() => void ask(), DEBOUNCE_MS);
    return () => {
      generation.current++;
      if (timer) clearTimeout(timer);
    };
  }, [active, text, effectiveScope, currentRoot, requestKey]);

  // A chat the renderer does not know (just archived, not yet listed) cannot be opened.
  const searchRows = useMemo(
    () =>
      results && results.key === requestKey
        ? results.rows
            .filter((row) => known.has(row.sessionId))
            .map((row) => ({ ...row, repoName: repoOf.get(row.sessionId) ?? null }))
        : [],
    [results, requestKey, known, repoOf]
  );
  const rows = text ? searchRows : recentRows;

  const [selection, setSelectedIndex] = useState(0);
  // A new question starts at its first row; a re-asked one (indexing) keeps the place.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `requestKey` is the trigger
  useEffect(() => setSelectedIndex(0), [requestKey]);
  const selectedIndex = Math.max(0, Math.min(rows.length - 1, selection));
  const moveSelection = useCallback(
    (delta: number) =>
      setSelectedIndex((index) =>
        Math.max(0, Math.min(rows.length - 1, Math.min(index, rows.length - 1) + delta))
      ),
    [rows.length]
  );

  return {
    rows,
    recent: !text,
    indexing: text && results?.key === requestKey ? results.indexing : null,
    loading: Boolean(text) && loading,
    failed: Boolean(text) && failed,
    selectedIndex,
    setSelectedIndex,
    moveSelection,
    selectedRow: rows[selectedIndex] ?? null,
  };
}
