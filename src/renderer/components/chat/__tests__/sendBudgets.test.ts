/**
 * F2 S2 (2026-08-18 watchdog redesign) — the renderer's send-wait budgets.
 *
 * Two halves live here:
 *
 *  - The REVERSED cross-program invariant. `attachmentLimits.test.ts`'s
 *    `[T-06]` / `[a4]` used to lock the opposite direction ("the renderer's
 *    ceiling elapses first"); they are retired rather than renumbered,
 *    because renumbering would hide the fact that the direction flipped.
 *  - `createSendWaitBudget`, a pure resettable budget with no timer, no
 *    store and no React, so `runSend`'s wait can be asserted without a clock.
 *
 * Time is injected everywhere (`nowMs` arguments) — nothing here waits.
 */

import { describe, expect, it } from 'vitest';
import {
  createSendWaitBudget,
  SEND_SILENCE_CEILING_MS,
  SEND_WAIT_LOOP_BOUND_MS,
} from '../sendBudgets';

describe('send budget constants', () => {
  it('keeps the renderer silence ceiling within the absolute loop bound', () => {
    expect(SEND_SILENCE_CEILING_MS).toBeLessThanOrEqual(SEND_WAIT_LOOP_BOUND_MS);
  });
});

describe('createSendWaitBudget (F2 C-04)', () => {
  const T0 = 1_000_000;

  it('[C-04-1] with no liveness frame it expires exactly at the silence ceiling', () => {
    const budget = createSendWaitBudget(T0);
    expect(budget.lastLivenessAtMs()).toBe(T0);
    expect(budget.isExpired(T0)).toBe(false);
    expect(budget.isExpired(T0 + SEND_SILENCE_CEILING_MS - 1)).toBe(false);
    expect(budget.isExpired(T0 + SEND_SILENCE_CEILING_MS)).toBe(true);
  });

  it('[C-04-2] a liveness frame resets it to a FULL silence budget again', () => {
    // 60ms override instead of the real 300s — the arithmetic is identical and
    // nothing here sleeps.
    const budget = createSendWaitBudget(T0, { silenceCeilingMs: 60, loopBoundMs: 100_000 });
    expect(budget.isExpired(T0 + 59)).toBe(false);
    budget.markLiveness(T0 + 59);
    expect(budget.lastLivenessAtMs()).toBe(T0 + 59);
    // The original deadline passes with no expiry — this is the whole point.
    expect(budget.isExpired(T0 + 60)).toBe(false);
    expect(budget.isExpired(T0 + 118)).toBe(false);
    expect(budget.isExpired(T0 + 119)).toBe(true);
  });

  it('[C-04-3] an endless liveness stream still hits the absolute loop bound', () => {
    const budget = createSendWaitBudget(T0, { silenceCeilingMs: 60, loopBoundMs: 500 });
    for (let now = T0; now < T0 + 500; now += 20) {
      budget.markLiveness(now);
      expect(budget.isExpired(now)).toBe(false);
    }
    budget.markLiveness(T0 + 500);
    expect(budget.isExpired(T0 + 500)).toBe(true);
  });

  it('[C-04-4] markLiveness never moves the last-liveness stamp backwards', () => {
    const budget = createSendWaitBudget(T0, { silenceCeilingMs: 60, loopBoundMs: 100_000 });
    budget.markLiveness(T0 + 40);
    budget.markLiveness(T0 + 10);
    expect(budget.lastLivenessAtMs()).toBe(T0 + 40);
    expect(budget.isExpired(T0 + 99)).toBe(false);
    expect(budget.isExpired(T0 + 100)).toBe(true);
  });
});
