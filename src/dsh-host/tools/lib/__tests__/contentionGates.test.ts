import { describe, expect, it } from 'vitest';
import { GATES, judge, VICTIM_CHUNK_MS } from '../contentionGates.ts';

/**
 * Decision 158: the LC-2 victim-gap hard gate used to read "gap <= ELD +
 * 150 ms" with the 150 happening to equal the victim's own pacing
 * (VICTIM_CHUNK_MS) and zero margin for scheduling/IPC jitter outside the
 * host's own event loop — real runs exceeded it by 28.2 ms (dev box,
 * 2026-10-07) and 12.6 ms (CI, 2026-10-08). The gate now adds an explicit
 * `victimJitterMs` on top of the pacing term.
 */

function lc2Row(gapMs: number, eldMs: number): Record<string, unknown> {
  return {
    pings: {
      pings: 5,
      answered: 5,
      unanswered: 0,
      maxRttMs: 10,
      eldMaxMs: eldMs,
      rssMaxMb: 100,
      rssLastMb: 100,
    },
    victim: {
      streamed: true,
      completed: true,
      deltas: 60,
      stamped: 60,
      maxGapMs: gapMs,
      rawMaxGapMs: gapMs,
      medianRawGapMs: gapMs,
      maxDeliveryLatencyMs: 1,
      medianDeliveryLatencyMs: 1,
    },
    recalls: [
      { logical: 'a', completed: true, ms: 1, reply: '' },
      { logical: 'b', completed: true, ms: 1, reply: '' },
      { logical: 'c', completed: true, ms: 1, reply: '' },
      { logical: 'd', completed: true, ms: 1, reply: '' },
    ],
  };
}

const lc2Gates = GATES['LC-2'].hard;
const gateName = `LC-2 victim gap <= ELD + ${lc2Gates.victimPacingMs} ms pacing + ${lc2Gates.victimJitterMs} ms jitter`;

describe('contentionGates: LC-2 victim gap (decision 158)', () => {
  it('derives the gate pacing term from VICTIM_CHUNK_MS, not a second literal', () => {
    expect(lc2Gates.victimPacingMs).toBe(VICTIM_CHUNK_MS);
  });

  it('names the judgment with the pacing and jitter terms spelled out', () => {
    const result = judge('LC-2', [lc2Row(0, 0)]);
    expect(Object.keys(result.hard)).toContain(gateName);
  });

  it('passes when the gap is within ELD + pacing + jitter', () => {
    const eldMs = 50;
    const gapMs = eldMs + lc2Gates.victimPacingMs + (lc2Gates.victimJitterMs - 1);
    const result = judge('LC-2', [lc2Row(gapMs, eldMs)]);
    expect(result.hard[gateName]).toBe(true);
  });

  it('fails when the gap exceeds ELD + pacing + jitter', () => {
    const eldMs = 50;
    const gapMs = eldMs + lc2Gates.victimPacingMs + (lc2Gates.victimJitterMs + 1);
    const result = judge('LC-2', [lc2Row(gapMs, eldMs)]);
    expect(result.hard[gateName]).toBe(false);
  });

  it('would have failed on the pre-158 gate (ELD + pacing only) for both real-world excesses', () => {
    // 2026-10-07 dev box: gap 249.6 ms, ELD 71.4 ms -> excess over ELD + 150 is 28.2 ms.
    // 2026-10-08 CI run 37709934981: gap 184.9 ms, ELD 22.3 ms -> excess over ELD + 150 is 12.6 ms.
    const devBox = { gapMs: 249.6, eldMs: 71.4 };
    const ci = { gapMs: 184.9, eldMs: 22.3 };
    for (const sample of [devBox, ci]) {
      expect(sample.gapMs).toBeGreaterThan(sample.eldMs + VICTIM_CHUNK_MS);
      const result = judge('LC-2', [lc2Row(sample.gapMs, sample.eldMs)]);
      expect(result.hard[gateName]).toBe(true);
    }
  });
});
