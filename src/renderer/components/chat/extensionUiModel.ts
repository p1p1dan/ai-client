import {
  type ExtensionUiDialogArgs,
  type RuntimeEvent,
  readExtensionUiDialogArgs,
} from '@shared/types/runtimeEvents';

/**
 * T08 — the renderer's model of pending Extension UI dialogs.
 *
 * A pi extension that calls `ui.select(...)` is BLOCKED on the answer: its turn
 * does not advance until this store's dialog is closed one way or another. That
 * makes two failures the reducer below exists to prevent — a dialog that is
 * never shown (the turn hangs with nothing on screen) and a dialog that is shown
 * after the Host already settled it (the user answers into the void).
 *
 * Pure by construction so it can be tested under node-env vitest, same split as
 * `subagentActivityModel.ts`: this file folds, `stores/extensionUi.ts` is the
 * zustand shell plus the IPC call.
 */

export interface ExtensionUiPendingDialog {
  /** The bridge instance that asked. Must be echoed back or the answer is stale. */
  runtimeId: string;
  uiRequestId: string;
  /** The session whose turn triggered it; absent when an extension asked during init. */
  sessionId?: string;
  /** Already narrowed — the renderer never re-parses `args`. */
  dialog: ExtensionUiDialogArgs;
  receivedAt: number;
}

export interface ExtensionUiState {
  /**
   * FIFO. An extension may ask again before the first answer arrives (and two
   * extensions may ask at once), so this is a queue rather than a single slot —
   * dropping the second request would hang whichever extension asked it.
   */
  pending: ExtensionUiPendingDialog[];
  /**
   * Answers that have left the renderer but whose IPC call has not come back.
   *
   * In the store rather than in the component's `useState` for one reason: the
   * dialog must stay on screen until the Host has actually been told. It used to
   * be removed the moment a button was pressed, so a failed IPC left the modal
   * gone and the extension parked forever — nothing on screen, and a turn that
   * never finishes.
   */
  sending: string[];
  /** `uiRequestId` → why the last send failed. Shown on the dialog, which is still up. */
  sendErrors: Record<string, string>;
}

export const initialExtensionUi: ExtensionUiState = {
  pending: [],
  sending: [],
  sendErrors: {},
};

/**
 * Fold one runtime event.
 *
 * Returns the SAME state object when nothing changed — the zustand shell uses
 * reference equality to skip a re-render, and this store sees every event in the
 * app, the vast majority of which are not its own.
 */
export function reduceExtensionUi(state: ExtensionUiState, event: RuntimeEvent): ExtensionUiState {
  switch (event.type) {
    case 'extensionUi.request': {
      const { runtimeId, uiRequestId, method, args } = event.payload;
      const dialog = readExtensionUiDialogArgs(method, args);
      // Not a dialog (notify / setStatus / … — T09) or a shape we cannot draw.
      // Either way there is nothing to show, and we must NOT answer on the
      // user's behalf: the Host's bridge settles it with the fallback that
      // matches the method, which is the only place that knows a dismissed
      // `confirm` is a refusal.
      if (!dialog) return state;
      // Defensive: a duplicate id would render two modals that answer each
      // other, and the second answer would be refused Host-side anyway.
      if (state.pending.some((p) => p.uiRequestId === uiRequestId)) return state;
      return {
        ...state,
        pending: [
          ...state.pending,
          {
            runtimeId,
            uiRequestId,
            ...(event.sessionId ? { sessionId: event.sessionId } : {}),
            dialog,
            receivedAt: event.timestamp,
          },
        ],
      };
    }

    case 'extensionUi.cancelled': {
      // The bridge settled these without us — timed out, session swapped, Host
      // shut down. Close them, or the user is looking at a modal that can no
      // longer do anything.
      //
      // Matched on runtimeId AND uiRequestId, never on the id alone: ids are
      // minted per bridge, and every session now has its own bridge. A
      // cancellation from session A that closed a live dialog of session B
      // would take away B's only way to answer — and B's extension would then
      // wait for an answer that can no longer be given.
      const dead = new Set(event.payload.uiRequestIds);
      const runtimeId = event.payload.runtimeId;
      const next = state.pending.filter(
        (p) => !(p.runtimeId === runtimeId && dead.has(p.uiRequestId))
      );
      if (next.length === state.pending.length) return state;
      const closed = new Set(
        state.pending
          .filter((p) => p.runtimeId === runtimeId && dead.has(p.uiRequestId))
          .map((p) => p.uiRequestId)
      );
      return {
        ...state,
        pending: next,
        sending: state.sending.filter((id) => !closed.has(id)),
        sendErrors: withoutKeys(state.sendErrors, closed),
      };
    }

    default:
      return state;
  }
}

