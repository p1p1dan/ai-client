import { ArrowLeftRight, Monitor, Plus, Terminal } from 'lucide-react';
import type { PresentationSwitch } from '@/components/chat/usePresentationSwitch';
import { Button } from '@/components/ui/button';
import { Ident } from '@/components/ui/ident';
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import {
  createChatSessionOnWorkspace,
  createUnboundChatSession,
} from '@/stores/chatSessionActions';
import { useChatSessionsStore } from '@/stores/chatSessions';

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

  // "New chat" targets the folder the current chat lives in. With no folder
  // behind the current chat it starts a temporary one instead of doing nothing —
  // same rule U22 gave the sidebar's New button.
  const newSessionWorkspaceId = activeWorkspace?.path?.trim() ? activeWorkspace.id : null;
  const startNewChat = () => {
    if (newSessionWorkspaceId) {
      createChatSessionOnWorkspace(newSessionWorkspaceId);
      return;
    }
    createUnboundChatSession();
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
    </div>
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
