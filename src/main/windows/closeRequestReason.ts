import type { AppCloseRequestReason } from '@shared/types';

/**
 * T065 — is this window's close the app's exit, or just one window going away?
 *
 * The dialog asks a different question in each case, and getting it backwards is
 * worse than the single wrong sentence it replaced: telling someone the app
 * keeps running in their other windows, and then quitting, is a promise broken
 * in front of them.
 *
 * `browser_preview` windows are what makes this a judgement rather than a count.
 * They are ordinary `BrowserWindow`s, so `BrowserWindow.getAllWindows()` returns
 * them, but they are not somewhere the app keeps running: the last app window's
 * `closed` handler disposes every preview, and `window-all-closed` then quits.
 *
 * A plain function taking a plain description of what is left, so it can be
 * tested — the real inputs are Electron windows that only exist inside a running
 * app, and this decision is the part that was wrong.
 */
export interface RemainingWindow {
  destroyed: boolean;
  /** True for a preview window — see above; not a place the app keeps running. */
  preview: boolean;
}

export function closeRequestReason(remaining: readonly RemainingWindow[]): AppCloseRequestReason {
  const appWindowStaysOpen = remaining.some((window) => !window.destroyed && !window.preview);
  return appWindowStaysOpen ? 'close-window' : 'quit-app';
}
