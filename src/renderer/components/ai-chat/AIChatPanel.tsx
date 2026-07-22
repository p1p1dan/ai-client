/**
 * Top-level container for the Cursor-style chat UI.
 * Replaces AgentPanel in the MainContent layout when using the middleware engine.
 */

import { useState } from 'react';
import { cn } from '@/lib/utils';
import { ChatInput } from './ChatInput';
import { EmptyState } from './EmptyState';
import { MessageList } from './MessageList';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  blocks: Array<{
    kind: 'text' | 'thinking' | 'tool_use';
    text?: string;
    toolUseId?: string;
    toolName?: string;
    input?: unknown;
    status?: 'streaming' | 'running' | 'done' | 'error';
    result?: string;
    isError?: boolean;
  }>;
  createdAt: number;
}

interface AIChatPanelProps {
  cwd?: string;
  repoPath?: string;
  className?: string;
}

export function AIChatPanel({ cwd, repoPath, className }: AIChatPanelProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [hasSession, setHasSession] = useState(false);

  const handleSend = (content: string, _imagePaths: string[]) => {
    if (!hasSession) setHasSession(true);

    // Add user message
    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      blocks: [{ kind: 'text', text: content }],
      createdAt: Date.now(),
    };
    setMessages((prev) => [...prev, userMessage]);

    // TODO: Replace with real middleware call when S2/S5 is integrated
    // For now, show a placeholder assistant response
    setIsStreaming(true);
    setTimeout(() => {
      const assistantMessage: Message = {
        id: crypto.randomUUID(),
        role: 'assistant',
        blocks: [
          {
            kind: 'text',
            text: `This is a placeholder response. The middleware engine will be integrated in a later phase.\n\nYou said: "${content}"`,
          },
        ],
        createdAt: Date.now(),
      };
      setMessages((prev) => [...prev, assistantMessage]);
      setIsStreaming(false);
    }, 500);
  };

  if (!hasSession && messages.length === 0) {
    return (
      <div className={cn('flex flex-col h-full', className)}>
        <EmptyState
          title="Start a conversation"
          description="Type a message below to begin a new AI session."
        />
        <ChatInput onSend={handleSend} cwd={cwd} repoPath={repoPath} isActive={true} />
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col h-full', className)}>
      <MessageList messages={messages} isStreaming={isStreaming} />
      <ChatInput onSend={handleSend} cwd={cwd} repoPath={repoPath} isActive={true} />
    </div>
  );
}
