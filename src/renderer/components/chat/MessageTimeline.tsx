import type { SessionRetryInfo, SessionRuntimeStatus } from '@shared/types/runtimeEvents';
import {
  ArrowDown,
  ArrowRightLeft,
  Check,
  ChevronRight,
  Copy,
  FileQuestion,
  FileSearch,
  FileText,
  Image as ImageIcon,
  Lock,
  PackageSearch,
  RefreshCw,
  Send,
  ShieldAlert,
  TriangleAlert,
} from 'lucide-react';
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Spinner } from '@/components/ui/spinner';
import { useSignInRequest } from '@/hooks/useSignInRequest';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { stopChatSession } from '@/stores/chatSessionActions';
import type { ChatMessage } from '@/stores/chatSessions';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { useContinueIntentStore } from '@/stores/continueIntent';
import {
  isPendingUserMessage,
  type PendingUserMessage,
  pendingUserToChatMessage,
  usePendingUserMessagesStore,
} from '@/stores/pendingUserMessages';
import { useSettingsIntentStore } from '@/stores/settingsIntent';
import { useSubagentActivityStore } from '@/stores/subagentActivity';
import {
  type PendingReplyWatch,
  type TurnSendStatus,
  useTurnSendStatusStore,
} from '@/stores/turnSendStatus';
import { AUTH_REQUIRED_ERROR_VIEW, isAuthRequiredError } from './authRequiredError';
import { ChatMarkdown } from './ChatMarkdown';
import {
  advanceClosedPrefix,
  chatMarkdownSegmentGapClass,
  deriveStreamingBlockIds,
  shouldRenderMarkdown,
} from './chatMarkdownPolicy';
import {
  chatTurnClass,
  readingColumnSpacingClass,
  turnActionsInnerClass,
  turnActionsSlotClass,
  turnAnswerToneClass,
  turnBodyClass,
  turnCopyButtonClass,
  turnFinalAnswerDividerClass,
  turnHeadClass,
  turnIntermediateToneClass,
  turnProcessShellClass,
  turnProcessToneClass,
  turnStatusToneClass,
  turnWorkGroupSummaryClass,
  turnWorkZoneClass,
  userBubbleClass,
  userBubbleRowClass,
  userBubbleTextClass,
} from './chatTimelineLayout';
import {
  countAssistantReplyChars,
  flattenTurnItems,
  groupMessagesIntoTurns,
  segmentTurnBody,
  stabilizeTurns,
  type Turn,
  type TurnItem,
  type TurnSegment,
} from './chatTurn';
import {
  deriveHistoryNotice,
  deriveRetryControl,
  deriveTakeoverControl,
  describeSessionLockOwner,
  type HistoryErrorView,
  selectHistoryError,
} from './historyError';
import { loadOlderHistoryPage } from './historyPageRequest';
// T12-b: `formatMessageMetadata` / `formatRelativeTimestamp` left with the meta
// row, and they stay left: the relative form ("3 minutes ago") needs a ticking
// clock to stay true, and the `model · time` composer duplicates the composer's
// permanent model chip.
//
// T113 reverses the other half of that ruling. T12-b had moved the wall clock
// onto a HOVER-ONLY strip, on the reasoning that a finished turn should say
// nothing about itself (pi-app's model). The user's 2026-09-21 decision puts a
// completion time back into the always-visible line — 「完成于 17:05」 on the
// work zone row — because the turn-level facts it sits beside (duration, call
// count, thinking time) were asked for by name. So `formatAbsoluteTime` now has
// a permanent consumer here, not a hover-gated one.
import { formatAbsoluteTime, type MessageMetadata } from './messageMetadata';
import { nextFollowState, shouldShowJumpToBottom } from './messageTimelineScroll';
import { TIMELINE_PADDING_CLASS } from './middleColumnLayout';
import { isModelMissingError, MODEL_MISSING_ERROR_VIEW } from './modelMissingError';
import { PermissionActivityRows } from './PermissionActivityRows';
import { QuestionCard } from './QuestionCard';
import { deriveQuestionCardState } from './questionCardModel';
import { ReadingColumn } from './ReadingColumn';
import { deriveRetryBanner, type RetryBannerView } from './retryBanner';
import { SEND_SILENCE_CEILING_MS } from './sendBudgets';
import { canContinueSession, deriveSessionFailure } from './sessionFailure';
import { useResumeSession } from './sessionIndex/useResumeSession';
import { streamingBlockIdForItem } from './streamingBlockId';
import { delegateDisplayName } from './subagentActivityModel';
import { ToolGroup } from './ToolRows';
import { deriveToolGroupRows, type ToolGroupEntry } from './toolCard';
import { buildTurnCopyTextFromItems } from './turnCopy';
import {
  deriveSendStatusBinding,
  hasLiveTurnEvidence,
  isTurnInFlight,
  ownsSessionFailure,
} from './turnHead';
import {
  countTurnToolCalls,
  deriveTurnCurrentAction,
  deriveTurnWorkZone,
  splitTurnWorkGroup,
  type TurnWorkZone,
  turnProcessGroupFolds,
  turnWorkGroupAwaitsUser,
  turnWorkGroupOpen,
} from './turnProcessFold';
// T113 drops this module's token half from the turn surface. `sumTurnTokens` /
// `turnProgressClauses` are NOT retired — they are exported, tested and still
// the one place the two-stage 「先状态词+时间，有内容再加 ↑↓」 rule lives — but the
// work zone row that replaced the head carries the four figures the user named
// and token usage is deliberately not among them. Re-wiring them here is a
// product decision to reopen, not a gap to close.
import { formatThinkingClause, joinTurnProgressLine, sumTurnThinkingMs } from './turnProgress';
import {
  deriveTurnStatus,
  isFailedCardBodyDuplicate,
  latestErrorNoticeText,
  type TurnStatus,
} from './turnStatus';
// T12-b: `deriveTurnStats` / `formatWorkedForRow` / `THOUGHT_VERB` /
// `turnHasThinkingOnlyProcess` all fed the retired meta row's completed state.
// chat-tool-07 corrects what this note used to claim: of those four, only
// `THOUGHT_VERB` still has a consumer (`subagentActivityModel.ts`, alongside
// `formatThoughtRow` in `toolCard.ts`). The other three have no caller anywhere
// in `src/` — they are kept, exported and tested, but nothing renders them, so
// anything they look up (`turnTiming.ts`'s `EDIT_TOOL_NAMES`) is not a live
// vocabulary table and must not be "fixed" as if it were.
//
// T113 brings a completed state BACK to the turn and still does not revive
// those two, which is worth stating because reviving them is the obvious move:
//   - `deriveTurnStats` buckets into tools / searches / edits and would print
//     three numbers where the user asked for one 「8 次工具调用」, and it reads
//     raw `ChatBlock`s. `turnProcessFold.ts`'s `countTurnToolCalls` answers the
//     question actually asked, off the items this component already has.
//   - `formatWorkedForRow` reports ONE message's latency; the row needs the
//     whole turn's span, which is `deriveTurnElapsedMs` — the same reason
//     2026-09-18 chose it for the head this row replaces.
import { deriveTurnElapsedMs, type ThinkingTiming } from './turnTiming';
import { useMessageMetadata } from './useMessageMetadata';
import { useResolvedSessionModel } from './useResolvedSessionModel';
import { useTurnTiming } from './useTurnTiming';

/**
 * The base-ui `ScrollArea`'s actual scrollable node is the inner Viewport
 * div (`ui/scroll-area.tsx` tags it `data-slot="scroll-area-viewport"`), not
 * the `ScrollArea` root — that root is a non-scrolling positioning wrapper.
 */
function findViewport(root: HTMLDivElement | null): HTMLDivElement | null {
  return root?.querySelector<HTMLDivElement>('[data-slot="scroll-area-viewport"]') ?? null;
}

/**
 * Whole-second clock for the turn head, running only while something is
 * actually in flight.
 *
 * The composer's own ticker (`turnSendStatus`) stops at the FIRST assistant
 * progress — `runSend` returns there — so it covers the handshake/awaiting
 * window and nothing after it. The streaming state (§4.7 `Generating · Ns`)
 * spans the rest of the turn and needs its own tick; the epoch it counts from
 * is T-06's `message.started` timestamp, not a new field.
 */
function useSecondsTick(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return undefined;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [enabled]);
  return now;
}

/*
 * `useMinuteTick` retired with the meta row (T12-b). F9 built it because the
 * footer printed a RELATIVE age ("just now", "3h ago") and nothing re-renders
 * an idle transcript, so every age froze at whatever it was when the last token
 * landed. The hover strip prints an absolute `HH:MM` instead, which stays
 * correct forever without a clock — so the tick, the `footerNowMs` prop it fed,
 * and F9's assertion all retire together, rather than leaving an interval
 * running once a minute for a value nobody reads.
 */

/**
 * `nowMs` for a turn that is not the one in flight (review batch F7).
 *
 * Only the last turn can read the second clock (`streamStartedAt` is gated on
 * `isLastTurn`), so handing every other turn the ticking value changed a prop
 * on every turn in the session once a second and made `React.memo` on
 * `ChatTurn` useless. A constant keeps their props byte-identical between
 * ticks; the value is never read.
 */
const STATIC_NOW_MS = 0;
const EMPTY_PENDING_USER_MESSAGES: PendingUserMessage[] = [];

interface MessageTimelineProps {
  sessionId: string | null;
  status: SessionRuntimeStatus;
  /** Host capability gate (T-04)：thinking-capable 时为 true，UI 渲染折叠卡。 */
  thinkingEnabled: boolean;
  /** T-05: repo name tail for Grep/Glob rows ("… in ai-client"); wired by ChatWorkspace in batch 3. */
  repoName?: string | null;
  /** T26: increments on an explicit user Send; passive output growth does not touch it. */
  jumpToBottomRequest?: number;
}

