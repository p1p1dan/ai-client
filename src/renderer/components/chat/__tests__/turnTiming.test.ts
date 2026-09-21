import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ChatBlock, ChatMessage } from '@/stores/chatSessions';
import {
  deriveTurnElapsedMs,
  deriveTurnStats,
  deriveTurnWorkedMs,
  formatThoughtRow,
  formatWorkedForDuration,
  formatWorkedForRow,
  initialTurnTimingRegistry,
  reduceTurnTiming,
  splitWorkedForDuration,
  type TurnSpanMetadata,
  turnHasThinkingOnlyProcess,
} from '../turnTiming';

/**
 * Source text of one top-level `export function name(...) { ... }` body.
 * Skips the parameter list first -- an inline param type (`input: { ... }`)
 * would otherwise be mistaken for the body.
 */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`export function ${name}(`);
  if (start === -1) throw new Error(`function ${name} not found`);
  let parens = 0;
  let afterParams = -1;
  for (let i = source.indexOf('(', start); i < source.length; i += 1) {
    if (source[i] === '(') parens += 1;
    else if (source[i] === ')') {
      parens -= 1;
      if (parens === 0) {
        afterParams = i + 1;
        break;
      }
    }
  }
  if (afterParams === -1) throw new Error(`unbalanced parens in ${name}`);
  const open = source.indexOf('{', afterParams);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

function countOccurrences(source: string, pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0;
}

function event(
  type: string,
  opts: { blockId?: string; timestamp?: number; messageId?: string } = {}
): { type: string; timestamp?: number; payload?: Record<string, unknown> } {
  return {
    type,
    timestamp: opts.timestamp,
    payload: { messageId: opts.messageId ?? 'm1', blockId: opts.blockId },
  };
}

describe('reduceTurnTiming', () => {
  it('records thinking.started as startedAt', () => {
    const next = reduceTurnTiming(
      initialTurnTimingRegistry,
      event('thinking.started', { blockId: 'th1', timestamp: 1000 })
    );
    expect(next.byBlock.th1).toEqual({ startedAt: 1000 });
  });

  it('fills in completedAt and durationMs on thinking.completed', () => {
    let reg = reduceTurnTiming(
      initialTurnTimingRegistry,
      event('thinking.started', { blockId: 'th1', timestamp: 1000 })
    );
    reg = reduceTurnTiming(reg, event('thinking.completed', { blockId: 'th1', timestamp: 4000 }));
    expect(reg.byBlock.th1).toEqual({ startedAt: 1000, completedAt: 4000, durationMs: 3000 });
  });

  it('leaves durationMs null when completed arrives without a prior started', () => {
    const reg = reduceTurnTiming(
      initialTurnTimingRegistry,
      event('thinking.completed', { blockId: 'th1', timestamp: 4000 })
    );
    expect(reg.byBlock.th1.durationMs).toBeNull();
  });

  it('ignores unrelated events, returning the same registry reference', () => {
    const reg = reduceTurnTiming(
      initialTurnTimingRegistry,
      event('thinking.started', { blockId: 'th1', timestamp: 1000 })
    );
    expect(reduceTurnTiming(reg, event('tool.started', { blockId: 'x' }))).toBe(reg);
    expect(reduceTurnTiming(reg, event('message.completed'))).toBe(reg);
  });

  it('keeps multiple blockIds independent', () => {
    let reg = reduceTurnTiming(
      initialTurnTimingRegistry,
      event('thinking.started', { blockId: 'a', timestamp: 0 })
    );
    reg = reduceTurnTiming(reg, event('thinking.started', { blockId: 'b', timestamp: 10 }));
    reg = reduceTurnTiming(reg, event('thinking.completed', { blockId: 'a', timestamp: 5 }));
    expect(reg.byBlock.a).toEqual({ startedAt: 0, completedAt: 5, durationMs: 5 });
    expect(reg.byBlock.b).toEqual({ startedAt: 10 });
  });
});

