/**
 * T-22 (D19): pure layout model for the three-column shell.
 * Every hard size lives here; `docs/design-system.md` 「新壳布局档位」 mirrors it.
 * Pure so vitest (node env, `.ts` only) can cover it — `hostStatus.ts` pattern.
 */
import {
  type ContextSurfaceId,
  DEFAULT_SURFACE_ORDER,
  firstAlwaysSurfaceId,
  getSurfaceWidthFraction,
  isContextSurfaceId,
  isRailSelectableSurface,
  sortSurfaces,
} from './surfaceRegistry';

// ── sizes (acceptance ①) ────────────────────────────────────────────────
export const RAIL_WIDTH = 44;
export const SIDEBAR_MIN_WIDTH = 280;
export const SIDEBAR_MAX_WIDTH = 500;
export const SIDEBAR_DEFAULT_WIDTH = 280;
export const SIDEBAR_COLLAPSED_WIDTH = 48; // = current `w-12`
export const CONTEXT_PANEL_MIN_WIDTH = 380;
export const CONTEXT_PANEL_MAX_WIDTH = 1400;
/** Used before the first ResizeObserver measurement (reference component default). */
export const CONTEXT_PANEL_FALLBACK_WIDTH = 600;

export type ReadingWidthMode = 'normal' | 'wide';

// min(100%, 45rem) / min(100%, 60rem) via the --container-reading{,-wide}
// tokens (globals.css) — no arbitrary values. 45rem = 48 CJK chars/line at
// 15px, the DPR-calibrated Cursor reference (D25 §3.4); the old max-w-3xl
// (48rem) ran ~51 chars/line, wider than the reference rhythm.
export const READING_COLUMN_CLASS: Record<ReadingWidthMode, string> = {
  normal: 'max-w-reading',
  wide: 'max-w-reading-wide',
};

export function readingColumnClass(mode: ReadingWidthMode | undefined | null): string {
  return mode === 'wide' ? READING_COLUMN_CLASS.wide : READING_COLUMN_CLASS.normal;
}

export function nextReadingWidthMode(mode: ReadingWidthMode | undefined | null): ReadingWidthMode {
  return mode === 'wide' ? 'normal' : 'wide';
}

// ── clamps ──────────────────────────────────────────────────────────────
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** 280..500; NaN/Infinity/non-finite → SIDEBAR_DEFAULT_WIDTH; result is rounded. */
export function clampSidebarWidth(width: number): number {
  if (!isFiniteNumber(width)) {
    return SIDEBAR_DEFAULT_WIDTH;
  }
  return Math.round(clamp(width, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH));
}

/**
 * 380..1400, additionally capped by `availableWidth` when it is a positive
 * finite number. When the available width is below the 380 minimum the minimum
 * wins (acceptance ① pins 380 as hard) — the panel then overflows the row on
 * purpose rather than silently violating the floor. NaN/Infinity/non-finite
 * `width` falls back to `CONTEXT_PANEL_FALLBACK_WIDTH` before clamping, mirroring
 * `clampSidebarWidth`'s non-finite guard.
 */
export function clampContextPanelWidth(width: number, availableWidth?: number | null): number {
  if (!isFiniteNumber(width)) {
    return clampContextPanelWidth(CONTEXT_PANEL_FALLBACK_WIDTH, availableWidth);
  }
  let max = CONTEXT_PANEL_MAX_WIDTH;
  if (isFiniteNumber(availableWidth) && availableWidth > 0) {
    max = Math.min(max, availableWidth);
  }
  if (max < CONTEXT_PANEL_MIN_WIDTH) {
    max = CONTEXT_PANEL_MIN_WIDTH;
  }
  return clamp(width, CONTEXT_PANEL_MIN_WIDTH, max);
}

function measuredWidth(availableWidth: number | null | undefined): number | null {
  return isFiniteNumber(availableWidth) && availableWidth > 0 ? availableWidth : null;
}

// ── width resolution (decision 9) ───────────────────────────────────────
export interface ResolveContextPanelWidthInput {
  /** null = panel closed. */
  surfaceId: ContextSurfaceId | null;
  /** widthBySurface[surfaceId] — user drag override, wins whenever present. */
  manualWidth?: number | null;
  /** Measured Main+Panel row width; null/0 = not measured yet. */
  availableWidth?: number | null;
  expanded?: boolean;
}

/**
 * 0 when closed; the full available width when expanded (px, never '100%');
 * otherwise clamp(manual ?? round(fraction × available ?? FALLBACK)).
 */
export function resolveContextPanelWidth(input: ResolveContextPanelWidthInput): number {
  const { surfaceId, manualWidth, availableWidth, expanded } = input;
  if (surfaceId === null) {
    return 0;
  }

  const measured = measuredWidth(availableWidth);
  if (expanded && measured !== null) {
    return measured;
  }

  if (isFiniteNumber(manualWidth)) {
    return clampContextPanelWidth(manualWidth, measured);
  }

  const fraction = getSurfaceWidthFraction(surfaceId);
  const base = measured !== null ? measured * fraction : CONTEXT_PANEL_FALLBACK_WIDTH;
  return clampContextPanelWidth(Math.round(base), measured);
}

// ── surface state machine (decision 2) ──────────────────────────────────
export interface ShellSurfaceState {
  /** null = panel closed. */
  activeSurfaceId: ContextSurfaceId | null;
  /** Survives close so the header toggle can restore the user's last surface. */
  lastSurfaceId: ContextSurfaceId | null;
  expanded: boolean;
}

export const initialShellSurfaceState: ShellSurfaceState = {
  activeSurfaceId: null,
  lastSurfaceId: null,
  expanded: false,
};