function withoutKeys(
  record: Record<string, string>,
  keys: ReadonlySet<string>
): Record<string, string> {
  const entries = Object.entries(record).filter(([key]) => !keys.has(key));
  return entries.length === Object.keys(record).length ? record : Object.fromEntries(entries);
}

/** Drop one dialog after its answer has been ACKNOWLEDGED by the Host. */
export function removeExtensionUiDialog(
  state: ExtensionUiState,
  uiRequestId: string
): ExtensionUiState {
  const next = state.pending.filter((p) => p.uiRequestId !== uiRequestId);
  const one = new Set([uiRequestId]);
  if (
    next.length === state.pending.length &&
    !state.sending.includes(uiRequestId) &&
    !(uiRequestId in state.sendErrors)
  ) {
    return state;
  }
  return {
    ...state,
    pending: next,
    sending: state.sending.filter((id) => id !== uiRequestId),
    sendErrors: withoutKeys(state.sendErrors, one),
  };
}

/**
 * Mark an answer as in flight.
 *
 * This is BOTH the double-click guard and the "do not close yet" flag, which is
 * why they are one piece of state: separating them is how the modal came to be
 * removed on click while the send was still unresolved.
 */
export function markExtensionUiSending(
  state: ExtensionUiState,
  uiRequestId: string
): ExtensionUiState {
  if (state.sending.includes(uiRequestId)) return state;
  return {
    ...state,
    sending: [...state.sending, uiRequestId],
    sendErrors: withoutKeys(state.sendErrors, new Set([uiRequestId])),
  };
}

/**
 * The send failed: keep the dialog, release the guard, and say why.
 *
 * Retry rather than auto-cancel, deliberately. The Host never heard the answer,
 * so its dialog is still parked and still answerable; sending a cancellation on
 * the user's behalf would turn a transport hiccup into a denied tool call they
 * never denied.
 */
export function failExtensionUiSend(
  state: ExtensionUiState,
  uiRequestId: string,
  message: string
): ExtensionUiState {
  return {
    ...state,
    sending: state.sending.filter((id) => id !== uiRequestId),
    sendErrors: { ...state.sendErrors, [uiRequestId]: message },
  };
}

/** A dialog title split into a heading and the preformatted body under it. */
export interface ExtensionUiDialogText {
  heading: string;
  /** Absent when the extension sent a single-line title. */
  body?: string;
}

/**
 * T08-b — split a dialog title into what to headline and what to show below it.
 *
 * pi's `ui.select(title, options)` has ONE text slot, so an extension with more
 * to say than a heading packs it into that slot with newlines.
 * `@gotgenes/pi-permission-system` does exactly this: it calls
 * `ui.select(\`${title}\n${message}\`, …)` where `message` is a multi-line
 * rendered prompt body — the tool, the command, the paths being touched.
 *
 * That body is the entire basis on which someone approves or denies a tool call.
 * Rendering the whole blob as one heading would run it together into an
 * unreadable line and lose the structure the decision depends on, so the first
 * line becomes the heading and the rest is kept verbatim for monospace display.
 *
 * Trailing blank lines are dropped (the renderer pads to a row budget it was
 * given for a terminal); interior ones are kept, because they are the body's own
 * paragraph breaks.
 */
export function splitExtensionUiDialogText(title: string): ExtensionUiDialogText {
  const newline = title.indexOf('\n');
  if (newline === -1) return { heading: title };
  const heading = title.slice(0, newline);
  const body = title.slice(newline + 1).replace(/\s+$/, '');
  return body ? { heading, body } : { heading };
}

/**
 * The dialog to show right now, or `undefined`.
 *
 * Strictly one at a time even when several are queued: these are modal
 * questions, and stacking them would let a user answer the second while the
 * first is still on screen — with no way to tell which extension asked what.
 */
export function currentExtensionUiDialog(
  // Only the queue: a caller holding a `pending` array should not have to
  // fabricate the send-tracking fields to ask which dialog is on top.
  state: Pick<ExtensionUiState, 'pending'>
): ExtensionUiPendingDialog | undefined {
  return state.pending[0];
}
