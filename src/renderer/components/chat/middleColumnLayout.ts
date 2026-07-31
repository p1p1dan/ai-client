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

/**
 * Composer host div's class: empty centers-and-grows, session docks at a fixed
 * height. Both share `px-6`.
 *
 * T-30b2 (F-A10): the session host carries `pt-0`, NOT its old `pt-1.5` — the
 * 8px band above the card is owned exclusively by whichever upstream renders
 * last (`TIMELINE_PADDING_CLASS`'s `pb-2`, the question dock wrapper's `pb-2`,
 * or the queue strip's `mb-2`). Stacking a host padding on top was how the
 * band silently grew to 14px (A07 :2709 wrote 8px).
 */
export function middleColumnHostClass(mode: MiddleColumnMode): string {
  if (mode === 'empty') {
    return 'flex min-h-0 flex-1 flex-col justify-center px-6 pb-[9%]';
  }
  return 'shrink-0 px-6 pt-0 pb-3.5';
}

/** Timeline scroll area's inner padding (A07 `.tl`: 20/24/8). Padding stays outside `ReadingColumn`. */
export const TIMELINE_PADDING_CLASS = 'px-6 pt-5 pb-2';

// ---- One 24px control tier (T-30b2 §3.3 E1+E2) ----

/**
 * Single height source for every control inside the composer: attach button,
 * model trigger, target-row triggers and the round action keys are all 24px
 * (`h-6`/`size-6`). Tailwind's scanner cannot see dynamically-built class
 * names, so the class strings below spell `h-6`/`size-6` literally — this
 * constant is the assertion anchor (F-A3/F-A4 extract the numeric suffix and
 * cross-check `n × 4 === COMPOSER_CONTROL_SIZE`), not a runtime source.
 */
export const COMPOSER_CONTROL_SIZE = 24;

/**
 * The follow-up card's resting-height arithmetic as an assertable object
 * (F-A2). A07 :1844 wrote "40px (content 24 + padding 8×2)" — that sum
 * forgets the 2×1px border; the true border-box value is 42px, which is also
 * the Cursor reference measurement (52 device px @ DPR 1.25). T-28's review
 * "fixed" the mismatch in the wrong direction (kept 40, squeezed padding to
 * 5px and the key at 28); this restores content 24 + padding 8 + border 1
 * per side.
 */
export function composerFollowHeightBreakdown(): {
  border: number;
  padding: number;
  content: number;
  total: number;
} {
  const border = 2;
  const padding = 16;
  const content = COMPOSER_CONTROL_SIZE;
  return { border, padding, content, total: border + padding + content };
}

/**
 * Composer card's outer frame class — shared border/fill tokens, mode-specific
 * radius and layout.
 *
 * Border ladder (F-A1): rest = `--border`, focus = `--input` — the neutral
 * one-step ΔL≈0.035 gray ladder matching Cursor's measured focus behavior
 * (ΔL 0.033, zero chroma). The old `border-input` rest + `focus-within:
 * border-ring` (brand orange, C 0.15) was 2.5× Cursor's edge weight at rest
 * and lit the whole frame orange on focus — a top-4 "AI 化" source.
 *
 * Radius (拍板 ②): the resting follow-up card is a full pill (`rounded-full`,
 * r = h/2 — the Cursor measurement: circle-fit residual ≤1px), but ONLY while
 * it is a single resting row. When extras stack (attachment chips / notices /
 * queue rejections) the card grows and a pill radius would warp into huge
 * side arcs, so `hasExtras` demotes it to `rounded-md` (F-A2b). The empty
 * card measured ~12px on Cursor — `rounded-md` stays.
 */