describe('formatThoughtRow', () => {
  it('shows "briefly" under the 5s threshold', () => {
    expect(formatThoughtRow({ durationMs: 3000 })).toEqual({
      verb: 'Thought',
      arg: 'briefly',
      argKind: 'prose',
    });
  });

  it('shows "for Ns" at/above the threshold', () => {
    expect(formatThoughtRow({ durationMs: 12_000 })).toEqual({
      verb: 'Thought',
      arg: 'for 12s',
      argKind: 'prose',
    });
  });

  it('shows a bare "Thought" with no arg when duration is null (never fabricates seconds)', () => {
    expect(formatThoughtRow({ durationMs: null })).toEqual({ verb: 'Thought' });
  });

  it('shows "Thinking" with no arg while streaming', () => {
    expect(formatThoughtRow({ streaming: true, durationMs: 9000 })).toEqual({ verb: 'Thinking' });
  });

  it('D25 §2.4: "briefly" and "for Ns" args are prose, not an identifier (sans, not mono)', () => {
    expect(formatThoughtRow({ durationMs: 3000 }).argKind).toBe('prose');
    expect(formatThoughtRow({ durationMs: 12_000 }).argKind).toBe('prose');
  });

  // [FB8-1] The reported defect: 1702000ms rendered as a bare "for 1702s".
  it('[FB8-1] converts to minutes past 60s instead of printing bare seconds', () => {
    expect(formatThoughtRow({ durationMs: 1_702_000 }).arg).toBe('for 28m 22s');
    expect(formatThoughtRow({ durationMs: 66_000 }).arg).toBe('for 1m 6s');
    expect(formatThoughtRow({ durationMs: 120_000 }).arg).toBe('for 2m');
  });

  it('[FB8-1] leaves the sub-minute arm untouched', () => {
    expect(formatThoughtRow({ durationMs: 12_000 }).arg).toBe('for 12s');
    expect(formatThoughtRow({ durationMs: 59_000 }).arg).toBe('for 59s');
  });

  // [FB8-2] One definition of "how a minute is written". A copied conversion
  // would drift; this pins the two rows to the same formatter.
  it('[FB8-2] the duration fragment is verbatim formatWorkedForDuration output', () => {
    for (const ms of [5000, 12_000, 59_000, 60_000, 66_000, 120_000, 1_702_000, 7_200_000]) {
      expect(formatThoughtRow({ durationMs: ms }).arg).toBe(`for ${formatWorkedForDuration(ms)}`);
    }
  });

  // [FB8-2] source half. The behavioural assertion above cannot tell reuse from
  // a faithful copy -- a duplicated conversion produces identical output and
  // rides along green (verified: mutation M-24 survived the behavioural arm
  // alone). Only the source can pin "one definition, repo-wide".
  it('[FB8-2] formatThoughtRow calls the shared formatter, with no second seconds-to-minutes conversion', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../turnTiming.ts', import.meta.url)),
      'utf8'
    );
    const body = functionBody(source, 'formatThoughtRow');
    expect(body).toContain('formatWorkedForDuration(input.durationMs)');
    // The conversion's fingerprints must live in exactly one function.
    expect(body).not.toMatch(/\/\s*1000/);
    expect(body).not.toMatch(/%\s*60/);
    expect(countOccurrences(source, /%\s*60/g)).toBe(1);
    // 2026-09-18: the arithmetic moved down one level, into
    // `splitWorkedForDuration`, so the work-group head can reach the NUMBERS
    // (「已工作 1 分 6 秒」) without an English "1m 6s" being interpolated into a
    // Chinese sentence. The claim is unchanged — still exactly one place that
    // knows how many seconds a minute has — only the function's name moved.
    expect(countOccurrences(source, /Math\.floor\(total \/ 60\)/g)).toBe(1);
    expect(functionBody(source, 'formatWorkedForDuration')).toContain(
      'splitWorkedForDuration(latencyMs)'
    );
  });

  // §7.2 / Q8: no hour tier in this batch -- pinned so adding one is a
  // deliberate, visible change to BOTH rows (it is a separate ticket).
  it('[FB8-2] has no hour tier yet, in lockstep with the turn head', () => {
    expect(formatThoughtRow({ durationMs: 3_600_000 }).arg).toBe('for 60m');
    expect(formatWorkedForDuration(3_600_000)).toBe('60m');
  });
});

