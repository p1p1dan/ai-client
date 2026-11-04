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
  PanelRight,
  Plus,
  SquareTerminal,
} from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { requestComposerFocus } from '@/components/chat/composerFocus';
import { SessionTreeDialog } from '@/components/chat/SessionTreeDialog';
import { displaySessionTitle } from '@/components/chat/sessionIndex/sessionTitle';
import { deriveJobsWindowView, deriveSubagentsWindowView } from '@/components/chat/subwindowsModel';
import { WindowControls } from '@/components/layout/WindowControls';
import { Badge } from '@/components/ui/badge';
import { Ident } from '@/components/ui/ident';
import {
  Menu,
  MenuCheckboxItem,
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
import { type BarButton, resolveBarOverflow } from './sessionBarOverflow';
import type { PaneKind, TerminalButtonState } from './workPanelModel';

const NO_PANES: readonly PaneKind[] = [];

export interface SessionReviewTotals {
  count: number;
  added: number;
  removed: number;
}

/**
 * macOS keeps its native traffic lights; Windows and Linux windows are
 * frameless. Off, too, where there is no window API (tests, a bare browser).
 */
const WINDOW_CONTROLS_SHOWN =
  typeof window !== 'undefined' &&
  Boolean(window.electronAPI?.window) &&
  window.electronAPI.env?.platform !== 'darwin';

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
  /**
   * Layout 5f (ruling L6): the side chat's toggle, right after the rail's
   * divider and before the terminal.
   */
  sideChatToggle?: ReactNode;
  /**
   * Layout 5e: the rail's ⋮ entry, and whether the rail is on screen — while it
   * is, its environment card carries the repository / branch / folder, so the
   * menu drops them.
   */
  sessionRail?: {
    visible: boolean;
    /** Already translated. */
    label: string;
    disabled: boolean;
    onToggle: () => void;
  };
  /**
   * Decision 209 §5: the side chat's ⋮ entry, for when its button does not
   * fit on the bar. Already translated.
   */
  sideChat?: { open: boolean; label: string; onToggle: () => void };
  /**
   * Decision 209 §5: the bar's width (the center row's), so buttons that do
   * not fit move into ⋮. Null or absent = unmeasured: every button stays.
   */
  barWidth?: number | null;
}

/**
 * Layout 5a: the title bar's buttons — icon only, the name in a tooltip
 * (the reference's desktop shell). 28px, 16px icons; pressed = the shared
 * `fill-ghost-selected`.
 */
