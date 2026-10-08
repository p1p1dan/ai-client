/**
 * Pure LC-0/1/2 gate thresholds and judging logic for the P1-8 long-session
 * contention regression (decisions 067, 081, 158; plan P1-8 shard 05 §4).
 * Factored out of contention-regression.ts so this logic has a side-effect
 * free unit-test entry point: that script's `process.exitCode = await
 * main()` runs for real (spawns the fake gateway and real DSH hosts) the
 * moment the module is imported, which a unit test must never trigger.
 */

import { median } from './kit.ts';

export type Scenario = 'LC-0' | 'LC-1' | 'LC-2';

/**
 * The victim's pacing (P8-VICTIM). contention-regression.ts's lc2() paces
 * the victim's own deltas with this constant, and the LC-2 victim-gap gate
 * below pulls the same constant for its "pacing" term — one source, not two
 * numbers that happen to match (decision 158).
 */
export const VICTIM_CHUNK_MS = 150;

/** Decision 067 / shard 05 §4; LC-2's victim-gap margin revised by decision 158. */
export const GATES = {
  'LC-0': { hard: { eldMs: 50, rssMb: 300 }, soft: { eldMs: 10, rssMb: 230 } },
  'LC-1': { hard: { eldMs: 150, rssMb: 350 }, soft: { eldMs: 60, rssMb: 260 } },
  'LC-2': {
    hard: {
      eldMs: 1000,
      rssMb: 600,
      // Decision 158: the gate used to read "gap <= ELD + 150 ms", where the
      // 150 happened to equal VICTIM_CHUNK_MS, leaving zero margin for
      // process-scheduling / IPC jitter outside the host's own event loop.
      // victimPacingMs pulls that same pacing constant; victimJitterMs is the
      // explicit margin added on top of it.
      victimPacingMs: VICTIM_CHUNK_MS,
      victimJitterMs: 100,
      pongRttMs: 2000,
    },
    soft: { eldMs: 450, rssMb: 450 },
  },
} as const;

export interface PingStats {
  pings: number;
  answered: number;
  unanswered: number;
  maxRttMs: number;
  eldMaxMs: number;
  rssMaxMb: number;
  rssLastMb: number;
}

export interface GateResult {
  hard: Record<string, boolean>;
  softWarnings: string[];
  numbers: Record<string, number[]>;
}

export function judge(scenario: Scenario, results: Array<Record<string, unknown>>): GateResult {
  const gates = GATES[scenario];
  const pings = results.map((r) => (r.pings ?? {}) as PingStats);
  const eld = pings.map((p) => p.eldMaxMs);
  const rss = pings.map((p) => p.rssMaxMb);
  const hard: Record<string, boolean> = {
    [`${scenario} ELD <= ${gates.hard.eldMs} ms`]: eld.every((v) => v <= gates.hard.eldMs),
    [`${scenario} RSS <= ${gates.hard.rssMb} MB`]: rss.every((v) => v <= gates.hard.rssMb),
  };
  const numbers: Record<string, number[]> = { eldMaxMs: eld, rssMaxMb: rss };
  if (scenario === 'LC-1') {
    const turns = results.flatMap((r) => (r.turns ?? []) as Array<Record<string, unknown>>);
    hard['LC-1 8 x 200 deltas, each on its own channel'] =
      results.every((r) => ((r.turns ?? []) as Array<Record<string, unknown>>).length === 8) &&
      turns.every((t) => t.stamps === 200 && t.foreignEvents === 0);
    hard['LC-1 all turns completed'] = turns.every((t) => t.completed === true);
  }
  if (scenario === 'LC-2') {
    const lc2Gates = GATES['LC-2'].hard;
    hard['LC-2 no host error'] = results.every((r) => r.error === undefined);
    hard['LC-2 victim deltas stamped'] = results.every(
      (r) => Number((r.victim as Record<string, unknown> | undefined)?.stamped ?? 0) >= 60
    );
    hard['LC-2 5 turns completed'] = results.every(
      (r) =>
        ((r.recalls ?? []) as Array<Record<string, unknown>>).filter((t) => t.completed === true)
          .length === 4 && (r.victim as Record<string, unknown> | undefined)?.completed === true
    );
    const gaps = results.map((r) =>
      Number((r.victim as Record<string, unknown> | undefined)?.maxGapMs ?? Infinity)
    );
    numbers.victimMaxGapMs = gaps;
    // Decision 158: the budget is spelled out as pacing + jitter, not one
    // opaque number, and the judgment name below says so too.
    const victimGapBudgetMs = lc2Gates.victimPacingMs + lc2Gates.victimJitterMs;
    hard[
      `LC-2 victim gap <= ELD + ${lc2Gates.victimPacingMs} ms pacing + ${lc2Gates.victimJitterMs} ms jitter`
    ] = results.every((_r, i) => (gaps[i] ?? Infinity) <= (eld[i] ?? 0) + victimGapBudgetMs);
    hard['LC-2 every ping answered'] = pings.every((p) => p.unanswered === 0 && p.answered > 0);
    numbers.maxPongRttMs = pings.map((p) => p.maxRttMs);
    hard[`LC-2 no pong slower than ${lc2Gates.pongRttMs} ms`] = pings.every(
      (p) => p.maxRttMs <= lc2Gates.pongRttMs
    );
  }
  const softWarnings: string[] = [];
  if (median(eld) > gates.soft.eldMs)
    softWarnings.push(`${scenario} ELD median ${median(eld)} ms > soft ${gates.soft.eldMs} ms`);
  if (median(rss) > gates.soft.rssMb)
    softWarnings.push(`${scenario} RSS median ${median(rss)} MB > soft ${gates.soft.rssMb} MB`);
  return { hard, softWarnings, numbers };
}
