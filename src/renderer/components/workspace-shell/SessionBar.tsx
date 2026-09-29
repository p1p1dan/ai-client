import { ArrowLeftRight, GitBranch, Layers, Monitor, Plus, Terminal, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { SessionTreeDialog } from '@/components/chat/SessionTreeDialog';
import { deriveJobsWindowView, deriveSubagentsWindowView } from '@/components/chat/subwindowsModel';
import type { PresentationSwitch } from '@/components/chat/usePresentationSwitch';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Ident } from '@/components/ui/ident';
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import {
  createOrReuseChatSessionOnWorkspace,
  createOrReuseUnboundChatSession,
} from '@/stores/chatSessionActions';
import { statusForNextTurn, useChatSessionsStore } from '@/stores/chatSessions';
import { useSessionPanelsStore } from '@/stores/sessionPanels';
import { type SubwindowKey, useSessionSubwindowsStore } from '@/stores/sessionSubwindows';
import { useSubagentActivityStore } from '@/stores/subagentActivity';

interface SessionBarProps {
  /**
   * D07's arrangement survives D12: the shell owns the one
   * `usePresentationSwitch` instance and hands it to both the control (here) and
   * the terminal (`ChatWorkspace`). Creating it in both would give one terminal
   * two ids.
   */
  presentation: PresentationSwitch;
  reviewOpen?: boolean;
  reviewCount?: number;
  onToggleReview?: () => void;
}

/**
 * D12 (U24): the center column's one bar, showing THE conversation on screen.
 *
 * Replaces `SessionTabs`, D08's one-tab-per-started-session strip. The user's
 * verdict on the strip after living with it was 「用起来确实很别扭」, and the
 * thing it was reaching for — several conversations working at once — turned out
 * not to need tabs at all: `WorkerManager` keeps a session's worker alive while
 * it has a turn running no matter which one is on screen (`isSafeToEvict`), and
 * always did. The strip was drawing a fact the sidebar could state more cheaply.
 *
 * So the bar is back to what `MainHeader` carried before D08 — title, folder
 * context, GUI/TUI — minus the controls D08 deleted for good (the panel toggle
 * and the two/three-column switch went with `shellColumnMode`).
 *
 * The close ✕ does NOT come back here. "End this conversation" now lives in the
 * sidebar row's context menu, next to Rename and Archive, so the repo's three
 * closes sit together and can be told apart in one place.
 */
