import type { SessionRuntimeStatus } from '@shared/types/runtimeEvents';
import { describe, expect, it } from 'vitest';
import {
  COMPOSER_BAR_LEADING,
  COMPOSER_BAR_TRAILING,
  COMPOSER_CONTROL_SIZE,
  composerActionGroupClass,
  composerAttachButtonClass,
  composerBarClass,
  composerCardClass,
  composerFollowHeightBreakdown,
  composerHasProtrusion,
  composerModelBaseClass,
  composerModelSuffixClass,
  composerModelTriggerClass,
  composerPermissionTriggerClass,
  composerPlaceholder,
  composerPopupSide,
  composerRowsClass,
  composerTextareaClass,
  deriveMiddleColumnMode,
  type MiddleColumnMode,
  type MiddleColumnModeInput,
  mentionPopupPlacementClass,
  middleColumnHostClass,
  queueStripWrapperClass,
  rememberSendAttempt,
  resolveIdleStatusText,
  roundActionButtonClass,
  roundActionButtonKindClass,
  sessionStatusLineWrapperClass,
  shouldRenderTargetRow,
  shouldShowStatusLine,
  TIMELINE_PADDING_CLASS,
  targetRowClass,
  targetRowSlots,
  targetTriggerClass,
} from '../middleColumnLayout';
import { QUESTION_DOCK_WRAPPER_CLASS } from '../questionCardModel';

/**
 * T-30b2 assertion suite (Composer form alignment).
 *
 * Assertion ids below map to the design spec and its round-4 addendum. Three
 * ids were superseded when the addendum settled the three open decisions:
 * F-A5 → F-A15 (stricter superset), F-A8 → F-A20 (moved to the static-scan
 * file), F-A14 → F-A22. The old ids are noted at each call site so the spec
 * can still be walked line by line.
 *
 * Every assertion here is a pure function or a string: `.tsx` files have zero
 * coverage under this repo's node-env vitest, so no assertion may require a
 * render.
 */

/** Pull the numeric part of a spacing/size step out of a class string. */
function stepValue(cls: string, pattern: RegExp): number | null {
  const match = cls.match(pattern);
  return match ? Number(match[1]) : null;
}

function baseInput(overrides: Partial<MiddleColumnModeInput> = {}): MiddleColumnModeInput {
  return {
    sessionId: 'session-1',
    messageCount: 0,
    sendAttempted: false,
    hostBound: false,
    hasRuntimeIdentity: false,
    hasHistoryError: false,
    status: 'idle',
    ...overrides,
  };
}

describe('deriveMiddleColumnMode', () => {
  it('returns empty when there is no active session', () => {
    expect(deriveMiddleColumnMode(baseInput({ sessionId: null }))).toBe('empty');
  });

  it('returns empty when sessionId is null even though a send was attempted earlier', () => {
    expect(deriveMiddleColumnMode(baseInput({ sessionId: null, sendAttempted: true }))).toBe(
      'empty'
    );
  });

  it('returns empty for a freshly created session with no messages, no identity and no send attempt', () => {
    expect(deriveMiddleColumnMode(baseInput())).toBe('empty');
  });

  it('returns session as soon as the bucket holds one message', () => {
    expect(deriveMiddleColumnMode(baseInput({ messageCount: 1 }))).toBe('session');
  });

  it('returns session the moment a send starts, before any message lands', () => {
    expect(deriveMiddleColumnMode(baseInput({ messageCount: 0, sendAttempted: true }))).toBe(
      'session'
    );
  });

  it('keeps session after a failed send that never produced a message', () => {
    expect(
      deriveMiddleColumnMode(baseInput({ messageCount: 0, sendAttempted: true, status: 'failed' }))
    ).toBe('session');
  });

  it('returns session for a session restored from the index (runtimeIdentity set, history not replayed)', () => {
    expect(
      deriveMiddleColumnMode(
        baseInput({ messageCount: 0, sendAttempted: false, hasRuntimeIdentity: true })
      )
    ).toBe('session');
  });

  it('returns session for a host-bound session whose bucket is still empty', () => {
    expect(
      deriveMiddleColumnMode(baseInput({ messageCount: 0, sendAttempted: false, hostBound: true }))
    ).toBe('session');
  });

  it('returns session when the history read failed, with no messages and no identity', () => {
    expect(
      deriveMiddleColumnMode(
        baseInput({
          messageCount: 0,
          sendAttempted: false,
          hostBound: false,
          hasRuntimeIdentity: false,
          hasHistoryError: true,
        })
      )
    ).toBe('session');
  });

  it('returns session while the session is busy (starting/running/waiting_*/stopping)', () => {
    const busyStatuses: SessionRuntimeStatus[] = [
      'starting',
      'running',
      'waiting_permission',
      'waiting_question',
      'stopping',
    ];
    for (const status of busyStatuses) {
      expect(deriveMiddleColumnMode(baseInput({ messageCount: 0, status }))).toBe('session');
    }
  });

  it('returns session when the session status is failed', () => {
    expect(deriveMiddleColumnMode(baseInput({ messageCount: 0, status: 'failed' }))).toBe(
      'session'
    );
  });
});

describe('rememberSendAttempt', () => {
  it('appends the session id', () => {
    expect(rememberSendAttempt(['a'], 'b')).toEqual(['a', 'b']);
  });

  it('returns the same array reference when the id is already tracked', () => {
    const tracked = ['a', 'b'];
    expect(rememberSendAttempt(tracked, 'b')).toBe(tracked);
  });

  it('returns the same array reference for a null session id', () => {
    const tracked = ['a', 'b'];
    expect(rememberSendAttempt(tracked, null)).toBe(tracked);
  });
});

describe('middleColumnHostClass', () => {
  it('centers the composer and applies the A07 9% bottom offset in empty mode', () => {
    const cls = middleColumnHostClass('empty');
    expect(cls).toContain('justify-center');
    expect(cls).toContain('pb-[9%]');
  });

  // F-A10: the 8px gap above the composer card belongs to exactly one owner.
  // The host used to add 6px on top of whichever upstream was present, so the
  // real gap was 14px — two elements each contributing half a contract is the
  // shape of bug this asserts against.
  it('F-A10: adds no top padding of its own in session mode, leaving the 8px gap to its single upstream owner', () => {
    const cls = middleColumnHostClass('session');
    expect(cls).toContain('pt-0');
    expect(cls).not.toMatch(/(^|\s)pt-(?!0(\s|$))/);
    expect(cls).toContain('pb-3.5');
  });

  it('F-A10: each upstream of the composer card carries the 8px gap exactly once', () => {
    expect(TIMELINE_PADDING_CLASS).toContain('pb-2');
    expect(QUESTION_DOCK_WRAPPER_CLASS).toContain('pb-2');
    expect(queueStripWrapperClass()).toContain('mb-2');
    expect(queueStripWrapperClass()).not.toContain('mb-1.5');
  });

  it('keeps the same horizontal padding in both modes', () => {
    expect(middleColumnHostClass('empty')).toContain('px-6');
    expect(middleColumnHostClass('session')).toContain('px-6');
  });

  it('never lets the docked host grow (shrink-0) or the centered host collapse (flex-1)', () => {
    const empty = middleColumnHostClass('empty');
    const session = middleColumnHostClass('session');
    expect(empty).toContain('flex-1');
    expect(empty).not.toContain('shrink-0');
    expect(session).toContain('shrink-0');
    expect(session).not.toContain('flex-1');
  });
});