export type ShellSurfaceAction =
  | { type: 'select'; surfaceId: ContextSurfaceId } // rail click
  | { type: 'open'; surfaceId?: ContextSurfaceId } // header toggle on / T-12~15 entry
  | { type: 'close' }
  | { type: 'toggle-panel' } // header PanelRight button
  | { type: 'toggle-expanded' };

/** Opens `id`, keeping expanded as-is. Reused by `select`'s non-toggle branch and by `open`. */
function openSurface(prev: ShellSurfaceState, id: ContextSurfaceId): ShellSurfaceState {
  return { activeSurfaceId: id, lastSurfaceId: id, expanded: prev.expanded };
}

function closePanel(prev: ShellSurfaceState): ShellSurfaceState {
  return {
    activeSurfaceId: null,
    lastSurfaceId: prev.activeSurfaceId ?? prev.lastSurfaceId,
    expanded: false,
  };
}

function bareOpenTarget(prev: ShellSurfaceState): ContextSurfaceId {
  return prev.activeSurfaceId ?? prev.lastSurfaceId ?? firstAlwaysSurfaceId();
}

function applySelect(prev: ShellSurfaceState, id: ContextSurfaceId): ShellSurfaceState {
  if (!isRailSelectableSurface(id)) {
    return prev;
  }
  if (id === prev.activeSurfaceId) {
    // Toggle-off; also exits the expanded overlay so a re-open never restores a stale overlay.
    return { activeSurfaceId: null, lastSurfaceId: id, expanded: false };
  }
  return openSurface(prev, id);
}

function applyOpen(prev: ShellSurfaceState, id: ContextSurfaceId | undefined): ShellSurfaceState {
  if (id === undefined) {
    // Explicit open never no-ops (decision 4 correction): fall back through
    // the last surface, then the first always-available rail surface.
    return openSurface(prev, bareOpenTarget(prev));
  }
  if (!isRailSelectableSurface(id)) {
    return prev;
  }
  // Explicit open is always an open, never a toggle-off — unlike `select`.
  return openSurface(prev, id);
}

export function reduceShellSurface(
  prev: ShellSurfaceState,
  action: ShellSurfaceAction
): ShellSurfaceState {
  switch (action.type) {
    case 'select':
      return applySelect(prev, action.surfaceId);
    case 'open':
      return applyOpen(prev, action.surfaceId);
    case 'close':
      return closePanel(prev);
    case 'toggle-panel':
      return prev.activeSurfaceId !== null ? closePanel(prev) : applyOpen(prev, undefined);
    case 'toggle-expanded':
      return prev.activeSurfaceId === null ? prev : { ...prev, expanded: !prev.expanded };
    default:
      return prev;
  }
}

// ── persistence hygiene ─────────────────────────────────────────────────
export interface PersistedShellLayout {
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  activeSurfaceId: ContextSurfaceId | null;
  lastSurfaceId: ContextSurfaceId | null;
  expanded: boolean;
  widthBySurface: Partial<Record<ContextSurfaceId, number>>;
  railOrder: ContextSurfaceId[];
  readingWidthMode: ReadingWidthMode;
}

export const defaultShellLayout: PersistedShellLayout = {
  sidebarCollapsed: false,
  sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
  activeSurfaceId: null,
  lastSurfaceId: null,
  expanded: false,
  widthBySurface: {},
  railOrder: [...DEFAULT_SURFACE_ORDER],
  readingWidthMode: 'normal',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Illegal or not rail-selectable this round → null (never trusts a stale persisted id). */
function sanitizeSurfaceIdOrNull(value: unknown): ContextSurfaceId | null {
  if (!isContextSurfaceId(value) || !isRailSelectableSurface(value)) {
    return null;
  }
  return value;
}

function sanitizeWidthBySurface(raw: unknown): Partial<Record<ContextSurfaceId, number>> {
  if (!isRecord(raw)) {
    return {};
  }
  const result: Partial<Record<ContextSurfaceId, number>> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!isContextSurfaceId(key) || !isFiniteNumber(value)) {
      continue;
    }
    // No `availableWidth` here: the window size is unknown at persistence time.
    result[key] = clampContextPanelWidth(value);
  }
  return result;
}

function sanitizeRailOrder(raw: unknown): ContextSurfaceId[] {
  const order = Array.isArray(raw) ? raw : [];
  return sortSurfaces(order as readonly string[]).map((surface) => surface.id);
}

/** Re-clamps and drops anything the registry no longer knows. Total: never throws. */
export function sanitizeShellLayoutPersisted(raw: unknown): PersistedShellLayout {
  if (!isRecord(raw)) {
    return { ...defaultShellLayout };
  }

  const activeSurfaceId = sanitizeSurfaceIdOrNull(raw.activeSurfaceId);

  return {
    sidebarCollapsed: raw.sidebarCollapsed === true,
    sidebarWidth: clampSidebarWidth(
      typeof raw.sidebarWidth === 'number' ? raw.sidebarWidth : Number.NaN
    ),
    activeSurfaceId,
    lastSurfaceId: sanitizeSurfaceIdOrNull(raw.lastSurfaceId),
    // Only meaningful while a surface is active — otherwise the overlay would be orphaned.
    expanded: raw.expanded === true && activeSurfaceId !== null,
    widthBySurface: sanitizeWidthBySurface(raw.widthBySurface),
    railOrder: sanitizeRailOrder(raw.railOrder),
    readingWidthMode: raw.readingWidthMode === 'wide' ? 'wide' : 'normal',
  };
}
