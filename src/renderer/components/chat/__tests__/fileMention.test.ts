import type { FileSearchResult } from '@shared/types/search';
import { describe, expect, it } from 'vitest';
import { extractMentionQuery, parseMentionChips, replaceMention } from '../fileMention';

function file(relativePath: string, absolute?: string): FileSearchResult {
  const sep = relativePath.includes('/') ? '/' : '\\';
  const name = relativePath.slice(relativePath.lastIndexOf(sep) + 1);
  return { path: absolute ?? `/${relativePath}`, name, relativePath, score: 0 };
}

describe('extractMentionQuery (T-07)', () => {
  it('returns "" for a bare @ at cursor end', () => {
    expect(extractMentionQuery('@', 1)).toBe('');
  });

  it('returns the substring after @ when @foo is open', () => {
    expect(extractMentionQuery('@foo', 4)).toBe('foo');
  });

  it('returns null when the char before cursor is whitespace', () => {
    expect(extractMentionQuery('hi @foo ', 8)).toBe(null);
  });

  it('returns null when @ is preceded by non-whitespace and not at start (mid token)', () => {
    expect(extractMentionQuery('a@foo', 5)).toBe(null);
  });

  it('returns substring including slash for @dir/file', () => {
    expect(extractMentionQuery('@dir/file', 9)).toBe('dir/file');
  });

  it('walks past newlines and returns null when @ is unreachable', () => {
    const text = 'first line\nsecond @foo\nbar';
    expect(extractMentionQuery(text, text.indexOf('@foo') + 4)).toBe('foo');
    expect(extractMentionQuery(text, text.length)).toBe(null);
  });

  it('returns "" when cursor is right after @', () => {
    expect(extractMentionQuery('@', 1)).toBe('');
    expect(extractMentionQuery('prompt @', 8)).toBe('');
  });

  it('handles @ at very start of text', () => {
    expect(extractMentionQuery('@foo bar', 4)).toBe('foo');
  });

  it('returns null when no @ before cursor at all', () => {
    expect(extractMentionQuery('hello world', 11)).toBe(null);
  });

  it('stops at first whitespace going backwards — returns null when cursor inside a later token', () => {
    // cursor inside "@qux" returns null because @foo before it has a trailing
    // space that breaks the backward scan.
    expect(extractMentionQuery('@foo bar @qux', 13)).toBe('qux');
  });
});

describe('replaceMention (T-07)', () => {
  it('replaces @qu with @relativePath, reusing the existing trailing space (no double space)', () => {
    const out = replaceMention('@qu end', 3, file('docs/readme.md'));
    expect(out).toEqual({ text: '@docs/readme.md end', cursor: 15 });
  });

  it('preserves content before the @ token', () => {
    const text = 'Please @qu review';
    const out = replaceMention(text, text.indexOf('@qu') + 3, file('src/main.ts'));
    expect(out).toEqual({ text: 'Please @src/main.ts review', cursor: 19 });
  });

  it('preserves content after the open token', () => {
    const text = '@qu tail';
    const out = replaceMention(text, 3, file('a.ts'));
    expect(out).toEqual({ text: '@a.ts tail', cursor: 5 });
  });

  it('returns null when there is no @ before cursor', () => {
    expect(replaceMention('hi there', 8, file('a.ts'))).toBeNull();
  });

  it('returns null when @ is mid-token (preceded by non-whitespace)', () => {
    expect(replaceMention('a@foo', 5, file('a.ts'))).toBeNull();
  });

  it('appends a trailing space when cursor is at end of text (no separator after)', () => {
    const out = replaceMention('check @qu', 9, file('pkg.json'));
    expect(out).toEqual({ text: 'check @pkg.json ', cursor: 16 });
  });

  it('treats bare @ (open with empty query) as replaceable', () => {
    const out = replaceMention('look @', 6, file('x.ts'));
    expect(out).toEqual({ text: 'look @x.ts ', cursor: 11 });
  });

  it('supports search result that provides an absolute path', () => {
    const out = replaceMention('@q', 2, file('a.ts', '/repo/a.ts'));
    expect(out?.text).toBe('@a.ts ');
  });

  it('does NOT double the space when the next char is a newline', () => {
    const out = replaceMention('@qu\nnext', 3, file('a.ts'));
    expect(out).toEqual({ text: '@a.ts\nnext', cursor: 5 });
  });

  it('replaces the full open @token up to cursor, leaving text after cursor intact', () => {
    // cursor = 3 (end of "@qu" — the full open-token query range).
    // text after cursor (" bar") is preserved; existing space reused.
    const out = replaceMention('@qu bar', 3, file('a.ts'));
    expect(out).toEqual({ text: '@a.ts bar', cursor: 5 });
  });
});

describe('parseMentionChips (T-07)', () => {
  it('returns empty for text without @', () => {
    expect(parseMentionChips('hello world')).toEqual([]);
  });

  it('returns empty for bare @', () => {
    expect(parseMentionChips('look @')).toEqual([]);
  });

  it('returns one chip for a single @path', () => {
    expect(parseMentionChips('@src/main.ts')).toEqual([{ path: 'src/main.ts' }]);
  });

  it('returns chips for multiple @path on a single line', () => {
    expect(parseMentionChips('@a @b @c')).toEqual([{ path: 'a' }, { path: 'b' }, { path: 'c' }]);
  });

  it('stops each chip at space or newline', () => {
    expect(parseMentionChips('@a\n@b @c tail')).toEqual([
      { path: 'a' },
      { path: 'b' },
      { path: 'c' },
    ]);
  });

  it('ignores @ embedded mid-token (no leading whitespace)', () => {
    expect(parseMentionChips('foo@bar')).toEqual([]);
  });

  it('allows @ at document start', () => {
    expect(parseMentionChips('@first hello')).toEqual([{ path: 'first' }]);
  });

  it('preserves order across newlines', () => {
    expect(parseMentionChips('@a\n\n@c')).toEqual([{ path: 'a' }, { path: 'c' }]);
  });
});