describe('formatWorkedForRow', () => {
  it('rounds 31000ms to "Worked for 31s"', () => {
    expect(formatWorkedForRow(31_000)).toEqual({
      verb: 'Worked for',
      arg: '31s',
      argKind: 'prose',
    });
  });

  it('never shows 0s -- 400ms rounds up to "Worked for 1s"', () => {
    expect(formatWorkedForRow(400)).toEqual({ verb: 'Worked for', arg: '1s', argKind: 'prose' });
  });

  // F-B12 (T-31, A07 :2399): the never-fabricate-seconds guard. A history
  // message hydrated without T-06 metadata has no measured duration, and the
  // row must be omitted rather than shown as "0s"/"1s". The stats argument
  // added by T-31 must not create a second path that renders a row anyway.
  it('F-B12: returns null (row does not render) when latencyMs is null, stats or not', () => {
    expect(formatWorkedForRow(null)).toBeNull();
    expect(formatWorkedForRow(undefined)).toBeNull();
    expect(formatWorkedForRow(null, '3 tools, 11 searches')).toBeNull();
  });

  it('F-B12: 66000ms reads as "1m 6s", not "66s"', () => {
    expect(formatWorkedForRow(66_000)?.arg).toContain('1m 6s');
    expect(formatWorkedForRow(66_000)?.arg).toBe('1m 6s');
  });

  it('F-B12: appends the turn stats to the same arg (§4.2 — counts move up into the collapsed row)', () => {
    expect(formatWorkedForRow(66_000, '3 tools, 11 searches')).toEqual({
      verb: 'Worked for',
      arg: '1m 6s · 3 tools, 11 searches',
      argKind: 'prose',
    });
  });

  it('F-B12: an absent or empty stats value leaves the duration arg untouched', () => {
    expect(formatWorkedForRow(31_000, null)?.arg).toBe('31s');
    expect(formatWorkedForRow(31_000, '')?.arg).toBe('31s');
  });

  it('F-B12: drops the seconds segment on a whole minute', () => {
    expect(formatWorkedForRow(120_000)?.arg).toBe('2m');
  });

  it('D25 §2.4: the "Ns" arg is prose, not an identifier (sans, not mono)', () => {
    expect(formatWorkedForRow(31_000)?.argKind).toBe('prose');
  });
});

function call(id: string, toolName: string, input: unknown = {}): ChatBlock {
  return { id, type: 'tool_call', toolCallId: id, toolName, toolInput: input };
}

function result(callId: string, overrides: Partial<ChatBlock> = {}): ChatBlock {
  return {
    id: `${callId}-result`,
    type: 'tool_result',
    toolCallId: callId,
    toolOk: true,
    ...overrides,
  };
}

function message(blocks: ChatBlock[]): ChatMessage {
  return { id: 'm1', sessionId: 's1', role: 'assistant', blocks };
}

