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

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  createSendWaitBudget,
  HOST_STALL_TIMEOUT_MS,
  HOST_TTFT_TIMEOUT_MS,
  SEND_SILENCE_CEILING_MS,
  SEND_WAIT_LOOP_BOUND_MS,
} from '../sendBudgets';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOST_RUNTIME_PATH = path.resolve(__dirname, '../../../../agent-host/claudeRuntime.ts');

describe('send budget constants (F2 C-01/C-02)', () => {
  it('[C-01] the ordered chain holds: TTFT < STALL < SILENCE <= LOOP_BOUND', () => {
    expect(HOST_TTFT_TIMEOUT_MS).toBeLessThan(HOST_STALL_TIMEOUT_MS);
    expect(HOST_STALL_TIMEOUT_MS).toBeLessThan(SEND_SILENCE_CEILING_MS);
    expect(SEND_SILENCE_CEILING_MS).toBeLessThanOrEqual(SEND_WAIT_LOOP_BOUND_MS);
  });

  it('[C-02] REVERSED invariant: the renderer silence ceiling is ABOVE the Host stall watchdog, so the Host always speaks first', () => {
    // The retired `[T-06]` asserted `SEND_TIMEOUT_CEILING_MS < HOST_STALL_TIMEOUT_MS`
    // — literally the opposite claim. The R9 shape (system/init then permanent
    // silence) is terminated by the STALL watchdog, and that is the only span
    // in which the renderer is still waiting, so the ceiling has to outlive it.
    expect(SEND_SILENCE_CEILING_MS).toBeGreaterThan(HOST_STALL_TIMEOUT_MS);
  });
});

/**
 * [C-03] source mirror lock.
 *
 * `attachmentLimits.ts` claimed its mirrors were "locked by a unit test", but
 * the old test only compared the mirrors against EACH OTHER — both could drift
 * from the Host together and stay green. This reads the Host source text,
 * which is the only truth a renderer test can reach across the program
 * boundary (`src/agent-host` is a separate program and cannot be imported).
 */
describe('Host mirror lock (F2 C-03)', () => {
  const hostSource = readFileSync(HOST_RUNTIME_PATH, 'utf8');

  function hostConstant(name: string): number {
    const match = new RegExp(`\\bconst ${name} = ([0-9_]+);`).exec(hostSource);
    // A rename must fail loudly rather than silently skip the comparison.
    expect(match, `claudeRuntime.ts no longer declares ${name}`).not.toBeNull();
    return Number((match as RegExpExecArray)[1].replace(/_/g, ''));
  }

  it('[C-03] HOST_STALL_TIMEOUT_MS mirrors claudeRuntime.ts DEFAULT_STALL_TIMEOUT_MS', () => {
    expect(HOST_STALL_TIMEOUT_MS).toBe(hostConstant('DEFAULT_STALL_TIMEOUT_MS'));
  });

  it('[C-03] HOST_TTFT_TIMEOUT_MS mirrors claudeRuntime.ts DEFAULT_TTFT_TIMEOUT_MS', () => {
    expect(HOST_TTFT_TIMEOUT_MS).toBe(hostConstant('DEFAULT_TTFT_TIMEOUT_MS'));
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
