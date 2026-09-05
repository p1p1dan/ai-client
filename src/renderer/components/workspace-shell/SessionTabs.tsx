import { Monitor, Plus, Terminal, X } from 'lucide-react';
import { useState } from 'react';
import type { PresentationSwitch } from '@/components/chat/usePresentationSwitch';
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Ident } from '@/components/ui/ident';
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { createChatSessionOnWorkspace } from '@/stores/chatSessionActions';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { useSessionTabsStore } from '@/stores/sessionTabs';
import { endSessionForTab } from './closeSessionTab';
import { deriveSessionTabs, resolveNextActiveSession, type SessionTab } from './sessionTabsModel';
import { useActivateSession } from './useActivateSession';

interface SessionTabsProps {
  /**
   * D07's arrangement survives D08: the shell owns the one
   * `usePresentationSwitch` instance and hands it to both the control (here) and
   * the terminal (`ChatWorkspace`). Creating it in both would give one terminal
   * two ids.
   */
  presentation: PresentationSwitch;
}

/**
 * D08 (U15-c): the center column's only bar — one tab per STARTED session.
 *
 * Replaces `MainHeader`, which carried `title · folder chip · [panel][columns][GUI|TUI]`.
 * Three of those four are gone by decision, not by omission:
 *
 *   - the title is now each tab's own label (that is what a tab is),
 *   - the folder chip is duplicated by the Composer's target bar right below it,
 *     so it moved into the tab's tooltip instead of taking permanent width,
 *   - the panel toggle and the two/three-column switch are deleted with
 *     `shellColumnMode` (D08 decision four).
 *
 * GUI/TUI stays, at the right end, because it is the only per-conversation
 * control here that has no other home.
 */