export function barIconClass(pressed: boolean): string {
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
 *   right — [5e session rail toggle | divider] [5f side chat] terminal · changes · files ·
 *           (background tasks while something runs or its pane is open) · ⋮.
 *
 * Layout 5d: every button toggles a pane card; pressed = that pane is open.
 * The ⋮ menu takes what has no button: the Git / Run / Context / background
 * tasks panes, the session rail (layout 5e), and — only while the rail is not
 * on screen — the repository / branch / folder the conversation runs in,
 * which the rail's environment card otherwise shows. The background
 * tasks button opens the tasks pane; the floating sub-windows (chat/) are no
 * longer opened from here.
 *
 * Decision 209 §5: buttons that do not fit move into ⋮ from the right
 * (`resolveBarOverflow`), as ticked entries at the top of the menu; the
 * rail's and the background tasks' entries are already there and are not
 * repeated.
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
  sideChatToggle,
  sessionRail,
  sideChat,
  barWidth = null,
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

  // Shown while something runs or its pane is open; the ⋮ entry always is.
  const tasksOpen = openPanes.includes('tasks');
  const backgroundWork = useBackgroundWorkCounts(activeSessionId);
  const tasksCount = backgroundWork.jobs + backgroundWork.agents;
  const terminalShown = Boolean(activeSessionId && terminalState && onToggleTerminal);
  const buttons: BarButton[] = [];
  if (sessionRailToggle) buttons.push('rail');
  if (sideChatToggle) buttons.push('side-chat');
  if (terminalShown) buttons.push('terminal');
  if (review && onTogglePane) buttons.push('changes');
  if (onTogglePane) buttons.push('files');
  if (activeSessionId && onTogglePane && (tasksCount > 0 || tasksOpen)) buttons.push('tasks');
  const bar = resolveBarOverflow({
    width: barWidth,
    buttons,
    expandSidebar: sidebarCollapsed && Boolean(onExpandSidebar),
    windowControls: WINDOW_CONTROLS_SHOWN,
  });
  const onBar = (button: BarButton) => bar.inline.includes(button);
  const inMenu = (button: BarButton) => bar.overflow.includes(button);
  // The rail and the background tasks already have their ⋮ entries.
  const menuToggles = bar.overflow.filter((button) => button !== 'rail' && button !== 'tasks');

  return (
    // `overflow-hidden`: the bar ends at the center row's edge whatever its
    // content does; the title truncates first.
    <div
      className={cn(
        'flex h-9 shrink-0 items-center gap-1 overflow-hidden bg-surface-1 pl-2 drag-region select-none',
        WINDOW_CONTROLS_SHOWN ? 'pr-0' : 'pr-2'
      )}
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

      {onBar('rail') && (
        <>
          {sessionRailToggle}
          <span aria-hidden className="mx-1 h-4.5 w-px shrink-0 bg-border-soft" />
        </>
      )}
      {onBar('side-chat') && sideChatToggle}
      {onBar('terminal') && terminalState && onToggleTerminal && (
        <TerminalButton state={terminalState} onToggle={onToggleTerminal} />
      )}
      {onBar('changes') && review && onTogglePane && (
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
      {onBar('files') && onTogglePane && (
        <BarIconButton
          label={t('Files')}
          pressed={openPanes.includes('files')}
          onClick={() => onTogglePane('files')}
          data={{ 'data-panel-toggle': 'files' }}
        >
          <FolderOpen className="size-4" />
        </BarIconButton>
      )}
      {onBar('tasks') && onTogglePane && (
        <BackgroundTasksButton
          count={tasksCount}
          open={tasksOpen}
          onToggle={() => onTogglePane('tasks')}
        />
      )}

      <Menu>
        <MenuTrigger className={barIconClass(false)} aria-label={t('More actions')}>
          <MoreVertical className="size-4" />
        </MenuTrigger>
        <MenuPopup align="end" className="min-w-56">
          {/* Decision 209 §5: the buttons the bar had no room for, where
              they sat, ticked while their pane (or the side chat) is open. */}
          {menuToggles.length > 0 && (
            <>
              <MenuGroup data-bar-overflow="">
                {menuToggles.map((button) => (
                  <BarOverflowItem
                    key={button}
                    button={button}
                    openPanes={openPanes}
                    onTogglePane={onTogglePane}
                    terminalState={terminalState}
                    onToggleTerminal={onToggleTerminal}
                    reviewLabel={reviewLabel}
                    sideChat={sideChat}
                  />
                ))}
              </MenuGroup>
              <MenuSeparator />
            </>
          )}
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
                  {/* The button's running count, while the button is in here. */}
                  {inMenu('tasks') && tasksCount > 0 && (
                    <Badge size="sm" className="ms-auto rounded-full tabular-nums">
                      {tasksCount}
                    </Badge>
                  )}
                </MenuItem>
              )}
            </MenuGroup>
          )}
          {activeSessionId && sessionRail && (
            <MenuItem
              disabled={sessionRail.disabled}
              onClick={sessionRail.onToggle}
              data-session-rail-item=""
            >
              <PanelRight />
              {sessionRail.label}
            </MenuItem>
          )}
          {/* Layout 5e: the session rail's environment card carries these
              while the rail is on screen. */}
          {activeWorkspace && !sessionRail?.visible && (
            <>
              <MenuSeparator />
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

      {/* The window's top line (frameless on Windows and Linux): its buttons
          sit at the bar's right end, flush with the window edge. */}
      {WINDOW_CONTROLS_SHOWN && (
        <div className="ml-1 flex h-full shrink-0 self-stretch no-drag" data-window-controls="">
          <WindowControls />
        </div>
      )}

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
function terminalLabel(state: TerminalButtonState, t: (key: string) => string): string {
  return state === 'unavailable'
    ? t('This conversation has no folder to open a terminal in')
    : state === 'hidden'
      ? t('Terminal (still running)')
      : t('Terminal');
}

function TerminalButton({ state, onToggle }: { state: TerminalButtonState; onToggle: () => void }) {
  const { t } = useI18n();
  const unavailable = state === 'unavailable';
  const label = terminalLabel(state, t);
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

function useBackgroundWorkCounts(sessionId: string | null): { jobs: number; agents: number } {
  const panels = useSessionPanelsStore((state) =>
    sessionId ? state.bySession[sessionId] : undefined
  );
  const allLanes = useSubagentActivityStore((state) => state.lanes);
  return useMemo(() => {
    if (!sessionId) return { jobs: 0, agents: 0 };
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
 * sub-windows used to). Shown only while something runs or the pane is open
 * (the bar decides, decision 209 §5), with the running count; the ⋮ menu
 * always offers it.
 */
function BackgroundTasksButton({
  count,
  open,
  onToggle,
}: {
  count: number;
  open: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
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

/**
 * Decision 209 §5: a bar button that moved into ⋮ — the same toggle, ticked
 * while what it opens is on screen. The menu closes on a click, as the
 * button's own click would leave nothing more to do there.
 */
function BarOverflowItem({
  button,
  openPanes,
  onTogglePane,
  terminalState,
  onToggleTerminal,
  reviewLabel,
  sideChat,
}: {
  button: Exclude<BarButton, 'rail' | 'tasks'>;
  openPanes: readonly PaneKind[];
  onTogglePane?: (kind: PaneKind) => void;
  terminalState?: TerminalButtonState;
  onToggleTerminal?: () => void;
  reviewLabel: string;
  sideChat?: { open: boolean; label: string; onToggle: () => void };
}) {
  const { t } = useI18n();
  if (button === 'side-chat') {
    if (!sideChat) return null;
    return (
      <MenuCheckboxItem
        checked={sideChat.open}
        onCheckedChange={sideChat.onToggle}
        closeOnClick
        data-bar-overflow-item={button}
      >
        {sideChat.label}
      </MenuCheckboxItem>
    );
  }
  if (button === 'terminal') {
    if (!terminalState || !onToggleTerminal) return null;
    return (
      <MenuCheckboxItem
        checked={terminalState === 'open'}
        disabled={terminalState === 'unavailable'}
        onCheckedChange={onToggleTerminal}
        closeOnClick
        data-bar-overflow-item={button}
      >
        {terminalLabel(terminalState, t)}
      </MenuCheckboxItem>
    );
  }
  if (!onTogglePane) return null;
  return (
    <MenuCheckboxItem
      checked={openPanes.includes(button)}
      onCheckedChange={() => onTogglePane(button)}
      closeOnClick
      data-bar-overflow-item={button}
    >
      {button === 'changes' ? reviewLabel : t('Files')}
    </MenuCheckboxItem>
  );
}
