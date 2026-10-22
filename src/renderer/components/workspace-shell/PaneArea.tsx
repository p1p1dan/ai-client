/**
 * Layout 5d (ui-cohesion §6; user feedback 2026-10-22): the panes to the right
 * of the chat, as separate cards — up to 2 columns × 2 rows, the rule in
 * `workPanelModel.ts`. Replaces 5a's `WorkPanel` (one container with a tab
 * strip, which read as a page inside a page).
 *
 * Every card is a sibling under ONE box with a stable key (its kind), placed
 * absolutely from the layout model, so opening, closing or expanding a pane
 * moves cards without remounting any of them. The splits are CSS variables on
 * that box; dragging a gap rewrites them on the node (no React render) and
 * commits once on release.
 *
 * Mount rules carried over from the work panel, because each one guards a
 * real bug:
 *  - a card that must stay mounted while off screen (below) is `invisible` +
 *    `inert` over the area's whole box, never `display: none` — a
 *    display-hidden box measures 0×0, and xterm's FitAddon (driven by a
 *    ResizeObserver `useXterm` does not zero-guard) forwards that to the pty
 *    as `cols: 2`;
 *  - the editor mounts while a file is open OR a file-open intent is pending
 *    (round-10 ⑥: it is the intent's only consumer);
 *  - running column shells never unmount;
 *  - keep-alive registry surfaces (the init-script terminal) stay mounted
 *    from their first showing; 'active' ones mount while their pane is open;
 *  - the editor sits behind its own error boundary (T4).
 *
 * With nothing open the area is not unmounted either: it is lifted out of the
 * row (`absolute`), made invisible and inert, and keeps the width it would
 * have (`parkedWidth`), so everything above keeps holding.
 */
import {
  Activity,
  Diff,
  FileCode,
  FolderOpen,
  Gauge,
  GitBranch,
  Globe,
  Layers,
  ListTodo,
  SquareTerminal,
  Users,
} from 'lucide-react';
import {
  type CSSProperties,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useRef,
} from 'react';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import type { SearchMode } from '@/components/search/useGlobalSearch';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useEditorStore } from '@/stores/editor';
import { EditorColumn } from './center/EditorColumn';
import { TerminalColumn } from './center/TerminalColumn';
import { PaneCard } from './PaneCard';
import { BackgroundTasksPane } from './panes/BackgroundTasksPane';
import { SessionReviewPanel } from './SessionReviewPanel';
import { ShellResizeHandle } from './ShellResizeHandle';
import type { SessionReviewEntry } from './sessionReview';
import type { ContextSurfaceId } from './surfaceRegistry';
import { SURFACE_VIEWS } from './surfaceViews';
import {
  clampSplitRatio,
  derivePaneGrid,
  PANE_KINDS,
  PANE_LABEL_KEYS,
  PANE_MIN_HEIGHT,
  PANE_MIN_WIDTH,
  type PaneKind,
  type PaneSplits,
  type PaneView,
  paneSlotStyle,
  surfaceIdForPane,
} from './workPanelModel';

/**
 * T4: the editor behind its own error boundary, so a file view that throws
 * while rendering takes down this pane instead of the whole window (the
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

const PANE_ICONS: Record<PaneKind, ReactNode> = {
  changes: <Diff />,
  files: <FolderOpen />,
  editor: <FileCode />,
  git: <GitBranch />,
  terminal: <SquareTerminal />,
  setup: <SquareTerminal />,
  run: <Activity />,
  context: <Gauge />,
  tasks: <Layers />,
  browser: <Globe />,
  plan: <ListTodo />,
  subagent: <Users />,
};

export interface PaneAreaResize {
  /** What the area is allocated now — the drag baseline. */
  width: number;
  clamp: (width: number) => number;
  onCommit: (width: number) => void;
  onDragFrame: (width: number) => void;
  onResizingChange: (resizing: boolean) => void;
}

export interface PaneActions {
  open: (kind: PaneKind) => void;
  close: (kind: PaneKind) => void;
  focus: (kind: PaneKind) => void;
  toggleExpanded: (kind: PaneKind) => void;
  commitColumnSplit: (ratio: number) => void;
  commitRowSplit: (column: 0 | 1, ratio: number) => void;
}

