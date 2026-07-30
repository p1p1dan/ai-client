import type { SessionRuntimeStatus } from '@shared/types/runtimeEvents';
import { describe, expect, it } from 'vitest';
import {
  composerCardClass,
  composerPlaceholder,
  composerTextareaClass,
  deriveMiddleColumnMode,
  type MiddleColumnMode,
  type MiddleColumnModeInput,
  mentionPopupPlacementClass,
  middleColumnHostClass,
  rememberSendAttempt,
  roundActionButtonClass,
  shouldRenderTargetRow,
  shouldShowStatusLine,
  targetRowClass,
  targetRowSlots,
} from '../middleColumnLayout';

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

  it('docks the composer with 6px top / 14px bottom padding in session mode', () => {
    const cls = middleColumnHostClass('session');
    expect(cls).toContain('pt-1.5');
    expect(cls).toContain('pb-3.5');
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
  it('uses the --input border, --card fill and the 12px radius token in both modes', () => {
    for (const mode of ['empty', 'session'] satisfies MiddleColumnMode[]) {
      const cls = composerCardClass(mode);
      expect(cls).toContain('border-input');
      expect(cls).toContain('bg-card');
      expect(cls).toContain('rounded-md');
    }
  });

  it('stacks the empty card with 10/12/8 padding', () => {
    const cls = composerCardClass('empty');
    expect(cls).toContain('px-3');
    expect(cls).toContain('pt-2.5');
    expect(cls).toContain('pb-2');
  });

  it('rests the follow-up card at exactly 40px via min-h-10 (28px key + borders, centered)', () => {
    const cls = composerCardClass('session');
    expect(cls).toContain('flex');
    expect(cls).toContain('items-center');
    expect(cls).toContain('px-2');
    expect(cls).toContain('min-h-10');
    expect(cls).toContain('py-1');
    // py-1.5 rested at 42px (6+28+6 + 2px borders) — the review-caught regression.
    expect(cls).not.toContain('py-1.5');
  });

  it('never uses rounded-lg (16px in this repo) for the card', () => {
    expect(composerCardClass('empty')).not.toContain('rounded-lg');
    expect(composerCardClass('session')).not.toContain('rounded-lg');
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

  it('never enables the resize handle', () => {
    expect(composerTextareaClass('empty')).toContain('resize-none');
    expect(composerTextareaClass('session')).toContain('resize-none');
  });
});

describe('targetRowClass / targetRowSlots', () => {
  it('places the full target bar 8px above the card in empty mode', () => {
    expect(targetRowClass('empty')).toContain('mb-2');
  });

  it('places the target row 8px below the card in session mode', () => {
    expect(targetRowClass('session')).toContain('mt-2');
  });

  it('keeps the 24px row height and 4px gaps in both modes', () => {
    expect(targetRowClass('empty')).toContain('h-6');
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
  it('hides the resting status line in the follow-up card', () => {
    expect(
      shouldShowStatusLine({
        mode: 'session',
        sending: false,
        reading: 0,
        hasStatusError: false,
        hasLargeHint: false,
      })
    ).toBe(false);
  });

  it('shows it while a send is in flight', () => {
    expect(
      shouldShowStatusLine({
        mode: 'session',
        sending: true,
        reading: 0,
        hasStatusError: false,
        hasLargeHint: false,
      })
    ).toBe(true);
  });

  it('shows it while attachments are still being read', () => {
    expect(
      shouldShowStatusLine({
        mode: 'session',
        sending: false,
        reading: 1,
        hasStatusError: false,
        hasLargeHint: false,
      })
    ).toBe(true);
  });

  it('shows it whenever the composer is in an error state', () => {
    expect(
      shouldShowStatusLine({
        mode: 'session',
        sending: false,
        reading: 0,
        hasStatusError: true,
        hasLargeHint: false,
      })
    ).toBe(true);
  });

  it('shows it for a large-attachment hint', () => {
    expect(
      shouldShowStatusLine({
        mode: 'session',
        sending: false,
        reading: 0,
        hasStatusError: false,
        hasLargeHint: true,
      })
    ).toBe(true);
  });

  it('always shows it in empty mode', () => {
    expect(
      shouldShowStatusLine({
        mode: 'empty',
        sending: false,
        reading: 0,
        hasStatusError: false,
        hasLargeHint: false,
      })
    ).toBe(true);
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
  it('is a 28px box', () => {
    expect(roundActionButtonClass()).toContain('size-7');
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
    ).toBe('Message Claude via Agent Host…');
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
      ).toBe('Agent Host is running — use Stop, then send again…');

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
});
