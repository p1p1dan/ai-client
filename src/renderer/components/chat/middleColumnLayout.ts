/**
 * T-28: pure decision/derivation functions for the middle column's two-state
 * layout (D23) — empty (centered, no history) vs session (docked composer +
 * timeline) — plus the class strings and small view-model helpers that both
 * states share.
 *
 * Only type imports plus the pure `isSessionBusy` helper are allowed here —
 * no components, hooks, or `window`. Store writes and subscriptions live in
 * `ChatWorkspace.tsx`; this module only decides what should render and
 * assembles read-only view data (mirrors `composerTarget.ts`'s role for the
 * target bar).
 */

import type { SessionRuntimeStatus } from '@shared/types/runtimeEvents';
import { isSessionBusy } from './sessionIndex/resumeIntent';

// ---- Two-state mode derivation ----

export type MiddleColumnMode = 'empty' | 'session';

export interface MiddleColumnModeInput {
  sessionId: string | null;
  /** messages[sessionId]?.length ?? 0 — must come from a scalar selector, never subscribe to the whole array. */
  messageCount: number;
  /** Whether this app run already started a send for this session (sticky — see `rememberSendAttempt`). */
  sendAttempted: boolean;
  /** activeSessionId ∈ hostBoundSessionIds */
  hostBound: boolean;
  /** session.runtimeIdentity != null — resume-flicker guard (mirrors `computeEverHostBound`). */
  hasRuntimeIdentity: boolean;
  /** Whether historyErrors[sessionId] is set (pass a boolean, not the raw error). */
  hasHistoryError: boolean;
  status: SessionRuntimeStatus;
}

/**
 * Decide whether the middle column shows the centered empty state or the
 * docked session state. Rules are evaluated in order and short-circuit —
 * order matters (see T-28 design doc §1 decision table).
 */
export function deriveMiddleColumnMode(input: MiddleColumnModeInput): MiddleColumnMode {
  if (input.sessionId == null) {
    return 'empty';
  }
  if (input.messageCount > 0) {
    return 'session';
  }
  if (input.sendAttempted) {
    return 'session';
  }
  if (input.hostBound || input.hasRuntimeIdentity) {
    return 'session';
  }
  if (input.hasHistoryError) {
    return 'session';
  }
  if (isSessionBusy(input.status) || input.status === 'failed') {
    return 'session';
  }
  return 'empty';
}

/**
 * Sticky latch recording which sessions have started a send this app run.
 * Returns the same array reference when the id is already tracked (or when
 * `sessionId` is null) so callers can use it directly as `setState` input
 * without triggering an extra re-render.
 */
export function rememberSendAttempt(
  sessionIds: readonly string[],
  sessionId: string | null
): readonly string[] {
  if (sessionId == null) {
    return sessionIds;
  }
  if (sessionIds.includes(sessionId)) {
    return sessionIds;
  }
  return [...sessionIds, sessionId];
}

// ---- Composer host / card / textarea class assembly ----

/** Composer host div's class: empty centers-and-grows, session docks at a fixed height. Both share `px-6`. */
export function middleColumnHostClass(mode: MiddleColumnMode): string {
  if (mode === 'empty') {
    return 'flex min-h-0 flex-1 flex-col justify-center px-6 pb-[9%]';
  }
  return 'shrink-0 px-6 pt-1.5 pb-3.5';
}

/** Timeline scroll area's inner padding (A07 `.tl`: 20/24/8). Padding stays outside `ReadingColumn`. */
export const TIMELINE_PADDING_CLASS = 'px-6 pt-5 pb-2';

/** Composer card's outer frame class — shared border/fill/radius tokens, mode-specific padding and layout. */
export function composerCardClass(mode: MiddleColumnMode): string {
  if (mode === 'empty') {
    return 'relative rounded-md border border-input bg-card focus-within:border-ring px-3 pt-2.5 pb-2';
  }
  // Resting height contract (A07 :1844): exactly 40px. Border-box math:
  // 28px round key + 2×1px border = 30px content floor; `py-1` alone would
  // rest at 38px, so `min-h-10` (40px) owns the floor and `items-center`
  // distributes the remaining 10px — review fix for the earlier `py-1.5`
  // variant that rested at 42px (6+28+6+2 borders).
  return 'relative rounded-md border border-input bg-card focus-within:border-ring flex min-h-10 items-center gap-2 px-2 py-1';
}

/**
 * Textarea outer span's class, including the `[&_textarea]:` pierce-through
 * variants for the inner `<textarea>`. The `<Textarea>` is rendered with
 * `unstyled` (no border/bg/shadow/ring/dark:bg-input chrome on the outer
 * span at all), so the old `border-0 bg-transparent shadow-none
 * focus-visible:ring-0` counters against that default chrome are gone —
 * only size and pierce-through classes remain.
 */
