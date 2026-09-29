import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { create } from 'zustand';
import {
  initialToolLiveOutput,
  pruneToolLiveOutput,
  reduceToolLiveOutput,
  type ToolLiveOutputState,
} from '@/components/chat/toolLiveOutputModel';
import { subscribeRuntimeEvent } from './runtimeEventBus';
import { isSessionRetired } from './sessionRetirement';

/**
 * dsh-rebase P1-7b: adjacent store for the live output of running commands
 * (`tool.output`) — memory only, never in the red-line `chatSessions.ts`. The
 * fold is `toolLiveOutputModel.ts`'s; this is the zustand shell and the
 * single-listener latch, owned by `ChatWorkspace.tsx` like the other
 * adjacent stores.
 */
interface ToolLiveOutputStoreState extends ToolLiveOutputState {
  listening: boolean;
  init: () => () => void;
  pruneSessions: (sessionIds: readonly string[]) => void;
}

export const useToolLiveOutputStore = create<ToolLiveOutputStoreState>()((set, get) => ({
  ...initialToolLiveOutput,
  listening: false,

  init: () => {
    if (get().listening) {
      return () => {};
    }
    set({ listening: true });
    const unsubscribe = subscribeRuntimeEvent((event: RuntimeEvent) => {
      if (isSessionRetired(event.sessionId)) return;
      set((state) => {
        const next = reduceToolLiveOutput(state, event);
        return next === state ? state : { byCall: next.byCall, order: next.order };
      });
    });
    return () => {
      set({ listening: false });
      unsubscribe();
    };
  },

  pruneSessions: (sessionIds) =>
    set((state) => {
      const next = pruneToolLiveOutput(state, sessionIds);
      return next === state ? state : { byCall: next.byCall, order: next.order };
    }),
}));
