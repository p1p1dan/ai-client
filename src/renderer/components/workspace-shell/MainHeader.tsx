import { Folder, LayoutGrid, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Ident } from '@/components/ui/ident';
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useChatSessionsStore } from '@/stores/chatSessions';
import type { ReadingWidthMode } from './shellLayoutModel';

interface MainHeaderProps {
  contextPanelOpen: boolean;
  onToggleContextPanel: () => void;
  readingWidthMode: ReadingWidthMode;
  onToggleReadingWidth: () => void;
}

export function MainHeader({
  contextPanelOpen,
  onToggleContextPanel,
  readingWidthMode,
  onToggleReadingWidth,
}: MainHeaderProps) {
  const { t } = useI18n();
  const activeSessionId = useChatSessionsStore((state) => state.activeSessionId);
  const sessions = useChatSessionsStore((state) => state.sessions);
  const projects = useChatSessionsStore((state) => state.projects);
  const workspaces = useChatSessionsStore((state) => state.workspaces);

  const activeSession = sessions.find((session) => session.id === activeSessionId);
  const activeWorkspace = workspaces.find((ws) => ws.id === activeSession?.workspaceId);
  // Resolved through the workspace, not session.projectId — a stale
  // session.projectId must not label the header with the wrong folder (same
  // trap buildSidebarFolders documents in LeftNav).
  const activeProject = projects.find((project) => project.id === activeWorkspace?.projectId);

  const workspaceLabel = activeProject?.name ?? activeWorkspace?.name;
  const contextLine = [activeProject?.name, activeWorkspace?.name].filter(Boolean).join(' · ');

  return (
    // T-23 (P-22): one line, h-9 so the three top bars (LeftNav / here /
    // ContextPanel) share one flush border-b. The old second line is gone —
    // but NOT because the Composer target bar repeats it: in session mode the
    // target row drops its folder slot (A07 §08②), so the workspace chip
    // below is the project's only header presence, with the full path behind
    // its tooltip (hover and keyboard focus both reach it). Usage stays in
    // WindowTitleBar's user pill (real todayCostUsd); the header must not
    // grow a ring for it (the removed ring showed a hardcoded percentage).
    <header className="flex h-9 shrink-0 items-center gap-3 border-b px-3">
      <h1
        // T-23 (P-19): body copy is 15px (--text-markdown); a 14px title read
        // as *less* important than the messages under it, so the title joins
        // the body tier. Weight is font-semibold per the design-system weight
        // table: Win10's Segoe UI has no 500 and falls back to 400, so a
        // medium-only hierarchy would vanish there.
        // min-w-20, not the usual min-w-0: flex-1 gives the title basis 0, so
        // in the narrow-window crunch it would vanish while the chip kept its
        // width. The floor keeps a few characters of title and forces the
        // chip to shrink first (80px floor still fits the 685px minimum).
        className="min-w-20 flex-1 truncate text-markdown leading-normal font-semibold text-foreground"
        title={activeSession?.title}
      >
        {activeSession?.title ?? t('No session selected')}
      </h1>

      {activeWorkspace && (
        <Tooltip>
          <TooltipTrigger
            delay={150}
            // Focusable info affordance, not a button: its whole feedback is
            // the tooltip, so it must not read as clickable (cursor-default,
            // no button role).
            render={
              <span
                // biome-ignore lint/a11y/noNoninteractiveTabindex: WAI-ARIA tooltip pattern — the disclosure trigger must be keyboard-focusable, and it is deliberately not a button (there is no action to perform).
                tabIndex={0}
                // min-w-0 (NOT shrink-0): at the 685px window minimum with a
                // 380px panel open the main column is ~213px — a fixed-width
                // chip would push the action buttons past overflow-hidden.
                // Flex shrinks the chip down to its icon before that happens;
                // the tooltip still carries the full names.
                className="flex min-w-0 max-w-48 cursor-default items-center gap-1 rounded-sm text-meta text-muted-foreground"
              />
            }
          >
            <Folder className="h-3.5 w-3.5 shrink-0 text-folder" />
            <span className="min-w-0 truncate">{workspaceLabel}</span>
          </TooltipTrigger>
          <TooltipPopup side="bottom" sideOffset={8} className="max-w-96">
            <p className="font-medium">{contextLine}</p>
            {/* Ident, not raw font-mono: paths are mono via the D25 §2.5
                primitive so the fontDomainScan whitelist stays closed. */}
            <p className="text-muted-foreground">
              <Ident>{activeWorkspace.path}</Ident>
            </p>
          </TooltipPopup>
        </Tooltip>
      )}

      <div className="flex shrink-0 items-center gap-1">
        <HeaderIconButton
          label={t('Wide reading column')}
          icon={LayoutGrid}
          active={readingWidthMode === 'wide'}
          onClick={onToggleReadingWidth}
        />
        <HeaderIconButton
          label={t('Context panel')}
          icon={contextPanelOpen ? PanelRightClose : PanelRightOpen}
          active={contextPanelOpen}
          onClick={onToggleContextPanel}
        />
      </div>
    </header>
  );
}

interface HeaderIconButtonProps {
  /** Constant name of the thing toggled (rail idiom): state is aria-pressed's job. */
  label: string;
  icon: typeof LayoutGrid;
  active?: boolean;
  /** Required on purpose: a handler-less header icon is a dead control (A06 / T-23). */
  onClick: () => void;
}

function HeaderIconButton({ label, icon: Icon, active, onClick }: HeaderIconButtonProps) {
  return (
    <Button
      variant={active ? 'secondary' : 'ghost'}
      size="icon-xs"
      className={cn('h-6 w-6', active && 'bg-accent')}
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      title={label}
    >
      <Icon className="h-3.5 w-3.5" />
    </Button>
  );
}
