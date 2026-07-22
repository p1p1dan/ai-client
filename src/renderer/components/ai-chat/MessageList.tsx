/**
 * Message list for the Cursor-style chat UI.
 * Renders the conversation as a scrollable list of bubbles and tool cards.
 */

import { memo, useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import { AssistantBubble } from './AssistantBubble';
import { StreamingBubble } from './StreamingBubble';
import { ToolCallCard } from './ToolCallCard';
import { UserBubble } from './UserBubble';

interface MessageBlock {
  kind: 'text' | 'thinking' | 'tool_use';
  text?: string;
  toolUseId?: string;
  toolName?: string;
  input?: unknown;
  status?: 'streaming' | 'running' | 'done' | 'error';
  result?: string;
  isError?: boolean;
}

interface Message {
  id: string;
  role: 'user' | 'assistant';
  blocks: MessageBlock[];
  createdAt: number;
}

interface MessageListProps {
  messages: Message[];
  isStreaming?: boolean;
  className?: string;
}

export const MessageList = memo(function MessageList({
  messages,
  isStreaming = false,
  className,
}: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new messages arrive or streaming updates
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on any message change
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isStreaming]);

  return (
    <div className={cn('flex-1 overflow-y-auto py-4', className)}>
      {messages.map((message) => {
        if (message.role === 'user') {
          const textBlock = message.blocks.find((b) => b.kind === 'text');
          const text = textBlock?.text ?? '';
          return <UserBubble key={message.id} text={text} />;
        }

        // Assistant message: render blocks in order
        return (
          <div key={message.id}>
            {message.blocks.map((block, idx) => {
              if (block.kind === 'text' && block.text) {
                return <AssistantBubble key={`${message.id}-${idx}`} content={block.text} />;
              }
              if (block.kind === 'tool_use') {
                return (
                  <ToolCallCard
                    key={block.toolUseId ?? `${message.id}-tool-${idx}`}
                    toolName={block.toolName ?? 'Unknown'}
                    toolUseId={block.toolUseId ?? ''}
                    input={block.input}
                    status={block.status ?? 'done'}
                    result={block.result}
                    isError={block.isError}
                  />
                );
              }
              return null;
            })}
          </div>
        );
      })}
      {isStreaming && <StreamingBubble />}
      <div ref={bottomRef} />
    </div>
  );
});
