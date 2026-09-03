import { Columns2, Folder, LayoutGrid, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Ident } from '@/components/ui/ident';
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { useShellLayoutStore } from '@/stores/shellLayout';
import { derivePanelTabs, type PanelTab } from './panelTabsModel';
import type { ReadingWidthMode } from './shellLayoutModel';
import { SURFACE_ICON_MAP } from './surfaceIcons';
import type { ContextSurfaceId } from './surfaceRegistry';
import { useGitChangeCount } from './useGitChangeCount';

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

  // D34 (user ruling 2026-08-14, overturns round-12's "one switcher, always
  // on the rail"): the four rail icons move here, left of the collapse
  // toggle. Same source as the retired `ContextPanelRail` — `derivePanelTabs`
  // exists precisely so the switcher can be re-mounted anywhere without a
  // second reading of the registry drifting from the first (see its doc).
  const railOrder = useShellLayoutStore((state) => state.railOrder);
  const activeSurfaceId = useShellLayoutStore((state) => state.activeSurfaceId);
  const selectSurface = useShellLayoutStore((state) => state.selectSurface);
  const shellColumnMode = useShellLayoutStore((state) => state.shellColumnMode);
  const toggleShellColumnMode = useShellLayoutStore((state) => state.toggleShellColumnMode);
  const changedFilesCount = useGitChangeCount();
  // U02-b: two-column collapses the rail to `context` alone.
  const surfaces = derivePanelTabs(railOrder, { changedFilesCount }, shellColumnMode);

  const activeSession = sessions.find((session) => session.id === activeSessionId);
  const activeWorkspace = workspaces.find((ws) => ws.id === activeSession?.workspaceId);
  // Resolved through the workspace, not session.projectId — a stale
  // session.projectId must not label the header with the wrong folder (same
  // trap buildSidebarFolders documents in LeftNav).
  const activeProject = projects.find((project) => project.id === activeWorkspace?.projectId);

  const workspaceLabel = activeProject?.name ?? activeWorkspace?.name;
  const contextLine = [activeProject?.name, activeWorkspace?.name].filter(Boolean).join(' · ');

  return (
    // T-23 (P-22): one line, h-9. T-32 (D27) moved this header out of the chat
    // column so it now SPANS chat + panel + rail (A08「顶栏贯通中右」,
    // a08:1078) — the flush line it shares is therefore LeftNav's top bar, and
    // the panel's tab strip sits one row BELOW it («三 tab 明确居其下»), not
    // beside it. T-23's original "three top bars flush" wording described the
    // pre-T-32 shell and no longer holds; height and contents are unchanged.
    // The old second line is gone —
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
        {/*
          U02-b (D02): two-column layout — AI conversation + development only.
          The rail collapses to `context`; Files/Git/Terminal are unreachable
          until you switch back. aria-pressed carries the state (rail idiom).
        */}
        <HeaderIconButton
          label={t('Two-column layout')}
          icon={Columns2}
          active={shellColumnMode === 'two-column'}
          onClick={toggleShellColumnMode}
        />
        {/*
          D34: the surface switcher, migrated from the retired vertical rail.
          `border-l` keeps it visually distinct from the reading-width toggle,
          the same separation the rail's own border gave it as a column.
        */}
        <div
          role="group"
          aria-label={t('Context surfaces')}
          className="flex items-center gap-1 border-l pl-1"
        >
          {surfaces.map((surface) => (
            <SurfaceHeaderButton
              key={surface.id}
              surface={surface}
              active={surface.id === activeSurfaceId}
              onSelect={selectSurface}
            />
          ))}
        </div>
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

interface SurfaceHeaderButtonProps {
  surface: PanelTab;
  active: boolean;
  onSelect: (id: ContextSurfaceId) => void;
}

/**
 * D34: one rail-visible surface, migrated verbatim from the retired
 * `ContextPanelRail.tsx` (icon, aria-label/aria-pressed, the title+description
 * Tooltip, the git-only 6px dot) — only the tooltip side flipped from `left`
 * (rail on the right edge) to `bottom` (button on the top edge) and the
 * outer size from a 44px column to `size="icon"` in a horizontal row (design
 * system 「新壳布局档位」 566-567: 32px button, 18px / `size-4.5` icon).
 */
function SurfaceHeaderButton({ surface, active, onSelect }: SurfaceHeaderButtonProps) {
  const { t } = useI18n();
  const Icon = SURFACE_ICON_MAP[surface.icon];

  return (
    <Tooltip>
      <TooltipTrigger
        delay={150}
        render={
          <Button
            variant="ghost"
            size="icon"
            aria-pressed={active}
            aria-label={t(surface.labelKey)}
            className={cn(
              'relative',
              // --hover / --selection are mutually exclusive on purpose (see
              // LeftNav.tsx:520-529): `hover:bg-hover` compiles to
              // `.hover\:bg-hover:hover` (0,2,0) and would outrank a plain
              // `.bg-selection` (0,1,0), erasing the active state on hover.
              active
                ? 'bg-selection text-primary'
                : 'text-muted-foreground hover:bg-hover hover:text-foreground'
            )}
            onClick={() => onSelect(surface.id)}
          />
        }
      >
        <Icon className="size-4.5" />
        {surface.showDot && (
          <span
            aria-hidden="true"
            className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-info"
          />
        )}
      </TooltipTrigger>
      <TooltipPopup side="bottom" sideOffset={8}>
        <p className="font-medium">{t(surface.labelKey)}</p>
        <p className="text-muted-foreground">{t(surface.descriptionKey)}</p>
      </TooltipPopup>
    </Tooltip>
  );
}
