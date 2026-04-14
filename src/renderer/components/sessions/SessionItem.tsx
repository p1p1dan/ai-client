import type { ClaudeProject, ClaudeSessionMeta } from '@shared/types';
import { MessageSquare } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatActivityLabel } from './time';

interface SessionItemProps {
  project: ClaudeProject;
  session: ClaudeSessionMeta;
  onResumeSession?: (session: ClaudeSessionMeta, project: ClaudeProject) => void;
  className?: string;
}

export function SessionItem({ project, session, onResumeSession, className }: SessionItemProps) {
  const message = session.firstMessage ?? '（无预览）';
  const activityLabel = formatActivityLabel(session.lastMessageAt ?? session.createdAt);

  return (
    <button
      className={cn(
        'flex w-full min-w-0 items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-accent',
        className
      )}
      onClick={() => onResumeSession?.(session, project)}
      type="button"
    >
      <MessageSquare className="h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            'truncate text-sm',
            session.firstMessage ? 'text-foreground' : 'text-muted-foreground'
          )}
          title={session.firstMessage ?? undefined}
        >
          {message}
        </div>
        <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">{session.id}</div>
      </div>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{activityLabel}</span>
      {session.model ? (
        <span className="shrink-0 text-xs text-muted-foreground">{session.model}</span>
      ) : null}
    </button>
  );
}
