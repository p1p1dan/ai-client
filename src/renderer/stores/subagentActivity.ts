import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { create } from 'zustand';
import {
  initialSubagentActivity,
  reduceSubagentActivity,
  type SubagentActivityState,
} from '@/components/chat/subagentActivityModel';
import { subscribeRuntimeEvent } from './runtimeEventBus';

/**
 * T-34: adjacent store for live subagent activity — the red-line
 * `chatSessions.ts` never carries it. All folding lives in
 * `subagentActivityModel.ts`'s pure reducer (node-env vitest); this file is
 * only the zustand shell plus the subscription lifecycle, structurally
 * identical to `sessionRuntimeFacts.ts` (T-35 precedent — see its header for
 * why the latch works this way and why ONE app-lifetime call site
 * (`ChatWorkspace.tsx`) must own `init()`).
 */
interface SubagentActivityStoreState extends SubagentActivityState {
  /** Latch: true once the single runtime-event listener is installed. */
  listening: boolean;
  /** Subscribe (no-op if already subscribed) and return the unsubscribe. */
  init: () => () => void;
}

export const useSubagentActivityStore = create<SubagentActivityStoreState>()((set, get) => ({
  ...initialSubagentActivity,
  listening: false,

  init: () => {
    if (get().listening) {
      return () => {};
    }
    set({ listening: true });

    const unsubscribe = subscribeRuntimeEvent((event: RuntimeEvent) => {
      set((state) => {
        const next = reduceSubagentActivity(state, event);
        return next === state ? state : next;
      });
    });

    return () => {
      set({ listening: false });
      unsubscribe();
    };
  },
}));
