/**
 * Which sessions have a transcript on its way, but not yet on screen.
 *
 * The symptom this exists for: clicking a stored chat in the sidebar shows
 * 「还没有消息，发一条消息开始对话。」until its history arrives. `selectSession`
 * switches `activeSessionId` synchronously, while the transcript comes later —
 * from `chat.readSessionPage` (T102's read-only preview) or from a resume's
 * `session.history` event, whichever this activation took. For that whole
 * window the red-line store's bucket is empty, and an empty bucket is exactly
 * what a genuinely new chat has. Nothing in that store distinguishes the two,
 * because nothing there knows a load is in flight: `historyErrors` and
 * `historyPagination` are both written by the answer, not the request.
 *
 * So the fact lives here, renderer-side, where the request is made. It is
 * display-only in-memory state, like `pendingUserMessages` — a reload starts
 * with nothing loading.
 *
 * ## When a load counts as answered
 *
 * Each entry keeps the session's history state AS IT WAS when the load was
 * asked for, and the load is over once that state changes. The first version
 * read "this session has a `historyPagination` entry" as the answer instead,
 * but that entry outlives the read that wrote it, so a second load of the same
 * chat counted as answered before it was even sent. The reducer writes a NEW
 * pagination object on every `session.history` ingest — failed reads
 * included — and a failed resume writes `historyErrors`, so either one
 * changing is exactly "something answered after we asked". Message rows are
 * not part of the rule: rows that predate the request answer nothing about it.
 *
 * The answer is watched here, on the chat store, rather than by the timeline:
 * the user can click away before it lands, and an entry must settle whether or
 * not a timeline for its session is mounted. The watch is attached only while
 * something is loading.
 *
 * A resume that declines to start answers nothing at all, so its caller clears
 * the entry (`useActivateSession`). The deadline, armed per entry, is the
 * backstop for a load that never answers: a refused preview that fell back to
 * a resume that then hung would otherwise leave the spinner up for good.
 */
import { create } from 'zustand';
import { type ChatSessionsState, useChatSessionsStore } from './chatSessions';

/**
 * How long one load may claim the timeline before it is taken at its word
 * that nothing is coming. Generous on purpose: an activation that falls back
 * to a resume spawns a worker, and a cold engine can take seconds to answer.
 * Too short is worse than too long — a cleared marker repaints the misleading
 * 「还没有消息」 this store exists to remove.
 */
export const HISTORY_LOAD_DEADLINE_MS = 30_000;

/** A session's history state at the moment its load was asked for. */
interface HistoryLoadBaseline {
  /** The `historyPagination` entry, compared by identity. */
  cursor: object | undefined;
  error: string | undefined;
}

type HistorySources = Pick<ChatSessionsState, 'historyErrors' | 'historyPagination'>;

interface HistoryLoadingState {
  /** Sessions whose transcript was asked for and has not arrived. */
  loading: Readonly<Record<string, HistoryLoadBaseline>>;
  /** This activation is about to ask Main for the transcript. */
  begin: (sessionId: string) => void;
  /** Nothing is coming for this load: a resume declined to start. */
  clear: (sessionId: string) => void;
  /** Drop the entries of sessions absent from the live tree. */
  pruneSessions: (sessionIds: readonly string[]) => void;
}

/** One per entry of `loading`: the two are always added and dropped together. */
const deadlines = new Map<string, ReturnType<typeof setTimeout>>();
let stopWatching: (() => void) | null = null;

function baselineOf(state: HistorySources, sessionId: string): HistoryLoadBaseline {
  return { cursor: state.historyPagination?.[sessionId], error: state.historyErrors[sessionId] };
}

function answered(load: HistoryLoadBaseline, state: HistorySources, sessionId: string): boolean {
  const now = baselineOf(state, sessionId);
  return now.cursor !== load.cursor || now.error !== load.error;
}

/** Remove these entries and their deadlines; the watch goes with the last one. */
function drop(sessionIds: readonly string[]): void {
  for (const sessionId of sessionIds) {
    clearTimeout(deadlines.get(sessionId));
    deadlines.delete(sessionId);
  }
  const { loading } = useHistoryLoadingStore.getState();
  const kept = Object.fromEntries(
    Object.entries(loading).filter(([sessionId]) => !sessionIds.includes(sessionId))
  );
  if (Object.keys(kept).length !== Object.keys(loading).length) {
    useHistoryLoadingStore.setState({ loading: kept });
  }
  if (Object.keys(kept).length === 0 && stopWatching) {
    stopWatching();
    stopWatching = null;
  }
}

function watchAnswers(): void {
  if (stopWatching) return;
  stopWatching = useChatSessionsStore.subscribe((chat) => {
    const { loading } = useHistoryLoadingStore.getState();
    const settled = Object.entries(loading)
      .filter(([sessionId, load]) => answered(load, chat, sessionId))
      .map(([sessionId]) => sessionId);
    if (settled.length > 0) drop(settled);
  });
}

export const useHistoryLoadingStore = create<HistoryLoadingState>((set) => ({
  loading: {},
  begin: (sessionId) => {
    // A second activation asks again; the new request, not the first one's
    // clock or state, is what its answer belongs to.
    clearTimeout(deadlines.get(sessionId));
    deadlines.set(
      sessionId,
      setTimeout(() => drop([sessionId]), HISTORY_LOAD_DEADLINE_MS)
    );
    const baseline = baselineOf(useChatSessionsStore.getState(), sessionId);
    set((state) => ({ loading: { ...state.loading, [sessionId]: baseline } }));
    watchAnswers();
  },
  clear: (sessionId) => drop([sessionId]),
  pruneSessions: (sessionIds) => {
    const live = new Set(sessionIds);
    const gone = [...deadlines.keys()].filter((sessionId) => !live.has(sessionId));
    if (gone.length > 0) drop(gone);
  },
}));

/**
 * Is this session's transcript still on its way?
 *
 * Selector-shaped (a boolean, not the map) so a second session's load never
 * re-renders this timeline — the same discipline `selectHistoryError` states
 * for the error record.
 */
export function selectIsHistoryLoading(
  state: Pick<HistoryLoadingState, 'loading'>,
  sessionId: string | null
): boolean {
  return sessionId != null && state.loading[sessionId] !== undefined;
}

/** Test-only: drops every entry, its deadline, and the watch. */
export function resetHistoryLoadingForTests(): void {
  drop([...deadlines.keys()]);
  useHistoryLoadingStore.setState({ loading: {} });
  stopWatching?.();
  stopWatching = null;
}
