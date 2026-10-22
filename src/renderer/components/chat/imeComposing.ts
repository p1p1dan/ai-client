/**
 * Issue #26 item 9: is this keydown part of an IME composition?
 *
 * Three signals, any one is enough: the composer's own `compositionstart` /
 * `compositionend` flag, the event's `isComposing`, and keyCode 229 (what
 * Chromium reports for a key the IME consumed). The flag alone missed the
 * Enter that confirms a candidate on IMEs that fire `compositionend` before
 * the keydown; the event fields alone miss nothing the flag sees on Safari-
 * style orderings. Checking all three costs nothing.
 */
export function isImeComposing(
  event: { keyCode?: number; nativeEvent?: { isComposing?: boolean } },
  composingFlag: boolean
): boolean {
  return composingFlag || event.nativeEvent?.isComposing === true || event.keyCode === 229;
}