export function composerTextareaClass(mode: MiddleColumnMode): string {
  if (mode === 'empty') {
    return 'min-h-14 resize-none p-0 [&_textarea]:min-h-14 [&_textarea]:px-0';
  }
  return 'min-w-0 flex-1 resize-none p-0 [&_textarea]:min-h-6 [&_textarea]:max-h-14 [&_textarea]:px-0 [&_textarea]:py-0';
}

// ---- Target row ----

/** Target row's outer class: empty sits 8px above the card, session sits 8px below it; row height/gap match. */
export function targetRowClass(mode: MiddleColumnMode): string {
  if (mode === 'empty') {
    return 'mb-2 flex h-6 items-center gap-1';
  }
  return 'mt-2 flex h-6 items-center gap-1';
}

/** Target row slots: session mode drops the folder slot (A07 §08②). */
export function targetRowSlots(mode: MiddleColumnMode): {
  folder: boolean;
  branch: boolean;
  runLocation: boolean;
} {
  return { folder: mode === 'empty', branch: true, runLocation: true };
}

/**
 * Whether the target row should render at all. A non-targetable workspace
 * always hides it. In session mode, a row with neither a branch dropdown nor
 * a run-location label would just be 24px of dead space, so it collapses.
 */
export function shouldRenderTargetRow(input: {
  mode: MiddleColumnMode;
  hasTargetableWorkspace: boolean;
  showBranchSelect: boolean;
  hasRunLocation: boolean;
}): boolean {
  if (!input.hasTargetableWorkspace) {
    return false;
  }
  if (input.mode === 'empty') {
    return true;
  }
  return input.showBranchSelect || input.hasRunLocation;
}

// ---- Status line ----

/**
 * Whether the composer's status line (`Ready · cwd: …` / sending / error /
 * large-attachment hint) should be shown. The follow-up card hides its
 * resting state so a static line doesn't inflate the 40px docked height; the
 * empty-state card always shows it.
 */
export function shouldShowStatusLine(input: {
  mode: MiddleColumnMode;
  sending: boolean;
  reading: number;
  hasStatusError: boolean;
  hasLargeHint: boolean;
}): boolean {
  if (input.mode === 'empty') {
    return true;
  }
  return input.sending || input.reading > 0 || input.hasStatusError || input.hasLargeHint;
}

// ---- Mention popup ----

/** Mention popup's placement class: the empty card has less headroom above it, so it opens downward. */
export function mentionPopupPlacementClass(mode: MiddleColumnMode): string {
  if (mode === 'empty') {
    return 'top-full mt-1';
  }
  return 'bottom-full mb-1';
}

// ---- Round action button ----

/**
 * 28px true-circle class for the send/stop/retry action button, overriding
 * `Button`'s forced squircle four-piece (`rounded-[10px] [corner-shape:squircle]
 * supports-…:rounded-[50px] before:rounded-[9px]…`). Same for both modes —
 * only the `Button` variant (color) differs by kind.
 */
export function roundActionButtonClass(): string {
  return 'size-7 rounded-full [corner-shape:round] supports-[corner-shape:squircle]:rounded-full before:rounded-full supports-[corner-shape:squircle]:before:rounded-full';
}

// ---- Placeholder text ----

/** T-05: pending-question follow-up copy (A07 screen 6 group E — same lifecycle as the collapsed dock strip). */
export const PENDING_QUESTION_PLACEHOLDER = 'Add more optional details…';

/**
 * Composer placeholder text. Sending/busy/no-session/no-workspace states are
 * identical in both modes; only the default "ready to type" copy differs —
 * the docked composer asks for a follow-up instead of the initial prompt.
 *
 * `pendingQuestion` must be checked before `busy`: `waiting_question` makes
 * `isStoppable` (`ChatComposer.tsx:64-71`) true, which makes `busy` true —
 * if this branch sat after the `busy` check it would never be reached.
 */
export function composerPlaceholder(input: {
  mode: MiddleColumnMode;
  canSend: boolean;
  busy: boolean;
  sending: boolean;
  hasSession: boolean;
  hasWorkspace: boolean;
  attachmentCount: number;
  /** T-05: this session has a pending question dock showing. */
  pendingQuestion?: boolean;
}): string {
  if (input.sending) {
    return input.attachmentCount > 0
      ? `Sending ${input.attachmentCount} attachment${input.attachmentCount > 1 ? 's' : ''} to Agent Host…`
      : 'Sending to Agent Host…';
  }
  if (input.pendingQuestion) {
    return PENDING_QUESTION_PLACEHOLDER;
  }
  if (input.busy) {
    return 'Agent Host is running — use Stop, then send again…';
  }
  if (!input.hasSession) {
    return 'Select a session in the left nav before sending…';
  }
  if (!input.hasWorkspace) {
    return 'Active session has no workspace…';
  }
  if (input.canSend) {
    return input.mode === 'session' ? 'Send follow-up…' : 'Message Claude via Agent Host…';
  }
  return 'Cannot send right now…';
}