export function SessionBar({
  presentation,
  reviewOpen,
  reviewCount = 0,
  onToggleReview,
}: SessionBarProps) {
  const { t } = useI18n();

  const sessions = useChatSessionsStore((state) => state.sessions);
  const projects = useChatSessionsStore((state) => state.projects);
  const workspaces = useChatSessionsStore((state) => state.workspaces);
  const activeSessionId = useChatSessionsStore((state) => state.activeSessionId);

  const activeSession = sessions.find((session) => session.id === activeSessionId);
  const activeWorkspace = workspaces.find((ws) => ws.id === activeSession?.workspaceId);
  // Resolved through the workspace, not `session.projectId` — a stale
  // `projectId` must not label the bar with the wrong folder (the same trap
  // `buildSidebarFolders` documents).
  const activeProject = projects.find((project) => project.id === activeWorkspace?.projectId);

  const { presentationMode, openGui, openTui } = presentation;
  const isTui = presentationMode === 'tui';
  // Welcome state: no chat to render either way, so no switch.
  const presentationSwitchAvailable = Boolean(
    activeWorkspace?.path?.trim() || activeSession?.unbound
  );

  const contextLine = [activeProject?.name, activeWorkspace?.name].filter(Boolean).join(' · ');
  const busy = activeSession?.status === 'running' || activeSession?.status === 'starting';

  // 2026-09-18 — the conversation's message tree (branches / rewind points),
  // moved here from `MessageTimeline`. It used to be the first child of the
  // scrolling message list: it looked like a bar control, it scrolled away as
  // soon as the reader moved, and its label was a hardcoded English "Branches"
  // that stayed English in the Chinese UI. Nothing about it was timeline
  // content, so it belongs on the bar with the other conversation-level
  // controls.
  //
  // Both of its gates travel verbatim, and are derived HERE rather than in two
  // places:
  //  - it exists only once the chat has a durable session on disk
  //    (`runtimeIdentity`), because there is no tree to read before that;
  //  - and it is disabled unless the session is IDLE — `busy` above is the
  //    narrower 「running / starting」 dot and is deliberately NOT reused:
  //    rewinding a session parked on a permission prompt is just as unsafe as
  //    rewinding one mid-stream.
  const [treeOpen, setTreeOpen] = useState(false);
  const hasDurableSession = activeSession?.runtimeIdentity != null;
  // D1 (2026-09-24): `status` now stays `'failed'` after a failed run closes,
  // and rewinding past the failed turn is exactly the recovery this dialog
  // offers — so "idle" is read through the store's next-turn view.
  const isIdle = (statusForNextTurn(activeSession) ?? 'idle') === 'idle';

  // "New chat" targets the folder the current chat lives in. With no folder
  // behind the current chat it starts a temporary one instead of doing nothing —
  // same rule U22 gave the sidebar's New button.
  //
  // create-or-reuse: since this target IS the active session's own workspace,
  // a fresh empty active session always resolves to "already there" (stay
  // put) here — never a retarget — see chatSessionActions.ts's
  // createOrReuseChatSessionOnWorkspace / createOrReuseUnboundChatSession.
  const newSessionWorkspaceId = activeWorkspace?.path?.trim() ? activeWorkspace.id : null;
  const startNewChat = () => {
    if (newSessionWorkspaceId) {
      createOrReuseChatSessionOnWorkspace(newSessionWorkspaceId);
      return;
    }
    createOrReuseUnboundChatSession();
  };

  const title = (
    <div className="flex min-w-0 items-center gap-1.5">
      {busy && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-status-running" />}
      <span className="min-w-0 truncate font-medium text-foreground text-meta">
        {activeSession?.title ?? t('No conversation open')}
      </span>
      {activeSession?.unbound && (
        <span className="shrink-0 rounded-xs border px-1 text-2xs text-muted-foreground">
          {t('Temporary')}
        </span>
      )}
      {contextLine && (
        <span className="min-w-0 truncate text-meta text-muted-foreground">{contextLine}</span>
      )}
    </div>
  );

  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b bg-card/40 px-2">
      {activeWorkspace?.path ? (
        <Tooltip>
          <TooltipTrigger delay={400} render={<div className="min-w-0 flex-1" />}>
            {title}
          </TooltipTrigger>
          <TooltipPopup side="bottom" sideOffset={8} className="max-w-96">
            {/* Ident, not raw font-mono: paths are mono via the D25 §2.5
                primitive so the fontDomainScan whitelist stays closed. */}
            <Ident>{activeWorkspace.path}</Ident>
          </TooltipPopup>
        </Tooltip>
      ) : (
        <div className="min-w-0 flex-1">{title}</div>
      )}

      {/* Left of 「审阅」: both controls inspect the conversation already on
          screen, while 「+ / GUI / TUI」 to their right create or re-present one.
          Same size tier as every other control on this bar (h-6, size-3.5). */}
      {hasDurableSession && activeSessionId && (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 shrink-0 gap-1 text-meta"
          disabled={!isIdle}
          onClick={() => setTreeOpen(true)}
          title={t('Session branches')}
        >
          <GitBranch className="size-3.5" />
          {t('Session branches')}
        </Button>
      )}
      {onToggleReview && activeSessionId && (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 shrink-0 gap-1 text-meta tabular-nums"
          onClick={onToggleReview}
          aria-pressed={reviewOpen}
          title={t('Session review')}
        >
          <ArrowLeftRight className="size-3.5" />
          {t('Session review')}
          {reviewCount > 0 && <span>{reviewCount}</span>}
        </Button>
      )}
      <button
        type="button"
        className="flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-hover hover:text-foreground"
        aria-label={t('New chat')}
        title={t('New chat')}
        onClick={startNewChat}
      >
        <Plus className="size-3.5" />
      </button>

      {presentationSwitchAvailable && (
        <div
          className="flex shrink-0 items-center gap-0.5 border-l pl-2"
          role="group"
          aria-label={t('Presentation mode')}
        >
          <PresentationButton
            label="GUI"
            icon={Monitor}
            active={presentationMode === 'gui'}
            onClick={openGui}
          />
          <PresentationButton label="TUI" icon={Terminal} active={isTui} onClick={openTui} />
        </div>
      )}
      {/* dsh-rebase P1-7b (decisions 090, 109): the background jobs and
          subagents windows, opened and hidden here, next to where the
          terminal button goes (P1-11). The count is what runs now. */}
      {activeSessionId && <BackgroundWorkButtons sessionId={activeSessionId} />}
      {/* Keyed by session: a dialog left open across a session switch must not
          show the previous conversation's tree. Mounted next to its trigger
          rather than in the timeline, so the two cannot drift apart. */}
      {activeSessionId && (
        <SessionTreeDialog
          key={activeSessionId}
          sessionId={activeSessionId}
          open={treeOpen}
          onOpenChange={setTreeOpen}
          isIdle={isIdle}
        />
      )}
    </div>
  );
}