export function SessionTabs({ presentation }: SessionTabsProps) {
  const { t, tNode } = useI18n();

  const sessions = useChatSessionsStore((state) => state.sessions);
  const projects = useChatSessionsStore((state) => state.projects);
  const workspaces = useChatSessionsStore((state) => state.workspaces);
  const activeSessionId = useChatSessionsStore((state) => state.activeSessionId);
  const selectSession = useChatSessionsStore((state) => state.selectSession);

  const openSessionIds = useSessionTabsStore((state) => state.openSessionIds);
  const closeTab = useSessionTabsStore((state) => state.closeSession);
  const activateSession = useActivateSession();

  const tabs = deriveSessionTabs(
    openSessionIds,
    sessions.map((session) => ({
      id: session.id,
      title: session.title,
      // `starting`/`running` are the two states worth a dot; the rest are
      // steady states the strip should not animate over.
      busy: session.status === 'running' || session.status === 'starting',
      unbound: Boolean(session.unbound),
    })),
    activeSessionId
  );

  const activeSession = sessions.find((session) => session.id === activeSessionId);
  const activeWorkspace = workspaces.find((ws) => ws.id === activeSession?.workspaceId);
  // Resolved through the workspace, not `session.projectId` — a stale
  // `projectId` must not label the tab with the wrong folder (the same trap
  // `buildSidebarFolders` documents).
  const activeProject = projects.find((project) => project.id === activeWorkspace?.projectId);

  const { presentationMode, openGui, openTui } = presentation;
  const isTui = presentationMode === 'tui';
  // Welcome state: no chat to render either way, so no switch.
  const presentationSwitchAvailable = Boolean(
    activeWorkspace?.path?.trim() || activeSession?.unbound
  );

  // "New chat" targets the folder the current chat lives in. With no active
  // chat there is no target, and the dock's own New button (which resolves a
  // target from the folder tree) is the entry point instead.
  const newSessionWorkspaceId = activeWorkspace?.path?.trim() ? activeWorkspace.id : null;

  // Closing ends the conversation, so it asks first. The dialog holds the tab
  // it is about to close; `null` means no dialog is up.
  const [pendingClose, setPendingClose] = useState<SessionTab | null>(null);

  const confirmClose = (sessionId: string) => {
    // Order matters: pick the successor from the list that still contains the
    // tab being closed, then close it. Closing first would make the neighbour
    // lookup miss the index it needs.
    const nextActive = resolveNextActiveSession(openSessionIds, sessionId, activeSessionId);
    closeTab(sessionId);
    if (nextActive !== activeSessionId) {
      // `selectSession`, not `activateSession`: the successor tab is already
      // started, so re-running the resume decision would be a no-op at best.
      selectSession(nextActive);
    }
    // Fire-and-forget: the tab is already gone from the strip, and a detach
    // that fails leaves nothing the user can act on here. `endSessionForTab`
    // resets the local state either way.
    void endSessionForTab(sessionId);
  };

  return (
    <>
      <div className="flex h-9 shrink-0 items-stretch border-b bg-card/40">
        <div
          role="tablist"
          aria-label={t('Open sessions')}
          className="flex min-w-0 flex-1 items-stretch overflow-x-auto"
        >
          {tabs.map((tab) => (
            <SessionTabButton
              key={tab.id}
              tab={tab}
              contextLine={
                tab.active
                  ? [activeProject?.name, activeWorkspace?.name].filter(Boolean).join(' · ')
                  : undefined
              }
              workspacePath={tab.active ? activeWorkspace?.path : undefined}
              onSelect={() => activateSession(tab.id)}
              onClose={() => setPendingClose(tab)}
            />
          ))}
          {newSessionWorkspaceId && (
            <button
              type="button"
              className="flex w-8 shrink-0 items-center justify-center text-muted-foreground hover:bg-hover hover:text-foreground"
              aria-label={t('New chat')}
              title={t('New chat')}
              onClick={() => createChatSessionOnWorkspace(newSessionWorkspaceId)}
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {presentationSwitchAvailable && (
          <div
            className="flex shrink-0 items-center gap-0.5 border-l px-2"
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

      <AlertDialog
        open={pendingClose !== null}
        onOpenChange={(open) => {
          if (!open) setPendingClose(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('End this conversation?')}</AlertDialogTitle>
            <AlertDialogDescription>
              {tNode('Closing {{title}} stops its agent and releases it from the background.', {
                title: <strong>{pendingClose?.title}</strong>,
              })}
              {pendingClose?.busy && (
                <span className="mt-2 block text-destructive">
                  {t('This conversation is still running; its current turn will be cut off.')}
                </span>
              )}
              <span className="mt-2 block text-muted-foreground">
                {t('It stays in the chat list and reopening it will load its history again.')}
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline">{t('Cancel')}</Button>} />
            <Button
              variant="destructive"
              onClick={() => {
                if (pendingClose) confirmClose(pendingClose.id);
                setPendingClose(null);
              }}
            >
              {t('End conversation')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

interface SessionTabButtonProps {
  tab: SessionTab;
  /** Only supplied for the active tab — the others have no resolved workspace here. */
  contextLine?: string;
  workspacePath?: string;
  onSelect: () => void;
  onClose: () => void;
}

function SessionTabButton({
  tab,
  contextLine,
  workspacePath,
  onSelect,
  onClose,
}: SessionTabButtonProps) {
  const { t } = useI18n();

  const button = (
    <div
      role="tab"
      tabIndex={0}
      aria-selected={tab.active}
      title={tab.title}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        'group relative flex max-w-52 min-w-0 shrink-0 cursor-default items-center gap-1.5',
        'border-r pr-1.5 pl-2.5 text-meta',
        tab.active
          ? 'bg-background font-medium text-foreground'
          : 'text-muted-foreground hover:bg-hover hover:text-foreground'
      )}
    >
      {/* The active marker is a top rule, not a background swap: the tab already
          carries `bg-background`, and on a card-tinted strip that alone is too
          quiet to find at a glance. */}
      {tab.active && (
        <span aria-hidden className="absolute inset-x-0 top-0 h-0.5 rounded-b-xs bg-primary" />
      )}
      {tab.busy && (
        <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-status-running" />
      )}
      <span className="min-w-0 flex-1 truncate">{tab.title}</span>
      {tab.unbound && (
        <span className="shrink-0 rounded-xs border px-1 text-2xs text-muted-foreground">
          {t('Temporary')}
        </span>
      )}
      {/* Always rendered, revealed on hover/focus/active. `invisible`, not a
          conditional mount: a close button that appears on hover changes the
          tab's width, so every neighbour shifts under the pointer. */}
      <button
        type="button"
        aria-label={t('Close tab')}
        title={t('Close tab')}
        className={cn(
          'flex h-4 w-4 shrink-0 items-center justify-center rounded-xs',
          'hover:bg-accent hover:text-foreground',
          tab.active ? 'visible' : 'invisible group-hover:visible group-focus-within:visible'
        )}
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );

  // The tooltip only carries information for the tab whose workspace the strip
  // could resolve; a bare title tooltip is already on the `title` attribute.
  if (!contextLine && !workspacePath) {
    return button;
  }

  return (
    <Tooltip>
      <TooltipTrigger delay={400} render={button} />
      <TooltipPopup side="bottom" sideOffset={8} className="max-w-96">
        {contextLine && <p className="font-medium">{contextLine}</p>}
        {workspacePath && (
          <p className="text-muted-foreground">
            {/* Ident, not raw font-mono: paths are mono via the D25 §2.5
                primitive so the fontDomainScan whitelist stays closed. */}
            <Ident>{workspacePath}</Ident>
          </p>
        )}
      </TooltipPopup>
    </Tooltip>
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
 * who has not already learned which is which. Carried over from `MainHeader`.
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
