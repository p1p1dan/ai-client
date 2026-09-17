/**
 * T065 回炉 — what to SHOW when Main refuses to open a Pi terminal.
 *
 * Main refuses for four reasons that are written as English sentences and used
 * as dictionary keys, because Main has no translator and the renderer does
 * (`PI_TUI_SESSION_BUSY_REASON`, `PI_TUI_NATIVE_SESSION_REASON`,
 * `PI_TUI_SESSION_MISMATCH_REASON`, `PI_TUI_TURN_RUNNING_REASON`). The
 * pre-flight path already displays them; the open path threw them away, so the
 * D4 re-verify clicked 「Start Pi TUI」 in a second window twice and got no
 * terminal and no message of any kind.
 *
 * Electron wraps a rejected `invoke` before the renderer sees it —
 * `Error invoking remote method 'pi-tui:open': Error: <message>` — so the key
 * arrives buried and `t()` on the raw text would look up a string no dictionary
 * has. Unwrapping generically rather than matching a list of known sentences:
 * a needle list is one more place for the wording to drift out of step, and an
 * unrecognised message still has to reach the user as itself (`translate`
 * falls back to the key, so an untranslated reason degrades to English rather
 * than to blank).
 */

/** `Error invoking remote method 'x': [SomeError: ]<message>` */
const IPC_WRAPPER = /^Error invoking remote method '[^']*':\s*(?:[A-Za-z]*Error:\s*)?([\s\S]+)$/;

/**
 * The dictionary key (or, for anything unrecognised, the plain message) behind
 * a rejected `piTui.open`.
 */
export function piTuiOpenRefusalKey(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error ?? '');
  const unwrapped = IPC_WRAPPER.exec(text.trim())?.[1] ?? text;
  return unwrapped.trim();
}
