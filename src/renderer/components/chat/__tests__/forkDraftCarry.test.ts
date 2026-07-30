import { beforeEach, describe, expect, it } from 'vitest';
import { consumeForkDraftCarry, markForkDraftCarry, resetForkDraftCarry } from '../forkDraftCarry';

describe('forkDraftCarry', () => {
  beforeEach(() => {
    resetForkDraftCarry();
  });

  it('consumes a matching mark and returns true', () => {
    markForkDraftCarry('session-a');
    expect(consumeForkDraftCarry('session-a')).toBe(true);
  });

  it('returns false when there is no mark at all', () => {
    expect(consumeForkDraftCarry('session-a')).toBe(false);
  });

  it('does not consume a mark set for a different session id', () => {
    markForkDraftCarry('session-a');
    expect(consumeForkDraftCarry('session-b')).toBe(false);
  });

  it('leaves the mark consumable by its real session id after a mismatched attempt', () => {
    markForkDraftCarry('session-a');
    expect(consumeForkDraftCarry('session-b')).toBe(false);
    expect(consumeForkDraftCarry('session-a')).toBe(true);
  });

  it('does not consume the same mark twice', () => {
    markForkDraftCarry('session-a');
    expect(consumeForkDraftCarry('session-a')).toBe(true);
    expect(consumeForkDraftCarry('session-a')).toBe(false);
  });

  it('a later mark for a different session replaces the earlier one', () => {
    markForkDraftCarry('session-a');
    markForkDraftCarry('session-b');
    expect(consumeForkDraftCarry('session-a')).toBe(false);
    expect(consumeForkDraftCarry('session-b')).toBe(true);
  });

  it('reset clears any pending mark', () => {
    markForkDraftCarry('session-a');
    resetForkDraftCarry();
    expect(consumeForkDraftCarry('session-a')).toBe(false);
  });
});
