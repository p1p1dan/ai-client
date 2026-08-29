import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { create } from 'zustand';
import {
  type ExtensionUiState,
  initialExtensionUi,
  reduceExtensionUi,
  removeExtensionUiDialog,
} from '@/components/chat/extensionUiModel';
import { subscribeRuntimeEvent } from './runtimeEventBus';

/**
 * T11/T08 — pending Extension UI dialogs.
 *
 * Zustand shell only; every fold lives in `extensionUiModel.ts`'s pure reducer.
 * Structurally identical to `subagentActivity.ts` — see its header for why ONE
 * app-lifetime call site owns `init()`.
 */
interface ExtensionUiStoreState extends ExtensionUiState {
  /** Latch: true once the single runtime-event listener is installed. */
  listening: boolean;
  init: () => () => void;
  /**
   * Send the user's answer and close the dialog.
   *
   * The dialog is dropped locally REGARDLESS of what the IPC call does. A
   * failed send means the Host never heard us, and the extension will be
   * settled by the bridge's own timeout or teardown — whereas leaving the modal
   * up would trap the user in a dialog whose button no longer does anything.
   */
  answer: (uiRequestId: string, value: unknown) => Promise<void>;
  /** Dismiss without answering: the Host substitutes the method's fallback. */
  dismiss: (uiRequestId: string) => Promise<void>;
}

export const useExtensionUiStore = create<ExtensionUiStoreState>()((set, get) => ({
  ...initialExtensionUi,
  listening: false,

  init: () => {
    if (get().listening) {
      return () => {};
    }
    set({ listening: true });

    const unsubscribe = subscribeRuntimeEvent((event: RuntimeEvent) => {
      set((state) => {
        const next = reduceExtensionUi(state, event);
        return next === state ? state : next;
      });
    });

    return () => {
      set({ listening: false });
      unsubscribe();
    };
  },

  answer: async (uiRequestId, value) => {
    await respond(get, set, uiRequestId, true, value);
  },

  dismiss: async (uiRequestId) => {
    await respond(get, set, uiRequestId, false, undefined);
  },
}));

async function respond(
  get: () => ExtensionUiStoreState,
  set: (fn: (state: ExtensionUiStoreState) => Partial<ExtensionUiStoreState>) => void,
  uiRequestId: string,
  ok: boolean,
  value: unknown
): Promise<void> {
  const dialog = get().pending.find((p) => p.uiRequestId === uiRequestId);
  // Already gone — cancelled by the bridge, or answered twice by a re-mounted
  // component. Sending anyway would be refused Host-side; not sending is the
  // same outcome without the round trip.
  if (!dialog) return;

  set((state) => removeExtensionUiDialog(state, uiRequestId));

  try {
    await window.electronAPI.chat.respondExtensionUi({
      runtimeId: dialog.runtimeId,
      uiRequestId,
      ok,
      // Omitted entirely on a dismissal: `ok: false` means "nobody answered",
      // and a value riding along would invite a reader to use it.
      ...(ok ? { value } : {}),
    });
  } catch (err) {
    console.error('[extensionUi] failed to send response', err);
  }
}
