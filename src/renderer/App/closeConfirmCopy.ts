import type { AppCloseRequestReason } from '@shared/types';

/**
 * T065 — what the close-confirmation dialog says, chosen by what is actually
 * about to happen.
 *
 * The DEV-16 point check opened a second window and closed it: the dialog asked
 * 「确认退出 / 确定要退出应用吗？」 about an app that would still be running in
 * the other window. One window closing and the app exiting are genuinely
 * different outcomes here (`window-all-closed` quits), and the reason Main
 * sends already distinguishes them — nothing read it.
 *
 * A plain function in a `.ts` rather than a branch inside `App.tsx`: the repo's
 * vitest only collects `.ts`, so copy decided inside the component cannot be
 * asserted.
 */
export interface CloseConfirmCopy {
  /** Dictionary keys, not display text — `App.tsx` calls `t()` on each. */
  title: string;
  description: string;
  confirmLabel: string;
}

const QUIT_APP: CloseConfirmCopy = {
  title: 'Confirm exit',
  description: 'Are you sure you want to exit the app?',
  confirmLabel: 'Exit',
};

const CLOSE_WINDOW: CloseConfirmCopy = {
  title: 'Close this window',
  description: 'The app keeps running in your other windows.',
  confirmLabel: 'Close window',
};

/**
 * `replace-window` never reaches a dialog (the renderer auto-confirms it in
 * `useAppLifecycle`), so it falls through to the exit copy rather than getting
 * a third set of strings nobody would see.
 */
export function closeConfirmCopy(reason: AppCloseRequestReason): CloseConfirmCopy {
  return reason === 'close-window' ? CLOSE_WINDOW : QUIT_APP;
}
