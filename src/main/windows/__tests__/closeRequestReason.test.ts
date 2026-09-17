import { describe, expect, it } from 'vitest';
import { closeRequestReason } from '../closeRequestReason';

/**
 * T065 回炉 — which question the close dialog asks.
 *
 * The first landing counted `BrowserWindow.getAllWindows()`, which includes
 * `browser_preview` windows. With one app window and one preview open, closing
 * the app window promised 「应用会在你其他的窗口里继续运行」 and then quit: the
 * `closed` handler disposes every preview once nothing but previews is left,
 * `window-all-closed` fires, and the app exits. A dialog that is wrong in that
 * direction is worse than the single hardcoded sentence it replaced.
 */
describe('closeRequestReason', () => {
  it('does not count preview windows as somewhere the app keeps running', () => {
    // The defect, as one assertion.
    expect(closeRequestReason([{ destroyed: false, preview: true }])).toBe('quit-app');
  });

  it('still says close-window when a real app window stays open', () => {
    // Reverse check: the fix must not put the old always-quit copy back.
    expect(
      closeRequestReason([
        { destroyed: false, preview: true },
        { destroyed: false, preview: false },
      ])
    ).toBe('close-window');
  });

  it('treats a destroyed window as gone, and no windows at all as the exit', () => {
    expect(closeRequestReason([{ destroyed: true, preview: false }])).toBe('quit-app');
    expect(closeRequestReason([])).toBe('quit-app');
  });
});
