import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { create } from 'zustand';
import {
  type ExtensionUiState,
  failExtensionUiSend,
  initialExtensionUi,
  markExtensionUiSending,
  reduceExtensionUi,
  removeExtensionUiDialog,
} from '@/components/chat/extensionUiModel';
import { subscribeRuntimeEvent } from './runtimeEventBus';
import { isSessionRetired } from './sessionRetirement';

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
   * Send the user's answer, and close the dialog once the Host has it.
   *
   * The dialog stays up until the IPC call RESOLVES. Dropping it on click was
   * the failure this replaces: a rejected call left nothing on screen while the
   * Host's dialog stayed parked, so the extension waited forever and the turn
   * never finished, with no way for the user to tell or retry.
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
      if (isSessionRetired(event.sessionId)) return;
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
  const state = get();
  const dialog = state.pending.find((p) => p.uiRequestId === uiRequestId);
  // Already gone — cancelled by the bridge, or answered twice by a re-mounted
  // component. Sending anyway would be refused Host-side; not sending is the
  // same outcome without the round trip.
  if (!dialog) return;
  // Double-click guard. It lives in the store, not in the component, so a
  // remount cannot reset it mid-flight.
  if (state.sending.includes(uiRequestId)) return;

  set((current) => markExtensionUiSending(current, uiRequestId));

  try {
    await window.electronAPI.chat.respondExtensionUi({
      runtimeId: dialog.runtimeId,
      uiRequestId,
      ok,
      // Omitted entirely on a dismissal: `ok: false` means "nobody answered",
      // and a value riding along would invite a reader to use it.
      ...(ok ? { value } : {}),
    });
    set((current) => removeExtensionUiDialog(current, uiRequestId));
  } catch (err) {
    // The Host never heard us, so its dialog is still parked and still
    // answerable. Keep ours up, say what happened, and let them press again.
    const message = err instanceof Error ? err.message : String(err);
    set((current) => failExtensionUiSend(current, uiRequestId, message));
  }
}
