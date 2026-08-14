/**
 * T-22 (D19): pure layout model for the three-column shell.
 * Every hard size lives here; `docs/design-system.md` 「新壳布局档位」 mirrors it.
 * Pure so vitest (node env, `.ts` only) can cover it — `hostStatus.ts` pattern.
 */
import { clampEditorRatio, DEFAULT_EDITOR_RATIO } from './centerLayoutModel';
import {
  type ContextSurfaceId,
  DEFAULT_SURFACE_ORDER,
  firstAlwaysSurfaceId,
  isContextSurfaceId,
  isRailSelectableSurface,
  sortSurfaces,
} from './surfaceRegistry';

// ── sizes (acceptance ①) ────────────────────────────────────────────────
// D34: the vertical rail retired (its four icons moved into MainHeader's top
// bar) — `RAIL_WIDTH` had exactly one consumer, `ContextPanelRail.tsx`, and
// dies with it. `centerLayoutModel.ts`'s `RAIL_RESERVE` is a SEPARATE
// constant (a width-budget reservation, not a rendered column) and is
// zeroed there rather than removed.
export const SIDEBAR_MIN_WIDTH = 280;
export const SIDEBAR_MAX_WIDTH = 500;
export const SIDEBAR_DEFAULT_WIDTH = 280;
export const SIDEBAR_COLLAPSED_WIDTH = 48; // = current `w-12`
// D34 (user ruling 2026-08-14): the hard floor drops 380 -> 250 so the panel
// can go narrower than a fixed 380px minimum. The DEFAULT stays 380 (A08's
// value, unchanged) — the two used to be the same number by coincidence, not
// by rule, and this round is what proves it: `CONTEXT_PANEL_DEFAULT_WIDTH` is
// what "no manual width yet" resolves to, `CONTEXT_PANEL_MIN_WIDTH` is the
// floor a drag can never cross.
export const CONTEXT_PANEL_MIN_WIDTH = 250;
export const CONTEXT_PANEL_DEFAULT_WIDTH = 380;
export const CONTEXT_PANEL_MAX_WIDTH = 1400;
/** Used before the first ResizeObserver measurement (reference component default). */
export const CONTEXT_PANEL_FALLBACK_WIDTH = 600;

export type ReadingWidthMode = 'normal' | 'wide';

// min(100%, 45rem) / min(100%, 60rem) — D25 §3.4 container tokens
// (--container-reading / --container-reading-wide in globals.css), no arbitrary values.
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
 * 250..1400, additionally capped by `availableWidth` when it is a positive
 * finite number. When the available width is below the 250 minimum the minimum
 * wins (D34 pins 250 as hard, demoted from acceptance ①'s original 380) — the
 * panel then overflows the row on purpose rather than silently violating the
 * floor. NaN/Infinity/non-finite `width` falls back to
 * `CONTEXT_PANEL_FALLBACK_WIDTH` before clamping, mirroring
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
  /** The single persisted panel width — user drag override, wins when present. */
  manualWidth?: number | null;
  /** Measured Main+Panel row width; null/0 = not measured yet. */
  availableWidth?: number | null;
  expanded?: boolean;
}

/**
 * 0 when closed; the full available width when expanded (px, never '100%');
 * otherwise clamp(manual ?? A08's 380 default).
 *
 * m-T32 (user round 1): the panel used to size itself from a PER-SURFACE
 * `defaultWidthFraction` (git 2/5, files 3/5, context 0.45 …) plus per-surface
 * drag memory, so every tab click resized the panel. A08 specifies one default
 * for all three tabs («panel 默认宽 git/files/context 380», a08:1550) and the
 * user's report is the same: switching tabs must not move the edge. Both the
 * fraction and the per-surface memory are gone; there is one panel width.
 *
 * D34: the fallback below is `CONTEXT_PANEL_DEFAULT_WIDTH`, not
 * `CONTEXT_PANEL_MIN_WIDTH` — the two used to be the same 380 by coincidence.
 * Now that the floor is 250, "no manual width yet" must still land on A08's
 * 380 default, not on the new, narrower floor.
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

  return clampContextPanelWidth(CONTEXT_PANEL_DEFAULT_WIDTH, measured);
}

/**
 * Round-10 GUI review ②: the ONE width budget the panel is measured against —
 * used by the render AND by the drag handle's clamp/commit.
 *
 * They used to disagree. The render already capped the docked panel at
 * `maxDockedWidth` (the content floor's leftovers), but the resize handle
 * clamped against the whole `availableWidth` row. So a drag could commit a
 * width the panel was never allowed to render at: the pointer pulled the edge
 * past the cap, the commit stored it, and the next render snapped the edge
 * back — while the oversized stored value walked the shell down the level
 * ladder (see `resolveShellChrome`'s `panelFootprint`) until the panel
 * vanished. One budget, both consumers, no disagreement possible.
 *
 * `expanded` deliberately keeps the full row: that state is an overlay meant
 * to cover chat and the editor, and capping it left a strip of reflowing chat
 * showing beside it (the m6 report).
 */