describe('composerCardClass', () => {
  // F-A1: the resting edge is --border and focus steps it to --input, a
  // neutral ΔL with zero chroma. The old pair rested on --input and focused to
  // --ring (the brand orange) — a 2.5x heavier resting edge plus a fully
  // chromatic focus state.
  it('F-A1: rests on --border and focuses to --input, with no brand-orange focus edge in either mode', () => {
    for (const mode of ['empty', 'session'] satisfies MiddleColumnMode[]) {
      const cls = composerCardClass(mode);
      expect(cls).toContain('border-border');
      expect(cls).toContain('focus-within:border-input');
      // A standalone `border-input` would be the RESTING edge; the
      // `focus-within:`-prefixed one is the focus edge and must not match.
      expect(cls).not.toMatch(/(^|\s)border-input(\s|$)/);
      expect(cls).not.toContain('focus-within:border-ring');
      expect(cls).toContain('bg-card');
    }
  });

  // F-A7: A07 :1337 (zero shadows on buttons and cards), independently
  // confirmed by measurement — the reference card's "float" comes from a
  // slightly brighter fill plus a hairline edge, not from a shadow.
  it('F-A7: carries no shadow in either mode', () => {
    for (const mode of ['empty', 'session'] satisfies MiddleColumnMode[]) {
      expect(composerCardClass(mode)).not.toContain('shadow-');
    }
  });

  it('gives both cards one symmetric 8px inset instead of a three-value padding', () => {
    for (const mode of ['empty', 'session'] satisfies MiddleColumnMode[]) {
      const cls = composerCardClass(mode);
      expect(cls).toContain('p-2');
      expect(cls).not.toMatch(/(^|\s)p[xytblrse]-/);
    }
  });

  // F-A2: the T-28 blocker was a test that asserted a class was PRESENT and
  // therefore could not notice that the height it composed was wrong. This
  // crosses the spelled Tailwind step against the arithmetic breakdown, so a
  // change to either one alone fails.
  //
  // F6 (2026-08-18): the contract is 74px, not 42px — the card now stacks a
  // textarea row and a control row with an 8px gap between them. The
  // load-bearing proposition is unchanged ("the resting height is DERIVED, not
  // copied"), so this is a value change rather than a retirement; the
  // breakdown simply grew the two terms the second row introduced, and the gap
  // term is cross-checked against the class that actually produces it.
  //
  // The `items-center` assertion that used to sit here is GONE on purpose, not
  // by omission: the card's only in-flow child is now a single full-width
  // column, so centring it cross-axis is meaningless, and it aligns
  // ambiguously the moment the extras stack appears.
  it('F-A2: rests the follow-up card at exactly 74px, cross-checking the class step against the arithmetic', () => {
    const cls = composerCardClass('session');
    const breakdown = composerFollowHeightBreakdown();

    expect(breakdown.rows).toBe(2);
    expect(breakdown.content).toBe(COMPOSER_CONTROL_SIZE);
    expect(
      breakdown.border +
        breakdown.padding +
        breakdown.content * breakdown.rows +
        breakdown.rowGap * (breakdown.rows - 1)
    ).toBe(breakdown.total);
    expect(breakdown.total).toBe(74);

    // The inter-row gap is not a free number either: it is whatever
    // `composerRowsClass()` spells, so the two cannot drift apart.
    const gapStep = stepValue(composerRowsClass(), /(?:^|\s)gap-(\d+(?:\.\d+)?)(?:\s|$)/);
    expect(gapStep).not.toBeNull();
    expect((gapStep as number) * 4).toBe(breakdown.rowGap);

    const step = stepValue(cls, /(?:^|\s)min-h-(\d+(?:\.\d+)?)(?:\s|$)/);
    expect(step).not.toBeNull();
    expect((step as number) * 4).toBe(breakdown.total);

    expect(cls).toContain('flex');
    // The single-row 42px step must not come back on its own: that spelling
    // and the two-row structure cannot both be right.
    expect(cls).not.toContain('min-h-10.5');
  });

  // F-A2's blind spot, same shape as the one F-A3 documents for `size-*`: the
  // arithmetic above cross-checks the UNPREFIXED `min-h-10.5` and `p-2`, and a
  // variant-prefixed sibling (`sm:min-h-11`, `focus-within:p-3`, …) belongs to
  // a different tailwind-merge conflict group, so it does not displace them —
  // it simply wins wherever it applies. Above the `sm` breakpoint (i.e. every
  // real window) the card would rest at a different height while every
  // assertion in this file still passed. Since exactly one height and one inset
  // are contracted here, ANY variant-prefixed spacing/height token is the bug,
  // and enumerating them is cheaper than guessing which one gets written.
  it('F-A2: no variant-prefixed padding or height token can override the resting contract', () => {
    const spacingBase = /^(?:p[xytbrlse]?|min-h)-/;
    const offenders = composerCardClass('session')
      .split(/\s+/)
      .filter((token) => token.includes(':'))
      .filter((token) => spacingBase.test(token.slice(token.lastIndexOf(':') + 1)));
    expect(offenders).toEqual([]);
  });

  // [F6-1] RETIRES both F-A21 assertions and F-A2b (2026-08-18). Those three
  // asserted the PILL DERIVATION: that the session card's radius was
  // `composerFollowHeightBreakdown().total / 2` spelled as a constant, and
  // that `hasExtras` switched it down to `rounded-md`. That derivation chain
  // is what stopped being true — not its value. Followed literally at the new
  // 74px resting height it yields `rounded-[37px]`, which is a hand-written
  // arbitrary value (the design system bans those), and half-height corners on
  // a two-row card read as a stretched capsule rather than a pill. The card
  // has no pill mental model left to protect, so the whole chain retires and
  // both cards simply share `rounded-md`.
  //
  // What replaces it is a stronger fact than "the number is 12": arbitrary-
  // value radii are out of this card entirely. `rounded-[21px]` coming back —
  // or any other `rounded-[…]` — is the regression, whatever its number.
  it('[F6-1] both composer cards share rounded-md, with no arbitrary-value radius anywhere', () => {
    for (const mode of ['empty', 'session'] satisfies MiddleColumnMode[]) {
      const cls = composerCardClass(mode);
      expect(cls).toContain('rounded-md');
      expect(cls).not.toMatch(/rounded-\[/);
      expect(cls).not.toContain('rounded-full');
    }
  });

  it('never uses rounded-lg (16px in this repo) for the card', () => {
    expect(composerCardClass('empty')).not.toContain('rounded-lg');
    expect(composerCardClass('session')).not.toContain('rounded-lg');
  });

  // U09-1: the tab and the card's top radius are one visual join, so they are
  // asserted against each other rather than each on its own.
  describe('U09-1 protrusion join', () => {
    it('drops the top corners to 4px when the tab is present, keeping the bottom at 10px', () => {
      const cls = composerCardClass('empty', { hasProtrusion: true });
      expect(cls).toContain('rounded-t-xs');
      // The base `rounded-md` must survive — it is what the bottom corners
      // still render at; dropping it would square the whole card.
      expect(cls).toContain('rounded-md');
      expect(cls).not.toMatch(/rounded-\[/);
    });

    it('leaves the card untouched with no tab, which is the fresh-install state', () => {
      const withoutTab = composerCardClass('empty', { hasProtrusion: false });
      expect(withoutTab).toBe(composerCardClass('empty'));
      expect(withoutTab).not.toContain('rounded-t-');
    });

    // A session card never wears the tab, so the flag must not be able to give
    // it one — otherwise a future caller passing the option unconditionally
    // would square the docked card's top edge against nothing.
    it('ignores the flag in session mode', () => {
      expect(composerCardClass('session', { hasProtrusion: true })).toBe(
        composerCardClass('session')
      );
    });
  });
});

describe('composerHasProtrusion', () => {
  it('wears the tab in empty mode with a targetable workspace', () => {
    expect(composerHasProtrusion({ mode: 'empty', hasTargetableWorkspace: true })).toBe(true);
  });

  // No targetable workspace means `ComposerTargetBar` renders nothing, so a
  // squared-off top edge would sit above empty space.
  it('has no tab without a targetable workspace', () => {
    expect(composerHasProtrusion({ mode: 'empty', hasTargetableWorkspace: false })).toBe(false);
  });

  // U09-1 acceptance 2: the tab is an empty-state form only. The session card
  // keeps its bar docked BELOW, which is a different element in a different
  // place — this asserts the tab form specifically never appears there.
  it('never wears the tab in session mode, however targetable the workspace', () => {
    expect(composerHasProtrusion({ mode: 'session', hasTargetableWorkspace: true })).toBe(false);
  });

  // The predicate must stay tied to `shouldRenderTargetRow`, not drift into a
  // second opinion about when the bar exists: in empty mode the branch and
  // run-location slots gate nothing, so they cannot change the answer.
  it('matches shouldRenderTargetRow regardless of the branch/run-location slots', () => {
    for (const showBranchSelect of [true, false]) {
      for (const hasRunLocation of [true, false]) {
        for (const hasTargetableWorkspace of [true, false]) {
          expect(composerHasProtrusion({ mode: 'empty', hasTargetableWorkspace })).toBe(
            shouldRenderTargetRow({
              mode: 'empty',
              hasTargetableWorkspace,
              showBranchSelect,
              hasRunLocation,
            })
          );
        }
      }
    }
  });
});

describe('composerBarClass / composerActionGroupClass', () => {
  it('offsets the empty-state bottom bar 6px below the textarea and gaps it at 8px', () => {
    const cls = composerBarClass('empty');
    expect(cls).toContain('mt-1.5');
    expect(cls).toContain('gap-2');
    expect(cls).toContain('items-center');
  });

  it('gives the docked single row the same 8px gap with no top offset', () => {
    const cls = composerBarClass('session');
    expect(cls).toContain('gap-2');
    expect(cls).toContain('min-w-0');
    expect(cls).not.toContain('mt-');
  });

  // F6 (2026-08-18) REVERSES the round-5 fix (diag:placeholder-align), because
  // the condition that fix existed for is gone. `items-start` was chosen for
  // one reason: the textarea was the single child in this row whose rendered
  // height was NOT pinned to 24px (`field-sizing-content`), so `items-center`
  // would centre its taller box against the 24px reference and push its
  // top-anchored first line above the other controls' centreline. Row 2 no
  // longer contains the textarea — every remaining child is an exact 24px box,
  // which makes the two values equivalent in output and `items-center` the
  // honest one to write.
  it('F6: aligns the docked control row by centre, now that the textarea has left it', () => {
    const cls = composerBarClass('session');
    expect(cls).toContain('items-center');
    expect(cls).not.toContain('items-start');
  });

  // The action group is shared by BOTH modes now (F6): it tail-anchors the
  // round keys at the end of the empty card's bottom bar and of the session
  // card's row 2. Without the auto margin the round key would slide left
  // whenever the slots to its left are narrow, breaking the "Stop replaces
  // Send in place" rule the whole button stack is built on.
  it('pins the action group right in both modes, whatever sits to its left', () => {
    const cls = composerActionGroupClass();
    expect(cls).toContain('ms-auto');
    expect(cls).toContain('shrink-0');
  });

  // U09-2 acceptance 1. The prototype's bar reads
  // 「＋附件 · 权限管理」 on the left and 「上下文占用 · 模型 · 思考 · 发送」 on the
  // right; "模型 · 思考" is one merged chip here (evidence-u09 #2), so it is a
  // single `modelEffort` slot in that position.
  describe('U09-2 bar order', () => {
    it('leads with attach then the permission position', () => {
      expect(COMPOSER_BAR_LEADING).toEqual(['attach', 'permission']);
    });

    it('trails with usage, then model/effort, then the send key', () => {
      expect(COMPOSER_BAR_TRAILING).toEqual(['usage', 'modelEffort', 'actions']);
    });

    // The send key must be last in the bar, full stop: every "Stop replaces
    // Send in place" guarantee assumes a fixed terminal position.
    it('keeps the action slot last', () => {
      expect(COMPOSER_BAR_TRAILING.at(-1)).toBe('actions');
      expect(COMPOSER_BAR_LEADING).not.toContain('actions');
    });

    // A slot appearing in both groups would render its control twice.
    it('assigns every slot to exactly one group', () => {
      const all = [...COMPOSER_BAR_LEADING, ...COMPOSER_BAR_TRAILING];
      expect(new Set(all).size).toBe(all.length);
    });

    // The two reserved positions exist so U12 and T38 fill a slot rather than
    // reopening the order debate. Losing them is how a later slice ends up
    // appending its control wherever it happens to be convenient.
    it('reserves the permission and usage positions', () => {
      const all = [...COMPOSER_BAR_LEADING, ...COMPOSER_BAR_TRAILING];
      expect(all).toContain('permission');
      expect(all).toContain('usage');
    });
  });

  // The two-row mechanism itself. `[F6-4]` proves this class is APPLIED to the
  // session branch's root; nothing there proves it lays out as a column, so a
  // silent `flex-col` → `flex-row` edit would put the textarea back beside the
  // controls with every AST assertion still green. `flex-1`/`min-w-0` are the
  // pair that lets the column fill the card and still shrink below its
  // content's intrinsic width.
  it('F6: the session card body is a growable, shrinkable column', () => {
    const cls = composerRowsClass();
    expect(cls).toContain('flex-col');
    expect(cls).toContain('flex-1');
    expect(cls).toContain('min-w-0');
    expect(cls).not.toContain('flex-row');
  });
});

describe('composerTextareaClass', () => {
  it('gives the empty card a 56px minimum input height on the inner textarea', () => {
    const cls = composerTextareaClass('empty');
    expect(cls).toContain('min-h-14');
    expect(cls).toContain('[&_textarea]:min-h-14');
  });

  it('collapses the follow-up input to one 24px row', () => {
    expect(composerTextareaClass('session')).toContain('[&_textarea]:min-h-6');
  });

  it('caps follow-up growth at the empty-state 56px height instead of inventing a third step', () => {
    expect(composerTextareaClass('session')).toContain('[&_textarea]:max-h-14');
  });

  it('zeroes the inner horizontal padding so the caret lines up with the card edge in both modes', () => {
    expect(composerTextareaClass('empty')).toContain('[&_textarea]:px-0');
    expect(composerTextareaClass('session')).toContain('[&_textarea]:px-0');
  });

  it('pierces resize-none through to the real inner textarea (round-2 fix: a bare resize-none on the unstyled outer span never reached the native <textarea>)', () => {
    expect(composerTextareaClass('empty')).toContain('[&_textarea]:resize-none');
    expect(composerTextareaClass('session')).toContain('[&_textarea]:resize-none');
  });

  it('gives the follow-up textarea a leading-6 line-height so its resting line fills the 24px floor instead of sitting high (round-2 visual fix)', () => {
    expect(composerTextareaClass('session')).toContain('[&_textarea]:leading-6');
    // Empty mode keeps its own symmetric padding-based centering — no floor to fill.
    expect(composerTextareaClass('empty')).not.toContain('leading-6');
  });

  it('drops the border/bg/shadow/ring counters now that <Textarea unstyled> renders no outer chrome to fight', () => {
    for (const mode of ['empty', 'session'] satisfies MiddleColumnMode[]) {
      const cls = composerTextareaClass(mode);
      expect(cls).not.toContain('border-0');
      expect(cls).not.toContain('bg-transparent');
      expect(cls).not.toContain('shadow-none');
      expect(cls).not.toContain('focus-visible:ring-0');
    }
  });

  // [F6-2] RETIRES the 128px width floor (round-4 defect B) and the dominant
  // flex-grow weight (F5b), 2026-08-18. Both were patches for ONE condition:
  // the session row held two elastic text competitors, so the textarea needed
  // a floor no sibling's shrink math could cross and a grow weight that
  // outvoted the status slot. Row 1 now holds the textarea and nothing else,
  // which deletes the contest rather than arbitrating it.
  //
  // The replacement fact is that the contest cannot come back by accident:
  // any `flex-` weight or `min-w-` floor on this class means something is
  // sharing the row again, which is the regression this catches.
  it('[F6-2] the session textarea owns its whole row, carrying no flex weight and no width floor', () => {
    const cls = composerTextareaClass('session');
    expect(cls).toContain('w-full');
    expect(cls).not.toMatch(/(?:^|\s)flex-/);
    expect(cls).not.toMatch(/(?:^|\s)min-w-/);
  });

  it('[F6-2] the empty-state textarea never picked up the row-sharing patches either', () => {
    const cls = composerTextareaClass('empty');
    expect(cls).not.toContain('min-w-32');
    expect(cls).not.toContain('flex-[2]');
  });
});

describe('sessionStatusLineWrapperClass (F6: the status slot left the control row)', () => {
  // [F6-3] RETIRES all five assertions this group used to hold (`basis-0`,
  // `shrink` + `min-w-0`, non-zero grow, `max-w-48`, `h-6`), 2026-08-18. Every
  // one of them arbitrated this slot's share of a row it no longer sits in:
  // the session status line moved into the extras stack above the textarea
  // (§6.4), where it is the only thing on its line and has the full card width
  // to itself. A width cap, a zero basis, a grow weight and a compensating
  // fixed height are all answers to a question that stopped being asked — kept
  // as-is they would cap this line at 192px for no reason anyone could name.
  //
  // The one surviving requirement is that it can still shrink below its
  // content: the text is arbitrary-length and the `truncate` on the inner
  // `<p>` needs a zero min-width somewhere above it to ever fire.
  it('[F6-3] is a plain full-line slot: shrinkable, with none of the row-contest patches left', () => {
    const cls = sessionStatusLineWrapperClass();
    expect(cls).toContain('min-w-0');
    expect(cls).toContain('items-center');
    expect(cls).not.toContain('flex-1');
    expect(cls).not.toMatch(/(?:^|\s)basis-/);
    expect(cls).not.toMatch(/(?:^|\s)max-w-/);
    expect(cls).not.toMatch(/(?:^|\s)h-6(?:\s|$)/);
  });
});

describe('resolveIdleStatusText (F5a, round-4 Codex NEEDS-FIX #4)', () => {
  const statusHint = 'Error: something went wrong';
  const largeHint = 'Attachments total 12 MB — sending may take longer.';

  it('session mode + hasStatusError: selects largeHint, never the full statusHint, even though shouldShowStatusLine can still show the row for hasLargeHint alone', () => {
    expect(
      resolveIdleStatusText({ mode: 'session', hasStatusError: true, largeHint, statusHint })
    ).toBe(largeHint);
  });

  it('session mode + hasStatusError + no largeHint: selects null (the row will not render at all — shouldShowStatusLine agrees)', () => {
    expect(
      resolveIdleStatusText({ mode: 'session', hasStatusError: true, largeHint: null, statusHint })
    ).toBeNull();
  });

  it('session mode + no hasStatusError + largeHint: selects largeHint (unchanged from before this fix)', () => {
    expect(
      resolveIdleStatusText({ mode: 'session', hasStatusError: false, largeHint, statusHint })
    ).toBe(largeHint);
  });

  it('session mode + no hasStatusError + no largeHint: falls back to statusHint (the "Ready · cwd:" case — unchanged)', () => {
    expect(
      resolveIdleStatusText({ mode: 'session', hasStatusError: false, largeHint: null, statusHint })
    ).toBe(statusHint);
  });

  it('empty mode + hasStatusError: still selects the full statusHint (unaffected by this fix — only session mode changed)', () => {
    expect(
      resolveIdleStatusText({ mode: 'empty', hasStatusError: true, largeHint, statusHint })
    ).toBe(statusHint);
  });

  it('empty mode + no hasStatusError + largeHint: still selects largeHint (unaffected)', () => {
    expect(
      resolveIdleStatusText({ mode: 'empty', hasStatusError: false, largeHint, statusHint })
    ).toBe(largeHint);
  });
});

describe('targetRowClass / targetRowSlots', () => {
  // U09-1 (2026-09-03) REPLACES the old "8px above the card" assertion. That
  // gap was the free-floating row's defining property and is exactly what the
  // protrusion tab retires: joined means zero gap. Asserting its ABSENCE is
  // the stronger fact — any bottom margin creeping back un-joins the tab, and
  // there is no second owner of that space to compensate with.
  it('joins the empty-mode tab flush to the card, with no gap below it', () => {
    const cls = targetRowClass('empty');
    expect(cls).not.toMatch(/(^|\s)mb-/);
    expect(cls).toContain('rounded-t-md');
    // Bottom corners must stay square or the tab meets the card on a curve.
    expect(cls).not.toMatch(/(^|\s)rounded-b/);
    expect(cls).not.toMatch(/(^|\s)rounded-md(\s|$)/);
  });

  it('insets the empty-mode tab so the card edge reads as sitting on it', () => {
    expect(targetRowClass('empty')).toContain('mx-3');
  });

  it('fills the empty-mode tab with the adjacent surface step, never the hover token', () => {
    const cls = targetRowClass('empty');
    expect(cls).toContain('bg-muted');
    // `bg-hover` means "pointer is over this"; as a resting fill it would
    // leave the real hover state with nowhere to go.
    expect(cls).not.toContain('bg-hover');
  });

  it('places the target row 8px below the card in session mode', () => {
    expect(targetRowClass('session')).toContain('mt-2');
  });

  // The empty row became a filled CONTAINER around the 24px control tier, so
  // it carries 28px to give its chips 2px of breathing room. 28px is the
  // sidebar row step D03 pinned, not a new one. The session row is still bare
  // and stays at the control height itself.
  it('keeps 4px gaps in both modes, with 28px for the tab and 24px for the bare row', () => {
    expect(targetRowClass('empty')).toContain('h-7');
    expect(targetRowClass('empty')).toContain('gap-1');
    expect(targetRowClass('session')).toContain('h-6');
    expect(targetRowClass('session')).toContain('gap-1');
  });

  it('renders folder + branch + run location in empty mode', () => {
    expect(targetRowSlots('empty')).toEqual({ folder: true, branch: true, runLocation: true });
  });

  it('drops the folder slot in session mode', () => {
    expect(targetRowSlots('session')).toEqual({ folder: false, branch: true, runLocation: true });
  });
});

describe('shouldRenderTargetRow', () => {
  it('renders nothing without a targetable workspace, in either mode', () => {
    expect(
      shouldRenderTargetRow({
        mode: 'empty',
        hasTargetableWorkspace: false,
        showBranchSelect: true,
        hasRunLocation: true,
      })
    ).toBe(false);
    expect(
      shouldRenderTargetRow({
        mode: 'session',
        hasTargetableWorkspace: false,
        showBranchSelect: true,
        hasRunLocation: true,
      })
    ).toBe(false);
  });

  it('renders the empty-mode row even when branch and run location are unavailable', () => {
    expect(
      shouldRenderTargetRow({
        mode: 'empty',
        hasTargetableWorkspace: true,
        showBranchSelect: false,
        hasRunLocation: false,
      })
    ).toBe(true);
  });

  it('renders nothing in session mode when neither branch nor run location is available', () => {
    expect(
      shouldRenderTargetRow({
        mode: 'session',
        hasTargetableWorkspace: true,
        showBranchSelect: false,
        hasRunLocation: false,
      })
    ).toBe(false);
  });
});

describe('shouldShowStatusLine', () => {
  const resting = { sending: false, reading: 0, hasStatusError: false, hasLargeHint: false };

  // F-A11: one truth table for both modes, 8 cases. The empty card used to
  // return `true` unconditionally, parking a permanent `Ready · cwd: /home/…`
  // line inside it — the reference has no such element, and A07 :1612 says
  // nothing is permanently docked in the empty state.
  //
  // Note that dropping this line is only legitimate BECAUSE the cwd path it
  // used to be the sole carrier of is now reachable from the target row's
  // folder trigger tooltip. The compensation is asserted separately, in the
  // component that renders it.
  it('F-A11: hides the resting status line in BOTH modes', () => {
    for (const mode of ['empty', 'session'] satisfies MiddleColumnMode[]) {
      expect(shouldShowStatusLine({ mode, ...resting })).toBe(false);
    }
  });

  // T-31 §3.2: `sending` was the fourth trigger and is gone — see F-B11 below.
  it('F-A11: any one of the three remaining conditions shows it, in either mode', () => {
    const triggers = [{ reading: 1 }, { hasStatusError: true }, { hasLargeHint: true }];
    for (const mode of ['empty', 'session'] satisfies MiddleColumnMode[]) {
      for (const trigger of triggers) {
        expect(shouldShowStatusLine({ mode, ...resting, ...trigger })).toBe(true);
      }
    }
  });

  // F-B11 (T-31 §3.2): the waiting copy describes the turn in flight, not the
  // draft in hand, so it moved to the turn head. If `sending` still lit this
  // row, one fact from one source would print in two places at once — the
  // exact duplication the migration exists to remove. `reading > 0` is the
  // control: it describes the draft (attachments still being read off disk),
  // so it stays.
  it('F-B11: sending alone no longer shows the composer status line, in either mode', () => {
    for (const mode of ['empty', 'session'] satisfies MiddleColumnMode[]) {
      expect(shouldShowStatusLine({ mode, ...resting, sending: true })).toBe(false);
      expect(shouldShowStatusLine({ mode, ...resting, reading: 1 })).toBe(true);
    }
  });

  it('F-B11: sending does not resurrect the row alongside a draft-side condition either', () => {
    expect(
      shouldShowStatusLine({ mode: 'session', ...resting, sending: true, hasLargeHint: true })
    ).toBe(true);
    expect(
      shouldShowStatusLine({ mode: 'session', ...resting, sending: true, hasStatusError: false })
    ).toBe(false);
  });
});

describe('mentionPopupPlacementClass', () => {
  it('opens upward from the docked composer', () => {
    expect(mentionPopupPlacementClass('session')).toContain('bottom-full');
  });

  it('opens downward from the centered composer', () => {
    expect(mentionPopupPlacementClass('empty')).toContain('top-full');
  });
});

describe('roundActionButtonClass', () => {
  // F-A3: 28px came from A07 :1329 reading "the reference send key looks about
  // 36px" and discounting it — the measured value is 24, so the input to that
  // derivation was 25% off. 24 is this design system's own button tier.
  it('F-A3: is a 24px box, cross-checked against the single control tier', () => {
    const cls = roundActionButtonClass();
    expect(cls).toContain('size-6');
    expect(cls).not.toContain('size-7');

    const step = stepValue(cls, /(?:^|\s)size-(\d+(?:\.\d+)?)(?:\s|$)/);
    expect(step).not.toBeNull();
    expect((step as number) * 4).toBe(COMPOSER_CONTROL_SIZE);
  });

  // `Button`'s `icon-sm` size is `size-8 sm:size-7`. A bare `size-6` only
  // displaces the unprefixed half — tailwind-merge keeps `sm:size-7`, because a
  // breakpoint-prefixed class is a different conflict group — so at `sm` and
  // wider the leftover wins and the button renders 28px while the assertion
  // above still passes. Asserting EVERY size step (responsive ones included)
  // resolves to the same tier is what actually closes that gap; the deleted
  // Model/Effort selectors each carried a hand-written patch for the identical
  // leak, which is evidence it recurs rather than being a one-off.
  it('F-A3: every responsive size step resolves to the same tier, so no breakpoint variant can leak the old 28px', () => {
    const steps = [
      ...roundActionButtonClass().matchAll(/(?:^|\s)(?:[a-z-]+:)*size-(\d+(?:\.\d+)?)(?=\s|$)/g),
    ];
    expect(steps.length).toBeGreaterThanOrEqual(2);
    for (const step of steps) {
      expect(Number(step[1]) * 4).toBe(COMPOSER_CONTROL_SIZE);
    }
  });

  it('overrides both squircle radius pairs so the shape is a true circle', () => {
    const cls = roundActionButtonClass();
    expect(cls).toContain('rounded-full');
    expect(cls).toContain('before:rounded-full');
  });

  it('neutralises corner-shape so the fallback and supports- radii agree', () => {
    const cls = roundActionButtonClass();
    expect(cls).toContain('[corner-shape:round]');
    expect(cls).toContain('supports-[corner-shape:squircle]:rounded-full');
    expect(cls).toContain('supports-[corner-shape:squircle]:before:rounded-full');
  });
});

// F-A22 (supersedes the earlier F-A14, which was written as conditional on a
// decision that has since been taken).
describe('roundActionButtonKindClass', () => {
  it('F-A22: send and enqueue are the near-neutral dark fill, never the brand primary', () => {
    for (const kind of ['send', 'enqueue'] as const) {
      const cls = roundActionButtonKindClass(kind);
      expect(cls).toContain('bg-foreground');
      expect(cls).toContain('text-background');
      expect(cls).not.toContain('bg-primary');
    }
  });

  // Send and enqueue are deliberately IDENTICAL: enqueue is this turn's send
  // with a delay, not a demoted variant, so a colour difference would invent a
  // distinction the behaviour does not have. The spec's "all mutually
  // distinct" is therefore read as distinctness across the three colour
  // FAMILIES (dark / destructive / outline), which is what it protects
  // against: send and stop collapsing into one colour.
  it('F-A22: send and enqueue share one fill', () => {
    expect(roundActionButtonKindClass('send')).toBe(roundActionButtonKindClass('enqueue'));
  });

  it('F-A22: stop keeps the destructive fill and the three families stay mutually distinct', () => {
    const send = roundActionButtonKindClass('send');
    const stop = roundActionButtonKindClass('stop');
    const retry = roundActionButtonKindClass('retry');

    expect(stop).toContain('destructive');
    expect(send).not.toContain('destructive');

    expect(stop).not.toBe(send);
    expect(retry).not.toBe(send);
    expect(retry).not.toBe(stop);
  });
});

describe('composerModelTriggerClass / composerAttachButtonClass / targetTriggerClass', () => {
  // F-A15 (supersedes F-A5). Every "not" below is a form `SelectTrigger`'s
  // base class used to drag in, and together they are the largest single
  // contributor to the "too round / too AI" reading: a bordered, shadowed,
  // width-floored control whose radius CSS clamps into a full pill.
  it('F-A15: the merged model trigger is a frameless ghost chip', () => {
    const cls = composerModelTriggerClass();

    expect(cls).toContain('rounded-sm');
    expect(cls).toContain('px-2');
    expect(cls).toContain('hover:bg-hover');
    expect(cls).toContain('data-[popup-open]:bg-selection');

    expect(cls).not.toContain('border');
    expect(cls).not.toContain('shadow');
    expect(cls).not.toContain('min-w-');
    expect(cls).not.toContain('rounded-lg');
    expect(cls).not.toContain('rounded-md');
    expect(cls).not.toContain('rounded-full');
  });

  // F-A15's paired half: a control with no resting frame gives a keyboard user
  // nothing to see unless focus produces the same shell hover does. The two
  // must ship together or neither is trustworthy.
  it('F-A15: hover and keyboard focus produce the same shell, always as a pair', () => {
    const cls = composerModelTriggerClass();
    expect(cls.includes('hover:bg-hover')).toBe(cls.includes('focus-visible:bg-hover'));
    expect(cls).toContain('focus-visible:bg-hover');
    // The outline sits on top of the fill rather than replacing it.
    expect(cls).toContain('focus-visible:outline-accent-primary');
  });

  // The shell is a FILL, never a border: a hover border would add 2px to the
  // box the moment the pointer arrives and make the whole row jump.
  it('F-A15: the hover shell is a fill, not a border', () => {
    expect(composerModelTriggerClass()).not.toContain('hover:border');
    expect(targetTriggerClass()).not.toContain('hover:border');
    expect(composerAttachButtonClass()).not.toContain('hover:border');
  });

  /**
   * F-A23 (D4, round-5; continues the F-A series — F-A20..22 were taken by
   * T-30 batch 2, so the number the work order penciled in as F-A20 lands
   * here).
   *
   * ⊕ became a MENU trigger in D4. A menu trigger has three states, not two:
   * hover, keyboard focus, and popup-open — and the third is the one that is
   * easy to forget, because it only shows up once the pointer leaves the
   * button for the popup it just opened. Missing it makes the open menu look
   * detached from anything.
   *
   * Asserted as SAMENESS with the model trigger rather than as three literals:
   * the two now sit side by side in the same card, so the failure that matters
   * is divergence between them, not any particular class name.
   */
  it('F-A23: the ⊕ menu trigger carries the same three ghost states as the model trigger', () => {
    const attach = composerAttachButtonClass();
    const model = composerModelTriggerClass();

    for (const state of [
      'hover:bg-hover',
      'focus-visible:bg-hover',
      'data-[popup-open]:bg-selection',
    ]) {
      expect(model).toContain(state);
      expect(attach).toContain(state);
    }

    // Same absences too — a bordered/shadowed ⊕ beside a frameless model chip
    // is the "two different apps in one row" reading F-A15 exists to prevent.
    expect(attach).not.toContain('border');
    expect(attach).not.toContain('shadow');
    // …and the disabled treatment the whole Composer shares.
    expect(attach).toContain('disabled:pointer-events-none');
    expect(attach).toContain('disabled:opacity-64');
  });

  // F-A6: `rounded-md` (12px) on an `h-6` (24px) box is clamped by CSS to half
  // the height, so the hover fill rendered as a full pill. A07 :736-753 always
  // said `--r-sm`.
  it('F-A6: the target-row trigger uses the 8px radius, not the clamped 12px one', () => {
    for (const tone of ['default', 'muted'] as const) {
      const cls = targetTriggerClass(tone);
      expect(cls).toContain('rounded-sm');
      expect(cls).not.toContain('rounded-md');
    }
    expect(targetTriggerClass('muted')).toContain('text-muted-foreground');

    // T-32 m8: the target row is a fixed h-6 flex row shared with the
    // run-location label. Without `min-w-0` a trigger refuses to shrink below
    // its content (flex items default to `min-width: auto`), so a long branch
    // name overflowed the row and squeezed its siblings until "This PC"
    // wrapped and was clipped by the row height. The trigger's own `truncate`
    // only engages once it is allowed to shrink.
    for (const tone of ['default', 'muted'] as const) {
      expect(targetTriggerClass(tone)).toContain('min-w-0');
    }
    expect(targetTriggerClass()).not.toContain('text-muted-foreground');
  });

  // F-A18: one ghost chip form across the whole Composer — the model trigger
  // sits inside the card and the target triggers sit on the row below it, and
  // a divergence between them reads as two different control languages
  // stacked on top of each other.
  it('F-A18: the model trigger and the target trigger share one height and one inset', () => {
    const heightPattern = /(?:^|\s)h-(\d+(?:\.\d+)?)(?:\s|$)/;
    const insetPattern = /(?:^|\s)px-(\d+(?:\.\d+)?)(?:\s|$)/;

    expect(stepValue(composerModelTriggerClass(), heightPattern)).toBe(
      stepValue(targetTriggerClass(), heightPattern)
    );
    expect(stepValue(composerModelTriggerClass(), insetPattern)).toBe(
      stepValue(targetTriggerClass(), insetPattern)
    );
  });

  // F-A4: every Composer control derives from the one 24px tier. The "three
  // height tiers in one bar" state (24 / 28 / 40) is what the coherence work
  // is undoing, so a local edit that moves one control off the tier fails.
  //
  // `matchAll`, not `match` — the F-A3 pattern, applied to the rest of the bar.
  // Checking only the FIRST size step in each string reproduced exactly the
  // leak F-A3 exists to close: a `sm:`/`data-[…]:`-prefixed step sits in a
  // different tailwind-merge conflict group, survives the unprefixed one, and
  // wins wherever it applies — so the control renders off-tier while the
  // assertion reads a passing 24 from the token before it. Every step in the
  // string has to land on the tier, prefixed or not.
  it('F-A4: attach button, model trigger and target trigger all sit on the single control tier', () => {
    // Variant prefix = `name:` or `name-[arbitrary]:`; the bracket clause is
    // what lets this see `data-[popup-open]:h-7` and
    // `supports-[corner-shape:squircle]:size-7`, which a plain `[a-z-]+:`
    // prefix would skip straight past.
    const pattern = /(?:^|\s)(?:[\w-]+(?:\[[^\]]*\])?:)*(?:size|h)-(\d+(?:\.\d+)?)(?=\s|$)/g;
    for (const cls of [
      composerAttachButtonClass(),
      composerModelTriggerClass(),
      targetTriggerClass(),
      targetTriggerClass('muted'),
    ]) {
      const steps = [...cls.matchAll(pattern)];
      expect(steps.length).toBeGreaterThanOrEqual(1);
      for (const step of steps) {
        expect(Number(step[1]) * 4).toBe(COMPOSER_CONTROL_SIZE);
      }
    }
  });

  // U12: the permission trigger sits beside the model trigger in the bar, so
  // it shares the same ghost-chip language — same height, same radius, same
  // three interactive states.
  it('U12: the permission trigger matches the model trigger ghost-chip form', () => {
    const perm = composerPermissionTriggerClass();
    const model = composerModelTriggerClass();

    for (const state of [
      'hover:bg-hover',
      'focus-visible:bg-hover',
      'data-[popup-open]:bg-selection',
    ]) {
      expect(model).toContain(state);
      expect(perm).toContain(state);
    }

    expect(perm).toContain('rounded-sm');
    expect(perm).not.toContain('border');
    expect(perm).not.toContain('shadow');
    expect(perm).toContain('disabled:pointer-events-none');
    expect(perm).toContain('disabled:opacity-64');

    const heightPattern = /(?:^|\s)h-(\d+(?:\.\d+)?)(?:\s|$)/;
    expect(stepValue(perm, heightPattern)).toBe(stepValue(model, heightPattern));
  });

  it('splits the merged label into a quiet model name and an emphasised effort suffix', () => {
    expect(composerModelBaseClass()).toContain('text-muted-foreground');
    expect(composerModelSuffixClass()).toContain('text-foreground');
  });
});

describe('composerPopupSide', () => {
  // Restates the same judgement `mentionPopupPlacementClass` encodes as
  // classes, for primitives that position themselves — not a second rule.
  it('opens upward from the docked card and downward from the centered one', () => {
    expect(composerPopupSide('session')).toBe('top');
    expect(composerPopupSide('empty')).toBe('bottom');
    expect(mentionPopupPlacementClass('session')).toContain('bottom-full');
    expect(mentionPopupPlacementClass('empty')).toContain('top-full');
  });
});

describe('composerPlaceholder', () => {
  it('asks for a follow-up in the docked card', () => {
    expect(
      composerPlaceholder({
        mode: 'session',
        canSend: true,
        busy: false,
        sending: false,
        hasSession: true,
        hasWorkspace: true,
        attachmentCount: 0,
      })
    ).toBe('Send follow-up…');
  });

  it('keeps the empty-state placeholder unchanged', () => {
    expect(
      composerPlaceholder({
        mode: 'empty',
        canSend: true,
        busy: false,
        sending: false,
        hasSession: true,
        hasWorkspace: true,
        attachmentCount: 0,
      })
    ).toBe('Message Pi…');
  });

  it('reports sending / busy / no-session / no-workspace states identically in both modes', () => {
    for (const mode of ['empty', 'session'] satisfies MiddleColumnMode[]) {
      expect(
        composerPlaceholder({
          mode,
          canSend: false,
          busy: false,
          sending: true,
          hasSession: true,
          hasWorkspace: true,
          attachmentCount: 2,
        })
      ).toBe('Sending 2 attachments to Agent Host…');

      expect(
        composerPlaceholder({
          mode,
          canSend: false,
          busy: true,
          sending: false,
          hasSession: true,
          hasWorkspace: true,
          attachmentCount: 0,
        })
      ).toBe('Agent Host is running — your message will be queued…');

      expect(
        composerPlaceholder({
          mode,
          canSend: false,
          busy: false,
          sending: false,
          hasSession: false,
          hasWorkspace: true,
          attachmentCount: 0,
        })
      ).toBe('Select a session in the left nav before sending…');

      expect(
        composerPlaceholder({
          mode,
          canSend: false,
          busy: false,
          sending: false,
          hasSession: true,
          hasWorkspace: false,
          attachmentCount: 0,
        })
      ).toBe('Active session has no workspace…');
    }
  });

  it('shows the pending-question follow-up copy even while busy (pendingQuestion must be checked before busy)', () => {
    expect(
      composerPlaceholder({
        mode: 'session',
        canSend: false,
        busy: true,
        sending: false,
        hasSession: true,
        hasWorkspace: true,
        attachmentCount: 0,
        pendingQuestion: true,
      })
    ).toBe('Add more optional details…');
  });

  it('still prioritizes the sending copy over a pending question', () => {
    expect(
      composerPlaceholder({
        mode: 'session',
        canSend: false,
        busy: false,
        sending: true,
        hasSession: true,
        hasWorkspace: true,
        attachmentCount: 0,
        pendingQuestion: true,
      })
    ).toBe('Sending to Agent Host…');
  });

  it('leaves the existing 8 cases unchanged when pendingQuestion is omitted', () => {
    expect(
      composerPlaceholder({
        mode: 'session',
        canSend: true,
        busy: false,
        sending: false,
        hasSession: true,
        hasWorkspace: true,
        attachmentCount: 0,
      })
    ).toBe('Send follow-up…');
  });

  // T-19 batch 2: queuedCount additions (decision 2.6).
  it('T-19: busy with an empty queue uses the new "will be queued" copy', () => {
    expect(
      composerPlaceholder({
        mode: 'session',
        canSend: false,
        busy: true,
        sending: false,
        hasSession: true,
        hasWorkspace: true,
        attachmentCount: 0,
        queuedCount: 0,
      })
    ).toBe('Agent Host is running — your message will be queued…');
  });

  it('T-19: a non-empty queue reports its count instead of the busy copy', () => {
    expect(
      composerPlaceholder({
        mode: 'session',
        canSend: false,
        busy: true,
        sending: false,
        hasSession: true,
        hasWorkspace: true,
        attachmentCount: 0,
        queuedCount: 2,
      })
    ).toBe('Queued 2 — type another follow-up…');
  });

  it('T-19: pendingQuestion still outranks a non-empty queue', () => {
    expect(
      composerPlaceholder({
        mode: 'session',
        canSend: false,
        busy: true,
        sending: false,
        hasSession: true,
        hasWorkspace: true,
        attachmentCount: 0,
        pendingQuestion: true,
        queuedCount: 3,
      })
    ).toBe('Add more optional details…');
  });

  // Stop-hang fix (2026-08-10) — this REPLACES "T-19: sending still outranks
  // a non-empty queue". The placeholder describes what typing HERE will do,
  // and while a turn is in flight with a non-empty queue, typing enqueues.
  // "Sending to Agent Host…" told the user their follow-up was on its way to
  // the Host when it was actually sitting in the queue — the copy that made a
  // wedged send look like a working one during the Stop investigation.
  it('a non-empty queue outranks the sending copy — typing enqueues, it does not send', () => {
    expect(
      composerPlaceholder({
        mode: 'session',
        canSend: false,
        busy: true,
        sending: true,
        hasSession: true,
        hasWorkspace: true,
        attachmentCount: 0,
        queuedCount: 1,
      })
    ).toBe('Queued 1 — type another follow-up…');
  });

  // The create-session handshake copy is the one "sending" variant with its
  // own reason to exist (a slow FIRST message), but it makes the same promise
  // about the draft in hand — so a non-empty queue outranks it too.
  it('a non-empty queue outranks the create-session handshake copy as well', () => {
    expect(
      composerPlaceholder({
        mode: 'session',
        canSend: false,
        busy: true,
        sending: true,
        hasSession: true,
        hasWorkspace: true,
        attachmentCount: 0,
        queuedCount: 2,
        isCreatingSession: true,
      })
    ).toBe('Queued 2 — type another follow-up…');
  });

  // The m9 workspace gate wins over the reorder: with no workspace the queue
  // cannot release at all, so the queue copy must stay suppressed and the
  // sending copy stands (this is the ONLY case where `sending` still wins
  // over a non-empty queue).
  it('keeps the sending copy when a non-empty queue has lost its workspace', () => {
    expect(
      composerPlaceholder({
        mode: 'session',
        canSend: false,
        busy: true,
        sending: true,
        hasSession: true,
        hasWorkspace: false,
        attachmentCount: 0,
        queuedCount: 1,
      })
    ).toBe('Sending to Agent Host…');
  });

  // Priority is a total order, not a pile of pairwise rules: pendingQuestion
  // still outranks the queue (existing case above), and the queue now
  // outranks sending — so all three at once must resolve to the question copy
  // and not accidentally re-expose the sending branch.
  it('pendingQuestion still wins when a queue and an in-flight send are both present', () => {
    expect(
      composerPlaceholder({
        mode: 'session',
        canSend: false,
        busy: true,
        sending: true,
        hasSession: true,
        hasWorkspace: true,
        attachmentCount: 0,
        pendingQuestion: true,
        queuedCount: 3,
      })
    ).toBe('Add more optional details…');
  });

  // m9 fix: a queue bucket can outlive its workspace (only pruned when the
  // SESSION disappears — see ChatWorkspace's prune effect), so `queuedCount`
  // alone is not proof the queue can ever release. Without `hasWorkspace`
  // gating this branch, the placeholder kept promising delivery for a queue
  // that no longer can.
  it('T-19: a non-empty queue does not claim delivery once the workspace is gone', () => {
    expect(
      composerPlaceholder({
        mode: 'session',
        canSend: false,
        busy: true,
        sending: false,
        hasSession: true,
        hasWorkspace: false,
        attachmentCount: 0,
        queuedCount: 2,
      })
    ).not.toMatch(/Queued/);
  });

  it('T-19: default placeholders are unchanged in both modes when the queue is empty', () => {
    for (const mode of ['empty', 'session'] satisfies MiddleColumnMode[]) {
      expect(
        composerPlaceholder({
          mode,
          canSend: true,
          busy: false,
          sending: false,
          hasSession: true,
          hasWorkspace: true,
          attachmentCount: 0,
          queuedCount: 0,
        })
      ).toBe(mode === 'session' ? 'Send follow-up…' : 'Message Pi…');
    }
  });

  // Round-2 P0: a brand-new session's first message goes through the
  // create-session handshake — that gets its own copy, distinct from the
  // ordinary "Sending…" text a steady-state follow-up shows.
  it('shows the create-session handshake copy when isCreatingSession is true', () => {
    expect(
      composerPlaceholder({
        mode: 'session',
        canSend: false,
        busy: false,
        sending: true,
        hasSession: true,
        hasWorkspace: true,
        attachmentCount: 0,
        isCreatingSession: true,
      })
    ).toBe('Creating session with Agent Host (first message only)…');
  });

  it('keeps the ordinary sending copy when isCreatingSession is false or omitted', () => {
    expect(
      composerPlaceholder({
        mode: 'session',
        canSend: false,
        busy: false,
        sending: true,
        hasSession: true,
        hasWorkspace: true,
        attachmentCount: 0,
        isCreatingSession: false,
      })
    ).toBe('Sending to Agent Host…');

    expect(
      composerPlaceholder({
        mode: 'session',
        canSend: false,
        busy: false,
        sending: true,
        hasSession: true,
        hasWorkspace: true,
        attachmentCount: 1,
      })
    ).toBe('Sending 1 attachment to Agent Host…');
  });

  it('never shows the create-session copy while not sending', () => {
    expect(
      composerPlaceholder({
        mode: 'session',
        canSend: true,
        busy: false,
        sending: false,
        hasSession: true,
        hasWorkspace: true,
        attachmentCount: 0,
        isCreatingSession: true,
      })
    ).not.toMatch(/Creating session/);
  });
});
