import { describe, expect, it } from 'vitest';
import {
  CONTEXT_PANEL_FALLBACK_WIDTH,
  clampContextPanelWidth,
  clampSidebarWidth,
  defaultShellLayout,
  initialShellSurfaceState,
  nextReadingWidthMode,
  READING_COLUMN_CLASS,
  type ReadingWidthMode,
  readingColumnClass,
  reduceShellSurface,
  resolveContextPanelWidth,
  type ShellSurfaceState,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  sanitizeShellLayoutPersisted,
} from '../shellLayoutModel';
import { type ContextSurfaceId, DEFAULT_SURFACE_ORDER, sortSurfaces } from '../surfaceRegistry';

describe('clampSidebarWidth', () => {
  it('raises a width below 280 to the minimum', () => {
    expect(clampSidebarWidth(100)).toBe(SIDEBAR_MIN_WIDTH);
  });

  it('lowers a width above 500 to the maximum', () => {
    expect(clampSidebarWidth(600)).toBe(SIDEBAR_MAX_WIDTH);
  });

  it('rounds fractional widths', () => {
    expect(clampSidebarWidth(300.6)).toBe(301);
  });

  it('falls back to the 280 default for NaN and Infinity', () => {
    expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(clampSidebarWidth(Number.POSITIVE_INFINITY)).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(clampSidebarWidth(Number.NEGATIVE_INFINITY)).toBe(SIDEBAR_DEFAULT_WIDTH);
  });
});

describe('clampContextPanelWidth', () => {
  it('clamps into 380..1400', () => {
    expect(clampContextPanelWidth(100)).toBe(380);
    expect(clampContextPanelWidth(2000)).toBe(1400);
  });

  it('caps at the measured available width when it is narrower than 1400', () => {
    expect(clampContextPanelWidth(1000, 600)).toBe(600);
  });

  it('keeps the 380 minimum even when the available width is smaller', () => {
    expect(clampContextPanelWidth(500, 200)).toBe(380);
  });

  it('ignores a null / zero / negative available width', () => {
    expect(clampContextPanelWidth(500, null)).toBe(500);
    expect(clampContextPanelWidth(500, 0)).toBe(500);
    expect(clampContextPanelWidth(500, -10)).toBe(500);
  });

  it('falls back to the 600 fallback width for NaN and Infinity before clamping', () => {
    expect(clampContextPanelWidth(Number.NaN)).toBe(CONTEXT_PANEL_FALLBACK_WIDTH);
    expect(clampContextPanelWidth(Number.POSITIVE_INFINITY)).toBe(CONTEXT_PANEL_FALLBACK_WIDTH);
    expect(clampContextPanelWidth(Number.NEGATIVE_INFINITY)).toBe(CONTEXT_PANEL_FALLBACK_WIDTH);
  });

  it('caps the NaN fallback at a narrower available width', () => {
    expect(clampContextPanelWidth(Number.NaN, 500)).toBe(500);
  });
});

