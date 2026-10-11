/**
 * dsh-rebase decision 176 — the `/compact` this window has on its way, per
 * conversation, and how far it got: starting the conversation (only when the
 * engine was not running it), then compacting.
 *
 * Before this nothing said a compaction was running: no status, no Stop, the
 * command sat in the input box for up to 45 s, and a second Enter queued a
 * second compaction. The composer's status line reads the phase
 * (「正在启动对话…」, then 「正在压缩上下文…」); a second `/compact` is answered
 * here while one runs; a message waits while the conversation is being
 * started.
 *
 * Not persisted: it is about calls in flight in this run.
 */
import { create } from 'zustand';

export type CompactRunPhase = 'starting' | 'compacting';

interface CompactRunsState {
  phases: Readonly<Record<string, CompactRunPhase>>;
  /** Mark one on its way; `false` (and nothing changed) when one already is. */
  begin: (sessionId: string) => boolean;
  setPhase: (sessionId: string, phase: CompactRunPhase) => void;
  end: (sessionId: string) => void;
}

export const useCompactRunsStore = create<CompactRunsState>((set, get) => ({
  phases: {},
  begin: (sessionId) => {
    if (get().phases[sessionId]) return false;
    set((state) => ({ phases: { ...state.phases, [sessionId]: 'compacting' } }));
    return true;
  },
  setPhase: (sessionId, phase) =>
    set((state) =>
      state.phases[sessionId] === undefined || state.phases[sessionId] === phase
        ? state
        : { phases: { ...state.phases, [sessionId]: phase } }
    ),
  end: (sessionId) =>
    set((state) => {
      if (state.phases[sessionId] === undefined) return state;
      const { [sessionId]: _ended, ...rest } = state.phases;
      return { phases: rest };
    }),
}));

/** The phase of the `/compact` on its way for `sessionId`, if one is. */
export function selectCompactPhase(
  state: Pick<CompactRunsState, 'phases'>,
  sessionId: string | null | undefined
): CompactRunPhase | undefined {
  return sessionId ? state.phases[sessionId] : undefined;
}
