import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { create } from 'zustand';
import {
  type ExtensionUiDisplayState,
  initialExtensionUiDisplay,
  reduceExtensionUiDisplay,
  removeExtensionUiNotification,
} from '@/components/chat/extensionUiDisplayModel';
import { subscribeRuntimeEvent } from './runtimeEventBus';
import { isSessionRetired } from './sessionRetirement';

interface ExtensionUiDisplayStoreState extends ExtensionUiDisplayState {
  listening: boolean;
  init: () => () => void;
  removeNotification: (id: string) => void;
}

export const useExtensionUiDisplayStore = create<ExtensionUiDisplayStoreState>()((set, get) => ({
  ...initialExtensionUiDisplay,
  listening: false,

  init: () => {
    if (get().listening) return () => {};
    set({ listening: true });
    const unsubscribe = subscribeRuntimeEvent((event: RuntimeEvent) => {
      if (isSessionRetired(event.sessionId)) return;
      set((state) => {
        const next = reduceExtensionUiDisplay(state, event);
        return next === state ? state : next;
      });
    });
    return () => {
      set({ listening: false });
      unsubscribe();
    };
  },

  removeNotification: (id) => {
    set((state) => removeExtensionUiNotification(state, id));
  },
}));
