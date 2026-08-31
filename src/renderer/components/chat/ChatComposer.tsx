import {
  agentDefaultEffort,
  agentDefaultModel,
  agentDefaultPermission,
  resolveDraftPermissionPreference,
} from '@shared/models/chatAgentDefaults';
import { sessionAgent } from '@shared/types/agentWire';
import type { RuntimeEvent, SessionRuntimeStatus } from '@shared/types/runtimeEvents';
import type { FileSearchResult } from '@shared/types/search';
import {
  File as FileIcon,
  FileText,
  Folder,
  Image as ImageIcon,
  TriangleAlert,
  X,
} from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AlertAction, AlertTitle } from '@/components/ui/alert';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { applyAutoSessionTitle } from '@/stores/chatSessionActions';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { useFileOpenIntentStore } from '@/stores/fileOpenIntent';
import { useMessageQueueStore } from '@/stores/messageQueue';
import { usePendingUserMessagesStore } from '@/stores/pendingUserMessages';
import { subscribeRuntimeEvent } from '@/stores/runtimeEventBus';
import { useSettingsHydrated, useSettingsStore } from '@/stores/settings';
import { type TurnSendOwner, useTurnSendStatusStore } from '@/stores/turnSendStatus';
import {
  classifyAssistantProgress,
  classifyTurnLiveness,
  collectAssistantMessageIds,
  countAssistantMessagesWithBlocks,
  hasNewAssistantMessage,
  isHostErrorForSend,
  isSessionCompletedForSend,
  isSessionFailedForSend,
  isSessionStoppedForSend,
  isUserEchoForSend,
  pushPendingHostError,
  readSessionFailedError,
  resolveAbandonProgress,
  resolvePendingHostError,
} from './assistantProgress';
import { largeAttachmentHint } from './attachmentLimits';
import {
  type AttachmentDraft,
  shouldRenderThumbnail,
  toAttachmentChip,
  totalAttachmentBytes,
  toWireAttachments,
} from './attachments';
import { ComposerAgentPicker } from './ComposerAgentPicker';
import { ComposerAttachMenu } from './ComposerAttachMenu';
import { ComposerModelTrigger } from './ComposerModelTrigger';
import { ComposerPermissionTrigger } from './ComposerPermissionTrigger';
import { ComposerRoundButton } from './ComposerRoundButton';
import { ComposerTargetBar } from './ComposerTargetBar';
import { deriveChatEmptySurface } from './chatEmptyState';
import { AGENT_UNAVAILABLE_SEND_ERROR, isSendableAgent } from './composerAgentPickerModel';
import { resolveActiveTarget } from './composerTarget';
import { resolveEffortSelection, toWireEffort } from './efforts';
import { createEventRing, type EventRing } from './eventRing';
import { extractMentionQuery, parseMentionChips, replaceMention } from './fileMention';
import { consumeForkDraftCarry } from './forkDraftCarry';
import { type QueuedMessage, selectSessionQueue } from './messageQueue';
import {
  composerActionGroupClass,
  composerBarClass,
  composerCardClass,
  composerPlaceholder,
  composerRowsClass,
  composerTextareaClass,
  type MiddleColumnMode,
  mentionPopupPlacementClass,
  resolveIdleStatusText,
  sessionStatusLineWrapperClass,
  shouldShowStatusLine,
} from './middleColumnLayout';
import { resolveResumeModel } from './models';
import { QueuedMessageStrip } from './QueuedMessageStrip';
import {
  decideAdmittedTimeoutOutcome,
  decideFailureAffordance,
  decidePendingResolution,
  decideRunEntryOutcome,
  decideSendAction,
  deriveActionButtons,
  deriveQueueStripModel,
  isAdmittedOutcome,
  isRunningStatus,
  type RestoredDraftMarker,
  type RunEntryOutcome,
  type RunSendOrigin,
  shouldClearPauseOnSend,
  shouldClearRetryableOnOutcome,
  shouldPauseQueueOnRejection,
  shouldRetryBusySend,
  shouldRevokeRestoredDraft,
} from './queueRelease';
import { ReadingColumn } from './ReadingColumn';
import { createSendWaitBudget, SEND_SILENCE_CEILING_MS } from './sendBudgets';
import { decideSendPreamble } from './sendPreamble';
import { sessionHasUserMessage } from './sessionIndex/sessionTitle';
import { clearDraftPermission, readDraftPermission } from './sessionPreferenceStore';
import { useComposerAttachments } from './useComposerAttachments';
import { useHostStatus } from './useHostStatus';
import { useQueueRelease } from './useQueueRelease';
import { useSessionEffort } from './useSessionEffort';
import { useSessionModel } from './useSessionModel';

interface ChatComposerProps {
  /** T-28: two-state host mode — drives the card shape/layout branch below (§3.4). */
  mode: MiddleColumnMode;
  disabled?: boolean;
  /** Opens the shared AddRepositoryDialog (owned by App) — see ComposerTargetBar. */
  onAddRepository?: (mode?: 'local' | 'remote' | 'ssh') => void;
  /** Fires once runSend's guards pass. Origin lets ChatWorkspace distinguish an explicit Send/Retry from an automatic queue release. */
  onSendStart?: (origin: RunSendOrigin) => void;
  /**
   * D48 S1: whether this session's agent binding is already settled
   * (`isChatAgentBindingLocked`). Computed in `ChatWorkspace` because the
   * `sendAttempted` half of that criterion is its local latch and never
   * reaches a store — see `sessionBinding.ts`.
   */
  agentBindingLocked?: boolean;
  /**
   * D48 S1: the raw `sendAttempted` latch behind `agentBindingLocked`'s first
   * arm, passed unfolded because `setDraftSessionAgent`'s option of that name
   * is a contract about that one fact — see `ComposerAgentPicker`'s prop doc.
   */
  agentSendAttempted?: boolean;
}

/** T-07③: popup page size. Kept next to the truncation hint that reports it. */
const MENTION_PAGE_SIZE = 10;

// T-19: same id-generation shape as useComposerAttachments' `nextDraftId` —
// monotonic per-module counter, collision-proof within one renderer session.
let queuedMessageSeq = 0;

function nextQueuedMessageId(): string {
  queuedMessageSeq += 1;
  return `queued-${Date.now().toString(36)}-${queuedMessageSeq}`;
}