describe('resolveContextPanelWidth', () => {
  it('returns 0 when no surface is active', () => {
    expect(resolveContextPanelWidth({ surfaceId: null })).toBe(0);
  });

  it('uses the manual width whenever the surface has one', () => {
    expect(
      resolveContextPanelWidth({ surfaceId: 'git', manualWidth: 500, availableWidth: 1000 })
    ).toBe(500);
  });

  it('uses fraction x available width when there is no manual width', () => {
    // git fraction = 2/5, available = 1000 -> 400
    expect(resolveContextPanelWidth({ surfaceId: 'git', availableWidth: 1000 })).toBe(400);
  });

  it('raises a fraction result below 380 to the minimum', () => {
    // git fraction = 2/5, available = 500 -> 200, raised to the 380 floor
    expect(resolveContextPanelWidth({ surfaceId: 'git', availableWidth: 500 })).toBe(380);
  });

  it('lowers a fraction result above 1400 to the maximum', () => {
    // editor fraction = 3/5, available = 3000 -> 1800, lowered to the 1400 ceiling
    expect(resolveContextPanelWidth({ surfaceId: 'editor', availableWidth: 3000 })).toBe(1400);
  });

  it('falls back to 600 before the first measurement', () => {
    expect(resolveContextPanelWidth({ surfaceId: 'git' })).toBe(CONTEXT_PANEL_FALLBACK_WIDTH);
  });

  it('keeps a manual width recorded at another window size (no re-proportioning)', () => {
    const atFirstSize = resolveContextPanelWidth({
      surfaceId: 'git',
      manualWidth: 700,
      availableWidth: 900,
    });
    const atOtherSize = resolveContextPanelWidth({
      surfaceId: 'git',
      manualWidth: 700,
      availableWidth: 2000,
    });
    expect(atFirstSize).toBe(700);
    expect(atOtherSize).toBe(700);
  });

  it('returns the full available width when expanded', () => {
    expect(
      resolveContextPanelWidth({ surfaceId: 'git', availableWidth: 900, expanded: true })
    ).toBe(900);
  });

  it('falls back to the docked width when expanded before the first measurement', () => {
    expect(resolveContextPanelWidth({ surfaceId: 'git', expanded: true })).toBe(
      CONTEXT_PANEL_FALLBACK_WIDTH
    );
    expect(resolveContextPanelWidth({ surfaceId: 'git', manualWidth: 500, expanded: true })).toBe(
      500
    );
  });
});

