import {
  Activity,
  ChevronDown,
  Diff,
  Folder,
  FolderOpen,
  Gauge,
  GitBranch,
  Layers,
  MoreVertical,
  PanelLeftOpen,
  Plus,
  SquareTerminal,
} from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { requestComposerFocus } from '@/components/chat/composerFocus';
import { SessionTreeDialog } from '@/components/chat/SessionTreeDialog';
import { displaySessionTitle } from '@/components/chat/sessionIndex/sessionTitle';
import { deriveJobsWindowView, deriveSubagentsWindowView } from '@/components/chat/subwindowsModel';
import { Badge } from '@/components/ui/badge';
import { Ident } from '@/components/ui/ident';
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from '@/components/ui/menu';
import { StatusIcon } from '@/components/ui/status-icon';
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { statusForNextTurn, useChatSessionsStore } from '@/stores/chatSessions';
import { openHome } from '@/stores/homeDraft';
import { useSessionPanelsStore } from '@/stores/sessionPanels';
import { useSubagentActivityStore } from '@/stores/subagentActivity';
import type { PaneKind, TerminalButtonState } from './workPanelModel';

const NO_PANES: readonly PaneKind[] = [];

export interface SessionReviewTotals {
  count: number;
  added: number;
  removed: number;
}

interface SessionBarProps {
  /** Layout 5a: the sidebar collapses entirely; this bar then offers it back. */
  sidebarCollapsed?: boolean;
  onExpandSidebar?: () => void;
  /** Absent = the session review is off (setting) or no conversation is open. */
  review?: SessionReviewTotals;
  /** Layout 5d: the panes on screen, for the buttons' pressed state. */
  openPanes?: readonly PaneKind[];
  /** The bar's buttons toggle: a pane on screen closes. */
  onTogglePane?: (kind: PaneKind) => void;
  /** Menu entries open (never close) a pane. */
  onOpenPane?: (kind: PaneKind) => void;
  /** dsh-rebase P1-11: the terminal pane's toggle; absent = no button. */
  terminalState?: TerminalButtonState;
  onToggleTerminal?: () => void;
  /**
   * Layout 5e (ui-cohesion §6, ruling L5) seam: the session rail's toggle. It
   * sits leftmost in the right-hand group, set off from the panel buttons by a
   * divider. Nothing renders (divider included) until 5e passes one.
   */
  sessionRailToggle?: ReactNode;
}

/**
 * Layout 5a: the title bar's buttons — icon only, the name in a tooltip
 * (the reference's desktop shell). 28px, 16px icons; pressed = the shared
 * `fill-ghost-selected`.
 */
function barIconClass(pressed: boolean): string {
  return cn(
    'relative flex size-7 shrink-0 items-center justify-center rounded-sm transition-colors',
    pressed
      ? 'bg-fill-ghost-selected text-foreground'
      : 'text-muted-foreground hover:bg-fill-ghost-hover hover:text-foreground focus-visible:bg-fill-ghost-hover'
  );
}

