import { describe, expect, it } from 'vitest';
import { buildSnippet, findMatch } from '../snippet';

describe('findMatch', () => {
  it('folds case and reports UTF-16 offsets', () => {
    expect(findMatch('😀 Lot 8GE21E15', '8ge21e15')).toEqual({ start: 7, length: 8 });
    expect(findMatch('abc', 'x')).toBeNull();
    expect(findMatch('abc', '')).toBeNull();
  });

  it('falls back to window by window when folding changes the length', () => {
    // 'İ'.toLowerCase() is two code units.
    expect(findMatch('İstanbul ABC', 'abc')).toEqual({ start: 9, length: 3 });
  });
});

describe('buildSnippet', () => {
  it('never splits a surrogate pair at either edge', () => {
    const text = `${'😀'.repeat(30)}X${'😀'.repeat(50)}`;
    const match = findMatch(text, 'x');
    const snippet = buildSnippet(text, 'user', match);
    const inner = snippet.text.replace(/^…/, '').replace(/…$/, '');
    expect(inner).toBe(inner.normalize());
    expect(/^[\uDC00-\uDFFF]/.test(inner)).toBe(false);
    expect(/[\uD800-\uDBFF]$/.test(inner)).toBe(false);
    expect(snippet.text.slice(snippet.matchStart, snippet.matchStart + snippet.matchLength)).toBe(
      'X'
    );
  });

  it('starts at the top when no match position is known', () => {
    expect(buildSnippet('short text', 'assistant', null)).toEqual({
      role: 'assistant',
      text: 'short text',
      matchStart: 0,
      matchLength: 0,
    });
  });
});