describe('reduceShellSurface', () => {
  it('opens a surface from the closed state', () => {
    const result = reduceShellSurface(initialShellSurfaceState, {
      type: 'select',
      surfaceId: 'git',
    });
    expect(result).toEqual({ activeSurfaceId: 'git', lastSurfaceId: 'git', expanded: false });
  });

  it('switches to another surface without closing the panel', () => {
    const opened = reduceShellSurface(initialShellSurfaceState, {
      type: 'select',
      surfaceId: 'git',
    });
    const switched = reduceShellSurface(opened, { type: 'select', surfaceId: 'editor' });
    expect(switched).toEqual({
      activeSurfaceId: 'editor',
      lastSurfaceId: 'editor',
      expanded: false,
    });
  });

  it('closes the panel when the active surface is selected again', () => {
    const opened = reduceShellSurface(initialShellSurfaceState, {
      type: 'select',
      surfaceId: 'git',
    });
    const closed = reduceShellSurface(opened, { type: 'select', surfaceId: 'git' });
    expect(closed).toEqual({ activeSurfaceId: null, lastSurfaceId: 'git', expanded: false });
  });

  it('remembers the closed surface as lastSurfaceId', () => {
    const opened = reduceShellSurface(initialShellSurfaceState, {
      type: 'select',
      surfaceId: 'terminal',
    });
    const closed = reduceShellSurface(opened, { type: 'close' });
    expect(closed.activeSurfaceId).toBeNull();
    expect(closed.lastSurfaceId).toBe('terminal');
  });

  it('ignores a select for an unknown surface id', () => {
    const result = reduceShellSurface(initialShellSurfaceState, {
      type: 'select',
      surfaceId: 'bogus' as ContextSurfaceId,
    });
    expect(result).toBe(initialShellSurfaceState);
  });

  it('ignores a select for a surface that is not rail-visible this round', () => {
    expect(reduceShellSurface(initialShellSurfaceState, { type: 'select', surfaceId: 'pr' })).toBe(
      initialShellSurfaceState
    );
    expect(
      reduceShellSurface(initialShellSurfaceState, { type: 'select', surfaceId: 'chat' })
    ).toBe(initialShellSurfaceState);
  });

  it('restores lastSurfaceId on a bare open', () => {
    const prev: ShellSurfaceState = {
      activeSurfaceId: null,
      lastSurfaceId: 'git',
      expanded: false,
    };
    const result = reduceShellSurface(prev, { type: 'open' });
    expect(result).toEqual({ activeSurfaceId: 'git', lastSurfaceId: 'git', expanded: false });
  });

  it('opens the first always-surface when there is no lastSurfaceId', () => {
    const result = reduceShellSurface(initialShellSurfaceState, { type: 'open' });
    expect(result.activeSurfaceId).toBe('context');
  });

  it('opens the requested surface when open carries an explicit id', () => {
    const result = reduceShellSurface(initialShellSurfaceState, {
      type: 'open',
      surfaceId: 'editor',
    });
    expect(result).toEqual({
      activeSurfaceId: 'editor',
      lastSurfaceId: 'editor',
      expanded: false,
    });
  });

  it('never toggles off on an explicit open of the active surface', () => {
    const opened = reduceShellSurface(initialShellSurfaceState, {
      type: 'select',
      surfaceId: 'git',
    });
    const reopened = reduceShellSurface(opened, { type: 'open', surfaceId: 'git' });
    expect(reopened).toEqual({ activeSurfaceId: 'git', lastSurfaceId: 'git', expanded: false });
  });

  it('closes an open panel via toggle-panel', () => {
    const opened = reduceShellSurface(initialShellSurfaceState, {
      type: 'select',
      surfaceId: 'git',
    });
    const closed = reduceShellSurface(opened, { type: 'toggle-panel' });
    expect(closed).toEqual({ activeSurfaceId: null, lastSurfaceId: 'git', expanded: false });
  });

  it('opens via toggle-panel with the fallback surface when nothing was open', () => {
    const result = reduceShellSurface(initialShellSurfaceState, { type: 'toggle-panel' });
    expect(result.activeSurfaceId).toBe('context');
  });

  it('drops expanded when the panel closes', () => {
    const opened = reduceShellSurface(initialShellSurfaceState, {
      type: 'select',
      surfaceId: 'git',
    });
    const expanded = reduceShellSurface(opened, { type: 'toggle-expanded' });
    expect(expanded.expanded).toBe(true);
    const closed = reduceShellSurface(expanded, { type: 'close' });
    expect(closed.expanded).toBe(false);
  });

  it('drops expanded when toggling off the active surface', () => {
    const opened = reduceShellSurface(initialShellSurfaceState, {
      type: 'select',
      surfaceId: 'git',
    });
    const expanded = reduceShellSurface(opened, { type: 'toggle-expanded' });
    const toggledOff = reduceShellSurface(expanded, { type: 'select', surfaceId: 'git' });
    expect(toggledOff).toEqual({ activeSurfaceId: null, lastSurfaceId: 'git', expanded: false });
  });

  it('keeps expanded while switching between surfaces', () => {
    const opened = reduceShellSurface(initialShellSurfaceState, {
      type: 'select',
      surfaceId: 'git',
    });
    const expanded = reduceShellSurface(opened, { type: 'toggle-expanded' });
    const switched = reduceShellSurface(expanded, { type: 'select', surfaceId: 'editor' });
    expect(switched).toEqual({
      activeSurfaceId: 'editor',
      lastSurfaceId: 'editor',
      expanded: true,
    });
  });

  it('toggles expanded while the panel is open', () => {
    const opened = reduceShellSurface(initialShellSurfaceState, {
      type: 'select',
      surfaceId: 'git',
    });
    const expanded = reduceShellSurface(opened, { type: 'toggle-expanded' });
    expect(expanded.expanded).toBe(true);
    const collapsed = reduceShellSurface(expanded, { type: 'toggle-expanded' });
    expect(collapsed.expanded).toBe(false);
  });

  it('ignores toggle-expanded while the panel is closed', () => {
    const result = reduceShellSurface(initialShellSurfaceState, { type: 'toggle-expanded' });
    expect(result).toBe(initialShellSurfaceState);
  });

  it('returns the previous state object for every ignored action', () => {
    const prev = initialShellSurfaceState;
    expect(
      reduceShellSurface(prev, { type: 'select', surfaceId: 'bogus' as ContextSurfaceId })
    ).toBe(prev);
    expect(reduceShellSurface(prev, { type: 'open', surfaceId: 'pr' })).toBe(prev);
    expect(reduceShellSurface(prev, { type: 'toggle-expanded' })).toBe(prev);
  });
});

