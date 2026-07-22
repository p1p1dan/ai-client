/**
 * Session list sidebar for the Cursor-style chat UI.
 * Displays historical sessions for the current project, allowing the user to resume conversations.
 */

import { MessageSquare, Plus } from 'lucide-react';
import { memo } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

interface SessionMeta {
  sessionId: string;
  firstUserMessage: string;
  messageCount: number;
  lastActivityAt: number;
}

interface SessionListSidebarProps {
  sessions: SessionMeta[];
  activeSessionId?: string;
  onSelectSession: (sessionId: string) => void;
  onNewSession: () => void;
  className?: string;
}

function formatTimestamp(ts: number): string {
  const date = new Date(ts * 1000);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export const SessionListSidebar = memo(function SessionListSidebar({
  sessions,
  activeSessionId,
  onSelectSession,
  onNewSession,
  className,
}: SessionListSidebarProps) {
  return (
    <div className={cn('w-60 border-r border-border bg-background flex flex-col', className)}>
      <div className="h-9 flex items-center px-3 border-b border-border shrink-0">
        <span className="text-xs font-semibold text-muted-foreground">Sessions</span>
        <button
          type="button"
          onClick={onNewSession}
          className="ml-auto h-5 w-5 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          aria-label="New session"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
      <ScrollArea className="flex-1">
        <div className="py-1">
          {sessions.length === 0 && (
            <div className="px-3 py-4 text-xs text-muted-foreground text-center">
              No sessions yet
            </div>
          )}
          {sessions.map((session) => (
            <button
              key={session.sessionId}
              type="button"
              onClick={() => onSelectSession(session.sessionId)}
              className={cn(
                'w-full text-left px-3 py-2 transition-colors',
                session.sessionId === activeSessionId
                  ? 'bg-accent text-accent-foreground'
                  : 'text-foreground hover:bg-accent/50'
              )}
            >
              <div className="flex items-start gap-2">
                <MessageSquare className="h-3.5 w-3.5 mt-0.5 shrink-0 text-muted-foreground" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm truncate">{session.firstUserMessage || 'Untitled'}</div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-xs text-muted-foreground">
                      {session.messageCount} messages
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {formatTimestamp(session.lastActivityAt)}
                    </span>
                  </div>
                </div>
              </div>
            </button>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
});
