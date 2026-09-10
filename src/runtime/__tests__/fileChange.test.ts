import { describe, expect, it } from 'vitest';
import { createFileChange, REVIEW_FILE_BYTES } from '../plugins/tools/file-change.ts';

describe('message-owned file changes', () => {
  it('records creation and a later edit separately', () => {
    const first = createFileChange('test.txt', { text: null }, 'pong\n');
    const second = createFileChange('test.txt', { text: 'pong\n' }, 'pong\nabc\n');
    expect(first).toMatchObject({ status: 'added', patch: '@@ -0,0 +1,1 @@\n+pong' });
    expect(second).toMatchObject({ status: 'modified', patch: '@@ -1,1 +1,2 @@\n pong\n+abc' });
  });
  it('captures overwritten content and final-newline changes', () => {
    expect(createFileChange('a', { text: 'before\n' }, 'after\n').patch).toBe(
      '@@ -1,1 +1,1 @@\n-before\n+after'
    );
    expect(createFileChange('a', { text: 'a' }, 'a\n').patch).toBe(
      '@@ -1,1 +1,1 @@\n-a\n\\ No newline at end of file\n+a'
    );
  });
  it('uses actual line positions and separates distant hunks', () => {
    const original = Array.from({ length: 40 }, (_, i) => `line ${i + 1}\n`).join('');
    const modified = original.replace('line 10', 'ten').replace('line 30', 'thirty');
    const patch = createFileChange('a', { text: original }, modified).patch!;
    expect(patch).toContain('@@ -7,7 +7,7 @@');
    expect(patch).toContain('@@ -27,7 +27,7 @@');
    expect(patch).not.toContain('line 20');
  });
  it('does not invent changes for an unchanged or empty file', () => {
    expect(createFileChange('a', { text: 'same\n' }, 'same\n').patch).toBe('');
    expect(createFileChange('a', { text: null }, '')).toMatchObject({ status: 'added', patch: '' });
  });
  it('keeps unavailable before content distinct from a new file', () => {
    expect(createFileChange('a', { unavailable: 'unreadable' }, 'new')).toEqual({
      version: 1,
      path: 'a',
      status: 'unknown',
      unavailable: 'unreadable',
    });
    for (const unavailable of ['too-large', 'binary'] as const)
      expect(createFileChange('a', { unavailable }, 'new')).toEqual({
        version: 1,
        path: 'a',
        status: 'modified',
        unavailable,
      });
  });
  it('bounds file sizes, line counts, patch sizes, and comparison work', () => {
    for (const [before, after] of [
      ['', 'x'.repeat(REVIEW_FILE_BYTES + 1)],
      ['a\n'.repeat(2100), 'b\n'.repeat(2100)],
      ['a\n'.repeat(1100), 'b\n'.repeat(1100)],
      ['', 'x'.repeat(70_000)],
    ])
      expect(createFileChange('a', { text: before }, after).unavailable).toBe('too-large');
  });
  it('omits binary contents', () => {
    expect(createFileChange('a', { text: '\0old' }, 'new').unavailable).toBe('binary');
  });
});
