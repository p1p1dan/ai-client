import { describe, expect, it } from 'vitest';
import {
  DIFF_SPLIT_MIN_WIDTH,
  diffTooNarrowToSplit,
  effectiveDiffLayout,
  sanitizeDiffLayout,
} from '../diffLayout';

describe('diff layout preference (PiLab R2, FR-07.3)', () => {
  it('defaults to unified and keeps only values this build knows', () => {
    expect(sanitizeDiffLayout(undefined)).toEqual({ layout: 'unified' });
    expect(sanitizeDiffLayout({ layout: 'split' })).toEqual({ layout: 'split' });
    expect(sanitizeDiffLayout({ layout: 'sideways' })).toEqual({ layout: 'unified' });
  });

  it('stacks a split diff that is too narrow, without changing the choice', () => {
    expect(effectiveDiffLayout('split', DIFF_SPLIT_MIN_WIDTH - 1)).toBe('unified');
    expect(effectiveDiffLayout('split', DIFF_SPLIT_MIN_WIDTH)).toBe('split');
    expect(effectiveDiffLayout('split', null)).toBe('split');
    expect(effectiveDiffLayout('unified', 2000)).toBe('unified');
    // The switch greys out on width alone, whatever is chosen.
    expect(diffTooNarrowToSplit(DIFF_SPLIT_MIN_WIDTH - 1)).toBe(true);
    expect(diffTooNarrowToSplit(null)).toBe(false);
  });
});
