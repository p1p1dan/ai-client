import { useCallback, useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { useMessageQueueStore } from '@/stores/messageQueue';
import { useSessionRuntimeFactsStore } from '@/stores/sessionRuntimeFacts';
import { ChatComposer } from './ChatComposer';
import { HostStatusBanner } from './HostStatusBanner';
import { selectHistoryError } from './historyError';
import { MessageTimeline } from './MessageTimeline';
import {
  deriveMiddleColumnMode,
  middleColumnHostClass,
  rememberSendAttempt,
} from './middleColumnLayout';
import { PendingQuestionDock } from './PendingQuestionDock';
import { isThinkingCapable } from './thinkingCard';
import { deriveRepoName } from './toolCard';
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
  const workspaces = useChatSessionsStore((state) => state.workspaces);
  const selectSession = useChatSessionsStore((state) => state.selectSession);
  const { status: hostStatus, retry } = useHostStatus();

  // T-28: scalar selectors only — subscribing to `messages`/`hostBoundSessionIds`/
  // `historyErrors` wholesale would re-render this on every streaming session's
  // update, not just the active one.
  const messageCount = useChatSessionsStore((state) =>
    state.activeSessionId ? (state.messages[state.activeSessionId]?.length ?? 0) : 0
  );
  const hostBound = useChatSessionsStore((state) =>
    state.activeSessionId ? state.hostBoundSessionIds.includes(state.activeSessionId) : false
  );
  const hasHistoryError = useChatSessionsStore((state) =>
    Boolean(selectHistoryError(state.historyErrors, state.activeSessionId))
  );

  const activeSession = sessions.find((session) => session.id === activeSessionId);
  const thinkingEnabled = isThinkingCapable(hostStatus.capabilities);
  // T-05: repo name tail for Grep/Glob rows ("… in ai-client").
  const activeWorkspace = workspaces.find((ws) => ws.id === activeSession?.workspaceId);
  const repoName = deriveRepoName(activeWorkspace?.path);

  // T-28: sticky latch of sessions that have started a send this app run —
  // deriveMiddleColumnMode needs this to dock the composer the instant Enter
  // is pressed, without waiting for the store's first echoed message.
  const [sendAttempts, setSendAttempts] = useState<readonly string[]>([]);
  const markSendAttempt = useCallback(() => {
    // Read the current id off the store instead of closing over the
    // render-time `activeSessionId` — this callback is handed to ChatComposer
    // and must stay correct even if the active session changed since the
    // render that created it.
    const currentSessionId = useChatSessionsStore.getState().activeSessionId;
    setSendAttempts((prev) => rememberSendAttempt(prev, currentSessionId));
  }, []);

  const mode = deriveMiddleColumnMode({
    sessionId: activeSessionId,
    messageCount,
    sendAttempted: sendAttempts.includes(activeSessionId ?? ''),
    hostBound,
    hasRuntimeIdentity: activeSession?.runtimeIdentity != null,
    hasHistoryError,
    status: activeSession?.status ?? 'idle',
  });

  useEffect(() => {
    // chatSessions.initRuntime() only subscribes once (runtimeReady latch).
    // React Strict Mode / shell remount unsubscribes on cleanup, then the latch
    // prevents re-subscribe — Send appears to succeed with no timeline updates.
    // Reset the latch here without editing the red-line store file.
    useChatSessionsStore.setState({ runtimeReady: false });
    return initRuntime();
  }, [initRuntime]);

  useEffect(() => {
    // T-14: sessionRuntimeFacts's own single-listener latch. Unlike
    // chatSessions.ts's `runtimeReady` latch above — a red-line file whose
    // `initRuntime` cleanup never resets it, which is exactly why THAT effect
    // needs the manual `setState({ runtimeReady: false })` workaround — this
    // store owns its cleanup (sessionRuntimeFacts.ts's own `init()`) and
    // already resets `listening: false` there before unsubscribing. So a
    // StrictMode mount→cleanup→remount re-latches correctly on its own.
    //
    // Opus m9: this effect used to force `listening: false` here too, copied
    // from the pattern above. That defeated the latch instead of fixing
    // anything: a second concurrent mount would flip `listening` back to
    // false out from under an already-subscribed first mount and install a
    // second listener. Trust the store's own latch — do not reset it here.
    //
    // Started here — mounted for the whole app run, exactly like the
    // `useHostStatus()` call above — rather than from ContextSurfaceView, so
    // a session.created that fires before the user ever opens the Context
    // surface is still captured instead of permanently reading as "not
    // reported".
    return useSessionRuntimeFactsStore.getState().init();
  }, []);

  // Review fix: the latch would otherwise grow unbounded across a long run —
  // prune ids whose sessions no longer exist (removed / retired by tree sync).
  useEffect(() => {
    setSendAttempts((prev) => {
      const next = prev.filter((id) => sessions.some((session) => session.id === id));
      return next.length === prev.length ? prev : next;
    });
  }, [sessions]);

  // T-19 decision 6/7: drop message-queue buckets for sessions that no
  // longer exist (deleted / retired by tree sync / fork not followed) —
  // same rationale and same trigger as the `sendAttempts` prune above.
  useEffect(() => {
    useMessageQueueStore.getState().pruneSessions(sessions.map((session) => session.id));
  }, [sessions]);

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
      {mode === 'session' && (
        <MessageTimeline
          sessionId={activeSessionId}
          status={activeSession?.status ?? 'idle'}
          thinkingEnabled={thinkingEnabled}
          repoName={repoName}
        />
      )}
      {mode === 'session' && <PendingQuestionDock sessionId={activeSessionId} />}
      <div className={middleColumnHostClass(mode)}>
        <ChatComposer
          mode={mode}
          disabled={!activeSessionId}
          onAddRepository={onAddRepository}
          onSendStart={markSendAttempt}
        />
      </div>
    </section>
  );
}
