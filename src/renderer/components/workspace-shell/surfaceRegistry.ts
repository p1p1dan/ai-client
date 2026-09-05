/**
 * T-22 (D19): the context surface registry — 11 surfaces mirroring openchamber
 * `lib/surfaces/registry.ts` @a3519141. This round lands five
 * (chat/editor/git/terminal/context); the other six are registry slots only.
 *
 * Pure so vitest (node env, `.ts` only) can cover it — same pattern as
 * `sidebarTree.ts` / `hostStatus.ts`. Icons are string names here; the mapping
 * to lucide components lives in `surfaceIcons.ts` (D34: split out of the
 * retired `ContextPanelRail.tsx`, whose four icons moved into MainHeader).
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
  | 'preview'
  | 'chat';

/** 'always' can be opened empty from the rail; 'has-content' stays hidden until content exists. */
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
  | 'app-window'
  | 'message-square';

export interface ContextSurfaceDescriptor {
  id: ContextSurfaceId;
  icon: SurfaceIconName;
  /** English source string = i18n key (see src/shared/i18n.ts). */
  labelKey: string;
  descriptionKey: string;
  availability: SurfaceAvailability;
  /**
   * MVP scope gate: true = registry slot only, never rendered on the rail this
   * round. The task that lands the surface flips this to false.
   */
  registeredOnly: boolean;
  /**
   * A06 honesty: the task that will supply real content. Non-null means the
   * panel body must render an explicit "not wired yet" empty state naming it.
   * Set to null by the task that wires the surface.
   */
  pendingTask: string | null;
}

