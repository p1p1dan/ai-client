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
}

export const initialExtensionUi: ExtensionUiState = { pending: [] };

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
      const dead = new Set(event.payload.uiRequestIds);
      const next = state.pending.filter((p) => !dead.has(p.uiRequestId));
      return next.length === state.pending.length ? state : { pending: next };
    }

    default:
      return state;
  }
}

/** Drop one dialog after its answer has been sent. */
export function removeExtensionUiDialog(
  state: ExtensionUiState,
  uiRequestId: string
): ExtensionUiState {
  const next = state.pending.filter((p) => p.uiRequestId !== uiRequestId);
  return next.length === state.pending.length ? state : { pending: next };
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
  state: ExtensionUiState
): ExtensionUiPendingDialog | undefined {
  return state.pending[0];
}
