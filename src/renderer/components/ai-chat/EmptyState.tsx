/**
 * Empty state for the Cursor-style chat UI.
 * Shown when no session is active, prompting the user to select a project or start a new session.
 */

import { FolderOpen, MessageSquare } from 'lucide-react';
import { cn } from '@/lib/utils';

interface EmptyStateProps {
  title?: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
  className?: string;
}

export function EmptyState({
  title = 'No active session',
  description = 'Select a project from the sidebar or start a new conversation.',
  actionLabel,
  onAction,
  className,
}: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center h-full gap-4 px-8', className)}>
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted/50">
        <MessageSquare className="h-8 w-8 text-muted-foreground" />
      </div>
      <div className="text-center">
        <h3 className="text-lg font-medium text-foreground">{title}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      {actionLabel && onAction && (
        <button
          type="button"
          onClick={onAction}
          className="flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          <FolderOpen className="h-4 w-4" />
          {actionLabel}
        </button>
      )}
    </div>
  );
}
