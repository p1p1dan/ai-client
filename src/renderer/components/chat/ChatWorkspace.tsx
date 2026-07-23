import { useEffect } from 'react';
import { cn } from '@/lib/utils';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { ChatComposer } from './ChatComposer';
import { MessageTimeline } from './MessageTimeline';

interface ChatWorkspaceProps {
  className?: string;
}

export function ChatWorkspace({ className }: ChatWorkspaceProps) {
  const initMockRuntime = useChatSessionsStore((state) => state.initMockRuntime);
  const activeSessionId = useChatSessionsStore((state) => state.activeSessionId);
  const sessions = useChatSessionsStore((state) => state.sessions);

  const activeSession = sessions.find((session) => session.id === activeSessionId);

  useEffect(() => {
    return initMockRuntime();
  }, [initMockRuntime]);

  return (
    <section className={cn('flex min-h-0 flex-col', className)}>
      <MessageTimeline sessionId={activeSessionId} status={activeSession?.status ?? 'idle'} />
      <ChatComposer disabled={!activeSessionId} />
    </section>
  );
}
