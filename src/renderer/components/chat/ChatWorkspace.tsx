import { useCallback, useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { useExtensionUiStore } from '@/stores/extensionUi';
import { useExtensionUiDisplayStore } from '@/stores/extensionUiDisplay';
import { pruneSessionScopedRendererState } from '@/stores/sessionLifecycle';
import { markSessionsLive } from '@/stores/sessionRetirement';
import { useSessionRuntimeFactsStore } from '@/stores/sessionRuntimeFacts';
import { useSubagentActivityStore } from '@/stores/subagentActivity';
import { ChatComposer } from './ChatComposer';
import { ChatWelcomeCard } from './ChatWelcomeCard';
import { ExtensionUiDialog, ExtensionUiInlineDock } from './ExtensionUiDialog';
import {
  ExtensionUiNotificationEffects,
  ExtensionUiStatusChips,
  ExtensionUiUnsupportedNotice,
  ExtensionUiWidgets,
} from './ExtensionUiSurfaces';
import { HostStatusBanner } from './HostStatusBanner';
import { selectHistoryError } from './historyError';
import { MessageTimeline } from './MessageTimeline';
import {
  deriveMiddleColumnMode,
  middleColumnHostClass,
  rememberSendAttempt,
} from './middleColumnLayout';
import type { RunSendOrigin } from './queueRelease';
import { ReadingColumn } from './ReadingColumn';
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
  const hasWorkingDirectory = workspaces.some((workspace) => workspace.path.trim().length > 0);

  // T-28: sticky latch of sessions that have started a send this app run —
  // deriveMiddleColumnMode needs this to dock the composer the instant Enter
  // is pressed, without waiting for the store's first echoed message.
  const [sendAttempts, setSendAttempts] = useState<readonly string[]>([]);
  const [sendJumpRequest, setSendJumpRequest] = useState(0);
  const markSendAttempt = useCallback((origin: RunSendOrigin) => {
    // Read the current id off the store instead of closing over the
    // render-time `activeSessionId` — this callback is handed to ChatComposer
    // and must stay correct even if the active session changed since the
    // render that created it.
    const currentSessionId = useChatSessionsStore.getState().activeSessionId;
    setSendAttempts((prev) => rememberSendAttempt(prev, currentSessionId));
    // T26: only a deliberate Send/Retry is user intent to return to the live
    // edge. A queued entry may auto-release much later, after the reader has
    // scrolled up again, so `release` must not force their position.
    if (origin !== 'release') {
      setSendJumpRequest((request) => request + 1);
    }
  }, []);

  // One read of the latch for this render: the mode derivation, the binding
  // lock and the picker's own prop are three consumers of the same fact.
  const sendAttempted = sendAttempts.includes(activeSessionId ?? '');

  const mode = deriveMiddleColumnMode({
    sessionId: activeSessionId,
    messageCount,
    sendAttempted,
    hostBound,
    hasRuntimeIdentity: activeSession?.runtimeIdentity != null,
    hasHistoryError,
    status: activeSession?.status ?? 'idle',
  });
  const renderedMode = hasWorkingDirectory ? mode : 'empty';

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

  useEffect(() => {
    // T-34: same latch discipline as sessionRuntimeFacts above (own cleanup,
    // no manual reset — see the Opus m9 note there). Owned here, not by any
    // ToolRow-level mount: a `subagent.activity` that lands before the panel
    // ever renders must still reach the store.
    return useSubagentActivityStore.getState().init();
  }, []);

  useEffect(() => {
    // T11: same latch discipline as the two above. Owned at app level and not
    // by the dialog component, which by definition is not mounted until a
    // request has already arrived — a listener installed there could never see
    // the event that would have created its own dialog.
    return useExtensionUiStore.getState().init();
  }, []);

  useEffect(() => {
    // T10: fire-and-forget status/widget/unsupported events need the same
    // app-lifetime listener ownership. A leaf chip cannot install this listener:
    // the event that creates the first chip would already have passed.
    return useExtensionUiDisplayStore.getState().init();
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
    const sessionIds = sessions.map((session) => session.id);
    markSessionsLive(sessionIds);
    pruneSessionScopedRendererState(sessionIds);
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
      {renderedMode === 'session' && (
        <MessageTimeline
          sessionId={activeSessionId}
          status={activeSession?.status ?? 'idle'}
          thinkingEnabled={thinkingEnabled}
          repoName={repoName}
          jumpToBottomRequest={sendJumpRequest}
        />
      )}
      <ExtensionUiStatusChips sessionId={activeSessionId} />
      <ExtensionUiUnsupportedNotice sessionId={activeSessionId} />
      <ExtensionUiInlineDock sessionId={activeSessionId} />
      <ExtensionUiWidgets sessionId={activeSessionId} placement="aboveEditor" />
      <div className={middleColumnHostClass(renderedMode)}>
        {hasWorkingDirectory ? (
          <ChatComposer
            mode={renderedMode}
            disabled={!activeSessionId}
            onAddRepository={onAddRepository}
            onSendStart={markSendAttempt}
          />
        ) : (
          // T12-e′: the empty repository surface owns the welcome card. It
          // cannot live inside ChatComposer because this state deliberately
          // does not mount an input or send button at all.
          <ReadingColumn>
            <ChatWelcomeCard onAddRepository={onAddRepository} />
          </ReadingColumn>
        )}
      </div>
      <ExtensionUiWidgets sessionId={activeSessionId} placement="belowEditor" />
      <ExtensionUiNotificationEffects />
      {/* A truly session-less bind request has no conversation surface yet.
       * Only that exceptional shape may use the global fallback; every normal
       * request is rendered by ExtensionUiInlineDock in its owning session. */}
      <ExtensionUiDialog />
    </section>
  );
}
