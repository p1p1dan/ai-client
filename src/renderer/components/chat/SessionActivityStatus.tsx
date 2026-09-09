import { useEffect, useState } from 'react';
import { Spinner } from '@/components/ui/spinner';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useChatSessionsStore } from '@/stores/chatSessions';

export function SessionActivityStatus({
  sessionId,
  compact = false,
  replyChars = 0,
}: {
  sessionId: string | null;
  compact?: boolean;
  replyChars?: number;
}) {
  const { t } = useI18n();
  const session = useChatSessionsStore((state) =>
    state.sessions.find((item) => item.id === sessionId)
  );
  const activity = session?.activity;
  const [now, setNow] = useState(Date.now);
  const running =
    session &&
    ['starting', 'running', 'waiting_permission', 'waiting_question', 'stopping'].includes(
      session.status
    );
  useEffect(() => {
    if (!running || !sessionId) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running, sessionId]);
  if (!running) return null;
  const labels = {
    waiting: 'Waiting for model',
    thinking: 'Thinking',
    output: 'Writing response',
    tool: 'Running tool',
    confirmation: 'Waiting for confirmation',
    retry: 'Retrying',
    failed: 'Failed',
    stopping: 'Stopping',
  } as const;
  const kind =
    activity?.phase ?? (session.status.startsWith('waiting_') ? 'confirmation' : 'waiting');
  const elapsed = activity ? Math.max(0, Math.floor((now - activity.since) / 1000)) : null;
  const retry = activity?.retry;
  const delay =
    retry?.delayMs && activity
      ? Math.max(0, Math.ceil((activity.since + retry.delayMs - now) / 1000))
      : null;
  const label = [
    t(labels[kind]),
    activity?.tool,
    retry ? `${retry.attempt}/${retry.maxRetries}` : null,
    delay !== null
      ? delay > 0
        ? t('Retry in {{seconds}}s', { seconds: delay })
        : t('Waiting for retry response')
      : null,
    replyChars > 0 ? `↓ ${replyChars} ${t('chars')}` : null,
    elapsed !== null ? `${elapsed}s` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div
      role="status"
      data-session-activity={kind}
      className={cn(
        'flex min-w-0 items-center gap-2 text-meta text-status-running',
        compact ? 'mb-1 px-2' : 'py-1'
      )}
    >
      <Spinner className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate" title={label}>
        {label}
      </span>
    </div>
  );
}
