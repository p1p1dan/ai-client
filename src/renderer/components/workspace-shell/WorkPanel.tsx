/**
 * Layout 5a (ui-cohesion §6, rulings L3/L4): the right work panel.
 *
 * One container replaces two: the left dock's surface stack (git / files /
 * context / run behind the retired icon rail) and the right column's three
 * mutually exclusive occupants (review, terminal, editor). A 40px strip of
 * frameless tabs on top, the tab's content below. Closed by default; the
 * title bar's buttons, Ctrl/Cmd+2..5 and opening a file open it.
 *
 * Mount rules carried over unchanged, because each one guards a real bug:
 *  - registry surfaces use the dock's multi-mount stack (`deriveMountedSurfaceIds`):
 *    hidden layers are `invisible` + `inert`, never `display: none` — a
 *    display-hidden box measures 0×0, and xterm's FitAddon (driven by a
 *    ResizeObserver `useXterm` does not zero-guard) forwards that to the pty
 *    as `cols: 2`;
 *  - the editor mounts while a file is open OR a file-open intent is pending
 *    (round-10 ⑥: it is the intent's only consumer), and is `hidden` while
 *    another tab shows, never unmounted;
 *  - running column shells never unmount; out of sight they keep a real box;
 *  - the editor sits behind its own error boundary (T4).
 *
 * While closed the panel is not unmounted either: it is lifted out of the row
 * (`absolute`), made invisible and inert, and keeps the width it would have
 * (`parkedWidth`), so everything above keeps holding.
 */
import { Maximize2, Minimize2, X } from 'lucide-react';
import { type ReactNode, type RefObject, useRef } from 'react';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import type { SearchMode } from '@/components/search/useGlobalSearch';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useEditorStore } from '@/stores/editor';
import { EditorColumn } from './center/EditorColumn';
import { TerminalColumn } from './center/TerminalColumn';
import { SessionReviewPanel } from './SessionReviewPanel';
import { ShellResizeHandle } from './ShellResizeHandle';
import type { SessionReviewEntry } from './sessionReview';
import {
  deriveMountedSurfaceIds,
  ESCAPE_OWNING_POPUP_SELECTOR,
  SURFACE_ESCAPE_HOLD_ATTR,
  shouldCloseOnEscape,
} from './shellLayoutModel';
import { type ContextSurfaceId, shouldShowActivityDot } from './surfaceRegistry';
import { SURFACE_VIEWS } from './surfaceViews';
import { useGitChangeCount } from './useGitChangeCount';
import {
  surfaceIdForTab,
  WORK_PANEL_TAB_LABEL_KEYS,
  type WorkPanelTab,
  type WorkPanelView,
} from './workPanelModel';

/**
 * T4: the editor behind its own error boundary, so a file view that throws
 * while rendering takes down this tab instead of the whole window (the
 * 2026-09-24 field crash reached the root card from an image preview).
 *
 * The boundary retries by itself when the active tab or the tab count
 * changes — the fallback covers the tab bar, so picking another file in the
 * tree (or closing the failed tab from anywhere else) has to be enough to
 * bring it back. Subscribed here, not in the shell, so a tab switch does not
 * re-render the whole shell.
 */
function GuardedEditorColumn() {
  const activeTabPath = useEditorStore((state) => state.activeTabPath);
  const tabCount = useEditorStore((state) => state.tabs.length);
  return (
    <ErrorBoundary
      scope="editor-column"
      className="h-full min-h-0"
      resetKey={`${tabCount}:${activeTabPath ?? ''}`}
    >
      <EditorColumn />
    </ErrorBoundary>
  );
}

export interface WorkPanelResize {
  /** What the panel is allocated now — the drag baseline. */
  width: number;
  clamp: (width: number) => number;
  onCommit: (width: number) => void;
  onDragFrame: (width: number) => void;
  onResizingChange: (resizing: boolean) => void;
}

