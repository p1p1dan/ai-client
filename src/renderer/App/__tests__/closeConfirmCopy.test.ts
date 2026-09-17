import { readFileSync } from 'node:fs';
import path from 'node:path';
import { zhTranslations } from '@shared/i18n';
import { describe, expect, it } from 'vitest';
import { closeConfirmCopy } from '../closeConfirmCopy';

/**
 * T065 — the DEV-16 point check opened a second window and closed it. The
 * dialog asked 「确认退出 / 确定要退出应用吗？」 about an app that would keep
 * running in the first window. Main already sent a reason; nothing read it.
 */
describe('closeConfirmCopy', () => {
  it('asks about the window when another window will still be open', () => {
    const copy = closeConfirmCopy('close-window');

    expect(copy.title).toBe('Close this window');
    expect(copy.confirmLabel).toBe('Close window');
    // The bug in one assertion: this dialog must not claim the app is exiting.
    expect(copy.description).not.toMatch(/exit the app/i);
  });

  it('still asks about the app when this really is the exit', () => {
    // Reverse check: the last window's close DOES quit the app
    // (`window-all-closed` → `app.quit()`), so that copy has to stay.
    expect(closeConfirmCopy('quit-app')).toEqual({
      title: 'Confirm exit',
      description: 'Are you sure you want to exit the app?',
      confirmLabel: 'Exit',
    });
    // `replace-window` is auto-confirmed before any dialog opens, so it gets no
    // copy of its own rather than a third set of unreachable strings.
    expect(closeConfirmCopy('replace-window')).toEqual(closeConfirmCopy('quit-app'));
  });

  it('has a Chinese entry for every string it hands to the dialog', () => {
    for (const reason of ['quit-app', 'close-window'] as const) {
      const copy = closeConfirmCopy(reason);
      expect(zhTranslations[copy.title]).toBeTruthy();
      expect(zhTranslations[copy.description]).toBeTruthy();
      expect(zhTranslations[copy.confirmLabel]).toBeTruthy();
    }
  });
});

/**
 * The producer side. `MainWindow.ts` has no headless entry point, so this reads
 * the source the way the renderer's wiring tests do: what matters is that the
 * reason is CHOSEN, not hardcoded to 'quit-app' as it was.
 */
describe('Main picks the reason from how many windows are left', () => {
  const MAIN_WINDOW = readFileSync(
    path.join(__dirname, '../../../main/windows/MainWindow.ts'),
    'utf8'
  );

  it('is read by the dialog, instead of two hardcoded exit strings', () => {
    // The consumer half: `App.tsx` is a component with no headless entry, so
    // this is a source scan like `tuiHandoverWiring.test.ts` does.
    const APP = readFileSync(path.join(__dirname, '../../App.tsx'), 'utf8');
    expect(APP).toContain('{t(closeCopy.title)}');
    expect(APP).toContain('{t(closeCopy.description)}');
    expect(APP).toContain('{t(closeCopy.confirmLabel)}');
  });

  it('picks the reason from what is left, and asks the same function the tests do', () => {
    // The decision itself is unit-tested in
    // `src/main/windows/__tests__/closeRequestReason.test.ts`; what a source
    // scan can still add is that this file calls it rather than counting
    // windows inline again.
    expect(MAIN_WINDOW).toContain('const reason = closeRequestReason(');
    expect(MAIN_WINDOW).toContain('void confirmCloseWithReason(reason)');
    expect(MAIN_WINDOW).not.toContain("'close-window' : 'quit-app'");
  });

  it('excludes preview windows from what it counts as left', () => {
    // T065 回炉: a `browser_preview` window is an ordinary BrowserWindow, so a
    // plain `getAllWindows()` count promised the user an app that then quit.
    expect(MAIN_WINDOW).toContain('preview: previewWindowManager.isPreviewWindow(other)');
  });
});