export interface ResolveDockedPanelBudgetInput {
  expanded: boolean;
  /** Measured Main+Panel row width. */
  availableWidth?: number | null;
  /** `maxPanelWidth(...)` — the largest width that still clears the content floor. */
  maxDockedWidth?: number | null;
}

export function resolveDockedPanelBudget(input: ResolveDockedPanelBudgetInput): number | null {
  const { expanded, availableWidth = null, maxDockedWidth = null } = input;
  if (expanded) {
    return availableWidth;
  }
  return maxDockedWidth ?? availableWidth;
}

/**
 * F-b invariant (S0). The outer panel animates its width to 0 on close, but
 * the content column inside it must never follow: xterm's `FitAddon` and
 * Monaco both re-measure from a ResizeObserver, and `useXterm` has no
 * zero-width guard — a 0px measurement is forwarded to the pty as `cols: 2`.
 * So the column keeps the last open width while closed and never drops below
 * CONTEXT_PANEL_MIN_WIDTH. Pure mirror of what `ContextPanel` computes per
 * render, so the floor is assertable without a DOM.
 */
export interface ResolveContentColumnWidthInput {
  /** Current outer panel width; 0 while closed and throughout the close transition. */
  width: number;
  /** Width the content column was last laid out at while the panel was open. */
  lastOpenWidth: number;
}

/** Always ≥ CONTEXT_PANEL_MIN_WIDTH, for every input including 0/negative/non-finite. */
export function resolveContentColumnWidth(input: ResolveContentColumnWidthInput): number {
  const { width, lastOpenWidth } = input;
  if (isFiniteNumber(width) && width > 0) {
    return Math.max(width, CONTEXT_PANEL_MIN_WIDTH);
  }
  if (isFiniteNumber(lastOpenWidth)) {
    return Math.max(lastOpenWidth, CONTEXT_PANEL_MIN_WIDTH);
  }
  return CONTEXT_PANEL_MIN_WIDTH;
}

// ── surface mounting (S0, T-12~15 shell prerequisite) ───────────────────
/**
 * Lifetime of a wired surface view, not its looks:
 * - 'active'     — mounted only while the panel shows this surface.
 * - 'keep-alive' — mounted from its first activation onwards, including while
 *                  another surface is shown and while the panel is closed.
 *                  For views owning state the renderer cannot rebuild (T-15's
 *                  pty). Hidden layers stay in the layout box; see
 *                  `ContextPanel` for why `display: none` is banned.
 */
export type SurfaceMountPolicy = 'active' | 'keep-alive';

/** Structural view of a `SURFACE_VIEWS` entry — keeps this module React-free. */
export interface SurfaceMountRegistration {
  mountPolicy: SurfaceMountPolicy;
}

export interface DeriveMountedSurfaceIdsInput {
  /**
   * Every surface that has been `activeSurfaceId` at least once — either this
   * session, or (for a keep-alive surface) seeded from a persisted
   * `lastSurfaceId` before the very first render, see `seedVisitedSurfaceIds`.
   */
  visited: readonly ContextSurfaceId[];
  /** null = panel closed. */
  activeSurfaceId: ContextSurfaceId | null;
  /**
   * Shown while the panel is closed so an 'active' view survives a close/open
   * toggle (batch-3 correction, `ContextPanel.tsx`). Only ever names a surface
   * that has already been active, so 'keep-alive' is covered by `visited`.
   */
  lastSurfaceId?: ContextSurfaceId | null;
  /** Only surfaces with a view registered in `SURFACE_VIEWS` can mount at all. */
  registrations: Partial<Record<ContextSurfaceId, SurfaceMountRegistration>>;
}

/**
 * The surfaces whose views must exist in the DOM right now, in registry order
 * (deterministic, so callers get a stable React key order and tests can assert
 * the whole list). Unregistered ids are never mounted — an unwired surface
 * shows `SurfacePlaceholder` instead.
 */