// Order doubles as the panel tab order AND the rail order (decision 10).
// D08 (2026-09-05) puts `chat` FIRST: the left dock's first entry is the
// session list, matching the prototype's rail order
// `聊天 · Git · 文件 · 上下文 · 运行`.
// NOTE: this order is also what `Ctrl/Cmd+1..4` maps to (shellShortcuts.ts
// derives the digits from `railSurfaces(DEFAULT_SURFACE_ORDER).slice(0, 4)`),
// so reordering here silently rebinds those shortcuts — which is exactly what
// D08 intends (digit 1 is now the session list).
export const CONTEXT_SURFACES: readonly ContextSurfaceDescriptor[] = [
  {
    // D08: the id is REUSED, its meaning is not. It used to mean "split chat
    // sessions (deferred)"; it now means the session list that used to be the
    // whole left sidebar. Reusing it avoids both a store migration for a new id
    // and a dead id left behind in persisted `railOrder` / `lastSurfaceId`.
    id: 'chat',
    icon: 'message-square',
    labelKey: 'Chat',
    descriptionKey: 'Sessions and repositories',
    availability: 'always',
    registeredOnly: false,
    pendingTask: null,
  },
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
    // wrong: this id is already persisted in `aiclient-shell-layout` under
    // `widthBySurface` / `lastSurfaceId` / `railOrder`, so the rename costs a
    // store migration and a version bump and buys nothing but the name.
    // If you came here to "fix" the mismatch, that is the reason not to.
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
    // clock, tools. Placed right after `context` so the rail digit it takes is
    // Ctrl/Cmd+4 (the slot the terminal vacated) and the first three do not
    // move; a profile with a persisted `railOrder` gets it appended by
    // `sortSurfaces`, which lands it in the same visible position.
    id: 'run',
    icon: 'activity',
    labelKey: 'Run',
    descriptionKey: 'Live turn status',
    availability: 'always',
    registeredOnly: false,
    pendingTask: null,
  },
  {
    // 2026-09-04: taken off the rail at the user's request. The surface itself
    // still exists (`surfaceViews.tsx` keeps `TerminalSurfaceView`, and a
    // persisted `lastSurfaceId: 'terminal'` still resolves through
    // `getSurface`), it simply has no entry point any more — no header button,
    // no Ctrl/Cmd+`, no rail digit. `registeredOnly` is the registry's own way
    // of saying "not offered on the rail this round"; it is what every guard
    // in `shellLayoutModel.ts` already reads, so one flag closes every door at
    // once rather than leaving a shortcut that silently does nothing.
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
    pendingTask: '后置',
  },
  {
    id: 'diff',
    icon: 'arrow-left-right',
    labelKey: 'Diff',
    descriptionKey: 'Compare file changes',
    availability: 'always',
    registeredOnly: true,
    pendingTask: '后置',
  },
  {
    id: 'plan',
    icon: 'file-text',
    labelKey: 'Plan',
    descriptionKey: 'Session task plan',
    availability: 'always',
    registeredOnly: true,
    pendingTask: '后置',
  },
  {
    id: 'notes',
    icon: 'sticky-note',
    labelKey: 'Notes',
    descriptionKey: 'Session notes',
    availability: 'always',
    registeredOnly: true,
    pendingTask: '后置',
  },
  {
    id: 'browser',
    icon: 'globe',
    labelKey: 'Browser',
    descriptionKey: 'In-app browser',
    availability: 'always',
    registeredOnly: true,
    pendingTask: '后置',
  },
  {
    id: 'preview',
    icon: 'app-window',
    labelKey: 'Preview',
    descriptionKey: 'Live app preview',
    availability: 'has-content',
    registeredOnly: true,
    pendingTask: '后置',
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

/** Applies a persisted reorder: unknown/dup ids dropped, missing ids appended in default order. */
export function sortSurfaces(order: readonly string[]): ContextSurfaceDescriptor[] {
  const seen = new Set<ContextSurfaceId>();
  const result: ContextSurfaceDescriptor[] = [];

  for (const raw of order) {
    if (!isContextSurfaceId(raw) || seen.has(raw)) {
      continue;
    }
    const surface = getSurface(raw);
    if (!surface) {
      continue;
    }
    seen.add(raw);
    result.push(surface);
  }

  for (const id of DEFAULT_SURFACE_ORDER) {
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    // Every id in DEFAULT_SURFACE_ORDER resolves — it is derived from CONTEXT_SURFACES itself.
    result.push(getSurface(id) as ContextSurfaceDescriptor);
  }

  return result;
}

export interface RailSurfacesOptions {
  /** MVP: always false. T-12~T-15 pass a real predicate when content-driven surfaces land. */
  hasContent?: (id: ContextSurfaceId) => boolean;
}

/** True when the rail may select this surface today (used as a reducer guard). */
export function isRailSelectableSurface(
  id: ContextSurfaceId,
  options: RailSurfacesOptions = {}
): boolean {
  const surface = getSurface(id);
  if (!surface || surface.registeredOnly) {
    return false;
  }
  if (surface.availability === 'has-content') {
    return options.hasContent?.(id) ?? false;
  }
  return true;
}

/** Rail-visible subset, in `order`: drops registeredOnly, drops has-content without content. */
export function railSurfaces(
  order: readonly string[],
  options: RailSurfacesOptions = {}
): ContextSurfaceDescriptor[] {
  return sortSurfaces(order).filter((surface) => isRailSelectableSurface(surface.id, options));
}

/**
 * Fallback target for "open the dock" when nothing was open before (decision 4).
 * D08 moves the safety net from `context` to `chat`: the dock's first entry is
 * the session list, and an empty registry must not resolve to a surface that is
 * no longer first.
 */
export function firstAlwaysSurfaceId(options: RailSurfacesOptions = {}): ContextSurfaceId {
  const visible = railSurfaces(DEFAULT_SURFACE_ORDER, options);
  return visible[0]?.id ?? 'chat';
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

/** Acceptance ④: only `git`, only when the working tree has changes. */
export function shouldShowActivityDot(
  id: ContextSurfaceId,
  input: { changedFilesCount: number }
): boolean {
  return id === 'git' && input.changedFilesCount > 0;
}
