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
    // Round-2 visual fix: pt-2.5/pb-2 was a literal 2px top/bottom asymmetry
    // on the empty-state card frame — symmetric py-2.5 matches the 8/10px
    // spacing tiers already used elsewhere in this file without inventing a
    // new value.
    return 'relative rounded-md border border-input bg-card focus-within:border-ring px-3 py-2.5';
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
    // Round-2 visual fix: `<Textarea unstyled>` only applies `className` to
    // the outer span (textarea.tsx), never to the real inner `<textarea>` —
    // a bare `resize-none` here was inert (outer span isn't a scroll
    // container) and left the UA default `resize: both` grip on the real
    // element. `[&_textarea]:` pierces through like every sizing class next
    // to it.
    return 'min-h-14 p-0 [&_textarea]:min-h-14 [&_textarea]:resize-none [&_textarea]:px-0';
  }
  // Round-2 visual fix: same resize pierce-through as the empty branch, plus
  // `[&_textarea]:leading-6` — the session textarea pins `min-h-6`/`py-0`
  // (needed for the 40px docked-card contract), and a `<textarea>` never
  // vertically centers its own content, so with zero padding the resting
  // line sat high in the 24px box. Matching line-height to the height token
  // fills the box instead of relying on padding.
  //
  // Round-4 point-check fix (defect B): `min-w-0` was a genuine flex-crush
  // hazard — the textarea's `flex: 1 1 0%` gives it a zero flex-basis, and
  // with no floor at all a same-row sibling with a large max-content basis
  // (e.g. a long error string) can claim the ENTIRE negative-shrink budget
  // (`shrink × basis`) and squeeze this down to a literal 0px. `min-w-32`
  // (128px, an ordinary Tailwind scale step) gives it a floor no sibling's
  // shrink math can cross, independent of how long any status text gets —
  // the same-row status slot itself also gets `basis-0` as the other half
  // of this fix (see `sessionStatusLineWrapperClass` below).
  //
  // Round-4 Codex NEEDS-FIX #4 (F5b): `flex-1` (grow:1) is now `flex-[2]`
  // (grow:2, same shrink:1/basis:0% — CSS's single-number `flex: N`
  // shorthand). `sessionStatusLineWrapperClass` below was ALSO switched to a
  // `flex-1`-based (grow:1) sibling instead of grow:0 — a real, live bug
  // Codex's review caught: `basis-0` with NO grow at all means that slot's
  // final width stays pinned at its zero basis in ANY positive-free-space
  // layout (the ordinary case — short "Sending…"/attachment-hint text, no
  // error present), since flex-grow:0 never claims a share of leftover
  // space; `min-w-0` on that slot removed even the browser's automatic
  // minimum-content floor. Ordinary status text was being crushed to 0px
  // EVERY time, not just under overflow — the fix this comment describes
  // regressed the case it wasn't targeting. Giving both siblings a
  // grow>0 flex basis restores real space-sharing; the 2:1 ratio keeps the
  // textarea's share dominant so the status slot (capped by its own
  // `max-w`, see below) never wins a fight for width, mirroring
  // `MergeEditor.tsx`'s existing `flex-[1.5]` split-pane precedent — no
  // non-arbitrary Tailwind step exists for a flex-grow RATIO (unlike a
  // spacing/size token, which `min-w-32`/the status line's `max-w` below
  // both are).
  return 'min-w-32 flex-[2] p-0 [&_textarea]:min-h-6 [&_textarea]:max-h-14 [&_textarea]:resize-none [&_textarea]:px-0 [&_textarea]:py-0 [&_textarea]:leading-6';
}

/**
 * Round-4 point-check fix (defect B, `shouldShowStatusLine`'s sibling in the
 * layout half of the fix): the session card's single docked row places the
 * textarea, the status line, Model/Effort and the action buttons all in one
 * flex row. ANY same-row auxiliary text slot in that row must carry
 * `basis-0` — without an explicit `flex-basis`, its own (potentially long)
 * content becomes its flex base size, and CSS's negative-space shrink
 * distribution (`shrink × basis`) hands nearly all of the deficit to
 * whichever sibling has the larger basis, starving the textarea's
 * `flex: 1 1 0%` toward 0px regardless of its own `min-w-32` floor's
 * PRESENCE — `basis-0` is what stops that sibling from ever outweighing the
 * textarea in the first place; `min-w-32` above is the second, independent
 * line of defense.
 *
 * Round-4 Codex NEEDS-FIX #4 (F5b): `basis-0` alone, with `flex-grow`
 * left at its browser default of 0, was itself a regression — a grow:0
 * item never claims any of a row's POSITIVE leftover space, so this slot
 * rendered at literally 0px (its own zero basis, un-grown) for the
 * ordinary, no-error case too (short "Sending…"/attachment-hint text),
 * not just the long-error-text case the original fix targeted. Now
 * carries `flex-1` (grow:1 — the textarea's own `flex-[2]` above keeps a
 * 2:1 dominance so this slot still loses any real space contest) PLUS an
 * explicit `max-w-48` (192px, an ordinary Tailwind scale step) so it can
 * never claim more than a bounded share even in a very wide row —
 * `max-width` clamps a flex item's HYPOTHETICAL size too (not just its
 * final rendered size), so this simultaneously re-caps this slot's
 * contribution to the negative-space shrink calculation, the exact
 * protection `basis-0` used to provide alone.
 */
