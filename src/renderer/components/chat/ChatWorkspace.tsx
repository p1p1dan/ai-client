import type React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { useMessageMetadataStore } from '@/stores/messageMetadataRegistry';
import { pruneSessionScopedRendererState } from '@/stores/sessionLifecycle';
import { useSessionPanelsStore } from '@/stores/sessionPanels';
import { markSessionsLive } from '@/stores/sessionRetirement';
import { useSessionRuntimeFactsStore } from '@/stores/sessionRuntimeFacts';
import { useSettingsStore } from '@/stores/settings';
import { useSubagentActivityStore } from '@/stores/subagentActivity';
import { useToolLiveOutputStore } from '@/stores/toolLiveOutput';
import { useTurnTimingStore } from '@/stores/turnTimingRegistry';
import { ChatComposer } from './ChatComposer';
import { ChatWelcomeCard } from './ChatWelcomeCard';
import { HostStatusBanner } from './HostStatusBanner';
import { selectHistoryError } from './historyError';
import { MessageTimeline } from './MessageTimeline';
import {
  deriveMiddleColumnMode,
  middleColumnHostClass,
  rememberSendAttempt,
  START_SCREEN_HOST_CLASS,
} from './middleColumnLayout';
import { PendingPermissionDock } from './PendingPermissionDock';
import { PendingQuestionDock } from './PendingQuestionDock';
import type { RunSendOrigin } from './queueRelease';
import { SessionPanelStrips } from './SessionPanelStrips';
import { SubwindowRegion } from './SessionSubwindows';
import { isThinkingCapable } from './thinkingCard';
import { deriveRepoName } from './toolCard';
import { useHostStatus } from './useHostStatus';
import { useResolvedSessionModel } from './useResolvedSessionModel';

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

  // ---------------------------------------------------------------------
  // T104: the chat area's two configurable tiers, applied as inline custom
  // properties on this column's ROOT <section>.
  //
  // Scope is the whole point. `--text-chat-body` / `--text-chat-process` are
  // consumed by `var()` inside the chat utilities (`text-chat-body`,
  // `text-chat-process`), so re-declaring them HERE — on the ancestor of the
  // timeline, the composer and the question cards — reaches every consumer and
  // nothing outside this subtree. Writing them to `documentElement` would
  // re-create the bug T-21 deleted: `applyTerminalFont()` wrote the terminal
  // font into the root custom properties, which polluted 41 `font-mono` call
  // sites and scaled the ENTIRE interface by `terminalFontSize / 16`
  // (design-system.md "分离契约"). That red line stands.
  //
  // The family is a direct `fontFamily` declaration rather than an override of
  // `--font-sans`, for the reason `globals.css` writes
  // `html[data-font-domain="mono"]` the same way: a theme custom property can
  // be inlined at build time, and then the runtime override silently does
  // nothing. A direct declaration only inherits into descendants that do not
  // set their own family — chat's `font-mono` code blocks and tool output are
  // untouched, since a utility's family beats inheritance.
  //
  // Empty string means "follow the app", so the key is OMITTED rather than set
  // to a fallback literal: the store's historical `fontFamily` (dead since
  // T-21) carries `'Inter'`, and copying that shape is what would make the chat
  // area disagree with the rest of the UI for everyone who never opens the
  // setting.
  // ---------------------------------------------------------------------
  const chatFontFamily = useSettingsStore((state) => state.chatFontFamily);
  const chatBodyFontSize = useSettingsStore((state) => state.chatBodyFontSize);
  const chatProcessFontSize = useSettingsStore((state) => state.chatProcessFontSize);
  const chatSurfaceStyle = useMemo(
    () =>
      ({
        '--text-chat-body': `${chatBodyFontSize}px`,
        '--text-chat-process': `${chatProcessFontSize}px`,
        ...(chatFontFamily ? { fontFamily: chatFontFamily } : {}),
      }) as React.CSSProperties,
    [chatBodyFontSize, chatProcessFontSize, chatFontFamily]
  );

  // T-05: repo name tail for Grep/Glob rows ("… in ai-client").
  const activeWorkspace = workspaces.find((ws) => ws.id === activeSession?.workspaceId);
  const activeWorkspacePath = activeWorkspace?.path?.trim() ?? '';
  const repoName = deriveRepoName(activeWorkspacePath);
  // D07: the temporary-chat marker and its `scratchCwd` moved to the shell's
  // session bar with the rest of this column's old bar. They are derived there
  // from the same stores, not threaded through — this column no longer has a
  // header to put them in.

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
  // U05-b: the old `hasWorkingDirectory ? mode : 'empty'` override is gone. It
  // existed to keep the welcome card on screen when the app had no folders at
  // all, by forcing the middle column into its empty state; now an unbound
  // chat can carry a real conversation with no folder anywhere, and pinning it
  // to 'empty' would undock the composer under its own messages.
  const renderedMode = mode;

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
    // dsh-rebase P1-7a: the goal bar's and the todo card's store, same latch
    // discipline — a `session.projection` that lands before either strip
    // renders must still reach it.
    return useSessionPanelsStore.getState().init();
  }, []);

  useEffect(() => {
    // dsh-rebase P1-7b: a running command's live output, same latch
    // discipline — its first `tool.output` may land before its row is open.
    return useToolLiveOutputStore.getState().init();
  }, []);

  // dsh-rebase P1-7e (problem 16): the turn clock's live stamps, held for the
  // whole run. The timeline unmounts whenever this column shows the start
  // screen, and a turn can end while another chat is on screen; neither may
  // cost a turn its 「已工作 N 秒」 / 「完成于」.
  const resolveSessionModel = useResolvedSessionModel();
  useEffect(
    () => useMessageMetadataStore.getState().retain(resolveSessionModel),
    [resolveSessionModel]
  );
  // P1-7e (decision 140): the same for the thought and tool stamps behind
  // 「思考 N 秒」 and a running row's clock.
  useEffect(() => useTurnTimingStore.getState().retain(), []);

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
    <section className={cn('relative flex min-h-0 flex-col', className)} style={chatSurfaceStyle}>
      {/*
        D07: this column no longer draws a header bar of its own. It used to be
        a second h-9 strip under `MainHeader` — three stacked bars over the 32px
        title bar is what read as clutter. Everything it held moved up into the
        one bar the shell renders above this column. (dsh-rebase P1-11,
        decision 127: the pi TUI this column could switch to is gone.)
      */}
      <HostStatusBanner status={hostStatus} onRetry={() => void retry()} />
      {/* dsh-rebase P1-7b (decision 109): the background jobs and
          subagents windows float over the room above the composer and
          nowhere else — `SubwindowRegion` lays their layer over it. */}
      {renderedMode === 'session' && (
        <SubwindowRegion sessionId={activeSessionId}>
          <MessageTimeline
            sessionId={activeSessionId}
            status={activeSession?.status ?? 'idle'}
            thinkingEnabled={thinkingEnabled}
            repoName={repoName}
            jumpToBottomRequest={sendJumpRequest}
          />
        </SubwindowRegion>
      )}
      {/* dsh-rebase P1-7a (decisions 068 / 109): the todo card and the
          goal bar, above the answerable cards, which stay nearest the
          composer. Session mode only: an empty chat has neither. */}
      {renderedMode === 'session' && <SessionPanelStrips sessionId={activeSessionId} />}
      {/* F5: the only answerable copy of a live question. Above the
          composer rather than in the timeline so it cannot scroll away
          while the session waits on it. */}
      <PendingQuestionDock sessionId={activeSessionId} />
      {/* 2026-09-18: the same arrangement for permissions, and the only
          answerable copy of one. Questions and permissions are two separate
          gates that can be open at the same time, so neither dock hides the
          other — stacked, they are still both above the composer. */}
      <PendingPermissionDock sessionId={activeSessionId} />
      {/* U05-b ②: the start screen does not REPLACE the composer, it sits
          above it — a user who wants to bind a folder still has the
          composer's own target bar, and a user who just wants to talk can
          type. Still gated on the empty column, so it cannot hang over a
          chat that already has messages.

          U28 drops the `!hasWorkingDirectory` term (user, 2026-09-06): a
          bound chat that has not started yet is the same moment as an
          unbound one. Only the sentence differs, and it differs by naming
          the folder — which is why the workspace name is passed in. */}
      {renderedMode === 'empty' && (
        <SubwindowRegion sessionId={activeSessionId}>
          <div className={START_SCREEN_HOST_CLASS}>
            <ChatWelcomeCard
              {...(activeWorkspacePath && repoName ? { workspaceName: repoName } : {})}
            />
          </div>
        </SubwindowRegion>
      )}
      <div className={middleColumnHostClass(renderedMode)}>
        <ChatComposer
          mode={renderedMode}
          onAddRepository={onAddRepository}
          onSendStart={markSendAttempt}
        />
      </div>
    </section>
  );
}
