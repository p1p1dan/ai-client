/**
 * A08: pure key-resolution for shell-level global shortcuts. Kept UI/DOM-free
 * so vitest can cover every branch without mounting `WorkspaceShell` — same
 * pattern as `shellLayoutModel.ts`.
 */
import {
  type ContextSurfaceId,
  DEFAULT_SHELL_COLUMN_MODE,
  DEFAULT_SURFACE_ORDER,
  railSurfaces,
  type ShellColumnMode,
} from './surfaceRegistry';

// 2026-09-04: `open-terminal` (Ctrl/Cmd+`) is gone with the terminal's rail
// button — see `surfaceRegistry.ts`. A shortcut whose target surface is no
// longer rail-selectable resolves to nothing at the reducer, i.e. a key that
// looks bound and does nothing, so it leaves with the button rather than after.
export type ShellShortcutAction =
  | { type: 'toggle-context-panel' }
  | { type: 'select-surface'; surfaceId: ContextSurfaceId }
  | { type: 'toggle-sidebar' };

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
  /**
   * The rail/tab order currently rendered (the store's `railOrder`). Defaults
   * to the registry order so existing callers and tests keep working.
   */
  railOrder?: readonly string[];
  /**
   * Current column mode (the store's `shellColumnMode`). In two-column only
   * `context` is rail-numbered, so Ctrl/Cmd+2..4 resolve to nothing. Defaults
   * to three-column so existing callers and tests keep the full digit map.
   */
  columnMode?: ShellColumnMode;
}

/**
 * First four rail-visible surfaces, in the order the UI actually renders.
 *
 * m-T32: this used to hardcode `DEFAULT_SURFACE_ORDER` while the tab strip and
 * rail render the PERSISTED `railOrder`. The two agreed only until T-32
 * reordered the registry — after which a profile carrying the pre-T-32 order
 * kept showing `context|git|editor|terminal` while Ctrl+1..4 fired the new
 * `git|files|context|terminal`, i.e. the digits "jumped" to the wrong tabs.
 * Taking the same order the caller renders makes that drift impossible.
 */
function numberedSurfaceIds(
  order: readonly string[],
  columnMode: ShellColumnMode
): readonly ContextSurfaceId[] {
  return railSurfaces(order, { columnMode })
    .slice(0, 4)
    .map((surface) => surface.id);
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
 * Focus protection: while the target is editable, only Ctrl/Cmd+J is honored.
 * Everything else — including Ctrl/Cmd+B, which collides with Monaco's
 * bold/cursor-left semantics — is left alone so it reaches the editable
 * element untouched.
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

  if (input.code === 'KeyJ') {
    return { type: 'toggle-context-panel' };
  }

  if (input.targetIsEditable) {
    return null;
  }

  if (input.code === 'KeyB') {
    return { type: 'toggle-sidebar' };
  }

  const digitMatch = /^Digit([1-4])$/.exec(input.code);
  if (digitMatch) {
    const index = Number(digitMatch[1]) - 1;
    const surfaceId = numberedSurfaceIds(
      input.railOrder ?? DEFAULT_SURFACE_ORDER,
      input.columnMode ?? DEFAULT_SHELL_COLUMN_MODE
    )[index];
    return surfaceId ? { type: 'select-surface', surfaceId } : null;
  }

  return null;
}
