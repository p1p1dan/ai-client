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

const kindsOf = <T>(segments: readonly TurnSegment<T>[]) => segments.map((s) => s.kind);

// ---------------------------------------------------------------------------
// The final-output rule
// ---------------------------------------------------------------------------

describe('splitTurnWorkGroup — the final output is the LAST answer segment', () => {
  it('[WG-1] an alternating turn keeps only its last paragraph outside the group', () => {
    // "said something, ran a tool, said something, ran a tool, said something" —
    // the shape the user described, and the one the old per-segment fold turned
    // into three 「已处理 N 个步骤」 lines interleaved with prose.
    const split = splitTurnWorkGroup(
      segmentsOf(['text', 'toolGroup', 'text', 'toolGroup', 'text'])
    );
    expect(kindsOf(split.grouped)).toEqual(['answer', 'process', 'answer', 'process']);
    expect(split.finalAnswer?.kind).toBe('answer');
    expect(split.leading).toEqual([]);
    expect(split.trailing).toEqual([]);
  });

  /**
   * ⚠️ FB4 REGRESSION CASE — the reason this rule is written as "the last
   * `answer` SEGMENT" and not "the trailing run of text items".
   *
   * Under the tail rule, a turn ending in an error notice has no trailing text
   * run, so `answer` came out empty and EVERY paragraph the model had written
   * went into the collapsed segment. The user's report was "my prose
   * disappeared into Worked for". Here the notice does not participate: the
   * final output is still the prose before it, still outside the group, and the
   * notice renders under it.
   */
  it('[WG-2] a turn that ENDS in a notice still shows its final output outside the group', () => {
    const segments = segmentsOf(['text', 'toolGroup', 'text', 'notice']);
    const split = splitTurnWorkGroup(segments);
    expect(kindsOf(split.grouped)).toEqual(['answer', 'process']);
    // Identity, not shape: the prose the tail rule used to swallow is THE
    // second paragraph, and it is the one thing guaranteed outside the group.
    expect(split.finalAnswer).toBe(segments[2]);
    expect(kindsOf(split.trailing)).toEqual(['notice']);
  });

  it('[WG-3] a turn with NO answer at all does not swallow its notice', () => {
    // Only ran a tool, then failed. Folding everything would leave one line on
    // screen and hide the error that is the only thing this turn has to say.
    const split = splitTurnWorkGroup(segmentsOf(['toolGroup', 'notice']));
    expect(split.finalAnswer).toBeNull();
    expect(kindsOf(split.grouped)).toEqual(['process']);
    expect(kindsOf(split.trailing)).toEqual(['notice']);
  });

  it('[WG-4] with no answer, a notice BETWEEN two tool runs still stays out of the group', () => {
    const split = splitTurnWorkGroup(segmentsOf(['toolGroup', 'notice', 'permission']));
    expect(split.finalAnswer).toBeNull();
    expect(kindsOf(split.grouped)).toEqual(['process', 'process']);
    expect(kindsOf(split.trailing)).toEqual(['notice']);
  });

  it('[WG-5] a plain one-paragraph reply renders NO group head', () => {
    const split = splitTurnWorkGroup(segmentsOf(['text']));
    expect(split.grouped).toEqual([]);
    expect(split.leading).toEqual([]);
    expect(split.finalAnswer?.kind).toBe('answer');
    expect(split.trailing).toEqual([]);
  });

  it('[WG-6] a group that would hide no work is not opened either', () => {
    // Nothing before the answer but a notice: a head here would hide an error
    // message and summarise zero steps.
    const split = splitTurnWorkGroup(segmentsOf(['notice', 'text']));
    expect(split.grouped).toEqual([]);
    expect(kindsOf(split.leading)).toEqual(['notice']);
    expect(split.finalAnswer?.kind).toBe('answer');
  });

  it('[WG-7] nothing is lost or reordered when an answer exists', () => {
    for (const kinds of [
      ['text'],
      ['text', 'toolGroup', 'text'],
      ['notice', 'text', 'toolGroup', 'text', 'notice'],
      ['toolGroup', 'text', 'notice', 'text'],
      ['permission', 'text', 'toolGroup'],
    ] as TurnItemKind[][]) {
      const segments = segmentsOf(kinds);
      const split = splitTurnWorkGroup(segments);
      const rendered = [
        ...split.leading,
        ...split.grouped,
        ...(split.finalAnswer ? [split.finalAnswer] : []),
        ...split.trailing,
      ];
      expect(rendered, kinds.join(',')).toEqual([...segments]);
    }
  });

  it('[WG-8] mid-stream, a tool called after the last paragraph stays visible until the next one', () => {
    // Streaming order: prose -> tool -> more prose. The boundary moves when the
    // second paragraph opens, which is expected; what must NOT happen is the
    // running tool being hidden while it is the newest thing on screen.
    const streaming = splitTurnWorkGroup(segmentsOf(['text', 'toolGroup']));
    expect(streaming.finalAnswer?.kind).toBe('answer');
    expect(kindsOf(streaming.trailing)).toEqual(['process']);
    expect(streaming.grouped).toEqual([]);

    const settled = splitTurnWorkGroup(segmentsOf(['text', 'toolGroup', 'text']));
    expect(kindsOf(settled.grouped)).toEqual(['answer', 'process']);
    expect(settled.trailing).toEqual([]);
  });

  it('[WG-9] an empty turn produces nothing to render', () => {
    const split = splitTurnWorkGroup([]);
    expect(split).toEqual({ leading: [], grouped: [], finalAnswer: null, trailing: [] });
  });
});

// ---------------------------------------------------------------------------
// The same rule against the four turn shapes real sessions actually produce
// ---------------------------------------------------------------------------