export function composerCardClass(mode: MiddleColumnMode, opts?: { hasExtras?: boolean }): string {
  if (mode === 'empty') {
    return 'relative rounded-md border border-border bg-card focus-within:border-input p-2';
  }
  const radius = opts?.hasExtras ? 'rounded-md' : 'rounded-full';
  // Resting height contract: 42px = border 2 + padding 16 + content 24 —
  // see `composerFollowHeightBreakdown` (min-h-10.5 = 42px on the 0.25rem
  // scale; not an arbitrary value).
  return `relative ${radius} border border-border bg-card focus-within:border-input flex min-h-10.5 items-center gap-2 p-2`;
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
  // T-30b2: the banner-owns-error-text contract now covers BOTH modes — the
  // empty card's status line stopped being resident (`shouldShowStatusLine`
  // below), so the empty branch's old fall-through to the full `statusHint`
  // on error would have been the same defect-B text duplication, one mode
  // later.
  if (input.hasStatusError) {
    return input.largeHint;
  }
  return input.largeHint || input.statusHint;
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
 * Whether the composer's status line (sending / reading / large-attachment
 * hint) should be shown. Need-based in BOTH modes now (T-30b2, F-A11): the
 * empty card's old resident `Ready · cwd: …` line had no Cursor counterpart
 * and duplicated information the target row's folder trigger now carries in
 * its `title` (the full workspace path — the A06 "compensate before deleting"
 * requirement).
 *
 * Round-4 point-check fix (defect B), extended to both modes by T-30b2:
 * `hasStatusError` never shows this line. The full error text
 * (`Error: ${lastError}` — potentially a multi-hundred-character
 * `rawEvents=[...]`/`hostAfter=...` dump) already renders once, in full, in
 * the destructive banner above the composer card (`ChatComposer.tsx`'s
 * `mb-2 max-h-28 …` block) — showing it a SECOND time crammed into the same
 * flex row as the textarea was the actual defect-B trigger: the error
 * string's own max-content width could claim the row's entire shrink budget
 * and crush the textarea to 0px (see `composerTextareaClass`'s `min-w-32` /
 * the layout-half fix `sessionStatusLineWrapperClass`, both above). The
 * banner is the SOLE owner of error text; any future inline status for an
 * error state must be a short, fixed-length label (e.g. "Failed"), never the
 * full message.
 */
export function shouldShowStatusLine(input: {
  mode: MiddleColumnMode;
  sending: boolean;
  reading: number;
  hasStatusError: boolean;
  hasLargeHint: boolean;
}): boolean {
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
 * 24px true-circle class for the send/stop/retry/enqueue action key,
 * overriding `Button`'s forced squircle four-piece (`rounded-[10px]
 * [corner-shape:squircle] supports-…:rounded-[50px] before:rounded-[9px]…`).
 * 24px = `COMPOSER_CONTROL_SIZE` (E2: A07's "Cursor 目视约 36px" was a
 * measurement error — the reference circles are 30 device px @ DPR 1.25 =
 * 24 CSS px, i.e. A07's own `--h-btn`). Same for both modes — color comes
 * from `roundActionButtonKindClass`.
 */
export function roundActionButtonClass(): string {
  return 'size-6 rounded-full [corner-shape:round] supports-[corner-shape:squircle]:rounded-full before:rounded-full supports-[corner-shape:squircle]:before:rounded-full';
}

/**
 * Per-kind color for the round action key (拍板 ③ / F-A22). Send and enqueue
 * deliberately share one near-black fill (`--foreground` — Cursor's measured
 * `#141414`, C≈0; they are the same "submit" action family, distinguished by
 * icon) so the composer carries at most ONE high-saturation object at a time:
 * the destructive Stop. Retry keeps the outline variant and needs no
 * override. `bg-primary` here is a regression — the orange fill was one of
 * the four "AI 化" sources.
 */
export function roundActionButtonKindClass(kind: 'send' | 'enqueue' | 'stop' | 'retry'): string {
  switch (kind) {
    case 'send':
    case 'enqueue':
      return 'border-transparent bg-foreground text-background hover:bg-foreground/90 active:bg-foreground/80';
    case 'stop':
      return 'bg-destructive text-destructive-foreground';
    case 'retry':
      return '';
  }
}

