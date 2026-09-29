import { create } from 'zustand';

/**
 * dsh-rebase P1-7b (decisions 109, 119): the window-local state of the two
 * floating sub-windows — background jobs and subagents — that the session
 * bar's buttons open and hide.
 *
 * Nothing here is persisted (the prototype's answer to its question 6: a
 * dragged window keeps its place for this run of the app only). Open or not
 * is one fact per window, not per session: switching chats keeps a window
 * open and shows the new chat's list in it.
 */
export type SubwindowKey = 'jobs' | 'agents';

/** A dragged window's corner, in px from the layer's top-left. */
export interface SubwindowPosition {
  left: number;
  top: number;
}

interface SessionSubwindowsState {
  open: Record<SubwindowKey, boolean>;
  /** Where each window was dragged to; absent: stacked at the top right. */
  positions: Partial<Record<SubwindowKey, SubwindowPosition>>;
  /** Ended jobs this window was told to put away, per session (「移除」: this window only). */
  hiddenJobs: Record<string, readonly string[]>;
  /** Rows whose output / activity is open, by row key. */
  expanded: Record<string, true>;
  toggle: (key: SubwindowKey) => void;
  close: (key: SubwindowKey) => void;
  setPosition: (key: SubwindowKey, position: SubwindowPosition | null) => void;
  hideJob: (sessionId: string, jobId: string) => void;
  toggleExpanded: (rowKey: string) => void;
  pruneSessions: (sessionIds: readonly string[]) => void;
}

/** How many put-away jobs are remembered per session (the bridge keeps 8 ended ones). */
const HIDDEN_JOBS_KEPT = 32;

export const useSessionSubwindowsStore = create<SessionSubwindowsState>()((set) => ({
  open: { jobs: false, agents: false },
  positions: {},
  hiddenJobs: {},
  expanded: {},

  toggle: (key) => set((state) => ({ open: { ...state.open, [key]: !state.open[key] } })),

  close: (key) => set((state) => ({ open: { ...state.open, [key]: false } })),

  setPosition: (key, position) =>
    set((state) => {
      const positions = { ...state.positions };
      if (position) positions[key] = position;
      else delete positions[key];
      return { positions };
    }),

  hideJob: (sessionId, jobId) =>
    set((state) => {
      const current = state.hiddenJobs[sessionId] ?? [];
      if (current.includes(jobId)) return state;
      return {
        hiddenJobs: {
          ...state.hiddenJobs,
          [sessionId]: [...current, jobId].slice(-HIDDEN_JOBS_KEPT),
        },
      };
    }),

  toggleExpanded: (rowKey) =>
    set((state) => {
      const expanded = { ...state.expanded };
      if (expanded[rowKey]) delete expanded[rowKey];
      else expanded[rowKey] = true;
      return { expanded };
    }),

  pruneSessions: (sessionIds) =>
    set((state) => {
      const live = new Set(sessionIds);
      const kept = Object.entries(state.hiddenJobs).filter(([id]) => live.has(id));
      return kept.length === Object.keys(state.hiddenJobs).length
        ? state
        : { hiddenJobs: Object.fromEntries(kept) };
    }),
}));
