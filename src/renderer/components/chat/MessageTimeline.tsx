import type { SessionRuntimeStatus } from '@shared/types/runtimeEvents';
import { ChevronRight, FileSearch, RefreshCw, ShieldAlert, TriangleAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import type { ChatBlock, ChatMessage } from '@/stores/chatSessions';
import { useChatSessionsStore } from '@/stores/chatSessions';
import {
  deriveHistoryNotice,
  deriveRetryControl,
  HISTORY_ERROR_NON_FATAL_HINT,
  type HistoryErrorView,
  selectHistoryError,
} from './historyError';
import { formatMessageMetadata, type MessageMetadata } from './messageMetadata';
import { ReadingColumn } from './ReadingColumn';
import { useResumeSession } from './sessionIndex/useResumeSession';
import { deriveThinkingCard, isTurnActive } from './thinkingCard';
import { useMessageMetadata } from './useMessageMetadata';

interface MessageTimelineProps {
  sessionId: string | null;
  status: SessionRuntimeStatus;
  /** Host capability gate (T-04)：thinking-capable 时为 true，UI 渲染折叠卡。 */
  thinkingEnabled: boolean;
}

export function MessageTimeline({ sessionId, status, thinkingEnabled }: MessageTimelineProps) {
  // C-08b: subscribe to this session's bucket only — other sessions' streams
  // no longer re-render this timeline.
  const bucket = useChatSessionsStore((state) =>
    sessionId ? state.messages[sessionId] : undefined
  );
  const respondPermission = useChatSessionsStore((state) => state.respondPermission);
  const pendingPermission = useChatSessionsStore((state) => state.pendingPermission);
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

  if (!sessionId) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Select a session to start chatting.
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 items-center gap-2 border-b px-3">
        <span className="text-xs text-muted-foreground">Session status</span>
        <Badge variant="outline" size="sm" className="capitalize">
          {status.replace(/_/g, ' ')}
        </Badge>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {/* Padding stays outside ReadingColumn — inside it would shave 24px off
            the documented 48rem/64rem reading width (T-22 spec §2.13). */}
        <div className="p-3">
          <ReadingColumn className="space-y-3">
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
                  canRespondPermission={Boolean(
                    pendingPermission &&
                      pendingPermission.sessionId === sessionId &&
                      message.id === pendingPermission.messageId
                  )}
                  onRespondPermission={respondPermission}
                />
              ))
            )}
            {status === 'failed' && (
              <div
                className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
                role="alert"
              >
                <p className="font-medium">Session failed</p>
                {lastError && (
                  <p className="mt-1 break-words whitespace-pre-wrap opacity-90">{lastError}</p>
                )}
                <p className="mt-1 opacity-70">已产内容保留。在下方输入框点 Retry 重发上条消息。</p>
                {pendingPermission?.sessionId === sessionId && (
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
  canRespondPermission: boolean;
  onRespondPermission: (allow: boolean) => void;
}

function MessageBubble({
  message,
  metadata,
  isActiveTurn,
  thinkingEnabled,
  canRespondPermission,
  onRespondPermission,
}: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const metaLine = !isUser ? formatMessageMetadata(metadata) : null;

  return (
    <article className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[85%] space-y-2 rounded-lg border px-3 py-2',
          // Speaker differentiation is a neutral job, so the bubble is bg-accent, not
          // the old bg-primary/10 - under Flexoki that low-alpha primary turned the
          // most-repeated surface in the app into brand orange.
          // Upstream splits this per scheme (flexoki-*.json colors.chat.
          // userMessageBackground: light #f7f4ec neutral, dark #27180E brand-tinted);
          // we deliberately do not, because this repo never registered a class-based
          // `dark` variant, so `dark:` still compiles to prefers-color-scheme and
          // would desync from the .dark palette. --accent is the only token that
          // separates from the assistant's bg-card/50 in *both* schemes.
          isUser ? 'border-border bg-accent' : 'border-border bg-card/50'
        )}
      >
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {message.role}
        </p>

        {message.blocks.map((block, index) => (
          <BlockRenderer
            key={block.id}
            block={block}
            blockIndex={index}
            message={message}
            isActiveTurn={isActiveTurn}
            thinkingEnabled={thinkingEnabled}
            canRespondPermission={canRespondPermission}
            onRespondPermission={onRespondPermission}
          />
        ))}

        {metaLine && <p className="text-[10px] text-muted-foreground/80">{metaLine}</p>}
      </div>
    </article>
  );
}

interface BlockRendererProps {
  block: ChatBlock;
  blockIndex: number;
  message: ChatMessage;
  isActiveTurn: boolean;
  thinkingEnabled: boolean;
  canRespondPermission: boolean;
  onRespondPermission: (allow: boolean) => void;
}

function BlockRenderer({
  block,
  blockIndex,
  message,
  isActiveTurn,
  thinkingEnabled,
  canRespondPermission,
  onRespondPermission,
}: BlockRendererProps) {
  switch (block.type) {
    case 'text':
      return <p className="whitespace-pre-wrap text-sm text-foreground">{block.text}</p>;

    case 'thinking': {
      // T-04 能力闸：capability=false 不渲染、不留入口。
      if (!thinkingEnabled) return null;
      const vm = deriveThinkingCard(message, blockIndex, isActiveTurn);
      if (!vm) return null;
      return <ThinkingCard vm={vm} />;
    }

    case 'tool_call':
      return (
        <div className="rounded-md border border-border bg-muted/30 p-2 text-xs">
          <p className="font-medium text-foreground">Tool: {block.toolName}</p>
          {block.toolInput ? (
            <pre className="mt-1 overflow-x-auto text-muted-foreground">
              {JSON.stringify(block.toolInput, null, 2)}
            </pre>
          ) : null}
        </div>
      );

    case 'tool_result':
      return (
        <div className="rounded-md border border-border bg-muted/20 p-2 text-xs">
          <p className="font-medium text-foreground">
            Tool result {block.toolOk ? '(ok)' : '(failed)'}
          </p>
          <pre className="mt-1 overflow-x-auto text-muted-foreground">
            {typeof block.toolOutput === 'string'
              ? block.toolOutput
              : JSON.stringify(block.toolOutput ?? block.text, null, 2)}
          </pre>
        </div>
      );

    case 'permission_request':
      return (
        <div className="space-y-2 rounded-md border border-warning/30 bg-warning/5 p-2 text-xs">
          <p className="font-medium text-foreground">Permission required: {block.toolName}</p>
          {block.toolDescription ? (
            <p className="text-muted-foreground">{block.toolDescription}</p>
          ) : null}
          {block.resolved ? (
            <Badge variant={block.allowed ? 'success' : 'destructive'} size="sm">
              {block.allowed ? 'Allowed' : 'Denied'}
            </Badge>
          ) : canRespondPermission ? (
            <div className="flex gap-1">
              <Button size="xs" className="h-6" onClick={() => onRespondPermission(true)}>
                Allow
              </Button>
              <Button
                size="xs"
                variant="outline"
                className="h-6"
                onClick={() => onRespondPermission(false)}
              >
                Deny
              </Button>
            </div>
          ) : (
            <Badge variant="warning" size="sm">
              Waiting
            </Badge>
          )}
        </div>
      );

    default:
      return null;
  }
}

interface ThinkingCardProps {
  vm: { state: 'streaming' | 'done'; text: string };
}

/**
 * T-04 Thinking 折叠卡：
 * - streaming：默认折叠 + 轻量指示（pulse 点 + "Thinking…"），不渲染空文本。
 * - done：默认折叠，可单击展开正文（whitespace-pre-wrap）；空文本显示占位。
 * 仅在 `thinkingEnabled === true` 时挂载（BlockRenderer 已先过滤）。
 */
function ThinkingCard({ vm }: ThinkingCardProps) {
  const [open, setOpen] = useState(false);
  const streaming = vm.state === 'streaming';
  const label = streaming ? 'Thinking' : 'Thought process';

  return (
    <Collapsible
      className="rounded-md border border-border bg-muted/20 text-xs"
      onOpenChange={setOpen}
      open={open}
    >
      <CollapsibleTrigger className="flex h-7 w-full min-w-0 items-center gap-1.5 px-2 text-left text-muted-foreground hover:bg-accent">
        {streaming ? (
          <span
            aria-hidden
            className="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-status-running"
          />
        ) : (
          <ChevronRight
            className={cn('h-3.5 w-3.5 shrink-0 transition-transform', open && 'rotate-90')}
          />
        )}
        <span className="min-w-0 flex-1 truncate font-medium text-foreground">{label}</span>
        {streaming && vm.text && (
          <span className="min-w-0 flex-1 truncate opacity-70">{vm.text.slice(-80)}</span>
        )}
      </CollapsibleTrigger>
      {!streaming && (
        <CollapsibleContent className="px-2 pb-2">
          {vm.text ? (
            <pre className="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-muted-foreground">
              {vm.text}
            </pre>
          ) : (
            <p className="text-[11px] italic text-muted-foreground/70">
              （thinking 段落为空，可能 Host 未发任何 delta）
            </p>
          )}
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}