describe('deriveTurnStats', () => {
  it('3 other tool calls + 11 searches + 1 edit -> "3 tool calls · 11 searches · 1 edit"', () => {
    const blocks: ChatBlock[] = [];
    for (let i = 0; i < 3; i += 1) {
      blocks.push(call(`t${i}`, 'Bash', { command: 'ls' }), result(`t${i}`));
    }
    for (let i = 0; i < 11; i += 1) {
      blocks.push(call(`s${i}`, 'Grep', { pattern: 'x' }), result(`s${i}`));
    }
    blocks.push(call('e0', 'Edit', { file_path: 'a.ts' }), result('e0'));
    expect(deriveTurnStats(message(blocks))).toBe('3 tool calls · 11 searches · 1 edit');
  });

  it('omits a zero-count segment', () => {
    const blocks: ChatBlock[] = [call('a', 'Bash', { command: 'ls' }), result('a')];
    expect(deriveTurnStats(message(blocks))).toBe('1 tool call');
  });

  /**
   * A refused call did no work, so it is not work this turn did. The head used
   * to say `1 edit` about a write the user had just declined — the same
   * past-tense claim the row itself was making (G-9, 2026-08-23).
   */
  it('does not count a call whose authorization was refused', () => {
    const refusedPermission: ChatBlock = {
      id: 'p0',
      type: 'permission_request',
      permissionId: 'e0',
      toolName: 'Write',
      resolved: true,
      allowed: false,
      permissionDecision: 'deny',
    };
    const blocks: ChatBlock[] = [
      call('e0', 'Edit', { file_path: 'a.ts' }),
      result('e0', { toolOk: false }),
      refusedPermission,
    ];
    expect(deriveTurnStats(message(blocks))).toBeNull();

    // …and an ALLOWED one still counts, or the exclusion is just "never count".
    const allowed: ChatBlock = {
      ...refusedPermission,
      id: 'p1',
      allowed: true,
      permissionDecision: 'allow',
    };
    expect(deriveTurnStats(message([blocks[0], blocks[1], allowed]))).toBe('1 edit');
  });

  it('a turn whose only call was refused reads as thinking-only, not as tool work', () => {
    const blocks: ChatBlock[] = [
      thinking('th0'),
      call('e0', 'Edit', { file_path: 'a.ts' }),
      result('e0', { toolOk: false }),
      {
        id: 'p0',
        type: 'permission_request',
        permissionId: 'e0',
        resolved: true,
        allowed: false,
      },
    ];
    expect(turnHasThinkingOnlyProcess(blocks)).toBe(true);
  });

  it('returns null when every count is zero', () => {
    expect(deriveTurnStats(message([]))).toBeNull();
    expect(deriveTurnStats(message([]), { style: 'compact' })).toBeNull();
  });

  // Same counting pass, two renderings: ` · ` is already the separator between
  // the duration and the counts inside the "Worked for …" arg, so the compact
  // form falls back to commas instead of nesting one separator inside itself.
  it('F-B12: compact style renders the reference wording "3 tools, 11 searches"', () => {
    const blocks: ChatBlock[] = [];
    for (let i = 0; i < 3; i += 1) {
      blocks.push(call(`t${i}`, 'Bash', { command: 'ls' }), result(`t${i}`));
    }
    for (let i = 0; i < 11; i += 1) {
      blocks.push(call(`s${i}`, 'Grep', { pattern: 'x' }), result(`s${i}`));
    }
    expect(deriveTurnStats(message(blocks), { style: 'compact' })).toBe('3 tools, 11 searches');
  });

  it('F-B12: compact style keeps the singular/plural rule', () => {
    const blocks: ChatBlock[] = [call('a', 'Bash', { command: 'ls' }), result('a')];
    expect(deriveTurnStats(message(blocks), { style: 'compact' })).toBe('1 tool');
  });
});

function thinking(id: string, text = 'hmm'): ChatBlock {
  return { id, type: 'thinking', text };
}