export function sessionStatusLineWrapperClass(): string {
  return 'flex min-w-0 flex-1 shrink basis-0 max-w-48 items-center gap-1.5';
}

/**
 * F5(a) (round-4 Codex NEEDS-FIX #4): the composer's inline status-line TEXT
 * for the non-sending, non-reading case. Session mode must NEVER select the
 * full `statusHint` (error / no-session / no-workspace / no-cwd) text —
 * even in combination with `hasLargeHint` being true (`shouldShowStatusLine`
 * can still show the row for `hasLargeHint` alone, independent of
 * `hasStatusError`) — because the destructive banner above the composer
 * card already owns that text exclusively (`shouldShowStatusLine`'s own
 * fix). Without this, the OLD `(!hasStatusError && largeHint) || statusHint`
 * selection still fell through to the full error text the instant
 * `hasStatusError` was true, regardless of why the row was showing at all —
 * a residual defect-B crack in exactly the combined state the original fix
 * did not consider. Empty mode is unaffected: unchanged fallback order.
 */
export function resolveIdleStatusText(input: {
  mode: MiddleColumnMode;
  hasStatusError: boolean;
  largeHint: string | null;
  statusHint: string;
}): string | null {
  if (input.mode === 'session' && input.hasStatusError) {
    return input.largeHint;
  }
  return (!input.hasStatusError && input.largeHint) || input.statusHint;
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
 *
 * Round-4 point-check fix (defect B): session mode no longer shows it for
 * `hasStatusError` at all. The full error text (`Error: ${lastError}` —
 * potentially a multi-hundred-character `rawEvents=[...]`/`hostAfter=...`
 * dump) already renders once, in full, in the destructive banner above the
 * composer card (`ChatComposer.tsx`'s `mb-2 max-h-28 …` block) — showing it
 * a SECOND time crammed into this same single flex row as the textarea was
 * not just redundant, it was the actual defect-B trigger: the error string's
 * own max-content width could claim the row's entire shrink budget and crush
 * the textarea to 0px (see `composerTextareaClass`'s `min-w-32` / the
 * layout-half fix `sessionStatusLineWrapperClass`, both below). The banner
 * is now the SOLE owner of error text in session mode; any future inline
 * status for an error state must be a short, fixed-length label (e.g.
 * "Failed"), never the full message.
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
  return input.sending || input.reading > 0 || input.hasLargeHint;
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
 *
 * T-19: `queuedCount` must also be checked before `busy` for the same reason
 * `pendingQuestion` is — a non-empty queue only exists while `busy` is true,
 * so a branch after `busy` would never fire. Once composer input unlocks
 * while a turn runs (T-19 decision 2), the old "use Stop, then send again"
 * copy is simply wrong — it tells the user to do something they no longer
 * need to.
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
  /** T-19: messages already queued for this session while a turn runs. */
  queuedCount?: number;
  /**
   * Round-2 P0: this send is a brand-new session's first message, going
   * through the create-session handshake (close → createSession → wait for
   * session.created, up to ~5s) rather than the instant 'direct' path an
   * already-bound session takes. Gets its own copy so a slow first message
   * doesn't read like an ordinary follow-up sitting in flight.
   */
  isCreatingSession?: boolean;
}): string {
  if (input.sending) {
    if (input.isCreatingSession) {
      return 'Creating session with Agent Host (first message only)…';
    }
    return input.attachmentCount > 0
      ? `Sending ${input.attachmentCount} attachment${input.attachmentCount > 1 ? 's' : ''} to Agent Host…`
      : 'Sending to Agent Host…';
  }
  if (input.pendingQuestion) {
    return PENDING_QUESTION_PLACEHOLDER;
  }
  // m9 fix: `hasWorkspace` must gate this branch too — a queue can outlive
  // its workspace (a bucket is only pruned when its SESSION disappears, not
  // when the workspace backing it is removed), and without this guard the
  // placeholder keeps promising delivery ("type another follow-up…") for a
  // queue that can no longer release at all, masking the real blocker.
  if ((input.queuedCount ?? 0) > 0 && input.hasWorkspace) {
    return `Queued ${input.queuedCount} — type another follow-up…`;
  }
  if (input.busy) {
    return 'Agent Host is running — your message will be queued…';
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