/**
 * Read off `~/.pilab/jyw-ai-client-dev/pi-agent/sessions/session-live-*.jsonl`
 * on 2026-09-18, not imagined. Four shapes account for every turn in the five
 * most recent live sessions:
 *
 * ```
 *   user | text
 *   assistant | thinking,text,toolCall     <- intermediate: explains, then calls
 *   toolResult| text
 *   assistant | thinking,text              <- the final output
 * ```
 *
 * The pieces of one assistant message do NOT stay together on screen:
 * `groupTimeline` flushes the open tool group when a `text` block arrives, so
 * `thinking,text,toolCall` flattens to `toolGroup, text, toolGroup`. That is
 * what makes 「模型在工具调用之间穿插的解释性文字」 an `answer` segment in the
 * middle of the turn — and therefore something the last-answer rule has to have
 * an opinion about.
 */
describe('splitTurnWorkGroup — the turn shapes real pi sessions produce', () => {
  /**
   * The common shape. The mid-turn explanation goes INSIDE the fold; only the
   * paragraph the model ended on stays out. That is the user's own wording:
   * 「折叠后只显示 agent 的最终输出」.
   */
  it('[WG-REAL-1] explanatory text between tool calls folds away; the last paragraph does not', () => {
    const split = splitTurnWorkGroup(
      segmentsOf(['toolGroup', 'text', 'toolGroup', 'toolGroup', 'text'])
    );
    // The two adjacent tool groups are one run-length segment, hence three.
    expect(kindsOf(split.grouped)).toEqual(['process', 'answer', 'process']);
    expect(split.finalAnswer?.kind).toBe('answer');
    expect(split.trailing).toEqual([]);
  });

  /** A turn that only thought — no tool call anywhere. The thought still folds. */
  it('[WG-REAL-2] thinking with no tool call is still work, and still folds', () => {
    const split = splitTurnWorkGroup(segmentsOf(['toolGroup', 'text']));
    expect(kindsOf(split.grouped)).toEqual(['process']);
    expect(split.finalAnswer?.kind).toBe('answer');
    expect(split.leading).toEqual([]);
  });

  /**
   * Interrupted mid-tool (Stop, or a failure): the turn's last event is a tool
   * call, so there is a `process` segment AFTER the last thing the model said.
   *
   * It stays in `trailing`, i.e. VISIBLE, and that is deliberate rather than an
   * oversight of the collapse: on an interrupted turn the unfinished call is the
   * explanation for why there is no answer, and folding it away would leave the
   * turn looking like it simply stopped talking.
   */
  it('[WG-REAL-3] a turn interrupted mid-tool keeps the unfinished call on screen', () => {
    const split = splitTurnWorkGroup(segmentsOf(['toolGroup', 'text', 'toolGroup']));
    expect(kindsOf(split.grouped)).toEqual(['process']);
    expect(split.finalAnswer?.kind).toBe('answer');
    expect(kindsOf(split.trailing)).toEqual(['process']);
  });

  /**
   * Interrupted before the model said anything at all — thinking and a tool
   * call, then the error notice. Everything that ran folds; the notice does
   * not, because a collapsed head is not allowed to hide the only statement the
   * turn has to make (`[WG-3]`, restated against the real shape).
   */
  it('[WG-REAL-4] an interrupted turn with no prose folds the work and keeps the error', () => {
    const split = splitTurnWorkGroup(segmentsOf(['toolGroup', 'notice']));
    expect(split.finalAnswer).toBeNull();
    expect(kindsOf(split.grouped)).toEqual(['process']);
    expect(kindsOf(split.trailing)).toEqual(['notice']);
  });
});

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

describe('turnWorkGroupOpen — open by default, user intent forever', () => {
  const open = (forcedOpen: boolean, userOpen: boolean | null): boolean =>
    turnWorkGroupOpen({ forcedOpen, userOpen });

  /**
   * ⚠️ FLIPPED AGAIN 2026-09-21 (user decision), and the history matters.
   *
   * 2026-09-19 (D6) asserted `open(false, null) === false`: a long tool
   * sequence had left a wall of 「Read / Grep / Read / Edit」 on screen for the
   * whole turn, and the head above it was lost in the middle. The answer then
   * was to start the group folded.
   *
   * That is still true about tool rows — which is why `ToolRows.tsx` keeps
   * every individual row closed and this flip does not touch it. What D6 got
   * wrong is that the group holds more than tool traffic: thinking blocks and
   * tool RESULTS are in there, and the user's own follow-up was 「我发现很多
   * agent 有效输出也在这个栏目下，如果默认折叠,有很多输出都看不到了」. The part of
   * the agent's work they actually wanted to read was behind a 「已工作 57 秒」
   * line every single turn.
   *
   * The `settled` parameter stays DELETED (D6's reasoning, still correct): the
   * default does not depend on it, and an exported input nothing reads is a
   * rule waiting to be mistaken for a live one.
   */
  it('[WG-OPEN-1] the group is open by default, whether it runs or has settled', () => {
    expect(open(false, null)).toBe(true);
  });

  it('[WG-OPEN-2] the default does not override a user who closed it', () => {
    // The load-bearing half: with the default now OPEN, an expanded group that
    // ignored the click would be a group the reader cannot put away — strictly
    // worse than the D6 state it replaces.
    expect(open(false, true)).toBe(true);
    expect(open(false, false)).toBe(false);
  });

  it('[WG-OPEN-3] restored history mounts open, like a live turn', () => {
    // A turn that never ran in this window is settled on its first render and
    // gets the same answer as a running one — no history detection anywhere.
    expect(open(false, null)).toBe(true);
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
