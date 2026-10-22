/**
 * T-22 (D19): pure layout model for the three-column shell.
 * Every hard size lives here; `docs/design-system.md` 「新壳布局档位」 mirrors it.
 * Pure so vitest (node env, `.ts` only) can cover it — `hostStatus.ts` pattern.
 */
import { type ContextSurfaceId, DEFAULT_SURFACE_ORDER } from './surfaceRegistry';
import {
  clampWorkPanelWidth,
  isWorkPanelTab,
  tabForIntent,
  WORK_PANEL_DEFAULT_WIDTH,
  type WorkPanelTab,
} from './workPanelModel';

// ── sizes (acceptance ①) ────────────────────────────────────────────────
/**
 * Layout 5a (ui-cohesion §6, ruling L1): the icon rail is gone. The left
 * column is the sidebar alone — the chat list — and it collapses entirely
 * (width 0), so these measure the sidebar and nothing else. 272 / 240 / 480
 * follow the reference's sidebar (preview `--side-w`).
 */
export const SIDEBAR_MIN_WIDTH = 240;
export const SIDEBAR_MAX_WIDTH = 480;
export const SIDEBAR_DEFAULT_WIDTH = 272;
/**
 * The retired rail's width. Profiles persisted before layout 5a stored the
 * sidebar width WITH the rail in it; migration subtracts this once.
 */
export const LEGACY_DOCK_RAIL_WIDTH = 44;
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

/** 240..480; NaN/Infinity/non-finite → SIDEBAR_DEFAULT_WIDTH; result is rounded. */
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
   * Every surface that has been on screen at least once this session (the
   * work panel tracks it; layout 5a dropped the persisted-restore seed — the
   * panel starts closed, so nothing is restored before first use).
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
 * the whole list). Unregistered ids are never mounted.
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

// ── Escape scope (S0, risk R1) ──────────────────────────────────────────
/**
 * Opt-out marker for the panel's capture-phase Escape. Any element inside a
 * surface that owns Escape itself — a terminal running vim/less, Monaco's find
 * widget or suggest popup, a surface-local dialog — carries this attribute so
 * the key reaches it instead of closing the panel.
 */
export const SURFACE_ESCAPE_HOLD_ATTR = 'data-surface-holds-escape';

/**
 * H/18 point-check fix — an open popup owns Escape, and this is how the panel
 * recognizes one.
 *
 * `SURFACE_ESCAPE_HOLD_ATTR` cannot cover this case: a Base UI popup is
 * PORTALED to `document.body`, so it is not in the event target's ancestor
 * chain — the keydown still targets whatever inside the panel opened it, the
 * panel's capture handler fires first and calls `stopPropagation`, and the
 * popup's own dismiss listener never sees the key. Measured in the real app on
 * 2026-09-10: with a sidebar context menu open, Escape collapsed the whole
 * panel AND left the menu on screen.
 *
 * Tooltips are excluded on purpose. They open on hover, so treating one as an
 * Escape owner would make the key stop working while the pointer merely rests
 * on a tab.
 */
export const ESCAPE_OWNING_POPUP_SELECTOR =
  '[data-slot$="-popup"]:not([data-slot="tooltip-popup"])';

export interface ShouldCloseOnEscapeInput {
  /** `KeyboardEvent.key`. */
  key: string;
  /** Panel open state; a closed panel has nothing to close. */
  isOpen: boolean;
  /** True when the event target sits inside a `[data-surface-holds-escape]` subtree. */
  holdsEscape: boolean;
  /**
   * True when a menu/dialog/popover is open anywhere on screen — see
   * {@link ESCAPE_OWNING_POPUP_SELECTOR}. Escape belongs to the innermost thing
   * that can be dismissed, and a popup is always innermost relative to the
   * panel that contains its trigger.
   */
  popupOpen?: boolean;
}

/**
 * False means BOTH: do not close, and do not `stopPropagation` — swallowing the
 * key without acting on it is what made Escape unusable inside a surface (F-c),
 * and later what left a context menu stranded on screen while the panel behind
 * it collapsed.
 */
