import { AUTH_OPEN_ONBOARDING_EVENT } from '@shared/authGate';
import type {
  PermissionDecisionId,
  SessionRetryInfo,
  SessionRuntimeStatus,
} from '@shared/types/runtimeEvents';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FileQuestion,
  FileSearch,
  FileText,
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
import { cn } from '@/lib/utils';
import type { ChatMessage } from '@/stores/chatSessions';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { useSessionRuntimeFactsStore } from '@/stores/sessionRuntimeFacts';
import {
  type PendingReplyWatch,
  type TurnSendStatus,
  useTurnSendStatusStore,
} from '@/stores/turnSendStatus';
import { AUTH_REQUIRED_ERROR_VIEW, isAuthRequiredError } from './authRequiredError';
import { ChatMarkdown } from './ChatMarkdown';
import { deriveStreamingBlockIds, shouldRenderMarkdown } from './chatMarkdownPolicy';
import {
  chatTurnClass,
  readingColumnSpacingClass,
  turnAnswerContainerClass,
  turnBodyClass,
  turnBubbleBandClass,
  turnCopyButtonClass,
  turnFooterClass,
  turnHeadClass,
  turnProcessPanelClass,
  turnProcessShellClass,
  turnStatusToneClass,
  userBubbleTextClass,
} from './chatTimelineLayout';
import {
  defaultTurnProcessOpen,
  flattenTurnItems,
  groupMessagesIntoTurns,
  hasUnresolvedPermission,
  splitTurnBody,
  stabilizeTurns,
  type Turn,
  type TurnItem,
  turnHasFailure,
} from './chatTurn';
import {
  deriveHistoryNotice,
  deriveRetryControl,
  type HistoryErrorView,
  selectHistoryError,
} from './historyError';
import {
  formatAbsoluteTime,
  formatMessageMetadata,
  formatRelativeTimestamp,
  type MessageMetadata,
} from './messageMetadata';
import { nextFollowState } from './messageTimelineScroll';
import { TIMELINE_PADDING_CLASS } from './middleColumnLayout';
import { QuestionCard } from './QuestionCard';
import {
  canRespondToPermission,
  deriveQuestionCardState,
  permissionDecisionAllows,
} from './questionCardModel';
import { ReadingColumn } from './ReadingColumn';
import { deriveRetryBanner, type RetryBannerView } from './retryBanner';
import { SEND_SILENCE_CEILING_MS } from './sendBudgets';
import { useResumeSession } from './sessionIndex/useResumeSession';
import { ToolGroup } from './ToolRows';
import { deriveToolGroupRows, type ToolGroupEntry } from './toolCard';
import { buildTurnCopyTextFromItems } from './turnCopy';
import {
  deriveSendStatusBinding,
  deriveTurnHeadModel,
  hasLiveTurnEvidence,
  isTurnInFlight,
  ownsSessionFailure,
  type TurnHeadModel,
} from './turnHead';
import {
  deriveTurnStatus,
  isFailedCardBodyDuplicate,
  latestErrorNoticeText,
  type TurnStatus,
} from './turnStatus';
import {
  deriveTurnStats,
  formatWorkedForRow,
  THOUGHT_VERB,
  turnHasThinkingOnlyProcess,
  type WorkedForRowText,
} from './turnTiming';
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

/**
 * The clock the footer's relative timestamps are read against (review batch
 * F9), always running.
 *
 * `formatMessageMetadata`'s default renderer reads `Date.now()` itself, so a
 * footer rendered as "just now" stayed "just now" until something ELSE forced
 * that turn to re-render — in an idle session, nothing does, and the whole
 * transcript froze its ages at whatever they were when the last token landed.
 * The clock is passed explicitly instead, which also makes the formatter a pure
 * function of its arguments (`formatRelativeTimestamp(ms, now)`) and therefore
 * assertable.
 *
 * A minute is the finest bucket `formatRelativeAge` has, so a 60s beat is the
 * cheapest tick that can never be visibly late; unlike `useSecondsTick` it must
 * run even when nothing is in flight, since ageing is exactly what happens
 * while nothing is in flight.
 */
const RELATIVE_TIME_TICK_MS = 60_000;

