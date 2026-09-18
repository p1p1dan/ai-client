import { describe, expect, it } from 'vitest';
import type { TurnItem, TurnItemKind, TurnSegment } from '../chatTurn';
import { segmentTurnBody } from '../chatTurn';
import {
  countProcessSteps,
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

describe('turnWorkGroupOpen — auto-collapse once, user intent forever', () => {
  const open = (settled: boolean, forcedOpen: boolean, userOpen: boolean | null): boolean =>
    turnWorkGroupOpen({ settled, forcedOpen, userOpen });

  it('[WG-OPEN-1] a running turn is open, a settled one is closed', () => {
    expect(open(false, false, null)).toBe(true);
    expect(open(true, false, null)).toBe(false);
  });

  it('[WG-OPEN-2] the auto-collapse does not override a user who opened it', () => {
    // The whole point: once the user has clicked, `settled` stops deciding —
    // which is also what makes the collapse a one-shot at the transition rather
    // than something every render re-applies.
    expect(open(true, false, true)).toBe(true);
    expect(open(false, false, false)).toBe(false);
  });

  it('[WG-OPEN-3] restored history mounts collapsed with no history-detection at all', () => {
    // A turn that never ran in this window is `settled` on its first render.
    expect(open(true, false, null)).toBe(false);
  });

  it('[WG-OPEN-4] an unanswered authorization outranks both the clock and the click', () => {
    for (const settled of [true, false]) {
      for (const userOpen of [true, false, null]) {
        expect(open(settled, true, userOpen), `${settled}/${userOpen}`).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Head copy
// ---------------------------------------------------------------------------

describe('deriveTurnWorkGroupLabel', () => {
  it('[WG-LABEL-1] says 「工作中」 while the turn runs, with no second count', () => {
    expect(deriveTurnWorkGroupLabel({ settled: false, workedMs: 61_000, steps: 3 })).toEqual({
      kind: 'working',
    });
  });

  it('[WG-LABEL-2] reports the span in the units the catalog writes', () => {
    expect(deriveTurnWorkGroupLabel({ settled: true, workedMs: 57_000, steps: 3 })).toEqual({
      kind: 'worked',
      minutes: 0,
      seconds: 57,
    });
    expect(deriveTurnWorkGroupLabel({ settled: true, workedMs: 66_000, steps: 3 })).toEqual({
      kind: 'worked',
      minutes: 1,
      seconds: 6,
    });
    expect(deriveTurnWorkGroupLabel({ settled: true, workedMs: 120_000, steps: 3 })).toEqual({
      kind: 'worked',
      minutes: 2,
      seconds: 0,
    });
  });

  /**
   * A07 `:2399`'s red line at the turn scale: unknown duration means OMIT, not
   * `0s`. A restored history turn replays no timing events, and a head reading
   * 「已工作 0 秒」 about a turn that ran four tools is a fabricated measurement.
   */
  it('[WG-LABEL-3] an unknown duration falls back to the step count and prints NO seconds', () => {
    const label = deriveTurnWorkGroupLabel({ settled: true, workedMs: null, steps: 4 });
    expect(label).toEqual({ kind: 'steps', steps: 4 });
    expect(Object.keys(label)).not.toContain('seconds');
    expect(Object.keys(label)).not.toContain('minutes');
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
});
