import { describe, expect, it } from 'vitest';
import { isImeComposing } from '../imeComposing';

/** Issue #26 item 9: any of the three IME signals holds the key back. */
describe('isImeComposing', () => {
  it('is false for an ordinary key with no composition', () => {
    expect(isImeComposing({ keyCode: 13, nativeEvent: { isComposing: false } }, false)).toBe(false);
  });

  it("trusts the composer's own composition flag", () => {
    expect(isImeComposing({ keyCode: 13, nativeEvent: { isComposing: false } }, true)).toBe(true);
  });

  it('trusts the event when compositionend already cleared the flag', () => {
    expect(isImeComposing({ keyCode: 13, nativeEvent: { isComposing: true } }, false)).toBe(true);
  });

  it('treats keyCode 229 (a key the IME consumed) as composing', () => {
    expect(isImeComposing({ keyCode: 229, nativeEvent: { isComposing: false } }, false)).toBe(true);
  });
});
