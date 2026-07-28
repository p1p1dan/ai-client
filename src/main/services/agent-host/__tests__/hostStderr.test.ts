import { describe, expect, it } from 'vitest';
import {
  drainStderrLines,
  flushStderrPending,
  MAX_STDERR_LINE_CHARS,
  pushRecentStderr,
  RECENT_STDERR_LIMIT,
  TRUNCATION_SUFFIX,
} from '../hostStderr';

describe('drainStderrLines', () => {
  it('emits a complete line and keeps nothing pending', () => {
    expect(drainStderrLines('', '[agent-host] starting\n')).toEqual({
      lines: ['[agent-host] starting'],
      pending: '',
    });
  });

  it('splits several lines out of one chunk', () => {
    const { lines, pending } = drainStderrLines('', 'first\nsecond\nthird\n');
    expect(lines).toEqual(['first', 'second', 'third']);
    expect(pending).toBe('');
  });

  it('holds an incomplete tail until the next chunk completes it', () => {
    const first = drainStderrLines('', 'cometix reso');
    expect(first.lines).toEqual([]);
    expect(first.pending).toBe('cometix reso');

    const second = drainStderrLines(first.pending, 'lved\n');
    expect(second.lines).toEqual(['cometix resolved']);
    expect(second.pending).toBe('');
  });

  it('handles CRLF line endings', () => {
    const { lines, pending } = drainStderrLines('', 'a\r\nb\r\n');
    expect(lines).toEqual(['a', 'b']);
    expect(pending).toBe('');
  });

  it('drops blank lines the Host uses as block separators', () => {
    const { lines } = drainStderrLines('', 'a\n\n   \nb\n');
    expect(lines).toEqual(['a', 'b']);
  });

  it('truncates an over-long complete line', () => {
    const long = 'x'.repeat(MAX_STDERR_LINE_CHARS + 500);
    const { lines } = drainStderrLines('', `${long}\n`);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('x'.repeat(MAX_STDERR_LINE_CHARS) + TRUNCATION_SUFFIX);
  });

  it('flushes a newline-free tail once it passes the cap so pending cannot grow unbounded', () => {
    const long = 'y'.repeat(MAX_STDERR_LINE_CHARS + 1);
    const { lines, pending } = drainStderrLines('', long);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('y'.repeat(MAX_STDERR_LINE_CHARS) + TRUNCATION_SUFFIX);
    expect(pending).toBe('');
  });

  it('keeps a sub-cap tail pending rather than logging a partial line', () => {
    const { lines, pending } = drainStderrLines('', 'y'.repeat(MAX_STDERR_LINE_CHARS));
    expect(lines).toEqual([]);
    expect(pending).toHaveLength(MAX_STDERR_LINE_CHARS);
  });
});

describe('flushStderrPending', () => {
  it('emits the final unterminated line', () => {
    expect(flushStderrPending('last words')).toEqual(['last words']);
  });

  it('emits nothing for an empty or blank buffer', () => {
    expect(flushStderrPending('')).toEqual([]);
    expect(flushStderrPending('   ')).toEqual([]);
  });

  it('truncates an over-long final line', () => {
    const long = 'z'.repeat(MAX_STDERR_LINE_CHARS + 10);
    expect(flushStderrPending(long)).toEqual([
      'z'.repeat(MAX_STDERR_LINE_CHARS) + TRUNCATION_SUFFIX,
    ]);
  });
});

describe('pushRecentStderr', () => {
  it('appends new lines', () => {
    expect(pushRecentStderr(['a'], ['b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('returns a copy when there is nothing to add', () => {
    const recent = ['a'];
    const next = pushRecentStderr(recent, []);
    expect(next).toEqual(['a']);
    expect(next).not.toBe(recent);
  });

  it('keeps only the most recent lines once past the limit', () => {
    const recent = Array.from({ length: RECENT_STDERR_LIMIT }, (_, i) => `line-${i}`);
    const next = pushRecentStderr(recent, ['newest']);
    expect(next).toHaveLength(RECENT_STDERR_LIMIT);
    expect(next.at(-1)).toBe('newest');
    expect(next[0]).toBe('line-1');
  });
});
