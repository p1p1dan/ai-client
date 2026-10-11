import { describe, expect, it } from 'vitest';
import {
  COMPACT_INSTRUCTIONS_MAX_CHARS,
  COMPACT_INSTRUCTIONS_NOTE_KEY,
  compactInstructionsNoteText,
  readCompactInstructions,
} from '../compactInstructions';
import { translate } from '../i18n';

/**
 * dsh-rebase decision 179 — the text after `/compact`, as the composer, the
 * bridge and the history read it: plain text, trimmed, at most 2000
 * characters (a CJK character counts one).
 */
describe('readCompactInstructions (decision 179)', () => {
  it('[179-IN-01] none: absent, not a string, blank', () => {
    expect(readCompactInstructions(undefined)).toEqual({ kind: 'none' });
    expect(readCompactInstructions(42)).toEqual({ kind: 'none' });
    expect(readCompactInstructions(' \n\t\r\n ')).toEqual({ kind: 'none' });
  });

  it('[179-IN-02] plain text: line endings as \\n, control characters dropped, ends trimmed', () => {
    expect(
      readCompactInstructions('  保留未完成的任务\r\n和失败经验\r\u0000\u001b\u007f\tend  ')
    ).toEqual({
      kind: 'ok',
      text: '保留未完成的任务\n和失败经验\n\tend',
    });
    // Markup is not interpreted: it is text like any other.
    expect(readCompactInstructions('<b>keep</b> `this`')).toEqual({
      kind: 'ok',
      text: '<b>keep</b> `this`',
    });
  });

  it('[179-IN-03] up to the limit is taken; one more is refused whole, counted in characters', () => {
    expect(COMPACT_INSTRUCTIONS_MAX_CHARS).toBe(2000);
    expect(readCompactInstructions('字'.repeat(2000))).toEqual({
      kind: 'ok',
      text: '字'.repeat(2000),
    });
    // Astral characters count one each, as a person counts them.
    expect(readCompactInstructions('😀'.repeat(2000))).toMatchObject({ kind: 'ok' });
    expect(readCompactInstructions('字'.repeat(2001))).toEqual({
      kind: 'too-long',
      length: 2001,
      max: 2000,
    });
  });

  it('[179-IN-04] the summary line: English rendering and the dictionary entry, instructions as typed', () => {
    expect(compactInstructionsNoteText('keep $1 and $&')).toBe(
      'Instructions for this summary: keep $1 and $&'
    );
    expect(translate('zh', COMPACT_INSTRUCTIONS_NOTE_KEY, { instructions: '保留 {{x}}' })).toBe(
      '本次压缩的附加说明：保留 {{x}}'
    );
  });
});
