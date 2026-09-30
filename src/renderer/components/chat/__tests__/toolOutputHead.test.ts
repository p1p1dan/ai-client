import { describe, expect, it } from 'vitest';
import {
  DSH_OUTPUT_TRUNCATED_MARKER,
  dshShellOutputHead,
  isDshAbortedText,
  kilobytesLabel,
  startAtLine,
} from '../toolOutputHead';

/**
 * dsh-rebase P1-7e (problems 20 and 21, decision 140): a command's output that
 * lost its start opens on a whole line and says how much went before; DSH's
 * sentence for a stopped call is recognised so the row does not print it as
 * the command's output.
 */
describe('startAtLine', () => {
  it('[E2B-HEAD-1] a tail read from a byte offset drops its partial first line and counts it', () => {
    expect(startAtLine('ll-line 612 d2\nline 613 d2\nline 614 d2\n', 4096)).toEqual({
      text: 'line 613 d2\nline 614 d2\n',
      omittedBytes: 4096 + 'll-line 612 d2\n'.length,
    });
    // UTF-8 bytes, not characters: the ring counts bytes.
    expect(startAtLine('半行\nnext\n', 10).omittedBytes).toBe(10 + 7);
  });

  it('[E2B-HEAD-2] a whole output, or one unbroken line, stays as it is', () => {
    expect(startAtLine('first\nsecond\n', 0)).toEqual({ text: 'first\nsecond\n', omittedBytes: 0 });
    expect(startAtLine('one partial line', 300)).toEqual({
      text: 'one partial line',
      omittedBytes: 300,
    });
    // Only a trailing line break: dropping the line would leave nothing.
    expect(startAtLine('partial\n', 300)).toEqual({ text: 'partial\n', omittedBytes: 300 });
  });

  it('kilobytesLabel rounds as the jobs window does, never below 1 KB', () => {
    expect(kilobytesLabel(1)).toBe('1 KB');
    expect(kilobytesLabel(1536)).toBe('2 KB');
    expect(kilobytesLabel(10 * 1024)).toBe('10 KB');
  });
});

describe('dshShellOutputHead', () => {
  const marker = (path = '/tmp/dsh-spill-1/stdout') => `${DSH_OUTPUT_TRUNCATED_MARKER}${path}]`;

  it('[E2B-HEAD-3] DSH kept only the tail of stdout: the body starts on a whole line', () => {
    const output = `ll-line 612 d2\nline 613 d2\nline 614 d2${marker()}`;
    expect(dshShellOutputHead(output)).toEqual({
      text: `line 613 d2\nline 614 d2${marker()}`,
      headCut: true,
    });
    // Exit markers after the notice stay.
    const withExit = `${output}\n[exit code: 1]`;
    expect(dshShellOutputHead(withExit).text.endsWith('[exit code: 1]')).toBe(true);
  });

  it('[E2B-HEAD-4] a kept stdout that is one partial line is kept whole, still marked cut', () => {
    const output = `only part of a line${marker()}`;
    expect(dshShellOutputHead(output)).toEqual({ text: output, headCut: true });
  });

  it('[E2B-HEAD-5] untruncated stdout, or a truncated stderr only, is left alone', () => {
    expect(dshShellOutputHead('a\nb\n')).toEqual({ text: 'a\nb\n', headCut: false });
    const stderrOnly = `[stderr]\nwarn tail\nwarn end${marker('/tmp/x/stderr')}`;
    expect(dshShellOutputHead(stderrOnly)).toEqual({ text: stderrOnly, headCut: false });
    const stdoutWhole = `all of stdout\n[stderr]\nhalf a warn\nwarn end${marker('/tmp/x/stderr')}`;
    expect(dshShellOutputHead(stdoutWhole)).toEqual({ text: stdoutWhole, headCut: false });
  });
});

describe('isDshAbortedText', () => {
  it('[E2B-STOP-TEXT] is DSH’s whole sentence for a call Stop cut short, and only that', () => {
    expect(isDshAbortedText('Error: tool call aborted')).toBe(true);
    expect(isDshAbortedText('Error: tool call aborted\n')).toBe(true);
    expect(isDshAbortedText('partial\nError: tool call aborted')).toBe(false);
    expect(isDshAbortedText('a\n[stopped: user]')).toBe(false);
    expect(isDshAbortedText(undefined)).toBe(false);
  });
});
