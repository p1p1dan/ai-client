import { Monitor, Play, Terminal } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { addToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { useExtensionUiStore } from '@/stores/extensionUi';
import { useExtensionUiDisplayStore } from '@/stores/extensionUiDisplay';
import { pruneSessionScopedRendererState } from '@/stores/sessionLifecycle';
import { markSessionsLive } from '@/stores/sessionRetirement';
import { useSessionRuntimeFactsStore } from '@/stores/sessionRuntimeFacts';
import { useSettingsStore } from '@/stores/settings';
import { useSubagentActivityStore } from '@/stores/subagentActivity';
import { AgentTerminal } from './AgentTerminal';
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
  const activeWorkspacePath = activeWorkspace?.path?.trim() ?? '';
  const repoName = deriveRepoName(activeWorkspacePath);
  // Q17/D19: the TUI takes over this chat's own JSONL once a runtime is bound.
  // An unbound chat has no conversation to hand over, so it starts fresh.
  const tuiHeaderLabel = activeSession?.runtimeIdentity
    ? 'Pi TUI continues this chat'
    : 'Pi TUI starts a new session';
  const hasWorkingDirectory = workspaces.some((workspace) => workspace.path.trim().length > 0);
  const presentationMode = useSettingsStore((state) => state.presentationMode);
  const setPresentationMode = useSettingsStore((state) => state.setPresentationMode);
  const [tuiTerminalId, setTuiTerminalId] = useState<string | null>(null);
  const previousWorkspacePathRef = useRef(activeWorkspacePath);

  const openTui = useCallback(() => {
    if (!activeWorkspacePath) return;
    setPresentationMode('tui');
    setTuiTerminalId((current) => current ?? `pi-tui-${crypto.randomUUID()}`);
  }, [activeWorkspacePath, setPresentationMode]);

  const openGui = useCallback(() => {
    if (tuiTerminalId) void window.electronAPI.piTui.dispose(tuiTerminalId).catch(() => {});
    setTuiTerminalId(null);
    setPresentationMode('gui');
  }, [setPresentationMode, tuiTerminalId]);

  useEffect(() => {
    if (!tuiTerminalId) return;
    return () => {
      void window.electronAPI.piTui.dispose(tuiTerminalId).catch(() => {});
    };
  }, [tuiTerminalId]);

  useEffect(() => {
    if (previousWorkspacePathRef.current === activeWorkspacePath) return;
    previousWorkspacePathRef.current = activeWorkspacePath;
    setTuiTerminalId((current) => {
      if (current) void window.electronAPI.piTui.dispose(current).catch(() => {});
      return null;
    });
  }, [activeWorkspacePath]);

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
      {activeWorkspacePath && (
        <div className="flex h-9 shrink-0 items-center justify-between border-b px-3">
          <span className="truncate text-meta text-muted-foreground">
            {presentationMode === 'tui' ? tuiHeaderLabel : repoName}
          </span>
          <div className="flex h-7 items-center rounded border bg-muted p-0.5" role="group">
            <button
              type="button"
              className={cn(
                'flex h-6 items-center gap-1 px-2 text-meta',
                presentationMode === 'gui' && 'bg-background text-foreground shadow-sm'
              )}
              onClick={openGui}
              aria-pressed={presentationMode === 'gui'}
            >
              <Monitor className="size-3.5" />
              GUI
            </button>
            <button
              type="button"
              className={cn(
                'flex h-6 items-center gap-1 px-2 text-meta',
                presentationMode === 'tui' && 'bg-background text-foreground shadow-sm'
              )}
              onClick={openTui}
              aria-pressed={presentationMode === 'tui'}
            >
              <Terminal className="size-3.5" />
              TUI
            </button>
          </div>
        </div>
      )}

      {presentationMode === 'tui' && activeWorkspacePath ? (
        tuiTerminalId ? (
          <div className="min-h-0 flex-1">
            <AgentTerminal
              id={tuiTerminalId}
              cwd={activeWorkspacePath}
              // Q17: continue this chat's own JSONL rather than opening a new
              // session. Absent until the first send has bound a runtime, and
              // an unbound chat has no conversation to continue anyway.
              {...(activeSession?.runtimeIdentity
                ? { sessionFile: activeSession.runtimeIdentity }
                : {})}
              isActive
              onExit={() => {
                setTuiTerminalId(null);
                setPresentationMode('gui');
                addToast({
                  type: 'warning',
                  title: 'Pi TUI closed',
                  description: 'Returned to the GUI session.',
                });
              }}
            />
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 items-center justify-center">
            <Button size="sm" onClick={openTui}>
              <Play className="size-4" />
              Start Pi TUI
            </Button>
          </div>
        )
      ) : (
        <>
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
          <ExtensionUiUnsupportedNotice sessionId={activeSessionId} onOpenTui={openTui} />
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
              <ReadingColumn>
                <ChatWelcomeCard onAddRepository={onAddRepository} />
              </ReadingColumn>
            )}
          </div>
          <ExtensionUiWidgets sessionId={activeSessionId} placement="belowEditor" />
        </>
      )}
      <ExtensionUiNotificationEffects />
      <ExtensionUiDialog />
    </section>
  );
}
