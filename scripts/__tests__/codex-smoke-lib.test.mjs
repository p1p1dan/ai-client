import { describe, expect, it } from 'vitest';

import { describeExit, isCleanExit } from '../codex-smoke-lib.mjs';

/**
 * Packaging spec §6.2 — the S2 "干净退出" assertion.
 *
 * The negative arms are the point of this file. The previous implementation
 * ignored `close`'s arguments and reported exitClean: true for every exit,
 * which made the Linux hard gate assert nothing beyond "close fired" — and no
 * test caught it, because only the success arm was ever exercised.
 */
describe('isCleanExit (spec §6.2)', () => {
  it('is true only for status 0 with no signal', () => {
    expect(isCleanExit({ code: 0, signal: null })).toBe(true);
    expect(isCleanExit({ code: 0, signal: undefined })).toBe(true);
  });

  it('is false for a non-zero exit status', () => {
    expect(isCleanExit({ code: 1, signal: null })).toBe(false);
    expect(isCleanExit({ code: 7, signal: null })).toBe(false);
    expect(isCleanExit({ code: 101, signal: null })).toBe(false);
  });

  it('is false for a signal death, including alongside code 0', () => {
    expect(isCleanExit({ code: null, signal: 'SIGTERM' })).toBe(false);
    expect(isCleanExit({ code: null, signal: 'SIGKILL' })).toBe(false);
    // Node reports (null, SIGNAL), but a caller passing both must not squeak
    // through on the code alone.
    expect(isCleanExit({ code: 0, signal: 'SIGKILL' })).toBe(false);
  });

  it('is false when there is no exit status at all', () => {
    expect(isCleanExit({ code: null, signal: null })).toBe(false);
    expect(isCleanExit({})).toBe(false);
  });
});

describe('describeExit', () => {
  it('names the signal when one killed the process', () => {
    expect(describeExit({ code: null, signal: 'SIGKILL' })).toBe('signal SIGKILL');
  });

  it('names the code otherwise, including 0', () => {
    expect(describeExit({ code: 0, signal: null })).toBe('code 0');
    expect(describeExit({ code: 3, signal: null })).toBe('code 3');
  });

  it('says so when neither is available', () => {
    expect(describeExit({ code: null, signal: null })).toBe('no exit status');
  });
});
