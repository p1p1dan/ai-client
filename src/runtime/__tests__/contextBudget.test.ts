/**
 * P2-3 gate.
 *
 * The compaction thresholds are ported arithmetic (PI-Desktop `runtime.ts`),
 * and ported arithmetic is exactly the kind of code that looks obviously
 * correct and silently is not: every value is a clamp of a clamp, so a single
 * `Math.min` flipped to `Math.max` still returns a plausible number. These
 * tests pin the properties the clamps exist for — a small window must keep a
 * usable tail, a huge window must not carry the whole session forward, and the
 * guard must fire before the request that would overflow, not after it.
 */

import { describe, expect, it } from 'vitest';
import {
  AT_LIMIT_REMINDER,
  approachingReminder,
  COMPACTION_MAX_KEEP_RECENT_TOKENS,
  COMPACTION_MIN_KEEP_RECENT_TOKENS,
  COMPACTION_RETAINED_USER_MESSAGE_MAX_TOKENS,
  CONTEXT_FALLBACK_REMINDER_TOKENS,
  compactionNeeded,
  contextBudget,
  NO_REMINDERS_CLAIMED,
  remainingTokens,
  reminderThreshold,
  retainedUserMessageBudget,
  selectReminder,
} from '../plugins/context/budget.ts';

const SMALL = { contextWindow: 32_000, maxTokens: 4_096 };
const LARGE = { contextWindow: 1_000_000, maxTokens: 64_000 };

describe('contextBudget', () => {
  it('leaves a usable working budget on a 32K window', () => {
    const budget = contextBudget(SMALL, 0);
    // The reserve floor would swallow half of a small window, so it is itself
    // clamped; if that clamp is lost the hard limit collapses toward zero.
    expect(budget.hardLimit).toBeGreaterThan(0);
    expect(budget.hardLimit).toBeLessThan(SMALL.contextWindow);
    expect(budget.requestHeadroom).toBe(SMALL.contextWindow - budget.hardLimit);
  });

  it('never lets the retained tail exceed half the safe budget', () => {
    for (const window of [8_000, 32_000, 128_000, 1_000_000]) {
      const budget = contextBudget({ contextWindow: window }, 0);
      expect(budget.keepRecentTokens).toBeLessThanOrEqual(Math.floor(budget.hardLimit * 0.5));
      expect(budget.keepRecentTokens).toBeGreaterThan(0);
    }
  });

  it('bounds the retained tail at both ends across window sizes', () => {
    const large = contextBudget(LARGE, 0);
    expect(large.keepRecentTokens).toBe(COMPACTION_MAX_KEEP_RECENT_TOKENS);
    // A 128K window sits between the floor and the ceiling, so the ratio rules.
    const mid = contextBudget({ contextWindow: 128_000 }, 0);
    expect(mid.keepRecentTokens).toBeGreaterThanOrEqual(COMPACTION_MIN_KEEP_RECENT_TOKENS);
    expect(mid.keepRecentTokens).toBeLessThan(COMPACTION_MAX_KEEP_RECENT_TOKENS);
  });

  it('falls back to defaults when the catalog entry declares no window', () => {
    expect(contextBudget({}, 0).hardLimit).toBe(
      contextBudget({ contextWindow: 128_000 }, 0).hardLimit
    );
  });

  it('treats a negative token estimate as empty rather than as headroom', () => {
    expect(contextBudget(SMALL, -50).tokens).toBe(0);
  });
});

describe('compactionNeeded', () => {
  it('fires at the hard limit, not past it', () => {
    const budget = contextBudget(SMALL, 0);
    expect(compactionNeeded({ ...budget, tokens: budget.hardLimit - 1 })).toBe(false);
    expect(compactionNeeded({ ...budget, tokens: budget.hardLimit })).toBe(true);
  });

  it('stays off when compaction is disabled', () => {
    const budget = contextBudget(SMALL, 0);
    expect(compactionNeeded({ ...budget, tokens: budget.hardLimit * 2 }, false)).toBe(false);
  });
});

