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
 * A deadline rather than a lifetime: the marker is cleared the moment history
 * or an error lands (the timeline's effect), or when a resume declines to start
 * (`useActivateSession`), and the deadline is only the backstop for a load that
 * never answers at all. Without it a refused preview that fell back to a resume
 * that then hung would leave the spinner up forever.
 */
import { create } from 'zustand';

/**
 * How long one load may claim the timeline before it is taken at its word
 * that nothing is coming. Generous on purpose: an activation that falls back
 * to a resume spawns a worker, and a cold engine can take seconds to answer.
 * Too short is worse than too long — a cleared marker repaints the misleading
 * 「还没有消息」 this store exists to remove.
 */
export const HISTORY_LOAD_DEADLINE_MS = 30_000;

interface HistoryLoadingState {
  /** Sessions whose transcript was asked for and has not arrived. */
  loading: Readonly<Record<string, number>>;
  /** This activation is about to ask Main for the transcript. */
  begin: (sessionId: string, nowMs?: number) => void;
  /** The transcript (or its failure) landed, or the deadline passed. */
  clear: (sessionId: string) => void;
  /** Drop every entry whose deadline has passed (the timeline's wake-up). */
  reap: (nowMs?: number) => void;
}

export const useHistoryLoadingStore = create<HistoryLoadingState>((set) => ({
  loading: {},
  begin: (sessionId, nowMs = Date.now()) =>
    set((state) => ({
      loading: { ...state.loading, [sessionId]: nowMs + HISTORY_LOAD_DEADLINE_MS },
    })),
  clear: (sessionId) =>
    set((state) => {
      if (state.loading[sessionId] === undefined) return state;
      const loading = { ...state.loading };
      delete loading[sessionId];
      return { loading };
    }),
  reap: (nowMs = Date.now()) =>
    set((state) => {
      const entries = Object.entries(state.loading).filter(([, deadline]) => deadline > nowMs);
      if (entries.length === Object.keys(state.loading).length) return state;
      return { loading: Object.fromEntries(entries) };
    }),
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
  if (!sessionId) return false;
  const deadline = state.loading[sessionId];
  return deadline !== undefined && deadline > Date.now();
}
