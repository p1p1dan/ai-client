/**
 * T-22 (D19): the context surface registry — 11 surfaces mirroring openchamber
 * `lib/surfaces/registry.ts` @a3519141. This round lands five
 * (chat/editor/git/terminal/context); the other six are registry slots only.
 *
 * Pure so vitest (node env, `.ts` only) can cover it — same pattern as
 * `sidebarTree.ts` / `hostStatus.ts`. Icons are string names here; the mapping
 * to lucide components lives in `ContextPanelRail.tsx`.
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
  | 'browser'
  | 'preview'
  | 'chat';

/** 'always' can be opened empty from the rail; 'has-content' stays hidden until content exists. */
export type SurfaceAvailability = 'always' | 'has-content';

export type SurfaceIconName =
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
  /** Fraction of the measured Main+Panel row used until the user resizes this surface. */
  defaultWidthFraction: number;
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

// Order doubles as the default rail order (decision 10): context, git, editor,
// terminal are this round's rail-visible four; the rest are registry-only or
// content-driven until their task lands.
export const CONTEXT_SURFACES: readonly ContextSurfaceDescriptor[] = [
  {
    id: 'context',
    icon: 'gauge',
    labelKey: 'Context',
    descriptionKey: 'Session context and runtime',
    availability: 'always',
    defaultWidthFraction: 0.45,
    registeredOnly: false,
    pendingTask: null,
  },
  {
    id: 'git',
    icon: 'git-branch',
    labelKey: 'Git',
    descriptionKey: 'Working tree changes',
    availability: 'always',
    defaultWidthFraction: 2 / 5,
    registeredOnly: false,
    pendingTask: null,
  },
  {
    id: 'editor',
    icon: 'file-code',
    labelKey: 'Editor',
    descriptionKey: 'Browse and edit workspace files',
    availability: 'always',
    defaultWidthFraction: 3 / 5,
    registeredOnly: false,
    pendingTask: null,
  },
  {
    id: 'terminal',
    icon: 'square-terminal',
    labelKey: 'Terminal',
    descriptionKey: 'Workspace terminal',
    availability: 'always',
    defaultWidthFraction: 3 / 5,
    registeredOnly: false,
    pendingTask: null,
  },
  {
    id: 'chat',
    icon: 'message-square',
    labelKey: 'Chat',
    descriptionKey: 'Split chat sessions',
    availability: 'has-content',
    defaultWidthFraction: 0.45,
    registeredOnly: false,
    pendingTask: '后置（多标签）',
  },
  {
    id: 'pr',
    icon: 'git-pull-request',
    labelKey: 'Pull Request',
    descriptionKey: 'Review a pull request',
    availability: 'always',
    defaultWidthFraction: 0.45,
    registeredOnly: true,
    pendingTask: '后置',
  },
  {
    id: 'diff',
    icon: 'arrow-left-right',
    labelKey: 'Diff',
    descriptionKey: 'Compare file changes',
    availability: 'always',
    defaultWidthFraction: 3 / 5,
    registeredOnly: true,
    pendingTask: '后置',
  },
  {
    id: 'plan',
    icon: 'file-text',
    labelKey: 'Plan',
    descriptionKey: 'Session task plan',
    availability: 'always',
    defaultWidthFraction: 0.45,
    registeredOnly: true,
    pendingTask: '后置',
  },
  {
    id: 'notes',
    icon: 'sticky-note',
    labelKey: 'Notes',
    descriptionKey: 'Session notes',
    availability: 'always',
    defaultWidthFraction: 1 / 3,
    registeredOnly: true,
    pendingTask: '后置',
  },
  {
    id: 'browser',
    icon: 'globe',
    labelKey: 'Browser',
    descriptionKey: 'In-app browser',
    availability: 'always',
    defaultWidthFraction: 0.45,
    registeredOnly: true,
    pendingTask: '后置',
  },
  {
    id: 'preview',
    icon: 'app-window',
    labelKey: 'Preview',
    descriptionKey: 'Live app preview',
    availability: 'has-content',
    defaultWidthFraction: 0.45,
    registeredOnly: true,
    pendingTask: '后置',
  },
];

export const DEFAULT_SURFACE_ORDER: readonly ContextSurfaceId[] = CONTEXT_SURFACES.map(
  (surface) => surface.id
);

const SURFACE_BY_ID = new Map(CONTEXT_SURFACES.map((surface) => [surface.id, surface] as const));

/** Registry fraction fallback when a surface is unknown (mirrors reference fallback). */
const FALLBACK_WIDTH_FRACTION = 0.5;

export function isContextSurfaceId(value: unknown): value is ContextSurfaceId {
  return typeof value === 'string' && SURFACE_BY_ID.has(value as ContextSurfaceId);
}

export function getSurface(id: ContextSurfaceId): ContextSurfaceDescriptor | undefined {
  return SURFACE_BY_ID.get(id);
}

/** Registry fraction, 0.5 for anything unknown (mirrors reference fallback). */
export function getSurfaceWidthFraction(id: ContextSurfaceId | null | undefined): number {
  if (id == null) {
    return FALLBACK_WIDTH_FRACTION;
  }
  return getSurface(id)?.defaultWidthFraction ?? FALLBACK_WIDTH_FRACTION;
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

/** Fallback target for "open the panel" when nothing was open before (decision 4). */
export function firstAlwaysSurfaceId(options: RailSurfacesOptions = {}): ContextSurfaceId {
  const visible = railSurfaces(DEFAULT_SURFACE_ORDER, options);
  return visible[0]?.id ?? 'context';
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