// M6 fix: delegate to queueRelease.ts's exported `isRunningStatus` instead of
// hand-copying the four-status list — a second copy is exactly the "must be
// kept in sync by inspection" risk the T-19 fix review flagged.
function isStoppable(status: SessionRuntimeStatus | undefined): boolean {
  return status != null && isRunningStatus(status);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function formatRuntimeEvent(event: { type: string; payload?: unknown }): string {
  const payload =
    event.payload && typeof event.payload === 'object'
      ? (event.payload as {
          code?: string;
          message?: string;
          error?: string;
          status?: string;
          // a1: surfaced so the diagnostic string this feeds (lastError's
          // rawEvents=[...] summary) carries the ONE event that actually
          // explains a "hung" turn — previously eventNormalizer dropped
          // api_retry entirely, so this event never reached the log.
          retry?: { attempt?: number; maxRetries?: number };
          // F2 (2026-08-18): a Host watchdog window elapsed and the watchdog
          // DECLINED to abort. Printing it is half of what makes this batch
          // diagnosable — without it, `rawEvents=[...]` cannot distinguish
          // "the Host looked and decided the turn is alive" from "nothing
          // happened at all".
          liveness?: { source?: string; reason?: string; degraded?: boolean };
          // F2-g (2026-08-17 inspection): without the role, the user-echo
          // message.started/delta/completed trio reads as assistant progress
          // in rawEvents=[...] and the "no progress" diagnostic looks
          // self-contradicting.
          role?: string;
        })
      : null;
  const code = payload?.code;
  const message = payload?.message ?? payload?.error;
  const status = payload?.status;
  const retry = payload?.retry;
  const liveness = payload?.liveness;
  const role = payload?.role;
  if (code || message) {
    return `${event.type}(${code ?? ''}${code && message ? ': ' : ''}${message ?? ''})`;
  }
  if (status) {
    const retrySuffix = retry ? `,retry ${retry.attempt ?? '?'}/${retry.maxRetries ?? '?'}` : '';
    // `degraded` is only ever set by the one branch that permanently closes
    // the TTFT table, so `ttft-degraded` loses nothing that `reason` carried.
    const livenessSuffix = liveness
      ? `,${liveness.source ?? '?'}-${liveness.degraded ? 'degraded' : (liveness.reason ?? '?')}`
      : '';
    return `${event.type}(${status}${retrySuffix}${livenessSuffix})`;
  }
  if (role) {
    return `${event.type}(${role})`;
  }
  return event.type;
}

/**
 * Renders an `eventRing.ts` ring for the `rawEvents=[...]` diagnostic lines
 * below. A dropped-events prefix comes first (partial-messages build spec
 * §2 "片 2") so a reader sees the trail is incomplete before scanning it.
 */
function formatSeenEvents(ring: EventRing): string {
  const dropped = ring.dropped();
  const prefix = dropped > 0 ? `…(${dropped} earlier events dropped) ` : '';
  return `${prefix}${ring.snapshot().join(' ; ') || 'none'}`;
}

interface AttachmentChipProps {
  draft: AttachmentDraft;
  sending: boolean;
  onRemove: (id: string) => void;
}

/**
 * One attachment chip.
 *
 * Memoised on purpose: the send status line ticks once a second for up to
 * SEND_SILENCE_CEILING_MS, and re-deriving `data:${mediaType};base64,${data}`
 * on every one of those renders would flatten a multi-MB string per tick for
 * the whole wait. With stable props React skips this subtree entirely.
 */
const AttachmentChip = memo(function AttachmentChip({
  draft,
  sending,
  onRemove,
}: AttachmentChipProps) {
  const chip = toAttachmentChip(draft);
  // The clipboard is invisible — a thumbnail is the only way to confirm what
  // was actually pasted. Large images fall back to the icon: a data: URI is
  // decoded at natural size before being rastered into 16 CSS pixels.
  const previewUrl = useMemo(
    () => (shouldRenderThumbnail(draft) ? `data:${draft.mediaType};base64,${draft.data}` : null),
    [draft]
  );

  return (
    <span
      className={cn(
        'inline-flex h-6 max-w-56 shrink-0 items-center gap-1 rounded-xs border border-border bg-muted/50 pr-0.5 pl-1.5 text-meta text-foreground',
        sending && 'pointer-events-none opacity-64'
      )}
    >
      {previewUrl ? (
        <img src={previewUrl} alt="" className="size-4 shrink-0 rounded-xs object-cover" />
      ) : draft.kind === 'image' ? (
        <ImageIcon className="size-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <FileText className="size-3.5 shrink-0 text-muted-foreground" />
      )}
      <span className="min-w-0 flex-1 truncate" title={chip.title}>
        {chip.label}
      </span>
      <span className="shrink-0 tabular-nums text-muted-foreground">{chip.sizeLabel}</span>
      <button
        type="button"
        onClick={() => onRemove(draft.id)}
        disabled={sending}
        aria-label={`Remove ${chip.title}`}
        className="flex size-4 shrink-0 items-center justify-center rounded-xs text-muted-foreground transition-colors duration-150 hover:bg-accent/50 hover:text-foreground disabled:pointer-events-none disabled:opacity-64"
      >
        <X className="size-3" />
      </button>
    </span>
  );
});

/**
 * Wait until `predicate` holds, or until `expired` says to stop. Returns false
 * on expiry.
 *
 * F2 (2026-08-18): the expiry RULE is injected instead of a fixed `timeoutMs`.
 * The old form (`Date.now() - start < timeoutMs`) had zero reset conditions,
 * so a turn that was demonstrably alive — `session.status(running, retry 1/10)`
 * frames arriving from the Host the whole time — still ran out of budget on
 * schedule and was then reported as a failure. The two handshake waits keep a
 * fixed deadline (`deadlineAt`); the main wait passes a RESETTABLE silence
 * budget (`sendBudgets.ts`).
 */
async function waitUntil(
  predicate: () => boolean,
  expired: () => boolean,
  stepMs = 50
): Promise<boolean> {
  while (!expired()) {
    if (predicate()) return true;
    await sleep(stepMs);
  }
  return predicate();
}

/**
 * F2 (2026-08-18 §4.2): why `runSend` stopped waiting — the FIRST of the two
 * layers. It answers only that question; whether the Host ever took the turn is
 * the second layer's (`decideAdmittedTimeoutOutcome`), and the two are
 * deliberately not merged: one is about this renderer, the other about the Host.
 *
 * Spelled as a union rather than the old `boolean` because the exits are not
 * two but four, and `false` used to mean both "the budget ran out" and "the
 * user pressed Stop and the Host never answered" — which is how a Stop came to
 * be reported with a no-progress error card. As explicit `case` labels these
 * also give the source-scan guards (`composerStopStatic.test.ts`) an anchor
 * that survives renaming any local variable.
 */
type WaitResult =
  /** A release condition fired: progress, a permission/question park, or a fatal error. */
  | 'progress'
  /** THIS attempt's own `session.stopped` / `session.completed` reached the wire. */
  | 'terminal'
  /** A newer generation superseded this attempt (Stop, or a fresh send). */
  | 'cancelled'
  /** The silence ceiling (or the absolute loop bound) elapsed. NOT a verdict. */
  | 'ceiling';

/**
 * Fixed-deadline expiry rule, for the two handshake waits whose semantics did
 * NOT change: a create/resume acknowledgement either arrives promptly or the
 * Host is not answering, and no liveness frame for a session that does not
 * exist yet could reset anything.
 */
function deadlineAt(durationMs: number): () => boolean {
  const at = Date.now() + durationMs;
  return () => Date.now() >= at;
}

export function ChatComposer({
  mode,
  disabled,
  onAddRepository,
  onSendStart,
  agentBindingLocked = false,
  agentSendAttempted = false,
}: ChatComposerProps) {
  const [value, setValue] = useState('');
  const [sending, setSending] = useState(false);
  // T-19 fix review (R5): reverted from batch 3's queue-based "failure
  // payload lives on queueEntries[0].failure" back to a component-local
  // snapshot — batch 3's form let a swap-edit on a failed head clear
  // `failure` and auto-release the user's half-typed draft (blocker), and let
  // a second direct-send failure produce a second, un-retryable queue entry
  // (major). An object rather than a plain string because an attachment-only
  // turn fails with text '' — `retryable !== null` is then the only honest
  // "the last turn failed" signal. Carries `drafts` (T-18's `{ text }`
  // upgraded per decision 2.2) so Retry replays the EXACT attachments that
  // failed, not whatever happens to be in the live list.
  const [retryable, setRetryable] = useState<{
    text: string;
    drafts: readonly AttachmentDraft[];
  } | null>(null);
  // T-19: rejection message from a failed `enqueue()` (queue full / over the
  // attachment byte budget) — decision 1/7's "reject, never silently drop".
  const [queueNotice, setQueueNotice] = useState<string | null>(null);
  // T-31 §3 (R4): T-18's three send-status values — the seconds ticker, the
  // wait budget and the handshake/awaiting phase — used to be `useState` here,
  // feeding the composer's own status row. That row moved to the turn head, and
  // nothing inside this component reads them any more, so they MOVED to
  // `stores/turnSendStatus.ts` rather than staying here with a mirror beside
  // them. `sending` below is unchanged and stays local: it gates this
  // component's own affordances (placeholder, canSend, queue release), which is
  // a composer concern, not a turn one.
  const beginTurnSend = useTurnSendStatusStore((state) => state.begin);
  const updateTurnSend = useTurnSendStatusStore((state) => state.update);
  const endTurnSend = useTurnSendStatusStore((state) => state.end);
  // F2 §4.5: the second slot's two actions. Kept as separate selectors for the
  // same reason the three above are — a whole-store subscription would
  // re-render the composer on every seconds tick the turn head publishes.
  const armPendingReply = useTurnSendStatusStore((state) => state.armPendingReply);
  const clearPendingReply = useTurnSendStatusStore((state) => state.clearPendingReply);
  // Review batch F3: the ownership token of the send THIS instance currently
  // holds the status slot for, so the unmount cleanup below can only ever clear
  // its own snapshot — never one a surviving instance published in the
  // meantime. `runSend`'s ticker / phase switch / `finally` carry the token in
  // their own closure instead (they may outlive this component).
  const sendOwnerRef = useRef<TurnSendOwner | null>(null);
  const phaseStartedAtRef = useRef(0);
  // Synchronous re-entry latch: `canSend` is a render-closure constant and
  // setSending is async, so two calls in one tick would both pass the checks.
  const inFlightRef = useRef(false);
  // m10 fix: which session's turn `inFlightRef` actually belongs to — this
  // component's `sending`/`inFlightRef` are NOT per-session, so if the user
  // switches sessions while a send is in flight, `activeSessionId` no longer
  // names the session that is actually running. `handleStop`'s queue-pause
  // must target this, not `activeSessionId`.
  const inFlightSessionIdRef = useRef<string | null>(null);
  // F6 (round-2 review fix): invalidates an in-flight runSend's session_busy
  // backoff loop the instant the user clicks Stop — without this, a resend
  // queued up between two 250ms backoff sleeps could still fire AFTER Stop
  // already told the Host to abort the turn the user was looking at,
  // silently starting a turn they had just explicitly cancelled.
  const sendGenerationRef = useRef(0);
  // F2 (2026-08-18 §4.2/§5.1): the `'pending'` branch's own record of a turn
  // the Host ADMITTED and is still running, which this renderer stopped waiting
  // for. It is not a failure marker any more — its predecessor
  // (`abandonMarkerRef`) existed to un-say a red banner the abandon branch had
  // just fabricated, and that branch no longer fabricates anything. What it
  // carries now is the found-material for the ONE case that may still replay
  // the input: if a real `session.failed` arrives later, the turn is CONFIRMED
  // dead and D1 puts the payload back (with provenance — see
  // `restoredDraftRef`). If instead a late reply, a `session.completed` or a
  // Stop arrives, this is dropped in silence and the composer was never
  // touched at all.
  //
  // Deliberately holds no `error`: the ceiling path writes no `lastError` and
  // arms no `retryable`, so it has no products of its own to clean up, and
  // clearing someone else's would be overreach.
  //
  // S4 (round-2 iteration-3 review): `assistantCursor` (count of
  // assistant-with-blocks messages observed AT ARM TIME) is the monotonic
  // marker the clearing effect compares against, instead of reading "does
  // any assistant message exist" off session-wide state — a resumed
  // session's REPLAYED history already satisfies that unconditional check,
  // so ANY unrelated status/message change used to wipe this marker (and the
  // user's payload with it) the instant it fired.
  const pendingReplyRef = useRef<{
    sessionId: string;
    committed: { text: string; drafts: readonly AttachmentDraft[] };
    assistantCursor: number;
  } | null>(null);
  // §5.3 (D1 connected): provenance for a draft this component restored BY
  // ITSELF, and the only thing a late event is ever allowed to take back out.
  const restoredDraftRef = useRef<RestoredDraftMarker | null>(null);
  // Monotonic revision of the composer's text, bumped by `updateValue` — the
  // single write path for `value`. This is what distinguishes "still the draft
  // we restored" from "the user retyped the identical sentence": the second
  // moves this counter even though every character matches.
  const valueRevisionRef = useRef(0);
  // The attachment half of the same question. Ids rather than a count, because
  // a count cannot see "removed one, added one" — and ids come from a
  // monotonic sequence, so a re-paste of the same image is a different id.
  // Mirrored through an effect because a paste never passes through this
  // component: the hook's own state is the only complete observation point.
  const draftIdsRef = useRef<readonly string[]>([]);
  const attachmentRevisionRef = useRef(0);
  // A1 (round-4 point-check fix): a fresh-value mirror of the composer's own
  // `value` state. `runSend` is a plain closure re-created every render, so
  // an ALREADY-RUNNING call's committed-outcome draft-restore (it can fire
  // tens of seconds after the user started typing something else) must read
  // the CURRENT composer text, not whatever it captured at call time —
  // exactly the same staleness class this file already routes around via
  // `useChatSessionsStore.getState()` for store-backed state, but `value` is
  // local React state with no such accessor.
  //
  // F4 (round-4 Codex NEEDS-FIX #3): written SYNCHRONOUSLY by `updateValue`
  // (below) at every `setValue` call site, not by a `useEffect([value])`.
  // An effect runs a full render AFTER the state update that triggered it —
  // in the window between that state update and the effect actually
  // running, a committed-outcome restore reading the STALE ref could still
  // pass the "composer is empty" check on text the user had already
  // replaced (or, symmetrically, wrongly treat a just-cleared composer as
  // non-empty and skip a restore it owed), a real two-direction race the
  // synchronous write closes.
  const valueRef = useRef(value);
  const updateValue = useCallback((next: string) => {
    valueRef.current = next;
    // F2 §5.3: bumped on EVERY write, including our own restore — the marker
    // records the value AFTER the restore, so any later keystroke moves it out
    // of match and the restore becomes the user's to keep.
    valueRevisionRef.current += 1;
    setValue(next);
  }, []);
  // Round-4 point-check fix (Codex 2.3): the empty->session mode switch
  // remounts `textareaEl` under a structurally different parent (see the
  // mode-branch JSX below), destroying the native <textarea> node — and any
  // focus it held — the instant the FIRST send flips `mode`. `hadFocusRef`
  // (set by the textarea's own onFocus/onBlur) plus the effect further down
  // that watches `mode` is what restores focus (and the caret) onto the new
  // node right after that remount, instead of leaving the user to re-click
  // into the box they were just typing in.
  const hadFocusRef = useRef(false);
  // T-07 @ 文件引用：popup 态、搜索结果、选中索引、IME 合成态。delayed 焦点
  // 恢复通过 setTimeout 在 React 提交后再 setSelectionRange。
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionResults, setMentionResults] = useState<FileSearchResult[]>([]);
  /** T-07③ pre-truncation match count, so the popup can say "10 / 304". */
  const [mentionTotal, setMentionTotal] = useState(0);
  const [mentionIndex, setMentionIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const stopActiveSession = useChatSessionsStore((state) => state.stopActiveSession);
  const respondQuestion = useChatSessionsStore((state) => state.respondQuestion);
  const activeSessionId = useChatSessionsStore((state) => state.activeSessionId);
  const sessions = useChatSessionsStore((state) => state.sessions);
  const workspaces = useChatSessionsStore((state) => state.workspaces);
  const lastError = useChatSessionsStore((state) => state.lastError);
  const activeMessages = useChatSessionsStore((state) =>
    state.activeSessionId ? state.messages[state.activeSessionId] : undefined
  );
  // T-05: this session has a pending question dock showing (drives the
  // "Add more optional details…" placeholder, A07 screen 6 group E).
  const pendingQuestionHere = useChatSessionsStore(
    (state) =>
      state.pendingQuestion?.sessionId != null &&
      state.pendingQuestion.sessionId === state.activeSessionId
  );
  // T-19 decision 4: a pending permission is never auto-answered, only hinted
  // at — this scopes that hint (and the "don't deny for the user" rule) to
  // THIS session, same pattern as pendingQuestionHere above.
  const pendingPermissionHere = useChatSessionsStore((state) =>
    state.pendingPermissions.some((item) => item.sessionId === state.activeSessionId)
  );
  // T-19: this session's live queue — feeds the placeholder copy (decision
  // 2.6), the release hook, and the strip (batch 3). `selectSessionQueue`
  // returns a stable empty-array/null sentinel for an unknown session, so
  // these two selectors never thrash.
  const queueEntries = useMessageQueueStore(
    (state) => selectSessionQueue(state.state, activeSessionId).entries
  );
  const queuePaused = useMessageQueueStore(
    (state) => selectSessionQueue(state.state, activeSessionId).paused
  );
  const queuedCount = queueEntries.length;

  // T-27: shared with the Composer target bar (§2.6) — this is the same
  // production derivation the target bar's plan/apply flow lands through,
  // not a parallel copy of the lookup logic.
  const {
    session: activeSession,
    workspace: activeWorkspace,
    cwd,
  } = resolveActiveTarget({ activeSessionId, sessions, workspaces });
  const mentionChips = useMemo(() => parseMentionChips(value), [value]);
  const mentionOpen = mentionQuery !== null && mentionResults.length > 0;
  const busy = isStoppable(activeSession?.status);
  // A Send in flight must also be abortable: the SDK stream can hang (e.g.
  // gateway revoked key) without ever flipping session.status to running, and
  // the user needs Stop during the 45s wait, not just when store says busy.
  const canStop = busy || sending;
  // Round-2 P0: THIS session has no live Host registry entry yet, so a send
  // right now would take runSend's 'create' preamble (close → sleep(120) →
  // createSession → wait up to 5s for session.created) instead of the
  // instant 'direct' path an already-bound session takes. Used only to give
  // that one-time handshake its own placeholder copy (isCreatingSession
  // below) — distinct from ordinary "Sending to Agent Host…" follow-ups.
  const hostBound = useChatSessionsStore((state) =>
    activeSessionId ? state.hostBoundSessionIds.includes(activeSessionId) : false
  );
  const isCreatingSession = sending && !hostBound && activeSession?.runtimeIdentity == null;
  // `cwd` (resolveActiveTarget's derived value, not `activeWorkspace?.path`
  // directly): it already folds "no workspace" and "workspace present but
  // not targetable (demo placeholder's empty path)" into a single null, so
  // every send-gate check below reads that one value instead of re-deriving
  // "is this path usable" ad hoc.
  const canSend = Boolean(activeSessionId && cwd && !disabled && !canStop);
  const { getSessionModel } = useSessionModel();
  const { getSessionEffort } = useSessionEffort();
  // D48 S2 §4.3-1: the model trigger is handed the SAME binding the agent
  // picker shows — `sessionAgent` is the one reader that knows what an unset
  // binding means, and two independent resolutions of "which agent" is how a
  // menu ends up offering the other runtime's catalog.
  const composerAgent = sessionAgent(activeSession ?? {});
  const chatAgentDefaults = useSettingsStore((state) => state.chatAgentDefaults);
  // D48 S3 §5.5-3 (C15): app settings rehydrate over an async IPC round trip,
  // and the posture a first send materialises is PERMANENT for that session
  // (resume replays the snapshot and never revisits the template). Sending a
  // factory value that nobody chose would pin it forever, so the send path has
  // to know whether what it is reading is real yet.
  const settingsHydrated = useSettingsHydrated();
  // R11 (round-2 iteration-2 review): the same Host-reported default the
  // resume paths (LeftNav/MessageTimeline) already resolve through — so the
  // live send path and ModelSelect's own display never diverge from what a
  // resume just pinned onto the Host registry entry.
  const { status: hostStatus, retry: retryHost } = useHostStatus();
  // T-18 paste attachments. Reads/encoding stay in the hook; every threshold
  // and format decision is a pure function under __tests__.
  // T-19 decision 2.1: paste unlocks whenever the textarea does — only
  // "nowhere to put this draft" (`!activeSessionId`) still locks it. A
  // running/sending turn no longer does: that draft may need to go on the
  // queue, and a queued message must be able to carry attachments too.
  const attachments = useComposerAttachments({ disabled: Boolean(disabled) || !activeSessionId });
  const { clearDrafts: clearAttachmentDrafts, dismissNotice: dismissAttachmentNotice } =
    attachments;

  // F2 §5.3: the attachment half of the restored-draft provenance. It has to be
  // mirrored out of the hook's own state rather than counted at this
  // component's call sites, because the two most common mutations — a paste and
  // a file pick — happen entirely inside the hook and never pass through here.
  // One render behind by construction, which is harmless for the only consumer:
  // a late runtime event arriving seconds after the restore.
  useEffect(() => {
    draftIdsRef.current = attachments.drafts.map((draft) => draft.id);
    attachmentRevisionRef.current += 1;
  }, [attachments.drafts]);

  // A1's draft restore, LIFTED out of `runSend` (F2 §5.3): it now has two
  // callers — the `'committed'` failure path inside `runSend`, and the
  // confirmed-death listener further down (D1) which fires long after that
  // closure is gone. Both must write the SAME provenance marker, so there can
  // only be one of these.
  //
  // Reads the FRESH mirrors (`valueRef`, synced synchronously by `updateValue`;
  // `getLiveDraftCount`, the hook's own ref) rather than render-closure values,
  // because this can fire tens of seconds after the render that armed it — by
  // which time the user may have started typing something else that must never
  // be clobbered.
  const restoreDraftIfComposerEmpty = useCallback(
    (sessionId: string, payload: { text: string; drafts: readonly AttachmentDraft[] }) => {
      const composerIsEmpty =
        valueRef.current.trim().length === 0 && attachments.getLiveDraftCount() === 0;
      if (!composerIsEmpty) return;
      if (payload.text) updateValue(payload.text);
      if (payload.drafts.length > 0) attachments.addDrafts(payload.drafts);
      // Written AFTER the two writes above, so `valueRevision` is the revision
      // the restore itself produced. "This draft is ours, not the user's."
      restoredDraftRef.current = {
        sessionId,
        text: payload.text,
        draftIds: payload.drafts.map((draft) => draft.id),
        valueRevision: valueRevisionRef.current,
        attachmentRevision: attachmentRevisionRef.current,
      };
    },
    [attachments, updateValue]
  );

  // Step 7 of the late-event cleanup chain (§5.4). Asymmetric on purpose:
  // revoking wrongly destroys input that exists nowhere else, while failing to
  // revoke leaves a visible duplicate the user can delete — so every clause of
  // `shouldRevokeRestoredDraft` is a veto and the default is to leave it alone.
  // The marker is dropped either way (step 8): once a late event has been
  // evaluated against it, it has had its one chance.
  const revokeRestoredDraftIfUntouched = useCallback(
    (sessionId: string) => {
      const marker = restoredDraftRef.current;
      if (!marker) return;
      const revoke = shouldRevokeRestoredDraft(marker, {
        sessionId,
        text: valueRef.current,
        draftIds: draftIdsRef.current,
        valueRevision: valueRevisionRef.current,
      });
      restoredDraftRef.current = null;
      if (!revoke) return;
      updateValue('');
      if (marker.draftIds.length > 0) attachments.removeDrafts(marker.draftIds);
    },
    [attachments, updateValue]
  );

  // Drafts belong to the session they were pasted into. The Composer is mounted
  // once with no key, so without this a screenshot pasted in session A would
  // ride along with the next message sent from session B — real image tokens
  // and unrelated visual context, invisible in the timeline either way. The
  // failure state is scoped the same way: session A's Retry must not appear
  // over session B.
  useEffect(() => {
    // T-27 fix: a fork (useComposerTarget's selectTarget / applyPendingTarget
    // marking `markForkDraftCarry`) intentionally carries the composer's
    // in-flight state onto the new session — the textarea `value` state is
    // never touched here either way, so text + attachments land together on
    // the forked session instead of being wiped by the switch below.
    if (activeSessionId && consumeForkDraftCarry(activeSessionId)) return;
    clearAttachmentDrafts();
    dismissAttachmentNotice();
    setRetryable(null);
    // T-19: a stale "queue full" rejection belongs to the session that
    // rejected it, not to whatever session is now active.
    setQueueNotice(null);
  }, [activeSessionId, clearAttachmentDrafts, dismissAttachmentNotice]);

  // B9 (round-4 point-check fix, Codex 2.3): `mode` flipping empty->session
  // (the FIRST send) remounts `textareaEl` under a structurally different
  // parent below, destroying the native <textarea> node. If the user was
  // still focused on it right before that (the exact moment a keystroke —
  // Enter — triggered the switch), restore focus (and the caret, at the end
  // of whatever text is now in the box) onto the freshly-mounted node so
  // T-19's "keep typing while it runs" promise does not silently break at
  // the one instant it matters most.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mode triggers the focus-restore across the remount mode itself causes
  useEffect(() => {
    if (!hadFocusRef.current) return;
    const ta = textareaRef.current;
    if (!ta) return;
    ta.focus();
    const len = ta.value.length;
    ta.setSelectionRange(len, len);
  }, [mode]);

  const statusHint = !activeSessionId
    ? 'No session selected — pick Live Agent Host in the left nav (or click New).'
    : !activeWorkspace
      ? 'Active session has no workspace — re-open a repository and refresh.'
      : !cwd
        ? 'No repository registered — launch with --open-path=<repo> (or add a repository) first.'
        : lastError
          ? `Error: ${lastError}`
          : sending
            ? 'Starting Agent Host / sending…'
            : busy
              ? 'Agent Host running — use Stop to abort'
              : `Ready · cwd: ${cwd}`;

  // T-27 round-3 (point-check #10): fire-and-forget after ANY `runSend` call
  // site sees a 'committed' outcome (the Host admitted the turn — see
  // `RunEntryOutcome`) — covers a direct send, a queue-release first send,
  // and a Retry that succeeds. `applyAutoSessionTitle` itself no-ops unless
  // the session's title is still a placeholder, so later messages on an
  // already-titled session are cheap no-ops, not repeat renames. Not
  // awaited: a rename lagging behind by one IPC round-trip must never delay
  // the composer unlocking for the next message.
  //
  // R3 fix: `hadUserMessage` gates this — every call site captures it (via
  // `sessionHasUserMessage`, off a fresh store read) BEFORE calling
  // `runSend`, never after. This matters because all three call sites carry
  // "the message that was just sent", not necessarily the session's FIRST
  // one: a resumed session's replayed history already has user messages
  // even though its title may still be a placeholder (predates this
  // feature, or its true first message had no derivable title), so a later
  // follow-up must not be mistaken for the first message and re-title the
  // session. Reading the timeline AFTER runSend would always see the
  // just-admitted message and be trivially true — the flag has to be
  // captured before that message can land.
  const maybeApplyFirstMessageTitle = useCallback(
    (sessionId: string, text: string, outcome: RunEntryOutcome, hadUserMessage: boolean) => {
      // F2 (§4.3 consumption point 6): ADMITTED, not `=== 'committed'`. This is
      // the one row of the six where the silent default was wrong in the other
      // direction — a first message whose reply timed out is still in the CLI's
      // own transcript, so the chat should carry its name. Leaving it untitled
      // would have been a second, quieter way of pretending the turn never
      // happened.
      if (!isAdmittedOutcome(outcome)) return;
      if (hadUserMessage) return;
      void applyAutoSessionTitle(sessionId, text);
    },
    []
  );

  // T-19 decision 2.3: Enter/Send-click both funnel through the same pure
  // dispatch — `decideSendAction` is the single place that decides whether
  // this keystroke starts a turn or joins the queue behind one already
  // running. `inFlightRef.current` (not `sending`) is read here on purpose:
  // it is the synchronous latch, `sending` lags a render behind it.
  const handleSend = async () => {
    const trimmed = value.trim();
    const action = decideSendAction({
      hasTarget: Boolean(activeSessionId && cwd),
      disabled: Boolean(disabled),
      busy,
      sending,
      inFlight: inFlightRef.current,
      hasContent: Boolean(trimmed) || attachments.drafts.length > 0,
      reading: attachments.reading,
      hasQueuedEntries: queuedCount > 0,
    });

    if (action === 'blocked') return;

    if (action === 'send') {
      // R3 fix: capture BEFORE runSend — the user's own echo for THIS send
      // has not landed on the timeline yet at this point, so this reads
      // whatever history already existed (empty for a genuinely new
      // session, non-empty for a resumed one).
      const hadUserMessage = activeSessionId
        ? sessionHasUserMessage(useChatSessionsStore.getState().messages[activeSessionId] ?? [])
        : false;
      const outcome = await runSend(trimmed, attachments.drafts, {
        clearComposerValue: true,
        origin: 'direct',
      });
      if (activeSessionId) {
        maybeApplyFirstMessageTitle(activeSessionId, trimmed, outcome, hadUserMessage);
      }
      return;
    }

    // action === 'enqueue' (decision 1/2/3): a turn is already running — join
    // the queue instead of racing it. `decideSendAction`'s `hasTarget` check
    // already guarantees `activeSessionId` is non-null here.
    if (!activeSessionId) return;
    const queued: QueuedMessage = {
      id: nextQueuedMessageId(),
      sessionId: activeSessionId,
      text: trimmed,
      attachments: attachments.drafts,
      queuedAt: Date.now(),
    };
    const result = useMessageQueueStore.getState().enqueue(queued);
    if (!result.ok) {
      // Decision 1/7: reject and keep the draft exactly as typed — never
      // silently drop it.
      setQueueNotice(result.message);
      return;
    }
    setQueueNotice(null);
    // T26: enqueue is itself an explicit user Send and should return the
    // reader to the live edge now. Its later automatic release is deliberately
    // excluded from scrolling by ChatWorkspace's origin check.
    onSendStart?.('direct');
    // Commit-point consumption for the enqueue path, mirroring runSend's
    // (decision 2.2): the draft is now owned by the queue entry.
    updateValue('');
    attachments.removeDrafts(queued.attachments.map((draft) => draft.id));

    // Decision 4: a pending question on THIS session must never deadlock the
    // queue behind an answer the user chose not to give — cancel it
    // (non-destructive: SDK-side `allow` + empty answers, never a real
    // rejection). A pending permission is left alone; the strip's hint
    // (batch 3) explains why nothing sent yet.
    const resolution = decidePendingResolution({
      status: activeSession?.status ?? 'idle',
      hasPendingQuestionHere: pendingQuestionHere,
      hasPendingPermissionHere: pendingPermissionHere,
    });
    if (resolution.cancelQuestion) {
      // m8 fix: a failed cancel must be visible — otherwise the queue looks
      // permanently stuck with no explanation (status stays waiting_question,
      // so decideQueueRelease holds `not-idle` forever with no hint why).
      void respondQuestion({ cancel: true }).then((ok) => {
        if (!ok) {
          setQueueNotice('Could not dismiss the pending question — try answering it directly.');
        }
      });
    }
  };

  // T-07 @ 文件搜索：150ms 防抖，cwd 缺失或 mention 关闭时清空结果。
  useEffect(() => {
    if (mentionQuery === null || !cwd) {
      setMentionResults([]);
      setMentionTotal(0);
      return;
    }
    const timer = setTimeout(() => {
      window.electronAPI.search
        .files({ rootPath: cwd, query: mentionQuery, maxResults: MENTION_PAGE_SIZE })
        .then((page) => {
          setMentionResults(page.items);
          setMentionTotal(page.total);
        })
        .catch(() => {
          setMentionResults([]);
          setMentionTotal(0);
        });
    }, 150);
    return () => clearTimeout(timer);
  }, [mentionQuery, cwd]);

  const handleContentChange = (next: string) => {
    // F4 (round-4 Codex NEEDS-FIX #3): `updateValue` writes `valueRef`
    // synchronously, same tick as `setValue` — see the ref's own comment.
    updateValue(next);
    if (composingRef.current || !cwd) {
      setMentionQuery(null);
      return;
    }
    // setTimeout 读取 React 提交后的 selectionStart（与 EnhancedInput 同套路）。
    setTimeout(() => {
      const ta = textareaRef.current;
      if (!ta) {
        setMentionQuery(null);
        return;
      }
      setMentionQuery(extractMentionQuery(next, ta.selectionStart));
      setMentionIndex(0);
    }, 0);
  };

  const insertMention = (item: FileSearchResult) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const cursor = ta.selectionStart;
    const out = replaceMention(value, cursor, item);
    if (!out) return;
    updateValue(out.text);
    setMentionQuery(null);
    setMentionResults([]);
    setTimeout(() => {
      ta.focus();
      ta.setSelectionRange(out.cursor, out.cursor);
    }, 0);
  };

  // D4 (round-5): the ⊕ menu's "Attach files" entry. Replaces T-30b2 §4.6's
  // `handleAddFileContext`, which wrote an `@` at the caret because no
  // renderer-side file-read IPC existed yet; `file:readAttachment` closed that
  // gap, so this now attaches real bytes.
  //
  // Typing `@` by hand is untouched — `handleContentChange` still drives the
  // mention popup, and that is now the single way to add a file REFERENCE, as
  // opposed to a file.
  //
  // Cancelling the picker returns `[]` and this returns immediately: no
  // notice, no state change, nothing to undo (A06 honesty rule).
  const handleAttachFiles = () => {
    void (async () => {
      let paths: string[];
      try {
        paths = await window.electronAPI.dialog.openFiles();
      } catch {
        // The platform could not open a picker. Nothing was chosen, so there
        // is nothing to ingest and nothing about the draft to undo — the same
        // end state as a cancel, reached without an unhandled rejection.
        return;
      }
      if (paths.length === 0) return;
      await attachments.ingestPickedPaths(paths);
    })();
  };

  // A2 (round-4 point-check fix, retry-doublesend diagnosis): the previous
  // "no local `retryable`, but `activeSession?.status === 'failed'`" bootstrap
  // used to derive Retry's text from `lastUserPrompt` — the timeline's own
  // LAST user message. That is structurally guaranteed to duplicate: a
  // message only ever appears in the timeline once the Host has already
  // admitted it (the same `sawUserEcho` evidence `decideRunEntryOutcome`
  // treats as "never resend" everywhere else), so this path resent exactly
  // the text the Host had already accepted. Worse, it was immune to
  // `handleRetry`'s own `setRetryable(null)`: as long as `status` stayed
  // `'failed'`, the Retry button reappeared and stayed clickable on the very
  // next render, able to re-arm itself after a Retry that had just fired.
  // Retry is now offered ONLY off this component's own `retryable` snapshot
  // — a session reopened already-`failed` with no local snapshot gets the
  // error banner and Send, never an auto-derived one-click resend.
  const retryText = retryable?.text;
  const lastTurnFailed = retryable !== null;
  // m11 fix: no live-list fallback here. `retryable.drafts` is a snapshot
  // taken at failure time (decision 2.2) — falling back to the CURRENT
  // `attachments.drafts` meant a text-only status-'failed' reopen could
  // silently attach whatever the user has pasted since, and commit-time
  // consumption would make that chip vanish the instant Retry fired. The
  // reopened-failed fallback stays text-only; there is no reliable snapshot
  // to recover attachments from in that case anyway.
  const retryDrafts = retryable?.drafts ?? [];
  const retryAttachmentCount = retryDrafts.length;
  // T-19 decision 2.2: the Retry button's title carries the attachment count
  // that commit-time consumption made invisible in the draft area.
  const retryTitle =
    retryAttachmentCount > 0
      ? `Retry last message (${retryAttachmentCount} file${retryAttachmentCount > 1 ? 's' : ''})`
      : undefined;
  const canRetry =
    lastTurnFailed &&
    (Boolean(retryText) || retryDrafts.length > 0) &&
    // F3 (round-4 Codex NEEDS-FIX #2): aligned with `canSend`'s target
    // resolution — `cwd` explicitly checked, not just `activeWorkspace`
    // (a workspace can be "present" but not targetable, e.g. the demo
    // placeholder's empty path). `runSend`'s own guard already covers this
    // (its `!cwd` early-guard now safely preserves the snapshot instead of
    // losing it — see `handleRetry` below), so this is defense in depth,
    // not a correctness requirement: it just keeps a doomed-to-no-op Retry
    // click from ever rendering as clickable in the first place.
    Boolean(activeSessionId && activeWorkspace && cwd) &&
    !busy &&
    !sending &&
    attachments.reading === 0;
  const handleRetry = async () => {
    if (!canRetry) return;
    // F3 (round-4 Codex NEEDS-FIX #2): do NOT clear `retryable` before
    // calling `runSend`. `runSend` has two early guard-fail branches
    // (`!canSend`/`inFlightRef.current` — e.g. a race where `canSend` flips
    // false between this render's `canRetry` check and the actual click)
    // that return `'skipped'` BEFORE `finalizeOutcome` (and the `committed`
    // snapshot it closes over) are even constructed — clearing here first
    // left NOTHING able to restore the payload on that path, silently
    // losing it. `text`/`retryDrafts` below are captured from THIS render's
    // `retryable` regardless of when (or whether) the state gets cleared,
    // so nothing about what gets sent changes — only whether a
    // guard-fail can destroy the snapshot with nothing sent at all.
    const text = retryText ?? '';
    // R3 fix: Retry deliberately uses the SAME uniform "capture before
    // runSend" pattern as the direct/release call sites, not a special case
    // that always skips naming. The timeline only ever gains a user entry
    // via the Host's own confirmed echo (`message.started{role:'user'}` —
    // there is no local/optimistic add, see `sessionHasUserMessage`'s
    // header), so this is exactly right for both retry shapes:
    //  - the failed attempt WAS admitted (Host echoed it, then the turn
    //    failed mid-stream): that echo is already in the timeline, so this
    //    reads true and naming is correctly skipped (same as any ordinary
    //    follow-up);
    //  - the failed attempt was NEVER admitted (no echo at all — a
    //    'rejected'/timeout-with-zero-progress outcome): the timeline has
    //    no entry for it, so this reads false, and if THIS retry succeeds,
    //    its echo is genuinely the session's first user message — naming
    //    must apply.
    // No special-casing is needed because "hadUserMessage" already means
    // exactly the right thing in both cases.
    const hadUserMessage = activeSessionId
      ? sessionHasUserMessage(useChatSessionsStore.getState().messages[activeSessionId] ?? [])
      : false;
    const outcome = await runSend(text, retryDrafts, { origin: 'retry' });
    // F3: result-level clear — only a genuine 'committed' result means this
    // attempt's payload was actually delivered (`runSend`'s own internal
    // commit-point/success-path already clears it too; this is the explicit,
    // testable statement of the SAME rule at the call site). 'skipped' keeps
    // the original snapshot (nothing else would); 'rejected' already gets
    // its OWN re-arm from `finalizeOutcome`'s `decideFailureAffordance` —
    // writing it again here would just be a redundant second `setRetryable`
    // with the identical value, not a fix.
    if (shouldClearRetryableOnOutcome(outcome)) {
      setRetryable(null);
    }
    if (activeSessionId) {
      maybeApplyFirstMessageTitle(activeSessionId, text, outcome, hadUserMessage);
    }
  };

  // S3 (round-2 iteration-3 review, documentation only): the wiring below —
  // origin passing, `finalizeOutcome` gating, and the queue-pause call — is
  // structurally untestable under this project's node-env vitest config
  // (vitest.config.ts: `environment: 'node'`, `include` only `*.test.ts`; no
  // `.tsx` component ever renders under the suite). The following invariants
  // are therefore INSPECTION-VERIFIED, not unit-tested, and must be kept true
  // by inspection on every future edit to this function:
  //   1. All three call sites state `origin` explicitly: `handleSend` passes
  //      `'direct'`, `handleRetry` (above) passes `'retry'`, and
  //      `useQueueRelease`'s `runEntry` (below) passes `'release'` — the type
  //      has no default, so a fourth call site cannot silently inherit the
  //      wrong one.
  //   2. F6(iii) (round-4 Codex NEEDS-FIX #5, rewriting the stale claim this
  //      point used to make): every non-success `return` funnels through
  //      `finalizeOutcome(...)` — never `setRetryable`/`pauseSession`/
  //      `restoreDraftIfComposerEmpty` directly — EXCEPT the two early
  //      guard-fail `return 'skipped'`s right after this function starts
  //      (`!canSend`/`inFlightRef.current`), which return before `committed`/
  //      `finalizeOutcome` even exist and correctly do NOTHING (F3 fix:
  //      `handleRetry` no longer pre-clears `retryable`, so there is nothing
  //      to restore on that path either). `decideFailureAffordance`
  //      (queueRelease.ts, unit-tested) is the ONLY authority for whether a
  //      `finalizeOutcome`-routed outcome arms Retry or restores the draft;
  //      `shouldPauseQueueOnRejection` is the ONLY authority for the queue
  //      pause. A1 fix: these two are DELIBERATELY no longer complements of
  //      each other (`decideFailureAffordance('committed', …)` is
  //      `'restore-draft'`, not `'none'`, while `shouldPauseQueueOnRejection`
  //      stays `false` for `'committed'`) — see `shouldPauseQueueOnRejection`'s
  //      own header in queueRelease.ts for why.
  //   3. The success path (`return 'committed'` after the admission check)
  //      is a deliberate bypass of `finalizeOutcome` — it clears `retryable`
  //      instead of arming it, and never pauses the queue. Stop-hang fix
  //      (2026-08-10): the Stop exit added just above it is the SECOND and
  //      only other bypass, and only for its `'committed'` half — a Stop the
  //      Host had already admitted ends exactly like a success (same clear,
  //      no Retry, no draft replay, no pause). Its `'rejected'` half — a Stop
  //      the Host never admitted — still goes through `finalizeOutcome`, so
  //      the queue entry is restored and the payload recovered by the usual
  //      authorities. No third bypass may be added without the same
  //      justification.
  const runSend = async (
    trimmed: string,
    drafts: readonly AttachmentDraft[],
    // R1 (round-2 iteration-2 review): every call site now states its
    // origin explicitly — no default — so a future fourth call site cannot
    // silently inherit the wrong rejected-outcome ownership semantics (see
    // `shouldArmRetryable` in queueRelease.ts).
    options: { clearComposerValue?: boolean; origin: RunSendOrigin }
  ): Promise<RunEntryOutcome> => {
    const { origin } = options;
    // Explicit `cwd` check (independent of canSend): a null cwd is the demo
    // placeholder or a target with no path — creating a session against it
    // would persist a fake cwd into session-index.json and die in spawn on
    // the Host side.
    if (!canSend || !activeSessionId || !cwd) {
      return 'skipped';
    }
    if (inFlightRef.current) return 'skipped';
    // D48 S1 (A12): the Host has told us which agents it can run — refuse a
    // turn bound to one that is not on that list instead of letting the create
    // come back `agent_unsupported` after the draft is already consumed and
    // the picker already locked. `undefined` (a Host build that predates the
    // capability) deliberately does NOT trigger this; `isSendableAgent` owns
    // that distinction and is truth-tabled next door.
    //
    // Placed with the other guard-fail returns, i.e. BEFORE `inFlightRef` is
    // claimed and before `onSendStart?.()`: returning after either would wedge
    // the composer shut for the run, or lock the binding for a turn that never
    // went out.
    const knownAgents = hostStatus.capabilities?.agents;
    const agentAtEntry = sessionAgent(
      useChatSessionsStore.getState().sessions.find((item) => item.id === activeSessionId) ?? {}
    );
    if (!isSendableAgent(knownAgents, agentAtEntry)) {
      useChatSessionsStore.setState({ lastError: AGENT_UNAVAILABLE_SEND_ERROR });
      return 'skipped';
    }
    inFlightRef.current = true;
    inFlightSessionIdRef.current = activeSessionId;
    // F6: this attempt's cancellation token — handleStop bumps the shared
    // ref synchronously; the busy-retry loop below compares against its own
    // snapshot to notice.
    sendGenerationRef.current += 1;
    const myGeneration = sendGenerationRef.current;

    const sessionId = activeSessionId;
    const workspacePath = cwd;
    // D48 S2: `agentAtEntry` is the binding this turn was admitted under (read
    // off the store snapshot the guard above already took), and both selections
    // are keyed by it — which catalog a model id came from is not a detail the
    // wire can recover, so resolving against the wrong agent would send a Claude
    // id to Codex and be refused in Main (B18).
    const turnAgent = agentAtEntry;
    // R11, D48 S2 form: an explicit per-(session, agent) choice, else this
    // agent's template, else NOTHING — `undefined` means `Automatic`, i.e. the
    // key leaves the payload and the runtime's own default serves the turn
    // (B11). The pre-D48 `?? defaultModelId(null)` tail hard-pinned `sonnet`
    // onto every session the user never touched.
    const model = resolveResumeModel(
      getSessionModel,
      sessionId,
      turnAgent,
      agentDefaultModel(chatAgentDefaults, turnAgent)
    );
    // T-20: undefined when the user left it on "Default", so the key is dropped
    // from the payload entirely and the model default applies (≠ pinning high).
    const effort = toWireEffort(
      resolveEffortSelection(
        getSessionEffort(sessionId, turnAgent),
        agentDefaultEffort(chatAgentDefaults, turnAgent)
      )
    );
    // D48 S3 §5.5 — the permission template, resolved at the SAME commit point
    // as the model and effort above, keyed by the SAME `turnAgent`, and for the
    // same reason: which agent a posture belongs to is not something the wire
    // can recover afterwards. `undefined` (no template, or settings not yet
    // hydrated) drops the key entirely, so the runtime's own safe constant
    // applies — byte for byte the pre-D48 path.
    //
    // Only the create payload carries it. A resume takes its posture from the
    // session snapshot, which Main reads off the index row; this side does not
    // get to re-supply a template for a chat that already started (C9).
    const permissionPreference = resolveDraftPermissionPreference({
      defaults: chatAgentDefaults,
      agent: turnAgent,
      settingsHydrated,
      // What the user picked for THIS chat while it was still a draft. Outranks
      // the template — "open this one under bypass" must not mean "change what
      // every future chat opens under".
      draft: readDraftPermission(sessionId, turnAgent) ?? undefined,
    });
    const wireAttachments = toWireAttachments(drafts);
    // F2 (2026-08-18): `sendTimeoutMs(attachmentBytes)` is gone. The wait is no
    // longer a fixed deadline predicted from the payload size — it is a
    // silence budget that ANY liveness frame for this session resets, so
    // attachment bytes have identically zero effect on it. Opened here, at
    // dispatch time, so the absolute loop bound covers the handshake too.
    const budget = createSendWaitBudget(Date.now());
    // F2 §4.5: when the wait this send is about to open began, so a
    // `'pending'` turn head can recompute its own seconds without a second
    // ticker. Re-stamped at dispatch (below) so it names the AWAITING phase,
    // the one the user is actually watching, rather than the handshake.
    let turnStartedAtMs = Date.now();

    // 2026-07-28 continuity fix: decide, off a store snapshot and BEFORE any
    // IPC, whether the Host registry entry is still alive (direct send — no
    // close/create round-trip needed), gone but resumable (we still know its
    // runtimeIdentity), or genuinely new (create). Closing and recreating the
    // Host session on every send used to wipe the resume identity each turn,
    // silently starting a brand-new conversation every time.
    const preState = useChatSessionsStore.getState();
    const hostBound = preState.hostBoundSessionIds.includes(sessionId);
    const preSession = preState.sessions.find((session) => session.id === sessionId);
    const knownIdentity = preSession?.runtimeIdentity ?? null;
    // S2 (b): read off the same pre-IPC snapshot as the identity above — the
    // two travel together (a resume handle only means something paired with
    // the agent that issued it) and must describe the same instant.
    const agent = sessionAgent(preSession ?? {});
    const preamble = decideSendPreamble({ hostBound, runtimeIdentity: knownIdentity });

    // Starting a fresh send invalidates any prior failure's retryable prompt:
    // the new prompt is what the user wants now, and a stale ghost Retry would
    // linger if the prior failed stream happened to settle later (see the
    // "Retry 重影" bug — flow aborted without result, `retryable` stayed, a
    // late assistant bubble appeared, Retry showed next to Send wrongly).
    setRetryable(null);
    // S5 (round-2 iteration-3 review): same commit point — a stale marker
    // from a PRIOR abandoned turn must not survive into this new attempt.
    // Without this, a marker armed for turn A could still be sitting there
    // when turn B (a Retry, or an unrelated later send) commits, and the
    // clearing effect's later "does this match the marker" identity check
    // (see below) had nothing to anchor to except A's own committed object —
    // which `handleRetry` deliberately replays, making a fresh B's outcome
    // look identical to A's by value.
    //
    // F2: the store slot goes with it. A new turn on this session makes the
    // previous turn's head moot — whatever the Host is still doing with it, the
    // head the user is now watching belongs to THIS send.
    pendingReplyRef.current = null;
    clearPendingReply(sessionId);
    // A skip warning belongs to the paste that produced it, not to the next
    // turn. Sending is one of the three clear triggers (next attach / Send / x).
    dismissAttachmentNotice();
    useChatSessionsStore.setState({ lastError: null });

    // T-28: all guards have passed and the send is committed — this is what
    // flips the middle column to the docked session state the same frame,
    // instead of waiting for the first echoed message (handleRetry reuses
    // runSend, so a retry re-docks too, which is correct: the column must
    // not bounce back to centered on a failed first send).
    onSendStart?.(origin);

    // T-19 commit point (design decision 2.2): every guard above has passed —
    // this is the point of no return, still synchronous and still before the
    // first `await` below. Consume this turn's draft right here, not on
    // completion: once the composer unlocks while a turn runs, text typed for
    // the NEXT turn must never be wiped by THIS turn's "clear when done".
    // `clearComposerValue` is only set by the live handleSend path — a
    // queued entry being released here carries someone else's snapshot, not
    // whatever the user is typing right now, so it must never touch `value`.
    if (options.clearComposerValue) updateValue('');
    // Safe no-op when `drafts` is a retry/queue snapshot whose ids already
    // left the live list at THEIR OWN commit point.
    attachments.removeDrafts(drafts.map((draft) => draft.id));
    // Decision 3.4: any new turn starting — direct send or a queued entry
    // being released — means the user pushed the flow forward again, so this
    // session's Stop-pause (if any) no longer applies. Release already
    // implies "not paused" (decideQueueRelease holds on `paused`), so this is
    // a no-op for that path and only matters for a plain direct send.
    //
    // A4 (round-4 point-check fix): Retry is explicitly EXCLUDED
    // (`shouldClearPauseOnSend`) — a `'send-rejected'` pause is the queue
    // layer's OWN protection against re-releasing a head entry the Host just
    // refused, and Retry (a component-local snapshot with no queue entry
    // involved) must not be able to clear it out from under the queue: doing
    // so let the queue's next, DIFFERENT-text entry auto-release the instant
    // this Retry's turn settled back to idle.
    if (shouldClearPauseOnSend(origin)) {
      useMessageQueueStore.getState().clearPause(sessionId);
    }
    const committed = { text: trimmed, drafts };
    let pendingAttemptId: string | null = null;
    // R1 (round-2 iteration-2 review): the single place every non-success
    // return below now funnels through — `decideFailureAffordance` is the
    // ONLY place that decides whether this outcome arms the round Retry
    // button or restores the draft, so no individual branch can
    // independently (and inconsistently) get the origin-ownership call
    // wrong.
    //
    // S1 (round-2 iteration-3 review): this is now ALSO the single pause
    // authority — `shouldPauseQueueOnRejection` (A1 fix: no longer the
    // literal complement of the affordance decision, see its own header) —
    // so every non-success outcome gets exactly one of {resend armed,
    // draft restored, queue paused, none}. Living here (not at one specific
    // call site) means EVERY branch that returns through `finalizeOutcome` —
    // create/resume timeouts, the `ensureHost()` catch, a non-busy
    // pre-admission `host.error`, the busy-retry loop exhausting — gets the
    // same treatment, closing the restore→re-release livelock for every
    // handshake-failure class, not just `session_busy` exhaustion (see
    // `shouldPauseQueueOnRejection`'s header in queueRelease.ts).
    const finalizeOutcome = (outcome: RunEntryOutcome): RunEntryOutcome => {
      if (outcome === 'rejected' && pendingAttemptId) {
        usePendingUserMessagesStore.getState().clear(pendingAttemptId);
      }
      const affordance = decideFailureAffordance(outcome, origin);
      if (affordance === 'resend') {
        setRetryable(committed);
      } else if (affordance === 'restore-draft') {
        // F2 §5.3: the lifted, provenance-writing version (see its definition
        // above) — the same one the confirmed-death listener uses, so both
        // automatic restores are revocable by exactly the same rule.
        restoreDraftIfComposerEmpty(sessionId, committed);
      }
      if (shouldPauseQueueOnRejection(outcome, origin)) {
        useMessageQueueStore.getState().pauseSession(sessionId, 'send-rejected');
      }
      return outcome;
    };

    setSending(true);
    // T-31 §3: publish this turn's status for the turn head. Attachment count
    // and bytes are taken from `committed`-to-be `drafts`, NOT from the live
    // composer state the old status line read: the drafts were removed from
    // that list a few lines above (the T-19 commit point), so the live values
    // are already zero here and would describe whatever the user attaches NEXT
    // rather than what this turn actually sent.
    // Nothing has been transmitted yet: ensureHost / closeSession /
    // createSession still have to run, and that can take seconds — hence
    // `handshake`, which keeps "Sent 152 KB" off the screen until it is true.
    //
    // F3: `begin` hands back this send's ownership token. Every later write to
    // the slot — the ticker, the phase switch, the `finally`, the unmount
    // cleanup — presents it, and the store drops the write if the slot has
    // since been claimed by another send. Without it, a `ChatComposer` that
    // unmounts mid-send leaves a live ticker and a live `finally` able to
    // overwrite or blank the NEXT instance's in-flight snapshot.
    //
    // Final review (F2/F4 residue): the baseline is the last message id in this
    // session's bucket RIGHT NOW — read here, before `chat.send`, so before the
    // Host can echo this turn's user message back. It is what later tells a
    // turn this send opened from a restored (or previously abandoned) turn that
    // merely has the same user-with-no-reply shape. Read-only snapshot off the
    // red-line store; nothing in `chatSessions.ts` changes.
    const bucketAtCommit = useChatSessionsStore.getState().messages[sessionId] ?? [];
    const baselineMessageId =
      bucketAtCommit.length > 0 ? bucketAtCommit[bucketAtCommit.length - 1].id : null;
    const sendOwner = beginTurnSend(
      {
        sessionId,
        phase: 'handshake',
        elapsedSeconds: 0,
        budgetMs: SEND_SILENCE_CEILING_MS,
        attachmentCount: drafts.length,
        attachmentBytes: totalAttachmentBytes(drafts),
        // F456 §7.4: CODE POINTS, not `.length`. UTF-16 units would report an
        // emoji as two characters, and this number answers "how much did I
        // type" — not `CHAT_HIGHLIGHT_MAX_CHARS`'s question, which is about
        // tokeniser cost and deliberately counts units.
        //
        // Read off `committed`, exactly like the two fields above and for the
        // reason spelled out there: the textarea is not cleared until the send
        // resolves, so a live read would show this turn a count belonging to
        // the next message the user has already started typing.
        promptChars: [...committed.text].length,
      },
      baselineMessageId
    );
    pendingAttemptId = `${sessionId}:${sendOwner}`;
    usePendingUserMessagesStore.getState().publish({
      attemptId: pendingAttemptId,
      sessionId,
      text: committed.text,
      attachments: drafts.map((draft) => ({
        kind: draft.kind,
        mediaType: draft.mediaType,
        ...(draft.name ? { name: draft.name } : {}),
      })),
      startedAt: Date.now(),
    });
    sendOwnerRef.current = sendOwner;
    phaseStartedAtRef.current = Date.now();
    const ticker = window.setInterval(() => {
      updateTurnSend(sendOwner, {
        elapsedSeconds: Math.floor((Date.now() - phaseStartedAtRef.current) / 1000),
      });
    }, 1000);
    // Rev.2 (partial-messages build spec §2): a collapsing ring, not a flat
    // array — under partial-message traffic a flat cap would fill with
    // `message.delta ×N` and destroy the EARLIEST evidence the
    // create-timeout diagnostic below needs. See eventRing.ts for the
    // head-window + tail-cap + fold rules.
    const seenEvents = createEventRing();
    const assistantMessageIds = new Set<string>();
    let sawSessionCreated = false;
    let sawSessionResumed = false;
    let sawAssistantProgress = false;
    // Stop-hang fix (2026-08-10): this ATTEMPT's own TERMINAL wire events
    // (see the listener below for the `sawUserEcho` scoping that makes them
    // this attempt's and not merely this session's). Both are invisible to
    // everything the wait below used to watch, because `chatSessions.ts`
    // reduces `session.stopped` AND `session.completed` to the same `'idle'`
    // status — so a Stop (and a completion that produced no assistant blocks)
    // satisfied no release condition at all and the wait sat on its 50ms poll
    // until the 45s budget expired. Read off the wire, via the same
    // unit-tested predicates the abandon-marker effect uses; the store is not
    // an option here even setting the collapse aside, since it applies events
    // on a batched 16ms flush (`initRuntime`) that a Stop must not wait on.
    let sawSessionStopped = false;
    let sawSessionCompleted = false;
    // F4: the user's own echoed message (only EventNormalizer.beginTurn
    // emits it, past claudeRuntime.send's busy-gate) — the actual proof this
    // turn's text was admitted. classifyAssistantProgress deliberately
    // ignores it (it is not assistant progress), so it needs its own flag.
    let sawUserEcho = false;
    // F12: structured retry evidence — only ever set from the ONE field that
    // actually means "the CLI is mid transport-retry" (session.status's
    // `retry` payload), never by sniffing formatted event strings for the
    // substring "retry" (which the watchdogs' own failure copy also
    // contains — see the removed `seenEvents.some(...includes('retry'))`).
    let sawNetworkRetry = false;
    let fatalHostError: string | null = null;
    let fatalHostErrorCode: string | null = null;
    // F3: requestId of the IPC call THIS attempt is currently waiting on —
    // lets the listener correlate a session-less host.error (send()'s
    // session_not_found, deliberately emitted before the Host knows which
    // session) to THIS attempt instead of any other in-flight request.
    let currentRequestId: string | null = null;
    // F2 (round-4 Codex NEEDS-FIX #1): single-slot stash for a host.error
    // that arrived while `currentRequestId` was still null (the narrow
    // window between an IPC call firing and its own requestId resolving —
    // e.g. `chat.send()`'s IMMEDIATE failure can race the promise that
    // reports its requestId back). Strict matching can't be evaluated yet
    // without a known target requestId, and falling back to a loose
    // sessionId-only accept would reopen the exact cross-request hole
    // `strict` exists to close — so it waits here instead, and is
    // re-evaluated the instant `setCurrentRequestId` below learns the real
    // requestId (must happen in that SAME tick, not lazily, or a
    // fast-arriving failure for THIS OWN send would be silently dropped).
    //
    // F2b (round-4 Codex re-review, second pass): a bounded LIST, not a
    // single slot — `setCurrentRequestId(null)` now runs before EVERY new
    // create/resume/send dispatch (below), which reopens this "unknown"
    // window on EACH one, not just the very first. More than one
    // session-scoped host.error can legitimately land in that window (a
    // genuine fast failure for the JUST-dispatched request, AND/OR a late
    // straggler from an EARLIER request still winding down) — a single slot
    // let the second one silently evict the first with no re-evaluation.
    let pendingHostErrors: readonly RuntimeEvent[] = [];

    const applyHostError = (event: RuntimeEvent) => {
      const message =
        event.payload && typeof event.payload === 'object' && 'message' in event.payload
          ? String((event.payload as { message?: string }).message ?? 'host.error')
          : 'host.error';
      const code =
        event.payload && typeof event.payload === 'object' && 'code' in event.payload
          ? String((event.payload as { code?: string }).code ?? '')
          : '';
      fatalHostErrorCode = code || null;
      fatalHostError = code ? `${code}: ${message}` : message;
      useChatSessionsStore.setState({ lastError: fatalHostError });
    };

    // F2/F2b: the ONLY place `currentRequestId` may be assigned (every IPC
    // call site below routes through this instead of a raw assignment) — so
    // neither the stash re-evaluation NOR the F2b pre-dispatch reset (see the
    // call sites below) can ever be forgotten at a future call site.
    const setCurrentRequestId = (requestId: string | null) => {
      currentRequestId = requestId;
      if (requestId != null) {
        const match = resolvePendingHostError(pendingHostErrors, { sessionId, requestId });
        if (match) applyHostError(match);
      }
      pendingHostErrors = [];
    };

    const unsubEvents = subscribeRuntimeEvent((event) => {
      seenEvents.push(formatRuntimeEvent(event));

      if (event.type === 'session.created' && event.sessionId === sessionId) {
        sawSessionCreated = true;
      }

      if (event.type === 'session.resumed' && event.sessionId === sessionId) {
        sawSessionResumed = true;
      }

      if (event.sessionId === sessionId) {
        // R15: pulled out to a pure, unit-tested helper (assistantProgress.ts)
        // instead of the inline field-poke this used to be.
        if (isUserEchoForSend(event, sessionId)) {
          sawUserEcho = true;
        }
        if (classifyAssistantProgress(event, assistantMessageIds) === 'assistant') {
          sawAssistantProgress = true;
        }
        // F2 (2026-08-18): deliberately a SECOND, wider classifier standing
        // next to the first — liveness is NOT progress. It resets the silence
        // budget and nothing else: it never arms Retry, and it is never
        // admission evidence.
        if (classifyTurnLiveness(event, sessionId) === 'liveness') {
          budget.markLiveness(Date.now());
        }
        if (
          event.type === 'session.status' &&
          event.payload &&
          typeof event.payload === 'object' &&
          (event.payload as { retry?: unknown }).retry != null
        ) {
          sawNetworkRetry = true;
        }
      }

      // F3: scope to THIS send attempt — a background session's host.error
      // (e.g. a DIFFERENT session's resume hitting session_busy) must never
      // poison this attempt's fatalHostError.
      //
      // A3/F2/F2b (round-4 point-check + NEEDS-FIX #1 + re-review): `currentRequestId`
      // known -> strict match decides immediately, same as before.
      // `currentRequestId` NOT known yet (either genuinely not-yet-known, or
      // deliberately reset to `null` by F2b right before each new
      // create/resume/send dispatch) -> never accept on a loose
      // sessionId-only guess (that reopens the cross-request hole strict
      // mode exists to close); stash it in the bounded candidate list for
      // `setCurrentRequestId` to resolve the instant a requestId is known.
      if (event.type === 'host.error') {
        if (currentRequestId != null) {
          if (
            isHostErrorForSend(event, { sessionId, requestId: currentRequestId }, { strict: true })
          ) {
            applyHostError(event);
          }
        } else if (isHostErrorForSend(event, { sessionId, requestId: currentRequestId })) {
          pendingHostErrors = pushPendingHostError(pendingHostErrors, event);
        }
      }

      // R3 (round-2 iteration-2 review): fold a `session.failed` for THIS
      // session into `fatalHostError` directly off the wire event, instead
      // of `sendAndWait`/`waitUntil` reading the process-global
      // `useChatSessionsStore.lastError` — `chatSessions.ts`'s own
      // `session.failed` case sets that field for ANY session, so a
      // background session's failure used to be able to short-circuit (and
      // misclassify) THIS attempt's wait.
      if (isSessionFailedForSend(event, sessionId)) {
        fatalHostErrorCode = null;
        fatalHostError = readSessionFailedError(event.payload);
      }

      // Stop-hang fix (2026-08-10): deliberately NOT folded into
      // `fatalHostError` — neither event is an error, and both must end this
      // attempt's wait as a clean terminal (see the Stop exit below).
      //
      // `sawUserEcho` scopes them to THIS ATTEMPT and not merely to this
      // session. The Host only emits a terminal for a turn it has already
      // begun, and the echo is the proof that the begun turn is ours. Without
      // the gate, a terminal still in flight from the PREVIOUS turn would end
      // this wait before our own send had echoed — reachable now that a Stop
      // returns `runSend` immediately instead of at 45s, because the next
      // send can start while the Host is still tearing the stopped turn down
      // (`'stopping'` is not a busy status — see `isRunningStatus`) — and the
      // Stop exit would then classify a turn the Host had JUST admitted as
      // never-admitted, bouncing the user's text back with a Retry that
      // double-sends. A Stop landing before our echo is covered by the
      // generation check instead: `handleStop` bumps it synchronously, ahead
      // of its own IPC.
      if (sawUserEcho) {
        if (isSessionStoppedForSend(event, sessionId)) {
          sawSessionStopped = true;
        }
        if (isSessionCompletedForSend(event, sessionId)) {
          sawSessionCompleted = true;
        }
      }
    });

    // A broken binding must not be retried as-is next send: the following
    // send should go through 'resume' (if the runtimeIdentity is still known)
    // or 'create' fresh, never silently reuse a registry entry the Host
    // already dropped.
    const unbindHost = () => {
      useChatSessionsStore.setState((state) => ({
        hostBoundSessionIds: state.hostBoundSessionIds.filter((id) => id !== sessionId),
      }));
    };

    const setCreateTimeoutError = () => {
      useChatSessionsStore.setState({
        lastError: [
          'Timed out waiting for session.created after createSession.',
          `rawEvents=[${formatSeenEvents(seenEvents)}]`,
          `sessionId=${sessionId}`,
        ].join(' | '),
      });
    };

    /** close → sleep(120) → create → wait for session.created. */
    const runCreateSequence = async (): Promise<'ok' | 'fatal' | 'timeout'> => {
      // Drop Host registry entry so createSession is not "Session already exists".
      await window.electronAPI.chat.closeSession({ sessionId }).catch(() => undefined);
      await sleep(120);

      sawSessionCreated = false;
      // F2b (round-4 Codex re-review): reset BEFORE dispatch, not just after
      // the response resolves — without this, `currentRequestId` still held
      // whatever the PREVIOUS IPC call's requestId was for this entire
      // in-flight window, so a host.error that arrives for THIS createSession
      // call before its own response resolves would strict-match against the
      // stale old requestId, fail to match, and be silently DISCARDED
      // (rather than stashed) — the exact "own immediate failure gets
      // swallowed, hangs to timeout" bug this fix closes. The stash path
      // (see the listener above) naturally takes over this window.
      setCurrentRequestId(null);
      const createResult = await window.electronAPI.chat.createSession({
        sessionId,
        workspacePath,
        // B11: `Automatic` omits the key entirely rather than sending an
        // `undefined` value — `model: undefined` still serialises as a present
        // key on some paths, and "no model" has to be indistinguishable from
        // "field not supported" for the runtime default to apply.
        ...(model ? { model } : {}),
        agent,
        ...(effort ? { effort } : {}),
        // Same B11 rule as `model`: absent, never an `undefined` value — "no
        // template" has to be indistinguishable from "field not supported".
        ...(permissionPreference ? { permissionPreference } : {}),
      });
      setCurrentRequestId(createResult?.requestId ?? null);

      const created = await waitUntil(
        () => sawSessionCreated || Boolean(fatalHostError),
        deadlineAt(5000)
      );
      if (fatalHostError) return 'fatal';
      if (!created) return 'timeout';

      useChatSessionsStore.setState((state) => ({
        hostBoundSessionIds: state.hostBoundSessionIds.includes(sessionId)
          ? state.hostBoundSessionIds
          : [...state.hostBoundSessionIds, sessionId],
        lastError: null,
      }));
      // The draft intent has done its job: it is in the create payload, and from
      // here the session's own snapshot is the posture. Dropping it means a
      // later mid-session change can never be outranked by what someone picked
      // before the chat existed — the silent-privilege swap R18 names — and it
      // keeps the map from growing a row per chat forever.
      clearDraftPermission(sessionId);
      return 'ok';
    };

    /** Send the turn, then wait for assistant / tool / permission / terminal progress. */
    const sendAndWait = async (): Promise<WaitResult> => {
      // Stop-hang fix (2026-08-10), companion to the cancellation check in
      // the wait below: never DISPATCH a turn the user has already cancelled.
      // Stop is live from the moment `setSending(true)` runs — the whole
      // ensureHost + close/create/resume handshake ahead of this point can
      // take seconds — so a cancellation can land before this send ever goes
      // out. Without this guard the Host would be handed a turn nobody wants
      // anymore, AND the wait below would release on the generation check
      // before the echo arrived, classifying that just-dispatched turn as
      // never-admitted and arming a Retry that double-sends it. Returning
      // early keeps `sawUserEcho` honestly false with nothing sent: the Stop
      // exit reports `'rejected'`, so a queued entry goes back on the queue
      // and a direct send gets its payload back. Covers all three call sites
      // (first send, busy-retry resend, `session_not_found` fallback resend)
      // by living here rather than at any one of them.
      if (sendGenerationRef.current !== myGeneration) return 'cancelled';
      // Round-6 verify major: the store fallback in the wait below may only
      // accept a reply THIS send produced. Captured before dispatch — an
      // absolute "any runtime assistant exists" check is satisfied by the
      // previous turn's reply the instant a second send starts, releasing
      // the wait (and unsubscribing this send's listeners) with zero
      // evidence.
      const assistantBaseline = collectAssistantMessageIds(
        useChatSessionsStore.getState().messages[sessionId] ?? []
      );
      // F2b (round-4 Codex re-review): reset BEFORE dispatch — covers the
      // FIRST send AND every busy-retry resend (`sendAndWait` is called
      // again from the busy loop below), since each is its own NEW IPC call
      // whose own requestId is not yet known at dispatch time. See
      // `runCreateSequence`'s identical reset for the full rationale.
      setCurrentRequestId(null);
      const sendResult = await window.electronAPI.chat.send({
        sessionId,
        text: trimmed,
        // Same B11 rule as the create payload above. On the Codex axis this key
        // is what D40's `turn/start` override rides on, and an override is
        // STICKY there [实测 06-probes P1] — so sending a model the user did
        // not pick would silently re-default the whole thread, not just a turn.
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        ...(wireAttachments ? { attachments: wireAttachments } : {}),
      });
      // F2: MUST happen synchronously right here — the instant this
      // attempt's own requestId is known — not lazily on next use, or a
      // fast-arriving `host.error` for THIS send (already stashed above)
      // would sit unresolved instead of being admitted immediately.
      setCurrentRequestId(sendResult?.requestId ?? null);
      // The payload is with the Host now, so the status line may say so — and
      // the displayed clock restarts, because this phase is the one the
      // silence budget actually watches.
      // T-19: `value`/attachments were already consumed at runSend's commit
      // point (decision 2.2) — no clearing here.
      phaseStartedAtRef.current = Date.now();
      turnStartedAtMs = phaseStartedAtRef.current;
      updateTurnSend(sendOwner, { elapsedSeconds: 0, phase: 'awaiting' });

      // Running alone is not success — wait for assistant / tool / permission / terminal.
      const released = await waitUntil(
        () => {
          // Stop-hang fix (2026-08-10), FIRST because a stopped turn can also
          // carry a stale `fatalHostError` from earlier in the same attempt
          // (e.g. a `session_busy` the busy loop already moved past) and must
          // still read as a Stop, not as a failure.
          //
          // The two flags are this turn's own terminal wire events; the store
          // collapses both into `'idle'`, which is not in the release set
          // below, so neither used to end this wait at all.
          if (sawSessionStopped || sawSessionCompleted) return true;
          // F6's cancellation token, now read by the MAIN wait and not just by
          // the `session_busy` backoff loop. This is the only release condition
          // that still works when the Host never answers the Stop (no
          // `session.stopped` will ever arrive) — the case that made the button
          // look dead for a full 45s. `myGeneration` is snapshotted AFTER
          // `runSend`'s own entry bump (asserted in composerStopStatic.test.ts),
          // so a fresh attempt never starts out looking cancelled. `handleStop`
          // is the only OTHER writer that can reach the ref while this attempt
          // runs (`inFlightRef` makes a second concurrent `runSend` — direct,
          // Retry or queue release — return `'skipped'` before it can bump);
          // if that latch ever goes away, "a newer attempt supersedes this one"
          // is the same intent and the same correct release.
          if (sendGenerationRef.current !== myGeneration) return true;
          if (fatalHostError) return true;
          if (sawAssistantProgress) return true;
          // R3 (round-2 iteration-2 review): no `state.lastError` read here —
          // that field is process-global (chatSessions.ts's `session.failed`
          // case sets it for ANY session), so a background session's failure
          // used to be able to short-circuit this wait. `fatalHostError`
          // above already carries THIS session's own `session.failed` (see
          // the listener's `isSessionFailedForSend` branch); `session?.status`
          // below stays scoped the same way.
          const state = useChatSessionsStore.getState();
          const session = state.sessions.find((item) => item.id === sessionId);
          if (session?.status === 'failed') return true;
          if (session?.status === 'waiting_permission' || session?.status === 'waiting_question') {
            return true;
          }
          // Round-6 review N1 + verify major: only an assistant id that did
          // not exist at dispatch time counts — `h:*` replay rows and the
          // previous turn's reply are both excluded by the baseline.
          return hasNewAssistantMessage(state.messages[sessionId] ?? [], assistantBaseline);
          // F2 (2026-08-18): expiry is now "this session has been SILENT for
          // SEND_SILENCE_CEILING_MS", not "N ms have passed since dispatch".
          // Reaching it is not a verdict about the turn — the Host owns that,
          // and its own stall watchdog fires first (see sendBudgets.ts).
        },
        () => budget.isExpired(Date.now())
      );

      // §4.2 layer one. Classified HERE, the instant the wait returns, so the
      // answer cannot drift: the flags below are written synchronously by the
      // listener, while anything read out of the store later is subject to
      // `chatSessions.ts`'s batched 16ms flush (throttled further in a
      // background window). Order mirrors the predicate's own: a stopped turn
      // may also carry a stale `fatalHostError` and must still read as a Stop.
      if (sawSessionStopped || sawSessionCompleted) return 'terminal';
      if (sendGenerationRef.current !== myGeneration) return 'cancelled';
      return released ? 'progress' : 'ceiling';
    };

    // T-19: every non-success path below now calls `setRetryable(committed)`
    // — previously only the catch block and the final "no progress" branch
    // set `retryable`, so the `runCreateSequence` timeout/fatal branches lost
    // the user's text with no way to recover it (design's named bug).
    // `committed` (built above, right after the drafts it carries were
    // consumed) is the single snapshot every one of these branches now
    // reaches for, so none of them can forget it.
    try {
      await window.electronAPI.chat.ensureHost();

      if (preamble.action === 'create') {
        const seq = await runCreateSequence();
        if (seq === 'fatal') {
          // R2: this turn provably never reached the Host — createSession
          // itself failed, `sendAndWait` was never called, `sawUserEcho`/
          // `sawAssistantProgress` are both trivially false. Classify
          // honestly instead of hardcoding 'committed'.
          unbindHost();
          return finalizeOutcome(
            decideRunEntryOutcome({ fatalHostError: true, sawAssistantProgress, sawUserEcho })
          );
        }
        if (seq === 'timeout') {
          unbindHost();
          setCreateTimeoutError();
          return finalizeOutcome(
            decideRunEntryOutcome({ fatalHostError: true, sawAssistantProgress, sawUserEcho })
          );
        }
      } else if (preamble.action === 'resume') {
        sawSessionResumed = false;
        // F2b (round-4 Codex re-review): reset BEFORE dispatch — same
        // rationale as `runCreateSequence`'s reset above.
        setCurrentRequestId(null);
        const resumeResult = await window.electronAPI.chat
          .resumeSession({
            sessionId,
            runtimeIdentity: preamble.runtimeIdentity,
            workspacePath,
            // B11, third dispatch site: same rule as create and send. A resume
            // that named `model: undefined` would pin the Host registry entry's
            // model to nothing EXPLICITLY, which is not what `Automatic` means —
            // it means the field never existed.
            ...(model ? { model } : {}),
            agent,
            ...(effort ? { effort } : {}),
          })
          .catch(() => undefined);
        setCurrentRequestId(resumeResult?.requestId ?? null);

        const resumed = await waitUntil(
          () => sawSessionResumed || Boolean(fatalHostError),
          deadlineAt(5000)
        );
        if (!resumed || fatalHostError) {
          // Resume failed or timed out (stale identity / Host hiccup / etc.)
          // — fall through ONCE to a fresh session rather than fail the turn.
          fatalHostError = null;
          fatalHostErrorCode = null;
          useChatSessionsStore.setState({ lastError: null });

          const seq = await runCreateSequence();
          if (seq === 'fatal') {
            // R2: resume->create fallback failed too — still nothing was
            // ever sent to the Host.
            unbindHost();
            return finalizeOutcome(
              decideRunEntryOutcome({ fatalHostError: true, sawAssistantProgress, sawUserEcho })
            );
          }
          if (seq === 'timeout') {
            unbindHost();
            setCreateTimeoutError();
            return finalizeOutcome(
              decideRunEntryOutcome({ fatalHostError: true, sawAssistantProgress, sawUserEcho })
            );
          }
        } else {
          useChatSessionsStore.setState((state) => ({
            hostBoundSessionIds: state.hostBoundSessionIds.includes(sessionId)
              ? state.hostBoundSessionIds
              : [...state.hostBoundSessionIds, sessionId],
            lastError: null,
          }));
        }
      }
      // 'direct': the Host registry entry is already alive — no close/create
      // round-trip, straight to send below.

      let waitResult = await sendAndWait();

      // Round-2 P0 fix (queue-loss): the Host's `session.running` admission
      // gate can outlive the renderer-visible `idle`/`completed` status by a
      // full stream-teardown (see claudeRuntime.ts's `for await` break above,
      // which shrinks but does not eliminate this window) — a queue-release
      // send that lands inside it gets flatly refused with `session_busy`.
      // Bounded retry (not a fallback to a fresh session, unlike
      // `session_not_found` below): the SAME turn just needs a moment for the
      // Host to finish tearing down the previous one.
      let busyRetry = 0;
      let cancelledDuringBusyBackoff = false;
      // A3 (round-4 point-check fix): `shouldRetryBusySend` adds the
      // `!sawUserEcho` gate on top of the existing code/attempt-count
      // checks — `sawUserEcho` turning true at any point means the Host has
      // already admitted this turn (past the busy gate), so a further
      // resend inside this SAME loop would double-send the identical text
      // without the user clicking anything.
      while (shouldRetryBusySend({ fatalHostErrorCode, sawUserEcho, attempts: busyRetry })) {
        busyRetry += 1;
        await sleep(250);
        // F1 (round-4 Codex NEEDS-FIX #1): a SECOND gate, re-checked right
        // after the sleep and BEFORE firing another `sendAndWait` — the
        // while-condition above is only re-evaluated at the TOP of the
        // NEXT iteration, which is AFTER a resend has already gone out.
        // An echo that lands asynchronously DURING this 250ms backoff (a
        // late admission signal for the very attempt that triggered this
        // wait) must stop the loop HERE, closing the residual "one click,
        // two sends" window the pre-sleep-only check left open.
        // `fatalHostErrorCode`/`attempts` are deliberately NOT reset until
        // after this check (see below) so it reuses the EXACT SAME
        // evidence the while-condition just used — only `sawUserEcho` can
        // have meaningfully changed while asleep. `attempts: busyRetry - 1`
        // matches the value the while-condition itself was just evaluated
        // with for this same iteration (pre-increment).
        if (!shouldRetryBusySend({ fatalHostErrorCode, sawUserEcho, attempts: busyRetry - 1 })) {
          break;
        }
        // F6: check cancellation after every sleep and before every resend —
        // Stop may have landed while this attempt was backing off.
        if (sendGenerationRef.current !== myGeneration) {
          cancelledDuringBusyBackoff = true;
          break;
        }
        fatalHostError = null;
        fatalHostErrorCode = null;
        useChatSessionsStore.setState({ lastError: null });
        waitResult = await sendAndWait();
      }

      if (cancelledDuringBusyBackoff) {
        // F6: the user explicitly cancelled while this attempt was backing
        // off between session_busy retries — the Host was never told to
        // start this queued message's turn (no echo, no progress by
        // definition of being stuck in the busy loop), so this is a clean
        // 'rejected'. R1: `finalizeOutcome` decides whether Retry gets armed
        // — a direct/Retry-origin cancellation still needs it (there is no
        // queue entry to fall back on); only 'release' relies on
        // `useQueueRelease` restoring the entry to the head handleStop
        // already paused.
        return finalizeOutcome(
          decideRunEntryOutcome({ fatalHostError: true, sawAssistantProgress, sawUserEcho })
        );
      }

      if (preamble.action === 'direct' && fatalHostErrorCode === 'session_not_found') {
        // The Host dropped the registry entry behind our back (Host restart,
        // a stale binding, etc.) — fall through ONCE to a fresh session and
        // resend, instead of failing a turn the user has no way to recover.
        fatalHostError = null;
        fatalHostErrorCode = null;
        unbindHost();
        useChatSessionsStore.setState({ lastError: null });

        const seq = await runCreateSequence();
        if (seq === 'fatal') {
          unbindHost();
          return finalizeOutcome(
            decideRunEntryOutcome({ fatalHostError: true, sawAssistantProgress, sawUserEcho })
          );
        }
        if (seq === 'timeout') {
          unbindHost();
          setCreateTimeoutError();
          return finalizeOutcome(
            decideRunEntryOutcome({ fatalHostError: true, sawAssistantProgress, sawUserEcho })
          );
        }
        waitResult = await sendAndWait();
      }

      // R3: no `useChatSessionsStore.getState().lastError` read here — see
      // the listener's `isSessionFailedForSend` branch above, which already
      // folded THIS session's own `session.failed` into `fatalHostError`.
      if (fatalHostError) {
        unbindHost();
        // Round-2 P0 hardening: a fatal host.error the Host raised BEFORE it
        // ever admitted this turn (no echo, no beginTurn — e.g. session_busy
        // surviving the bounded retry above) must not be reported the same
        // as a turn that started and then failed mid-stream. Only the latter
        // is safe to call 'committed' — the former needs to go back on the
        // queue (decision 3.3's "never swallow a message").
        const outcome = decideRunEntryOutcome({
          fatalHostError: true,
          sawAssistantProgress,
          sawUserEcho,
        });
        // S1: the queue pause for a release-origin rejection now lives
        // entirely inside `finalizeOutcome` (one authority for every branch,
        // not just this one) — see its comment above.
        return finalizeOutcome(outcome);
      }

      // F2 (2026-08-18 §4.2) — the SECOND layer, for the one exit where the
      // Host never gave a verdict at all. Everything it does is what the old
      // 45s abandon branch did; what changed is WHEN it is allowed to run.
      //
      // Kept out of the `switch` below, and given a name, for two reasons: the
      // `'ceiling'` case then reads as the decision it is rather than as a wall
      // of diagnostics, and the negative source-guards `[S-1]`~`[S-7]` can scan
      // that case for the four things a still-running turn must never get.
      const abandonUnadmittedTurn = async (): Promise<RunEntryOutcome> => {
        unbindHost();
        // F2 (round-2 review fix): the renderer is giving up on this turn with
        // no terminal event. For a turn with NO admission evidence at all that
        // is as close to proof as this side ever gets — nothing was echoed, so
        // nothing was started, so nothing can be double-sent by putting it
        // back. This branch used to fire an implicit `chat.stop` here (a5) —
        // removed, because the code must not press Stop FOR the user: a5 could
        // kill a turn that was about to succeed. Background-burn loops are
        // caught host-side by the TTFT watchdog's evidence-gated abort (F1).
        const state = useChatSessionsStore.getState();
        const session = state.sessions.find((item) => item.id === sessionId);
        const hostAfter = await window.electronAPI.chat.getHostStatus().catch((err: unknown) => ({
          error: err instanceof Error ? err.message : String(err),
        }));

        // a3: this used to end with "Check Claude auth / API in your
        // CLAUDE_CONFIG_DIR settings.json" unconditionally — wrong on this
        // machine (OAuth via ~/.claude/.credentials.json, settings.json's `env`
        // is empty) and misleading in general: it sends the user chasing local
        // config for what the investigation report traced to a CLI-side
        // transport retry loop. Branch on what rawEvents actually shows instead
        // — a1 now makes api_retry visible there, so this is often decisive.
        // F12: `sawNetworkRetry` (tracked structurally in the listener above,
        // from `session.status.payload.retry`) replaces a prior substring sniff
        // over formatted event strings, which could false-positive on the
        // watchdogs' own failure copy (e.g. "transport-layer retry loop") that
        // also contains the word "retry".
        const hint = sawNetworkRetry
          ? 'rawEvents shows a network retry loop — likely a transient upstream connection issue; Retry usually recovers once it stabilizes.'
          : "no data reached the Host at all — check the Context panel's Host stderr rows (or the Host log's [cli-stderr] lines) for a spawn or connection failure.";
        const abandonError = [
          'No assistant/tool progress after send (status may still show idle/stopped — Host did not emit failed; the SDK stream likely hung or errored without a result event).',
          `status=${session?.status ?? 'n/a'}`,
          `rawEvents=[${formatSeenEvents(seenEvents)}]`,
          `hostAfter=${JSON.stringify(hostAfter)}`,
          `sessionId=${sessionId}`,
          `cwd=${workspacePath}`,
          `Click Retry to resend, or Stop — ${hint}`,
        ].join(' | ');
        useChatSessionsStore.setState({ lastError: abandonError });
        // A1's `'committed'` half of this branch is gone: an ADMITTED turn no
        // longer reaches here at all (it takes the `'pending'` exit above), so
        // there is no admitted-but-abandoned marker left to arm, and the
        // closing advice no longer has to hedge about which of the two happened.
        return finalizeOutcome('rejected');
      };

      // The status read the success gate needs. Taken once, here, so the
      // discriminated switch below never has to reach back into the store —
      // `chatSessions.ts` applies runtime events on a batched 16ms flush
      // (throttled further in a background window), so a read INSIDE a branch
      // races the very event that produced the branch.
      const statusAfter = useChatSessionsStore
        .getState()
        .sessions.find((s) => s.id === sessionId)?.status;
      const sawSuccess =
        // m14 fix: `sawAssistantProgress` alone must count as success even when
        // the wait came back without it — the wait's expiry check and this read
        // race the SAME event stream, so a narrow window exists where progress
        // lands just after the budget elapses. Without this, an
        // already-delivered, already-answered turn gets marked failed.
        (waitResult === 'progress' || sawAssistantProgress) &&
        (sawAssistantProgress ||
          statusAfter === 'waiting_permission' ||
          statusAfter === 'waiting_question' ||
          statusAfter === 'idle');
      // A predicate that released without producing a verdict is, from this
      // side, the same event as a silence expiry: we stopped waiting and the
      // Host has said nothing. Normalised here so the switch has exactly ONE
      // "we stopped waiting" exit instead of two that must be kept in step.
      const settled: WaitResult =
        waitResult === 'terminal' || waitResult === 'cancelled'
          ? waitResult
          : sawSuccess
            ? 'progress'
            : 'ceiling';

      switch (settled) {
        case 'ceiling': {
          // §4.2 layer two. NOT a failure classifier — there is no error here.
          // The renderer's budget elapsing says nothing about the turn: the
          // Host's own stall watchdog fires first by construction
          // (`sendBudgets.ts`), so silence on this side is a fact about this
          // side only.
          const ceilingOutcome = decideAdmittedTimeoutOutcome({
            sawUserEcho,
            sawAssistantProgress,
          });
          if (ceilingOutcome === 'pending') {
            // The Host TOOK this turn and, as far as anyone knows, is still
            // running it. Four things this branch must never do — each one was
            // in the old abandon path, and each one was a lie told about a live
            // turn: no `unbindHost()` (the binding is healthy, and dropping it
            // forces the next message through a resume it does not need), no
            // `lastError` (nobody has reported a failure), no diagnostic error
            // card, and no draft restore / Retry arming (the text is already in
            // the timeline as the echoed user bubble — replaying it would be a
            // guess, and a double-send if the guess is wrong).
            //
            // Two things it does instead: remember the found-material in case a
            // REAL `session.failed` arrives later (D1 restores it then, when it
            // is a fact), and keep the turn head — with its Stop button — alive.
            pendingReplyRef.current = {
              sessionId,
              committed,
              assistantCursor: countAssistantMessagesWithBlocks(
                useChatSessionsStore.getState().messages[sessionId] ?? []
              ),
            };
            armPendingReply({ sessionId, turnStartedAtMs });
            return 'pending';
          }
          // No echo, no progress: the Host never admitted this turn, so the old
          // treatment is still exactly right and is preserved whole.
          return abandonUnadmittedTurn();
        }
        case 'terminal':
        case 'cancelled': {
          // Stop-hang fix (2026-08-10): this attempt ENDED — the Host said so
          // on the wire (`session.stopped` for a Stop, `session.completed` for
          // a turn that finished without producing a single assistant block),
          // or `handleStop` bumped the generation and the confirmation is still
          // in flight.
          //
          // As its own case rather than an `if` ahead of the success gate: the
          // ordering that used to matter (this must be decided BEFORE anything
          // reads `statusAfter`, or the same user action comes out as a clean
          // end or as an abandon depending on a flush timer) is now structural
          // — the labels are mutually exclusive, so no gate below can claim it.
          //
          // Neither ending is a failure or an abandonment: no error card, no
          // pending watch (there is no still-running turn left to watch), and
          // deliberately NO `unbindHost()` — the binding is healthy.
          useChatSessionsStore.setState({ lastError: null });
          // Admission evidence still decides the outcome — same classifier as
          // every other exit. An echoed/progressed turn is SPENT ('committed':
          // the text is already in the timeline, and quite possibly in the
          // CLI's own transcript, so a resend would double-send it). A turn the
          // Host never admitted is 'rejected', so a release-origin entry goes
          // back on the queue instead of being swallowed (decision 3.3) and a
          // direct/Retry-origin one gets its payload back via
          // `decideFailureAffordance`.
          const stopOutcome = decideRunEntryOutcome({
            fatalHostError: true,
            sawAssistantProgress,
            sawUserEcho,
          });
          if (stopOutcome === 'committed') {
            // Same clean exit as the success case below — a turn the Host
            // admitted and then ended is a turn that FINISHED, not one that
            // failed, so it must not hand the user a Retry or replay its
            // payload into a composer they have moved on from.
            setRetryable(null);
            return 'committed';
          }
          return finalizeOutcome(stopOutcome);
        }
        case 'progress': {
          // Success — clear any stale failure UI so a ghost Retry can't
          // resurface later (e.g. prior failed stream settled and pushed an
          // assistant bubble).
          setRetryable(null);
          useChatSessionsStore.setState({ lastError: null });
          return 'committed';
        }
      }
    } catch (err) {
      unbindHost();
      useChatSessionsStore.setState({
        lastError: err instanceof Error ? err.message : String(err),
      });
      // R2: an exception here (e.g. `ensureHost()` rejecting) is, in every
      // realistic case, thrown before `sendAndWait` ever ran — classify via
      // the same evidence gate instead of hardcoding 'committed'.
      return finalizeOutcome(
        decideRunEntryOutcome({ fatalHostError: true, sawAssistantProgress, sawUserEcho })
      );
    } finally {
      window.clearInterval(ticker);
      endTurnSend(sendOwner);
      if (sendOwnerRef.current === sendOwner) sendOwnerRef.current = null;
      inFlightRef.current = false;
      inFlightSessionIdRef.current = null;
      unsubEvents();
      setSending(false);
    }
  };

  // T-19 decision 3.1: releases this session's queue head once a turn ends —
  // scoped to the active session because `runSend` is this component's own
  // closure (see the hook's header for why that is a deliberate boundary,
  // not an oversight).
  useQueueRelease({
    sessionId: activeSessionId,
    hasTarget: Boolean(activeSessionId && cwd),
    disabled: Boolean(disabled),
    sending,
    isInFlight: () => inFlightRef.current,
    status: activeSession?.status ?? 'idle',
    runEntry: async (entry) => {
      // R3 fix: capture BEFORE runSend, off `entry.sessionId` (not
      // `activeSessionId` — see the comment below on why those can differ)
      // — same uniform pattern as the direct/retry call sites.
      const hadUserMessage = sessionHasUserMessage(
        useChatSessionsStore.getState().messages[entry.sessionId] ?? []
      );
      const outcome = await runSend(entry.text, entry.attachments, { origin: 'release' });
      // `entry.sessionId` (not the render-time `activeSessionId` closure) —
      // a queue release always targets the session the entry itself belongs
      // to, and by the time this callback runs the user may have already
      // navigated elsewhere.
      maybeApplyFirstMessageTitle(entry.sessionId, entry.text, outcome, hadUserMessage);
      return outcome;
    },
  });

  // T-31 §3: the send-status snapshot outlives this component if the middle
  // column tears down mid-send (the `finally` that clears it belongs to a
  // closure that may never resume), and a stale snapshot would leave a turn
  // head counting seconds forever.
  //
  // F3: scoped to THIS instance's own token. The unconditional `end()` this
  // replaces was itself a way to blank a live snapshot — remount this component
  // (a layout change, a session switch) while a send is in flight and the old
  // instance's cleanup ran AFTER the new one had already published its own
  // handshake, wiping the head the user was watching.
  useEffect(
    () => () => {
      const owner = sendOwnerRef.current;
      if (owner != null) useTurnSendStatusStore.getState().end(owner);
    },
    []
  );

  // F2 (2026-08-18 §5.4) — the late-event cleanup chain, ORDERED.
  //
  // A turn this renderer stopped waiting for can end in three ways, and the
  // ORDER of the steps below is itself the contract: cleanup must run BEFORE
  // the reducer applies the new fact, or the cleared state overwrites it.
  //
  //  1. verify the sessionId — never clean up across turns or sessions;
  //  2. read and FREEZE the two markers;
  //  3. judge "landed" through `resolveAbandonProgress` (which re-bases the
  //     armed cursor downward when the replay-coverage merge folds runtime
  //     assistant messages away — a real defect, not a guard);
  //  4. clear the pending watch (store slot AND ref), handing the turn head
  //     back to the streaming/terminal clock;
  //  5-6. (retired with the abandon branch — the ceiling path writes no
  //     `lastError` and arms no `retryable`, so it has no products of its own
  //     to withdraw, and withdrawing another writer's would be overreach);
  //  7. revoke an automatically restored draft, but ONLY while it is provably
  //     still ours (`shouldRevokeRestoredDraft`);
  //  8. drop the markers; the reducer applies the new fact last.
  const resolvePendingReplyLanded = useCallback(
    (sessionId: string) => {
      // Steps 4 and 8 for the watch. Idempotent by session, so a late clear for
      // a session the user has already left cannot blank the current one.
      pendingReplyRef.current = null;
      clearPendingReply(sessionId);
      // Step 7 (+ step 8 for the draft marker, which it drops either way).
      revokeRestoredDraftIfUntouched(sessionId);
    },
    [clearPendingReply, revokeRestoredDraftIfUntouched]
  );

  // Real NEW progress on the watched session — not just "an assistant message
  // exists". A resumed session's REPLAYED history satisfies the latter
  // unconditionally, which is why `assistantCursor` (recorded at arm time) has
  // to ADVANCE before this fires. `waiting_permission`/`waiting_question` stay
  // unconditional: those statuses are only ever set by a LIVE host event, so
  // they cannot be spuriously "already true" the way accumulated history can.
  useEffect(() => {
    const watch = pendingReplyRef.current;
    if (!watch || watch.sessionId !== activeSessionId) return;
    // Round-6 review B2: one pure step — see `resolveAbandonProgress`.
    const step = resolveAbandonProgress({
      armedCursor: watch.assistantCursor,
      currentCursor: countAssistantMessagesWithBlocks(activeMessages ?? []),
      waitingInteraction:
        activeSession?.status === 'waiting_permission' ||
        activeSession?.status === 'waiting_question',
    });
    watch.assistantCursor = step.nextArmedCursor;
    if (!step.landed) return;
    resolvePendingReplyLanded(watch.sessionId);
  }, [activeSessionId, activeSession?.status, activeMessages, resolvePendingReplyLanded]);

  // The OTHER two wire endings, both read straight off the event stream:
  // `chatSessions.ts` collapses `session.completed` AND `session.stopped` into
  // the same `'idle'` status, so the effect above (derived state only) cannot
  // tell a real completion from a user Stop.
  //
  // `session.failed` is the third, and it is the only one that changes
  // anything: it is CONFIRMED DEATH (§6.1 — the single red-card entry point),
  // so D1 applies and the payload goes back to the composer. This is the causal
  // order the whole batch exists to restore — the user waits, the Host says it
  // failed, and only THEN does the text come back, with a red card that is
  // telling the truth. `chatSessions.ts` (red-line) already writes that card
  // from the same event; nothing here duplicates it.
  //
  // Mount-once: every identifier closed over is stable.
  useEffect(() => {
    const unsubscribe = subscribeRuntimeEvent((event) => {
      const watch = pendingReplyRef.current;
      if (!watch) return;
      // Step 1: scope first, always.
      if (isSessionFailedForSend(event, watch.sessionId)) {
        // Step 2: freeze the payload before step 4 drops the watch.
        const committed = watch.committed;
        resolvePendingReplyLanded(watch.sessionId);
        restoreDraftIfComposerEmpty(watch.sessionId, committed);
        return;
      }
      if (isSessionCompletedForSend(event, watch.sessionId)) {
        // A clean completion with zero new assistant blocks. The turn ended
        // fine; the found-material is dropped in silence and the composer is
        // never touched.
        resolvePendingReplyLanded(watch.sessionId);
      }
    });
    return unsubscribe;
  }, [resolvePendingReplyLanded, restoreDraftIfComposerEmpty]);

  // T-19 fix review (R5): the strip's failed-row Retry/Discard wiring
  // (`retryQueueHead` / `handleStripRetry`) is removed along with batch 3's
  // queue-based failure requeuing above — a queue entry can no longer carry
  // `failure` in production, so there is nothing for a strip row to retry.
  // The round Retry button (`handleRetry` above) is the only Retry affordance
  // now, backed by the component-local `retryable` snapshot.

  // T-19 batch 3 decision 5.3: Pencil / click-row — `takeEntryIntoDraft`
  // covers both the "draft empty" (move) and "draft non-empty" (in-place
  // swap) cases; either way the draft area's new content is the entry's OLD
  // payload, so the UI-side transition is identical: drop whatever is
  // currently drafted, then adopt the entry's payload. Attachments go through
  // `removeDrafts`/`addDrafts` (no bulk "replace" primitive exists, nor is
  // one needed for just these two calls).
  const handleQueueEntryEdit = (entryId: string) => {
    if (!activeSessionId) return;
    const currentDraftIds = attachments.drafts.map((draft) => draft.id);
    const outcome = useMessageQueueStore.getState().takeEntryIntoDraft(activeSessionId, entryId, {
      text: value,
      attachments: attachments.drafts,
    });
    if (!outcome) return;
    updateValue(outcome.payload.text);
    attachments.removeDrafts(currentDraftIds);
    attachments.addDrafts(outcome.payload.attachments);
  };

  const handleQueueEntryMove = (entryId: string, direction: 'up' | 'down') => {
    if (!activeSessionId) return;
    useMessageQueueStore.getState().moveEntry(activeSessionId, entryId, direction);
  };

  // X — decision 5.3's delete.
  const handleQueueEntryRemove = (entryId: string) => {
    if (!activeSessionId) return;
    useMessageQueueStore.getState().removeEntry(activeSessionId, entryId);
  };

  // Pause row's Resume (decision 3.4's explicit exit from `paused`).
  const handleQueueResume = () => {
    if (!activeSessionId) return;
    useMessageQueueStore.getState().clearPause(activeSessionId);
  };

  // T-19 batch 3 decision 5: pure view model for `QueuedMessageStrip` — the
  // component renders this and decides nothing itself.
  const queueStripModel = deriveQueueStripModel({
    entries: queueEntries,
    paused: queuePaused,
    hasPendingPermissionHere: pendingPermissionHere,
  });

  const handleStop = () => {
    // T-19 decision 3.4: Stop means "not doing this right now", not "this
    // turn finished" — pause the queue so it does not auto-fire the next
    // entry the instant status settles back to idle/stopped. m10 fix: pause
    // the session actually in flight (`inFlightSessionIdRef`), not
    // `activeSessionId` — those can diverge when the user switches sessions
    // mid-send (see the ref's own comment for why).
    const pauseTarget = inFlightSessionIdRef.current ?? activeSessionId;
    if (pauseTarget) {
      useMessageQueueStore.getState().pauseSession(pauseTarget);
    }
    // F6: invalidate any in-flight runSend's session_busy backoff loop so a
    // queued resend cannot fire after this explicit Stop already told the
    // Host to abort the turn the user was looking at.
    sendGenerationRef.current += 1;
    void stopActiveSession();
  };

  // T12-e: one derivation, two readers. `emptySurface` decides WHICH surface
  // sits above the composer (guided card vs red diagnostic box); `statusTone`
  // below asks the narrower question "is the status line's text a fault".
  //
  // F14 minor m2 (still live): `statusTone` must agree with whatever puts the
  // red box on screen — without the `!cwd` term, a workspace that is "present"
  // but not targetable (demo placeholder / empty path) showed the banner while
  // `statusTone` stayed neutral and `largeHint` could still win over
  // `statusHint`. Deriving both from the same call is what keeps them agreeing.
  const emptySurface = deriveChatEmptySurface({
    hasError: Boolean(lastError),
    hasSession: Boolean(activeSessionId),
    hasWorkspace: Boolean(activeWorkspace),
    hasCwd: Boolean(cwd),
  });
  const hasStatusError = emptySurface === 'error-notice';
  const readingLine =
    attachments.reading > 0
      ? `Reading ${attachments.reading} file${attachments.reading > 1 ? 's' : ''}…`
      : null;
  const largeHint = largeAttachmentHint(attachments.drafts);
  // F5(a) (round-4 Codex NEEDS-FIX #4): `resolveIdleStatusText` replaces the
  // old inline `(!hasStatusError && largeHint) || statusHint` for the
  // non-sending, non-reading case — that selection still fell through to
  // the FULL `statusHint` (error / no-session / no-workspace / no-cwd text)
  // the instant `hasStatusError` was true, even when the row was showing
  // for an UNRELATED reason (`hasLargeHint`, since `shouldShowStatusLine`
  // no longer consults `hasStatusError` for session mode at all) — a
  // residual defect-B crack in exactly the combined state the original
  // fix did not consider.
  // T-31 §3.2: the three-way selection is a two-way one now — the `sending`
  // branch (`composerSendingLine`, plus the `activeSession.retry` suffix it
  // took) describes the TURN in flight, so it renders with the reply
  // (`turnStatus.ts` calls the same generator; the copy itself was not
  // duplicated). What is left here all describes the DRAFT in hand: attachments
  // still being read off disk, an over-large attachment, or a missing
  // session/workspace/cwd.
  const statusLine =
    readingLine ?? resolveIdleStatusText({ mode, hasStatusError, largeHint, statusHint });
  // The warning tone went with the copy: `Still waiting · 62s …` is now the
  // turn head's, and so is its colour (`turnStatusToneClass`).
  const statusTone = hasStatusError ? 'text-destructive' : 'text-muted-foreground';

  // Whether the status line renders at all. T-30b2 F-A11 put BOTH cards on one
  // truth table: neither shows a resting line any more. The empty card used to
  // show one unconditionally (a permanently parked "Ready · cwd: /home/…"),
  // and that is gone — the row now appears only while something is actually in
  // flight or flagged, in either mode. Keeping it out of the docked card's
  // resting state is also what holds that card at its 42px contract
  // (`composerFollowHeightBreakdown`), not the 40px this comment used to name.
  // T-31 §3.2 / F-B11: `sending` is no longer supplied. The function ignores it
  // either way (the field stays in its input type so that assertion can keep
  // proving so), but passing a value the decision does not use would read like
  // it still mattered.
  const showStatusLine = shouldShowStatusLine({
    mode,
    reading: attachments.reading,
    hasStatusError,
    hasLargeHint: Boolean(largeHint),
  });
  // Wrapper class differs by mode, and after F6 so does the SLOT: empty mode's
  // status area takes the slack inside the bottom bar (needs flex-1 so it
  // truncates instead of pushing the buttons off), while session mode renders
  // it on its own line in the extras stack, where nothing competes for width
  // (`sessionStatusLineWrapperClass`).
  // T-30b2: `statusLine != null` is a second gate on top of
  // `shouldShowStatusLine`. Now that session mode admits `hasStatusError` into
  // the show condition (the two modes share one truth table again),
  // `resolveIdleStatusText` can legitimately return null for it — session mode
  // deliberately refuses to reprint the full error text the banner above the
  // card already owns. Rendering the wrapper anyway used to hand an empty
  // grow-weighted box a share of the docked row's free space at the textarea's
  // expense; after F6 it would instead mount an empty line and add its gap to
  // the card's height for nothing. Every state that previously showed this row
  // still produces a non-null line, so this narrows nothing that was visible
  // before.
  // F6 §6.4: hoisted out of `renderStatusLine` because the session card now
  // needs the ANSWER, not just the node — the status line renders inside the
  // extras stack, and that stack's mount gate has to widen to include it.
  // Deriving it here keeps one truth: a `renderStatusLine` that returned a node
  // while the gate said "nothing to show" would silently drop the line.
  const statusRowVisible = showStatusLine && statusLine != null;
  const renderStatusLine = (wrapperClassName: string) =>
    statusRowVisible ? (
      <div className={wrapperClassName}>
        {/* Reading attachments off disk is the only thing left in this row that
            runs for a while with nothing else to show for it. The in-flight
            send's own spinner moved to the turn head along with its copy
            (T-31 §3.3 — the composer still signals "something is running"
            through the round key's Stop state). */}
        {attachments.reading > 0 && <Spinner className="size-3.5 shrink-0 text-muted-foreground" />}
        <p
          className={cn('min-w-0 truncate text-meta tabular-nums', statusTone)}
          title={statusLine ?? undefined}
        >
          {statusLine}
        </p>
      </div>
    ) : null;

  const noticeBlock = attachments.notice ? (
    <Alert
      variant={attachments.notice.tone === 'info' ? 'info' : 'warning'}
      className="mt-1 items-center gap-x-2 px-2 py-1 text-meta"
    >
      <TriangleAlert />
      <AlertTitle className="min-w-0 truncate font-normal" title={attachments.notice.message}>
        {attachments.notice.message}
      </AlertTitle>
      <AlertAction>
        <button
          type="button"
          onClick={attachments.dismissNotice}
          aria-label="Dismiss attachment notice"
          className="flex size-4 shrink-0 items-center justify-center rounded-xs text-muted-foreground transition-colors duration-150 hover:bg-accent/50 hover:text-foreground"
        >
          <X className="size-3" />
        </button>
      </AlertAction>
    </Alert>
  ) : null;

  // T-19 decision 1/7: a rejected `enqueue()` (queue full / over the attachment
  // byte budget) reuses the same Alert language as the attachment notice
  // above — the draft itself is left untouched by the caller (handleSend).
  const queueNoticeBlock = queueNotice ? (
    <Alert variant="warning" className="mt-1 items-center gap-x-2 px-2 py-1 text-meta">
      <TriangleAlert />
      <AlertTitle className="min-w-0 truncate font-normal" title={queueNotice}>
        {queueNotice}
      </AlertTitle>
      <AlertAction>
        <button
          type="button"
          onClick={() => setQueueNotice(null)}
          aria-label="Dismiss queue notice"
          className="flex size-4 shrink-0 items-center justify-center rounded-xs text-muted-foreground transition-colors duration-150 hover:bg-accent/50 hover:text-foreground"
        >
          <X className="size-3" />
        </button>
      </AlertAction>
    </Alert>
  ) : null;

  const attachmentChipsBlock =
    attachments.drafts.length > 0 ? (
      <div className="mt-1 flex flex-wrap items-center gap-1">
        {attachments.drafts.map((draft) => (
          <AttachmentChip
            key={draft.id}
            draft={draft}
            sending={sending}
            onRemove={attachments.removeDraft}
          />
        ))}
      </div>
    ) : null;

  const mentionChipsBlock =
    mentionChips.length > 0 ? (
      <div className="mt-1 flex flex-wrap gap-1">
        {mentionChips.map((chip, idx) => (
          // T-13 spec §3 tail slice: clicking a mention chip opens it in the
          // CENTER editor, mirroring ToolRows.tsx's `openFileTarget` — the
          // intent alone is the whole action (round-10 ⑥: the old
          // `openSurface('editor')` call popped the right-panel Files tree,
          // which is what that surface id means post-T-32).
          <button
            key={`${chip.path}-${idx}`}
            type="button"
            onClick={() => {
              useFileOpenIntentStore.getState().requestFileOpen({
                path: chip.path,
                source: 'mention-chip',
              });
            }}
            className="rounded border border-primary/30 bg-primary/10 px-1.5 py-0.5 font-mono text-code text-primary transition-colors hover:bg-primary/20"
          >
            {chip.path}
          </button>
        ))}
      </div>
    ) : null;

  // T-28 §3.4 point 7: in the docked follow-up card, notice/attachment
  // chips/mention chips must never be silently hidden (that would be the
  // T-18 "invisible attachment" bug again) — they stack as the card's first
  // row, above the single control row, instead of disappearing.
  const hasComposerExtras = Boolean(
    noticeBlock || queueNoticeBlock || attachmentChipsBlock || mentionChipsBlock
  );

  const textareaEl = (
    <Textarea
      ref={textareaRef}
      unstyled
      // Round-3 fix (point-check #7, placeholder "sits high"): `<textarea>`
      // uses `field-sizing-content` to auto-fit its box to content (see
      // textarea.tsx), but that sizing is measured off the actual `value` —
      // when the field is EMPTY (only the placeholder shows, e.g. mid-send
      // or before the first keystroke) there is no content to measure, so
      // the browser falls back to the HTML default of 2 rows instead of 1.
      // In the docked session card (composerTextareaClass('session')'s
      // `min-h-6`/`leading-6` — a deliberate one-line, 24px resting-height
      // contract) that produced a taller-than-intended box; the placeholder
      // text is top-anchored inside it (textareas never vertically center
      // their own content), leaving visible empty space below and reading
      // as "text sits high". `rows={1}` pins the no-content baseline to one
      // line so the empty/placeholder state matches the typed-content state.
      rows={1}
      value={value}
      onChange={(event) => handleContentChange(event.target.value)}
      // B9 (round-4 point-check fix): tracks whether THIS node currently
      // holds focus, so the mode-switch effect below knows whether to
      // restore it onto the remounted node — see `hadFocusRef`'s own
      // comment.
      onFocus={() => {
        hadFocusRef.current = true;
      }}
      onBlur={() => {
        hadFocusRef.current = false;
      }}
      onCompositionStart={() => {
        composingRef.current = true;
      }}
      onCompositionEnd={(event) => {
        composingRef.current = false;
        const ta = textareaRef.current;
        if (!cwd || !ta) {
          setMentionQuery(null);
          return;
        }
        setMentionQuery(extractMentionQuery(event.currentTarget.value, ta.selectionStart));
        setMentionIndex(0);
      }}
      // T-18: attachments only. This handler must never write `value` or
      // move the caret — that is what keeps plain-text paste and IME
      // composition byte-for-byte native.
      onPaste={attachments.handlePaste}
      placeholder={composerPlaceholder({
        mode,
        canSend,
        busy,
        sending,
        hasSession: Boolean(activeSessionId),
        hasWorkspace: Boolean(activeWorkspace),
        hasCwd: Boolean(cwd),
        attachmentCount: attachments.drafts.length,
        pendingQuestion: pendingQuestionHere,
        queuedCount,
        isCreatingSession,
      })}
      className={composerTextareaClass(mode)}
      // T-19 decision 2.1: only "nowhere to put this draft" still locks the
      // textarea — a running/sending turn no longer does (decision 2's
      // unlock matrix). Model/Effort selects below keep the OLD gate: they
      // stay disabled while busy/sending because changing them mid-turn has
      // no effect on the turn already running (design §2.1④).
      disabled={disabled || !activeSessionId}
      onKeyDown={(event) => {
        // T-07 @ popup：popup 开时拦截方向键 / Enter / Esc，避免误发。
        if (mentionOpen) {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setMentionIndex((i) => (i + 1) % mentionResults.length);
            return;
          }
          if (event.key === 'ArrowUp') {
            event.preventDefault();
            setMentionIndex((i) => (i - 1 + mentionResults.length) % mentionResults.length);
            return;
          }
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            insertMention(mentionResults[mentionIndex]);
            return;
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            setMentionQuery(null);
            setMentionResults([]);
            return;
          }
        }
        if (event.key === 'Enter' && !event.shiftKey) {
          // An IME confirming a candidate fires Enter before
          // compositionend — sending here would fire off a half-typed
          // message, and with attachments that is an expensive mistake.
          if (composingRef.current) return;
          event.preventDefault();
          void handleSend();
        }
      }}
    />
  );

  // T-30b2: one merged model + effort control where T-08/T-20 had two selects.
  // Both are still per-session generation settings applied at the next
  // createSession, and both keep the OLD gate — disabled while busy/sending,
  // because changing them mid-turn has no effect on the turn already running.
  const modelEffortControls = activeSessionId ? (
    <ComposerModelTrigger
      sessionId={activeSessionId}
      agent={composerAgent}
      hostDefaultModel={hostStatus.settings?.model}
      hostState={hostStatus.state}
      mode={mode}
      disabled={disabled || busy || sending}
    />
  ) : null;

  // D48 S1: the chat-agent entry point, `capabilities.agents`'s first UI
  // consumer. Its gate is deliberately NOT the model trigger's
  // `disabled || busy || sending`: a model change applies to the next turn, so
  // it only has to stand down while one is running, whereas an agent change
  // never applies to an existing session at all. `locked` is the whole rule,
  // and `disabled` stays only as the "there is nowhere to put this draft"
  // kill switch. Adding busy/sending on top would be a second, weaker copy of
  // the lock: once a turn is in flight the `sendAttempted` latch has already
  // set `locked`.
  const agentPicker = activeSessionId ? (
    <ComposerAgentPicker
      sessionId={activeSessionId}
      agents={hostStatus.capabilities?.agents}
      hostState={hostStatus.state}
      locked={agentBindingLocked}
      sendAttempted={agentSendAttempted}
      disabled={disabled}
      onRetryHost={() => void retryHost()}
    />
  ) : null;

  // D48 S4 §6.3: the live permission chip. Its gate is the model trigger's
  // (`busy || sending`) and NOT the picker's `agentBindingLocked` — the whole
  // requirement is that an established chat can still change tier (D13). It
  // Renders on any Host that reports `permissionPolicy`; an old Host gets no
  // control rather than a dead one (D15).
  //
  // A zero-turn draft gets it too (2026-08-25). It used to be hidden there —
  // the chip is a mirror of the Host's echo and a draft has no echo — but the
  // consequence was that a chat could only START under the per-agent template:
  // to open one under bypass you changed what every future chat opens under, or
  // you sent a turn under the wrong posture and switched afterwards. In the
  // draft state the control records an intent instead of sending a request, and
  // `resolveDraftPermissionPreference` materialises it at the first send.
  const permissionControl = activeSessionId ? (
    <ComposerPermissionTrigger
      sessionId={activeSessionId}
      agent={composerAgent}
      capabilityPermissionPolicy={hostStatus.capabilities?.permissionPolicy}
      hostState={hostStatus.state}
      mode={mode}
      busy={busy}
      sending={sending}
      disabled={disabled}
      // D11: the chip may not reach the template layer itself, so the one value
      // it needs for a draft is handed over from here — the same
      // `chatAgentDefaults` this component already resolves model and effort
      // from at send time.
      templatePreference={agentDefaultPermission(chatAgentDefaults, composerAgent)}
    />
  ) : null;

  // T-30b2 §4.6 / D4: sits at the far left of the card in both modes. Its
  // disabled gate matches the textarea's exactly — "there is nowhere to put
  // this draft" — and deliberately excludes busy/sending, because T-19 already
  // unlocked composing during a run: attachments collected mid-turn simply
  // ride out with the next message.
  const attachButton = (
    <ComposerAttachMenu
      mode={mode}
      disabled={disabled || !activeSessionId}
      onAttachFiles={handleAttachFiles}
    />
  );

  // T-19 decision 2.5: the button stack is now derived, not hand-assembled —
  // `deriveActionButtons` is the single source that also decides "Retry and
  // Stop never share a render" (asserted as a property over all nine
  // statuses in queueRelease.test.ts), so this component only maps kinds to
  // click handlers, it does not re-derive when each one shows up.
  //
  // M3 fix: gate on `canRetry` (all the guards), not just `lastTurnFailed` —
  // otherwise this renders a Retry with `disabled: false` in states `canRetry`
  // itself excludes (attachment mid-encode, `activeWorkspace` missing, …),
  // and it goes dead the instant it is clicked (`handleRetry`'s own
  // `if (!canRetry) return`). A button that is visible must be clickable.
  const actionButtonSpecs = deriveActionButtons({
    status: activeSession?.status ?? 'idle',
    sending,
    hasFailed: canRetry,
    hasDraftContent: Boolean(value.trim()) || attachments.drafts.length > 0,
    hasQueuedEntries: queuedCount > 0,
  });

  const actionButtons = (
    <>
      {actionButtonSpecs.map((spec) => {
        if (spec.kind === 'retry') {
          return (
            <ComposerRoundButton
              key="retry"
              kind="retry"
              title={retryTitle}
              disabled={disabled || spec.disabled}
              onClick={() => void handleRetry()}
            />
          );
        }
        if (spec.kind === 'stop') {
          return (
            <ComposerRoundButton
              key="stop"
              kind="stop"
              disabled={disabled || spec.disabled}
              onClick={handleStop}
            />
          );
        }
        if (spec.kind === 'enqueue') {
          return (
            <ComposerRoundButton
              key="enqueue"
              kind="enqueue"
              // m4 fix: match Send's guard breadth (below) — a still-encoding
              // paste or a torn-down target must disable Enqueue too, not
              // just an empty draft, or the click is silently swallowed by
              // `decideSendAction` returning `'blocked'`.
              disabled={
                disabled || spec.disabled || !(activeSessionId && cwd) || attachments.reading > 0
              }
              onClick={() => void handleSend()}
            />
          );
        }
        return (
          <ComposerRoundButton
            key="send"
            kind="send"
            // Attachment-only sends are legal; a still-encoding paste is not
            // (Enter would send the message without its files).
            disabled={
              disabled ||
              spec.disabled ||
              !canSend ||
              (!value.trim() && attachments.drafts.length === 0) ||
              attachments.reading > 0
            }
            onClick={() => void handleSend()}
          />
        );
      })}
    </>
  );

  return (
    // Wraps both the error banner and the composer card so they share the
    // timeline's reading width (T-22 spec §2.13 — "Composer 同栏宽"). The host
    // div in ChatWorkspace (`middleColumnHostClass`) owns the padding and the
    // shrink/grow behaviour for both modes now — no border/background here.
    <ReadingColumn>
      {/* T12-e′ moves the no-repository welcome surface to ChatWorkspace and
            does not mount this component at all in that state. Real failures
            still belong immediately above the composer. */}
      {emptySurface === 'error-notice' && (
        <div className="mb-2 max-h-28 overflow-auto rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 font-mono text-code text-destructive whitespace-pre-wrap break-all">
          {statusHint}
        </div>
      )}
      {/* T-28 §3.6: one ComposerTargetBar instance, rendered at one of two
            positions by mode — never both at once. Empty mode keeps the bar
            above the card (current position); session mode docks it below. */}
      {mode === 'empty' && (
        <ComposerTargetBar
          mode={mode}
          sending={sending}
          disabled={disabled}
          onAddRepository={onAddRepository}
        />
      )}
      {/* T-19 batch 3 decision 5.1: strip sits after the error banner, before
            the composer card, and only in session mode (queue-worthy states
            always imply a session already exists — `onSendStart` marks
            `sendAttempted` before any turn, including one that goes on to
            fail, can complete). The component itself no-ops when the derived
            model has nothing to show. */}
      {mode === 'session' && (
        <QueuedMessageStrip
          model={queueStripModel}
          onResume={handleQueueResume}
          onEdit={handleQueueEntryEdit}
          onMove={handleQueueEntryMove}
          onRemove={handleQueueEntryRemove}
        />
      )}
      <div className={composerCardClass(mode)}>
        {/* T-07 @ 文件搜索 popup——放 textarea 上方/下方，避免被 overflow-hidden 容器裁掉 */}
        {mentionOpen && (
          <div
            className={cn(
              'absolute left-2 w-72 overflow-hidden rounded-lg border bg-popover shadow-lg',
              mentionPopupPlacementClass(mode)
            )}
          >
            <div className="max-h-[240px] overflow-y-auto py-1">
              {mentionResults.map((item, i) => {
                const lastSep = item.relativePath.lastIndexOf('/');
                const dirPart = lastSep > 0 ? item.relativePath.slice(0, lastSep) : '';
                const fileName =
                  lastSep > 0 ? item.relativePath.slice(lastSep + 1) : item.relativePath;
                return (
                  <button
                    type="button"
                    key={item.path}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      insertMention(item);
                    }}
                    onMouseEnter={() => setMentionIndex(i)}
                    className={cn(
                      'w-full px-3 py-1.5 text-left text-sm transition-colors',
                      i === mentionIndex
                        ? 'bg-accent text-accent-foreground'
                        : 'text-foreground hover:bg-accent/50'
                    )}
                  >
                    {/* T-07①: directories are selectable now — mark them so a
                          folder is not mistaken for a same-named file. */}
                    <span className="inline-flex min-w-0 items-center gap-1.5">
                      {item.isDirectory ? (
                        <Folder className="size-3.5 shrink-0 text-folder" />
                      ) : (
                        <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
                      )}
                      <span className="truncate">
                        {fileName}
                        {item.isDirectory ? '/' : ''}
                      </span>
                    </span>
                    {dirPart && (
                      <span className="ml-1.5 text-meta text-muted-foreground">{dirPart}</span>
                    )}
                  </button>
                );
              })}
            </div>
            <div className="flex items-center gap-3 border-t px-3 py-1.5 text-meta text-muted-foreground">
              <span className="flex items-center gap-1">
                <kbd className="rounded border bg-muted px-1 py-0.5 font-mono text-2xs leading-none">
                  ↑↓
                </kbd>
                Navigate
              </span>
              <span className="flex items-center gap-1">
                <kbd className="rounded border bg-muted px-1 py-0.5 font-mono text-2xs leading-none">
                  Enter
                </kbd>
                Select
              </span>
              <span className="flex items-center gap-1">
                <kbd className="rounded border bg-muted px-1 py-0.5 font-mono text-2xs leading-none">
                  Esc
                </kbd>
                Close
              </span>
              {/* T-07③: searching `chat` here matches 304 files but only 10
                    render — say so instead of truncating silently. */}
              {mentionTotal > mentionResults.length && (
                <span className="ml-auto shrink-0 tabular-nums">
                  {mentionResults.length}/{mentionTotal}
                </span>
              )}
            </div>
          </div>
        )}
        {mode === 'session' ? (
          <div className={composerRowsClass()}>
            {/* F6 §6.4: the status line joined this stack. It is the fifth
                draft-side fact here, not a sixth control below — in session
                mode it can only ever say "reading attachments off disk" or
                "these attachments are large", both of which happen BEFORE a
                send and belong with the notice and the chips. The gate widened
                with it: left at `hasComposerExtras` alone, the status line
                would render into a container that never mounts. */}
            {(hasComposerExtras || statusRowVisible) && (
              <div className="flex flex-col gap-1">
                {noticeBlock}
                {queueNoticeBlock}
                {attachmentChipsBlock}
                {mentionChipsBlock}
                {renderStatusLine(sessionStatusLineWrapperClass())}
              </div>
            )}
            {textareaEl}
            {/* F6 §6.2: row 2. The textarea has row 1 to itself, which is the
                whole point of the split — one row can hold one elastic text
                child, and this card had two fighting over it.
                D48 S1 §3.2 still governs the order WITHIN this row: the agent
                chip sits immediately left of the model/effort chip, NOT next
                to ⊕, because which models exist follows from which agent runs
                the chat, and the two ghost chips' height/inset are
                cross-asserted against each other. */}
            <div className={composerBarClass('session')}>
              {attachButton}
              {agentPicker}
              {modelEffortControls}
              {permissionControl}
              <div className={composerActionGroupClass()}>{actionButtons}</div>
            </div>
          </div>
        ) : (
          <>
            {textareaEl}
            {noticeBlock}
            {queueNoticeBlock}
            {attachmentChipsBlock}
            {mentionChipsBlock}
            {/* T-30b2 §5.2: the bottom bar reads left-to-right as ⊕ → model →
                  status → actions, so the two controls that start a message
                  sit together at the left and the status text takes whatever
                  space is left instead of owning the leading position.
                  D48 S1 §3.2 extends that same reasoning by one slot: the
                  agent comes BEFORE the model, because which models exist is
                  a function of which agent runs the chat — reading order
                  follows the causal order. */}
            <div className={composerBarClass('empty')}>
              {attachButton}
              {agentPicker}
              {modelEffortControls}
              {permissionControl}
              {renderStatusLine('flex min-w-0 flex-1 items-center gap-1.5')}
              <div className={composerActionGroupClass()}>{actionButtons}</div>
            </div>
          </>
        )}
      </div>
      {mode === 'session' && (
        <ComposerTargetBar
          mode={mode}
          sending={sending}
          disabled={disabled}
          onAddRepository={onAddRepository}
        />
      )}
    </ReadingColumn>
  );
}
