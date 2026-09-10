import { useEffect, useState } from 'react';
import { Spinner } from '@/components/ui/spinner';
import { useI18n } from '@/i18n';
import { type ChatMessage, useChatSessionsStore } from '@/stores/chatSessions';
import { useExtensionUiStore } from '@/stores/extensionUi';
import { countAssistantReplyChars } from './chatTurn';

/** The current turn is everything after the last user prompt. */
function currentReplyChars(messages: readonly ChatMessage[] | undefined): number {
  if (!messages) return 0;
  let start = messages.length;
  while (start > 0 && messages[start - 1].role !== 'user') start -= 1;
  return countAssistantReplyChars(messages.slice(start));
}

/**
 * F7b: the one running status, above the composer. The timeline used to mount
 * a second copy under the last turn; the user kept this one because it stays
 * visible while scrolling back.
 */
export function SessionActivityStatus({ sessionId }: { sessionId: string | null }) {
  const { t } = useI18n();
  const session = useChatSessionsStore((state) =>
    state.sessions.find((item) => item.id === sessionId)
  );
  const replyChars = useChatSessionsStore((state) =>
    sessionId ? currentReplyChars(state.messages[sessionId]) : 0
  );
  const pendingExtension = useExtensionUiStore((state) =>
    state.pending.find((request) => request.sessionId === sessionId)
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
  const kind = pendingExtension
    ? 'confirmation'
    : (activity?.phase ?? (session.status.startsWith('waiting_') ? 'confirmation' : 'waiting'));
  const since = pendingExtension?.receivedAt ?? activity?.since;
  const elapsed = since !== undefined ? Math.max(0, Math.floor((now - since) / 1000)) : null;
  const retry = pendingExtension ? undefined : activity?.retry;
  const delay =
    retry?.delayMs && activity
      ? Math.max(0, Math.ceil((activity.since + retry.delayMs - now) / 1000))
      : null;
  const label = [
    t(labels[kind]),
    pendingExtension ? undefined : activity?.tool,
    retry && retry.attempt > 0
      ? retry.maxRetries > 0
        ? `${retry.attempt}/${retry.maxRetries}`
        : String(retry.attempt)
      : null,
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
      className="mb-1 flex min-w-0 items-center gap-2 px-2 text-meta text-status-running"
    >
      <Spinner className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate" title={label}>
        {label}
      </span>
    </div>
  );
}
