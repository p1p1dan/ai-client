import type { LegacyImportSessionPreview } from '@shared/types';
import { CheckCircle2, MessageSquare, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import { formatActivityLabel } from './time';

interface SessionItemProps {
  session: LegacyImportSessionPreview;
  selected: boolean;
  disabled?: boolean;
  onSelectedChange: (selected: boolean) => void;
  result?: 'imported' | 'already-imported' | 'failed';
  error?: string;
}

export function SessionItem({
  session,
  selected,
  disabled,
  onSelectedChange,
  result,
  error,
}: SessionItemProps) {
  const message = session.firstMessage ?? '（无预览）';
  const activityLabel = formatActivityLabel(session.lastMessageAt ?? session.createdAt);
  return (
    <label
      className={cn(
        'flex min-h-14 w-full min-w-0 items-center gap-3 rounded-sm border border-transparent px-2 py-2 text-left transition-colors hover:bg-accent/50',
        selected && 'bg-selection',
        disabled && 'opacity-64'
      )}
    >
      <Checkbox
        checked={selected}
        disabled={disabled}
        onCheckedChange={(checked) => onSelectedChange(checked === true)}
      />
      <MessageSquare className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            'truncate text-ui',
            session.firstMessage ? 'text-foreground' : 'text-muted-foreground'
          )}
          title={session.firstMessage ?? undefined}
        >
          {message}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-2 text-meta text-muted-foreground">
          <span className="min-w-0 truncate font-mono text-code tracking-normal">{session.id}</span>
          {session.importedSnapshots > 0 ? (
            <Badge size="sm" variant="outline">
              已导入 {session.importedSnapshots} 个快照
            </Badge>
          ) : null}
        </div>
        {error ? <div className="mt-1 text-meta text-destructive">{error}</div> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2 text-meta text-muted-foreground tabular-nums">
        {result === 'imported' ? <CheckCircle2 className="size-4 text-success" /> : null}
        {result === 'already-imported' ? <CheckCircle2 className="size-4 text-info" /> : null}
        {result === 'failed' ? <XCircle className="size-4 text-destructive" /> : null}
        <span>{activityLabel}</span>
        {session.model ? <span>{session.model}</span> : null}
      </div>
    </label>
  );
}