const NO_HIDDEN_JOBS: readonly string[] = [];

/**
 * dsh-rebase P1-7b: 「后台任务 N」 and 「子代理 N」 (prototype `sessionbar`):
 * a toggle each, pressed while its window is open; the count, in the brand
 * colour as the prototype draws it, is what runs now and is absent at zero.
 * On a narrow window only the icons stay (the prototype's compact bar).
 */
function BackgroundWorkButtons({ sessionId }: { sessionId: string }) {
  const { t } = useI18n();
  const open = useSessionSubwindowsStore((state) => state.open);
  const toggle = useSessionSubwindowsStore((state) => state.toggle);
  const panels = useSessionPanelsStore((state) => state.bySession[sessionId]);
  const allLanes = useSubagentActivityStore((state) => state.lanes);
  const { jobs, agents } = useMemo(() => {
    const lanes = Object.values(allLanes).filter((lane) => lane.sessionId === sessionId);
    return {
      jobs: deriveJobsWindowView({ panels, lanes, hidden: NO_HIDDEN_JOBS }).running,
      agents: deriveSubagentsWindowView({ panels, lanes }).running,
    };
  }, [allLanes, panels, sessionId]);
  return (
    <div
      className="flex shrink-0 items-center gap-0.5 border-l pl-2"
      role="group"
      aria-label={t('Background work')}
    >
      <SubwindowButton
        windowKey="jobs"
        label={t('Background tasks')}
        icon={Layers}
        count={jobs}
        active={open.jobs}
        onClick={() => toggle('jobs')}
      />
      <SubwindowButton
        windowKey="agents"
        label={t('Subagents')}
        icon={Users}
        count={agents}
        active={open.agents}
        onClick={() => toggle('agents')}
      />
    </div>
  );
}

function SubwindowButton({
  windowKey,
  label,
  icon: Icon,
  count,
  active,
  onClick,
}: {
  windowKey: SubwindowKey;
  label: string;
  icon: typeof Layers;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        'flex h-6 items-center gap-1 rounded-sm px-2 text-meta transition-colors',
        active
          ? 'bg-selection text-foreground'
          : 'text-muted-foreground hover:bg-hover hover:text-foreground focus-visible:bg-hover'
      )}
      onClick={onClick}
      aria-pressed={active}
      title={label}
      data-subwindow={windowKey}
    >
      <Icon className="size-3.5" />
      <span className="max-xl:hidden">{label}</span>
      {count > 0 && (
        <Badge size="sm" className="rounded-full tabular-nums">
          {count}
        </Badge>
      )}
    </button>
  );
}

interface PresentationButtonProps {
  label: string;
  icon: typeof Monitor;
  active: boolean;
  onClick: () => void;
}

/**
 * Text + icon rather than icon-only: "GUI" and "TUI" are three letters wide and
 * the two icons (monitor / terminal) are not distinguishable at 14px for anyone
 * who has not already learned which is which. Carried over from `MainHeader`
 * through `SessionTabs` to here unchanged.
 */
function PresentationButton({ label, icon: Icon, active, onClick }: PresentationButtonProps) {
  return (
    <button
      type="button"
      className={cn(
        'flex h-6 items-center gap-1 rounded-sm px-2 text-meta transition-colors',
        active
          ? 'bg-selection text-foreground'
          : 'text-muted-foreground hover:bg-hover hover:text-foreground'
      )}
      onClick={onClick}
      aria-pressed={active}
    >
      <Icon className="size-3.5" />
      {label}
    </button>
  );
}