describe('turnHasThinkingOnlyProcess', () => {
  // The bug this exists to catch: `deriveTurnStats` returns null here (zero
  // tool runs), so a replayed turn made of one thought used to fall all the
  // way to `turnHead.ts`'s label-less `bare` rung.
  it('true for a process that is exactly one thinking block', () => {
    expect(turnHasThinkingOnlyProcess([thinking('t1')])).toBe(true);
  });

  it('true for several thinking blocks and no tool run', () => {
    expect(turnHasThinkingOnlyProcess([thinking('t1'), thinking('t2')])).toBe(true);
  });

  it('false once a tool run is present alongside the thinking block', () => {
    const blocks: ChatBlock[] = [thinking('t1'), call('a', 'Bash', { command: 'ls' }), result('a')];
    expect(turnHasThinkingOnlyProcess(blocks)).toBe(false);
  });

  it('false for a tool-only process (nothing to label "Thought")', () => {
    const blocks: ChatBlock[] = [call('a', 'Bash', { command: 'ls' }), result('a')];
    expect(turnHasThinkingOnlyProcess(blocks)).toBe(false);
  });

  it('false for an empty block list', () => {
    expect(turnHasThinkingOnlyProcess([])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2026-09-18 — the work group's clock
// ---------------------------------------------------------------------------

describe('splitWorkedForDuration', () => {
  it('[WG-DUR-1] agrees with the English formatter on every tier', () => {
    // Same split, two renderings. A drift here would show up as the head and
    // the thought row disagreeing about how long the same turn took.
    for (const ms of [1, 999, 1_000, 30_400, 59_500, 60_000, 66_000, 120_000, 3_600_000]) {
      const { minutes, seconds } = splitWorkedForDuration(ms);
      const expected =
        minutes === 0 ? `${seconds}s` : seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
      expect(formatWorkedForDuration(ms), String(ms)).toBe(expected);
    }
  });

  it('[WG-DUR-2] floors at one second — a turn that ran did not take zero', () => {
    expect(splitWorkedForDuration(0)).toEqual({ minutes: 0, seconds: 1 });
    expect(splitWorkedForDuration(400)).toEqual({ minutes: 0, seconds: 1 });
  });

  it('[WG-DUR-3] carries a whole minute with no remainder', () => {
    expect(splitWorkedForDuration(57_000)).toEqual({ minutes: 0, seconds: 57 });
    expect(splitWorkedForDuration(66_000)).toEqual({ minutes: 1, seconds: 6 });
    expect(splitWorkedForDuration(120_000)).toEqual({ minutes: 2, seconds: 0 });
  });
});

describe('deriveTurnWorkedMs', () => {
  it('[WG-SPAN-1] spans the whole turn: last completion minus first start', () => {
    // Two assistant messages — an authorization wait split the turn. The last
    // message's own latency is 2s; the turn took 57.
    expect(
      deriveTurnWorkedMs([
        { startedAt: 1_000, completedAt: 20_000 },
        { startedAt: 56_000, completedAt: 58_000 },
      ])
    ).toBe(57_000);
  });

  it('[WG-SPAN-2] ignores entries with no timing and messages that are still running', () => {
    expect(
      deriveTurnWorkedMs([undefined, { startedAt: 5_000 }, null, { completedAt: 9_000 }])
    ).toBe(4_000);
  });

  /**
   * A07 `:2399` at the turn scale. A restored history turn replays no
   * `message.started` / `message.completed` events, so `null` here is the ONLY
   * honest answer — and callers must read it as "omit the number", never as
   * "0s". `deriveTurnWorkZone` is what acts on it.
   */
  it('[WG-SPAN-3] returns null rather than fabricating a duration', () => {
    expect(deriveTurnWorkedMs([])).toBeNull();
    expect(deriveTurnWorkedMs([undefined, undefined])).toBeNull();
    // Started and never stamped again: ONE timestamp is not a span. (2026-09-19
    // moved the end from "the last completion" to "the last stamp of any kind",
    // so an interrupted turn does get a lower bound — but only once there is a
    // second instant to measure against, which there is not here.)
    expect(deriveTurnWorkedMs([{ startedAt: 1_000 }])).toBeNull();
    // Finished with no recorded start — the shape a partially-replayed turn has.
    expect(deriveTurnWorkedMs([{ completedAt: 1_000 }])).toBeNull();
    // A clock that ran backwards is unknown time, not negative time.
    expect(deriveTurnWorkedMs([{ startedAt: 9_000, completedAt: 1_000 }])).toBeNull();
  });

  it('[WG-SPAN-4] treats an explicit null timestamp exactly like a missing one', () => {
    expect(deriveTurnWorkedMs([{ startedAt: null, completedAt: null }])).toBeNull();
    expect(
      deriveTurnWorkedMs([{ startedAt: 1_000, completedAt: null }, { completedAt: 4_000 }])
    ).toBe(3_000);
  });

  /**
   * The turn's own origin is one more START candidate, so it can only ever make
   * the span LONGER — never shorter, and never a different measurement.
   */
  it('[WG-SPAN-5] counts from the turn origin when the caller knows one', () => {
    // Send at 1_000, first assistant byte at 8_000, reply done at 9_000.
    expect(deriveTurnWorkedMs([{ startedAt: 8_000, completedAt: 9_000 }], 1_000)).toBe(8_000);
    // An origin LATER than the body's first start is ignored — the earliest
    // evidence wins, so a stale anchor cannot shorten a turn.
    expect(deriveTurnWorkedMs([{ startedAt: 2_000, completedAt: 9_000 }], 5_000)).toBe(7_000);
    // Stopped before the reply completed: the lower bound the origin makes
    // measurable. Without it this turn had exactly one stamp and no duration.
    expect(deriveTurnWorkedMs([{ startedAt: 8_000 }], 1_000)).toBe(7_000);
  });
});

/**
 * `deriveTurnElapsedMs` — the head's one clock, running and finished.
 */
describe('deriveTurnElapsedMs', () => {
  it('[WG-CLOCK-1] running, it counts from the origin to now — wait included', () => {
    // 7s into a turn whose first byte has not arrived: no body metadata at all,
    // and the honest answer is still 7s, not "unmeasured".
    expect(
      deriveTurnElapsedMs({ startedAtMs: 1_000, metadata: [], nowMs: 8_000, running: true })
    ).toBe(7_000);
    // With the first assistant message open, the origin does not move to it.
    expect(
      deriveTurnElapsedMs({
        startedAtMs: 1_000,
        metadata: [{ startedAt: 8_000 }],
        nowMs: 8_500,
        running: true,
      })
    ).toBe(7_500);
  });

  it('[WG-CLOCK-2] returns null rather than zero when there is no origin', () => {
    expect(
      deriveTurnElapsedMs({ startedAtMs: null, metadata: [], nowMs: 9_999, running: true })
    ).toBeNull();
    expect(
      deriveTurnElapsedMs({ startedAtMs: null, metadata: [], nowMs: 9_999, running: false })
    ).toBeNull();
    // A clock that ran backwards is unknown time, not negative time.
    expect(
      deriveTurnElapsedMs({ startedAtMs: 9_000, metadata: [], nowMs: 1_000, running: true })
    ).toBeNull();
  });

  /**
   * A multi-step turn (tool call, or an authorization wait) settles several
   * messages. The span is send -> the LAST completion, never the last model
   * call's own latency — the defect `deriveTurnWorkedMs`'s header describes,
   * restated now that the origin moved further back.
   */
  it('[WG-CLOCK-3] a multi-step turn spans the whole turn, not its last call', () => {
    expect(
      deriveTurnElapsedMs({
        startedAtMs: 1_000,
        metadata: [
          { startedAt: 9_000, completedAt: 20_000 },
          { startedAt: 56_000, completedAt: 58_000 },
        ],
        nowMs: 0,
        running: false,
      })
    ).toBe(57_000);
  });

  /**
   * Stop pressed mid-stream, or a session failure with a message still open:
   * `message.completed` never arrives, so the end is the last instant anything
   * WAS stamped. A lower bound, stated as such in the function's own note —
   * and still better than the alternative the old code produced, which was no
   * number at all for every interrupted turn.
   */
  it('[WG-CLOCK-4] an interrupted turn ends at its last stamped event', () => {
    expect(
      deriveTurnElapsedMs({
        startedAtMs: 1_000,
        metadata: [{ startedAt: 8_000, completedAt: 9_000 }, { startedAt: 12_000 }],
        nowMs: 0,
        running: false,
      })
    ).toBe(11_000);
    // Nothing after the origin at all: one stamp is not a span, and a `0` here
    // would print as 「1 秒」 about a turn nobody timed.
    expect(
      deriveTurnElapsedMs({ startedAtMs: 4_000, metadata: [], nowMs: 0, running: false })
    ).toBeNull();
    expect(
      deriveTurnElapsedMs({
        startedAtMs: 4_000,
        metadata: [{ startedAt: 4_000 }],
        nowMs: 0,
        running: false,
      })
    ).toBeNull();
  });
});

/**
 * ## [WG-CLOCK-5] The regression this whole batch exists for: the clock never
 * goes backwards.
 *
 * Measured on a real turn through CDP, 2026-09-19 — 7936ms from Send to the
 * end of the reply, sampled at the head:
 *
 * ```
 * [+520ms]  工作中 1 秒
 * [+2615ms] 工作中 1 秒
 * [+5147ms] 工作中 2 秒
 * [+6164ms] 工作中 3 秒
 * [+7315ms] 工作中 1 秒 · ↑ 7.6k tokens   <- first byte: 3 -> 1
 * [+7936ms] 已工作 1 秒 · …                <- 7.9s reported as 1
 * ```
 *
 * Two faults, one cause: the head took whichever of three clocks happened to
 * be live, and they count from three different instants. The first byte swapped
 * the composer's ticker for the first assistant message's `message.started`, so
 * the number fell; and the finished turn reported that message's own span,
 * throwing the 7.3s wait away — the part the user means by 「运行了差不多 1 分
 * 钟」.
 *
 * This replays that exact shape — 7s of silence, first byte, 1s of streaming —
 * and asserts the two properties separately, because they fail separately:
 * MONOTONE across every sample, and a final value of 8s rather than 1s.
 */
describe('[WG-CLOCK-5] the turn head clock never runs backwards', () => {
  /** Send committed / user message echoed. */
  const SEND_AT = 1_000_000;
  /** First assistant byte, 7s of silence later. */
  const FIRST_BYTE_AT = SEND_AT + 7_000;
  /** Reply complete, one second of streaming after that. */
  const COMPLETED_AT = FIRST_BYTE_AT + 1_000;

  interface Sample {
    at: number;
    running: boolean;
    metadata: (TurnSpanMetadata | undefined)[];
  }

  /**
   * The two steps the end row itself performs, reproduced here so the assertion
   * is about the NUMBER ON SCREEN and not about an intermediate value: while
   * the turn runs `MessageTimeline` floors the elapsed ms to whole seconds
   * before `deriveTurnWorkZone` splits them; once it settles the row
   * receives the milliseconds directly.
   */
  function renderedSeconds(sample: Sample): number | null {
    const elapsedMs = deriveTurnElapsedMs({
      startedAtMs: SEND_AT,
      metadata: sample.metadata,
      nowMs: sample.at,
      running: sample.running,
    });
    if (elapsedMs === null) return null;
    const ms = sample.running ? Math.floor(elapsedMs / 1000) * 1000 : elapsedMs;
    const { minutes, seconds } = splitWorkedForDuration(ms);
    return minutes * 60 + seconds;
  }

  /** One sample per tick of `useSecondsTick`, plus the two event instants. */
  function timeline(): Sample[] {
    const samples: Sample[] = [];
    // The silence: the turn exists (the user message was echoed) and its body
    // is still empty, which is exactly the state the old code had no clock for.
    for (let at = SEND_AT + 500; at < FIRST_BYTE_AT; at += 1_000) {
      samples.push({ at, running: true, metadata: [] });
    }
    // First byte: the assistant message opens. This is the sample where the
    // count used to fall from 3 back to 1.
    samples.push({ at: FIRST_BYTE_AT, running: true, metadata: [{ startedAt: FIRST_BYTE_AT }] });
    samples.push({
      at: FIRST_BYTE_AT + 500,
      running: true,
      metadata: [{ startedAt: FIRST_BYTE_AT }],
    });
    // Settled: `message.completed` landed, so the head switches to its
    // finished shape — same origin, so the number may only grow.
    samples.push({
      at: COMPLETED_AT,
      running: false,
      metadata: [{ startedAt: FIRST_BYTE_AT, completedAt: COMPLETED_AT }],
    });
    return samples;
  }

  it('is monotone across every sample from send to settled', () => {
    const seen = timeline().map(renderedSeconds);
    expect(seen).not.toContain(null);
    for (let index = 1; index < seen.length; index += 1) {
      const previous = seen[index - 1] ?? 0;
      const current = seen[index] ?? 0;
      expect(
        current,
        `sample ${index} went backwards: ${previous}s -> ${current}s (whole sequence: ${seen.join(', ')})`
      ).toBeGreaterThanOrEqual(previous);
    }
  });

  it('reports 8s at the end, not the 1s the assistant message alone lasted', () => {
    const samples = timeline();
    const final = samples[samples.length - 1];
    expect(final.running).toBe(false);
    expect(renderedSeconds(final)).toBe(8);
    // The shape that produced 「已工作 1 秒」: the same body metadata with no
    // origin. Pinned here so the regression is visible in the test, not just
    // in the fix.
    expect(deriveTurnWorkedMs(final.metadata)).toBe(1_000);
  });

  it('shows the wait while it is happening, instead of waiting for a first byte', () => {
    // The 4th second of silence, with an empty body. The old head had no clock
    // at all in this state once the composer snapshot's phase reset landed.
    expect(renderedSeconds({ at: SEND_AT + 4_500, running: true, metadata: [] })).toBe(4);
  });
});
