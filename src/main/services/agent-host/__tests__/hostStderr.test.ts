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
      dropped: 0,
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

/**
 * main-aux-08 — the cap used to bound MEMORY only. A payload that never emits
 * a newline was cut into one 2000-char line per over-long chunk, so the tail
 * the cap's own comment calls "noise" was not dropped, just sliced. Those
 * slices then pushed the boot banner and the SDK stack out of the 50-line
 * crash-replay window, which is the one thing that window exists to hold.
 */
describe('drainStderrLines — an unterminated line is dropped, not sliced', () => {
  /** Feed chunks the way WorkerManager does, carrying both pieces of state. */
  function feed(chunks: readonly string[]): { lines: string[]; pending: string; dropped: number } {
    let pending = '';
    let dropped = 0;
    const lines: string[] = [];
    for (const chunk of chunks) {
      const drained = drainStderrLines(pending, chunk, dropped);
      pending = drained.pending;
      dropped = drained.dropped;
      lines.push(...drained.lines);
    }
    return { lines, pending, dropped };
  }

  it('emits one head plus one accounting line for a newline-free payload, however many chunks it takes', () => {
    const chunks = [
      'A'.repeat(MAX_STDERR_LINE_CHARS + 1),
      ...Array.from({ length: 20 }, () => 'B'.repeat(4000)),
      'C\n',
    ];
    const { lines, pending, dropped } = feed(chunks);

    // Before the fix this was 21 lines: one per over-long chunk.
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('A'.repeat(MAX_STDERR_LINE_CHARS) + TRUNCATION_SUFFIX);
    // The accounting is exact: everything that was not kept is counted.
    const total = chunks.join('').length - 1; // minus the newline itself
    expect(lines[1]).toBe(
      `…[dropped ${total - MAX_STDERR_LINE_CHARS} chars of an unterminated line]`
    );
    expect(pending).toBe('');
    expect(dropped).toBe(0);
  });

  it('resumes normal line assembly after the dropped line ends', () => {
    const { lines, pending } = feed([
      'Z'.repeat(MAX_STDERR_LINE_CHARS + 5),
      'more\nreal line\ntail',
    ]);
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe('real line');
    expect(pending).toBe('tail');
  });

  it('leaves the crash-replay window holding the boot banner a payload used to evict', () => {
    const banner = Array.from({ length: 10 }, (_, i) => `[agent-host] boot step ${i}`);
    let recent = pushRecentStderr([], banner);
    const { lines } = feed([
      ...Array.from({ length: 60 }, () => 'P'.repeat(MAX_STDERR_LINE_CHARS + 1)),
      '\n',
    ]);
    recent = pushRecentStderr(recent, lines);
    expect(recent).toHaveLength(12);
    expect(recent[0]).toBe('[agent-host] boot step 0');
  });

  it('carries the drop count into the final flush when the worker dies mid-line', () => {
    const { pending, dropped } = feed(['Q'.repeat(MAX_STDERR_LINE_CHARS + 750)]);
    expect(pending).toBe('');
    expect(flushStderrPending(pending, dropped)).toEqual([
      '…[dropped 750 chars of an unterminated line]',
    ]);
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