// ---- Composer row/bar assembly + ghost chips (T-30b2 §5) ----

/** Session card's single docked control row (⊕ · textarea · status · model · keys). */
export function composerRowClass(): string {
  return 'flex min-w-0 items-center gap-2';
}

/**
 * Empty card's bottom bar (⊕ · model · status · keys). No `justify-between`:
 * the status slot carries `flex-1` when present, and the action-key group
 * carries `ml-auto` in the JSX so it stays right-pinned even when the status
 * line is hidden (need-based since T-30b2).
 */
export function composerBarClass(): string {
  return 'mt-1.5 flex items-center gap-2';
}

/**
 * ⊕ "Add file context" button (A07 `.icon-btn`, first given real semantics by
 * T-30b2 §4.6): inserts `@` at the caret and hands over to the existing
 * mention search — NOT an attachment picker (no renderer-side file-byte IPC
 * exists; paste attachments are T-18's separate path). Same shell pair as
 * every composer ghost chip: hover AND keyboard focus show the same fill.
 */
export function composerAttachButtonClass(): string {
  return 'grid size-6 shrink-0 place-items-center rounded-sm text-muted-foreground transition-colors duration-150 hover:bg-hover focus-visible:bg-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-primary disabled:pointer-events-none disabled:opacity-64';
}

/**
 * Merged model+effort trigger (拍板 ①, round-4 addendum §3.1): a naked text
 * chip — no border, no shadow, no width floor — whose shell (a `--hover`
 * fill, never a border: a hover-border would grow the row 2px and jitter)
 * appears only on hover / keyboard focus / open popup. The old
 * `SelectTrigger` pair brought `rounded-lg` (clamped to a full pill at
 * h-6) + `border-input` + `shadow-xs` + inner highlight + `min-w` — the #1
 * measured "AI 化" source. `min-w`'s dead space also caused the round-3
 * "text not centered" misdiagnosis: width is now pure content-fit. Do not
 * reintroduce any of the four (F-A15).
 */
export function composerModelTriggerClass(): string {
  return 'inline-flex h-6 shrink-0 items-center gap-1 rounded-sm px-2 text-ui transition-colors duration-150 hover:bg-hover focus-visible:bg-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-primary data-[popup-open]:bg-selection disabled:pointer-events-none disabled:opacity-64';
}

/** Model base name: the lighter half of the trigger's dual polarity. */
export function composerModelBaseClass(): string {
  return 'text-muted-foreground';
}

/**
 * Effort suffix: darker AND heavier than the base name (Cursor follow-up
 * polarity; L 0.19 vs 0.40 measured). `font-medium` only means anything on
 * the D25 proportional stack — on the old all-mono stack 500 rounded to 400
 * (F-A17 pins the ordering). Not rendered at all when effort = Default.
 */
export function composerModelSuffixClass(): string {
  return 'font-medium text-foreground';
}

/**
 * Target-row dropdown triggers (folder / branch), downshifted from the two
 * `.tsx` files so the composer has exactly ONE ghost-chip shape (F-A18):
 * same height, same `px-2`, same `rounded-sm` (the old `rounded-md` clamped
 * to a full pill at h-6 — §3.5), same hover/open shell as the model trigger.
 */
export function targetTriggerClass(tone?: 'default' | 'muted'): string {
  const base =
    'inline-flex h-6 items-center gap-1.5 rounded-sm px-2 text-ui hover:bg-hover data-[popup-open]:bg-selection disabled:opacity-64';
  return tone === 'muted' ? `${base} text-muted-foreground` : base;
}

/**
 * Queue strip outer wrapper (T-19 component, geometry owned here): `mb-2`
 * is this strip's whole share of the 8px band above the card (F-A10).
 */
export function queueStripWrapperClass(): string {
  return 'mb-2 flex max-h-24 flex-col gap-1 overflow-y-auto';
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
