import type { SessionRuntimeStatus } from '@shared/types/runtimeEvents';
import { ChevronRight, FileSearch, RefreshCw, ShieldAlert, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import type { ChatMessage } from '@/stores/chatSessions';
import { useChatSessionsStore } from '@/stores/chatSessions';
import {
  deriveHistoryNotice,
  deriveRetryControl,
  HISTORY_ERROR_NON_FATAL_HINT,
  type HistoryErrorView,
  selectHistoryError,
} from './historyError';
import { formatMessageMetadata, type MessageMetadata } from './messageMetadata';
import { shouldStickToBottom } from './messageTimelineScroll';
import { TIMELINE_PADDING_CLASS } from './middleColumnLayout';
import { QuestionCard } from './QuestionCard';
import { canRespondToPermission, deriveQuestionCardState } from './questionCard';
import { ReadingColumn } from './ReadingColumn';
import { useResumeSession } from './sessionIndex/useResumeSession';
import { ToolGroup } from './ToolRows';
import { isTurnActive } from './thinkingCard';
import {
  deriveToolGroupRows,
  groupTimeline,
  type ToolGroupEntry,
  type ToolRowView,
} from './toolCard';
import { deriveTurnStats, formatWorkedForRow } from './turnTiming';
import { useMessageMetadata } from './useMessageMetadata';
import { useTurnTiming } from './useTurnTiming';

/**
 * The base-ui `ScrollArea`'s actual scrollable node is the inner Viewport
 * div (`ui/scroll-area.tsx` tags it `data-slot="scroll-area-viewport"`), not
 * the `ScrollArea` root — that root is a non-scrolling positioning wrapper.
 */
function findViewport(root: HTMLDivElement | null): HTMLDivElement | null {
  return root?.querySelector<HTMLDivElement>('[data-slot="scroll-area-viewport"]') ?? null;
}

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
  // C-06 / T-03: this session's history read error only. Subscribing to the
  // single key (a plain string) keeps a background session's failure out of
  // this timeline and out of its re-renders — the store rebuilds the whole
  // record on every `session.history` ingest.
  const historyError = useChatSessionsStore((state) =>
    selectHistoryError(state.historyErrors, sessionId)
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

  const isActiveTurn = isTurnActive(status);

  // Stick-to-bottom scroll following. `scrollRootRef` wraps `ScrollArea` (the
  // real scrollable viewport is found through it via `findViewport`);
  // `contentRef` is the rendered content whose height growth we watch.
  // `stickToBottomRef` is a ref, not state — it is read/written on every
  // native scroll and resize tick, and must never trigger a re-render.
  const scrollRootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  // Track whether the user is anchored to the bottom. Read fresh on every
  // native scroll event so a manual scroll-up is never fought by auto-scroll,
  // and scrolling back down re-arms following.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId triggers re-querying the viewport node, which base-ui remounts across the null <-> id transition
  useEffect(() => {
    const viewport = findViewport(scrollRootRef.current);
    if (!viewport) return undefined;
    const handleScroll = () => {
      stickToBottomRef.current = shouldStickToBottom(
        viewport.scrollTop,
        viewport.scrollHeight,
        viewport.clientHeight
      );
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
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [sessionId]);

  if (!sessionId) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Select a session to start chatting.
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" ref={scrollRootRef}>
      <ScrollArea className="min-h-0 flex-1">
        {/* Padding stays outside ReadingColumn — inside it would shave 24px off
            the documented 48rem/64rem reading width (T-22 spec §2.13). */}
        <div className={TIMELINE_PADDING_CLASS} ref={contentRef}>
          {/* T-05 (A07 `.tl` :846): 12px -> 20px turn spacing. */}
          <ReadingColumn className="space-y-5">
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
            {historyNotice.kind === 'empty' ? (
              <p className="text-sm text-muted-foreground">
                No messages yet. Send a prompt to stream from the Agent Host.
              </p>
            ) : (
              sessionMessages.map((message) => (
                <MessageBubble
                  key={message.id}
                  message={message}
                  metadata={getMeta(message.id)}
                  isActiveTurn={isActiveTurn}
                  thinkingEnabled={thinkingEnabled}
                  repoName={repoName}
                  getThinkingDurationMs={(blockId) => getThinking(blockId)?.durationMs}
                  canRespondPermission={canRespondPermission}
                  onRespondPermission={respondPermission}
                />
              ))
            )}
            {status === 'failed' && (
              <div
                className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs"
                role="alert"
              >
                {/* T-30 P-06: only the title carries destructive weight — body
                    and hint fall back to muted-foreground so a session-level
                    failure doesn't stack a second red block on top of the
                    already-red failed tool rows above it. */}
                <p className="font-medium text-destructive">Session failed</p>
                {lastError && (
                  <p className="mt-1 break-words whitespace-pre-wrap text-muted-foreground">
                    {lastError}
                  </p>
                )}
                <p className="mt-1 text-muted-foreground">
                  已产内容保留。在下方输入框点 Retry 重发上条消息。
                </p>
                {pendingPermissions.some((item) => item.sessionId === sessionId) && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-2 h-6 text-xs"
                    onClick={() => void stopActiveSession()}
                  >
                    Stop
                  </Button>
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
      const resumed = await resume(sessionId);
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
      <AlertDescription className="gap-1 text-xs">
        <p className="break-words">{view.guidance}</p>
        <p>{HISTORY_ERROR_NON_FATAL_HINT}</p>
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
              <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-all">
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

interface MessageBubbleProps {
  message: ChatMessage;
  metadata?: MessageMetadata;
  isActiveTurn: boolean;
  thinkingEnabled: boolean;
  repoName?: string | null;
  getThinkingDurationMs: (blockId: string) => number | null | undefined;
  canRespondPermission: (permissionId: string | undefined) => boolean;
  onRespondPermission: (permissionId: string, allow: boolean) => Promise<boolean>;
}

/**
 * T-05 (D-1) -> T-30 (P-08/P-09/P-11): three role branches.
 *  - assistant -> bare `AssistantMessage` (no bubble, no role label; A07 `:1725`/`:858`).
 *  - user -> `.fx-user-bubble` shape (A07 `:849-855`); no role label — neither
 *    A01 (`:1060-1061`) nor A07 (`:1721-1722`) ever put one on the markup.
 *  - system / error -> `Alert` primitive (same shell as `HistoryErrorNotice`
 *    below), not a chat bubble — A07 never defined a bubble form for these,
 *    and reusing the user bubble produced a third, baseline-undefined shape.
 */
function MessageBubble({
  message,
  metadata,
  isActiveTurn,
  thinkingEnabled,
  repoName,
  getThinkingDurationMs,
  canRespondPermission,
  onRespondPermission,
}: MessageBubbleProps) {
  if (message.role === 'assistant') {
    return (
      <AssistantMessage
        message={message}
        metadata={metadata}
        isActiveTurn={isActiveTurn}
        thinkingEnabled={thinkingEnabled}
        repoName={repoName}
        getThinkingDurationMs={getThinkingDurationMs}
        canRespondPermission={canRespondPermission}
        onRespondPermission={onRespondPermission}
      />
    );
  }

  if (message.role === 'system' || message.role === 'error') {
    return <NoticeMessage message={message} />;
  }

  return (
    <article className="flex justify-end">
      <div
        className={cn(
          'max-w-[85%] space-y-2 rounded-lg border px-4 py-2.5',
          // T-30 P-09: A07 `.fx-user-bubble` (`:849-855`) — 16/16/4/16 corners
          // (sharp bottom-right "tail" toward the right-aligned edge), --card
          // fill, primary-8% border. The old note about assistant needing
          // bg-accent for contrast against `bg-card/50` no longer applies —
          // T-05 already made assistant bubble-less, so user is free to sit
          // on the same --card surface as the rest of the shell.
          'rounded-br-xs border-primary/8 bg-card'
        )}
      >
        {/* user messages only ever carry `text` blocks (chatSessions.ts attaches
            tool_call/tool_result/thinking/permission_request/question exclusively
            to role: 'assistant' messages, live and replayed alike). */}
        {message.blocks.map((block) =>
          block.type === 'text' ? (
            <p
              key={block.id}
              className="whitespace-pre-wrap text-markdown leading-normal text-foreground"
            >
              {block.text}
            </p>
          ) : null
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
  return (
    <Alert variant={isError ? 'error' : 'default'} role={isError ? 'alert' : 'status'}>
      <AlertDescription>
        {message.blocks.map((block) =>
          block.type === 'text' ? (
            <p key={block.id} className="whitespace-pre-wrap text-foreground">
              {block.text}
            </p>
          ) : null
        )}
      </AlertDescription>
    </Alert>
  );
}

interface AssistantMessageProps {
  message: ChatMessage;
  metadata?: MessageMetadata;
  isActiveTurn: boolean;
  thinkingEnabled: boolean;
  repoName?: string | null;
  getThinkingDurationMs: (blockId: string) => number | null | undefined;
  canRespondPermission: (permissionId: string | undefined) => boolean;
  onRespondPermission: (permissionId: string, allow: boolean) => Promise<boolean>;
}

/**
 * T-05 (D-1/D-3): bare assistant container — no border, no fill, no role
 * label. Renders, in order: the turn's "Worked for Ns" row (A07 `:1728`,
 * top of turn, only when T-06 latency metadata is available), then
 * `groupTimeline`'s items (text / tool groups / permission / frozen
 * question), then the footer (`model · time`, latency dropped since the
 * "Worked for" row took over that duty).
 */
function AssistantMessage({
  message,
  metadata,
  isActiveTurn,
  thinkingEnabled,
  repoName,
  getThinkingDurationMs,
  canRespondPermission,
  onRespondPermission,
}: AssistantMessageProps) {
  const workedForRow = buildWorkedForRow(message, metadata);
  const items = groupTimeline(message);
  // Mirrors the pre-T-05 `deriveThinkingCard` streaming check: the turn's
  // active flag gates it, and only the message's own last block can be "in
  // flight" (thinking blocks that aren't last never match, so this needs no
  // extra type guard).
  const isStreamingBlockId =
    isActiveTurn && message.blocks.length > 0 ? message.blocks[message.blocks.length - 1].id : null;
  const footerLine = formatMessageMetadata(metadata, { omitLatency: true });

  return (
    // T-30 P-17: `gap-2.5` (10px) is the single source of the "段间" gap
    // between every direct item (tool group, paragraph, question/permission
    // card, footer) — replaces the old per-item `my-2.5`/`[&>p+p]:mt-2.5`
    // margins, which could collapse into (or stack on top of) ReadingColumn's
    // turn-to-turn `space-y-5` depending on which item type sat at the edge.
    <article className="flex flex-col gap-2.5 text-markdown leading-normal">
      {workedForRow && <ToolGroup rows={[workedForRow]} />}

      {items.map((item) => {
        switch (item.kind) {
          case 'text':
            return (
              <p
                key={item.block.id}
                className="text-markdown leading-normal text-foreground whitespace-pre-wrap"
              >
                {item.block.text}
              </p>
            );

          case 'toolGroup': {
            const entries = filterThinkingEntries(item.entries, thinkingEnabled);
            const rows = deriveToolGroupRows(entries, {
              repoName,
              thinkingDurationMs: getThinkingDurationMs,
              isStreamingBlockId,
            });
            return <ToolGroup key={`tool-group-${item.blockIndex}`} rows={rows} />;
          }

          case 'permission':
            // T-05 (D-5): same `.qa` shell as questions, thin adapter over
            // `derivePermissionCardView` — position unchanged (block-order,
            // not the Dock), Allow/Deny behavior preserved verbatim.
            return (
              <QuestionCard
                key={item.block.id}
                variant="permission"
                block={item.block}
                canRespond={canRespondPermission(item.block.permissionId)}
                onRespondPermission={(allow) =>
                  onRespondPermission(item.block.permissionId ?? '', allow)
                }
              />
            );

          case 'question': {
            // T-05 (D-4): the live, answerable card lives in
            // `PendingQuestionDock` (outside ScrollArea, docked above the
            // Composer) — this branch only renders once the question is
            // frozen (answered/skipped), in its original block position.
            const state = deriveQuestionCardState(item.block);
            if (state === 'pending') return null;
            return <QuestionCard key={item.block.id} variant="frozen" block={item.block} />;
          }

          default:
            return null;
        }
      })}

      {footerLine && (
        <p className="flex flex-wrap items-center gap-2 text-code text-muted-foreground">
          {footerLine}
        </p>
      )}
    </article>
  );
}

/** T-04 capability gate: dropped, not just hidden — no leftover entry point when disabled. */
function filterThinkingEntries(
  entries: readonly ToolGroupEntry[],
  thinkingEnabled: boolean
): readonly ToolGroupEntry[] {
  return thinkingEnabled ? entries : entries.filter((entry) => entry.kind !== 'thinking');
}

/**
 * Turn-level "Worked for Ns" row (A07 `:1728`/`:2398`): reuses `ToolRow`'s own
 * rendering pipeline instead of a bespoke component — same verb/arg column,
 * same `.ct-think` expand body, just a view-model built from `turnTiming.ts`
 * instead of a tool run.
 */
function buildWorkedForRow(message: ChatMessage, metadata?: MessageMetadata): ToolRowView | null {
  const worked = formatWorkedForRow(metadata?.latencyMs);
  if (!worked) return null;
  const stats = deriveTurnStats(message);
  return {
    key: `${message.id}~worked-for`,
    verb: worked.verb,
    arg: worked.arg,
    running: false,
    failed: false,
    expandable: Boolean(stats),
    body: stats ? 'stats' : undefined,
    output: stats ?? undefined,
  };
}
