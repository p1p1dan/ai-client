import { describe, expect, it } from 'vitest';
import type { TurnItem, TurnItemKind, TurnSegment } from '../chatTurn';
import { segmentTurnBody } from '../chatTurn';
import type { ToolRun, ToolRunStatus } from '../toolCard';
import {
  countProcessSteps,
  countTurnToolCalls,
  deriveTurnCurrentAction,
  deriveTurnWorkZone,
  splitTurnWorkGroup,
  turnProcessGroupFolds,
  turnWorkGroupAwaitsUser,
  turnWorkGroupOpen,
} from '../turnProcessFold';

/**
 * The 2026-09-18 work group, in the layer that can be asserted.
 *
 * `MessageTimeline.tsx` cannot be rendered under this suite (node environment),
 * so every placement rule lives in `turnProcessFold.ts` as a pure function and
 * is truth-tabled here. `messageTimelineWiring.test.ts` covers the one
 * remaining layer — that the component actually calls these.
 */

let seq = 0;

/** A segment built through the REAL segmenter, so the run-length contract is exercised too. */
function segmentsOf(kinds: readonly TurnItemKind[]): TurnSegment<{ kind: TurnItemKind }>[] {
  return segmentTurnBody(kinds.map((kind) => ({ kind })));
}

// Decision 033 D1 (2026-09-22): while the turn STREAMS there is no final reply
// to find, so everything but a notice stays in one group. Once it has settled,
// the final reply is the last answer segment with NO process after it, and that
// extraction is the single structural change the turn makes. Notices stay
// outside throughout (FB4).
describe('splitTurnWorkGroup — nothing is final until the turn settles', () => {
  it('[WG-STREAM-1] while streaming, every answer stays inside the group', () => {
    const segments = segmentsOf(['text', 'toolGroup', 'text']);
    expect(splitTurnWorkGroup(segments, false)).toEqual([
      { kind: 'processGroup', segments: [segments[0], segments[1], segments[2]] },
    ]);
  });

  it('[WG-STREAM-2] settling extracts the reply, and the group head does not move', () => {
    const segments = segmentsOf(['text', 'toolGroup', 'text']);
    const streaming = splitTurnWorkGroup(segments, false);
    const settled = splitTurnWorkGroup(segments, true);
    // `groupKey` is the first item of the first segment, so this identity is
    // what keeps the reader's expansion across the one change the turn makes.
    expect(streaming[0].kind === 'processGroup' && streaming[0].segments[0]).toBe(
      settled[0].kind === 'processGroup' && settled[0].segments[0]
    );
    expect(settled.at(-1)).toEqual({ kind: 'finalAnswer', segment: segments[2] });
  });

  it('[WG-FWD-1] a settled turn that ENDS on a tool call has no final reply at all', () => {
    // `answer → 工具 → 结束`. The retired `lastAnswerIndex` rule pulled the
    // trailing narration out as the reply while a call still followed it —
    // the 「各种调用穿插在 agent 的输出中」 complaint in a new shape.
    const segments = segmentsOf(['text', 'toolGroup']);
    expect(splitTurnWorkGroup(segments, true)).toEqual([
      { kind: 'processGroup', segments: [segments[0], segments[1]] },
    ]);
  });

  it('[WG-FWD-2] only PROCESS disqualifies a reply — a trailing notice does not', () => {
    const segments = segmentsOf(['toolGroup', 'text', 'notice']);
    expect(splitTurnWorkGroup(segments, true)).toEqual([
      { kind: 'processGroup', segments: [segments[0]] },
      { kind: 'finalAnswer', segment: segments[1] },
      { kind: 'notice', segment: segments[2] },
    ]);
  });

  it('[WG-FWD-3] with two qualifying answers the LAST one is the reply', () => {
    // A forward scan for "the first answer with no process after it" picks the
    // wrong paragraph here: `segments[1]` passes that test too, and extracting
    // it would fold the turn's actual last paragraph into the group.
    const segments = segmentsOf(['toolGroup', 'text', 'notice', 'text']);
    const sections = splitTurnWorkGroup(segments, true);
    // Identity, not deep equality: two one-paragraph answer segments are
    // structurally identical, so `toContainEqual` cannot tell them apart.
    const final = sections.filter((section) => section.kind === 'finalAnswer');
    expect(final).toHaveLength(1);
    expect(final[0].kind === 'finalAnswer' && final[0].segment).toBe(segments[3]);
  });

  it('[WG-1] three paragraphs: the first two fold, the last is the final reply', () => {
    const segments = segmentsOf(['text', 'toolGroup', 'text', 'toolGroup', 'text']);
    expect(splitTurnWorkGroup(segments, true)).toEqual([
      {
        kind: 'processGroup',
        segments: [segments[0], segments[1], segments[2], segments[3]],
      },
      { kind: 'finalAnswer', segment: segments[4] },
    ]);
  });

  it('[WG-2] an error ending cannot hide the FINAL reply (FB4)', () => {
    const segments = segmentsOf(['text', 'toolGroup', 'text', 'notice']);
    const sections = splitTurnWorkGroup(segments, true);
    // The notice stays outside and AFTER everything — it is the last section.
    expect(sections.at(-1)).toEqual({ kind: 'notice', segment: segments[3] });
    // The final reply (the last answer) is a standalone section, not folded.
    expect(sections).toContainEqual({ kind: 'finalAnswer', segment: segments[2] });
  });

  it('[WG-3/4] without prose, notices stay outside, after the process group', () => {
    const segments = segmentsOf(['toolGroup', 'notice', 'permission']);
    expect(splitTurnWorkGroup(segments, true)).toEqual([
      { kind: 'processGroup', segments: [segments[0], segments[2]] },
      { kind: 'notice', segment: segments[1] },
    ]);
  });

  it('[WG-5/6] no process means no empty group, even with a notice', () => {
    const segments = segmentsOf(['notice', 'text']);
    expect(splitTurnWorkGroup(segments, true)).toEqual([
      { kind: 'notice', segment: segments[0] },
      { kind: 'finalAnswer', segment: segments[1] },
    ]);
  });

  it('[WG-7] preserves every segment exactly once and in order when an answer exists', () => {
    for (const kinds of [
      ['text'],
      ['text', 'toolGroup', 'text'],
      ['notice', 'text', 'toolGroup', 'text', 'notice'],
      ['toolGroup', 'text', 'notice', 'text'],
      ['permission', 'text', 'toolGroup'],
      ['text', 'toolGroup', 'notice', 'toolGroup', 'text'],
    ] as TurnItemKind[][]) {
      const segments = segmentsOf(kinds);
      const sections = splitTurnWorkGroup(segments, true);
      expect(
        sections.flatMap((s) => (s.kind === 'processGroup' ? s.segments : [s.segment]))
      ).toEqual(segments);
      for (const section of sections) {
        if (section.kind === 'processGroup') {
          // A group holds process AND intermediate answer segments — but a
          // notice never enters one (FB4).
          expect(section.segments.every((s) => s.kind !== 'notice')).toBe(true);
        }
      }
    }
  });

  it('[WG-8] appending an answer folds the old final in — without moving the group head', () => {
    const segments = segmentsOf(['text', 'toolGroup', 'text', 'toolGroup', 'text']);
    const before = splitTurnWorkGroup(segments.slice(0, 3), true);
    const after = splitTurnWorkGroup(segments, true);
    // The group's FIRST segment is unchanged — it is the `groupKey` the
    // renderer keys on, so expansion state survives a new answer arriving.
    expect(after[0].kind === 'processGroup' && before[0].kind === 'processGroup').toBe(true);
    if (after[0].kind === 'processGroup' && before[0].kind === 'processGroup') {
      expect(after[0].segments[0]).toBe(before[0].segments[0]);
      const previousFinal = before.at(-1);
      expect(previousFinal?.kind).toBe('finalAnswer');
      if (previousFinal?.kind === 'finalAnswer') {
        expect(after[0].segments).toContain(previousFinal.segment);
      }
    }
  });

  it('[WG-9] an empty turn has no sections', () => {
    expect(splitTurnWorkGroup([], true)).toEqual([]);
  });

  it('[WG-REAL-1/2] interleaved thinking, prose and calls fold into one group before the final', () => {
    const sections = splitTurnWorkGroup(
      segmentsOf(['toolGroup', 'text', 'toolGroup', 'toolGroup', 'text']),
      true
    );
    expect(sections.map((s) => s.kind)).toEqual(['processGroup', 'finalAnswer']);
    // The group holds everything before the final: the process runs AND the
    // intermediate prose between them (the two adjacent toolGroups merge into
    // one process segment, so three segments, not four).
    expect(sections[0].kind === 'processGroup' && sections[0].segments).toHaveLength(3);
  });

  it('[WG-REAL-3/4] a notice always renders outside, and never splits the group open', () => {
    // Under the retired rule this shape produced FOUR sections — the middle
    // paragraph was extracted as the reply even though a call followed it, and
    // the call behind it started a second group. One group now, one notice.
    const sections = splitTurnWorkGroup(
      segmentsOf(['toolGroup', 'text', 'toolGroup', 'notice']),
      true
    );
    expect(sections.map((s) => s.kind)).toEqual(['processGroup', 'notice']);
    expect(
      splitTurnWorkGroup(segmentsOf(['toolGroup', 'notice']), true).map((s) => s.kind)
    ).toEqual(['processGroup', 'notice']);
  });

  it('[WG-LONG] twenty-four consecutive calls create one process section, not twenty-four', () => {
    const kinds: TurnItemKind[] = ['text', ...Array<TurnItemKind>(24).fill('toolGroup'), 'text'];
    const sections = splitTurnWorkGroup(segmentsOf(kinds), true);
    expect(sections.map((s) => s.kind)).toEqual(['processGroup', 'finalAnswer']);
  });
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// The authorization red line
// ---------------------------------------------------------------------------

function askItem(kind: 'permission' | 'question', resolved?: boolean): TurnItem {
  seq += 1;
  return {
    kind,
    blockIndex: 0,
    messageId: `m${seq}`,
    block: { id: `b${seq}`, type: 'permission_request', resolved },
  } as unknown as TurnItem;
}

const toolItem = (): TurnItem =>
  ({ kind: 'toolGroup', blockIndex: 0, messageId: 'm0', entries: [] }) as unknown as TurnItem;

const processSegment = (items: TurnItem[]): TurnSegment<TurnItem> => ({ kind: 'process', items });

describe('turnWorkGroupAwaitsUser — the Allow/Deny card can never be collapsed away', () => {
  it('[WG-RED-1] an unanswered permission anywhere in the group forces it open', () => {
    expect(
      turnWorkGroupAwaitsUser([
        processSegment([toolItem()]),
        processSegment([askItem('permission')]),
      ])
    ).toBe(true);
  });

  it('[WG-RED-2] an unanswered question counts too — it is the same surface', () => {
    expect(turnWorkGroupAwaitsUser([processSegment([askItem('question')])])).toBe(true);
  });

  it('[WG-RED-3] a settled card does not pin the group open', () => {
    expect(turnWorkGroupAwaitsUser([processSegment([askItem('permission', true)])])).toBe(false);
    expect(turnWorkGroupAwaitsUser([processSegment([toolItem()])])).toBe(false);
    expect(turnWorkGroupAwaitsUser([])).toBe(false);
  });

  it('[WG-RED-4] a card with NO resolved field fails open, not shut', () => {
    // An older card carries no `resolved` at all. "We don't know whether this
    // was answered" must never resolve to "hide it".
    expect(turnWorkGroupAwaitsUser([processSegment([askItem('permission', undefined)])])).toBe(
      true
    );
    expect(turnWorkGroupAwaitsUser([processSegment([askItem('permission', false)])])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Open / closed
// ---------------------------------------------------------------------------

describe('turnWorkGroupOpen — running open, completed closed', () => {
  const open = (forcedOpen: boolean, userOpen: boolean | null, settled = false): boolean =>
    turnWorkGroupOpen({ forcedOpen, userOpen, settled });

  it('[WG-OPEN-1] running groups open and completed groups close by default', () => {
    expect(open(false, null)).toBe(true);
    expect(open(false, null, true)).toBe(false);
    expect(open(false, true, true)).toBe(true);
  });

  it('[WG-OPEN-2] either explicit user choice overrides the default', () => {
    expect(open(false, true)).toBe(true);
    // The half that matters now the default flipped: a reader who collapses a
    // group keeps it collapsed. If this drifts, the click has no effect at all.
    expect(open(false, false)).toBe(false);
  });

  it('[WG-OPEN-3] restored history mounts closed', () => {
    expect(open(false, null, true)).toBe(false);
  });

  it('[WG-OPEN-4] an unanswered authorization outranks both the default and the click', () => {
    for (const userOpen of [true, false, null]) {
      expect(open(true, userOpen), `${userOpen}`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// The turn's work zone row (T113) — what replaced the head's copy rules
// ---------------------------------------------------------------------------

/**
 * REWRITTEN 2026-09-21 (T113). These were `[WG-LABEL-*]` over
 * `deriveTurnWorkGroupLabel`, which chose between three things a HEAD could
 * say. The head now says one thing (its step count) and the three it used to
 * choose between describe the TURN, on its own row — so the cases move here
 * rather than being deleted. The judgements they encode are unchanged and are
 * restated in each test: a running turn reports the LIVE clock and not the
 * settled span; a running turn with no clock prints no seconds at all; an
 * unmeasured duration is OMITTED, never rendered as `0`.
 */
describe('deriveTurnWorkZone — the turn describes itself, in two states', () => {
  const base = {
    elapsedSeconds: null,
    workedMs: null,
    completedAtMs: null,
    toolCalls: 0,
    thinkingMs: null,
  };

  /**
   * Note which clock a running turn reports: `elapsedSeconds` (the live one),
   * NOT `workedMs`. A running turn has no completion timestamp, so `workedMs`
   * on an unsettled turn is whatever a PREVIOUS message in it happened to close
   * with — the defect the 2026-09-19 origin fix was about.
   */
  it('[WZ-1] a running turn reports the LIVE clock, not the settled span', () => {
    expect(
      deriveTurnWorkZone({ ...base, running: true, workedMs: 61_000, elapsedSeconds: 47 })
    ).toEqual({ kind: 'working', elapsed: { minutes: 0, seconds: 47 } });
    expect(deriveTurnWorkZone({ ...base, running: true, elapsedSeconds: 66 })).toEqual({
      kind: 'working',
      elapsed: { minutes: 1, seconds: 6 },
    });
  });

  /**
   * A session already in flight when this window opened replays no
   * `message.started`, so it runs with no origin to count from. The row says a
   * bare 「工作中」 there — `elapsed: null` — rather than 「工作中 0 秒」, which is
   * the same fabricated-measurement rule as [WZ-4].
   */
  it('[WZ-2] a running turn with no clock reports no seconds at all', () => {
    expect(deriveTurnWorkZone({ ...base, running: true, elapsedSeconds: null })).toEqual({
      kind: 'working',
      elapsed: null,
    });
    // …and none of the settled figures leak into the running shape, even when
    // the caller happens to have them: a turn still going has not completed.
    expect(
      deriveTurnWorkZone({
        running: true,
        elapsedSeconds: 3,
        workedMs: 9_000,
        completedAtMs: 1_700_000_000_000,
        toolCalls: 8,
        thinkingMs: 12_000,
      })
    ).toEqual({ kind: 'working', elapsed: { minutes: 0, seconds: 3 } });
  });

  it('[WZ-3] a settled turn carries the four figures the user named, and only those', () => {
    const zone = deriveTurnWorkZone({
      running: false,
      elapsedSeconds: null,
      workedMs: 54_000,
      completedAtMs: 1_700_000_000_000,
      toolCalls: 8,
      thinkingMs: 12_000,
    });
    expect(zone).toEqual({
      kind: 'worked',
      worked: { minutes: 0, seconds: 54 },
      completedAtMs: 1_700_000_000_000,
      toolCalls: 8,
      thinkingMs: 12_000,
    });
    // The closed-list half of the claim. Token usage was considered at the same
    // time and deliberately left off; a field appearing here is a product
    // decision, not a refactor.
    expect(Object.keys(zone ?? {}).sort()).toEqual([
      'completedAtMs',
      'kind',
      'thinkingMs',
      'toolCalls',
      'worked',
    ]);
    // Units the catalog writes, not a pre-formatted string.
    expect(deriveTurnWorkZone({ ...base, running: false, workedMs: 66_000 })).toMatchObject({
      worked: { minutes: 1, seconds: 6 },
    });
    expect(deriveTurnWorkZone({ ...base, running: false, workedMs: 120_000 })).toMatchObject({
      worked: { minutes: 2, seconds: 0 },
    });
  });

  /**
   * A07 `:2399`'s red line at turn scale: unknown means OMIT, not `0`.
   *
   * ⚠️ **REWRITTEN 2026-09-22.** This case used to assert a `null` RETURN, and
   * that return was the defect. Two elements read this zone — the process fold
   * head and the tail row — and `null` deleted both, so a turn with no measured
   * span lost its head's text as well as its row (「现在折叠头和尾栏都没了」).
   * The absence now lives INSIDE the zone as `worked: null`, and the two
   * readers answer for themselves: the head prints the bare state word, the row
   * prints nothing when it has no clause.
   *
   * The rule itself did not move an inch — nothing here fabricates a `0`.
   */
  it('[WZ-4] a settled turn with no measured span reports the absence, not a zero', () => {
    expect(deriveTurnWorkZone({ ...base, running: false })).toEqual({
      kind: 'worked',
      worked: null,
      completedAtMs: null,
      toolCalls: null,
      thinkingMs: null,
    });
    // The other three are independent of it: a replayed turn knows when it
    // finished and how many calls it made, and an unmeasured SPAN is no reason
    // to throw those away.
    expect(
      deriveTurnWorkZone({
        running: false,
        elapsedSeconds: null,
        workedMs: null,
        completedAtMs: 1_700_000_000_000,
        toolCalls: 4,
        thinkingMs: 3_000,
      })
    ).toEqual({
      kind: 'worked',
      worked: null,
      completedAtMs: 1_700_000_000_000,
      toolCalls: 4,
      thinkingMs: 3_000,
    });
  });

  it('[WZ-5] each settled figure drops on its own when it was never measured', () => {
    expect(deriveTurnWorkZone({ ...base, running: false, workedMs: 54_000 })).toEqual({
      kind: 'worked',
      worked: { minutes: 0, seconds: 54 },
      completedAtMs: null,
      // Zero calls is "this turn called nothing", which is not a figure worth a
      // clause — and `0 次工具调用` would read as a measurement.
      toolCalls: null,
      thinkingMs: null,
    });
    expect(
      deriveTurnWorkZone({ ...base, running: false, workedMs: 54_000, toolCalls: 1 })
    ).toMatchObject({ toolCalls: 1 });
  });

  /**
   * The relay with `PendingTurnHead`, at the layer that can hold it.
   *
   * The caller passes `!processSettled`, and `processSettled` already folds in
   * `statusOwnedByPendingHead` — so the only way two rows count seconds at once
   * is if this function produced a clock for a turn that is not running. It
   * cannot: `running` is the single gate, and the settled shape has no live
   * field to tick.
   */
  it('[WZ-6] only a running turn can produce a ticking shape', () => {
    for (const elapsedSeconds of [null, 0, 47]) {
      const settled = deriveTurnWorkZone({
        ...base,
        running: false,
        elapsedSeconds,
        workedMs: 1_000,
      });
      expect(settled?.kind, `${elapsedSeconds}`).toBe('worked');
      expect(Object.keys(settled ?? {})).not.toContain('elapsed');
    }
  });
});

describe('countTurnToolCalls', () => {
  const group = (entries: unknown[]): TurnItem =>
    ({ kind: 'toolGroup', blockIndex: 0, messageId: 'm1', entries }) as never;

  it('[WZ-CALLS-1] counts runs across groups, and a thought is not a call', () => {
    const items = [
      group([{ kind: 'run' }, { kind: 'thinking' }, { kind: 'run' }]),
      group([{ kind: 'run' }]),
    ];
    expect(countTurnToolCalls(items)).toBe(3);
    // Deliberately NOT the same number as the step count beside it: a thought
    // is a step the user watched happen, and it is not a tool call. The two
    // clauses use different words for that reason.
    expect(countProcessSteps(items)).toBe(4);
  });

  it('[WZ-CALLS-2] a turn with no tool group counts zero', () => {
    expect(countTurnToolCalls([])).toBe(0);
    expect(countTurnToolCalls([askItem('permission')])).toBe(0);
    expect(countTurnToolCalls([group([{ kind: 'thinking' }])])).toBe(0);
  });
});

// The head's chips: each counts one kind of thing the group holds, and is
// shown only when its count is above zero.
describe('countProcessSteps', () => {
  it('counts what happened, not how it was grouped', () => {
    // A tool group holding four runs is four steps; counting groups would tell
    // a turn that ran four tools that it took one.
    const item = (kind: string, extra: Record<string, unknown> = {}) =>
      ({ kind, blockIndex: 0, messageId: 'm1', ...extra }) as never;
    expect(
      countProcessSteps([
        item('toolGroup', { entries: [{ kind: 'run' }, { kind: 'thinking' }, { kind: 'run' }] }),
        item('permissionActivity', { blocks: [{}, {}] }),
        item('permission', { block: {} }),
      ])
    ).toBe(6);
    expect(countProcessSteps([])).toBe(0);
  });

  /**
   * T105 — the same number, and the reason it did NOT have to move.
   *
   * The aggregate row's `N` changed meaning (it is the segment's run count now,
   * not a `file_path`-deduped file count), and the obvious worry was that this
   * function's "steps" would have to follow it. It does not, because they were
   * never the same count: this one is summed over the whole turn's grouped
   * items and deliberately counts a THOUGHT as a step too ("A tool group is not
   * one step: it is the run(s) and thinking blocks inside it"). Merging two
   * adjacent groups into one item therefore moves entries, and the sum is
   * unchanged — asserted rather than assumed, since a merge that dropped an
   * entry would be invisible everywhere else.
   */
  it('is unchanged by merging two adjacent groups into one item', () => {
    const group = (entries: unknown[]) =>
      ({ kind: 'toolGroup', blockIndex: 0, messageId: 'm1', entries }) as never;
    const before = countProcessSteps([
      group([{ kind: 'run' }, { kind: 'thinking' }]),
      group([{ kind: 'run' }]),
    ]);
    const after = countProcessSteps([
      group([{ kind: 'run' }, { kind: 'thinking' }, { kind: 'run' }]),
    ]);
    expect(after).toBe(before);
    expect(after).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// T112 — one step does not earn a fold
// ---------------------------------------------------------------------------

/**
 * The threshold, truth-tabled against the number the head would have printed.
 *
 * These are not a restatement of `countProcessSteps`: the claim is that the
 * fold and the head's own count are driven by ONE number, so the app can never
 * render a disclosure whose summary reads 「1 个步骤」. Asserting the predicate
 * against `countProcessSteps` of the same items is what pins them together.
 */
describe('turnProcessGroupFolds — a single step renders in place', () => {
  const entryGroup = (entries: number): TurnItem =>
    ({
      kind: 'toolGroup',
      blockIndex: 0,
      messageId: 'm1',
      entries: Array.from({ length: entries }, () => ({ kind: 'run' })),
    }) as unknown as TurnItem;

  it('[WG-ONE-1] one step does not fold, two or more do', () => {
    expect(turnProcessGroupFolds([entryGroup(1)])).toBe(false);
    expect(turnProcessGroupFolds([entryGroup(2)])).toBe(true);
    expect(turnProcessGroupFolds([entryGroup(1), entryGroup(1)])).toBe(true);
    expect(turnProcessGroupFolds([entryGroup(24)])).toBe(true);
  });

  it('[WG-ONE-2] the threshold IS the head count, not an item count', () => {
    // Four runs inside ONE item: an item-count threshold would call this a
    // single row and refuse to fold a group whose head says 「4 个步骤」.
    const items = [entryGroup(4)];
    expect(countProcessSteps(items)).toBe(4);
    expect(turnProcessGroupFolds(items)).toBe(true);
    for (const steps of [0, 1, 2, 3, 7]) {
      expect(turnProcessGroupFolds([entryGroup(steps)]), `${steps}`).toBe(
        countProcessSteps([entryGroup(steps)]) > 1
      );
    }
  });

  it('[WG-ONE-3] a group with nothing to count does not fold either', () => {
    // Not a new case: `deriveTurnWorkGroupLabel` already returned null for it,
    // so it never had a head to hide behind.
    expect(turnProcessGroupFolds([])).toBe(false);
    expect(turnProcessGroupFolds([entryGroup(0)])).toBe(false);
  });

  /**
   * The red line, at the one-step size.
   *
   * A sole unanswered permission is the case where "do not fold" and "force it
   * open" could have disagreed. They cannot: not folding puts the card on
   * screen unconditionally, which is strictly more than `forcedOpen` buys, and
   * `turnWorkGroupAwaitsUser` keeps reporting the same answer for the group so
   * the rule stays in one place for every group that DOES fold.
   */
  it('[WG-ONE-4] a lone unanswered authorization renders in place, and still reads as awaiting', () => {
    const lone = [askItem('permission')];
    expect(turnProcessGroupFolds(lone)).toBe(false);
    expect(turnWorkGroupAwaitsUser([processSegment(lone)])).toBe(true);
    // With a second step it folds — and then the forced-open rule is what keeps
    // the card visible.
    const pair = [askItem('permission'), toolItem()];
    expect(turnWorkGroupAwaitsUser([processSegment(pair)])).toBe(true);
    expect(turnWorkGroupOpen({ forcedOpen: true, userOpen: false })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The head's live clause (T105 / D6)
// ---------------------------------------------------------------------------

/**
 * With the work group always folded, this clause is the ONLY progress evidence
 * a running turn has on screen. So these are not decorative: the fallback case
 * is what keeps the head from dropping to a bare ticking clock in every gap
 * between two tool calls, which would read as a hang.
 */
describe('deriveTurnCurrentAction — what the head says the turn is doing', () => {
  function run(toolName: string, status: ToolRunStatus, id: string): ToolRun {
    return {
      toolCallId: id,
      blockIndex: 0,
      blockId: id,
      toolName,
      input: {},
      status,
    };
  }

  const group = (runs: readonly ToolRun[], messageId = 'm1', blockIndex = 0): TurnItem =>
    ({
      kind: 'toolGroup',
      blockIndex,
      messageId,
      entries: runs.map((r) => ({ kind: 'run', run: r })),
    }) as unknown as TurnItem;

  it('[ACT-1] takes the last running call in the group', () => {
    const action = deriveTurnCurrentAction([
      group([run('Read', 'ok', 'a'), run('Grep', 'running', 'b')]),
    ]);
    expect(action?.run.blockId).toBe('b');
    expect(action?.state).toBe('running');
    expect(action?.verb).toBe('Grepping');
  });

  it('[ACT-2] takes the LAST group, so an earlier group cannot win', () => {
    const action = deriveTurnCurrentAction([
      group([run('Read', 'running', 'stale')], 'm1', 0),
      { kind: 'text', block: { id: 't', type: 'text' }, blockIndex: 1, messageId: 'm1' } as never,
      group([run('Edit', 'running', 'fresh')], 'm2', 0),
    ]);
    expect(action?.run.blockId).toBe('fresh');
  });

  it('[ACT-3] falls back to the last FINISHED call when nothing is running', () => {
    // The defect this guards: between two tool calls (thinking, dispatching the
    // next one) no run is running. Returning null there blinks the clause off
    // and on while the seconds keep counting — a head indistinguishable from a
    // frozen one.
    const action = deriveTurnCurrentAction([
      group([run('Read', 'ok', 'a'), run('Edit', 'ok', 'b')]),
    ]);
    expect(action?.run.blockId).toBe('b');
    expect(action?.state).toBe('refused');
    // The infinitive slot: the head must read 「最后编辑 App.tsx」, never
    // 「最后已编辑」.
    expect(action?.verb).toBe('Edit');
  });

  it('[ACT-4] still reports a fallback when a LATER group holds only thinking', () => {
    const items = [
      group([run('Read', 'ok', 'a')]),
      {
        kind: 'toolGroup',
        blockIndex: 1,
        messageId: 'm2',
        entries: [{ kind: 'thinking', block: { id: 'th', type: 'thinking' }, blockIndex: 0 }],
      } as unknown as TurnItem,
    ];
    expect(deriveTurnCurrentAction(items)?.run.blockId).toBe('a');
  });

  it('[ACT-5] an empty list, and a list with no tool group, give null', () => {
    expect(deriveTurnCurrentAction([])).toBeNull();
    expect(
      deriveTurnCurrentAction([
        { kind: 'text', block: { id: 't', type: 'text' }, blockIndex: 0, messageId: 'm' } as never,
      ])
    ).toBeNull();
  });

  it('[ACT-6] reports what the turn just finished doing, not the first call of the group', () => {
    const action = deriveTurnCurrentAction([
      group([run('Read', 'ok', 'a'), run('Read', 'ok', 'b'), run('Bash', 'ok', 'c')]),
    ]);
    expect(action?.run.blockId).toBe('c');
    expect(action?.verb).toBe('Run');
  });
});