export function deriveMountedSurfaceIds(input: DeriveMountedSurfaceIdsInput): ContextSurfaceId[] {
  const { visited, activeSurfaceId, lastSurfaceId = null, registrations } = input;
  const contentSurfaceId = activeSurfaceId ?? lastSurfaceId;
  const visitedSet = new Set(visited);

  const mounted: ContextSurfaceId[] = [];
  for (const id of DEFAULT_SURFACE_ORDER) {
    const registration = registrations[id];
    if (!registration) {
      continue;
    }
    const shouldMount =
      registration.mountPolicy === 'keep-alive'
        ? visitedSet.has(id) || id === activeSurfaceId
        : id === contentSurfaceId;
    if (shouldMount) {
      mounted.push(id);
    }
  }
  return mounted;
}

/**
 * m14 fix: the seed for `ContextPanel`'s `visitedSurfaceIdsRef` on its very
 * first render. That ref otherwise only grows via a render-time write gated
 * on `activeSurfaceId` being truthy — which never runs on a persisted
 * `{activeSurfaceId: null, lastSurfaceId: 'terminal'}` restore, since the
 * panel opens CLOSED on that first render. Without this seed, `visited` stays
 * empty, `deriveMountedSurfaceIds` never mounts the keep-alive `lastSurfaceId`
 * surface, and the panel shows a header naming it with an empty body (neither
 * the mount stack nor the `SurfacePlaceholder` fallback render, because a
 * registered `contentSurfaceId` skips the placeholder branch).
 *
 * Only seeds a KEEP-ALIVE `lastSurfaceId`: an 'active'-policy surface never
 * needed this (it is only ever mounted while it IS `contentSurfaceId`, which
 * `deriveMountedSurfaceIds` already derives from `activeSurfaceId ??
 * lastSurfaceId` with no `visited` dependency).
 */
export function seedVisitedSurfaceIds(
  lastSurfaceId: ContextSurfaceId | null,
  registrations: Partial<Record<ContextSurfaceId, SurfaceMountRegistration>>
): ContextSurfaceId[] {
  if (lastSurfaceId && registrations[lastSurfaceId]?.mountPolicy === 'keep-alive') {
    return [lastSurfaceId];
  }
  return [];
}

// ── Escape scope (S0, risk R1) ──────────────────────────────────────────
/**
 * Opt-out marker for the panel's capture-phase Escape. Any element inside a
 * surface that owns Escape itself — a terminal running vim/less, Monaco's find
 * widget or suggest popup, a surface-local dialog — carries this attribute so
 * the key reaches it instead of closing the panel.
 */
export const SURFACE_ESCAPE_HOLD_ATTR = 'data-surface-holds-escape';

export interface ShouldCloseOnEscapeInput {
  /** `KeyboardEvent.key`. */
  key: string;
  /** Panel open state; a closed panel has nothing to close. */
  isOpen: boolean;
  /** True when the event target sits inside a `[data-surface-holds-escape]` subtree. */
  holdsEscape: boolean;
}

/**
 * False means BOTH: do not close, and do not `stopPropagation` — swallowing the
 * key without acting on it is what made Escape unusable inside a surface (F-c).
 */
export function shouldCloseOnEscape(input: ShouldCloseOnEscapeInput): boolean {
  return input.key === 'Escape' && input.isOpen && !input.holdsEscape;
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
  /** One width for the panel (T-32 m1): tab switches must not move the edge. */
  panelWidth: number | null;
  railOrder: ContextSurfaceId[];
  readingWidthMode: ReadingWidthMode;
  /** T-32: share of the center row given to the editor when a file is open. */
  editorRatio: number;
}

export const defaultShellLayout: PersistedShellLayout = {
  sidebarCollapsed: false,
  sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
  activeSurfaceId: null,
  lastSurfaceId: null,
  expanded: false,
  panelWidth: null,
  railOrder: [...DEFAULT_SURFACE_ORDER],
  readingWidthMode: 'normal',
  editorRatio: DEFAULT_EDITOR_RATIO,
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

function sanitizePanelWidth(raw: unknown): number | null {
  // No `availableWidth` here: the window size is unknown at persistence time.
  return isFiniteNumber(raw) ? clampContextPanelWidth(raw) : null;
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
    panelWidth: sanitizePanelWidth(raw.panelWidth),
    railOrder: sanitizeRailOrder(raw.railOrder),
    readingWidthMode: raw.readingWidthMode === 'wide' ? 'wide' : 'normal',
    editorRatio: clampEditorRatio(
      typeof raw.editorRatio === 'number' ? raw.editorRatio : Number.NaN
    ),
  };
}
