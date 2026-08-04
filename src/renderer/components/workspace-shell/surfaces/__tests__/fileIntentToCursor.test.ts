import { describe, expect, it } from 'vitest';
import { fileIntentToCursor, WHOLE_LINE_MATCH_LENGTH } from '../fileIntentToCursor';

describe('fileIntentToCursor', () => {
  it('returns undefined when no line is given', () => {
    expect(fileIntentToCursor({})).toBeUndefined();
  });

  it('places the cursor at line start when only line is given', () => {
    expect(fileIntentToCursor({ line: 42 })).toEqual({ line: 42, column: 0 });
  });

  it('never carries a matchLength when only line is given', () => {
    const target = fileIntentToCursor({ line: 10 });
    expect(target?.matchLength).toBeUndefined();
  });

  it('selects the whole anchor line when endLine differs from line', () => {
    expect(fileIntentToCursor({ line: 5, endLine: 8 })).toEqual({
      line: 5,
      column: 0,
      matchLength: WHOLE_LINE_MATCH_LENGTH,
    });
  });

  it('treats endLine equal to line as a plain line-start cursor (no fake range)', () => {
    expect(fileIntentToCursor({ line: 5, endLine: 5 })).toEqual({ line: 5, column: 0 });
  });

  it('never derives matchLength from the endLine - line difference', () => {
    // Regression guard for the bug this function exists to prevent: a line
    // count (endLine - line = 3) must never leak into matchLength, which only
    // ever means a same-line character count.
    const target = fileIntentToCursor({ line: 100, endLine: 103 });
    expect(target?.matchLength).not.toBe(3);
    expect(target?.matchLength).toBe(WHOLE_LINE_MATCH_LENGTH);
  });
});
