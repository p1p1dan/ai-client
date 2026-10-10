import { ArrowLeftRight, GitBranch, Layers, Plus, Terminal, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { requestComposerFocus } from '@/components/chat/composerFocus';
import { SessionTreeDialog } from '@/components/chat/SessionTreeDialog';
import { displaySessionTitle } from '@/components/chat/sessionIndex/sessionTitle';
import { deriveJobsWindowView, deriveSubagentsWindowView } from '@/components/chat/subwindowsModel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Ident } from '@/components/ui/ident';
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { statusForNextTurn, useChatSessionsStore } from '@/stores/chatSessions';
import { openHome } from '@/stores/homeDraft';
import { useSessionPanelsStore } from '@/stores/sessionPanels';
import { type SubwindowKey, useSessionSubwindowsStore } from '@/stores/sessionSubwindows';
import { useSubagentActivityStore } from '@/stores/subagentActivity';
import type { TerminalButtonState } from './rightColumnModel';

interface SessionBarProps {
  reviewOpen?: boolean;
  reviewCount?: number;
  onToggleReview?: () => void;
  /** dsh-rebase P1-11: the right-column terminal's toggle; absent = no button. */
  terminalState?: TerminalButtonState;
  onToggleTerminal?: () => void;
}

/**
 * dsh-rebase P1-11 (decision 128): when a button drops to its icon. On a
 * narrow window (below `xl`, the rule the sub-window buttons already had), and
 * also whenever the bar itself is narrow — the bar is as wide as the chat
 * column, and a file or the terminal in the right column can take half of a
 * wide window. A viewport breakpoint alone let the labels run past the chat
 * column's edge and over the right column's tab bar (the prototype's second
 * round, scene G). The bar is the `@container` these queries read.
 */
const BAR_LABEL_CLASS = 'max-xl:hidden @max-2xl:hidden';

/** The toggles' shared look: `h-6`, pressed = `bg-selection`. */
function barToggleClass(active: boolean): string {
  return cn(
    'flex h-6 items-center gap-1 rounded-sm px-2 text-meta transition-colors',
    active
      ? 'bg-selection text-foreground'
      : 'text-muted-foreground hover:bg-hover hover:text-foreground focus-visible:bg-hover'
  );
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
 * So the bar is back to what `MainHeader` carried before D08 — title and folder
 * context — minus the controls D08 deleted for good (the panel toggle and the
 * two/three-column switch went with `shellColumnMode`). The GUI / TUI switch
 * went with the pi TUI in dsh-rebase P1-11 (decision 127); the right-column
 * shell terminal's button took its place (decisions 109, 126, 128), first in
 * the group with the two sub-window toggles.
 *
 * The close ✕ does NOT come back here. "End this conversation" now lives in the
 * sidebar row's context menu, next to Rename and Archive, so the repo's three
 * closes sit together and can be told apart in one place.
 */
export function SessionBar({
  reviewOpen,
  reviewCount = 0,
  onToggleReview,
  terminalState,
  onToggleTerminal,
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

  // Decision 174 (issue #6, second wave): "New chat" opens the home page with
  // the folder the current chat lives in picked; for a temporary chat the home
  // page keeps its own pick (its default: the most recently active repository).
  // On the home page itself there is nothing to open — the button hands the
  // keyboard to the composer, which is where a new chat starts.
  const startNewChat = () => {
    if (!activeSession) {
      requestComposerFocus(null);
      return;
    }
    const path = activeWorkspace?.path?.trim() ? activeWorkspace.path : null;
    openHome(path ? { kind: 'path', path } : undefined);
  };

  const title = (
    <div className="flex min-w-0 items-center gap-1.5">
      {busy && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-status-running" />}
      {/* Decision 167 §6: 400 — the same size as the sidebar's 「聊天」 on this
          h-9 line, told apart by weight (panel name 600, chat name 400). The
          old `font-medium` rendered as 400 on Windows anyway. Decision 170
          (issue #6 ruling 3): both are 16px (`text-section`) now. Decision
          174: no conversation open is the home page, and the bar says so. */}
      <span className="min-w-0 truncate text-section text-foreground">
        {activeSession ? displaySessionTitle(activeSession.title, t) : t('Home')}
      </span>
      {/* P1-7e e6 (decision 145): 「临时」 is CJK, so the title's own
          `text-meta`, not 10px (design system, CJK cascade rule 3). */}
      {activeSession?.unbound && (
        <span className="shrink-0 rounded-xs border px-1 text-meta text-muted-foreground">
          {t('Temporary')}
        </span>
      )}
      {contextLine && (
        <span className="min-w-0 truncate text-meta text-muted-foreground">{contextLine}</span>
      )}
    </div>
  );

  return (
    // `overflow-hidden`: the bar ends at the chat column's edge whatever its
    // content does; the labels folding away (`BAR_LABEL_CLASS`) is the real fix.
    <div className="@container flex h-9 shrink-0 items-center gap-2 overflow-hidden border-b bg-card/40 px-2">
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
          screen, while 「+」 to their right creates one.
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
          <span className={BAR_LABEL_CLASS}>{t('Session branches')}</span>
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
          <span className={BAR_LABEL_CLASS}>{t('Session review')}</span>
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

      {/* dsh-rebase P1-11 (decisions 109, 126, 128): the terminal first, then
          P1-7b's background jobs and subagents windows (decisions 090, 109),
          behind one divider as in the prototype's bar. */}
      {activeSessionId && (
        <div className="flex shrink-0 items-center gap-0.5 border-l pl-2">
          {terminalState && onToggleTerminal && (
            <TerminalButton state={terminalState} onToggle={onToggleTerminal} />
          )}
          <BackgroundWorkButtons sessionId={activeSessionId} />
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
 * conversation's folder in the right column. Disabled, with the reason, when
 * the conversation has no folder (decision 126 rule 2). A dot marks a shell
 * that is running out of sight, so hiding the terminal never hides a process.
 */
function TerminalButton({ state, onToggle }: { state: TerminalButtonState; onToggle: () => void }) {
  const { t } = useI18n();
  const unavailable = state === 'unavailable';
  const open = state === 'open';
  const title = unavailable
    ? t('This conversation has no folder to open a terminal in')
    : state === 'hidden'
      ? t('Terminal (still running)')
      : t('Terminal');
  return (
    // A disabled button gets no pointer events, so the wrapper carries the
    // reason on hover (the arrangement `FailureContinueButton` uses).
    <span className="flex shrink-0" title={unavailable ? title : undefined}>
      <button
        type="button"
        className={
          unavailable
            ? 'flex h-6 cursor-not-allowed items-center gap-1 rounded-sm px-2 text-meta text-muted-foreground opacity-64'
            : barToggleClass(open)
        }
        onClick={onToggle}
        disabled={unavailable}
        aria-pressed={open}
        aria-label={title}
        title={title}
        data-session-terminal={state}
      >
        <Terminal className="size-3.5" />
        <span className={BAR_LABEL_CLASS}>{t('Terminal')}</span>
        {state === 'hidden' && (
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-status-running" />
        )}
      </button>
    </span>
  );
}

/**
 * dsh-rebase P1-7b: 「后台任务 N」 and 「子代理 N」 (prototype `sessionbar`):
 * a toggle each, pressed while its window is open; the count, in the brand
 * colour as the prototype draws it, is what runs now and is absent at zero.
 * On a narrow window or a narrow bar only the icons stay (the prototype's
 * compact bar; `BAR_LABEL_CLASS`).
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
      className="flex shrink-0 items-center gap-0.5"
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
      className={barToggleClass(active)}
      onClick={onClick}
      aria-pressed={active}
      title={label}
      data-subwindow={windowKey}
    >
      <Icon className="size-3.5" />
      <span className={BAR_LABEL_CLASS}>{label}</span>
      {count > 0 && (
        <Badge size="sm" className="rounded-full tabular-nums">
          {count}
        </Badge>
      )}
    </button>
  );
}
