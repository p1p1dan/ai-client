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
  resolveIdleStatusText,
  roundActionButtonClass,
  sessionStatusLineWrapperClass,
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

  it('docks the composer with zero top padding (the 8px band above the card is owned upstream — F-A10) and 14px bottom padding in session mode', () => {
    const cls = middleColumnHostClass('session');
    expect(cls).toContain('pt-0');
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
  // T-30b2: border ladder + radius + padding re-based on the Cursor
  // measurements — the fine-grained contracts live in
  // composerFormClasses.test.ts (F-A1/F-A2/F-A2b/F-A21); these keep the
  // coarse shape pinned.
  it('uses the neutral --border rest / --input focus ladder and --card fill in both modes', () => {
    for (const mode of ['empty', 'session'] satisfies MiddleColumnMode[]) {
      const cls = composerCardClass(mode);
      expect(cls).toContain('border-border');
      expect(cls).toContain('focus-within:border-input');
      expect(cls).toContain('bg-card');
    }
  });

  it('gives both cards the symmetric 8px padding (E1: the old px-3/py-2.5 vs px-2/py-1 asymmetry was A07 eyeballing residue)', () => {
    expect(composerCardClass('empty')).toContain('p-2');
    expect(composerCardClass('session')).toContain('p-2');
  });

  it('rests the follow-up card at exactly 42px via min-h-10.5 (24px key + 16px padding + 2px borders, centered)', () => {
    const cls = composerCardClass('session');
    expect(cls).toContain('flex');
    expect(cls).toContain('items-center');
    expect(cls).toContain('min-h-10.5');
    // min-h-10 (40px) was the E1 arithmetic error being enforced.
    expect(cls).not.toContain('min-h-10 ');
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

  // Round-4 point-check fix (defect B): a same-row sibling with a long
  // max-content flex-basis (a long error string) could claim the ENTIRE
  // negative-shrink budget and squeeze the follow-up textarea's
  // `flex: 1 1 0%` down to a literal 0px, since `min-w-0` gave it no floor
  // at all. `min-w-32` (128px) is the width-floor half of the fix —
  // `sessionStatusLineWrapperClass`'s `basis-0` (below) is the other half.
  it('round-4 fix (defect B): gives the follow-up textarea a 128px width floor instead of no floor at all', () => {
    const cls = composerTextareaClass('session');
    expect(cls).toContain('min-w-32');
    expect(cls).not.toContain('min-w-0');
  });

  it('round-4 fix (defect B): the empty-state textarea is unaffected by the width-floor fix', () => {
    expect(composerTextareaClass('empty')).not.toContain('min-w-32');
  });

  // F5(b) (round-4 Codex NEEDS-FIX #4): `flex-1` (grow:1) regressed to
  // `flex-[2]` (grow:2) — the textarea must keep a DOMINANT (not just
  // non-zero) share of any positive free space over the status-line slot,
  // which now also carries a non-zero grow weight (see
  // `sessionStatusLineWrapperClass` below) to fix its own 0px-under-normal-
  // conditions regression.
  it('round-4 fix (F5b): raises the follow-up textarea to a dominant flex-grow weight over the status-line slot', () => {
    const cls = composerTextareaClass('session');
    expect(cls).toContain('flex-[2]');
    expect(cls).not.toContain('flex-1');
  });
});

describe('sessionStatusLineWrapperClass (round-4 point-check fix, defect B; F5b Codex NEEDS-FIX #4)', () => {
  it('carries a zero flex-basis so its own content never dictates the row shrink math', () => {
    const cls = sessionStatusLineWrapperClass();
    expect(cls).toContain('basis-0');
  });

  it('still shrinks and keeps a zero min-width so it can collapse away entirely', () => {
    const cls = sessionStatusLineWrapperClass();
    expect(cls).toContain('shrink');
    expect(cls).toContain('min-w-0');
  });

  // F5(b): the ORIGINAL `basis-0` fix, with flex-grow left at the browser
  // default of 0, was itself a regression — a grow:0 item never claims any
  // of a row's POSITIVE leftover space, so this slot rendered at literally
  // 0px for the everyday case (short "Sending…"/attachment-hint text, no
  // error) too, not just the long-error-text case the original fix
  // targeted. `flex-1` (grow:1) restores real space-sharing; `max-w-48`
  // bounds how much of it this slot can claim even in a very wide row —
  // `max-width` clamps a flex item's HYPOTHETICAL size too, so it
  // continues to protect the textarea under negative free space exactly
  // as `basis-0` used to alone.
  it('round-4 fix (F5b): carries a non-zero grow weight so normal (non-error) status text is actually visible', () => {
    const cls = sessionStatusLineWrapperClass();
    expect(cls).toContain('flex-1');
  });

  it('round-4 fix (F5b): caps its own width with an ordinary Tailwind scale step, not an arbitrary value', () => {
    const cls = sessionStatusLineWrapperClass();
    expect(cls).toContain('max-w-48');
    expect(cls).not.toMatch(/max-w-\[/);
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

  // T-30b2: banner ownership of error text now covers BOTH modes — the empty
  // status line stopped being resident, so its old fall-through to the full
  // statusHint on error was the same defect-B duplication one mode later.
  it('empty mode + hasStatusError: selects largeHint (or nothing), never the full statusHint — banner owns error text in both modes now', () => {
    expect(
      resolveIdleStatusText({ mode: 'empty', hasStatusError: true, largeHint, statusHint })
    ).toBe(largeHint);
    expect(
      resolveIdleStatusText({ mode: 'empty', hasStatusError: true, largeHint: null, statusHint })
    ).toBeNull();
  });

  it('empty mode + no hasStatusError + largeHint: still selects largeHint (unaffected)', () => {
    expect(
      resolveIdleStatusText({ mode: 'empty', hasStatusError: false, largeHint, statusHint })
    ).toBe(largeHint);
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

  // Round-4 point-check fix (defect B): REWRITES the previous "shows it
  // whenever the composer is in an error state" assertion, which locked in
  // the actual defect-B bug — session mode showing the full error text a
  // SECOND time, inline next to the textarea, was what let a long error
  // string's max-content flex-basis crush the textarea to 0px width. The
  // destructive banner above the composer card is now the sole owner of
  // error text in session mode.
  it('round-4 fix (defect B): no longer shows it for an error state in session mode — the banner above the card owns error text exclusively now', () => {
    expect(
      shouldShowStatusLine({
        mode: 'session',
        sending: false,
        reading: 0,
        hasStatusError: true,
        hasLargeHint: false,
      })
    ).toBe(false);
  });

  it('T-30b2: empty mode no longer shows it for hasStatusError either — the banner owns error text in both modes', () => {
    expect(
      shouldShowStatusLine({
        mode: 'empty',
        sending: false,
        reading: 0,
        hasStatusError: true,
        hasLargeHint: false,
      })
    ).toBe(false);
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

  it('T-30b2: empty mode is need-based too — the resting "Ready · cwd:" line is gone (F-A11; cwd moved to the folder trigger title)', () => {
    expect(
      shouldShowStatusLine({
        mode: 'empty',
        sending: false,
        reading: 0,
        hasStatusError: false,
        hasLargeHint: false,
      })
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
  it('is a 24px box (E2 measurement fix: the Cursor reference circles are 24 CSS px, not "about 36")', () => {
    expect(roundActionButtonClass()).toContain('size-6');
    expect(roundActionButtonClass()).not.toContain('size-7');
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

  it('T-19: sending still outranks a non-empty queue', () => {
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
    ).toBe('Sending to Agent Host…');
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
      ).toBe(mode === 'session' ? 'Send follow-up…' : 'Message Claude via Agent Host…');
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
