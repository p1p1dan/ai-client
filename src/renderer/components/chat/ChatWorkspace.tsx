import { useEffect } from 'react';
import { cn } from '@/lib/utils';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { ChatComposer } from './ChatComposer';
import { HostStatusBanner } from './HostStatusBanner';
import { MessageTimeline } from './MessageTimeline';
import { isThinkingCapable } from './thinkingCard';
import { useHostStatus } from './useHostStatus';

interface ChatWorkspaceProps {
  className?: string;
  /** Opens the shared AddRepositoryDialog (owned by App) — threaded down to ComposerTargetBar. */
  onAddRepository?: (mode?: 'local' | 'remote' | 'ssh') => void;
}

export function ChatWorkspace({ className, onAddRepository }: ChatWorkspaceProps) {
  const initRuntime = useChatSessionsStore((state) => state.initRuntime);
  const activeSessionId = useChatSessionsStore((state) => state.activeSessionId);
  const sessions = useChatSessionsStore((state) => state.sessions);
  const selectSession = useChatSessionsStore((state) => state.selectSession);
  const { status: hostStatus, retry } = useHostStatus();

  const activeSession = sessions.find((session) => session.id === activeSessionId);
  const thinkingEnabled = isThinkingCapable(hostStatus.capabilities);

  useEffect(() => {
    // chatSessions.initRuntime() only subscribes once (runtimeReady latch).
    // React Strict Mode / shell remount unsubscribes on cleanup, then the latch
    // prevents re-subscribe — Send appears to succeed with no timeline updates.
    // Reset the latch here without editing the red-line store file.
    useChatSessionsStore.setState({ runtimeReady: false });
    return initRuntime();
  }, [initRuntime]);

  // After tree sync, activeSessionId can point at a removed demo id — pick a live one.
  useEffect(() => {
    if (activeSessionId && sessions.some((session) => session.id === activeSessionId)) {
      return;
    }
    const fallback =
      sessions.find((session) => session.title === 'Live Agent Host') ?? sessions[0] ?? null;
    if (fallback) {
      selectSession(fallback.id);
    }
  }, [activeSessionId, sessions, selectSession]);

  return (
    <section className={cn('flex min-h-0 flex-col', className)}>
      <HostStatusBanner status={hostStatus} onRetry={() => void retry()} />
      <MessageTimeline
        sessionId={activeSessionId}
        status={activeSession?.status ?? 'idle'}
        thinkingEnabled={thinkingEnabled}
      />
      <ChatComposer disabled={!activeSessionId} onAddRepository={onAddRepository} />
    </section>
  );
}
