/**
 * T-22 (D19): the context surface registry — 11 surfaces mirroring openchamber
 * `lib/surfaces/registry.ts` @a3519141. Five are wired
 * (editor/git/terminal/context/run); the rest are registry slots only.
 *
 * Pure so vitest (node env, `.ts` only) can cover it — same pattern as
 * `sidebarTree.ts` / `hostStatus.ts`. Icons are string names here; layout 5a
 * retired their last renderers (the rail and `SurfacePlaceholder`, with the
 * `surfaceIcons.ts` lookup) — the work panel's tabs are text, as in the
 * reference. The names stay as descriptor data.
 */
import type { GitStatus } from '@shared/types/git';

export type ContextSurfaceId =
  | 'editor'
  | 'git'
  | 'pr'
  | 'diff'
  | 'terminal'
  | 'plan'
  | 'notes'
  | 'context'
  | 'run'
  | 'browser'
  | 'preview';

/** 'always' can be opened empty; 'has-content' stays hidden until content exists. */
export type SurfaceAvailability = 'always' | 'has-content';

/**
 * D08 (2026-09-05): `ShellColumnMode` and its four helpers are GONE.
 *
 * The two/three-column switch existed to answer "is there a right panel". Under
 * D08 the surfaces below live in the LEFT dock and the right column only ever
 * holds files, so the question has no second answer left: the dock is always
 * there, and the right column appears when a file is open. Deleting the mode
 * removes `columnModeHasPanel`, `isSurfaceAvailableInColumnMode`,
 * `DEFAULT_SHELL_COLUMN_MODE` and `reduceColumnModeChange` along with it.
 */
export type SurfaceIconName =
  | 'activity'
  | 'file-code'
  | 'git-branch'
  | 'git-pull-request'
  | 'arrow-left-right'
  | 'square-terminal'
  | 'file-text'
  | 'sticky-note'
  | 'gauge'
  | 'globe'
  | 'app-window';

export interface ContextSurfaceDescriptor {
  id: ContextSurfaceId;
  icon: SurfaceIconName;
  /** English source string = i18n key (see src/shared/i18n.ts). */
  labelKey: string;
  descriptionKey: string;
  availability: SurfaceAvailability;
  /**
   * MVP scope gate: true = registry slot only, never offered as a work panel
   * tab. The task that lands the surface flips this to false.
   */
  registeredOnly: boolean;
  /**
   * A06 honesty: the task that will supply real content. Non-null means the
   * panel body must render an explicit "not wired yet" empty state naming it.
   * Set to null by the task that wires the surface.
   */
  pendingTask: string | null;
}

// Registry order: `deriveMountedSurfaceIds` mounts in this order, so React
// keys stay stable. Layout 5a (ruling L1) retired the rail and the dock's
// `chat` slot: the sidebar is the chat list itself, and git / files / context /
// run are work panel tabs (`workPanelModel.ts` owns their strip order and
// their Ctrl/Cmd+digit mapping).
export const CONTEXT_SURFACES: readonly ContextSurfaceDescriptor[] = [
  {
    id: 'git',
    icon: 'git-branch',
    labelKey: 'Git',
    descriptionKey: 'Working tree changes',
    availability: 'always',
    registeredOnly: false,
    pendingTask: null,
  },
  {
    // T-32: the id stays `editor` while the surface now means "Files" (the
    // tree only — the editor itself moved to the center column, D27/#28 ①).
    // Renaming it to `files` would be cosmetically right and practically
    // wrong: pre-5a profiles persisted it in `aiclient-shell-layout`, and the
    // v4 migration maps it to the work panel's `files` tab through
    // `tabForIntent`. The panel names the tab; this id stays internal.
    id: 'editor',
    icon: 'file-code',
    labelKey: 'Files',
    descriptionKey: 'Browse workspace files',
    availability: 'always',
    registeredOnly: false,
    pendingTask: null,
  },
  {
    id: 'context',
    icon: 'gauge',
    labelKey: 'Context',
    descriptionKey: 'Session context and runtime',
    availability: 'always',
    registeredOnly: false,
    pendingTask: null,
  },
  {
    // U06-a: the conversation's RUN state — status, model, thinking level, turn
    // clock, tools.
    id: 'run',
    icon: 'activity',
    labelKey: 'Run',
    descriptionKey: 'Live turn status',
    availability: 'always',
    registeredOnly: false,
    pendingTask: null,
  },
  {
    // 2026-09-04: taken off the rail at the user's request; the shell terminal
    // users open is the work panel's column terminal. S05 preserves one
    // non-navigation use: an explicitly enabled repository init script opens
    // this surface through `openInitializationTerminal` after worktree
    // creation succeeds — the work panel's `setup` tab.
    id: 'terminal',
    icon: 'square-terminal',
    labelKey: 'Terminal',
    descriptionKey: 'Workspace terminal',
    availability: 'always',
    registeredOnly: true,
    pendingTask: null,
  },
  {
    id: 'pr',
    icon: 'git-pull-request',
    labelKey: 'Pull Request',
    descriptionKey: 'Review a pull request',
    availability: 'always',
    registeredOnly: true,
    pendingTask: 'Deferred',
  },
  {
    id: 'diff',
    icon: 'arrow-left-right',
    labelKey: 'Diff',
    descriptionKey: 'Compare file changes',
    availability: 'always',
    registeredOnly: true,
    pendingTask: 'Deferred',
  },
  {
    id: 'plan',
    icon: 'file-text',
    labelKey: 'Plan',
    descriptionKey: 'Session task plan',
    availability: 'always',
    registeredOnly: true,
    pendingTask: 'Deferred',
  },
  {
    id: 'notes',
    icon: 'sticky-note',
    labelKey: 'Notes',
    descriptionKey: 'Session notes',
    availability: 'always',
    registeredOnly: true,
    pendingTask: 'Deferred',
  },
  {
    id: 'browser',
    icon: 'globe',
    labelKey: 'Browser',
    descriptionKey: 'In-app browser',
    availability: 'always',
    registeredOnly: true,
    pendingTask: 'Deferred',
  },
  {
    id: 'preview',
    icon: 'app-window',
    labelKey: 'Preview',
    descriptionKey: 'Live app preview',
    availability: 'has-content',
    registeredOnly: true,
    pendingTask: 'Deferred',
  },
];

export const DEFAULT_SURFACE_ORDER: readonly ContextSurfaceId[] = CONTEXT_SURFACES.map(
  (surface) => surface.id
);

const SURFACE_BY_ID = new Map(CONTEXT_SURFACES.map((surface) => [surface.id, surface] as const));

export function isContextSurfaceId(value: unknown): value is ContextSurfaceId {
  return typeof value === 'string' && SURFACE_BY_ID.has(value as ContextSurfaceId);
}

export function getSurface(id: ContextSurfaceId): ContextSurfaceDescriptor | undefined {
  return SURFACE_BY_ID.get(id);
}

/** Unique changed paths across staged/modified/deleted/untracked/conflicted. */
export function countChangedFiles(status: GitStatus | null | undefined): number {
  if (!status) {
    return 0;
  }
  const paths = new Set<string>([
    ...status.staged,
    ...status.modified,
    ...status.deleted,
    ...status.untracked,
    ...status.conflicted,
  ]);
  return paths.size;
}

/** Acceptance ④: only `git`, only when the working tree has changes (its panel tab's dot). */
export function shouldShowActivityDot(
  id: ContextSurfaceId,
  input: { changedFilesCount: number }
): boolean {
  return id === 'git' && input.changedFilesCount > 0;
}