describe('retainedUserMessageBudget', () => {
  it('caps at Codex’s flat 20k on a large window', () => {
    expect(retainedUserMessageBudget(contextBudget(LARGE, 0))).toBe(
      COMPACTION_RETAINED_USER_MESSAGE_MAX_TOKENS
    );
  });

  it('never lets retention alone fill a small window', () => {
    const budget = contextBudget(SMALL, 0);
    expect(retainedUserMessageBudget(budget)).toBeLessThanOrEqual(
      Math.floor(budget.hardLimit * 0.5)
    );
  });
});

describe('selectReminder', () => {
  const budget = contextBudget({ contextWindow: 200_000 }, 0);
  const at = (tokens: number) => ({ ...budget, tokens });

  it('says nothing while there is room', () => {
    expect(selectReminder(at(0))).toBeUndefined();
    expect(selectReminder(at(budget.hardLimit - reminderThreshold(budget) - 1))).toBeUndefined();
  });

  it('warns once when the remaining budget crosses the threshold', () => {
    const crossing = at(budget.hardLimit - reminderThreshold(budget));
    const first = selectReminder(crossing, NO_REMINDERS_CLAIMED);
    expect(first?.tier).toBe('approaching');
    expect(first?.text).toContain('remain before this conversation is compacted');
    expect(selectReminder(crossing, first!.state)).toBeUndefined();
  });

  it('reports the actual remaining tokens in the warning', () => {
    const decision = selectReminder(at(budget.hardLimit - reminderThreshold(budget)));
    expect(decision?.text).toContain(
      remainingTokens(at(budget.hardLimit - reminderThreshold(budget))).toLocaleString('en-US')
    );
  });

  it('escalates at the limit and spends the first tier with it', () => {
    const decision = selectReminder(at(budget.hardLimit - CONTEXT_FALLBACK_REMINDER_TOKENS));
    expect(decision?.tier).toBe('at-limit');
    expect(decision?.text).toBe(AT_LIMIT_REMINDER);
    // A "you have room to wrap up" notice after "you are out of room" is noise.
    expect(decision?.state).toEqual({ approachingClaimed: true, atLimitClaimed: true });
    expect(selectReminder(at(budget.hardLimit), decision!.state)).toBeUndefined();
  });

  it('still escalates when the first tier already fired', () => {
    const decision = selectReminder(at(budget.hardLimit), {
      approachingClaimed: true,
      atLimitClaimed: false,
    });
    expect(decision?.tier).toBe('at-limit');
  });

  it('does not name a tool the runtime has not registered', () => {
    const decision = selectReminder(at(budget.hardLimit - reminderThreshold(budget)));
    expect(decision?.text).not.toContain('new_context');
  });

  it('invites the model to rotate the window only when the tool is passed in', () => {
    // The P1-9 ∥ P2-8 pairing rule, at the level that decides the wording: the
    // sentence exists exactly when the caller has a registered tool to name.
    const crossing = at(budget.hardLimit - reminderThreshold(budget));
    const decision = selectReminder(crossing, NO_REMINDERS_CLAIMED, {
      compactionTool: 'new_context',
    });
    expect(decision?.text).toContain(
      'You may call new_context to start the new window yourself once the current step is at a clean stopping point.'
    );
    // The at-limit tier does not repeat the invitation: at that point the next
    // request compacts anyway, so a choice is no longer on offer.
    expect(
      selectReminder(at(budget.hardLimit), NO_REMINDERS_CLAIMED, { compactionTool: 'new_context' })
        ?.text
    ).not.toContain('new_context');
  });

  it('keeps the invitation out of the default wording', () => {
    expect(approachingReminder(1_000)).not.toContain('new_context');
    expect(approachingReminder(1_000, {})).not.toContain('new_context');
  });
});
