import { AUTH_OPEN_ONBOARDING_EVENT } from '@shared/authGate';
import type {
  PermissionDecisionId,
  SessionRetryInfo,
  SessionRuntimeStatus,
} from '@shared/types/runtimeEvents';
import {
  ArrowDown,
  Check,
  ChevronRight,
  Copy,
  FileQuestion,
  FileSearch,
  FileText,
  GitBranch,
  Image as ImageIcon,
  RefreshCw,
  ShieldAlert,
  TriangleAlert,
} from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Spinner } from '@/components/ui/spinner';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import type { ChatMessage } from '@/stores/chatSessions';
import { useChatSessionsStore } from '@/stores/chatSessions';
import {
  isPendingUserMessage,
  type PendingUserMessage,
  pendingUserToChatMessage,
  usePendingUserMessagesStore,
} from '@/stores/pendingUserMessages';
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
  turnBodyClass,
  turnCopyButtonClass,
  turnHeadClass,
  turnProcessShellClass,
  turnStatusToneClass,
  userBubbleClass,
  userBubbleRowClass,
  userBubbleTextClass,
} from './chatTimelineLayout';
import {
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
  type HistoryErrorView,
  selectHistoryError,
} from './historyError';
// T12-b: `formatMessageMetadata` / `formatRelativeTimestamp` left with the meta
// row. The strip that replaced it shows a bare wall clock (`14:32`), so the
// relative form ("3 minutes ago") and the `model · time` composer are both
// unused here — see `chatTimelineLayout.ts`'s `turnMetaRowClass()` note.
import { formatAbsoluteTime, type MessageMetadata } from './messageMetadata';
import { nextFollowState, shouldShowJumpToBottom } from './messageTimelineScroll';
import { TIMELINE_PADDING_CLASS } from './middleColumnLayout';
import { PermissionActivityRows } from './PermissionActivityRows';
import { QuestionCard } from './QuestionCard';
import {
  canRespondToPermission,
  deriveQuestionCardState,
  permissionDecisionAllows,
} from './questionCardModel';
import { ReadingColumn } from './ReadingColumn';
import { deriveRetryBanner, type RetryBannerView } from './retryBanner';
import { SessionTreeDialog } from './SessionTreeDialog';
import { SEND_SILENCE_CEILING_MS } from './sendBudgets';
import { useResumeSession } from './sessionIndex/useResumeSession';
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
  deriveTurnStatus,
  isFailedCardBodyDuplicate,
  latestErrorNoticeText,
  type TurnStatus,
} from './turnStatus';
// T12-b: `deriveTurnStats` / `formatWorkedForRow` / `THOUGHT_VERB` /
// `turnHasThinkingOnlyProcess` all fed the retired meta row's completed state.
// They stay exported from `turnTiming.ts` because the per-tool-row and subagent
// surfaces still use them; only this file stopped asking.
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
  const pendingPermissions = useChatSessionsStore((state) => state.pendingPermissions);
  const respondPermission = async () => false;
  const canRespondPermission = useMemo(
    () => (permissionId: string | undefined) =>
      canRespondToPermission(pendingPermissions, sessionId, permissionId),
    [pendingPermissions, sessionId]
  );
  const lastError = useChatSessionsStore((state) => state.lastError);
  const stopActiveSession = useChatSessionsStore((state) => state.stopActiveSession);
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
  const hasDurablePiSession = useChatSessionsStore((state) =>
    sessionId
      ? state.sessions.some(
          (session) => session.id === sessionId && session.runtimeIdentity != null
        )
      : false
  );
  const isIdle = status === 'idle';
  const [treeOpen, setTreeOpen] = useState(false);
  const [loadingOlderHistory, setLoadingOlderHistory] = useState(false);
  const loadOlderHistory = useCallback(async () => {
    if (!sessionId || !historyPagination?.hasMore || loadingOlderHistory) return;
    setLoadingOlderHistory(true);
    try {
      await window.electronAPI.chat.loadHistoryPage({
        sessionId,
        offset: historyPagination.nextOffset,
        limit: 80,
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
    lastScrollHeightRef.current = viewport.scrollHeight;
    const handleScroll = () => {
      stickToBottomRef.current = nextFollowState({
        scrollTop: viewport.scrollTop,
        scrollHeight: viewport.scrollHeight,
        clientHeight: viewport.clientHeight,
        prevScrollHeight: lastScrollHeightRef.current,
        following: stickToBottomRef.current,
      });
      lastScrollHeightRef.current = viewport.scrollHeight;
      syncJumpToBottom(viewport);
    };
    viewport.addEventListener('scroll', handleScroll, { passive: true });
    return () => viewport.removeEventListener('scroll', handleScroll);
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
    const observer = new ResizeObserver(() => {
      if (stickToBottomRef.current) {
        viewport.scrollTop = viewport.scrollHeight;
      }
      // Keep the height record current even when not following, so the next
      // scroll event's height-change check compares against this frame.
      lastScrollHeightRef.current = viewport.scrollHeight;
      // T12-d: growth is the ONLY way the button appears during a stream the
      // user has scrolled away from — no scroll event fires while the content
      // grows underneath a stationary viewport.
      syncJumpToBottom(viewport);
    });
    observer.observe(content);
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
            {hasDurablePiSession && (
              <div className="flex justify-end">
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={!isIdle}
                  onClick={() => setTreeOpen(true)}
                >
                  <GitBranch />
                  Branches
                </Button>
              </div>
            )}
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
                    baselineKnown={sendBaseline != null}
                    baselineMessageId={sendBaseline?.messageId ?? null}
                    // T-33: session-scoped retry belongs to the turn actually
                    // in flight — the pending head below while the user echo
                    // has not landed, the last turn otherwise. Nulled for every
                    // other turn for the same reason the two ticking props are
                    // (F7): a retry tick must not break `memo` session-wide.
                    retry={isLastTurn && pendingSendStatus == null ? sessionRetry : null}
                    nowMs={isLastTurn ? nowMs : STATIC_NOW_MS}
                    getMetadata={getMeta}
                    thinkingEnabled={thinkingEnabled}
                    repoName={repoName}
                    getThinkingDurationMs={getThinkingDurationMs}
                    canRespondPermission={canRespondPermission}
                    onRespondPermission={respondPermission}
                  />
                );
              })
            )}
            {pendingSendStatus && (
              <PendingTurnHead sendStatus={pendingSendStatus} retry={sessionRetry} />
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
                <p className="font-medium text-destructive">Session failed</p>
                {lastError && isAuthRequiredError(lastError) ? (
                  // D47 S5 §3: spawn-gate rejection (resolveSpawnGateDecision,
                  // @shared/authGate) — retrying won't help without a fresh
                  // login, so this replaces the raw diagnostic + Retry hint
                  // with mapped copy and a re-login action instead.
                  <>
                    <p className="mt-1 text-muted-foreground">{AUTH_REQUIRED_ERROR_VIEW.message}</p>
                    <Button
                      size="sm"
                      variant="outline"
                      className="mt-2 h-6 text-ui"
                      onClick={() =>
                        window.dispatchEvent(new CustomEvent(AUTH_OPEN_ONBOARDING_EVENT))
                      }
                    >
                      {AUTH_REQUIRED_ERROR_VIEW.actionLabel}
                    </Button>
                  </>
                ) : (
                  <>
                    {lastError && failedCardShowsError && (
                      // D25 M3d: machine diagnostic text (rawEvents=/hostAfter=/cwd=), same
                      // content family as ChatComposer's destructive banner — mono.
                      // Round-10 ③: suppressed when the latest error notice above
                      // already prints this exact failure (see failedCardShowsError).
                      <p className="mt-1 select-text break-words whitespace-pre-wrap font-mono text-code text-muted-foreground">
                        {lastError}
                      </p>
                    )}
                    {/* F3 fast-fix batch: affordance-neutral on purpose. Whether
                        this failure armed the composer's Retry button or restored
                        the draft into the input is decided by queueRelease's
                        outcome — this card cannot see which, so it must not name
                        a button that may not exist (2026-08-17 inspection F2-d). */}
                    <p className="mt-1 text-muted-foreground">
                      已产内容保留。可从下方输入框重发上条消息。
                    </p>
                    {pendingPermissions.some((item) => item.sessionId === sessionId) && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="mt-2 h-6 text-ui"
                        onClick={() => void stopActiveSession()}
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
      <SessionTreeDialog
        key={sessionId}
        sessionId={sessionId}
        open={treeOpen}
        onOpenChange={setTreeOpen}
        isIdle={isIdle}
      />
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
  const [detailOpen, setDetailOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryFailed, setRetryFailed] = useState(false);
  const { resume } = useResumeSession();
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

  return (
    <Alert variant={view.severity} role={view.severity === 'error' ? 'alert' : 'status'}>
      <Icon />
      <AlertTitle className="min-w-0 truncate">{view.title}</AlertTitle>
      <AlertDescription className="gap-1 text-meta">
        <p className="break-words">{view.guidance}</p>
        <p>{view.continuationHint}</p>
        {retryControl.hint && (
          <p
            className={cn(
              'break-words',
              retryControl.hintKind === 'failed' && 'font-medium text-destructive'
            )}
          >
            {retryControl.hint}
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
              Details
            </CollapsibleTrigger>
            <CollapsibleContent>
              <pre className="max-h-24 select-text overflow-auto whitespace-pre-wrap break-all font-mono text-code">
                {view.message}
              </pre>
            </CollapsibleContent>
          </Collapsible>
        )}
      </AlertDescription>
      {retryControl.visible && (
        <AlertAction>
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
              className="whitespace-pre-wrap break-words text-markdown leading-relaxed text-foreground"
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
  const isError = message.role === 'error';
  // D47 S5 §3: a spawn-gate rejection (resolveSpawnGateDecision,
  // @shared/authGate) landing in this card as raw text — swap in mapped
  // Chinese copy + a re-login action instead of the raw diagnostic.
  const authRequired =
    isError &&
    message.blocks.some((block) => block.type === 'text' && isAuthRequiredError(block.text));

  return (
    <Alert variant={isError ? 'error' : 'default'} role={isError ? 'alert' : 'status'}>
      <AlertDescription>
        {message.blocks.map((block) =>
          block.type === 'text' ? (
            <p
              key={block.id}
              className="select-text whitespace-pre-wrap text-markdown text-foreground"
            >
              {/* D47 S5 §3: swap the raw spawn-gate rejection text for mapped
                  Chinese copy in-place — same paragraph, same class, so this
                  stays the one "notice body" surface T-29 pinned (see the
                  wiring test's exact-count assertion on this class string). */}
              {authRequired ? AUTH_REQUIRED_ERROR_VIEW.message : block.text}
            </p>
          ) : null
        )}
      </AlertDescription>
      {authRequired && (
        <AlertAction>
          <Button
            size="xs"
            variant="outline"
            className="h-6"
            onClick={() => window.dispatchEvent(new CustomEvent(AUTH_OPEN_ONBOARDING_EVENT))}
          >
            {AUTH_REQUIRED_ERROR_VIEW.actionLabel}
          </Button>
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
  /** A send-begin baseline exists for this session (`turnSendStatus.baseline`). */
  baselineKnown: boolean;
  /** Last message id in the bucket when this session's last send began. */
  baselineMessageId: string | null;
  retry: SessionRetryInfo | null;
  /** Whole-second clock, ticking only while a turn is in flight (`useSecondsTick`). `STATIC_NOW_MS` for every turn but the last. */
  nowMs: number;
  getMetadata: (messageId: string) => MessageMetadata | undefined;
  thinkingEnabled: boolean;
  repoName?: string | null;
  getThinkingDurationMs: (blockId: string) => number | null | undefined;
  canRespondPermission: (permissionId: string | undefined) => boolean;
  onRespondPermission: (
    permissionId: string,
    allow: boolean,
    decision?: PermissionDecisionId
  ) => Promise<boolean>;
}

/**
 * T-31 §4.8: one turn — the container this whole spec exists to introduce.
 *
 * Renders, in order: the sticky user-bubble band (§5), the turn's content
 * segments in block order (answer prose outside the shell, notices outside it,
 * tool/thinking/authorization inside a collapsible one — FB4), and finally ONE
 * bottom meta row carrying the status slot, the collapse trigger, the model ·
 * relative-time metadata and the copy button (FB6 + D55 ①).
 *
 * FB6 moved that row from the top of the turn to the bottom, which is where the
 * user asked for it: while a turn streams, "Worked for Ns" belongs under the
 * output being produced, not above it. T-31 §4.7's "one slot, two states"
 * (status while in flight -> `Worked for Ns …` once complete) is UNCHANGED —
 * this batch moved the slot's coordinates, not the number of slots, which is
 * why `deriveTurnHeadModel` / `deriveTurnStatus` / `formatWorkedForRow` are
 * untouched.
 *
 * The segments and the meta row are deliberately siblings under one
 * `turnBodyClass()`: P-17's 10px "within a turn" gap stays a single source,
 * inherited from the `<article className="flex flex-col gap-2.5">` that
 * `AssistantMessage` used to own before it was split in two.
 *
 * `memo` (review batch F7) is load-bearing, not a micro-optimization: the head
 * runs off a one-second clock, so without it every turn in the session
 * re-derived its items, its call counts and its tool rows once a second for the
 * whole length of a wait. It only holds because `stabilizeTurns` keeps this
 * turn's `turn` identity across an unrelated token, because the ticking props
 * reach the last turn only, and because both lookup callbacks are `useCallback`
 * -stable at their source.
 */
const ChatTurn = memo(function ChatTurn({
  turn,
  sessionId,
  isLastTurn,
  sessionStatus,
  inFlightSession,
  sendStatus,
  pendingReply,
  baselineKnown,
  baselineMessageId,
  retry,
  nowMs,
  getMetadata,
  thinkingEnabled,
  repoName,
  getThinkingDurationMs,
  canRespondPermission,
  onRespondPermission,
}: ChatTurnProps) {
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
  const bodyMetadata = useMemo(
    () => turn.body.map((message) => getMetadata(message.id)),
    [turn.body, getMetadata]
  );

  // ---- Head slot state (§4.7) ----

  // Two clocks, never both: the composer's snapshot covers handshake/awaiting
  // (it stops at the first assistant progress, where `runSend` returns), and
  // T-06's `message.started` timestamp covers the streaming remainder.
  // `!turnComplete` guards the stream clock the same way the parent's send
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
  const retryBanner = deriveRetryBanner({
    retry,
    inFlight: inFlightSession,
    outputSinceRetry: turnProgressStamp > progressStampAtRetry,
  });

  // A turn that is running with NEITHER clock (a session left running before
  // this window opened) gets no status row rather than one frozen at "0s" —
  // the composer showed nothing in that case either, so no information is lost.
  const status = deriveTurnStatus({
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
    retry: retry ? { attempt: retry.attempt, maxRetries: retry.maxRetries } : null,
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
  });

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
  // offer. `completedAt` alone is not enough: a bare clock with no button is a
  // statistic, and statistics are what this batch removed.
  const showActions = actionsCopyText.length > 0;

  const renderItem = (item: TurnItem) => (
    <TurnItemView
      key={turnItemKey(item)}
      item={item}
      sessionId={sessionId}
      thinkingEnabled={thinkingEnabled}
      repoName={repoName}
      streamingBlockId={streamingBlockIdByMessage.get(item.messageId) ?? null}
      getThinkingDurationMs={getThinkingDurationMs}
      canRespondPermission={canRespondPermission}
      onRespondPermission={onRespondPermission}
    />
  );

  const renderSegment = (segment: TurnSegment<TurnItem>) => {
    // Keyed off the segment's FIRST item, not its index: an index key would
    // remount every later segment the moment a new one opened mid-stream,
    // throwing away the expanded tool bodies inside them.
    const key = `${segment.kind}:${turnItemKey(segment.items[0])}`;
    if (segment.kind === 'answer') {
      // T12: bare prose. The `turnAnswerContainerClass()` ring that used to
      // wrap this retired with the box model it belonged to — after FB4 made
      // answer segments repeat within a turn, one ring per prose run stacked
      // several boxes inside a single reply (Q14). The role signal moved
      // entirely to the user side's shape; see the note in
      // `chatTimelineLayout.ts` where the container used to be defined.
      return (
        <div key={key} className={turnBodyClass()}>
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
    return (
      /**
       * The process segment: tool runs, thinking, and authorization cards, in
       * block order.
       *
       * Rendered UNCONDITIONALLY (2026-08-25 user decision). There is no
       * turn-level collapse any more — each tool row expands its own IN/OUT
       * body, and that turned out to be the only granularity worth having once
       * FB4 stopped folding prose in here. The authorization red line ("the
       * Allow/Deny card can never be collapsed away") is satisfied by
       * construction rather than by a forced-open rule.
       *
       * NO `overflow-hidden` here, ever: it would create a containing block and
       * silently break the pinned bubble band's `position: sticky`
       * (`chatTimelineLayout.ts`'s standing prohibition).
       */
      <div key={key} className={cn(turnProcessShellClass(), turnBodyClass())}>
        {segment.items.map(renderItem)}
      </div>
    );
  };

  return (
    <section className={chatTurnClass()}>
      {/* T12: an ordinary first row, not a pinned band. The `sticky top-0`
          wrapper that used to be here is gone along with the clamp and the
          toggle it forced (`chatTimelineLayout.ts` head note). What it bought —
          "you can always see which prompt you are reading the reply to" — is
          paid for instead by the reading rhythm: 20px between turns against
          10px inside one. */}
      {turn.user && <UserBubble message={turn.user} />}
      <div className={turnBodyClass()}>
        {/* T-33: top of the turn body, below the pinned bubble band — the
            banner describes the reply in progress, so it lives in the reply
            zone, not above the user's own message. */}
        {retryBanner && <RetryBanner view={retryBanner} />}
        {/* FB4: block order, all the way down. Prose and notices render where
            they happened instead of being scraped to the end of the turn, and
            only tool / thinking / authorization runs go inside a shell. The old
            rule ("the answer is the TRAILING run of text items") sent every
            earlier paragraph into the collapsed segment, and a turn that ended
            in an error notice sent ALL of it. */}
        {segments.map(renderSegment)}
        {/* T12-b: the running status, and ONLY while it is running. FB6's
            position is kept — under the output it describes, not above it —
            but the row no longer has a completed state (`Worked for 12s ·
            2 tools` retired with the meta row). A finished turn renders
            nothing here at all, which is the point of the change. */}
        {status && (
          <div className={turnHeadClass()}>
            <TurnStatusContent status={status} />
          </div>
        )}
        {/* T12-b: the hover strip — copy and the wall clock, revealed by
            hovering anywhere in the turn (`group/turn` on the section above).
            Deliberately hover-only per the 2026-08-29 user decision; the
            accessibility cost that buys is recorded on
            `turnActionsSlotClass()`.

            2026-08-30: the strip RESERVES its height and only fades, so
            hovering no longer pushes the turn below it down. The reasoning for
            the collapse it replaces — and why the user overruled it — is on
            `turnActionsSlotClass()` too. */}
        {showActions && (
          <div className={turnActionsSlotClass()}>
            <div className={turnActionsInnerClass()}>
              <TurnCopyButton text={actionsCopyText} />
              {metadata?.completedAt != null && (
                <span className="shrink-0">{formatAbsoluteTime(metadata.completedAt)}</span>
              )}
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
  sendStatus,
  retry,
}: {
  sendStatus: TurnSendStatus;
  retry: SessionRetryInfo | null;
}) {
  const status = deriveTurnStatus({
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
    retry: retry ? { attempt: retry.attempt, maxRetries: retry.maxRetries } : null,
    hasBlocks: false,
  });
  // T-33: the pending head's existence is itself the in-flight proof, and no
  // turn exists yet, so the other two gate inputs are literals here.
  const retryBanner = deriveRetryBanner({ retry, inFlight: true, outputSinceRetry: false });
  if (!status && !retryBanner) return null;
  return (
    <>
      {retryBanner && <RetryBanner view={retryBanner} />}
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
function RetryBanner({ view }: { view: RetryBannerView }) {
  return (
    <div
      className="flex items-start gap-2 rounded-md border border-status-running/30 bg-status-running/10 px-3 py-2 text-meta text-status-running"
      role="status"
    >
      <RefreshCw className="mt-0.5 size-3.5 shrink-0 animate-spin" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{view.title}</p>
        {view.detail && <p className="mt-0.5 opacity-90">{view.detail}</p>}
      </div>
    </div>
  );
}

/** Stable per-item key: block ids are unique within a message, group indexes within a message's blocks. */
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
  canRespondPermission: (permissionId: string | undefined) => boolean;
  onRespondPermission: (
    permissionId: string,
    allow: boolean,
    decision?: PermissionDecisionId
  ) => Promise<boolean>;
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
    <p className="text-markdown leading-relaxed text-foreground whitespace-pre-wrap select-text">
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
  canRespondPermission,
  onRespondPermission,
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
      // T-05 (D-5): same `.qa` shell as questions, thin adapter over
      // `derivePermissionCardView` — position unchanged (block-order,
      // not the Dock), Allow/Deny behavior preserved verbatim.
      return (
        <QuestionCard
          variant="permission"
          block={item.block}
          canRespond={canRespondPermission(item.block.permissionId)}
          // The one place `allow` is derived from the decision (spec §3.2):
          // downstream both travel together, so a card that says Allowed
          // cannot sit on top of a wire reply that said decline.
          onRespondPermission={(decision) =>
            onRespondPermission(
              item.block.permissionId ?? '',
              permissionDecisionAllows(decision),
              decision
            )
          }
        />
      );

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
  const rows = useMemo(
    () =>
      deriveToolGroupRows(filterThinkingEntries(item.entries, thinkingEnabled), {
        repoName,
        thinkingDurationMs: getThinkingDurationMs,
        isStreamingBlockId: streamingBlockId,
      }),
    [item.entries, thinkingEnabled, repoName, getThinkingDurationMs, streamingBlockId]
  );
  return <ToolGroup rows={rows} sessionId={sessionId} />;
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
