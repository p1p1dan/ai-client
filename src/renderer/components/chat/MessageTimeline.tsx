import type { SessionRuntimeStatus } from '@shared/types/runtimeEvents';
import { useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import type { ChatBlock, ChatMessage } from '@/stores/chatSessions';
import { useChatSessionsStore } from '@/stores/chatSessions';

interface MessageTimelineProps {
  sessionId: string | null;
  status: SessionRuntimeStatus;
}

export function MessageTimeline({ sessionId, status }: MessageTimelineProps) {
  const messages = useChatSessionsStore((state) => state.messages);
  const respondPermission = useChatSessionsStore((state) => state.respondPermission);
  const pendingPermission = useChatSessionsStore((state) => state.pendingPermission);

  const sessionMessages = useMemo(
    () => (sessionId ? messages.filter((message) => message.sessionId === sessionId) : []),
    [messages, sessionId]
  );

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
        <div className="space-y-3 p-3">
          {sessionMessages.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No messages yet. Send a prompt to stream from the Agent Host.
            </p>
          ) : (
            sessionMessages.map((message) => (
              <MessageBubble
                key={message.id}
                message={message}
                canRespondPermission={Boolean(
                  pendingPermission &&
                    pendingPermission.sessionId === sessionId &&
                    message.id === pendingPermission.messageId
                )}
                onRespondPermission={respondPermission}
              />
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

interface MessageBubbleProps {
  message: ChatMessage;
  canRespondPermission: boolean;
  onRespondPermission: (allow: boolean) => void;
}

function MessageBubble({ message, canRespondPermission, onRespondPermission }: MessageBubbleProps) {
  const isUser = message.role === 'user';

  return (
    <article className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[85%] space-y-2 rounded-lg border px-3 py-2',
          isUser ? 'border-primary/20 bg-primary/10' : 'border-border bg-card/50'
        )}
      >
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {message.role}
        </p>

        {message.blocks.map((block) => (
          <BlockRenderer
            key={block.id}
            block={block}
            canRespondPermission={canRespondPermission}
            onRespondPermission={onRespondPermission}
          />
        ))}
      </div>
    </article>
  );
}

interface BlockRendererProps {
  block: ChatBlock;
  canRespondPermission: boolean;
  onRespondPermission: (allow: boolean) => void;
}

function BlockRenderer({ block, canRespondPermission, onRespondPermission }: BlockRendererProps) {
  switch (block.type) {
    case 'text':
      return <p className="whitespace-pre-wrap text-sm text-primary">{block.text}</p>;

    case 'tool_call':
      return (
        <div className="rounded-md border border-border bg-muted/30 p-2 text-xs">
          <p className="font-medium text-primary">Tool: {block.toolName}</p>
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
          <p className="font-medium text-primary">
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
          <p className="font-medium text-primary">Permission required: {block.toolName}</p>
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
