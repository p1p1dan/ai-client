import { describe, expect, it } from 'vitest';
import { isNavigationRequestAborted } from '../useEditor';

describe('isNavigationRequestAborted', () => {
  it('does not abort when no guard is passed (every pre-existing call site)', () => {
    expect(isNavigationRequestAborted(undefined)).toBe(false);
  });

  it('aborts only when the guard explicitly returns false', () => {
    expect(isNavigationRequestAborted(() => false)).toBe(true);
  });

  it('does not abort when the guard returns true', () => {
    expect(isNavigationRequestAborted(() => true)).toBe(false);
  });
});