interface PaneAreaProps {
  /** `resolvePaneView`: what is on screen. */
  view: PaneView;
  splits: PaneSplits;
  actions: PaneActions;
  /** Width while nothing is open, so parked terminals keep a real box. */
  parkedWidth: number;
  resize: PaneAreaResize;
  /** Editor tabs exist. */
  editorOpen: boolean;
  /** A file-open intent is waiting for the editor to consume it. */
  fileIntentPending: boolean;
  review: { sessionId: string | null; entries: readonly SessionReviewEntry[] } | null;
  /** The conversation's branch, for the diff pane's header. */
  branch: string | null;
  /** The open conversation, for the background-tasks pane. */
  sessionId: string | null;
  hasColumnTerminals: boolean;
  terminalKey: string | null;
  onSearch?: (mode: SearchMode) => void;
}

const SPLIT_HANDLE_CLASS =
  'absolute z-20 touch-none select-none transition-colors hover:bg-border-strong/40 data-[dragging]:bg-border-strong/60';

export function PaneArea({
  view,
  splits,
  actions,
  parkedWidth,
  resize,
  editorOpen,
  fileIntentPending,
  review,
  branch,
  sessionId,
  hasColumnTerminals,
  terminalKey,
  onSearch,
}: PaneAreaProps) {
  const { t } = useI18n();
  const areaRef = useRef<HTMLElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const open = view.panes.length > 0;
  const grid = derivePaneGrid(view);
  const columns = grid.size === 0 ? 0 : (grid.values().next().value?.columns ?? 1);

  // Keep-alive registry surfaces stay mounted from their first showing. A ref
  // written during render, not state: the mount list must be right in the
  // SAME render that opens a pane, and the write is idempotent under StrictMode.
  const visitedRef = useRef<ContextSurfaceId[]>([]);
  for (const kind of view.panes) {
    const surfaceId = surfaceIdForPane(kind);
    if (surfaceId && !visitedRef.current.includes(surfaceId)) {
      visitedRef.current = [...visitedRef.current, surfaceId];
    }
  }

  const mounted = (kind: PaneKind): boolean => {
    if (view.panes.includes(kind)) return true;
    if (kind === 'terminal') return hasColumnTerminals;
    if (kind === 'editor') return editorOpen || fileIntentPending;
    const surfaceId = surfaceIdForPane(kind);
    return (
      surfaceId !== null &&
      SURFACE_VIEWS[surfaceId]?.mountPolicy === 'keep-alive' &&
      visitedRef.current.includes(surfaceId)
    );
  };

  const content = (kind: PaneKind, shown: boolean): ReactNode => {
    switch (kind) {
      case 'changes':
        return review ? (
          <SessionReviewPanel
            key={review.sessionId}
            sessionId={review.sessionId}
            entries={review.entries}
            branch={branch}
            onOpenDiff={() => actions.open('editor')}
            onOpenGit={() => actions.open('git')}
          />
        ) : null;
      case 'editor':
        return <GuardedEditorColumn />;
      case 'terminal':
        // dsh-rebase P1-11 (decisions 109, 126, 128): mounted while ANY
        // column shell runs — unmounting a shell ends it.
        return <TerminalColumn currentKey={terminalKey} visible={shown} />;
      case 'tasks':
        return sessionId ? <BackgroundTasksPane key={sessionId} sessionId={sessionId} /> : null;
      default: {
        const surfaceId = surfaceIdForPane(kind);
        const registration = surfaceId ? SURFACE_VIEWS[surfaceId] : undefined;
        if (!surfaceId || !registration) return null;
        const SurfaceView = registration.component;
        return <SurfaceView surfaceId={surfaceId} active={shown} onSearch={onSearch} />;
      }
    }
  };

  // ── split drags: CSS variables on the grid node, one commit on release ──
  const startSplitDrag = (
    event: ReactPointerEvent<HTMLDivElement>,
    axis: 'column' | 0 | 1
  ): void => {
    const box = gridRef.current;
    if (!box || event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    handle.dataset.dragging = '';
    const rect = box.getBoundingClientRect();
    const variable = axis === 'column' ? '--pane-col' : `--pane-row-${axis}`;
    let ratio = axis === 'column' ? splits.column : splits.rows[axis];
    const move = (moveEvent: PointerEvent) => {
      ratio =
        axis === 'column'
          ? clampSplitRatio(
              (moveEvent.clientX - rect.left) / rect.width,
              rect.width,
              PANE_MIN_WIDTH
            )
          : clampSplitRatio(
              (moveEvent.clientY - rect.top) / rect.height,
              rect.height,
              PANE_MIN_HEIGHT
            );
      box.style.setProperty(variable, String(ratio));
    };
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      delete handle.dataset.dragging;
      if (axis === 'column') actions.commitColumnSplit(ratio);
      else actions.commitRowSplit(axis, ratio);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  };

  const columnRows = (column: 0 | 1): number =>
    [...grid.values()].find((slot) => slot.column === column)?.rows ?? 0;

  return (
    <section
      ref={areaRef}
      aria-label={t('Panes')}
      aria-hidden={open ? undefined : true}
      inert={!open}
      data-pane-area={open ? view.panes.join(' ') : 'closed'}
      className={cn(
        'flex min-h-0 flex-col bg-surface-1 pt-0 pr-2 pb-2 pl-2',
        'transition-[width] duration-[250ms] group-data-[resizing]/shell:transition-none',
        !open && 'pointer-events-none invisible absolute inset-y-0 right-0',
        open && view.expanded && 'absolute inset-0 z-20',
        open && !view.expanded && 'relative min-w-0 shrink-0'
      )}
      style={
        !open
          ? { width: `${parkedWidth}px` }
          : view.expanded
            ? undefined
            : { width: 'var(--shell-editor-w)' }
      }
    >
      <div
        ref={gridRef}
        className="relative isolate min-h-0 flex-1"
        style={
          {
            '--pane-col': String(splits.column),
            '--pane-row-0': String(splits.rows[0]),
            '--pane-row-1': String(splits.rows[1]),
          } as CSSProperties
        }
      >
        {PANE_KINDS.filter(mounted).map((kind) => {
          const slot = grid.get(kind);
          const shown = open && slot !== undefined;
          return (
            <PaneCard
              key={kind}
              kind={kind}
              icon={PANE_ICONS[kind]}
              title={t(PANE_LABEL_KEYS[kind])}
              titleHidden={kind === 'changes'}
              shown={shown}
              slotStyle={slot ? paneSlotStyle(slot) : undefined}
              focused={view.focused === kind}
              expanded={view.expanded === kind}
              onFocus={actions.focus}
              onClose={actions.close}
              onToggleExpanded={actions.toggleExpanded}
            >
              {content(kind, shown)}
            </PaneCard>
          );
        })}

        {columns === 2 && (
          // biome-ignore lint/a11y/useFocusableInteractive: pointer-only split handle, like the shell's resize grips
          <div
            role="separator"
            aria-orientation="vertical"
            aria-valuenow={Math.round(splits.column * 100)}
            aria-label={t('Resize panes')}
            className={cn(SPLIT_HANDLE_CLASS, 'inset-y-0 w-2 cursor-col-resize')}
            style={{ left: 'calc(var(--pane-col) * 100% - 4px)' }}
            onPointerDown={(event) => startSplitDrag(event, 'column')}
          />
        )}
        {([0, 1] as const).map((column) =>
          columnRows(column) === 2 ? (
            // biome-ignore lint/a11y/useFocusableInteractive: pointer-only split handle, like the shell's resize grips
            <div
              key={column}
              role="separator"
              aria-orientation="horizontal"
              aria-valuenow={Math.round(splits.rows[column] * 100)}
              aria-label={t('Resize panes')}
              className={cn(SPLIT_HANDLE_CLASS, 'h-2 cursor-row-resize')}
              style={{
                top: `calc(var(--pane-row-${column}) * 100% - 4px)`,
                left: column === 0 ? '0' : 'calc(var(--pane-col) * 100% + 4px)',
                width:
                  columns === 1
                    ? '100%'
                    : column === 0
                      ? 'calc(var(--pane-col) * 100% - 4px)'
                      : 'calc((1 - var(--pane-col)) * 100% - 4px)',
              }}
              onPointerDown={(event) => startSplitDrag(event, column)}
            />
          ) : null
        )}
      </div>

      {open && !view.expanded && (
        <ShellResizeHandle
          side="left"
          ariaLabel={t('Resize panes')}
          width={resize.width}
          targetRef={areaRef as RefObject<HTMLElement | null>}
          clamp={resize.clamp}
          onCommit={resize.onCommit}
          onDragFrame={resize.onDragFrame}
          onResizingChange={resize.onResizingChange}
        />
      )}
    </section>
  );
}