function useMinuteTick(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), RELATIVE_TIME_TICK_MS);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

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

interface MessageTimelineProps {
  sessionId: string | null;
  status: SessionRuntimeStatus;
  /** Host capability gate (T-04)：thinking-capable 时为 true，UI 渲染折叠卡。 */
  thinkingEnabled: boolean;
  /** T-05: repo name tail for Grep/Glob rows ("… in ai-client"); wired by ChatWorkspace in batch 3. */
  repoName?: string | null;
}

export function MessageTimeline({
  sessionId,
  status,
  thinkingEnabled,
  repoName = null,
}: MessageTimelineProps) {
  // C-08b: subscribe to this session's bucket only — other sessions' streams
  // no longer re-render this timeline.
  const bucket = useChatSessionsStore((state) =>
    sessionId ? state.messages[sessionId] : undefined
  );
  const respondPermission = useChatSessionsStore((state) => state.respondPermission);
  const pendingPermissions = useChatSessionsStore((state) => state.pendingPermissions);
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
  // D33: the Host's live output-token estimate for THIS session's in-flight
  // turn. A narrow primitive selector (`number | null`, never the facts
  // object) — this ticks as often as the interim channel does, so widening it
  // to the whole per-session facts record would re-render on every stderr
  // line and permission-mode echo too, not just the token estimate this row
  // actually needs.
  const outputTokensDisplay = useSessionRuntimeFactsStore((state) =>
    sessionId ? (state.factsBySession[sessionId]?.turnTokensDisplay ?? null) : null
  );
  const { get: getMeta } = useMessageMetadata(sessionId);
  const { getThinking } = useTurnTiming(sessionId);

  const sessionMessages = useMemo(() => bucket ?? [], [bucket]);

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
  const footerNowMs = useMinuteTick();

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
    };
    viewport.addEventListener('scroll', handleScroll, { passive: true });
    return () => viewport.removeEventListener('scroll', handleScroll);
  }, [sessionId]);

  // Session switch: always jump to the bottom of the new session's history
  // and re-arm following — a previous session's scroll-up must not carry
  // over to a freshly opened one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId triggers the jump-to-bottom on session switch
  useEffect(() => {
    stickToBottomRef.current = true;
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
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [sessionId]);

  if (!sessionId) {
    return (
      <div className="flex flex-1 items-center justify-center text-ui text-muted-foreground">
        Select a session to start chatting.
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" ref={scrollRootRef}>
      {/* Round-2 V-b, updated by T-31 §5.7. Conclusion ① CHANGED: this viewport
          now contains a per-turn sticky user-bubble band (spec §5, class in
          `turnBubbleBandClass`). It is NOT the kind of element V-b ruled out —
          it lives inside the viewport and inside the content flow, not as a
          layer above the scrolled content — so the "floating header overlaps
          the timeline" failure surface V-b closed stays closed. Nothing above
          this viewport (MessageTimeline/ChatWorkspace/HostStatusBanner/
          WindowTitleBar) is sticky/fixed/absolute; that audit still holds.
          Conclusion ② unchanged: the "half a row cut off at the top"
          screenshot is the stick-to-bottom effect below
          (`viewport.scrollTop = viewport.scrollHeight` on every resize while
          `stickToBottomRef` is true) — a turn taller than the viewport
          necessarily scrolls its own top above the fold, expected chat-UI
          behavior, not an overlap bug. Conclusion ③ narrowed: `scrollFade` is
          now BOTTOM-ONLY (§5.5-A). The top fade existed to soften that hard
          clip, and the clip is gone — the top of the viewport is always an
          opaque bubble band now. Kept at four edges it would instead render
          the pinned bubble half-transparent, i.e. defeat §5 outright.
          NOT ASSERTABLE (vitest is node-only, §6.2): that `position: sticky`
          actually resolves against `ScrollArea.Viewport`, and how the viewport
          mask paints against a pinned band. Both are GUI-check items. */}
      <ScrollArea className="min-h-0 flex-1" scrollFade="bottom">
        {/* Padding stays outside ReadingColumn — inside it would shave 24px off
            the documented 45rem/60rem (D25 §3.4) reading width (T-22 spec §2.13). */}
        <div className={TIMELINE_PADDING_CLASS} ref={contentRef}>
          {/* T-05 (A07 `.tl` :846): 20px turn spacing — still 20 in total, but
              T-31 §5.4 split it into 10 here + 10 of band padding, so the band
              can double as the pinned bubble's opaque buffer (F-B9). */}
          <ReadingColumn className={readingColumnSpacingClass()}>
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
                    // D33: same last-turn-only discipline as `nowMs`/`retry`
                    // above (F7) — every other turn must keep a byte-identical
                    // prop across an interim tick, or `memo` on `ChatTurn`
                    // stops holding session-wide the moment a turn is streaming.
                    outputTokensDisplay={isLastTurn ? outputTokensDisplay : null}
                    footerNowMs={footerNowMs}
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
 * T-05 (D-1) -> T-30 (P-08/P-09/P-11) -> T-31 §4.8: the three role forms are
 * unchanged, but they are no longer selected by a single `MessageBubble`
 * dispatcher over a flat message list. `ChatTurn` below owns the ordering now:
 *  - user -> this `.fx-user-bubble`, hoisted into the turn's sticky band;
 *  - assistant -> its blocks, flattened by `flattenTurnItems` and rendered
 *    item by item by `TurnItemView` (same block order, T-05 D-5);
 *  - system / error -> `NoticeMessage`, still the `Alert` primitive.
 *
 * The bubble's corners are still A07 `:849-855`'s 16/16/4/16. Its face and edge
 * are NOT: P-09 landed `--card` + a primary-8% border, and F5 D3-c (2026-08-18)
 * replaced both with `--accent` + `--input` because the old pair measured 1.027
 * against the timeline surface — the bubble was, in effect, not drawn. See the
 * decision note on the `<article>` below.
 */
function UserBubble({ message }: { message: ChatMessage }) {
  // FB3: view-only state, deliberately not in the store (R5) -- same family as
  // the process shell's `processOpen`. It is the ONLY input to the clamp, and
  // it comes from a click; see `userBubbleTextClass`'s header for why nothing
  // geometric may join it.
  const [expanded, setExpanded] = useState(false);
  // user messages only ever carry `text` blocks (chatSessions.ts attaches
  // tool_call/tool_result/thinking/permission_request/question exclusively
  // to role: 'assistant' messages, live and replayed alike).
  const textBlocks = message.blocks.filter((block) => block.type === 'text');
  // §5.6: the full prompt stays reachable by hover and screen reader in every
  // state, which is what makes the unconditional six-line clamp safe (F10 —
  // the clamp is no longer pinned-only, and it is six lines, not three).
  const fullText = textBlocks
    .map((block) => block.text ?? '')
    .filter((text) => text.length > 0)
    .join('\n\n');

  return (
    // D31 (user decision 2026-08-13, `openchamber-chat-refactor-ledger.md:75`)
    // overturned D26 ④ and put the bubble back on the right at 85%; F5 D3-c
    // (user decision 2026-08-18) is the batch that executes it. D26 ④ — "the
    // bubble spans the reading column, 85% and right-alignment are dead
    // weight" — is void in the code from here on, as it already was in the
    // ledger; the ledger is append-only, so this comment is the code-side
    // record rather than an edit to it.
    //
    // What makes the two roles distinguishable is SHAPE on this side: the
    // right edge, the 85% cap, the sharp bottom-right tail that finally points
    // at an edge it was drawn for, and a face that is actually visible. The
    // assistant side is drawn by BOUNDARY instead (see
    // `turnAnswerContainerClass()`), deliberately not by the same means.
    //
    // "Actually visible" is measured, not asserted. The old `--card` face read
    // 1.027 (light) / 1.049 (dark) against the timeline background and the old
    // primary-8% border read 1.111 / 1.102 against that face — both under any
    // discriminable threshold, which is the precise reason the bubble looked
    // undifferentiated. `--accent` + `--input` measure 1.161 / 1.292 for the
    // face and 1.350 / 1.322 for the edge, with body text at 16.17 / 8.81 (AAA)
    // on top of it.
    <article className="flex justify-end">
      <div
        className={cn(
          // `min-w-0` is not decoration and not interchangeable with the cap:
          // the `<article>` above is a flex line, so this box is a flex item,
          // whose `min-width` resolves to `auto` (= its min-content width) —
          // and `min-width` outranks `max-width`. One unbreakable run (a long
          // URL, one long word) pushes min-content past 85% and the cap is
          // silently ignored, full width returns, and only for some content,
          // so review never sees it. The prose half of the same fix is
          // `break-words` on the paragraph below.
          'min-w-0 max-w-[85%] space-y-2 rounded-lg border px-4 py-2.5',
          // T-30 P-09: A07 `.fx-user-bubble` (`:849-855`) — 16/16/4/16 corners,
          // the sharp bottom-right "tail" pointing at the right-aligned edge it
          // was drawn for (D26 ④ had left it pointing at nothing).
          //
          // The face and edge are D3-c's, not P-09's. The note that used to sit
          // here read the other way round — "assistant needs bg-accent for
          // contrast, so user is free to stay on --card" — and D3-c inverts it:
          // assistant has no face at all now, and `--accent` belongs to the
          // user bubble. `--input` is the edge for the same reason it edges
          // text inputs (design-system.md:102, "fill semantics"): this box is
          // the echo of what the operator typed.
          'rounded-br-xs border-input bg-accent'
        )}
        title={fullText || undefined}
      >
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
        {/* Unconditional clamp (§5.6-B fallback, F10): the pinned-only
            scroll-state clamp oscillated — see `userBubbleTextClass()`'s
            header for the loop. `title` above keeps the full prompt
            reachable in every state. */}
        <div className={userBubbleTextClass(expanded)}>
          {textBlocks.map((block) => (
            <p
              key={block.id}
              className="whitespace-pre-wrap break-words text-markdown leading-relaxed text-foreground"
            >
              {block.text}
            </p>
          ))}
        </div>
        {/* FB3: the toggle is rendered whenever there is prompt text at all —
            no measurement, on purpose. Deciding visibility from "does it
            overflow?" would read element geometry inside this bubble, which is
            the exact edge F10 removed. Whether a permanently visible control
            under a SHORT prompt is acceptable is a look question, so it goes to
            the G-4 point-check rather than being guessed at here. */}
        {fullText.length > 0 ? (
          <button
            type="button"
            className="self-start text-meta text-muted-foreground/60 hover:text-foreground focus-visible:text-foreground"
            onClick={() => setExpanded((previous) => !previous)}
            aria-expanded={expanded}
          >
            {expanded ? 'Show less' : 'Show more'}
          </button>
        ) : null}
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
  /** D33: the live output-token estimate, `isLastTurn`-gated the same way as `nowMs`/`retry`. `null` for every turn but the last. */
  outputTokensDisplay: number | null;
  /** Minute clock for the footer's relative timestamp (`useMinuteTick`, F9). */
  footerNowMs: number;
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
 * Renders, in order: the sticky user-bubble band (§5), the head slot (§4.7 —
 * status line while in flight, `Worked for Ns …` once complete, one slot with
 * two states), the collapsible process segment, the always-visible answer
 * segment (§4.4), and the trailing status bar (§4.6).
 *
 * The head/trigger and the answer are deliberately siblings under one
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
  isLastTurn,
  sessionStatus,
  inFlightSession,
  sendStatus,
  pendingReply,
  baselineKnown,
  baselineMessageId,
  retry,
  nowMs,
  outputTokensDisplay,
  footerNowMs,
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
  const { process, answer } = useMemo(() => splitTurnBody(items), [items]);
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
    outputTokensDisplay,
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

  // §4.2 (A07 v3 revision): the call counts used to be this row's EXPAND body;
  // round-4's collapsed/expanded pair showed the body is the process segment,
  // so the counts moved up into the collapsed row's arg. Counted across the
  // whole turn, not one message — `deriveTurnStats` only reads `blocks`.
  const turnBlocks = useMemo(() => turn.body.flatMap((message) => message.blocks), [turn.body]);
  const stats = useMemo(
    () =>
      lastAssistant
        ? deriveTurnStats({ ...lastAssistant, blocks: turnBlocks }, { style: 'compact' })
        : null,
    [lastAssistant, turnBlocks]
  );
  const workedFor = formatWorkedForRow(metadata?.latencyMs, stats);
  // A turn whose process is one bare thought (no tool run) scores zero on
  // every `deriveTurnStats` bucket — see `turnHasThinkingOnlyProcess`'s
  // header comment for why that used to fall through to the label-less
  // `bare` rung below instead of saying "Thought".
  const thoughtOnly = useMemo(() => turnHasThinkingOnlyProcess(turnBlocks), [turnBlocks]);

  // F1: the head degrades `status -> workedFor -> stats -> thought -> bare
  // chevron` instead of stopping at the first two. A restored history turn
  // has neither of the first two (no T-06 metadata is replayed), so it used
  // to get a null head — no trigger, `collapsible === false`, force-expanded
  // — which made §4.3's "restored history defaults to collapsed" literally
  // unreachable. Nothing below fabricates a duration; the fallbacks print
  // counts derived from `blocks`, the D25 §2.4 bare "Thought" label, or no
  // text at all (A07 :2399 intact).
  const head = deriveTurnHeadModel({
    status,
    workedFor,
    stats,
    hasProcess: process.length > 0,
    thoughtOnly,
  });

  // ---- Process shell (§4.3) ----

  const permissionLock = hasUnresolvedPermission(turn);
  // §4.3's "a turn that completes while mounted stays expanded" is the reason
  // this is a lazy `useState` and not a derived value: the initializer runs
  // ONCE, at the turn's mount, exactly like the `<Collapsible defaultOpen>` the
  // spec describes (and like `ToolRows.tsx`'s per-row `defaultOpen`), so an
  // active -> complete transition cannot collapse content the user is watching.
  // NOT ASSERTABLE in a node-only vitest — this comment is the record (§6.2 ④).
  // Holding the state HERE rather than inside the shell also means the shell
  // may mount and unmount without ever re-deciding the open state.
  const [processOpen, setProcessOpen] = useState(() =>
    defaultTurnProcessOpen({
      isActive: turnActive,
      hasUnresolvedPermission: permissionLock,
      hasFailure: turnHasFailure(turn),
      answerEmpty: answer.length === 0,
    })
  );
  // Controlled, not `defaultOpen`, for one reason: `permissionLock` can turn
  // true AFTER the user has manually collapsed a running turn, and a disabled
  // trigger over a collapsed panel would then bury the authorization card —
  // the exact round-2 point-check #5 failure §4.3 calls the safety red line.
  // Forcing `open` here makes that unreachable by construction.
  const processShellOpen = permissionLock || processOpen;

  // F10: the forced-open state above is released the instant the user answers,
  // and if they had collapsed the turn before the card appeared the panel would
  // snap shut under the cursor — the answered card, and whatever ran next,
  // gone in the same frame they clicked. Adopting the forced state as the
  // manual one keeps the shell exactly as it looks at the moment of the click;
  // the user can still collapse it themselves afterwards.
  const wasPermissionLockedRef = useRef(permissionLock);
  useEffect(() => {
    if (wasPermissionLockedRef.current && !permissionLock) setProcessOpen(true);
    wasPermissionLockedRef.current = permissionLock;
  }, [permissionLock]);

  // The head IS the trigger (§4.8), and after F1 a turn with a process segment
  // ALWAYS has one (`deriveTurnHeadModel` guarantees a non-null model whenever
  // `hasProcess`, falling back to a text-less chevron row). So this is now
  // decided by the process segment alone — which is also what stops the shell
  // from mounting and unmounting when metadata arrives mid-turn and flips the
  // head from null to non-null, remounting the whole subtree twice (F2).
  const collapsible = process.length > 0;

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

  const renderItem = (item: TurnItem) => (
    <TurnItemView
      key={turnItemKey(item)}
      item={item}
      thinkingEnabled={thinkingEnabled}
      repoName={repoName}
      streamingBlockId={streamingBlockIdByMessage.get(item.messageId) ?? null}
      getThinkingDurationMs={getThinkingDurationMs}
      canRespondPermission={canRespondPermission}
      onRespondPermission={onRespondPermission}
    />
  );

  return (
    <section className={chatTurnClass()}>
      {turn.user && (
        // §5.1-A: plain CSS sticky, scoped by this `<section>`. That scoping IS
        // the release rule — when the turn's box leaves the top of the viewport
        // the bubble is pushed out and the next turn's takes over, so there is
        // no scroll listener, no IntersectionObserver and no `activeTurnId`
        // state anywhere in this file (§5.3). The former `fx-turn-band`
        // scroll-state query container is gone with the pinned-only clamp it
        // served (F10 — see `userBubbleTextClass()`).
        // NOT ASSERTABLE:
        // that sticky resolves against `ScrollArea.Viewport` (§6.2 ①③).
        <div className={turnBubbleBandClass()}>
          <UserBubble message={turn.user} />
        </div>
      )}
      <div className={turnBodyClass()}>
        {/* T-33: top of the turn body, below the pinned bubble band — the
            banner describes the reply in progress, so it lives in the reply
            zone, not above the user's own message. */}
        {retryBanner && <RetryBanner view={retryBanner} />}
        {collapsible ? (
          // F11: `Collapsible.Root` renders a bare `<div>`, so without a class
          // of its own the trigger row and the panel sat flush at 0px while
          // every other pair inside the turn kept P-17's 10px beat.
          <Collapsible
            open={processShellOpen}
            onOpenChange={setProcessOpen}
            disabled={permissionLock}
            className={turnProcessShellClass()}
          >
            <CollapsibleTrigger className={cn(turnHeadClass(), 'w-full disabled:cursor-default')}>
              <TurnHeadContent head={head} />
              {!permissionLock && (
                <ChevronDown
                  className={cn(
                    'size-3.5 shrink-0 transition-transform duration-150',
                    processShellOpen && 'rotate-180'
                  )}
                />
              )}
            </CollapsibleTrigger>
            {/* F5: `keepMounted` is the whole of §10-C's "expanded tool rows
                survive a collapse". Base UI's panel defaults to unmounting on
                close, and this panel takes the `animationType: 'none'` path
                (see `turnProcessPanelClass`), where "closed" means `mounted`
                goes false in the same tick — so every IN/OUT body the user had
                opened inside the process segment was destroyed and rebuilt at
                its default state on every collapse/expand. Tailwind's preflight
                gives `[hidden]` `display: none !important`, so the flex
                container below cannot override the hidden state. */}
            <CollapsibleContent
              keepMounted
              className={cn(turnProcessPanelClass(), turnBodyClass())}
            >
              {process.map(renderItem)}
            </CollapsibleContent>
          </Collapsible>
        ) : (
          <>
            {head && (
              <div className={turnHeadClass()}>
                <TurnHeadContent head={head} />
              </div>
            )}
            {process.map(renderItem)}
          </>
        )}
        {/* D3-b: the answer segment — and ONLY it — gets the neutral container.
            `splitTurnBody` defines `answer` as the trailing run of `text`
            items, so this box can never wrap a tool group, a permission card
            or a question card; those stay in `process`, which already has its
            own collapsible shell. Note the two sibling `turnBodyClass()` calls
            above read almost identically: the container belongs on THIS one. */}
        {answer.length > 0 && (
          <div className={cn(turnBodyClass(), turnAnswerContainerClass())}>
            {answer.map(renderItem)}
          </div>
        )}
        {/* F13: an in-flight turn's prose is half an answer, and a Copy button
            that silently yields it is worse than no button — the clipboard
            gives no sign the text was truncated. Restored history turns are NOT
            in flight, so they keep theirs. */}
        <TurnFooter metadata={metadata} copyText={turnActive ? '' : copyText} nowMs={footerNowMs} />
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
    case 'notice':
      return `${item.messageId}~notice`;
    default:
      return item.block.id;
  }
}

/**
 * The head slot's four rendered states (§4.7, extended by F1's degradation
 * chain in `deriveTurnHeadModel`).
 *
 * `stats` and `bare` only ever appear on a turn with no T-06 metadata — in
 * practice a restored history turn. They are what give such a turn a trigger,
 * and therefore a default-collapsed process segment, without printing a
 * duration nothing measured.
 */
function TurnHeadContent({ head }: { head: TurnHeadModel | null }) {
  // Unreachable from the collapsible trigger — `deriveTurnHeadModel` only
  // returns null when there is no process segment either — but the invariant
  // lives in that function, not in the type, so it is honoured rather than
  // asserted away.
  if (!head) return null;
  switch (head.kind) {
    case 'status':
      return <TurnStatusContent status={head.status} />;
    case 'workedFor':
      return <WorkedForContent row={head.row} />;
    case 'stats':
      // No verb: "Worked for" would be a claim about time, and this row exists
      // precisely because the time is unknown.
      return (
        <span className="min-w-0 truncate" title={head.text}>
          {head.text}
        </span>
      );
    case 'thought':
      // D25 §2.4's bare "Thought" (no arg — no duration to print for a
      // replayed turn), applied to the turn head instead of the per-row
      // shape. `THOUGHT_VERB` is the same constant `turnTiming.formatThoughtRow`
      // renders for the individual row, imported rather than re-spelled so the
      // two labels cannot drift apart.
      return <span className="shrink-0">{THOUGHT_VERB}</span>;
    default:
      // `bare` — the chevron the trigger renders beside this is the whole row.
      return null;
  }
}

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

/** Head slot, complete state (§4.7): `Worked for 1m 6s · 3 tools, 11 searches`. */
function WorkedForContent({ row }: { row: WorkedForRowText }) {
  return (
    <>
      <span className="shrink-0">{row.verb}</span>
      <span className="min-w-0 truncate">{row.arg}</span>
    </>
  );
}

interface TurnItemViewProps {
  item: TurnItem;
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
 * One flattened turn item. The five branches are `AssistantMessage`'s former
 * `groupTimeline` switch, moved verbatim so block order and every per-branch
 * ruling (T-05 D-4/D-5) survive the restructure, plus the `notice` branch
 * `flattenTurnItems` adds for system/error messages that used to be siblings of
 * the assistant message rather than part of its turn.
 */
function TurnItemView({
  item,
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
    case 'text': {
      const text = item.block.text ?? '';
      if (shouldRenderMarkdown({ blockId: item.block.id, streamingBlockId })) {
        return <ChatMarkdown text={text} />;
      }
      return (
        <p className="text-markdown leading-relaxed text-foreground whitespace-pre-wrap select-text">
          {text}
        </p>
      );
    }

    case 'toolGroup':
      return (
        <ToolGroupItem
          item={item}
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
  thinkingEnabled,
  repoName,
  streamingBlockId,
  getThinkingDurationMs,
}: {
  item: Extract<TurnItem, { kind: 'toolGroup' }>;
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
  return <ToolGroup rows={rows} />;
}

/**
 * Trailing status bar (§4.6 / P-34): model · relative time · copy, right
 * aligned.
 *
 * No duration here (§9-δ): the turn's elapsed time is the head's job, and
 * printing the same number twice was what A07 `:1871` removed. The reference
 * shot's footer agrees — it reads `3h ago` and nothing else.
 *
 * The relative timestamp keeps `formatRelativeAge`'s bucket table (P-18) and
 * the precision it trades away is restored on hover through `title`, matching
 * the sidebar's policy (§10-D). F9: the clock is passed IN rather than read
 * from `formatMessageMetadata`'s `defaultFormatTime`, which called `Date.now()`
 * at render time — so an idle session's ages froze at whatever they were when
 * the last render happened to run, and "just now" stayed "just now" for hours.
 */
function TurnFooter({
  metadata,
  copyText,
  nowMs,
}: {
  metadata?: MessageMetadata;
  copyText: string;
  /** Minute-resolution clock from `useMinuteTick`, the single source of "now" for the whole timeline's footers. */
  nowMs: number;
}) {
  const line = formatMessageMetadata(metadata, {
    omitLatency: true,
    formatTime: (ms) => formatRelativeTimestamp(ms, nowMs),
  });
  if (!line && copyText.length === 0) return null;
  return (
    <div className={turnFooterClass()}>
      {line && (
        <span
          className="min-w-0 truncate"
          title={
            metadata?.completedAt != null ? formatAbsoluteTime(metadata.completedAt) : undefined
          }
        >
          {line}
        </span>
      )}
      {copyText.length > 0 && <TurnCopyButton text={copyText} />}
    </div>
  );
}

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
