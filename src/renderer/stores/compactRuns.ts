/**
 * dsh-rebase decision 176 — the `/compact` this window has on its way, per
 * conversation, and how far it got: starting the conversation (only when the
 * engine was not running it), then compacting.
 *
 * Before this nothing said a compaction was running: no status, no Stop, the
 * command sat in the input box for up to 45 s, and a second Enter queued a
 * second compaction. A second `/compact` is answered here while one runs, and
 * a message waits in the queue while the conversation is being started or
 * compacted (decisions 178, 179).
 *
 * Decision 180: the run shows in the timeline now (its command line, then a
 * running row), which reads `compactingSince` for its clock and `cancelling`
 * for its hint; Esc or Stop asks for the cancel here (`requestCancel`).
 *
 * Not persisted: it is about calls in flight in this run.
 */
import { create } from 'zustand';

export type CompactRunPhase = 'starting' | 'compacting';

interface CompactRunsState {
  phases: Readonly<Record<string, CompactRunPhase>>;
  /** Decision 180: when each run's compacting phase began (epoch ms), for its row's clock. */
  compactingSince: Readonly<Record<string, number>>;
  /** Decision 180: Esc or Stop asked this run to cancel. */
  cancelling: Readonly<Record<string, true>>;
  /** Mark one on its way; `false` (and nothing changed) when one already is. */
  begin: (sessionId: string, phase?: CompactRunPhase) => boolean;
  setPhase: (sessionId: string, phase: CompactRunPhase) => void;
  /** Decision 180: `false` when there is no run, or its cancel was already asked. */
  requestCancel: (sessionId: string) => boolean;
  end: (sessionId: string) => void;
}

function without<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const { [key]: _gone, ...rest } = record;
  return rest;
}

/** `compactingSince` as `phase` leaves it: stamped on entering compacting, dropped otherwise. */
function sinceFor(
  state: Pick<CompactRunsState, 'compactingSince'>,
  sessionId: string,
  phase: CompactRunPhase
): Record<string, number> {
  if (phase === 'compacting') {
    return state.compactingSince[sessionId] !== undefined
      ? { ...state.compactingSince }
      : { ...state.compactingSince, [sessionId]: Date.now() };
  }
  return without(state.compactingSince, sessionId);
}

export const useCompactRunsStore = create<CompactRunsState>((set, get) => ({
  phases: {},
  compactingSince: {},
  cancelling: {},
  begin: (sessionId, phase = 'compacting') => {
    if (get().phases[sessionId]) return false;
    set((state) => ({
      phases: { ...state.phases, [sessionId]: phase },
      compactingSince: sinceFor(state, sessionId, phase),
      cancelling: without(state.cancelling, sessionId),
    }));
    return true;
  },
  setPhase: (sessionId, phase) =>
    set((state) =>
      state.phases[sessionId] === undefined || state.phases[sessionId] === phase
        ? state
        : {
            phases: { ...state.phases, [sessionId]: phase },
            compactingSince: sinceFor(state, sessionId, phase),
          }
    ),
  requestCancel: (sessionId) => {
    const state = get();
    if (state.phases[sessionId] === undefined || state.cancelling[sessionId]) return false;
    set({ cancelling: { ...state.cancelling, [sessionId]: true } });
    return true;
  },
  end: (sessionId) =>
    set((state) => {
      if (state.phases[sessionId] === undefined) return state;
      return {
        phases: without(state.phases, sessionId),
        compactingSince: without(state.compactingSince, sessionId),
        cancelling: without(state.cancelling, sessionId),
      };
    }),
}));

/** The phase of the `/compact` on its way for `sessionId`, if one is. */
export function selectCompactPhase(
  state: Pick<CompactRunsState, 'phases'>,
  sessionId: string | null | undefined
): CompactRunPhase | undefined {
  return sessionId ? state.phases[sessionId] : undefined;
}
