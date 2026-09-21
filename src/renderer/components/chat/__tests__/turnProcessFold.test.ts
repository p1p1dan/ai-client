import { describe, expect, it } from 'vitest';
import type { TurnItem, TurnItemKind, TurnSegment } from '../chatTurn';
import { segmentTurnBody } from '../chatTurn';
import type { ToolRun, ToolRunStatus } from '../toolCard';
import {
  countProcessSteps,
  deriveTurnCurrentAction,
  deriveTurnWorkGroupLabel,
  splitTurnWorkGroup,
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

// T107 supersedes the last-answer rule: FB4 now protects EVERY paragraph.
// The real-session shapes below still cover thinking/text/toolCall interleaving,
// interruption mid-tool, and failures before the first answer.
describe('splitTurnWorkGroup — every answer stays outside process groups', () => {
  it('[WG-1] preserves three paragraphs and folds the two intervening process runs', () => {
    const segments = segmentsOf(['text', 'toolGroup', 'text', 'toolGroup', 'text']);
    expect(splitTurnWorkGroup(segments)).toEqual([
      { kind: 'answer', segment: segments[0] },
      { kind: 'processGroup', segments: [segments[1]] },
      { kind: 'answer', segment: segments[2] },
      { kind: 'processGroup', segments: [segments[3]] },
      { kind: 'answer', segment: segments[4] },
    ]);
  });

  it('[WG-2] an error ending cannot hide ANY earlier answer (FB4)', () => {
    const segments = segmentsOf(['text', 'toolGroup', 'text', 'notice']);
    const sections = splitTurnWorkGroup(segments);
    expect(sections.filter((s) => s.kind === 'answer').map((s) => s.segment)).toEqual([
      segments[0],
      segments[2],
    ]);
    expect(sections.at(-1)).toEqual({ kind: 'notice', segment: segments[3] });
  });

  it('[WG-3/4] without prose, notices stay outside, after the process group', () => {
    const segments = segmentsOf(['toolGroup', 'notice', 'permission']);
    expect(splitTurnWorkGroup(segments)).toEqual([
      { kind: 'processGroup', segments: [segments[0], segments[2]] },
      { kind: 'notice', segment: segments[1] },
    ]);
  });

  it('[WG-5/6] no process means no empty group, even with a notice', () => {
    const segments = segmentsOf(['notice', 'text']);
    expect(splitTurnWorkGroup(segments)).toEqual([
      { kind: 'notice', segment: segments[0] },
      { kind: 'answer', segment: segments[1] },
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
      const sections = splitTurnWorkGroup(segments);
      expect(
        sections.flatMap((s) => (s.kind === 'processGroup' ? s.segments : [s.segment]))
      ).toEqual(segments);
      for (const section of sections) {
        if (section.kind === 'processGroup') {
          expect(section.segments.every((s) => s.kind === 'process')).toBe(true);
        }
      }
    }
  });

  it('[WG-8] appending an answer never moves existing prose or tools into another group', () => {
    const segments = segmentsOf(['text', 'toolGroup', 'text']);
    expect(splitTurnWorkGroup(segments).slice(0, 2)).toEqual(
      splitTurnWorkGroup(segments.slice(0, 2))
    );
  });

  it('[WG-9] an empty turn has no sections', () => {
    expect(splitTurnWorkGroup([])).toEqual([]);
  });

  it('[WG-REAL-1/2] thinking and adjacent calls fold while explanations remain visible', () => {
    const sections = splitTurnWorkGroup(
      segmentsOf(['toolGroup', 'text', 'toolGroup', 'toolGroup', 'text'])
    );
    expect(sections.map((s) => s.kind)).toEqual([
      'processGroup',
      'answer',
      'processGroup',
      'answer',
    ]);
    expect(sections[2].kind === 'processGroup' && sections[2].segments[0].items).toHaveLength(2);
  });

  it('[WG-REAL-3/4] interruption keeps prose and errors outside while folding unfinished work', () => {
    const sections = splitTurnWorkGroup(segmentsOf(['toolGroup', 'text', 'toolGroup', 'notice']));
    expect(sections.map((s) => s.kind)).toEqual([
      'processGroup',
      'answer',
      'processGroup',
      'notice',
    ]);
    expect(splitTurnWorkGroup(segmentsOf(['toolGroup', 'notice'])).map((s) => s.kind)).toEqual([
      'processGroup',
      'notice',
    ]);
  });

  it('[WG-LONG] twenty-four consecutive calls create one process section, not twenty-four', () => {
    const kinds: TurnItemKind[] = ['text', ...Array<TurnItemKind>(24).fill('toolGroup'), 'text'];
    const sections = splitTurnWorkGroup(segmentsOf(kinds));
    expect(sections.map((s) => s.kind)).toEqual(['answer', 'processGroup', 'answer']);
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

describe('turnWorkGroupOpen — closed by default, user intent forever', () => {
  const open = (forcedOpen: boolean, userOpen: boolean | null): boolean =>
    turnWorkGroupOpen({ forcedOpen, userOpen });

  // ef26ca5f temporarily opened groups to expose hidden prose. T107 moves
  // that prose outside instead; the user confirmed closed process groups.
  it('[WG-OPEN-1] process groups default closed while running or settled', () => {
    expect(open(false, null)).toBe(false);
  });

  it('[WG-OPEN-2] either explicit user choice overrides the default', () => {
    expect(open(false, true)).toBe(true);
    expect(open(false, false)).toBe(false);
  });

  it('[WG-OPEN-3] restored history mounts closed, like a live turn', () => {
    expect(open(false, null)).toBe(false);
  });

  it('[WG-OPEN-4] an unanswered authorization outranks both the default and the click', () => {
    for (const userOpen of [true, false, null]) {
      expect(open(true, userOpen), `${userOpen}`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Head copy
// ---------------------------------------------------------------------------

describe('deriveTurnWorkGroupLabel', () => {
  /**
   * 2026-09-18, second pass. This case used to assert the OPPOSITE — 「工作中」
   * and no second count, on the ground that the composer's own status row was
   * already counting. The user's report after living with that arrangement is
   * why it is inverted here: a counter that far from the reply does not read as
   * progress, and a 50-second wait behind a static 「工作中」 reads as a hang.
   *
   * Note which clock it reports: `elapsedSeconds` (the live one), NOT
   * `workedMs`. A running turn has no completion timestamp, so `workedMs` on an
   * unsettled turn is whatever a PREVIOUS message in it happened to close with.
   */
  it('[WG-LABEL-1] a running turn reports the LIVE clock, not the settled span', () => {
    expect(
      deriveTurnWorkGroupLabel({
        settled: false,
        workedMs: 61_000,
        steps: 3,
        elapsedSeconds: 47,
      })
    ).toEqual({ kind: 'working', elapsed: { minutes: 0, seconds: 47 } });
    expect(
      deriveTurnWorkGroupLabel({ settled: false, workedMs: null, steps: 0, elapsedSeconds: 66 })
    ).toEqual({ kind: 'working', elapsed: { minutes: 1, seconds: 6 } });
  });

  /**
   * A session that was already in flight when this window opened replays no
   * `message.started`, so it is running with no origin to count from. The head
   * says a bare 「工作中」 there — `elapsed: null` — rather than 「工作中 0 秒」,
   * which is the same fabricated-measurement rule as [WG-LABEL-3] below.
   */
  it('[WG-LABEL-1b] a running turn with no clock reports no seconds at all', () => {
    expect(
      deriveTurnWorkGroupLabel({
        settled: false,
        workedMs: null,
        steps: 2,
        elapsedSeconds: null,
      })
    ).toEqual({ kind: 'working', elapsed: null });
  });

  it('[WG-LABEL-2] reports the span in the units the catalog writes', () => {
    const settled = (workedMs: number) =>
      deriveTurnWorkGroupLabel({ settled: true, workedMs, steps: 3, elapsedSeconds: null });
    expect(settled(57_000)).toEqual({ kind: 'worked', minutes: 0, seconds: 57 });
    expect(settled(66_000)).toEqual({ kind: 'worked', minutes: 1, seconds: 6 });
    expect(settled(120_000)).toEqual({ kind: 'worked', minutes: 2, seconds: 0 });
  });

  /**
   * A07 `:2399`'s red line at the turn scale: unknown duration means OMIT, not
   * `0s`. A restored history turn replays no timing events, and a head reading
   * 「已工作 0 秒」 about a turn that ran four tools is a fabricated measurement.
   */
  it('[WG-LABEL-3] an unknown duration falls back to the step count and prints NO seconds', () => {
    const label = deriveTurnWorkGroupLabel({
      settled: true,
      workedMs: null,
      steps: 4,
      elapsedSeconds: null,
    });
    expect(label).toEqual({ kind: 'steps', steps: 4 });
    expect(Object.keys(label ?? {})).not.toContain('seconds');
    expect(Object.keys(label ?? {})).not.toContain('minutes');
  });

  /**
   * The head now renders for turns that fold NO work (that is the whole point
   * of the second pass — a 50-second one-word reply used to show nothing), so
   * it needs an answer for the one turn that has nothing honest to say: settled,
   * no timing, no steps. That is restored history, and both fallbacks would be
   * inventions there — `0 秒` and 「已处理 0 个步骤」 alike.
   */
  it('[WG-LABEL-4] a settled turn with neither a duration nor a step renders no head', () => {
    expect(
      deriveTurnWorkGroupLabel({ settled: true, workedMs: null, steps: 0, elapsedSeconds: null })
    ).toBeNull();
  });
});

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