export function MessageTimeline({
  sessionId,
  status,
  thinkingEnabled,
  repoName = null,
  jumpToBottomRequest = 0,
}: MessageTimelineProps) {
  const { t } = useI18n();
  // C-08b: subscribe to this session's bucket only — other sessions' streams
  // no longer re-render this timeline.
  const bucket = useChatSessionsStore((state) =>
    sessionId ? state.messages[sessionId] : undefined
  );
  const pendingUserMessages = usePendingUserMessagesStore((state) =>
    sessionId
      ? (state.bySession[sessionId] ?? EMPTY_PENDING_USER_MESSAGES)
      : EMPTY_PENDING_USER_MESSAGES
  );
  // Still read here for the session-failed card's Stop button (below): a turn
  // that died with the gate still open is the one case where Stop is the only
  // way out. Answering moved to `PendingPermissionDock` together with the live
  // card — see this file's `case 'permission'`.
  const pendingPermissions = useChatSessionsStore((state) => state.pendingPermissions);
  // H/21 P0: the session-failed card's "go migrate" action. `requestSettings`
  // is a stable store action, so subscribing to it does not add a render path.
  const requestSettings = useSettingsIntentStore((state) => state.requestSettings);
  // The session-failed card's re-login action. Dispatching the routing event
  // alone never moved the gate (see `useSignInRequest`); this leaves the
  // credential mode behind first, which is what the spawn gate was rejecting on.
  const { requestSignIn, requesting: signInRequesting } = useSignInRequest();
  const lastError = useChatSessionsStore(
    (state) =>
      state.sessions.find((session) => session.id === sessionId)?.runtimeError ??
      (state.activeSessionId === sessionId ? state.lastError : null)
  );
  /**
   * 2026-09-21: the machine-readable half of the failure, read BESIDE the
   * sentence rather than parsed out of it. The card's reason line is derived
   * from this and falls back to "unknown" when it is absent — which covers the
   * paths that write `runtimeError` without a code (an IPC-level catch, an
   * older runtime). See `sessionFailure.ts`.
   */
  const lastErrorCode = useChatSessionsStore(
    (state) => state.sessions.find((session) => session.id === sessionId)?.runtimeErrorCode ?? null
  );
  /**
   * What this failure IS, in the user's terms — the answer to 「不知道发生了
   * 什么为什么报错了」. `lastError` alone is the provider's sentence, which says
   * what went wrong in words only its author can act on; this says whether the
   * turn hit a ceiling, lost a stream, or never started.
   */
  const failure = useMemo(
    () => deriveSessionFailure({ error: lastError, errorCode: lastErrorCode }),
    [lastError, lastErrorCode]
  );
  const requestContinue = useContinueIntentStore((state) => state.requestContinue);
  // T091: no `stopActiveSession` selector here any more. This timeline renders
  // ONE session (`sessionId`, a prop), and its Stop button used to hand that
  // fact back to the store and let it re-resolve `activeSessionId` — which is
  // only the same session when this happens to be the foreground timeline.
  // `stopChatSession(sessionId)` at the call site stops what is on screen.
  // Round-10 inspection ③: when the latest error notice in the timeline
  // already carries `lastError`'s text, the session-failed card drops its
  // duplicate body (title/hint/Stop stay) — same failure, printed once.
  const failedCardShowsError = useMemo(
    () => !isFailedCardBodyDuplicate(lastError, latestErrorNoticeText(bucket ?? [])),
    [lastError, bucket]
  );
  // C-06 / T-03: this session's history read error only. Subscribing to the
  // single key (a plain string) keeps a background session's failure out of
  // this timeline and out of its re-renders — the store rebuilds the whole
  // record on every `session.history` ingest.
  const historyError = useChatSessionsStore((state) =>
    selectHistoryError(state.historyErrors, sessionId)
  );
  const historyPagination = useChatSessionsStore((state) =>
    sessionId ? state.historyPagination?.[sessionId] : undefined
  );
  // 2026-09-18: `hasDurablePiSession` / `isIdle` / `treeOpen` and the
  // SessionTreeDialog they drove moved to `workspace-shell/SessionBar.tsx`. The
  // button that opened it («Branches») was the first child of the scrolling
  // message list, so it read as a top-bar control and then scrolled away — the
  // user asked what it was and whether it was in the wrong place. Its gate
  // (`runtimeIdentity`) and its disable rule (non-idle) moved with it, derived
  // once, in the bar.
  const [loadingOlderHistory, setLoadingOlderHistory] = useState(false);
  const loadOlderHistory = useCallback(async () => {
    if (!sessionId || !historyPagination?.hasMore || loadingOlderHistory) return;
    setLoadingOlderHistory(true);
    try {
      await loadOlderHistoryPage({
        sessionId,
        offset: historyPagination.nextOffset,
        limit: 80,
        // Read at click time, not subscribed: this only decides which channel
        // to ask, and a subscription would re-render the whole timeline every
        // time any session gained or lost a worker.
        hostBound: useChatSessionsStore.getState().hostBoundSessionIds.includes(sessionId),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      useChatSessionsStore.setState((state) => ({
        historyErrors: {
          ...state.historyErrors,
          [sessionId]: `read_failed: ${message}`,
        },
      }));
    } finally {
      setLoadingOlderHistory(false);
    }
  }, [historyPagination, loadingOlderHistory, sessionId]);
  // T-31 §3: the in-flight turn's status snapshot, published by ChatComposer.
  // Scoped to THIS session — the composer's send state is not per-session, so a
  // session switch mid-send must not paint this timeline's head with another
  // session's clock.
  const sendStatus = useTurnSendStatusStore((state) =>
    state.status && state.status.sessionId === sessionId ? state.status : null
  );
  // Where this session's message list stood when its last send began. Session
  // -scoped for the same reason the snapshot above is, and read separately
  // because it deliberately OUTLIVES the snapshot — `ownsSessionFailure` needs
  // it after `runSend`'s `finally` has cleared the live status.
  const sendBaseline = useTurnSendStatusStore((state) =>
    state.baseline && state.baseline.sessionId === sessionId ? state.baseline : null
  );
  // F2 (2026-08-18 §4.5): the SECOND slot — a turn the Host admitted and is
  // still running, which the composer has stopped waiting on. Session-scoped
  // exactly like the two above. It exists because `runSend`'s `finally` clears
  // `status` the instant the wait ends: without it the turn head (and the Stop
  // button living inside it) would vanish at the ceiling, on a turn that is
  // demonstrably still going. Deliberately NOT folded into `status` — the two
  // are armed and cleared in the same breath, so one slot would cancel out.
  const pendingReply = useTurnSendStatusStore((state) =>
    state.pendingReply && state.pendingReply.sessionId === sessionId ? state.pendingReply : null
  );
  // The CLI's own transport-retry loop, read straight off the red-line store —
  // `deriveTurnStatus` appends it to the same copy the composer used to show.
  const sessionRetry = useChatSessionsStore(
    (state) => state.sessions.find((session) => session.id === sessionId)?.retry ?? null
  );
  // T093: who the retried request belongs to, when it is a delegate's.
  // Subscribed as a STRING, so the timeline re-renders only when the NAME
  // changes — the subagent store rewrites its lanes on every delegate event,
  // and subscribing to the lane itself would make a fan-out re-render this
  // whole list at its event rate. `null` (no delegation, or a lane that does
  // not exist yet) is a legitimate answer the banner words for itself.
  const retryDelegateName = useSubagentActivityStore((state) =>
    delegateDisplayName(state, sessionRetry?.delegationId)
  );
  const { get: getMeta } = useMessageMetadata(sessionId);
  const { getThinking } = useTurnTiming(sessionId);

  const sessionMessages = useMemo(() => {
    const authoritative = bucket ?? [];
    const authoritativeIds = new Set(authoritative.map((message) => message.id));
    const visiblePending = pendingUserMessages
      .filter(
        (pending) =>
          pending.authoritativeMessageId == null ||
          !authoritativeIds.has(pending.authoritativeMessageId)
      )
      .map(pendingUserToChatMessage);
    return visiblePending.length > 0 ? [...authoritative, ...visiblePending] : authoritative;
  }, [bucket, pendingUserMessages]);

  /**
   * The message Continue would send again: the LAST user message in this
   * session's transcript.
   *
   * The last one, not the first unanswered one, because a turn that failed was
   * admitted — the Host echoed its user message before anything went wrong, so
   * the prompt that failed IS the newest user message. Looking further back
   * would re-send a prompt that already produced a reply.
   *
   * `null` means there is nothing to continue from (a failure before any user
   * message existed, e.g. a create handshake that never got that far), which is
   * one of the two conditions `canContinueSession` checks.
   */
  const resumeMessageId = useMemo(() => {
    for (let index = sessionMessages.length - 1; index >= 0; index -= 1) {
      const message = sessionMessages[index];
      // Synthetic pending rows are skipped: they carry the user's own text but
      // no Host-issued id, and Continue resolves the message it names out of
      // the session store, where a pending row does not exist.
      if (message.role === 'user' && !isPendingUserMessage(message)) return message.id;
    }
    return null;
  }, [sessionMessages]);

  const historyNotice = useMemo(
    () =>
      deriveHistoryNotice({
        sessionId,
        messageCount: sessionMessages.length,
        error: historyError,
      }),
    [sessionId, sessionMessages.length, historyError]
  );

  // F12 used to fan a second predicate (`thinkingCard.isTurnActive`, which
  // excludes the `waiting_*` states) down to every turn as well. Its last
  // consumer was the Markdown streaming gate, and that turned out to be the
  // wrong predicate there — a permission wait is still in flight, so the gate
  // flipped Markdown on and back off around every authorization round-trip.
  // What remains is the one the turn SHELL needs: it must count as in flight
  // during a `waiting_*` state, or the head vanishes and the `Collapsible`
  // unmounts out from under the very permission card the user has to answer.
  const inFlightSession = isTurnInFlight(status);

  // T-31 §4.1: the turn layer the whole reply anatomy hangs off. Pure
  // derivation — no new store field, `chatSessions.ts` untouched.
  //
  // F7: `stabilizeTurns` feeds the previous result back in so a streamed token,
  // which necessarily reallocates the bucket, only changes the identity of the
  // turn it actually landed in. Without it every `ChatTurn` in the session
  // re-derives its items on every token.
  const turnsRef = useRef<Turn[]>([]);
  const turns = useMemo(() => {
    const next = stabilizeTurns(turnsRef.current, groupMessagesIntoTurns(sessionMessages));
    turnsRef.current = next;
    return next;
  }, [sessionMessages]);
  // F2: `pendingReply` joins the enable set so the seconds keep running after
  // the composer's snapshot is cleared. `inFlightSession` alone is not enough —
  // the session status can settle before the Host's real terminal arrives, and
  // a frozen head is exactly the "failed clock" symptom this batch removes.
  const nowMs = useSecondsTick(inFlightSession || sendStatus != null || pendingReply != null);

  // Which turn does an in-flight send describe? During the handshake there is
  // no answer yet: the user's own message is echoed by the Host (`beginTurn`),
  // not written optimistically, so for the first seconds of a send the turn it
  // belongs to DOES NOT EXIST. Attaching the snapshot to whatever turn happens
  // to be last would then overwrite that (finished) turn's `Worked for Ns` with
  // the next turn's "Starting Agent Host…". So the snapshot attaches only to a
  // turn this send demonstrably owns, and otherwise renders as a standalone
  // head below the last turn — which is also what keeps the very first message
  // of a session from showing "No messages yet" with its status nowhere on
  // screen (§3.3: no information may be lost in the migration).
  //
  // F2: the test is `deriveSendStatusBinding`, not "the last turn has no
  // latency". The latter is equally true of a restored history turn, a
  // Stop-interrupted one and a 45s-abandoned one, so a fresh send's handshake
  // used to be painted onto an old turn's head — and `PendingTurnHead`, the
  // only thing on screen during that window, never rendered at all.
  const lastTurn = turns.length > 0 ? turns[turns.length - 1] : null;
  const lastTurnBodyMetadata = useMemo(
    () => (lastTurn ? lastTurn.body.map((message) => getMeta(message.id)) : []),
    [lastTurn, getMeta]
  );
  const sendBinding = deriveSendStatusBinding({
    hasLastTurn: lastTurn != null,
    lastTurnHasUser: lastTurn?.user != null,
    lastTurnBodyEmpty: (lastTurn?.body.length ?? 0) === 0,
    // Final review: a restored transcript can END in an unanswered prompt, so
    // "a user message with no reply" is NOT proof this send opened the turn —
    // the id is (see `isTurnOpenedByCurrentSend`).
    lastTurnUserMessageId: lastTurn?.user?.id ?? null,
    baselineKnown: sendBaseline != null,
    baselineMessageId: sendBaseline?.messageId ?? null,
    phase: sendStatus?.phase ?? 'handshake',
    sessionActive: inFlightSession,
    lastTurnHasLiveMessage: hasLiveTurnEvidence(lastTurnBodyMetadata),
  });
  const attachedSendStatus = sendStatus && sendBinding === 'attached' ? sendStatus : null;
  const pendingSendStatus = sendStatus && sendBinding === 'pending' ? sendStatus : null;

  // Stable identities for the memoized `ChatTurn` (F7): an inline arrow here
  // would change on every render and defeat the memo entirely.
  const getThinkingDurationMs = useCallback(
    (blockId: string) => getThinking(blockId)?.durationMs,
    [getThinking]
  );

  // Stick-to-bottom scroll following. `scrollRootRef` wraps `ScrollArea` (the
  // real scrollable viewport is found through it via `findViewport`);
  // `contentRef` is the rendered content whose height growth we watch.
  // `stickToBottomRef` is a ref, not state — it is read/written on every
  // native scroll and resize tick, and must never trigger a re-render.
  const scrollRootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const lastScrollHeightRef = useRef(0);
  const lastScrollTopRef = useRef(0);

  // T12-d: the jump-to-bottom affordance. Unlike the follow flag this one has
  // to be state — it paints a button — so it is mirrored in a ref and written
  // only on a genuine flip. Both writers below run on every scroll and every
  // resize frame of a streaming turn; a bare `setState` there would hand React
  // a render pass per token to throw away.
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const showJumpToBottomRef = useRef(false);
  const syncJumpToBottom = useCallback((viewport: HTMLElement) => {
    const next = shouldShowJumpToBottom(
      viewport.scrollTop,
      viewport.scrollHeight,
      viewport.clientHeight
    );
    if (next === showJumpToBottomRef.current) return;
    showJumpToBottomRef.current = next;
    setShowJumpToBottom(next);
  }, []);

  /**
   * Re-anchor on demand. This is the ONE place allowed to re-arm the follower
   * from a click: `nextFollowState` deliberately refuses to arm on any scroll
   * event it cannot attribute to intent (F10-b), and a button press is that
   * intent, stated directly rather than inferred from geometry.
   *
   * `lastScrollHeightRef` is updated BEFORE the browser dispatches the scroll
   * event this write provokes, so the handler sees an unchanged height at the
   * bottom — `nextFollowState`'s "genuine arrival" case — and agrees with the
   * flag set here instead of overwriting it on the next frame.
   */
  const jumpToBottom = useCallback(() => {
    const viewport = findViewport(scrollRootRef.current);
    if (!viewport) return;
    stickToBottomRef.current = true;
    lastScrollHeightRef.current = viewport.scrollHeight;
    viewport.scrollTop = viewport.scrollHeight;
    lastScrollTopRef.current = viewport.scrollTop;
    showJumpToBottomRef.current = false;
    setShowJumpToBottom(false);
  }, []);

  useEffect(() => {
    if (jumpToBottomRequest <= 0) return;
    jumpToBottom();
  }, [jumpToBottom, jumpToBottomRequest]);

  // Track whether the user is anchored to the bottom. Read fresh on every
  // native scroll event so a manual scroll-up is never fought by auto-scroll,
  // and scrolling back down re-arms following. Arming goes through
  // `nextFollowState` so a browser clamp-induced scroll (content shrank, the
  // engine clamped `scrollTop` to the new max and fired `scroll`) cannot
  // re-arm the follower — the F10 amplifier.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId triggers re-querying the viewport node, which base-ui remounts across the null <-> id transition
  useEffect(() => {
    const viewport = findViewport(scrollRootRef.current);
    if (!viewport) return undefined;
    // F10-a: the timeline does its own bottom-following, so Chromium scroll
    // anchoring buys nothing here — and a height change in a stuck band above
    // the anchor node makes anchoring itself drive a collapse/expand loop.
    viewport.style.overflowAnchor = 'none';
    viewport.style.scrollBehavior = 'auto';
    lastScrollHeightRef.current = viewport.scrollHeight;
    lastScrollTopRef.current = viewport.scrollTop;
    const handleScroll = () => {
      // A queued scroll event can arrive after text grows but before the
      // resize follower runs. Growth at an unchanged position is not scroll-up.
      const grewWithoutMoving =
        viewport.scrollHeight > lastScrollHeightRef.current &&
        viewport.scrollTop === lastScrollTopRef.current;
      if (!grewWithoutMoving)
        stickToBottomRef.current = nextFollowState({
          scrollTop: viewport.scrollTop,
          scrollHeight: viewport.scrollHeight,
          clientHeight: viewport.clientHeight,
          prevScrollHeight: lastScrollHeightRef.current,
          following: stickToBottomRef.current,
        });
      lastScrollHeightRef.current = viewport.scrollHeight;
      lastScrollTopRef.current = viewport.scrollTop;
      if (!grewWithoutMoving || !stickToBottomRef.current) syncJumpToBottom(viewport);
    };
    // User intent wins before the next resize delivery.
    const handleWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) stickToBottomRef.current = false;
    };
    viewport.addEventListener('scroll', handleScroll, { passive: true });
    viewport.addEventListener('wheel', handleWheel, { passive: true });
    return () => {
      viewport.removeEventListener('scroll', handleScroll);
      viewport.removeEventListener('wheel', handleWheel);
    };
  }, [sessionId, syncJumpToBottom]);

  // Session switch: always jump to the bottom of the new session's history
  // and re-arm following — a previous session's scroll-up must not carry
  // over to a freshly opened one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId triggers the jump-to-bottom on session switch
  useEffect(() => {
    stickToBottomRef.current = true;
    // The new session opens at its own bottom, so the affordance starts hidden
    // — carrying the previous session's `true` over would paint a button that
    // has nothing above it to jump past.
    showJumpToBottomRef.current = false;
    setShowJumpToBottom(false);
    const viewport = findViewport(scrollRootRef.current);
    if (viewport) {
      viewport.scrollTop = viewport.scrollHeight;
      lastScrollTopRef.current = viewport.scrollTop;
      lastScrollHeightRef.current = viewport.scrollHeight;
    }
  }, [sessionId]);

  // Follow new content (new messages, streaming token growth) while stuck to
  // the bottom. A ResizeObserver on the rendered content — rather than an
  // effect keyed off `sessionMessages.length` — catches both a brand new
  // message and in-place growth of the last message's text as it streams,
  // with a single listener.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId triggers re-attaching the observer to the (re)mounted content node
  useEffect(() => {
    const viewport = findViewport(scrollRootRef.current);
    const content = contentRef.current;
    if (!viewport || !content) return undefined;
    // ResizeObserver batches content/viewport changes before paint. Adding a
    // requestAnimationFrame here delays a large chunk by a visible frame.
    const observer = new ResizeObserver(() => {
      const height = viewport.scrollHeight;
      if (stickToBottomRef.current) {
        const bottom = Math.max(0, height - viewport.clientHeight);
        if (Math.abs(viewport.scrollTop - bottom) > 1) viewport.scrollTop = bottom;
      }
      lastScrollHeightRef.current = height;
      lastScrollTopRef.current = viewport.scrollTop;
      syncJumpToBottom(viewport);
    });
    observer.observe(content);
    // Composer growth and window resizing also change the visible bottom.
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [sessionId, syncJumpToBottom]);

  if (!sessionId) {
    return (
      <div className="flex flex-1 items-center justify-center text-ui text-muted-foreground">
        Select a session to start chatting.
      </div>
    );
  }

  return (
    // T12-d: `relative` is the jump button's containing block, and it is on the
    // wrapper rather than inside the viewport on purpose — an absolutely
    // positioned child of the SCROLLPORT would scroll away with the content,
    // and a `sticky` one inside it is the shape `chatTimelineLayout.ts`
    // prohibits outright (F10). Out here the button neither scrolls nor
    // participates in the timeline's layout at all.
    <div className="relative flex min-h-0 flex-1 flex-col" ref={scrollRootRef}>
      {/* Round-2 V-b, as narrowed by T-31 §5.7 and simplified again by T12.
          Conclusion ① is back to its original form: this viewport contains no
          sticky or fixed element at all (T-31's per-turn bubble band retired —
          see `chatTimelineLayout.ts`), and nothing above it
          (MessageTimeline/ChatWorkspace/HostStatusBanner/WindowTitleBar) is
          either. The "floating header overlaps the timeline" failure surface
          stays closed. Conclusion ② unchanged: the "half a row cut off at the
          top" screenshot is the stick-to-bottom effect below
          (`viewport.scrollTop = viewport.scrollHeight` on every resize while
          `stickToBottomRef` is true) — a turn taller than the viewport
          necessarily scrolls its own top above the fold, expected chat-UI
          behavior, not an overlap bug. Conclusion ③: `scrollFade` stays
          BOTTOM-ONLY. It was narrowed to soften the hard bottom clip under the
          composer; a top fade has nothing left to do now that no band is pinned
          up there, and adding one back would only wash out live prose. */}
      <ScrollArea className="min-h-0 flex-1" scrollFade="bottom">
        {/* Padding stays outside ReadingColumn — inside it would shave 24px off
            the documented 45rem/60rem (D25 §3.4) reading width (T-22 spec §2.13). */}
        <div className={TIMELINE_PADDING_CLASS} ref={contentRef}>
          {/* T-05 (A07 `.tl` :846): 20px turn spacing. T-31 §5.4 had split it
              into 10 here + 10 of sticky-band padding; T12 retired the band, so
              the whole beat is back in one place (F-B9). */}
          <ReadingColumn className={readingColumnSpacingClass()}>
            {historyPagination?.hasMore && (
              <div className="flex justify-center">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={loadingOlderHistory || status !== 'idle'}
                  onClick={() => void loadOlderHistory()}
                >
                  {loadingOlderHistory ? <Spinner className="h-3.5 w-3.5" /> : <RefreshCw />}
                  Load earlier messages
                </Button>
              </div>
            )}
            {historyNotice.kind === 'error' && (
              // Keyed by session: detail/retry state must not follow the user
              // across sessions when React reuses this slot.
              <HistoryErrorNotice
                key={sessionId}
                view={historyNotice.error}
                sessionId={sessionId}
                status={status}
              />
            )}
            {historyNotice.kind === 'empty' && pendingSendStatus == null ? (
              <p className="text-ui text-muted-foreground">
                No messages yet. Send a prompt to stream from the Agent Host.
              </p>
            ) : (
              turns.map((turn, index) => {
                // F7: the two ticking props are handed ONLY to the turn that
                // can read them. Every other turn keeps byte-identical props
                // across a tick, which is what lets `React.memo` on `ChatTurn`
                // hold and returns the per-second derivation cost to
                // O(in-flight turn) instead of O(whole session).
                const isLastTurn = index === turns.length - 1;
                return (
                  <ChatTurn
                    key={turn.id}
                    turn={turn}
                    sessionId={sessionId}
                    isLastTurn={isLastTurn}
                    sessionStatus={status}
                    inFlightSession={inFlightSession}
                    sendStatus={isLastTurn ? attachedSendStatus : null}
                    // F2 §4.5: same last-turn-only discipline as `nowMs` — a
                    // pending reply belongs to the turn the send opened.
                    pendingReply={isLastTurn ? pendingReply : null}
                    statusOwnedByPendingHead={pendingSendStatus != null}
                    baselineKnown={sendBaseline != null}
                    baselineMessageId={sendBaseline?.messageId ?? null}
                    // T-33: session-scoped retry belongs to the turn actually
                    // in flight — the pending head below while the user echo
                    // has not landed, the last turn otherwise. Nulled for every
                    // other turn for the same reason the two ticking props are
                    // (F7): a retry tick must not break `memo` session-wide.
                    retry={isLastTurn && pendingSendStatus == null ? sessionRetry : null}
                    // T093: narrowed exactly like `retry` above — the name is
                    // only ever read next to it, so handing it to every turn
                    // would break `memo` for a string nobody else renders.
                    retryDelegateName={
                      isLastTurn && pendingSendStatus == null ? retryDelegateName : null
                    }
                    nowMs={isLastTurn ? nowMs : STATIC_NOW_MS}
                    getMetadata={getMeta}
                    thinkingEnabled={thinkingEnabled}
                    repoName={repoName}
                    getThinkingDurationMs={getThinkingDurationMs}
                    // The progress head needs the SPAN, not just the settled
                    // duration: a thought that has started and not finished is
                    // the whole point of a live 「思考 N 秒」 clause, and
                    // `durationMs` is null for exactly that case. Already
                    // `useCallback`-stable at its source, so the memo holds.
                    getThinkingTiming={getThinking}
                  />
                );
              })
            )}
            {pendingSendStatus && (
              <PendingTurnHead
                sessionId={sessionId}
                sendStatus={pendingSendStatus}
                retry={sessionRetry}
                retryDelegateName={retryDelegateName}
                nowMs={nowMs}
              />
            )}
            {/* T-31 §9-ζ: stays SESSION-level and stays here, after the last
                turn. Folding it into the failing turn would leave a
                session-level failure (one that belongs to no turn) with
                nowhere to render, and would move a block T-30 batch 1 already
                landed as P-06. The failed turn gets its own short head label
                instead (`deriveTurnStatus` -> 'Failed'). */}
            {status === 'failed' && (
              <div
                className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-meta"
                role="alert"
              >
                {/* T-30 P-06: only the title carries destructive weight — body
                    and hint fall back to muted-foreground so a session-level
                    failure doesn't stack a second red block on top of the
                    already-red failed tool rows above it. */}
                {/* 2026-09-21: the title used to be the bare words 「Session
                    failed」, which is the label of the sensor, not of the
                    event. It is now the KIND of stop ("Stopped at the
                    tool-call ceiling" / "The model's reply was cut off"), with
                    a reason line and a next step under it. The user's report
                    was 「停下了很莫名其妙」, and the fix for that is naming what
                    happened, not repeating that something did. */}
                <p className="font-medium text-destructive">{t(failure.title)}</p>
                {lastError && isAuthRequiredError(lastError) ? (
                  // D47 S5 §3: spawn-gate rejection (resolveSpawnGateDecision,
                  // @shared/authGate) — retrying won't help without a fresh
                  // login, so this replaces the raw diagnostic + Retry hint
                  // with mapped copy and a re-login action instead.
                  <>
                    <p className="mt-1 text-muted-foreground">
                      {t(AUTH_REQUIRED_ERROR_VIEW.message)}
                    </p>
                    <Button
                      size="sm"
                      variant="outline"
                      className="mt-2 h-6 text-ui"
                      onClick={() => void requestSignIn()}
                      disabled={signInRequesting}
                    >
                      {signInRequesting ? <Spinner className="h-3.5 w-3.5" /> : null}
                      {t(AUTH_REQUIRED_ERROR_VIEW.actionLabel)}
                    </Button>
                  </>
                ) : lastError && isModelMissingError(lastError) ? (
                  // H/21 P0: the session's recorded model is not in this app's
                  // model directory (H/19 U1 gave the app its own agent dir).
                  // Same reasoning as the auth branch above — resending cannot
                  // work until the model exists here, so the generic "可从下方
                  // 输入框重发上条消息" hint would be wrong, and the only useful
                  // affordance is the migration that puts the model there.
                  <>
                    <p className="mt-1 text-muted-foreground">
                      {t(MODEL_MISSING_ERROR_VIEW.message)}
                    </p>
                    <p className="mt-1 text-muted-foreground">{t(MODEL_MISSING_ERROR_VIEW.hint)}</p>
                    <Button
                      size="sm"
                      variant="outline"
                      className="mt-2 h-6 text-ui"
                      onClick={() => requestSettings(MODEL_MISSING_ERROR_VIEW.settingsCategory)}
                    >
                      {t(MODEL_MISSING_ERROR_VIEW.actionLabel)}
                    </Button>
                  </>
                ) : (
                  <>
                    {/* 2026-09-21: WHY it stopped, before the raw sentence that
                        says what the provider said. The two are different
                        kinds of fact and the card needs both — the reason is
                        what a reader can act on, the sentence is the evidence
                        they forward when they ask for help. */}
                    <p className="mt-1 text-muted-foreground">{t(failure.reason)}</p>
                    {lastError && failedCardShowsError && (
                      // D25 M3d: machine diagnostic text (rawEvents=/hostAfter=/cwd=), same
                      // content family as ChatComposer's destructive banner — mono.
                      // Round-10 ③: suppressed when the latest error notice above
                      // already prints this exact failure (see failedCardShowsError).
                      <p className="mt-1 select-text break-words whitespace-pre-wrap font-mono text-code text-muted-foreground">
                        {lastError}
                      </p>
                    )}
                    {/* F3 fast-fix batch, superseded 2026-09-21: this used to be
                        affordance-neutral on purpose — "whether this failure
                        armed the composer's Retry or restored the draft is
                        decided by queueRelease's outcome, so the card must not
                        name a button that may not exist" (2026-08-17). The
                        user's report is what that reasoning cost: a red card
                        whose only way out was a round icon beside the send
                        button, in a different part of the window — 「停下来但
                        也得给个明确的继续按钮」.

                        The neutrality is kept as a CONDITION rather than as
                        silence. `canContinueSession` says whether a resend can
                        work at all, and when it cannot (nothing to resend, or a
                        reason re-sending cannot fix), the card says what to do
                        in words instead of offering the button. What is gone
                        is the case where it did nothing at all. */}
                    {canContinueSession(failure, resumeMessageId != null) ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="mt-2 h-6 text-ui"
                        onClick={() =>
                          resumeMessageId && requestContinue(sessionId, resumeMessageId)
                        }
                      >
                        <Send className="mr-1 h-3.5 w-3.5" />
                        {t('Continue')}
                      </Button>
                    ) : (
                      <p className="mt-1 text-muted-foreground">{t(failure.hint)}</p>
                    )}
                    {pendingPermissions.some((item) => item.sessionId === sessionId) && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="mt-2 h-6 text-ui"
                        onClick={() => void stopChatSession(sessionId)}
                      >
                        Stop
                      </Button>
                    )}
                  </>
                )}
              </div>
            )}
          </ReadingColumn>
        </div>
      </ScrollArea>
      {/* T12-d: the bottom anchor. Shape is the app's OWN — `ShellTerminal`
          and `AgentTerminal` have carried this exact button for as long as
          they have had scrollback, and a second vocabulary for "jump to the
          live end" in the same window would be the worse choice even though
          the reference implementation centres its own pill instead.

          Visibility is geometry, never hover: `F-B15`'s reversal bought the
          turn action strip a hover-only life, and the argument that made that
          acceptable (a duplicate of an action available elsewhere) does not
          transfer to the only way back to a running stream. It is a real
          <button>, so it is reachable by keyboard whenever it is on screen. */}
      {showJumpToBottom && (
        <button
          type="button"
          onClick={jumpToBottom}
          className="absolute right-3 bottom-3 flex h-8 w-8 items-center justify-center rounded-full bg-primary/80 text-primary-foreground shadow-lg transition-all hover:scale-105 hover:bg-primary active:scale-95"
          title={t('Scroll to bottom')}
          aria-label={t('Scroll to bottom')}
        >
          <ArrowDown className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

interface HistoryErrorNoticeProps {
  view: HistoryErrorView;
  sessionId: string;
  status: SessionRuntimeStatus;
}

const HISTORY_ERROR_ICON = {
  jsonl_not_found: FileSearch,
  encrypted_unreadable: ShieldAlert,
  read_failed: TriangleAlert,
  // S2 (d): this build has no reader for the session's agent. Distinct from
  // "not found" on purpose — nothing is missing, we just cannot read it here.
  history_unsupported: FileQuestion,
  session_file_corrupt: TriangleAlert,
  session_cwd_mismatch: FileQuestion,
  // concurrency-02: another process is holding the file. Neither missing nor
  // damaged — occupied, which is the one shape a padlock says on its own.
  session_locked: Lock,
  // ah-lib-03: the record is neither missing nor damaged — this build simply
  // refuses to load one that big, which is a limit being hit, not a bad file.
  session_too_large: TriangleAlert,
  // F2-c: the folder itself is gone, which is a missing-file shape, not a
  // damaged-content one.
  workspace_missing: FileSearch,
  // H/21 P0: nothing on disk is missing or damaged — a model this app does not
  // have is a configuration gap, so it gets neither of the file icons.
  model_missing: PackageSearch,
  unknown: TriangleAlert,
} as const;

/**
 * T-03: non-fatal per-session history read failure.
 *
 * Rendered as the first timeline item — it sits where the missing history would
 * have been and scrolls away as the conversation grows. Deliberately not a top
 * ribbon: that form (HostStatusBanner) means the Host itself is down, and the
 * protocol says a history read failure leaves the session fully usable. Retry
 * only shows for transient read failures and reuses the existing resume action,
 * so no new IPC is introduced; a clean re-read drops the store entry and
 * unmounts this notice. Resume is refused mid-turn, so Retry is disabled while
 * the session is busy and a resolved-but-failed retry states so — the button
 * must never look like it did nothing.
 */
function HistoryErrorNotice({ view, sessionId, status }: HistoryErrorNoticeProps) {
  const { t } = useI18n();
  const [detailOpen, setDetailOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryFailed, setRetryFailed] = useState(false);
  // concurrency-02: the takeover keeps its own pair rather than sharing the
  // retry's. Both buttons can be on screen at once for `session_locked`, and a
  // failed takeover must not report itself as a failed re-read.
  const [takingOver, setTakingOver] = useState(false);
  const [takeoverFailed, setTakeoverFailed] = useState(false);
  const { resume } = useResumeSession();
  const requestSettings = useSettingsIntentStore((state) => state.requestSettings);
  // Round-2 P0 fix (model directness): this Retry re-runs the same resume
  // path LeftNav's sidebar open does — without a model it leaves the Host
  // registry entry's `model` undefined, and every later 'direct' send
  // silently falls back to the gateway default instead of the user's pick.
  // F9 (round-2 review fix), D48 S2 form: resolve the SAME way the Composer's
  // model trigger does — see `useResolvedSessionModel` for why the answer now
  // needs the session's agent, and LeftNav.tsx for the identical call site.
  const resolveSessionModel = useResolvedSessionModel();
  const Icon = HISTORY_ERROR_ICON[view.code];
  const retryControl = deriveRetryControl({
    retryable: view.retryable,
    status,
    retrying,
    failed: retryFailed,
  });
  const takeoverControl = deriveTakeoverControl({
    available: view.forceTakeover !== undefined,
    status,
    taking: takingOver,
    failed: takeoverFailed,
  });
  const lockOwner = describeSessionLockOwner(view.lock, t);

  const handleRetry = async () => {
    setRetrying(true);
    setRetryFailed(false);
    try {
      const resumed = await resume(sessionId, {
        model: resolveSessionModel(sessionId),
      });
      // A successful resume replays history and clears the store entry, which
      // unmounts this notice; anything else needs to say it went nowhere.
      if (!resumed) setRetryFailed(true);
    } finally {
      setRetrying(false);
    }
  };

  // concurrency-02: the same resume, with the lock forced. Nothing else about
  // the call changes — the model still has to be resolved, or a session opened
  // through this button would lose the user's pick (see `handleRetry`).
  const handleForceTakeover = async () => {
    setTakingOver(true);
    setTakeoverFailed(false);
    try {
      const resumed = await resume(sessionId, {
        model: resolveSessionModel(sessionId),
        forceTakeover: true,
      });
      if (!resumed) setTakeoverFailed(true);
    } finally {
      setTakingOver(false);
    }
  };

  return (
    <Alert variant={view.severity} role={view.severity === 'error' ? 'alert' : 'status'}>
      <Icon />
      {/* Every field on `view` is a dictionary key, not display text — the
          module that builds it is a plain `.ts` with no translator in scope. */}
      <AlertTitle className="min-w-0 truncate">{t(view.title)}</AlertTitle>
      <AlertDescription className="gap-1 text-meta">
        <p className="break-words">{t(view.guidance)}</p>
        {/* concurrency-02: who holds it and for how long is how a user judges
            whether that writer can still be real — the question the takeover
            below asks them to answer. */}
        {lockOwner && <p className="break-words">{lockOwner}</p>}
        <p>{t(view.continuationHint)}</p>
        {/* Rendered next to the button rather than behind a confirmation
            dialog: the warning is what the user needs while deciding, and a
            modal that appears after the click is read past, not read. */}
        {takeoverControl.visible && view.forceTakeover && (
          <p className="break-words font-medium">{t(view.forceTakeover.warning)}</p>
        )}
        {retryControl.hint && (
          <p
            className={cn(
              'break-words',
              retryControl.hintKind === 'failed' && 'font-medium text-destructive'
            )}
          >
            {t(retryControl.hint)}
          </p>
        )}
        {takeoverControl.hint && (
          <p
            className={cn(
              'break-words',
              takeoverControl.hintKind === 'failed' && 'font-medium text-destructive'
            )}
          >
            {t(takeoverControl.hint)}
          </p>
        )}
        {view.message && (
          <Collapsible open={detailOpen} onOpenChange={setDetailOpen}>
            <CollapsibleTrigger className="flex h-6 items-center gap-1 rounded-sm hover:text-foreground">
              <ChevronRight
                className={cn(
                  'h-3.5 w-3.5 shrink-0 transition-transform',
                  detailOpen && 'rotate-90'
                )}
              />
              {t('Details')}
            </CollapsibleTrigger>
            <CollapsibleContent>
              <pre className="max-h-24 select-text overflow-auto whitespace-pre-wrap break-all font-mono text-code">
                {view.message}
              </pre>
            </CollapsibleContent>
          </Collapsible>
        )}
      </AlertDescription>
      {(retryControl.visible || takeoverControl.visible || view.recovery) && (
        <AlertAction>
          {retryControl.visible && (
            <Button
              size="xs"
              variant="outline"
              className="h-6"
              disabled={retryControl.disabled}
              onClick={() => void handleRetry()}
            >
              <RefreshCw className={cn(retrying && 'animate-spin')} />
              Retry
            </Button>
          )}
          {/* concurrency-02: second, never first. Retry is the harmless answer
              when the holder is a window the user is about to close; the
              takeover displaces a writer that may still be alive. */}
          {takeoverControl.visible && view.forceTakeover && (
            <Button
              size="xs"
              variant="outline"
              className="h-6"
              disabled={takeoverControl.disabled}
              onClick={() => void handleForceTakeover()}
            >
              <Lock className={cn(takingOver && 'animate-pulse')} />
              {t(view.forceTakeover.label)}
            </Button>
          )}
          {/* H/21 P0: the only code with a recovery today is `model_missing`,
              and it is never retryable — so these two never stack in practice.
              Both branches are still written independently: a later code that
              is both would otherwise silently lose one of its buttons. */}
          {view.recovery && (
            <Button
              size="xs"
              variant="outline"
              className="h-6"
              onClick={() => requestSettings(view.recovery?.settingsCategory)}
            >
              <ArrowRightLeft />
              {t(view.recovery.label)}
            </Button>
          )}
        </AlertAction>
      )}
    </Alert>
  );
}

/**
 * T-05 (D-1) -> T-30 (P-08/P-11) -> T-31 §4.8 -> T12: the three role forms are
 * unchanged, but they are no longer selected by a single `MessageBubble`
 * dispatcher over a flat message list. `ChatTurn` below owns the ordering now:
 *  - user -> this bubble, the first row of the turn;
 *  - assistant -> its blocks, flattened by `flattenTurnItems` and rendered
 *    item by item by `TurnItemView` (same block order, T-05 D-5);
 *  - system / error -> `NoticeMessage`, still the `Alert` primitive.
 *
 * T12 (2026-08-29) takes pi-app's `.timeline-user-bubble` form: an ordinary row
 * in the flow (no sticky band), 80% cap, sharp corner at the TOP-right, and no
 * line clamp — so no `Show more` toggle either. `userBubbleClass()`'s header has
 * the causal chain and the one trade it accepts (a very long pasted prompt now
 * renders at full height).
 *
 * The face and edge are still F5 D3-c's `--accent` + `--input`, and that half is
 * deliberately NOT taken from pi-app: measured, the face alone reads 1.161
 * (light) / 1.292 (dark) against the timeline surface, which is where "the
 * bubble is, in effect, not drawn" starts. The edge carries the rest.
 */
function UserBubble({ message }: { message: ChatMessage }) {
  const { t } = useI18n();
  // user messages only ever carry `text` blocks (chatSessions.ts attaches
  // tool_call/tool_result/thinking/permission_request/question exclusively
  // to role: 'assistant' messages, live and replayed alike).
  const textBlocks = message.blocks.filter((block) => block.type === 'text');
  const pending = isPendingUserMessage(message);

  return (
    // What makes the two roles distinguishable is SHAPE on this side: the right
    // edge, the 80% cap, the sharp corner pointing back at the composer, and a
    // face that is actually visible. The assistant side is NOT drawn at all —
    // full reading width, no face, no edge — and that asymmetry is the whole
    // role signal now that the answer container has retired (see
    // `chatTimelineLayout.ts`'s note where it used to be defined).
    <article className={userBubbleRowClass()}>
      <div className={userBubbleClass()}>
        {/* Round-2 P0 (Chat attachments): read-only echo of what this turn sent,
            metadata only (no bytes, no size — never threaded over the wire).
            Visual language mirrors ChatComposer's AttachmentChip (icon +
            truncated name), minus the size label and remove button — this
            chip cannot be edited after the fact. */}
        {message.attachments && message.attachments.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {message.attachments.map((attachment, index) => (
              <span
                key={`${message.id}-attachment-${index}`}
                // D3-c: `border-border` measured ≈1.36 on the old `--card`
                // face but only 1.208 / 1.115 on `--accent` — invisible in
                // dark. The chip follows the bubble's own edge onto `--input`
                // (1.350 / 1.322). Its `bg-muted/50` fill stays as it was: the
                // chip is shaped by its edge and icon, not by its fill.
                className="inline-flex h-6 max-w-56 shrink-0 items-center gap-1 rounded-xs border border-input bg-muted/50 px-1.5 text-meta text-foreground"
              >
                {attachment.kind === 'image' ? (
                  <ImageIcon className="size-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                )}
                <span
                  className="min-w-0 flex-1 truncate"
                  title={attachment.name ?? attachment.mediaType}
                >
                  {attachment.name ?? attachment.mediaType}
                </span>
              </span>
            ))}
          </div>
        ) : null}
        {/* T12: the prompt in full. No clamp and no `Show more` — both retired
            with the sticky band that made them necessary (`userBubbleClass()`'s
            header carries the chain). `title` retired with them: with nothing
            hidden there is nothing for a tooltip to reveal, and a `title` on a
            long prompt is a screen-sized tooltip. */}
        <div className={userBubbleTextClass()}>
          {textBlocks.map((block) => (
            <p
              key={block.id}
              className="whitespace-pre-wrap break-words text-chat-body leading-relaxed text-foreground"
            >
              {block.text}
            </p>
          ))}
        </div>
        {pending && (
          <div className="mt-1 flex items-center justify-end gap-1 text-meta text-muted-foreground">
            <Spinner className="size-3 shrink-0" />
            <span>{t('Sending…')}</span>
          </div>
        )}
      </div>
    </article>
  );
}

/**
 * T-30 P-11: system / error notices — not a turn, so they get the same
 * `Alert` shell as `HistoryErrorNotice` instead of the user bubble. The
 * `error`/`default` variant is the only role differentiator now that the
 * uppercase role label is gone (P-08); that matches the color-only signal
 * every other notice in this file already uses.
 */
function NoticeMessage({ message }: { message: ChatMessage }) {
  const { t } = useI18n();
  const isError = message.role === 'error';
  // D47 S5 §3: a spawn-gate rejection (resolveSpawnGateDecision,
  // @shared/authGate) landing in this card as raw text — swap in mapped
  // copy + a re-login action instead of the raw diagnostic.
  const authRequired =
    isError &&
    message.blocks.some((block) => block.type === 'text' && isAuthRequiredError(block.text));
  // H/21 P0: the same in-place swap for "this session's model is not in this
  // app's model directory". The worker's own text is accurate and useless — it
  // names the model but never says that a migration is what puts it here.
  // Ranked below auth on purpose: a session that cannot start for BOTH reasons
  // has to be signed in before the model matters at all.
  const modelMissing =
    isError &&
    !authRequired &&
    message.blocks.some((block) => block.type === 'text' && isModelMissingError(block.text));
  const requestSettings = useSettingsIntentStore((state) => state.requestSettings);
  // Same action as the session-failed card's, and it was broken the same way —
  // see `useSignInRequest`.
  const { requestSignIn, requesting: signInRequesting } = useSignInRequest();

  return (
    <Alert variant={isError ? 'error' : 'default'} role={isError ? 'alert' : 'status'}>
      <AlertDescription>
        {message.blocks.map((block) =>
          block.type === 'text' ? (
            <p
              key={block.id}
              className="select-text whitespace-pre-wrap text-chat-body text-foreground"
            >
              {/* D47 S5 §3: swap the raw spawn-gate rejection text for mapped
                  copy in-place — same paragraph, same class, so this
                  stays the one "notice body" surface T-29 pinned (see the
                  wiring test's exact-count assertion on this class string). */}
              {authRequired
                ? t(AUTH_REQUIRED_ERROR_VIEW.message)
                : modelMissing
                  ? t(MODEL_MISSING_ERROR_VIEW.message)
                  : // T023: a `notice` marks this paragraph as copy the APP
                    // wrote (today: the imported-history banner), so it
                    // follows the language setting like every other label.
                    // Without one, `text` is transcript content and is
                    // printed exactly as it arrived.
                    block.notice
                    ? t(block.notice.key, block.notice.params)
                    : block.text}
            </p>
          ) : null
        )}
        {/* H/21 P0: unlike the auth swap, the replaced text here carried
            something worth keeping — WHICH model is missing. The mapped copy
            explains the failure and the raw line below still names the model,
            so the user can tell one stale session from another. */}
        {modelMissing && (
          <>
            <p className="mt-1 text-meta text-muted-foreground">
              {t(MODEL_MISSING_ERROR_VIEW.hint)}
            </p>
            {message.blocks.map((block) =>
              block.type === 'text' ? (
                <p
                  key={block.id}
                  className="mt-1 select-text break-words whitespace-pre-wrap font-mono text-code text-muted-foreground"
                >
                  {block.text}
                </p>
              ) : null
            )}
          </>
        )}
      </AlertDescription>
      {(authRequired || modelMissing) && (
        <AlertAction>
          {authRequired ? (
            <Button
              size="xs"
              variant="outline"
              className="h-6"
              onClick={() => void requestSignIn()}
              disabled={signInRequesting}
            >
              {signInRequesting ? <Spinner className="h-3.5 w-3.5" /> : null}
              {t(AUTH_REQUIRED_ERROR_VIEW.actionLabel)}
            </Button>
          ) : (
            <Button
              size="xs"
              variant="outline"
              className="h-6"
              onClick={() => requestSettings(MODEL_MISSING_ERROR_VIEW.settingsCategory)}
            >
              <ArrowRightLeft />
              {t(MODEL_MISSING_ERROR_VIEW.actionLabel)}
            </Button>
          )}
        </AlertAction>
      )}
    </Alert>
  );
}

interface ChatTurnProps {
  turn: Turn;
  /**
   * T12-d: session scope for the tool-row expand memory. Stable for the life of
   * the timeline, so handing it to a memoized turn costs nothing.
   */
  sessionId: string;
  /** Only the last turn can be in flight, and only it carries the session's failure state. */
  isLastTurn: boolean;
  sessionStatus: SessionRuntimeStatus;
  /** The session is in flight for turn-shell purposes, `waiting_*` included (`isTurnInFlight`, F12). */
  inFlightSession: boolean;
  sendStatus: TurnSendStatus | null;
  /** F2 §4.5: the Host still owes a reply this renderer stopped waiting for. `null` for every turn but the last. */
  pendingReply: PendingReplyWatch | null;
  /**
   * F7b: `PendingTurnHead` is on screen and already showing this turn's running
   * status, so this turn must not draw a second copy of it.
   *
   * The head's own guard asked `inFlightSession`, which is a different
   * question — a send whose user echo has not landed yet arms `pendingReply`
   * on the last turn (making its head render) while the session status has not
   * become in-flight, and the field pass saw exactly that: 「正在输出 · 3s」and
   * 「等待确认 · 2s」printed twice, once in the timeline and once above the
   * composer.
   */
  statusOwnedByPendingHead: boolean;
  /** A send-begin baseline exists for this session (`turnSendStatus.baseline`). */
  baselineKnown: boolean;
  /** Last message id in the bucket when this session's last send began. */
  baselineMessageId: string | null;
  retry: SessionRetryInfo | null;
  /** T093: delegate behind `retry.delegationId`, resolved by the timeline. */
  retryDelegateName: string | null;
  /** Whole-second clock, ticking only while a turn is in flight (`useSecondsTick`). `STATIC_NOW_MS` for every turn but the last. */
  nowMs: number;
  getMetadata: (messageId: string) => MessageMetadata | undefined;
  thinkingEnabled: boolean;
  repoName?: string | null;
  getThinkingDurationMs: (blockId: string) => number | null | undefined;
  /** The whole span, for the head's live 「思考 N 秒」 clause (`sumTurnThinkingMs`). */
  getThinkingTiming: (blockId: string) => ThinkingTiming | undefined;
}

/**
 * T-31 §4.8: one turn — the container this whole spec exists to introduce.
 *
 * Renders, in order: the user's prompt bubble (§5), then the turn's content in
 * block order under T107: answers stay visible, process runs have independent
 * folded heads, and notices stay outside. This supersedes the 2026-09-18
 * single group before the final output; the original FB4 prohibition on
 * hiding prose when a turn ends in an error now covers EVERY answer.
 * Placement belongs to `splitTurnWorkGroup`, not this renderer.
 *
 * The segments and the status row are deliberately siblings under one
 * `turnBodyClass()`: P-17's "within a turn" gap stays a single source (8px
 * since 2026-09-19 — `chatTimelineLayout.ts` owns the number and the reason),
 * inherited from the `<article>` that `AssistantMessage` used to own before it
 * was split in two.
 *
 * `memo` (review batch F7) is load-bearing, not a micro-optimization: the head
 * runs off a one-second clock, so without it every turn in the session
 * re-derived its items, its call counts and its tool rows once a second for the
 * whole length of a wait. It only holds because `stabilizeTurns` keeps this
 * turn's `turn` identity across an unrelated token, because the ticking props
 * reach the last turn only, and because both lookup callbacks are `useCallback`
 * -stable at their source.
 */
/**
 * A process group's head: one line, and one fact — how many steps are behind
 * it.
 *
 * ## One shape now, and where the second one went
 *
 * Until T113 this element had two. With work to hide it was a `<details>`
 * whose `<summary>` carried the line and a chevron; with nothing to hide it
 * was a plain chevron-less row. That second shape existed for the case the
 * 2026-09-18 field report was actually about: a one-word prompt that takes 50
 * seconds produces no thinking block and no tool call, so a head rendered only
 * "when the group has members" left that turn showing NOTHING for the whole
 * wait. `TurnWorkZoneRow` covers that now, one line lower and for every turn
 * including a tool-free one — and T112 stopped rendering a head at all for a
 * group of fewer than two steps, so nothing reaches this function without
 * something to disclose. The shape with nothing to disclose has no case left.
 *
 * What has not changed is why the copy and the affordance are one line: an
 * affordance that expands to nothing is worse than no affordance, which is the
 * same judgement `splitTurnWorkGroup` makes when it refuses an empty group.
 *
 * ## The head says nothing about the TURN any more
 *
 * T107 handed the LAST group's head the whole turn's duration, usage and
 * thinking time (`workedMs={lastGroup ? workedMs : null}`), to avoid reporting
 * one duration once per group. The cost was two different scopes wearing
 * identical lines — 「已处理 3 个步骤」 above, 「已工作 47 秒」 below, both a
 * chevron row — and the user's report on it was 「最后一个理应显示 N 个步骤的
 * 地方却显示工作区，有点不协调」. T113 splits them by scope: this head is
 * group-scoped always, and every turn-scoped figure is on the work zone row at
 * the end of the turn. That is also why `settled` is gone from here — the
 * spinner and the live action clause went with the clock they belonged to.
 *
 * ## 2026-09-22 (decision 033 D1/D2/D4/D5): one head, one number, open by default
 *
 * The user's list reworked this element again, and the four changes are one
 * design:
 *
 *  - **D5 — the words follow the system language.** The binding was
 *    `englishTranslate`, an exception decision 031 D7 granted to the OLD head
 *    shape (an English step-count line). That shape is gone, so the exception
 *    lost its carrier and the head binds `useI18n()` like every other row on
 *    this surface. Two guards retired with it ([HEAD-EN-1], [HEAD-EN-2]).
 *  - **D1 — counts, not chips.** The chips named what the group HELD
 *    (thinking / N tool calls / N explanations); the user asked for a COUNT of
 *    the work instead: 「已处理 N 个步骤」, the same number
 *    `turnProcessGroupFolds` already thresholds on. This element was the only
 *    caller `countProcessGroupThinking` / `countProcessGroupExplanations` ever
 *    had, so both retired with the chips rather than staying as exports
 *    nothing renders.
 *  - **D4 — pinned and findable.** `turnWorkGroupSummaryClass()` carries the
 *    sticky pin; see that function for why the pin is legal here, why it had to
 *    leave the thought header (D3), and why the accent face that shipped with
 *    it on the first pass was withdrawn hours later. The right-hand tool-call
 *    count is D4's other half (「滚动中也能看到进度」) and is the ONE place this
 *    head still reads a second figure.
 *  - **D2 — open by default.** Not this element's decision
 *    (`turnWorkGroupOpen` owns it), but it is why this file's copy no longer
 *    says "starts collapsed".
 *
 * ## Why a native `<details>` with `preventDefault`
 *
 * Two constraints meet here. The panel must be fully CONTROLLED — an
 * unanswered authorization card forces the group open regardless of what anyone
 * clicked — and it must not introduce
 * `overflow-hidden`, which is what rules out the Base UI `Collapsible`
 * (`COLLAPSIBLE_PANEL_BASE_CLASS` carries it; see `turnProcessShellClass()`).
 *
 * `<details>` toggles ITSELF on a summary click, before React hears about it,
 * so a plain `open={…}` prop desynchronises the moment a click is refused: the
 * DOM closes, the computed value stays `true`, React sees no prop change and
 * never puts it back. `preventDefault()` on the summary removes the native
 * toggle entirely, leaving `open` as the single driver — and keyboard Enter /
 * Space on a `<summary>` dispatch a click, so the affordance stays reachable
 * without inventing any ARIA.
 *
 * The children stay mounted when collapsed (that is what `<details>` does), so
 * collapsing never discards a tool row's expanded body.
 */
function TurnProgressHead({
  items,
  zone,
  clock,
  forcedOpen,
  userOpen,
  onUserOpenChange,
  children,
}: {
  /** The whole turn's items — the live action clause reads the newest call. */
  items: readonly TurnItem[];
  /** The turn's state, always. What this head is allowed to SAY about it is `clock`. */
  zone: TurnWorkZone;
  /**
   * May this head print the turn's DURATION? True for the turn's first folding
   * group and no other.
   *
   * That is T107's defect restated as a prop: two groups wearing the same
   * duration is what 「最后一个理应显示 N 个步骤的地方却显示工作区，有点不协调」
   * was about, and a turn grows a second group whenever a notice lands
   * mid-process.
   *
   * ⚠️ It gates the NUMBER, not the line. Passing `zone: null` here is what the
   * first cut did, and it made every non-first head a chevron with no text —
   * the same blank row the missing clock produced (2026-09-22). A head always
   * knows what state the turn is in; only one of them knows it in seconds.
   */
  clock: boolean;
  /** An unanswered permission/question is inside: the group may not close. */
  forcedOpen: boolean;
  userOpen: boolean | null;
  onUserOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  const open = turnWorkGroupOpen({ forcedOpen, userOpen });

  // Decision 034: the head reports the turn's CLOCK, and nothing else. The step
  // count and the call count that used to sit here were cut by the user on
  // sight (「折叠头就不要那个 73 次工具调用了。也不要显示什么已处理 xxx 个步骤」)
  // — they described the fold, and what a reader watches during a long wait is
  // whether the turn is still moving.
  //
  // Without the clock it reports the STATE and stops there — 「工作中」 /
  // 「已工作」, the bare forms of the very same two keys. That case is a head
  // that is not the turn's first, and a turn whose span nothing measured; both
  // used to render an empty row, which is what the user saw as 「折叠头没了」.
  const running = zone.kind === 'working';
  const showsSpinner = running && clock;
  const liveAction = showsSpinner ? deriveTurnCurrentAction(items) : null;
  const line = !clock
    ? running
      ? workingHeadText(t, null)
      : workedHeadText(t, null)
    : zone.kind === 'working'
      ? joinTurnProgressLine(`✻ ${workingHeadText(t, zone.elapsed)}`, [
          // The live clause, moved up from the work zone row with the clock it
          // belongs to: a clock with no subject reads as a stopwatch, and this
          // is the sentence that says the turn is doing something rather than
          // merely still open.
          liveAction ? t(liveAction.verb) : null,
        ])
      : workedHeadText(t, zone.worked);

  return (
    <details className={turnBodyClass()} open={open}>
      <summary
        className={turnWorkGroupSummaryClass()}
        onClick={(event) => {
          event.preventDefault();
          onUserOpenChange(!open);
        }}
      >
        {showsSpinner && <Spinner className="size-3.5 shrink-0" />}
        <span className="min-w-0 truncate" title={line}>
          {line}
        </span>
        <ChevronRight
          className={cn('size-3.5 shrink-0 transition-transform duration-150', open && 'rotate-90')}
          aria-hidden
        />
      </summary>
      <div className={cn(turnProcessShellClass(), 'pt-2')}>{children}</div>
    </details>
  );
}

/**
 * The turn's WORK ZONE row: one line pinned after the turn's last paragraph,
 * carrying everything that is true of the TURN rather than of one process
 * group (T113, user decision 2026-09-21).
 *
 * Two states, and they are a relay, never both:
 *
 *  - **running** — a spinner and 「✻ 工作中 47 秒」, closed by what the turn is
 *    doing right now. That clause is `deriveTurnCurrentAction`, which falls
 *    back to the last finished call rather than returning `null` between two
 *    calls (decision 031); without it the line blinks off and on several times
 *    a second while the seconds keep counting, which reads as a hang.
 *  - **settled** — 「✻ 完成于 17:05 · 8 次工具调用 · 思考 12 秒」. T113's list was
 *    four figures; decision 034 moved the first of them (the duration) up to
 *    the process head, because that is the one a reader wants WHILE the turn
 *    runs. The list is still CLOSED — token usage was considered at the same
 *    time and deliberately left off — and each figure is dropped individually
 *    when it was never measured, never printed as a zero (A07 `:2399`).
 *
 * It does not decide whether it renders: `deriveTurnWorkZone` returns `null`
 * for a settled turn that replayed no timing, and the caller drops the row.
 */
function TurnWorkZoneRow({ zone }: { zone: TurnWorkZone }) {
  const { t } = useI18n();

  // Decision 034: the RUNNING state is gone from this row. Its two parts — the
  // ticking clock and the live action clause — moved up to the process head,
  // where zcode puts them and where a reader watching a long wait is already
  // looking. A running turn therefore renders nothing here at all, rather than
  // a second line repeating the first.
  if (zone.kind === 'working') return null;
  // And nothing when the turn has no BILL to present either. `deriveTurnWorkZone`
  // stopped returning `null` for that case so the head above could still name
  // the state; the silence it used to signal belongs here, where a row with no
  // clause would be a lone 「✻」.
  if (zone.completedAtMs === null && zone.toolCalls === null && zone.thinkingMs === null) {
    return null;
  }

  const line = joinTurnProgressLine('✻', [
    // The duration went up to the head with the running clock. What is left is
    // the turn's BILL — the three figures that are only knowable once it ends —
    // and printing 「已工作 N 秒」 in both places is the T107 defect this split
    // exists to avoid.
    zone.completedAtMs === null
      ? null
      : t('Completed at {{time}}', { time: formatAbsoluteTime(zone.completedAtMs) }),
    zone.toolCalls === null
      ? null
      : t(zone.toolCalls === 1 ? '{{count}} tool call' : '{{count}} tool calls', {
          count: zone.toolCalls,
        }),
    // Shared with the head this row replaced, so a minute is written the same
    // way in both places and the two cannot word 「思考」 differently.
    formatThinkingClause(zone.thinkingMs, t),
  ]);
  return (
    <div className={turnWorkZoneClass()}>
      <span className="min-w-0 truncate" title={line}>
        {line}
      </span>
    </div>
  );
}

/**
 * 「工作中」 / 「工作中 47 秒」 / 「工作中 1 分 6 秒」.
 *
 * A function rather than a fourth nested ternary at the call site, and its four
 * keys are literals so `i18nCoverage.test.ts` can see them. The bare form is
 * for a turn running with no clock of its own — a session that was already in
 * flight when this window opened replays no `message.started`, and 「工作中 0
 * 秒」 would be a number nobody measured.
 *
 * T113 moved its caller from the group head to the work zone row, which is why
 * `t` is a parameter: the row hands it the localized translator and the same
 * four keys render 「工作中 47 秒」.
 */
function workingHeadText(
  t: (key: string, params?: Record<string, string | number>) => string,
  elapsed: { minutes: number; seconds: number } | null
): string {
  if (!elapsed) return t('Working');
  if (elapsed.minutes === 0) return t('Working {{seconds}}s', { seconds: elapsed.seconds });
  if (elapsed.seconds === 0) return t('Working {{minutes}}m', { minutes: elapsed.minutes });
  return t('Working {{minutes}}m {{seconds}}s', {
    minutes: elapsed.minutes,
    seconds: elapsed.seconds,
  });
}

/**
 * 「已工作 54 秒」 / 「已工作 1 分 6 秒」 — the settled twin of the above.
 *
 * Three literal keys and not one `{{duration}}` slot, for the reason the whole
 * turn-timing vocabulary carries: English writes "1m 6s" and Chinese writes
 * 「1 分 6 秒」, so the unit words belong to the CATALOG.
 *
 * The bare fourth (`Worked`, 「已工作」) answers two callers, and it is a
 * sentence rather than a zero: a head that is not the turn's first, which must
 * not repeat the number, and a turn whose span nothing measured. The second one
 * is why this function used to have no bare form at all — `deriveTurnWorkZone`
 * signalled it by returning `null`, which deleted the head's whole line
 * (2026-09-22).
 */
function workedHeadText(
  t: (key: string, params?: Record<string, string | number>) => string,
  worked: { minutes: number; seconds: number } | null
): string {
  if (!worked) return t('Worked');
  if (worked.minutes === 0) return t('Worked for {{seconds}}s', { seconds: worked.seconds });
  if (worked.seconds === 0) return t('Worked for {{minutes}}m', { minutes: worked.minutes });
  return t('Worked for {{minutes}}m {{seconds}}s', {
    minutes: worked.minutes,
    seconds: worked.seconds,
  });
}

const ChatTurn = memo(function ChatTurn({
  turn,
  sessionId,
  isLastTurn,
  sessionStatus,
  inFlightSession,
  sendStatus,
  pendingReply,
  statusOwnedByPendingHead,
  baselineKnown,
  baselineMessageId,
  retry,
  retryDelegateName,
  nowMs,
  getMetadata,
  thinkingEnabled,
  repoName,
  getThinkingDurationMs,
  getThinkingTiming,
}: ChatTurnProps) {
  const { t } = useI18n();
  // `null` until the user clicks: "no opinion yet" has to be distinguishable
  // from "chose closed", or the auto-collapse and a deliberate collapse would
  // be the same state and rule 2 of `turnWorkGroupOpen` could never hold. Held
  // HERE rather than in the head so it survives the head swapping shape — see
  // `TurnProgressHead`'s `userOpen` note.
  const [workGroupUserOpen, setWorkGroupUserOpen] = useState<Record<string, boolean>>({});
  // One flatten per turn, feeding both the render and the copy payload (F7):
  // the copy builder's `Turn` overload used to re-run `flattenTurnItems` — and
  // through it `groupTimeline`/`pairToolBlocks` over every block — a second
  // time on every render, clock ticks included.
  const items = useMemo(() => flattenTurnItems(turn), [turn]);
  const segments = useMemo(() => segmentTurnBody(items), [items]);
  const copyText = useMemo(() => buildTurnCopyTextFromItems(items), [items]);

  // Turn-level metadata: the LAST assistant message's, because that is the one
  // whose completion ends the turn. A turn with two assistant messages (a
  // permission interrupt splits one) therefore reports the final segment's
  // latency rather than wall-clock across the pause — which is the more honest
  // of the two, since the pause is the user's own thinking time.
  const lastAssistant = useMemo(() => findLastAssistant(turn.body), [turn.body]);
  const firstAssistant = useMemo(() => findFirstAssistant(turn.body), [turn.body]);
  const metadata = lastAssistant ? getMetadata(lastAssistant.id) : undefined;
  // Whole-turn metadata, for the two ownership questions that need evidence
  // rather than the absence of a latency (F2 / F4).
  //
  // A replayed row has no registry entry, and falls back to the stamp the
  // history file dated it with — as `completedAt` ONLY. Pi dates an entry when
  // it writes it, so there is no start to claim, and claiming one would make
  // `earliestTurnStartMs` take the first assistant's COMPLETION as the turn's
  // origin and report a 6-minute turn as a few seconds.
  const bodyMetadata = useMemo(
    () =>
      turn.body.map(
        (message) =>
          getMetadata(message.id) ??
          (message.timestamp === undefined ? undefined : { completedAt: message.timestamp })
      ),
    [turn.body, getMetadata]
  );

  // ---- Head slot state (§4.7) ----

  // Three ways a turn can be ACTIVE. Note that these decide whether a clock
  // exists, not what it reads — `turnStartedAtMs` below owns the reading, and
  // deliberately does not branch the same way (see its note).
  //
  // `!turnComplete` guards `streamStartedAt` the same way the parent's send
  // binding guards the snapshot: once this turn has its latency, a
  // still-`running` session status belongs to the NEXT turn, not this one.
  //
  // F12: the gate is `inFlightSession`, not `isActiveTurn` — under
  // `waiting_permission` / `waiting_question` the latter is false, which used
  // to drop `streamStartedAt`, drop the status row, and (before F1) drop the
  // head entirely, unmounting the `Collapsible` that holds the authorization
  // card the user is being asked to answer.
  const turnComplete = metadata?.latencyMs != null;
  const inFlight = isLastTurn && sendStatus != null;
  const streamStartedAt =
    !inFlight && isLastTurn && inFlightSession && !turnComplete && firstAssistant
      ? (getMetadata(firstAssistant.id)?.startedAt ?? null)
      : null;
  // F2 (2026-08-18 §4.5): the third way a turn can be active. `inFlight` dies
  // with the composer's snapshot and `streamStartedAt` needs a first assistant
  // message — so a turn the Host admitted, never answered, and never failed had
  // NEITHER, and its head silently disappeared at the ceiling. That is the
  // "lost stopwatch" defect: the turn was still running, and the UI stopped
  // showing it (taking the Stop button with it).
  const pendingActive = isLastTurn && pendingReply != null;
  const turnActive = inFlight || streamStartedAt != null || pendingActive;
  // The status ROW's clock, and only it: `composerSendingLine`'s wording and
  // its two silence tiers (`SLOW_HINT` / `STALLED_HINT`) ask "how long has THIS
  // PHASE been silent", which is what the composer's per-phase ticker measures.
  // The turn head asks a different question and has its own clock below; the
  // two are not interchangeable and were never meant to be one value.
  const elapsedSeconds =
    inFlight && sendStatus
      ? sendStatus.elapsedSeconds
      : streamStartedAt != null
        ? Math.max(0, Math.floor((nowMs - streamStartedAt) / 1000))
        : // Recomputed from the arm time rather than carried forward, so no
          // second ticker has to exist: `useSecondsTick` above already runs for
          // exactly as long as this watch does.
          pendingActive && pendingReply
          ? Math.max(0, Math.floor((nowMs - pendingReply.turnStartedAtMs) / 1000))
          : 0;

  /**
   * The turn's ORIGIN: when the user pressed Send, as well as anything here
   * knows it. One value, read by the running head and by the finished one.
   *
   * Measured defect, 2026-09-19: a 7936ms turn whose head counted 1s. The head
   * used to take whichever of the three clocks above happened to be live, and
   * those count from three different instants — so the first byte arriving
   * swapped the composer's ticker for the first assistant message's
   * `message.started` and the number on screen fell from 3 back to 1; then the
   * finished turn reported the assistant message's own span (~600ms) and threw
   * the 7.3s wait away. The wait is the part the user is complaining about.
   *
   * Priority, and why it is a priority rather than a `Math.min`:
   *
   *  1. **the user message's own `message.started`** — the Host's echo of this
   *     prompt (`projector.ts`). It is the only candidate that survives the
   *     whole turn: the snapshot below is torn down at the first byte, and the
   *     watch below that is cleared by the next send. Anchoring on it means
   *     the origin cannot move mid-turn, which is what the "never goes
   *     backwards" property actually rests on.
   *  2. **the send snapshot's commit stamp** — for the window BEFORE that echo
   *     lands, where the turn on screen is the composer's optimistic
   *     `pending-user:` bubble and no Host stamp exists yet.
   *  3. **the pending-reply watch** — after the silence ceiling, where the
   *     snapshot is gone and the Host has still said nothing.
   *  4. **the replayed user row's own stamp** (`ChatMessage.timestamp`) — LAST,
   *     because it is the only candidate that is not a measurement this window
   *     took. It is the date Pi wrote the prompt entry, so it may never
   *     displace a live reading — and it is the reason a restored turn has a
   *     clock at all, which is what 2026-09-22 found missing when the process
   *     fold head was made to report the clock and nothing else.
   *
   * Known residual, recorded rather than hidden: at the handover from (2) to
   * (1) the origin moves forward by the Agent-Host start plus one IPC round
   * trip, so the count can step back by that much, once, early in the turn.
   * Closing it needs the commit stamp carried onto the authoritative user
   * message, which is a red-line-store field (`chatSessions.ts` keeps no
   * timestamps at all); it is not done here.
   *
   * `null` is a real answer — a restored history turn replays none of these —
   * and it makes the head say a bare 「Working」 / fall back to a step count
   * rather than print a second nobody measured.
   */
  const turnStartedAtMs =
    (turn.user ? (getMetadata(turn.user.id)?.startedAt ?? null) : null) ??
    (inFlight && sendStatus ? sendStatus.turnStartedAtMs : null) ??
    (pendingActive && pendingReply ? pendingReply.turnStartedAtMs : null) ??
    turn.user?.timestamp ??
    null;

  // T-33 (review F1, round 2): the turn's progress stamp — block count PLUS
  // streamed characters. A resumed call may append into an EXISTING text
  // block (`appendTextBlock` mutates `text`, block count unchanged), so a
  // count-only stamp could not see that kind of recovery and the banner
  // outlived the retry for the rest of the turn.
  const turnProgressStamp = turn.body.reduce(
    (stamp, message) =>
      message.blocks.reduce((sum, block) => sum + 1 + (block.text?.length ?? 0), stamp),
    0
  );
  const turnHasBlocks = turn.body.some((message) => message.blocks.length > 0);

  // T-33 (review F1): the stamp snapshotted at the moment THIS retry payload
  // appeared — every api_retry event writes a fresh `retry` object into the
  // red-line store, so reference identity is the retry's epoch. Progress
  // after the snapshot means the retried call got through; output that
  // predates it (a tool call earlier in the turn) proves nothing and must not
  // suppress the banner. Residual (accepted): if the retry and its first
  // post-retry output land in the same React commit, the snapshot includes
  // that output and this attempt's banner is skipped — one-attempt window,
  // self-healing on the next api_retry event.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional capture — the stamp at the retry's arrival, not the live one
  const progressStampAtRetry = useMemo(() => turnProgressStamp, [retry]);

  // T-33: the banner reads `inFlightSession`, not `turnActive` — it renders
  // attempt counts, not a clock, so a session left running before this window
  // opened can still report its retry (the status row below stays absent
  // there by design). `outputSinceRetry` is what makes it disappear the
  // moment the retried call succeeds — see `retryBanner.ts`.
  const retryBanner = deriveRetryBanner(
    {
      retry,
      inFlight: inFlightSession,
      outputSinceRetry: turnProgressStamp > progressStampAtRetry,
      // T093: the ticking clock, so `retryAt` becomes a countdown instead of a
      // number formatted once and left there. `STATIC_NOW_MS` on a turn that
      // is not the last one degrades to the old static wording by itself.
      nowMs,
      delegateName: retryDelegateName,
    },
    // T067 (D21): the banner words itself from the catalog now, so it needs
    // the same translator the composer line below it already had.
    t
  );

  // A turn that is running with NEITHER clock (a session left running before
  // this window opened) gets no status row rather than one frozen at "0s" —
  // the composer showed nothing in that case either, so no information is lost.
  const status = deriveTurnStatus(
    {
      active: turnActive,
      phase: sendStatus?.phase ?? 'awaiting',
      elapsedSeconds,
      budgetMs: sendStatus?.budgetMs ?? DEFAULT_REPLY_BUDGET_MS,
      attachmentCount: sendStatus?.attachmentCount ?? 0,
      attachmentBytes: sendStatus?.attachmentBytes ?? 0,
      // F456 §7.4: `?? 0` is the "session already running when this window
      // opened" path the fallbacks above serve — and 0 omits the `↑` rather than
      // printing `↑ 0 chars`, so a missing snapshot never reads as an empty
      // prompt. The pending head below needs no such fallback: its snapshot is a
      // required prop.
      promptChars: sendStatus?.promptChars ?? 0,
      // F06: counted off THIS turn's own body, so it needs no snapshot and no
      // reset — a new send opens a new turn whose body starts empty. It is
      // available in the fallback case above too (a session already running when
      // this window opened has no `sendStatus`, but its reply text is still on
      // screen and still countable).
      replyChars: countAssistantReplyChars(turn.body),
      // T093: `retryAt` and the clock ride along so this line counts the same
      // second the banner above it does.
      retry: retry
        ? {
            attempt: retry.attempt,
            maxRetries: retry.maxRetries,
            ...(retry.retryAt === undefined ? {} : { retryAt: retry.retryAt }),
            delayMs: retry.delayMs,
          }
        : null,
      nowMs,
      hasBlocks: turnHasBlocks,
      // F4: a session failure belongs to the turn that was actually running when
      // it happened — never to the completed turn that merely happens to be last
      // while the next send's user echo is still in flight, and never to a
      // restored history turn. `ownsSessionFailure` holds that whole judgement;
      // a failure with no owning turn stays with the session-level block below
      // (§9-ζ, position unchanged).
      failed: ownsSessionFailure({
        isLastTurn,
        sessionFailed: sessionStatus === 'failed',
        hasUser: turn.user != null,
        bodyEmpty: turn.body.length === 0,
        userMessageId: turn.user?.id ?? null,
        baselineKnown,
        baselineMessageId,
        turnComplete,
        hasLiveMessage: hasLiveTurnEvidence(bodyMetadata),
      }),
    },
    t
  );

  /*
   * T12-b retired `deriveTurnHeadModel` and the `status -> workedFor -> stats
   * -> thought` degradation chain behind it.
   *
   * F1 had built that chain so a RESTORED history turn — which replays no T-06
   * metadata, so it has neither a status nor a latency — would still print
   * something about a turn that plainly did work (`2 tools`, or the bare
   * `Thought` label). Under pi-app's model that is no longer a gap to fill: a
   * finished turn says nothing about itself, restored or not, so the fallback
   * rungs have nothing left to fall back FROM.
   *
   * What survives is the top rung alone, and it is the one that was never
   * cosmetic: `status` is the only thing on screen saying the turn is still
   * running, stalled, retrying or failed. F2's "lost stopwatch" defect was
   * precisely this row going missing while work continued, so it is rendered
   * below on its own rather than folded into anything.
   */

  // F-C3. The derivation itself is a pure function so the node suite can
  // truth-table it; what is decided HERE is only which inputs it gets:
  //
  //  - `inFlightSession`, not `isActiveTurn` — a permission wait is still in
  //    flight, and the narrower predicate made the gate flip Markdown on and
  //    off around every authorization round-trip;
  //  - `&& isLastTurn` — the session-level flag is handed to every turn (the
  //    two ticking props above are narrowed for exactly this reason), so
  //    without it a new turn dropped every EARLIER answer in the session back
  //    to plain text until it finished;
  //  - per-message metadata, so a message that completes mid-turn converts
  //    immediately instead of waiting for the turn to end.
  const streamingBlockIdByMessage = useMemo(
    () =>
      deriveStreamingBlockIds({
        turnInFlight: inFlightSession && isLastTurn,
        messages: turn.body.map((message, index) => {
          const meta = bodyMetadata[index];
          return {
            id: message.id,
            lastBlockId:
              message.blocks.length > 0 ? message.blocks[message.blocks.length - 1].id : null,
            tracked: meta != null,
            completed: meta?.completedAt != null,
          };
        }),
      }),
    [turn.body, bodyMetadata, inFlightSession, isLastTurn]
  );

  // F13: an in-flight turn's prose is half an answer, and a Copy button that
  // silently yields it is worse than no button — the clipboard gives no sign
  // the text was truncated. Restored history turns are NOT in flight, so they
  // keep theirs. (T12-b moved this from the meta row to the hover strip; the
  // rule is unchanged, only its host is.)
  const actionsCopyText = turnActive ? '' : copyText;
  // A zero-height collapsed strip costs nothing, but the turn body's 10px gap
  // is spent on it either way — so it exists only when it has an action to
  // offer. The rule was already "an action, not a statistic" (`completedAt`
  // alone never earned the strip); T114 makes it the only rule there is, since
  // copy is now the strip's entire contents.
  const showActions = actionsCopyText.length > 0;

  const renderItem = (item: TurnItem) => (
    <TurnItemView
      key={turnItemKey(item)}
      item={item}
      sessionId={sessionId}
      thinkingEnabled={thinkingEnabled}
      repoName={repoName}
      streamingBlockId={streamingBlockIdForItem(item, streamingBlockIdByMessage)}
      getThinkingDurationMs={getThinkingDurationMs}
    />
  );

  // Between two assistant messages (a tool result or permission wait splits
  // them) the last one already carries a latency while the turn is still in
  // flight; only the session status tells those apart. No latency is needed
  // otherwise, so a restored history turn is settled from its first render and
  // therefore mounts collapsed.
  //
  // `&& !statusOwnedByPendingHead` closes the one window where the session
  // status lies about WHICH turn is running: between `chat.send` and the Host
  // echoing the user message back, the session is in flight but the turn that
  // send opened does not exist yet, so the previous (finished) turn is still
  // `isLastTurn`. Without this it un-settled itself for the length of the
  // handshake — reverting 「已工作 57 秒」 to 「工作中」 and re-expanding a group
  // the user had watched collapse, on a turn that ended a minute ago.
  // `pendingSendStatus != null` is exactly "a send is in flight whose turn has
  // not been echoed yet" (`deriveSendStatusBinding`), which is the fact needed;
  // `turnComplete` cannot serve here, for the reason the paragraph above gives.
  const processSettled =
    !turnActive && !(isLastTurn && inFlightSession && !statusOwnedByPendingHead);
  // T107 replaces the four buckets with ordered, independently folded sections.
  //
  // Decision 033 D1 passes `processSettled` in as well, and it is the SECOND
  // dependency on purpose: the split's answer genuinely changes when the turn
  // stops (that one extraction is the turn's only structural change), so a memo
  // keyed on `segments` alone would freeze the streaming shape forever.
  const workSections = useMemo(
    () => splitTurnWorkGroup(segments, processSettled),
    [segments, processSettled]
  );
  // The turn's clock, in ONE derivation for both of the head's states. Running
  // it counts to `nowMs`; finished it counts to the turn's last completion (or,
  // for a stopped/failed turn, to the last stamp on record) — but from the SAME
  // origin either way, which is what makes the head's number monotone across
  // the first-byte handover instead of resetting there. `null` means "omit the
  // number", never "0s" (`deriveTurnElapsedMs`'s own rule).
  //
  // Not memoized: while the turn runs this is a function of the one-second
  // tick, so a `useMemo` keyed on `nowMs` would only add a comparison — the
  // same reasoning `turnThinkingMs` below already carries.
  const turnRunning = !processSettled;
  const turnElapsedMs = deriveTurnElapsedMs({
    startedAtMs: turnStartedAtMs,
    metadata: bodyMetadata,
    nowMs,
    running: turnRunning,
  });
  // Split back out for the head's two props. Whole-turn span, NOT the last
  // message's latency: a turn split by a tool result or an authorization wait
  // is several messages, and reporting the final one's latency told a
  // two-minute turn it took four seconds.
  const workedMs = turnRunning ? null : turnElapsedMs;
  // The row's thinking total, per-TURN by construction: the thinking registry
  // is keyed by block id, so reading this turn's own messages is what scopes
  // it, with no snapshot to arm and no counter to reset between sends.
  //
  // T113 removed `turnTokens` (`sumTurnTokens` over the same messages) from
  // beside it. The token totals were the head's; the work zone row that
  // replaced the head carries the four figures the user named, and usage is
  // deliberately not one of them — see the `turnProgress` import note.
  const thinkingSpans = useMemo(
    () =>
      turn.body.flatMap((message) =>
        message.blocks
          .filter((block) => block.type === 'thinking')
          .map((block) => getThinkingTiming(block.id))
      ),
    [turn.body, getThinkingTiming]
  );
  // Not memoized on `nowMs`: an unfinished thought is measured against the
  // clock, so this is a per-tick value by definition and a `useMemo` keyed on
  // the tick would only add a comparison.
  const turnThinkingMs = sumTurnThinkingMs(thinkingSpans, { nowMs, live: !processSettled });
  // `turnElapsedMs === null` is what says no clock exists — a session that was
  // already running when this window opened replays no origin, and the row must
  // not report that as 「工作中 0 秒」. Gated on `turnRunning` rather than
  // `turnActive` so it matches the branch `deriveTurnWorkZone` takes on the very
  // same flag: the two used to disagree in the window between them, which left
  // the line saying a bare 「工作中」 while a clock was available.
  //
  // Renamed from `headElapsedSeconds` by T113: it no longer feeds a head.
  const liveElapsedSeconds =
    turnRunning && turnElapsedMs !== null ? Math.floor(turnElapsedMs / 1000) : null;

  // The turn's own line, pinned after its last paragraph. `running` is
  // `turnRunning` and nothing else: `processSettled` already folds in
  // `statusOwnedByPendingHead`, which is what makes this row and
  // `PendingTurnHead` a relay instead of two rows counting seconds at once.
  // `null` means the turn has nothing measured to report and no row renders —
  // never a fabricated zero.
  const workZone = deriveTurnWorkZone({
    running: turnRunning,
    elapsedSeconds: liveElapsedSeconds,
    workedMs,
    // The LAST assistant message's stamp, for the same reason `metadata` is
    // that message's: its completion is what ends the turn. Falls back to the
    // replayed row's own date, which is the same instant recorded one layer
    // down — a turn restored from history says 「完成于 17:05」 rather than
    // dropping the clause.
    completedAtMs: metadata?.completedAt ?? lastAssistant?.timestamp ?? null,
    toolCalls: countTurnToolCalls(items),
    thinkingMs: turnThinkingMs,
  });

  const renderSegment = (segment: TurnSegment<TurnItem>, intermediate = false) => {
    // Keyed off the segment's FIRST item, not its index: an index key would
    // remount every later segment the moment a new one opened mid-stream,
    // throwing away the expanded tool bodies inside them.
    const key = `${segment.kind}:${turnItemKey(segment.items[0])}`;
    if (segment.kind === 'answer') {
      // T12: bare prose. The role signal lives on the user side's shape; the
      // container ring retired with the box model it belonged to (Q14).
      //
      // Intermediate prose (inside the process group, before the final
      // reply) dims to tier 2 so the eye is drawn to the final answer
      // below. Standalone answer segments keep the brightest rung.
      const tone = intermediate ? turnIntermediateToneClass() : turnAnswerToneClass();
      return (
        <div key={key} className={cn(turnBodyClass(), tone)}>
          {segment.items.map(renderItem)}
        </div>
      );
    }
    if (segment.kind === 'notice') {
      // `NoticeMessage` brings its own Alert border, so a notice stays OUT of
      // the answer container — nesting the two would be a box in a box.
      return (
        <div key={key} className={turnBodyClass()}>
          {segment.items.map(renderItem)}
        </div>
      );
    }
    /**
     * The process segment: tool runs, thinking, and authorization cards, in
     * block order, on the dim rung of the reading ladder.
     *
     * It no longer decides its own visibility. 2026-09-10 gave each process
     * segment its own `<details>`, which put one 「已处理 N 个步骤」 line between
     * every pair of paragraphs; 2026-09-18 replaced that with ONE group per
     * turn (`splitTurnWorkGroup`), so this function renders a plain panel and
     * the group above it decides whether it is on screen.
     *
     * A process segment can also render OUTSIDE the group — while a turn
     * streams, a tool called after the last paragraph sits in `trailing` until
     * the next paragraph arrives. That is why the panel carries no visibility
     * logic of its own: it has to look the same in both places.
     *
     * NO `overflow-hidden` here, ever: it would create a containing block and
     * silently break `position: sticky` anywhere above it
     * (`chatTimelineLayout.ts`'s standing prohibition).
     */
    return (
      <div
        key={key}
        className={cn(turnProcessShellClass(), turnBodyClass(), turnProcessToneClass())}
      >
        {segment.items.map(renderItem)}
      </div>
    );
  };

  // Decision 034: the turn's clock rides the FIRST process head that actually
  // folds, and no other. A latch rather than an index test because a section
  // can decline to render a head at all (`turnProcessGroupFolds`), and keying
  // on `index === 0` would hand the clock to a group that never draws one —
  // leaving the turn with no visible clock while it runs.
  //
  // Reset on every render and consumed during the same synchronous map, so it
  // never outlives the pass that sets it.
  let clockClaimed = false;

  return (
    <section className={chatTurnClass()}>
      {/* T12: an ordinary first row, not a pinned band. The `sticky top-0`
          wrapper that used to be here is gone along with the clamp and the
          toggle it forced (`chatTimelineLayout.ts` head note). What it bought —
          "you can always see which prompt you are reading the reply to" — is
          paid for instead by the reading rhythm: 20px between turns against
          12px / 8px inside one. */}
      {turn.user && <UserBubble message={turn.user} />}
      <div className={turnBodyClass()}>
        {/* Q1 keeps the final answer and notices outside the process groups;
            intermediate prose joins the process it describes. Turn-level
            progress remains on the trailing work-zone row (T113). */}
        {workSections.map((section) => {
          if (section.kind === 'finalAnswer') {
            // Decision 033 D1: the reply keeps its ordinary answer styling (no
            // new border, background or container — D8 is explicit that it
            // differs from intermediate prose by COLOUR alone), and the ONE
            // thing added is the divider that announces the extraction. It is
            // rendered here rather than inside `renderSegment` because it
            // belongs to the placement decision `splitTurnWorkGroup` made, not
            // to the segment: a turn whose final answer sits mid-flow for any
            // other reason must not grow a second divider.
            return (
              <Fragment key={turnItemKey(section.segment.items[0])}>
                <div className={turnFinalAnswerDividerClass()}>
                  <span className="shrink-0">{t('Final output')}</span>
                  <span className="h-px min-w-0 flex-1 bg-border" aria-hidden />
                </div>
                {renderSegment(section.segment)}
              </Fragment>
            );
          }
          if (section.kind !== 'processGroup') return renderSegment(section.segment);
          // First-item identity survives appended tools and later answers. Each
          // group remembers its own click, even while authorization pins it open.
          const groupKey = turnItemKey(section.segments[0].items[0]);
          const groupedProcessItems = section.segments.flatMap((segment) => segment.items);
          // Inside the group, answer segments are INTERMEDIATE prose — dimmed,
          // so the final answer below stands out.
          const renderGroupSegment = (segment: TurnSegment<TurnItem>) =>
            renderSegment(segment, true);
          // T112: one step is its own best summary, so it renders where it
          // stands — no head, no chevron, nothing to click. The group grows a
          // fold the moment a second step lands, and `groupKey` is unchanged
          // across that transition, so the segments below are not remounted by
          // it. `turnProcessGroupFolds` owns the threshold; deciding it here
          // would fork the rule away from the one the head is built for.
          if (!turnProcessGroupFolds(groupedProcessItems)) {
            return <Fragment key={groupKey}>{section.segments.map(renderGroupSegment)}</Fragment>;
          }
          const groupForcedOpen = turnWorkGroupAwaitsUser(section.segments);
          const headClock = !clockClaimed;
          clockClaimed = true;
          return (
            <TurnProgressHead
              key={groupKey}
              items={items}
              zone={workZone}
              clock={headClock}
              forcedOpen={groupForcedOpen}
              userOpen={workGroupUserOpen[groupKey] ?? null}
              onUserOpenChange={(open) =>
                setWorkGroupUserOpen((previous) => ({ ...previous, [groupKey]: open }))
              }
            >
              {section.segments.map(renderGroupSegment)}
            </TurnProgressHead>
          );
        })}
        {/* T113: after the last paragraph, before the chrome that talks about
            the session rather than the turn. This is the 「工作区固定在末尾」 the
            user asked for — the duration stops moving from group to group as a
            turn grows. */}
        <TurnWorkZoneRow zone={workZone} />
        {retryBanner && <RetryBanner view={retryBanner} sessionId={sessionId} />}
        {/* T12-b: the running status, and ONLY while it is running. FB6's
            position is kept — under the output it describes, not above it —
            but the row no longer has a completed state (`Worked for 12s ·
            2 tools` retired with the meta row). A finished turn renders
            nothing here at all, which is the point of the change. */}
        {status && !(isLastTurn && (inFlightSession || statusOwnedByPendingHead)) && (
          <div className={turnHeadClass()}>
            <TurnStatusContent status={status} />
          </div>
        )}
        {/* T12-b: the hover strip, revealed by hovering anywhere in the turn
            (`group/turn` on the section above). Deliberately hover-only per the
            2026-08-29 user decision; the accessibility cost that buys is
            recorded on `turnActionsSlotClass()`.

            2026-08-30: the strip RESERVES its height and only fades, so
            hovering no longer pushes the turn below it down. The reasoning for
            the collapse it replaces — and why the user overruled it — is on
            `turnActionsSlotClass()` too. T114 does not touch either of those:
            the strip is one control shorter, not a different strip.

            T114: copy, and nothing else. The wall clock T12-b re-homed here is
            on the work zone row above now (「完成于 17:05」), where it is
            readable without a pointer — so keeping it here would print the same
            timestamp twice on the same turn, once visibly and once on hover. */}
        {showActions && (
          <div className={turnActionsSlotClass()}>
            <div className={turnActionsInnerClass()}>
              <TurnCopyButton text={actionsCopyText} />
            </div>
          </div>
        )}
      </div>
    </section>
  );
});

/**
 * Fallback reply budget for an in-flight turn with no composer snapshot of its
 * own. F456 §7.2 retired the `(up to Ns)` clause this used to feed, so the
 * value now reaches a parameter that is accepted and ignored; it is still
 * passed so `[F4-4]` can assert that passing it changes nothing.
 *
 * F2 (2026-08-18 §1.3): re-sourced from the retired byte-scaled `sendTimeoutMs(0)`
 * (45s) to the renderer's silence ceiling. This was `sendTimeoutMs`'s LAST
 * consumer, so the whole formula retires with this line. The figure is no
 * longer a prediction of when anything happens — reaching it is not a verdict
 * (see `sendBudgets.ts`) — which is why the `slow` copy above 45s deliberately
 * stops printing it at all.
 */
const DEFAULT_REPLY_BUDGET_MS = SEND_SILENCE_CEILING_MS;

function findLastAssistant(messages: readonly ChatMessage[]): ChatMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'assistant') return messages[index];
  }
  return null;
}

function findFirstAssistant(messages: readonly ChatMessage[]): ChatMessage | null {
  return messages.find((message) => message.role === 'assistant') ?? null;
}

/**
 * Head slot for a send whose turn has not been echoed back yet (§3.3).
 *
 * The seconds here come from the composer's own ticker, not `useSecondsTick` —
 * nothing has streamed yet, so there is no `message.started` to count from.
 */
function PendingTurnHead({
  sessionId,
  sendStatus,
  retry,
  retryDelegateName,
  nowMs,
}: {
  /** T093: whose turn the banner's Give-up button must abort — this timeline's. */
  sessionId: string;
  sendStatus: TurnSendStatus;
  retry: SessionRetryInfo | null;
  retryDelegateName: string | null;
  /** The timeline's `useSecondsTick`; it runs throughout this window (`sendStatus != null`). */
  nowMs: number;
}) {
  const { t } = useI18n();
  const status = deriveTurnStatus(
    {
      active: true,
      phase: sendStatus.phase,
      elapsedSeconds: sendStatus.elapsedSeconds,
      budgetMs: sendStatus.budgetMs,
      attachmentCount: sendStatus.attachmentCount,
      attachmentBytes: sendStatus.attachmentBytes,
      // F456 §7.4: the EARLIEST window this count can appear in, and the one
      // where it says the most — no user bubble exists yet, so `↑ 428 chars` is
      // the only thing on screen describing what was just sent.
      promptChars: sendStatus.promptChars,
      // T093: same countdown inputs the attached turn passes.
      retry: retry
        ? {
            attempt: retry.attempt,
            maxRetries: retry.maxRetries,
            ...(retry.retryAt === undefined ? {} : { retryAt: retry.retryAt }),
            delayMs: retry.delayMs,
          }
        : null,
      nowMs,
      hasBlocks: false,
    },
    t
  );
  // T-33: the pending head's existence is itself the in-flight proof, and no
  // turn exists yet, so the other two gate inputs are literals here.
  const retryBanner = deriveRetryBanner(
    { retry, inFlight: true, outputSinceRetry: false, nowMs, delegateName: retryDelegateName },
    t
  );
  if (!status && !retryBanner) return null;
  return (
    <>
      {retryBanner && <RetryBanner view={retryBanner} sessionId={sessionId} />}
      {status && (
        <div className={turnHeadClass()}>
          <TurnStatusContent status={status} />
        </div>
      )}
    </>
  );
}

/**
 * T-33: non-fatal transport-retry banner. Tone is the `status-running` trio —
 * the repo's established "running, non-fatal" banner idiom
 * (`HostStatusBanner.tsx`, design-system 运行中横幅) — deliberately NOT
 * `warning`/`destructive`: the banner exists to say the turn is alive, and an
 * alarm color would claim the opposite.
 */
function RetryBanner({ view, sessionId }: { view: RetryBannerView; sessionId: string }) {
  const { t } = useI18n();
  return (
    <div
      className="flex items-start gap-2 rounded-md border border-status-running/30 bg-status-running/10 px-3 py-2 text-meta text-status-running"
      role="status"
    >
      <RefreshCw className="mt-0.5 size-3.5 shrink-0 animate-spin" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{view.title}</p>
        {/* T093: the detail line is no longer behind a `<details>` disclosure.
            It carries the COUNTDOWN now, and a countdown nobody can see is
            indistinguishable from the frozen number decision 029 clause 3
            exists to replace. `tabular-nums` because the seconds are rewritten
            in place once a second — proportional digits would make the whole
            line twitch sideways (design-system 数字对齐). */}
        {view.detail && (
          <p className="mt-1 break-words tabular-nums whitespace-pre-wrap">{view.detail}</p>
        )}
      </div>
      {/* Decision 029 clause 3: give up without hunting for the composer's Stop.
          Shown during the backoff AND during an attempt — waiting out a 120 s
          silent attempt is exactly the case the user reported. `stopChatSession`
          takes an id, so this aborts THIS banner's session even when the
          timeline is not the foreground one (T091). Ghost, not destructive: the
          turn is alive and the banner says so; an alarm-coloured button would
          contradict the sentence it sits next to. */}
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="-my-0.5 h-6 shrink-0 text-meta"
        onClick={() => void stopChatSession(sessionId)}
      >
        {t('Give up now')}
      </Button>
    </div>
  );
}

/**
 * Stable per-item key: block ids are unique within a message, group indexes within a message's blocks.
 */
function turnItemKey(item: TurnItem): string {
  switch (item.kind) {
    case 'toolGroup':
      return `${item.messageId}~group-${item.blockIndex}`;
    case 'permissionActivity':
      // The first block's id, not the index: the item grows as more gates for
      // the same tool call arrive, and keying on a count would remount the row
      // every time one landed.
      return item.blocks[0]?.id ?? `${item.messageId}~perm-${item.blockIndex}`;
    case 'notice':
      return `${item.messageId}~notice`;
    default:
      return item.block.id;
  }
}

/*
 * `TurnHeadContent` retired with the degradation chain it switched on (T12-b).
 * Its four non-status branches — `workedFor`, `stats`, `thought`, `bare` —
 * existed to say SOMETHING about a finished turn even when no duration had been
 * measured (F1's concern, aimed at restored history turns). A finished turn now
 * says nothing about itself by design, so `ChatTurn` renders `TurnStatusContent`
 * directly and only while the turn is live, exactly as `PendingTurnHead` does.
 * `WorkedForContent` went with it.
 */

/**
 * Head slot, in-flight state (§4.7). Spinner and colour follow `kind`, which
 * `turnStatus.ts` derives from the branch of `composerSendingLine` that
 * actually produced the words — so the two can never contradict each other.
 */
function TurnStatusContent({ status }: { status: TurnStatus }) {
  // D33 / spec §3a: the `✽` glyph is decoration, not copy — `turnStatus.ts`
  // stays a pure text module (its own file header draws that line), so the
  // prefix is applied here, at the ONE `.tsx` render site, only once
  // `kind === 'streaming'` actually reaches paint.
  const text = status.kind === 'streaming' ? `✽ ${status.text}` : status.text;
  return (
    <>
      {/* A turn can stay silent for a minute; the spinner and the ticking
          seconds are what say it is alive rather than hung. Same 3.5 size the
          composer's own status row used before this moved here. */}
      {status.kind !== 'failed' && <Spinner className="size-3.5 shrink-0" />}
      <span className={cn('min-w-0 truncate', turnStatusToneClass(status.kind))} title={text}>
        {text}
      </span>
    </>
  );
}

interface TurnItemViewProps {
  item: TurnItem;
  /** T12-d: session scope for the tool-row expand memory. */
  sessionId: string;
  thinkingEnabled: boolean;
  repoName?: string | null;
  /** The one block in this item's source message that may still be streaming, if any. */
  streamingBlockId: string | null;
  getThinkingDurationMs: (blockId: string) => number | null | undefined;
}

/**
 * Assistant prose that is not (yet) Markdown: the still-streaming tail, and
 * whatever a text block is before the gate opens.
 *
 * ONE definition, used by both callers. Two copies of this class string would
 * be two answers to "how does unparsed prose read", and `leading-relaxed` is
 * counted file-wide by the layout suite for exactly that reason.
 */
function PlainProse({ text }: { text: string }) {
  return (
    <p className="text-chat-body leading-relaxed text-foreground whitespace-pre-wrap select-text">
      {text}
    </p>
  );
}

/**
 * FB1-b: assistant prose, rendered progressively while it streams.
 *
 * Before this, the markdown gate was all-or-nothing — a streaming block stayed
 * plain text until the whole turn finished, so a long answer arrived as an
 * unformatted wall and snapped into shape at the end. `advanceClosedPrefix`
 * narrows that to the part of the text that can still change: everything up to
 * the last blank line is settled and gets parsed, the tail after it stays plain.
 *
 * Two things make this affordable, both measured before the wiring went in
 * (100KB corpus, 40 flushes):
 *
 *  - SEGMENTS, not one growing document. Feeding the whole settled prefix to a
 *    single `<ChatMarkdown>` re-parses all of it on every flush: 6379ms of
 *    parsing across the sequence, against 165ms when each settled segment is
 *    parsed once and then memo-hits on its unchanged string. Same output, 39x
 *    the work.
 *  - A STATELESS re-scan every flush. The cut scanner costs 1.71ms at its worst
 *    (the full 100KB), so carrying an incremental fence-stack across flushes
 *    would buy nothing.
 *
 * The high-water mark is what keeps already-rendered text from un-rendering:
 * `splitClosedPrefix` is stateless and can legitimately return a SHORTER
 * prefix than it did a token ago (a new line can re-open a construct that
 * looked closed), which on screen is formatted text flashing back to plain.
 * `advanceClosedPrefix` never publishes less than it published before, and the
 * ref holding that mark survives because `turnItemKey` keys this component by
 * `block.id` — streaming appends to `block.text` and never changes the id.
 *
 * The mark is written in an effect rather than during render: the render then
 * reads the PREVIOUS mark, which is exactly the input `advanceClosedPrefix`
 * documents, and nothing here mutates during render.
 */
function TurnTextItem({ text, streaming }: { text: string; streaming: boolean }) {
  const closedHwmRef = useRef(0);
  const split = useMemo(
    () => (streaming ? advanceClosedPrefix(text, closedHwmRef.current) : null),
    [text, streaming]
  );
  useEffect(() => {
    if (split) closedHwmRef.current = split.closedLength;
  }, [split]);

  if (!split) return <ChatMarkdown text={text} />;
  return (
    <div className={chatMarkdownSegmentGapClass()}>
      {/* `key` by content: segments are append-only and their strings are what
          `ChatMarkdown`'s memo compares anyway, so an index key would be no
          weaker — but content keys survive a cut point moving without
          remounting the segments before it. */}
      {split.segments.map((segment) => (
        <ChatMarkdown key={segment} text={segment} />
      ))}
      {split.openTail.length > 0 && <PlainProse text={split.openTail} />}
      {/* T12-c (user decision, 2026-08-30: 按 pi-app 的来): a code fence that
          is still being written renders as Markdown, not as plain text — a
          long code block is most of a coding agent's output, and it used to
          sit here unformatted for its entire stream.

          Unlike a `segment` this string GROWS, so it re-parses on every flush.
          That cost is bounded by the current code block rather than by the
          whole answer, which is the distinction that made the all-in-one
          approach 39x more expensive (see this component's head note).

          No `key` on content here on purpose: this chunk is meant to update in
          place as it grows, where the settled segments above are keyed by
          content precisely because they never do. */}
      {split.openFence && <ChatMarkdown text={split.openFence} />}
    </div>
  );
}

/**
 * One flattened turn item. The five branches are `AssistantMessage`'s former
 * `groupTimeline` switch, moved verbatim so block order and every per-branch
 * ruling (T-05 D-4/D-5) survive the restructure, plus the `notice` branch
 * `flattenTurnItems` adds for system/error messages that used to be siblings of
 * the assistant message rather than part of its turn.
 */
function TurnItemView({
  item,
  sessionId,
  thinkingEnabled,
  repoName,
  streamingBlockId,
  getThinkingDurationMs,
}: TurnItemViewProps) {
  switch (item.kind) {
    /**
     * T-29: the ONE assistant-prose render point, and therefore the only place
     * markdown is applied. It is reached from BOTH turn segments — the process
     * segment's intermediate prose and the always-visible answer — which is
     * correct: both are assistant text, and the two differ only in position.
     *
     * The other two `whitespace-pre-wrap text-markdown` paragraphs in this file
     * are NOT this: `:686` is the user bubble's own prompt echo and `:711` is
     * `NoticeMessage`'s system/error body. Neither is model prose, both are
     * inside a clamped or an alert-shaped box, and neither gets markdown.
     * Thinking bodies and tool IN/OUT (`ToolRows.tsx`) stay plain for the same
     * reason.
     *
     * `shouldRenderMarkdown` is the streaming gate (F-C3): plain text while the
     * block is the one still streaming, markdown afterwards. Restored history
     * lands on the markdown branch immediately — but NOT for the reason an
     * earlier version of this comment gave ("a replayed turn is never active").
     * `streamingBlockId` was derived from SESSION state, so a replayed turn was
     * marked streaming the moment any new turn started; what makes restored
     * history safe is that it carries no per-message metadata, which
     * `deriveStreamingBlockIds` reads as finished.
     */
    case 'text':
      return (
        <TurnTextItem
          text={item.block.text ?? ''}
          streaming={!shouldRenderMarkdown({ blockId: item.block.id, streamingBlockId })}
        />
      );

    case 'toolGroup':
      return (
        <ToolGroupItem
          item={item}
          sessionId={sessionId}
          thinkingEnabled={thinkingEnabled}
          repoName={repoName}
          streamingBlockId={streamingBlockId}
          getThinkingDurationMs={getThinkingDurationMs}
        />
      );

    case 'permission':
      // 2026-09-18: the live, answerable card lives in `PendingPermissionDock`
      // (outside ScrollArea, docked above the Composer) — this branch only
      // renders once the request is settled, in its original block position.
      // Exactly the arrangement `case 'question'` below already had, and for
      // the same reason: a card that exists twice on screen is a card the user
      // can answer twice.
      //
      // T-05 (D-5)'s block-order ruling is unchanged — the settled row still
      // renders where the request happened. `PermissionQaCard` collapses it to
      // the Allowed/Denied tool row (2026-08-10 ruling); `canRespond` is not
      // passed because a settled card has nothing to respond to.
      //
      // Stated rather than hidden: an UNSETTLED request whose queue entry was
      // dropped without a `permission.resolved` — the terminal-event cleanup in
      // `withoutSessionPermissions` does exactly that when a turn fails or is
      // stopped mid-approval — now renders nothing here either. It was an
      // unanswerable "Waiting" card before. Nothing is waiting on it: the gate
      // it belonged to is gone with the turn.
      if (item.block.resolved !== true) return null;
      return <QuestionCard variant="permission" block={item.block} />;

    case 'permissionActivity':
      // T08-b: the record of what the permission plugin decided. Not a card and
      // not answerable — the plugin's question is the Extension UI modal, and
      // this row exists so the answer survives the modal closing.
      return <PermissionActivityRows blocks={item.blocks} />;

    case 'question': {
      // T-05 (D-4): the live, answerable card lives in `PendingQuestionDock`
      // (outside ScrollArea, docked above the Composer) — this branch only
      // renders once the question is frozen (answered/skipped), in its
      // original block position.
      const state = deriveQuestionCardState(item.block);
      if (state === 'pending') return null;
      return <QuestionCard variant="frozen" block={item.block} />;
    }

    case 'notice':
      return <NoticeMessage message={item.message} />;

    default:
      return null;
  }
}

/**
 * The `toolGroup` branch, split out so it can hold hooks (review batch F7).
 *
 * `deriveToolGroupRows` is by far the heaviest derivation in the timeline — it
 * re-pairs and re-classifies every tool block in the group, then builds a row
 * view (and its detail rows) for each. Inline in the switch above it ran on
 * every render of every turn, which the one-second head clock turned into a
 * whole-session sweep once a second. As its own component the `useMemo` below
 * is legal, and the group's entries are reference-stable between ticks
 * (`flattenTurnItems` only re-runs when the turn's messages actually change).
 */
function ToolGroupItem({
  item,
  sessionId,
  thinkingEnabled,
  repoName,
  streamingBlockId,
  getThinkingDurationMs,
}: {
  item: Extract<TurnItem, { kind: 'toolGroup' }>;
  sessionId: string;
  thinkingEnabled: boolean;
  repoName?: string | null;
  streamingBlockId: string | null;
  getThinkingDurationMs: (blockId: string) => number | null | undefined;
}) {
  const { t } = useI18n();
  const rows = useMemo(
    () =>
      deriveToolGroupRows(filterThinkingEntries(item.entries, thinkingEnabled), {
        repoName,
        thinkingDurationMs: getThinkingDurationMs,
        isStreamingBlockId: streamingBlockId,
        t,
      }),
    [item.entries, thinkingEnabled, repoName, getThinkingDurationMs, streamingBlockId, t]
  );
  return <ToolGroup rows={rows} sessionId={sessionId} showDiff={false} />;
}

/*
 * `TurnMetaTail` retired with the meta row (T12-b, user decision 2026-08-29).
 * It rendered `model · 3 minutes ago` plus the copy button at the trailing edge
 * of that row. Copy moved to `ChatTurn`'s hover strip; the model name and the
 * relative age were dropped outright, and with them F9's whole minute-clock
 * apparatus — the strip shows an absolute `HH:MM` that never needs re-rendering
 * as it ages. See `chatTimelineLayout.ts`'s `turnMetaRowClass()` note for what
 * pi-app does with each of the four things this row used to carry.
 */

/** Copy the turn's prose (never tool input/output — see `buildTurnCopyText`), then confirm for 1.5s. */
const COPY_CONFIRM_MS = 1500;

function TurnCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
    },
    []
  );

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard permission can be refused; a button that lies about having
      // copied is worse than one that appears to do nothing.
      return;
    }
    setCopied(true);
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setCopied(false), COPY_CONFIRM_MS);
  };

  const label = copied ? 'Copied' : 'Copy reply';
  return (
    <button
      type="button"
      className={turnCopyButtonClass()}
      onClick={() => void handleCopy()}
      aria-label={label}
      title={label}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </button>
  );
}

/** T-04 capability gate: dropped, not just hidden — no leftover entry point when disabled. */
function filterThinkingEntries(
  entries: readonly ToolGroupEntry[],
  thinkingEnabled: boolean
): readonly ToolGroupEntry[] {
  return thinkingEnabled ? entries : entries.filter((entry) => entry.kind !== 'thinking');
}
