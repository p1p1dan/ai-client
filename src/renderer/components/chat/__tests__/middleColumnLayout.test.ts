import { translate, zhTranslations } from '@shared/i18n';
import {
  CHAT_BODY_FONT_SIZE_MAX,
  CHAT_BODY_FONT_SIZE_MIN,
  DEFAULT_CHAT_BODY_FONT_SIZE,
} from '@shared/types/chatTypography';
import type { SessionRuntimeStatus } from '@shared/types/runtimeEvents';
import { describe, expect, it } from 'vitest';
import {
  COMPOSER_BAR_LEADING,
  COMPOSER_BAR_TRAILING,
  COMPOSER_CARD_LEADING,
  COMPOSER_CARD_TRAILING,
  COMPOSER_CONTROL_SIZE,
  COMPOSER_POPUP_DESIRED_HEIGHT,
  COMPOSER_POPUP_GAP,
  COMPOSER_POPUP_VIEWPORT_MARGIN,
  COMPOSER_TEXTAREA_LINE_SCALE,
  COMPOSER_TEXTAREA_MAX_ROWS,
  composerActionGroupClass,
  composerAttachButtonClass,
  composerBarClass,
  composerBarTrailingClass,
  composerCardClass,
  composerFollowHeightBreakdown,
  composerHasProtrusion,
  composerInputRowClass,
  composerModelBaseClass,
  composerModelSuffixClass,
  composerModelTriggerClass,
  composerPermissionTriggerClass,
  composerPlaceholder,
  composerPopupSide,
  composerTextareaClass,
  composerTextareaSlotClass,
  deriveMiddleColumnMode,
  MIGRATING_SESSION_PLACEHOLDER,
  type MiddleColumnMode,
  type MiddleColumnModeInput,
  MOVES_ON_SEND_PLACEHOLDER,
  mentionPopupPlacementClass,
  middleColumnHostClass,
  queueStripWrapperClass,
  rememberSendAttempt,
  resolveComposerPopupPlacement,
  resolveIdleStatusText,
  roundActionButtonClass,
  roundActionButtonKindClass,
  START_SCREEN_HOST_CLASS,
  sessionStatusLineWrapperClass,
  shouldRenderTargetRow,
  shouldShowStatusLine,
  TIMELINE_PADDING_CLASS,
  TURN_RUNNING_PLACEHOLDER,
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
  // Decision 174 (issue #6, second wave): no conversation open is the home
  // page, which docks the composer exactly where a conversation does — so the
  // first send from it moves nothing. It used to be the start screen's `empty`.
  it('returns session (the home page) when there is no active session', () => {
    expect(deriveMiddleColumnMode(baseInput({ sessionId: null }))).toBe('session');
  });

  it('returns session for the home page whatever else the input says', () => {
    expect(deriveMiddleColumnMode(baseInput({ sessionId: null, sendAttempted: true }))).toBe(
      'session'
    );
    expect(deriveMiddleColumnMode(baseInput({ sessionId: null, status: 'running' }))).toBe(
      'session'
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
  it('U28: pins the empty-mode composer to the bottom, with the start screen taking the room above', () => {
    // Was `flex-1 justify-center pb-[9%]` (A07), which centred the composer in
    // whatever the start screen left over — so both sat in the top half with a
    // dead area beneath. The user rejected that on sight; pix pins the composer
    // and centres the screen above it.
    const cls = middleColumnHostClass('empty');
    expect(cls).toContain('shrink-0');
    expect(cls).not.toContain('flex-1');
    expect(cls).not.toContain('pb-[9%]');
    expect(cls).toContain('pb-6');

    // The room above is the sibling that takes the leftover height.
    expect(START_SCREEN_HOST_CLASS).toContain('flex-1');
    expect(START_SCREEN_HOST_CLASS).toContain('items-center');
    expect(START_SCREEN_HOST_CLASS).toContain('justify-center');
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

  it('never lets a composer host grow — the start screen is what takes the slack', () => {
    // U28 moved `flex-1` off the empty-mode composer and onto the region ABOVE
    // it. Both composer hosts are now pinned; exactly one element in the empty
    // column grows, and it is the one with nothing in it but a title and a
    // sentence. A `flex-1` reappearing on either host is the old arrangement
    // (composer floating mid-column, dead space beneath) coming back.
    const empty = middleColumnHostClass('empty');
    const session = middleColumnHostClass('session');
    expect(empty).toContain('shrink-0');
    expect(empty).not.toContain('flex-1');
    expect(session).toContain('shrink-0');
    expect(session).not.toContain('flex-1');
    expect(START_SCREEN_HOST_CLASS).toContain('flex-1');
  });
});

describe('composerCardClass', () => {
  // 2026-10-22 (user ruling, Claude Code desktop screenshot): a thin box with
  // a 1px frame — `border-soft` at rest, `border-strong` on hover and while
  // the textarea has focus — on the nearest surface. No brand-orange focus
  // edge, and no heavy shadow.
  it('F-A1: wears a thin soft frame that steps to border-strong, with no brand-orange focus edge in either mode', () => {
    for (const mode of ['empty', 'session'] satisfies MiddleColumnMode[]) {
      const cls = composerCardClass(mode);
      expect(cls).toContain('bg-surface-3');
      expect(cls).toMatch(/(^|\s)border(\s|$)/);
      expect(cls).toContain('border-border-soft');
      expect(cls).toContain('hover:border-border-strong');
      expect(cls).toContain('focus-within:border-border-strong');
      expect(cls).not.toContain('focus-within:border-ring');
      expect(cls).not.toContain('ring-primary');
    }
  });

  // At most `elev-sm`; never an ad-hoc `shadow-*`, and not the composer
  // elevation (its inset ring would double the real border).
  it('F-A7: carries no heavy or ad-hoc shadow, in either mode', () => {
    for (const mode of ['empty', 'session'] satisfies MiddleColumnMode[]) {
      const cls = composerCardClass(mode);
      expect(cls).not.toContain('shadow-');
      expect(cls).not.toContain('elev-composer');
      expect(cls).not.toMatch(/(^|\s)elev-(?!sm(\s|$))/);
    }
  });

  it('gives both cards one symmetric 6px inset instead of a three-value padding', () => {
    for (const mode of ['empty', 'session'] satisfies MiddleColumnMode[]) {
      const cls = composerCardClass(mode);
      expect(cls).toContain('p-1.5');
      expect(cls).not.toMatch(/(^|\s)p[xytblrse]-/);
    }
  });

  // F-A2: the T-28 blocker was a test that asserted a class was PRESENT and
  // therefore could not notice that the height it composed was wrong. This
  // crosses every spelled Tailwind step against the arithmetic breakdown, so a
  // change to either one alone fails.
  //
  // 2026-10-22: the box is ONE input row now (⊕, textarea, action key), so the
  // contract is border + inset + the taller of the textarea's padded line and
  // the 24px control tier — 2 + 12 + 24 = 38px at the 13px default.
  it('F-A2: rests the box at one thin 38px line, cross-checking the class steps against the arithmetic', () => {
    const cls = composerCardClass('session');
    const breakdown = composerFollowHeightBreakdown();

    expect(breakdown.controlRow).toBe(COMPOSER_CONTROL_SIZE);
    expect(breakdown.textareaLine).toBe(DEFAULT_CHAT_BODY_FONT_SIZE * COMPOSER_TEXTAREA_LINE_SCALE);
    expect(breakdown.textareaRow).toBe(breakdown.textareaLine + breakdown.textareaPadding);
    expect(breakdown.inputRow).toBe(Math.max(breakdown.textareaRow, breakdown.controlRow));
    expect(breakdown.border + breakdown.padding + breakdown.inputRow).toBe(breakdown.total);
    expect(breakdown.total).toBe(38);

    // The border term is the 1px `border` the class spells, top and bottom.
    expect(cls).toMatch(/(^|\s)border(\s|$)/);
    expect(breakdown.border).toBe(2);
    // The inset term is whatever the class spells, so the two cannot drift.
    const padStep = stepValue(cls, /(?:^|\s)p-(\d+(?:\.\d+)?)(?:\s|$)/);
    expect(padStep).not.toBeNull();
    expect((padStep as number) * 4 * 2).toBe(breakdown.padding);

    // `min-h-9.5` is the FLOOR, and it is exactly the resting total: a larger
    // body font or a longer draft grows the box past it, never below.
    const step = stepValue(cls, /(?:^|\s)min-h-(\d+(?:\.\d+)?)(?:\s|$)/);
    expect(step).not.toBeNull();
    expect((step as number) * 4).toBe(breakdown.total);

    // The input row is one row: the extras stack above it is the only other
    // in-flow child, and the gap between them is the card's own.
    expect(cls).toContain('flex-col');
  });

  // F-A2's blind spot: a variant-prefixed sibling (`sm:min-h-11`,
  // `focus-within:p-3`, …) belongs to a different tailwind-merge conflict group,
  // so it does not displace the contracted steps — it simply wins wherever it
  // applies. ANY variant-prefixed spacing/height token is the bug.
  it('F-A2: no variant-prefixed padding or height token can override the resting contract', () => {
    const spacingBase = /^(?:p[xytbrlse]?|min-h)-/;
    const offenders = composerCardClass('session')
      .split(/\s+/)
      .filter((token) => token.includes(':'))
      .filter((token) => spacingBase.test(token.slice(token.lastIndexOf(':') + 1)));
    expect(offenders).toEqual([]);
  });

  // [F6-1]: arbitrary-value radii are out of this card entirely. 2026-10-22:
  // the shared radius is the 12px `rounded-lg` token.
  it('[F6-1] both composer cards share rounded-lg, with no arbitrary-value radius anywhere', () => {
    for (const mode of ['empty', 'session'] satisfies MiddleColumnMode[]) {
      const cls = composerCardClass(mode);
      expect(cls).toContain('rounded-lg');
      expect(cls).not.toContain('rounded-composer');
      expect(cls).not.toMatch(/rounded-\[/);
      expect(cls).not.toContain('rounded-full');
    }
  });

  // U09-1: the tab and the card's top radius are one visual join, so they are
  // asserted against each other rather than each on its own.
  describe('U09-1 protrusion join', () => {
    it('drops the top corners to 4px when the tab is present, keeping the bottom at the card radius', () => {
      const cls = composerCardClass('empty', { hasProtrusion: true });
      expect(cls).toContain('rounded-t-xs');
      // The base radius must survive — it is what the bottom corners still
      // render at; dropping it would square the whole card.
      expect(cls).toContain('rounded-lg');
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
  // second opinion about when the bar exists.
  it('matches shouldRenderTargetRow in empty mode', () => {
    for (const hasTargetableWorkspace of [true, false]) {
      expect(composerHasProtrusion({ mode: 'empty', hasTargetableWorkspace })).toBe(
        shouldRenderTargetRow({ mode: 'empty', hasTargetableWorkspace })
      );
    }
  });
});

describe('composerInputRowClass / composerBarClass / composerActionGroupClass', () => {
  // The one row inside the box. `items-end` keeps ⊕ and the action key on the
  // draft's last line as it grows; at rest every child is 24px, so it is
  // centred too.
  it('lays the input row out as one bottom-aligned row with a shrinkable textarea slot', () => {
    const row = composerInputRowClass();
    expect(row).toContain('flex');
    expect(row).toContain('items-end');
    expect(row).toContain('min-w-0');
    expect(row).not.toContain('flex-col');
    const slot = composerTextareaSlotClass();
    expect(slot).toContain('flex-1');
    expect(slot).toContain('min-w-0');
  });

  // The row under the box: no frame, no fill, the 24px control tier.
  it('gives the row under the box no frame or fill, at the control tier', () => {
    const cls = composerBarClass();
    expect(cls).toContain('items-center');
    expect(cls).toContain('min-w-0');
    expect(cls).not.toMatch(/(^|\s)border/);
    expect(cls).not.toMatch(/(^|\s)bg-/);
    const step = stepValue(cls, /(?:^|\s)h-(\d+(?:\.\d+)?)(?:\s|$)/);
    expect((step as number) * 4).toBe(COMPOSER_CONTROL_SIZE);
  });

  // In a conversation and on the home page the target row IS the row under
  // the box, so the two cannot disagree about its look.
  it('makes the session target row the row under the box', () => {
    expect(targetRowClass('session')).toBe(composerBarClass());
  });

  it('anchors the trailing group of the row under the box at its end', () => {
    const cls = composerBarTrailingClass();
    expect(cls).toContain('ms-auto');
    expect(cls).toContain('shrink-0');
  });

  // Without the auto margin the action key would slide whenever the slots to
  // its left change, breaking the "Stop replaces Send in place" rule.
  it('pins the action group to the end of the input row', () => {
    const cls = composerActionGroupClass();
    expect(cls).toContain('ms-auto');
    expect(cls).toContain('shrink-0');
  });

  // U09-2, re-cut 2026-10-22: inside the box only ⊕ and the action key; the
  // permission tier on the left of the row below, model/effort then context
  // use on its right (the Claude Code desktop order).
  describe('U09-2 slot order', () => {
    it('keeps only attach and the action key inside the box', () => {
      expect(COMPOSER_CARD_LEADING).toEqual(['attach']);
      expect(COMPOSER_CARD_TRAILING).toEqual(['actions']);
    });

    it('leads the row below with the permission tier', () => {
      expect(COMPOSER_BAR_LEADING).toEqual(['permission']);
    });

    it('trails the row below with model/effort, then context use', () => {
      expect(COMPOSER_BAR_TRAILING).toEqual(['modelEffort', 'usage']);
    });

    // The send key must be last in the box, full stop: every "Stop replaces
    // Send in place" guarantee assumes a fixed terminal position.
    it('keeps the action slot last inside the box and nowhere else', () => {
      expect(COMPOSER_CARD_TRAILING.at(-1)).toBe('actions');
      expect(COMPOSER_CARD_LEADING).not.toContain('actions');
      expect(COMPOSER_BAR_LEADING).not.toContain('actions');
      expect(COMPOSER_BAR_TRAILING).not.toContain('actions');
    });

    // A slot appearing in two groups would render its control twice.
    it('assigns every slot to exactly one group, and every slot somewhere', () => {
      const all = [
        ...COMPOSER_CARD_LEADING,
        ...COMPOSER_CARD_TRAILING,
        ...COMPOSER_BAR_LEADING,
        ...COMPOSER_BAR_TRAILING,
      ];
      expect(new Set(all).size).toBe(all.length);
      expect([...all].sort()).toEqual(
        ['actions', 'attach', 'modelEffort', 'permission', 'usage'].sort()
      );
    });
  });
});

describe('composerTextareaClass', () => {
  // 2026-10-22 (user ruling): one thin line when empty, growing with the text.
  it('rests the textarea at one line on the control tier', () => {
    const cls = composerTextareaClass();
    const step = stepValue(cls, /\[&_textarea\]:min-h-(\d+(?:\.\d+)?)(?:\s|$)/);
    expect((step as number) * 4).toBe(COMPOSER_CONTROL_SIZE);
    // The two-line resting floor (decision 174) is gone.
    expect(cls).not.toContain('*1.5*2)]');
  });

  it('caps growth at eight of its own body-tier rows, then scrolls', () => {
    // F7f: eight rows keeps the cap expressed in the row the class already
    // pins, and keeps a scroll boundary so a long draft cannot push the
    // timeline off screen.
    expect(COMPOSER_TEXTAREA_MAX_ROWS).toBe(8);
    const cls = composerTextareaClass();
    expect(cls).toContain(
      `[&_textarea]:max-h-[calc(var(--text-chat-body)*${COMPOSER_TEXTAREA_LINE_SCALE}*${COMPOSER_TEXTAREA_MAX_ROWS})]`
    );
  });

  it('T104: follows the body tier, its line box in the same calc the arithmetic multiplies', () => {
    // The pierce-through form is required, not stylistic — `<Textarea
    // unstyled>` only puts `className` on the outer span (textarea.tsx).
    const cls = composerTextareaClass();
    expect(cls).toContain('[&_textarea]:text-chat-body');
    expect(cls).toContain(
      `[&_textarea]:leading-[calc(var(--text-chat-body)*${COMPOSER_TEXTAREA_LINE_SCALE})]`
    );
  });

  // The class pads the one line out to the control tier and the arithmetic
  // counts that padding; both are checked from the same numbers.
  it('centres its one line on the control tier, clamping the padding at 0 for large body sizes', () => {
    const cls = composerTextareaClass();
    expect(cls).toContain(
      '[&_textarea]:py-[max(0px,calc((1.5rem_-_var(--text-chat-body)*1.5)/2))]'
    );
    const breakdown = composerFollowHeightBreakdown();
    expect(breakdown.textareaPadding).toBe(
      Math.max(
        0,
        COMPOSER_CONTROL_SIZE - DEFAULT_CHAT_BODY_FONT_SIZE * COMPOSER_TEXTAREA_LINE_SCALE
      )
    );
    expect(breakdown.textareaRow).toBe(COMPOSER_CONTROL_SIZE);
  });

  it('T104: the line box stays proportional across the body range', () => {
    expect(CHAT_BODY_FONT_SIZE_MIN * COMPOSER_TEXTAREA_LINE_SCALE).toBe(18);
    expect(CHAT_BODY_FONT_SIZE_MAX * COMPOSER_TEXTAREA_LINE_SCALE).toBe(36);
    // Below 16px the line is padded up to the 24px tier; above it the line
    // itself is taller than the tier and the box grows with it.
    expect(CHAT_BODY_FONT_SIZE_MIN * COMPOSER_TEXTAREA_LINE_SCALE).toBeLessThan(
      COMPOSER_CONTROL_SIZE
    );
    expect(CHAT_BODY_FONT_SIZE_MAX * COMPOSER_TEXTAREA_LINE_SCALE).toBeGreaterThan(
      COMPOSER_CONTROL_SIZE
    );
  });

  it('zeroes the inner horizontal padding so the caret starts right after ⊕', () => {
    expect(composerTextareaClass()).toContain('[&_textarea]:px-0');
  });

  it('pierces resize-none through to the real inner textarea (round-2 fix: a bare resize-none on the unstyled outer span never reached the native <textarea>)', () => {
    expect(composerTextareaClass()).toContain('[&_textarea]:resize-none');
  });

  it('drops the border/bg/shadow/ring counters now that <Textarea unstyled> renders no outer chrome to fight', () => {
    const cls = composerTextareaClass();
    expect(cls).not.toContain('border-0');
    expect(cls).not.toContain('bg-transparent');
    expect(cls).not.toContain('shadow-none');
    expect(cls).not.toContain('focus-visible:ring-0');
  });

  // [F6-2]: the textarea's slot takes the free width (`composerTextareaSlotClass`);
  // the textarea itself fills that slot and carries no flex weight or width
  // floor of its own.
  it('[F6-2] the textarea fills its slot, carrying no flex weight and no width floor', () => {
    const cls = composerTextareaClass();
    expect(cls).toContain('w-full');
    expect(cls).not.toMatch(/(?:^|\s)flex-/);
    expect(cls).not.toMatch(/(?:^|\s)min-w-/);
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

  it('places the target row 6px below the card in session mode', () => {
    expect(targetRowClass('session')).toContain('mt-1.5');
  });

  // The empty row became a filled CONTAINER around the 24px control tier, so
  // it carries 28px to give its chips 2px of breathing room. 28px is the
  // sidebar row step D03 pinned, not a new one. The session row is the bare
  // row under the box, at the control height itself, its ghost triggers
  // spaced by their own inset.
  it('gives the tab 28px with 4px gaps and the bare row 24px with 2px gaps', () => {
    expect(targetRowClass('empty')).toContain('h-7');
    expect(targetRowClass('empty')).toContain('gap-1');
    expect(targetRowClass('session')).toContain('h-6');
    expect(targetRowClass('session')).toContain('gap-0.5');
  });

  it('renders folder + branch + run location in empty mode', () => {
    expect(targetRowSlots('empty')).toEqual({ folder: true, branch: true, runLocation: true });
  });

  it('drops the folder slot in a conversation (session mode)', () => {
    expect(targetRowSlots('session')).toEqual({ folder: false, branch: true, runLocation: true });
  });

  // Decision 174 (issue #6): the home page docks in session mode and keeps the
  // folder dropdown — it is where the next conversation's repository is picked.
  it('keeps the folder slot on the home page', () => {
    expect(targetRowSlots('session', { home: true })).toEqual({
      folder: true,
      branch: true,
      runLocation: true,
    });
  });
});

describe('shouldRenderTargetRow', () => {
  it('renders nothing in empty mode without a targetable workspace', () => {
    expect(shouldRenderTargetRow({ mode: 'empty', hasTargetableWorkspace: false })).toBe(false);
  });

  it('renders the empty-mode row whenever there is a targetable workspace', () => {
    expect(shouldRenderTargetRow({ mode: 'empty', hasTargetableWorkspace: true })).toBe(true);
  });

  // Decision 174 (issue #6, user ruling 2026-10-10): the session row — every
  // conversation, and the home page — is always drawn, so the card sits at the
  // same height everywhere: a temporary chat shows 「临时对话」 and the home
  // page its repository dropdown, even with no repository at all.
  it('always renders the session-mode row, with or without a targetable workspace', () => {
    expect(shouldRenderTargetRow({ mode: 'session', hasTargetableWorkspace: true })).toBe(true);
    expect(shouldRenderTargetRow({ mode: 'session', hasTargetableWorkspace: false })).toBe(true);
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
  it('turns a resolved side into the matching anchor classes', () => {
    expect(mentionPopupPlacementClass('top')).toContain('bottom-full');
    expect(mentionPopupPlacementClass('bottom')).toContain('top-full');
  });

  it('still opens upward from the docked composer and downward from the centered one', () => {
    // F11 changed the INPUT from a mode to a resolved side; the mode's own
    // preference is unchanged and still reaches the same classes.
    expect(mentionPopupPlacementClass(composerPopupSide('session'))).toContain('bottom-full');
    expect(mentionPopupPlacementClass(composerPopupSide('empty'))).toContain('top-full');
  });
});

describe('F11 resolveComposerPopupPlacement', () => {
  // A 900px window with the composer docked at the bottom: ~700px of headroom
  // above it, ~40px below.
  const docked = {
    anchorTop: 760,
    anchorBottom: 860,
    viewportHeight: 900,
    preferred: 'top' as const,
  };

  it('keeps the preferred side, at full height, when it fits', () => {
    expect(resolveComposerPopupPlacement(docked)).toEqual({
      side: 'top',
      maxHeight: COMPOSER_POPUP_DESIRED_HEIGHT,
    });
  });

  it('flips when the preferred side cannot take the whole list but the other can', () => {
    // Composer near the TOP of the window: no headroom, plenty below.
    expect(
      resolveComposerPopupPlacement({
        anchorTop: 40,
        anchorBottom: 140,
        viewportHeight: 900,
        preferred: 'top',
      })
    ).toEqual({ side: 'bottom', maxHeight: COMPOSER_POPUP_DESIRED_HEIGHT });
  });

  it('never returns a height the chosen side cannot hold', () => {
    // The reported defect, as a number: a short window where NEITHER side fits
    // 240px. Whatever side wins, the cap is the space that exists.
    const short = resolveComposerPopupPlacement({
      anchorTop: 150,
      anchorBottom: 250,
      viewportHeight: 300,
      preferred: 'top',
    });
    const spaceAbove = 150 - COMPOSER_POPUP_GAP - COMPOSER_POPUP_VIEWPORT_MARGIN;
    expect(short.maxHeight).toBeLessThan(COMPOSER_POPUP_DESIRED_HEIGHT);
    expect(short).toEqual({ side: 'top', maxHeight: spaceAbove });
  });

  it('takes the larger side once the preferred one cannot show a usable list', () => {
    const placement = resolveComposerPopupPlacement({
      anchorTop: 30,
      anchorBottom: 130,
      viewportHeight: 300,
      preferred: 'top',
    });
    expect(placement.side).toBe('bottom');
    expect(placement.maxHeight).toBe(
      300 - 130 - COMPOSER_POPUP_GAP - COMPOSER_POPUP_VIEWPORT_MARGIN
    );
  });

  it('clamps a side with no room at all to zero rather than a negative height', () => {
    // An anchor taller than the viewport (a very short window, a multi-line
    // draft) put both edges out of range; a negative max-height would render as
    // no cap at all, which is the failure mode this whole task is about.
    const placement = resolveComposerPopupPlacement({
      anchorTop: -50,
      anchorBottom: 400,
      viewportHeight: 300,
      preferred: 'top',
    });
    expect(placement.maxHeight).toBe(0);
  });

  it('respects a shrunken visual viewport, which is how the IME case arrives', () => {
    // Same anchor, keyboard up: `visualViewport.height` drops and the space
    // below the composer goes with it.
    const keyboardUp = resolveComposerPopupPlacement({
      anchorTop: 300,
      anchorBottom: 400,
      viewportHeight: 420,
      preferred: 'bottom',
    });
    expect(keyboardUp.side).toBe('top');
    expect(keyboardUp.maxHeight).toBe(COMPOSER_POPUP_DESIRED_HEIGHT);
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

  // Design system v2 §7.9: the reference's send key is a small-radius square,
  // not a circle; at 24px the clamp rule (§10.3) allows only xs/sm.
  it('is a small-radius square, never a pill or circle', () => {
    const cls = roundActionButtonClass();
    expect(cls).toContain('rounded-sm');
    expect(cls).not.toContain('rounded-full');
    expect(cls).not.toMatch(/rounded-(md|lg|xl|\[)/);
  });
});

// F-A22 (supersedes the earlier F-A14, which was written as conditional on a
// decision that has since been taken).
describe('roundActionButtonKindClass', () => {
  // Design system v2 §1 rule 7 supersedes F-A22's "never the brand primary":
  // the send key is one of the few places the clay appears.
  it('F-A22: send and enqueue are the clay primary fill', () => {
    for (const kind of ['send', 'enqueue'] as const) {
      const cls = roundActionButtonKindClass(kind);
      expect(cls).toContain('bg-primary');
      expect(cls).toContain('text-primary-foreground');
      expect(cls).not.toContain('bg-foreground');
    }
  });

  // §1 rule 1: inside the composer's frame no key carries a frame of its own.
  it('no kind draws a border inside the composer', () => {
    for (const kind of ['send', 'stop', 'retry', 'enqueue', 'interject', 'send-now'] as const) {
      expect(roundActionButtonKindClass(kind)).not.toMatch(/(^|\s)(hover:)?border(-|\s|$)/);
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
    // Design system v2: the one ghost-hover fill, the selected fill while open.
    expect(cls).toContain('hover:bg-fill-ghost-hover');
    expect(cls).toContain('data-[popup-open]:bg-fill-ghost-selected');

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
    expect(cls.includes('hover:bg-fill-ghost-hover')).toBe(
      cls.includes('focus-visible:bg-fill-ghost-hover')
    );
    expect(cls).toContain('focus-visible:bg-fill-ghost-hover');
    // The ring sits on top of the fill rather than replacing it (design
    // system v2: the shared `focus-ring` utility).
    expect(cls).toContain('focus-ring');
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
      'hover:bg-fill-ghost-hover',
      'focus-visible:bg-fill-ghost-hover',
      'data-[popup-open]:bg-fill-ghost-selected',
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
      'hover:bg-fill-ghost-hover',
      'focus-visible:bg-fill-ghost-hover',
      'data-[popup-open]:bg-fill-ghost-selected',
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
    ).toBe('Send a message…');
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
      ).toBe('Sending 2 attachments…');

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
      ).toBe('Turn in progress — Enter adds to this turn, Ctrl+Enter queues for after it…');

      // U28: no session is no longer a blocker with its own copy — the first
      // send creates one. With `unbound` set (which is what ChatComposer passes
      // in that state) the ladder falls through to the ordinary prompt, and the
      // user sees an input they can type into rather than an errand.
      expect(
        composerPlaceholder({
          mode,
          canSend: true,
          busy: false,
          sending: false,
          hasSession: false,
          hasWorkspace: false,
          unbound: true,
          attachmentCount: 0,
        })
        // Decision 174: no session is the home page, which docks in session
        // mode but starts a conversation — it asks for the first message.
      ).toBe('Send a message…');

      // The workspace complaint is now scoped to a session that EXISTS: it
      // describes a broken binding, which a chat that was never created cannot
      // have.
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
    ).toBe('Sending…');
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
    ).toBe('Turn in progress — Enter adds to this turn, Ctrl+Enter queues for after it…');
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
  // "Sending…" told the user their follow-up was on its way to
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
    ).toBe('Sending…');
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
      ).toBe(mode === 'session' ? 'Send follow-up…' : 'Send a message…');
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
    ).toBe('Setting up the chat (first message only)…');
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
    ).toBe('Sending…');

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
    ).toBe('Sending 1 attachment…');
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

  /**
   * dsh-rebase P1-9e (decision 050): a chat from the previous version is moved
   * to the current engine by its first send. The box says so before (the
   * first send takes a moment longer), and while the move runs — which
   * otherwise read "Sending…" for as long as it took.
   */
  describe('legacy chat moved on its first send (P1-9e)', () => {
    const idle = {
      canSend: true,
      busy: false,
      sending: false,
      hasSession: true,
      hasWorkspace: true,
      hasCwd: true,
      attachmentCount: 0,
    };

    it('rewords the ordinary prompt, in both modes', () => {
      for (const mode of ['empty', 'session'] satisfies MiddleColumnMode[]) {
        expect(composerPlaceholder({ ...idle, mode, movesOnSend: true })).toBe(
          MOVES_ON_SEND_PLACEHOLDER
        );
      }
    });

    it('leaves the rungs that name something to fix first ahead of it', () => {
      // The chat can run now; a missing workspace still has to be dealt with.
      expect(
        composerPlaceholder({
          ...idle,
          mode: 'session',
          canSend: false,
          hasWorkspace: false,
          movesOnSend: true,
        })
      ).toBe('Active session has no workspace…');
      expect(
        composerPlaceholder({ ...idle, mode: 'session', sending: true, movesOnSend: true })
      ).toBe('Sending…');
    });

    it('says the move is running while it runs, ahead of the send waiting on it', () => {
      for (const mode of ['empty', 'session'] satisfies MiddleColumnMode[]) {
        expect(
          composerPlaceholder({
            ...idle,
            mode,
            sending: true,
            isCreatingSession: true,
            movesOnSend: true,
            migrating: true,
          })
        ).toBe(MIGRATING_SESSION_PLACEHOLDER);
      }
      // A move started from the history card's Retry: no send at all.
      expect(composerPlaceholder({ ...idle, mode: 'session', migrating: true })).toBe(
        MIGRATING_SESSION_PLACEHOLDER
      );
    });

    it('reverse: an ordinary chat keeps its prompt', () => {
      expect(
        composerPlaceholder({ ...idle, mode: 'session', movesOnSend: false, migrating: false })
      ).toBe('Send follow-up…');
      expect(composerPlaceholder({ ...idle, mode: 'session' })).toBe('Send follow-up…');
    });

    it('ships the copy in the dictionary, and not the read-only one it replaced', () => {
      expect(zhTranslations[MOVES_ON_SEND_PLACEHOLDER]).toBeDefined();
      expect(zhTranslations[MIGRATING_SESSION_PLACEHOLDER]).toBeDefined();
      expect(
        zhTranslations['Read-only until migration — start a new chat to continue']
      ).toBeUndefined();
    });
  });
});

describe('the running placeholder names the turn (P1-7e e6, problem 40, decision 145)', () => {
  it('reads 「回合进行中」 in Chinese, with no engine process name in either language', () => {
    const zh = (key: string, params?: Record<string, string | number>) =>
      translate('zh', key, params);
    const busy = composerPlaceholder(
      {
        mode: 'session',
        canSend: false,
        busy: true,
        sending: false,
        hasSession: true,
        hasWorkspace: true,
        attachmentCount: 0,
      },
      zh
    );
    expect(busy).toBe('回合进行中 —— Enter 并入当前回合，Ctrl+Enter 排到回合结束后…');
    expect(TURN_RUNNING_PLACEHOLDER).not.toContain('Agent Host');
    expect(
      zhTranslations['Agent Host is running — Enter queues, Ctrl+Enter adds to this turn…']
    ).toBeUndefined();
  });
});

describe('the sending placeholders name no engine process (decision 156)', () => {
  const zh = (key: string, params?: Record<string, string | number>) =>
    translate('zh', key, params);
  const sending = (extra: { isCreatingSession?: boolean; attachmentCount?: number }, t = zh) =>
    composerPlaceholder(
      {
        mode: 'session',
        canSend: false,
        busy: true,
        sending: true,
        hasSession: true,
        hasWorkspace: true,
        attachmentCount: extra.attachmentCount ?? 0,
        isCreatingSession: extra.isCreatingSession,
      },
      t
    );

  it('reads plainly in Chinese', () => {
    expect(sending({})).toBe('正在发送…');
    expect(sending({ isCreatingSession: true })).toBe('正在建立对话（仅首条消息）…');
    expect(sending({ attachmentCount: 1 })).toBe('正在发送 1 个附件…');
    expect(sending({ attachmentCount: 3 })).toBe('正在发送 3 个附件…');
  });

  it('carries no `Agent Host` in either language, and the old keys are gone', () => {
    for (const extra of [{}, { isCreatingSession: true }, { attachmentCount: 2 }]) {
      expect(sending(extra)).not.toContain('Agent Host');
      expect(sending(extra, (key, params) => translate('en', key, params))).not.toContain(
        'Agent Host'
      );
    }
    for (const key of Object.keys(zhTranslations)) {
      expect(key, key).not.toContain('Agent Host');
      expect(zhTranslations[key], key).not.toContain('Agent Host');
    }
  });
});
