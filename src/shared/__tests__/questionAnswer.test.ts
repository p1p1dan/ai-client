import { describe, expect, it } from 'vitest';
import {
  joinQuestionAnswer,
  QUESTION_ANSWER_SEPARATOR,
  splitQuestionAnswer,
} from '../questionAnswer';

/**
 * dsh-rebase decision 144: the one splitter the bridge (for the model) and the
 * frozen question card (for the reader) share. The P1-7d point-check (A11)
 * picked `tsc` and `smoke, then record` and typed `A11-OTHER, typed note`; the
 * model got it right, while the card showed one comma-joined line.
 */
const LABELS = ['tsc', 'smoke, then record', 'smoke'];

describe('joinQuestionAnswer / splitQuestionAnswer', () => {
  it('joins with the wire separator', () => {
    expect(QUESTION_ANSWER_SEPARATOR).toBe(', ');
    expect(joinQuestionAnswer(['tsc', 'smoke, then record', 'typed'])).toBe(
      'tsc, smoke, then record, typed'
    );
  });

  it('keeps a label that holds the separator whole, and the Other text verbatim', () => {
    expect(splitQuestionAnswer(LABELS, 'tsc, smoke, then record, A11-OTHER, typed note')).toEqual({
      selected: ['tsc', 'smoke, then record'],
      rest: 'A11-OTHER, typed note',
    });
  });

  it('prefers the longer label only where it ends at a separator or the end', () => {
    expect(splitQuestionAnswer(LABELS, 'smoke, tsc')).toEqual({
      selected: ['smoke', 'tsc'],
      rest: '',
    });
    expect(splitQuestionAnswer(LABELS, 'smoke, then record')).toEqual({
      selected: ['smoke, then record'],
      rest: '',
    });
  });

  it('reads a value that starts with no label as Other text alone', () => {
    expect(splitQuestionAnswer(LABELS, 'none of these, really')).toEqual({
      selected: [],
      rest: 'none of these, really',
    });
    expect(splitQuestionAnswer([], 'anything')).toEqual({ selected: [], rest: 'anything' });
  });

  it('round-trips labels picked in any order', () => {
    const parts = ['smoke, then record', 'tsc'];
    expect(splitQuestionAnswer(LABELS, joinQuestionAnswer(parts))).toEqual({
      selected: parts,
      rest: '',
    });
  });
});