function BarIconButton({
  label,
  pressed,
  onClick,
  children,
  data,
}: {
  label: string;
  pressed?: boolean;
  onClick: () => void;
  children: ReactNode;
  data?: Record<string, string>;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        delay={300}
        render={
          <button
            type="button"
            aria-label={label}
            aria-pressed={pressed}
            onClick={onClick}
            className={barIconClass(pressed === true)}
            {...data}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="bottom" sideOffset={6}>
        {label}
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * D12 (U24), reshaped by layout 5a (ui-cohesion §6; the target is the
 * reference desktop shell's Code tab): one slim row over the conversation,
 * the canvas colour, no hairline.
 *
 *   left  — the sidebar's expand button (only while it is collapsed), the
 *           conversation's title with a chevron for its menu (branches, new
 *           chat), the running glyph and the 「临时」 tag;
 *   right — [5e session rail toggle | divider] terminal · changes · files ·
 *           (background tasks while something runs or its pane is open) · ⋮.
 *
 * Layout 5d: every button toggles a pane card; pressed = that pane is open.
 * The ⋮ menu takes what has no button: the Git / Run / Context / background
 * tasks panes, and the repository / branch / folder the conversation runs in
 * — they move to the session rail's environment card in 5e. The background
 * tasks button opens the tasks pane; the floating sub-windows (chat/) are no
 * longer opened from here.
 *
 * Unchanged from D12: the close ✕ does NOT come back here. "End this
 * conversation" lives in the sidebar row's context menu.
 */
export function SessionBar({
  sidebarCollapsed = false,
  onExpandSidebar,
  review,
  openPanes = NO_PANES,
  onTogglePane,
  onOpenPane,
  terminalState,
  onToggleTerminal,
  sessionRailToggle,
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
  const busy = activeSession?.status === 'running' || activeSession?.status === 'starting';

  // 2026-09-18: the conversation's message tree (branches / rewind points).
  // Both gates travel verbatim:
  //  - it exists only once the chat has a durable session on disk
  //    (`runtimeIdentity`), because there is no tree to read before that;
  //  - it is disabled unless the session is IDLE — `busy` above is the
  //    narrower 「running / starting」 dot and is deliberately NOT reused:
  //    rewinding a session parked on a permission prompt is just as unsafe as
  //    rewinding one mid-stream.
  const [treeOpen, setTreeOpen] = useState(false);
  const hasDurableSession = activeSession?.runtimeIdentity != null;
  // D1 (2026-09-24): `status` stays `'failed'` after a failed run closes, and
  // rewinding past the failed turn is exactly the recovery this dialog offers.
  const isIdle = (statusForNextTurn(activeSession) ?? 'idle') === 'idle';

  // Decision 174 (issue #6, second wave): "New chat" opens the home page with
  // the folder the current chat lives in picked; for a temporary chat the home
  // page keeps its own pick. On the home page itself the keyboard goes to the
  // composer, which is where a new chat starts.
  const startNewChat = () => {
    if (!activeSession) {
      requestComposerFocus(null);
      return;
    }
    const path = activeWorkspace?.path?.trim() ? activeWorkspace.path : null;
    openHome(path ? { kind: 'path', path } : undefined);
  };

  const titleText = activeSession ? displaySessionTitle(activeSession.title, t) : t('Home');
  // Decision 174: no conversation open is the home page, and the bar says so.
  // Layout 5a: 13px (`text-ui`, the reference's title size), still 400 — the
  // bar carries no 500 (decision 167; YaHei renders 500 as 400 anyway).
  const titleClass = 'min-w-0 truncate text-ui text-foreground';
  const reviewLabel = review
    ? review.count > 0
      ? `${t('Session changes')} +${review.added} −${review.removed}`
      : t('Session changes')
    : '';

  return (
    // `overflow-hidden`: the bar ends at the center row's edge whatever its
    // content does; the title truncates first.
    <div
      className="flex h-9 shrink-0 items-center gap-1 overflow-hidden bg-surface-1 px-2"
      data-session-bar=""
    >
      {sidebarCollapsed && onExpandSidebar && (
        <BarIconButton label={`${t('Expand sidebar')} (Ctrl+B)`} onClick={onExpandSidebar}>
          <PanelLeftOpen className="size-4" />
        </BarIconButton>
      )}

      <div className="flex min-w-0 flex-1 items-center gap-1.5 pl-1">
        {/* Design system v2 §6: the one running glyph, neutral ink. */}
        {busy && <StatusIcon status="running" />}
        {activeSession ? (
          <Menu>
            <MenuTrigger
              className="flex h-7 min-w-0 items-center gap-1 rounded-sm px-1.5 hover:bg-fill-ghost-hover"
              aria-label={t('Conversation menu')}
            >
              <span className={titleClass}>{titleText}</span>
              <ChevronDown aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            </MenuTrigger>
            <MenuPopup align="start">
              {/* Absent, not disabled, before a durable session: no entry
                  point that leads nowhere. */}
              {hasDurableSession && (
                <MenuItem
                  disabled={!isIdle}
                  onClick={() => setTreeOpen(true)}
                  data-session-branches=""
                >
                  <GitBranch />
                  {t('Session branches')}
                </MenuItem>
              )}
              <MenuItem onClick={startNewChat}>
                <Plus />
                {t('New chat')}
              </MenuItem>
            </MenuPopup>
          </Menu>
        ) : (
          <span className={cn(titleClass, 'px-1.5')}>{titleText}</span>
        )}
        {/* P1-7e e6 (decision 145): 「临时」 is CJK, so `text-small`. Design
            system v2 §1: a tag on a bar is a filled chip, not a second frame. */}
        {activeSession?.unbound && (
          <span className="shrink-0 rounded-xs bg-fill-neutral px-1 text-small text-muted-foreground">
            {t('Temporary')}
          </span>
        )}
      </div>

      {sessionRailToggle && (
        <>
          {sessionRailToggle}
          <span aria-hidden className="mx-1 h-4.5 w-px shrink-0 bg-border-soft" />
        </>
      )}
      {activeSessionId && terminalState && onToggleTerminal && (
        <TerminalButton state={terminalState} onToggle={onToggleTerminal} />
      )}
      {review && onTogglePane && (
        <BarIconButton
          label={reviewLabel}
          pressed={openPanes.includes('changes')}
          onClick={() => onTogglePane('changes')}
          data={{ 'data-panel-toggle': 'changes' }}
        >
          <Diff className="size-4" />
          {review.count > 0 && (
            <span
              aria-hidden
              className="absolute top-1 right-1 size-1.5 rounded-full bg-muted-foreground"
            />
          )}
        </BarIconButton>
      )}
      {onTogglePane && (
        <BarIconButton
          label={t('Files')}
          pressed={openPanes.includes('files')}
          onClick={() => onTogglePane('files')}
          data={{ 'data-panel-toggle': 'files' }}
        >
          <FolderOpen className="size-4" />
        </BarIconButton>
      )}
      {activeSessionId && onTogglePane && (
        <BackgroundTasksButton
          sessionId={activeSessionId}
          open={openPanes.includes('tasks')}
          onToggle={() => onTogglePane('tasks')}
        />
      )}

      <Menu>
        <MenuTrigger className={barIconClass(false)} aria-label={t('More actions')}>
          <MoreVertical className="size-4" />
        </MenuTrigger>
        <MenuPopup align="end" className="min-w-56">
          {onOpenPane && (
            <MenuGroup>
              <MenuItem onClick={() => onOpenPane('git')}>
                <GitBranch />
                {t('Git')}
              </MenuItem>
              <MenuItem onClick={() => onOpenPane('run')}>
                <Activity />
                {t('Run')}
              </MenuItem>
              <MenuItem onClick={() => onOpenPane('context')}>
                <Gauge />
                {t('Context')}
              </MenuItem>
              {activeSessionId && (
                <MenuItem onClick={() => onOpenPane('tasks')} data-pane-item="tasks">
                  <Layers />
                  {t('Background tasks')}
                </MenuItem>
              )}
            </MenuGroup>
          )}
          {activeWorkspace && (
            <>
              <MenuSeparator />
              {/* Moves to the session rail's environment card in 5e. */}
              <MenuGroup>
                <MenuGroupLabel>{t('Environment')}</MenuGroupLabel>
                {activeProject?.name && (
                  <MenuItem disabled>
                    <Folder />
                    <span className="min-w-0 truncate">{activeProject.name}</span>
                  </MenuItem>
                )}
                {(activeWorkspace.branch || activeWorkspace.name) && (
                  <MenuItem disabled>
                    <GitBranch />
                    <span className="min-w-0 truncate">
                      {activeWorkspace.branch ?? activeWorkspace.name}
                    </span>
                  </MenuItem>
                )}
                {activeWorkspace.path && (
                  <div className="px-2 pt-0.5 pb-1.5 text-small text-muted-foreground">
                    {/* Ident, not raw font-mono: the fontDomainScan whitelist. */}
                    <Ident className="break-all">{activeWorkspace.path}</Ident>
                  </div>
                )}
              </MenuGroup>
            </>
          )}
        </MenuPopup>
      </Menu>

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
 * dsh-rebase P1-11 (decision 128): opens and hides the shell of this
 * conversation's folder — since layout 5d, the terminal pane.
 * Disabled, with the reason, when the conversation has no folder (decision
 * 126 rule 2). A dot marks a shell that is running out of sight, so hiding
 * the terminal never hides a process.
 */
function TerminalButton({ state, onToggle }: { state: TerminalButtonState; onToggle: () => void }) {
  const { t } = useI18n();
  const unavailable = state === 'unavailable';
  const label = unavailable
    ? t('This conversation has no folder to open a terminal in')
    : state === 'hidden'
      ? t('Terminal (still running)')
      : t('Terminal');
  const icon = (
    <>
      <SquareTerminal className="size-4" />
      {/* The sidebar's "attached in the background" mark: a filled muted dot
          (running is never blue, design system v2 §6). */}
      {state === 'hidden' && (
        <span
          aria-hidden
          className="absolute top-1 right-1 size-1.5 rounded-full bg-muted-foreground"
        />
      )}
    </>
  );
  if (unavailable) {
    // A disabled button gets no pointer events, so the wrapper carries the
    // reason on hover (the arrangement `FailureContinueButton` uses).
    return (
      <span className="flex shrink-0" title={label}>
        <button
          type="button"
          className="flex size-7 cursor-not-allowed items-center justify-center rounded-sm text-muted-foreground opacity-64"
          disabled
          aria-pressed={false}
          aria-label={label}
          data-session-terminal={state}
        >
          {icon}
        </button>
      </span>
    );
  }
  return (
    <BarIconButton
      label={label}
      pressed={state === 'open'}
      onClick={onToggle}
      data={{ 'data-session-terminal': state }}
    >
      {icon}
    </BarIconButton>
  );
}

function useBackgroundWorkCounts(sessionId: string): { jobs: number; agents: number } {
  const panels = useSessionPanelsStore((state) => state.bySession[sessionId]);
  const allLanes = useSubagentActivityStore((state) => state.lanes);
  return useMemo(() => {
    const lanes = Object.values(allLanes).filter((lane) => lane.sessionId === sessionId);
    return {
      jobs: deriveJobsWindowView({ panels, lanes, hidden: NO_HIDDEN_JOBS }).running,
      agents: deriveSubagentsWindowView({ panels, lanes }).running,
    };
  }, [allLanes, panels, sessionId]);
}

/**
 * Layout 5d: one 「后台任务」 button for the tasks pane (background commands,
 * workflows and subagents — the pane lists both kinds the two floating
 * sub-windows used to). Shown only while something runs or the pane is open,
 * with the running count; the ⋮ menu always offers it.
 */
function BackgroundTasksButton({
  sessionId,
  open,
  onToggle,
}: {
  sessionId: string;
  open: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  const { jobs, agents } = useBackgroundWorkCounts(sessionId);
  const count = jobs + agents;
  if (count === 0 && !open) return null;
  return (
    <BarIconButton
      label={t('Background tasks')}
      pressed={open}
      onClick={onToggle}
      data={{ 'data-panel-toggle': 'tasks' }}
    >
      <Layers className="size-4" />
      {count > 0 && (
        <Badge size="sm" className="absolute -top-0.5 -right-0.5 rounded-full tabular-nums">
          {count}
        </Badge>
      )}
    </BarIconButton>
  );
}
