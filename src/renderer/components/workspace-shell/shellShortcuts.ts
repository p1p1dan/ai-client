/**
 * A08: pure key-resolution for shell-level global shortcuts. Kept UI/DOM-free
 * so vitest can cover every branch without mounting `WorkspaceShell` — same
 * pattern as `shellLayoutModel.ts`.
 */
import type { WorkPanelTab } from './workPanelModel';

/**
 * Layout 5a (ruling L1): the rail's digits keep their slots, retargeted. 1 was
 * the dock's chat list and still is — the sidebar's, expanding it if it is
 * collapsed. 2–5 were the rail's git / files / context / run and now open (or
 * close) those work panel tabs. A fixed table: there is no rail order left to
 * derive it from.
 */
export const DIGIT_PANEL_TABS: Readonly<Record<'2' | '3' | '4' | '5', WorkPanelTab>> = {
  '2': 'git',
  '3': 'files',
  '4': 'context',
  '5': 'run',
};

// 2026-09-04: `open-terminal` (Ctrl/Cmd+`) is gone with the terminal's rail
// button. D08: Ctrl/Cmd+J left with the right panel it toggled; Ctrl/Cmd+B
// (VSCode's own sidebar binding) toggles the sidebar — since layout 5a, the
// whole sidebar, which collapses to nothing.
export type ShellShortcutAction =
  | { type: 'toggle-sidebar' }
  | { type: 'focus-chat-list' }
  | { type: 'toggle-panel-tab'; tab: WorkPanelTab };

export interface ResolveShellShortcutInput {
  /** `KeyboardEvent.key` — currently unused by resolution (kept for callers/future use). */
  key: string;
  /** `KeyboardEvent.code` — layout-independent, what every branch here matches on. */
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  /** True on macOS: the mod key is `metaKey` there, `ctrlKey` everywhere else. */
  isMac: boolean;
  /** True when the event target is an input/textarea/contenteditable (incl. Monaco/xterm's hidden input hosts). */
  targetIsEditable: boolean;
  /**
   * m15: `KeyboardEvent.isComposing` — true while an IME composition is in
   * progress. Mirrors the guard `App/useAppKeyboardShortcuts.ts` already
   * applies to its own shortcuts; without it, committing an IME composition
   * with Ctrl/Cmd fires this resolver mid-composition and `preventDefault`s
   * the keystroke the IME needed.
   */
  isComposing: boolean;
}

/**
 * m16: each platform's mod key must exclude the OTHER platform's — without
 * `&& !ctrlKey`/`&& !metaKey`, a Linux/Windows Super+Ctrl+1 chord (real on
 * some window managers) would also satisfy `ctrlKey` and fire a shell
 * shortcut the user never intended to press.
 */
function modKeyPressed(input: ResolveShellShortcutInput): boolean {
  return input.isMac ? input.metaKey && !input.ctrlKey : input.ctrlKey && !input.metaKey;
}

/**
 * Resolves a `keydown` event into a shell shortcut action, or `null` when the
 * event isn't one of ours and should be left to native/downstream handling.
 *
 * Focus protection: while the target is editable, NOTHING is honored. D08
 * removed the one exception (Ctrl/Cmd+J) along with the panel it toggled;
 * Ctrl/Cmd+B was never exempt because it collides with Monaco's
 * bold/cursor-left semantics, and the digits collide with editor tab switching.
 */
export function resolveShellShortcut(input: ResolveShellShortcutInput): ShellShortcutAction | null {
  // m15: composing always wins, even over the Ctrl/Cmd+J focus-protection
  // exception below — an in-progress IME composition must never be
  // interrupted by ANY shell shortcut.
  if (input.isComposing) {
    return null;
  }
  if (input.altKey || input.shiftKey || !modKeyPressed(input)) {
    return null;
  }

  if (input.targetIsEditable) {
    return null;
  }

  if (input.code === 'KeyB') {
    return { type: 'toggle-sidebar' };
  }

  const digitMatch = /^Digit([1-5])$/.exec(input.code);
  if (digitMatch) {
    const digit = digitMatch[1] as '1' | '2' | '3' | '4' | '5';
    return digit === '1'
      ? { type: 'focus-chat-list' }
      : { type: 'toggle-panel-tab', tab: DIGIT_PANEL_TABS[digit] };
  }

  return null;
}