describe('readingColumnClass', () => {
  // D25 A4: 45rem = 48 CJK chars/line at 15px — the DPR-calibrated Cursor
  // reference measurement. The value lives in the --container-reading token
  // (globals.css), not an arbitrary max-w-[45rem].
  it('maps normal to max-w-reading (45rem via --container-reading)', () => {
    expect(readingColumnClass('normal')).toBe('max-w-reading');
    expect(READING_COLUMN_CLASS.normal).toBe('max-w-reading');
  });

  it('maps wide to max-w-reading-wide (60rem via --container-reading-wide)', () => {
    expect(readingColumnClass('wide')).toBe('max-w-reading-wide');
    expect(READING_COLUMN_CLASS.wide).toBe('max-w-reading-wide');
  });

  it('falls back to normal for undefined / null / garbage', () => {
    expect(readingColumnClass(undefined)).toBe('max-w-reading');
    expect(readingColumnClass(null)).toBe('max-w-reading');
    expect(readingColumnClass('huge' as ReadingWidthMode)).toBe('max-w-reading');
  });
});

describe('nextReadingWidthMode', () => {
  it('flips normal to wide and wide back to normal', () => {
    expect(nextReadingWidthMode('normal')).toBe('wide');
    expect(nextReadingWidthMode('wide')).toBe('normal');
  });
});

describe('sanitizeShellLayoutPersisted', () => {
  it('returns defaults for null, a string and an array', () => {
    expect(sanitizeShellLayoutPersisted(null)).toEqual(defaultShellLayout);
    expect(sanitizeShellLayoutPersisted('nope')).toEqual(defaultShellLayout);
    expect(sanitizeShellLayoutPersisted([1, 2, 3])).toEqual(defaultShellLayout);
  });

  it('clamps a persisted sidebar width outside 280..500', () => {
    expect(sanitizeShellLayoutPersisted({ sidebarWidth: 50 }).sidebarWidth).toBe(280);
    expect(sanitizeShellLayoutPersisted({ sidebarWidth: 9000 }).sidebarWidth).toBe(500);
  });

  it('drops an activeSurfaceId the registry no longer knows', () => {
    expect(sanitizeShellLayoutPersisted({ activeSurfaceId: 'bogus' }).activeSurfaceId).toBeNull();
  });

  it('drops an activeSurfaceId that is registry-only this round', () => {
    expect(sanitizeShellLayoutPersisted({ activeSurfaceId: 'pr' }).activeSurfaceId).toBeNull();
  });

  it('drops manual widths for unknown surfaces and clamps the rest', () => {
    const result = sanitizeShellLayoutPersisted({
      widthBySurface: { bogus: 500, git: 50, editor: 9999 },
    });
    expect(result.widthBySurface).toEqual({ git: 380, editor: 1400 });
  });

  it('rebuilds a corrupted rail order from the registry', () => {
    const result = sanitizeShellLayoutPersisted({ railOrder: ['bogus', 'git', 'git'] });
    expect(result.railOrder).toEqual(sortSurfaces(['bogus', 'git', 'git']).map((s) => s.id));
    expect(result.railOrder).toHaveLength(DEFAULT_SURFACE_ORDER.length);
  });

  it('keeps a persisted closed panel closed', () => {
    const result = sanitizeShellLayoutPersisted({ activeSurfaceId: null, lastSurfaceId: 'git' });
    expect(result.activeSurfaceId).toBeNull();
  });

  it('forces expanded to false when nothing is open', () => {
    const result = sanitizeShellLayoutPersisted({ expanded: true });
    expect(result.activeSurfaceId).toBeNull();
    expect(result.expanded).toBe(false);
  });

  it('normalises an unknown reading width mode to normal', () => {
    expect(sanitizeShellLayoutPersisted({ readingWidthMode: 'huge' }).readingWidthMode).toBe(
      'normal'
    );
    expect(sanitizeShellLayoutPersisted({ readingWidthMode: 'wide' }).readingWidthMode).toBe(
      'wide'
    );
  });
});
