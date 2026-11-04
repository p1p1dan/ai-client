/**
 * Decision 209 §3: the side chat's own window — names and sizes both halves
 * agree on. The renderer opens it with `window.open('about:blank', NAME)` and
 * draws into it through a React portal; Main lets exactly this frame name
 * through its window-open handler, as a frameless window owned by the main
 * window (on top of it, minimized with it, no taskbar entry of its own).
 */

/** The `window.open` frame name Main lets through. Anything else is refused. */
export const SIDE_CHAT_WINDOW_NAME = 'aiclient-side-chat';

/** The reference's ~380×440 corner window, now a window of its own. */
export const SIDE_CHAT_WINDOW_DEFAULT_SIZE = { width: 380, height: 440 } as const;
export const SIDE_CHAT_WINDOW_MIN_SIZE = { width: 320, height: 280 } as const;
/** Where a first (or lost) window rests: this far in from the main window's bottom-right corner. */
export const SIDE_CHAT_WINDOW_MARGIN = 16;