interface WorkPanelProps {
  /** `resolveWorkPanelView`: open, and the tab on screen. */
  view: WorkPanelView;
  /** Tabs on the strip, in order (`deriveWorkPanelTabs`). */
  tabs: readonly WorkPanelTab[];
  /** The last tab asked for; its content stays mounted across a close. */
  rememberedTab: WorkPanelTab;
  onSelectTab: (tab: WorkPanelTab) => void;
  onClose: () => void;
  expanded: boolean;
  onToggleExpanded: () => void;
  /** Width while closed, so parked terminals keep a real box. */
  parkedWidth: number;
  resize: WorkPanelResize;
  /** Editor tabs exist (the editor gets a box). */
  editorOpen: boolean;
  /** A file-open intent is waiting for the editor to consume it. */
  fileIntentPending: boolean;
  review: { sessionId: string | null; entries: readonly SessionReviewEntry[] } | null;
  hasColumnTerminals: boolean;
  terminalKey: string | null;
  onSearch?: (mode: SearchMode) => void;
}

/** Computed key so a rename of the constant cannot leave a dead attribute behind. */
const ESCAPE_HOLD_ATTR = SURFACE_ESCAPE_HOLD_ATTR;

export function WorkPanel({
  view,
  tabs,
  rememberedTab,
  onSelectTab,
  onClose,
  expanded,
  onToggleExpanded,
  parkedWidth,
  resize,
  editorOpen,
  fileIntentPending,
  review,
  hasColumnTerminals,
  terminalKey,
  onSearch,
}: WorkPanelProps) {
  const { t } = useI18n();
  const panelRef = useRef<HTMLElement>(null);
  const shownTab = view.tab;
  const open = view.open;

  // Registry surfaces: the dock's mount rules, keyed by tab. A ref written
  // during render, not state: the mount list must be right in the SAME render
  // that opens a tab, and the write is idempotent under StrictMode.
  const activeSurfaceId = shownTab ? surfaceIdForTab(shownTab) : null;
  const visitedRef = useRef<ContextSurfaceId[]>([]);
  if (activeSurfaceId && !visitedRef.current.includes(activeSurfaceId)) {
    visitedRef.current = [...visitedRef.current, activeSurfaceId];
  }
  // Only a surface already shown this session stays mounted while closed:
  // nothing loads behind a panel the user never opened.
  const rememberedSurfaceId = surfaceIdForTab(rememberedTab);
  const lastSurfaceId =
    rememberedSurfaceId && visitedRef.current.includes(rememberedSurfaceId)
      ? rememberedSurfaceId
      : null;
  const mountedSurfaceIds = deriveMountedSurfaceIds({
    visited: visitedRef.current,
    activeSurfaceId,
    lastSurfaceId,
    registrations: SURFACE_VIEWS,
  });

  const changedFilesCount = useGitChangeCount();
  const showEditor = shownTab === 'editor' && editorOpen;
  const showTerminal = shownTab === 'terminal';

  return (
    <section
      ref={panelRef}
      aria-label={t('Work panel')}
      aria-hidden={open ? undefined : true}
      inert={!open}
      data-work-panel={open ? (shownTab ?? '') : 'closed'}
      className={cn(
        'flex min-h-0 flex-col bg-surface-1',
        'transition-[width] duration-[250ms] group-data-[resizing]/shell:transition-none',
        !open && 'pointer-events-none invisible absolute inset-y-0 right-0',
        open && expanded && 'absolute inset-0 z-20',
        open && !expanded && 'relative min-w-0 shrink-0 border-l border-border-soft'
      )}
      style={
        !open
          ? { width: `${parkedWidth}px` }
          : expanded
            ? undefined
            : { width: 'var(--shell-editor-w)' }
      }
      // Panel-scoped Escape, carried over from the dock: a subtree marked
      // `data-surface-holds-escape` (a terminal running vim, Monaco's find
      // widget) opts out, and so does any open popup (it is portaled, so it is
      // queried on the document).
      onKeyDownCapture={(event) => {
        const target = event.target as HTMLElement | null;
        const holdsEscape = !!target?.closest?.(`[${ESCAPE_HOLD_ATTR}]`);
        const popupOpen = !!document.querySelector(ESCAPE_OWNING_POPUP_SELECTOR);
        if (!shouldCloseOnEscape({ key: event.key, isOpen: open, holdsEscape, popupOpen })) {
          return;
        }
        onClose();
        event.stopPropagation();
      }}
    >
      {/* Design system v2 §7.12: the canvas, one hairline below; the selected
          tab is frameless, foreground ink and a 2px brand line. */}
      <div className="flex h-10 shrink-0 items-center gap-0.5 border-b border-border-soft pr-1.5 pl-1">
        <div
          role="tablist"
          aria-label={t('Work panel')}
          className="flex h-full min-w-0 flex-1 items-stretch overflow-x-auto [scrollbar-width:none]"
        >
          {tabs.map((tab) => (
            <PanelTabButton
              key={tab}
              tab={tab}
              selected={tab === shownTab}
              onSelect={() => onSelectTab(tab)}
              trailing={
                tab === 'changes' && review && review.entries.length > 0 ? (
                  <span className="text-2xs text-foreground-faint tabular-nums">
                    {review.entries.length}
                  </span>
                ) : tab === 'git' && shouldShowActivityDot('git', { changedFilesCount }) ? (
                  <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-info" />
                ) : null
              }
            />
          ))}
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onToggleExpanded}
          aria-label={t(expanded ? 'Restore panel' : 'Expand panel')}
          title={t(expanded ? 'Restore panel' : 'Expand panel')}
        >
          {expanded ? <Minimize2 /> : <Maximize2 />}
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onClose}
          aria-label={t('Close panel')}
          title={t('Close panel')}
        >
          <X />
        </Button>
      </div>

      <div className="relative isolate min-h-0 flex-1">
        {mountedSurfaceIds.map((id) => {
          const registration = SURFACE_VIEWS[id];
          if (!registration) return null;
          const SurfaceView = registration.component;
          const visible = id === activeSurfaceId;
          return (
            <div
              key={id}
              className={cn('absolute inset-0', visible ? 'z-10' : 'invisible pointer-events-none')}
              inert={!visible}
              data-panel-surface={id}
            >
              <SurfaceView surfaceId={id} active={open && visible} onSearch={onSearch} />
            </div>
          );
        })}

        {review && shownTab === 'changes' && (
          <div className="absolute inset-0 z-10">
            <SessionReviewPanel
              key={review.sessionId}
              sessionId={review.sessionId}
              entries={review.entries}
              onClose={onClose}
              onShowFiles={() => onSelectTab('editor')}
              onOpenDiff={() => onSelectTab('editor')}
              filesOpen={editorOpen}
              expanded={expanded}
              onToggleExpanded={onToggleExpanded}
            />
          </div>
        )}

        {/* Round-10 ⑥: a pending intent mounts the editor too, in a `hidden`
            layer (no box, effects still run) — it is the intent's only
            consumer. Covered by another tab means `hidden`, never unmounted. */}
        {(editorOpen || fileIntentPending) && (
          <div
            className={cn('absolute inset-0', showEditor ? 'z-10' : 'hidden')}
            data-panel-layer="editor"
          >
            <GuardedEditorColumn />
          </div>
        )}

        {/* dsh-rebase P1-11 (decisions 109, 126, 128): mounted while ANY column
            shell runs — unmounting a shell ends it. Out of sight it keeps a
            real box (`invisible`, never `display: none`). */}
        {hasColumnTerminals && (
          <div
            className={cn(
              'absolute inset-0',
              showTerminal ? 'z-10' : 'pointer-events-none invisible'
            )}
            inert={!showTerminal}
            aria-hidden={showTerminal ? undefined : true}
            data-panel-layer="terminal"
          >
            <TerminalColumn currentKey={terminalKey} visible={open && showTerminal} />
          </div>
        )}
      </div>

      {open && !expanded && (
        <ShellResizeHandle
          side="left"
          ariaLabel={t('Resize work panel')}
          width={resize.width}
          targetRef={panelRef as RefObject<HTMLElement | null>}
          clamp={resize.clamp}
          onCommit={resize.onCommit}
          onDragFrame={resize.onDragFrame}
          onResizingChange={resize.onResizingChange}
        />
      )}
    </section>
  );
}

function PanelTabButton({
  tab,
  selected,
  onSelect,
  trailing,
}: {
  tab: WorkPanelTab;
  selected: boolean;
  onSelect: () => void;
  trailing: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      data-panel-tab={tab}
      onClick={onSelect}
      className={cn(
        'relative flex shrink-0 items-center gap-1.5 rounded-sm px-2.5 text-ui transition-colors',
        selected
          ? 'text-foreground'
          : 'text-muted-foreground hover:bg-fill-ghost-hover hover:text-foreground'
      )}
    >
      {t(WORK_PANEL_TAB_LABEL_KEYS[tab])}
      {trailing}
      {selected && (
        <span aria-hidden className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-primary" />
      )}
    </button>
  );
}