export function shouldCloseOnEscape(input: ShouldCloseOnEscapeInput): boolean {
  return input.key === 'Escape' && input.isOpen && !input.holdsEscape && !input.popupOpen;
}

// ── persistence hygiene ─────────────────────────────────────────────────
/**
 * Layout 5a: what survives a restart. The work panel's OPEN state is not here
 * on purpose — ruling L3 opens it on demand, so every start begins closed; its
 * last tab and width are remembered.
 */
export interface PersistedShellLayout {
  sidebarWidth: number;
  /** The sidebar collapses entirely (Ctrl+B); there is no rail left behind. */
  sidebarCollapsed: boolean;
  workPanelTab: WorkPanelTab;
  workPanelWidth: number;
  readingWidthMode: ReadingWidthMode;
}

export const SHELL_LAYOUT_VERSION = 4;

export const defaultShellLayout: PersistedShellLayout = {
  sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
  sidebarCollapsed: false,
  workPanelTab: 'files',
  workPanelWidth: WORK_PANEL_DEFAULT_WIDTH,
  readingWidthMode: 'normal',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Re-clamps every field and drops anything unknown. Total: never throws. */
export function sanitizeShellLayoutPersisted(raw: unknown): PersistedShellLayout {
  if (!isRecord(raw)) {
    return { ...defaultShellLayout };
  }
  return {
    sidebarWidth: clampSidebarWidth(
      typeof raw.sidebarWidth === 'number' ? raw.sidebarWidth : Number.NaN
    ),
    sidebarCollapsed: raw.sidebarCollapsed === true,
    workPanelTab: isWorkPanelTab(raw.workPanelTab)
      ? raw.workPanelTab
      : defaultShellLayout.workPanelTab,
    workPanelWidth: clampWorkPanelWidth(
      typeof raw.workPanelWidth === 'number' ? raw.workPanelWidth : Number.NaN
    ),
    readingWidthMode: raw.readingWidthMode === 'wide' ? 'wide' : 'normal',
  };
}

/** A pre-5a `lastSurfaceId` that names a surface now living in the work panel. */
function legacyPanelTab(raw: unknown): WorkPanelTab | null {
  if (typeof raw !== 'string' || raw === 'chat') return null;
  return tabForIntent({ type: 'surface', surfaceId: raw as ContextSurfaceId });
}

/**
 * v3 (D08 dock) → v4 (layout 5a). The v3 shape was `{ sidebarWidth (rail
 * included), activeSurfaceId, lastSurfaceId, expanded, panelWidth, railOrder,
 * readingWidthMode, editorRatio }`; v1/v2 also carried `widthBySurface` and
 * `shellColumnMode`. Of those:
 *  - `sidebarWidth` loses the rail it included, then is clamped;
 *  - a v3 dock with no active surface WAS collapsed, so that carries over; v1
 *    and v2 profiles always showed the session list, so they open expanded;
 *  - a last surface that moved to the work panel becomes its last tab;
 *  - the rail order, the per-surface and panel widths, the expanded overlay
 *    and the editor ratio have no successor and are dropped. The old ratio
 *    cannot become a pixel width without the window width, so the panel
 *    starts at its default.
 */
export function migrateShellLayoutPersisted(raw: unknown, version: number): PersistedShellLayout {
  if (!isRecord(raw) || version >= SHELL_LAYOUT_VERSION) {
    return sanitizeShellLayoutPersisted(raw);
  }
  const legacyWidth =
    typeof raw.sidebarWidth === 'number' && Number.isFinite(raw.sidebarWidth)
      ? raw.sidebarWidth - LEGACY_DOCK_RAIL_WIDTH
      : Number.NaN;
  return sanitizeShellLayoutPersisted({
    sidebarWidth: legacyWidth,
    sidebarCollapsed: version >= 3 && raw.activeSurfaceId === null,
    workPanelTab: legacyPanelTab(raw.activeSurfaceId) ?? legacyPanelTab(raw.lastSurfaceId),
    readingWidthMode: raw.readingWidthMode,
  });
}
