import { describe, expect, it } from 'vitest';
import {
  CONTEXT_PANEL_DEFAULT_WIDTH,
  CONTEXT_PANEL_FALLBACK_WIDTH,
  CONTEXT_PANEL_MIN_WIDTH,
  clampContextPanelWidth,
  clampSidebarWidth,
  type DeriveMountedSurfaceIdsInput,
  defaultShellLayout,
  deriveMountedSurfaceIds,
  LEGACY_DOCK_RAIL_WIDTH,
  migrateShellLayoutPersisted,
  nextReadingWidthMode,
  READING_COLUMN_CLASS,
  type ReadingWidthMode,
  readingColumnClass,
  resolveContentColumnWidth,
  resolveContextPanelWidth,
  resolveDockedPanelBudget,
  SHELL_LAYOUT_VERSION,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SURFACE_ESCAPE_HOLD_ATTR,
  sanitizeShellLayoutPersisted,
  shouldCloseOnEscape,
} from '../shellLayoutModel';
import type { ContextSurfaceId } from '../surfaceRegistry';
import { PANE_AREA_DEFAULT_WIDTH, paneAreaMinWidth } from '../workPanelModel';

describe('clampSidebarWidth (design system v2 / layout 5a: the sidebar alone, no rail)', () => {
  it('pins 272 / 240 / 480', () => {
    expect([SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH]).toEqual([272, 240, 480]);
  });

  it('raises a width below 240 to the minimum', () => {
    expect(clampSidebarWidth(100)).toBe(SIDEBAR_MIN_WIDTH);
  });

  it('lowers a width above 480 to the maximum', () => {
    expect(clampSidebarWidth(600)).toBe(SIDEBAR_MAX_WIDTH);
  });

  it('rounds fractional widths', () => {
    expect(clampSidebarWidth(300.6)).toBe(301);
  });

  it('falls back to the 272 default for NaN and Infinity', () => {
    expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(clampSidebarWidth(Number.POSITIVE_INFINITY)).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(clampSidebarWidth(Number.NEGATIVE_INFINITY)).toBe(SIDEBAR_DEFAULT_WIDTH);
  });
});

describe('clampContextPanelWidth', () => {
  it('clamps into 250..1400 (D34: floor demoted from 380)', () => {
    expect(clampContextPanelWidth(100)).toBe(CONTEXT_PANEL_MIN_WIDTH);
    expect(clampContextPanelWidth(2000)).toBe(1400);
  });

  it('pins the literal 250 floor (D34) — not merely self-referential against the constant', () => {
    // Every other assertion in this file compares against the imported
    // `CONTEXT_PANEL_MIN_WIDTH`, so a regression that silently reverted the
    // constant's VALUE (380 was both the old floor and the still-current
    // default — a mutation back to 380 would slip past a purely symbolic
    // check). This hardcodes the number D34 actually pinned.
    expect(CONTEXT_PANEL_MIN_WIDTH).toBe(250);
    expect(clampContextPanelWidth(100)).toBe(250);
  });

  it('caps at the measured available width when it is narrower than 1400', () => {
    expect(clampContextPanelWidth(1000, 600)).toBe(600);
  });

  it('keeps the 250 minimum even when the available width is smaller', () => {
    expect(clampContextPanelWidth(500, 200)).toBe(CONTEXT_PANEL_MIN_WIDTH);
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

  it('is the SAME default width for every surface (T-32 m1)', () => {
    // Was a per-surface fraction (git 2/5 -> 400, editor 3/5 -> 600 …), which
    // made every tab click resize the panel — the user reported it as a bug and
    // A08 gives all tabs one 380 default (a08:1550). Switching tabs must not
    // move the edge, at any window size.
    for (const availableWidth of [500, 1000, 3000]) {
      const widths = (['git', 'editor', 'context', 'terminal'] as const).map((surfaceId) =>
        resolveContextPanelWidth({ surfaceId, availableWidth })
      );
      expect(new Set(widths).size).toBe(1);
      expect(widths[0]).toBe(CONTEXT_PANEL_DEFAULT_WIDTH);
    }
  });

  it('uses the same 380 default before the first measurement', () => {
    expect(resolveContextPanelWidth({ surfaceId: 'git' })).toBe(CONTEXT_PANEL_DEFAULT_WIDTH);
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

  it('falls back to the docked DEFAULT width when expanded before the first measurement', () => {
    // D34: the floor (250) and the default (380) diverged — this fallback is
    // "no manual width yet", which must still land on the default, not the
    // (now narrower) floor.
    expect(resolveContextPanelWidth({ surfaceId: 'git', expanded: true })).toBe(
      CONTEXT_PANEL_DEFAULT_WIDTH
    );
    expect(resolveContextPanelWidth({ surfaceId: 'git', manualWidth: 500, expanded: true })).toBe(
      500
    );
  });
});

describe('readingColumnClass', () => {
  it('maps normal to max-w-reading (45rem, D25 §3.4)', () => {
    expect(readingColumnClass('normal')).toBe('max-w-reading');
    expect(READING_COLUMN_CLASS.normal).toBe('max-w-reading');
  });

  it('maps wide to max-w-reading-wide (60rem, D25 §3.4)', () => {
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

describe('sanitizeShellLayoutPersisted (design system v2 / layout 5a)', () => {
  it('returns defaults for null, a string and an array', () => {
    expect(sanitizeShellLayoutPersisted(null)).toEqual(defaultShellLayout);
    expect(sanitizeShellLayoutPersisted('nope')).toEqual(defaultShellLayout);
    expect(sanitizeShellLayoutPersisted([1, 2, 3])).toEqual(defaultShellLayout);
  });

  it('defaults to an expanded 272px sidebar and the pane area`s 496 / 864 widths (layout 5d)', () => {
    expect(defaultShellLayout).toEqual({
      sidebarWidth: 272,
      sidebarCollapsed: false,
      paneAreaWidth: PANE_AREA_DEFAULT_WIDTH[1],
      paneAreaSplitWidth: PANE_AREA_DEFAULT_WIDTH[2],
      paneSplits: { column: 0.5, rows: [0.5, 0.5] },
      readingWidthMode: 'normal',
    });
  });

  it('never persists which panes are open (ruling L3: none on every start)', () => {
    const keys = Object.keys(sanitizeShellLayoutPersisted({ panes: ['git'], workPanelOpen: true }));
    expect(keys).not.toContain('panes');
    expect(keys).not.toContain('workPanelOpen');
  });

  it('clamps a persisted sidebar width outside the sidebar range', () => {
    expect(sanitizeShellLayoutPersisted({ sidebarWidth: 50 }).sidebarWidth).toBe(SIDEBAR_MIN_WIDTH);
    expect(sanitizeShellLayoutPersisted({ sidebarWidth: 9000 }).sidebarWidth).toBe(
      SIDEBAR_MAX_WIDTH
    );
  });

  it('keeps only a literal true as collapsed', () => {
    expect(sanitizeShellLayoutPersisted({ sidebarCollapsed: true }).sidebarCollapsed).toBe(true);
    expect(sanitizeShellLayoutPersisted({ sidebarCollapsed: 'yes' }).sidebarCollapsed).toBe(false);
  });

  it('clamps the pane area widths per column count and sanitizes the splits', () => {
    expect(sanitizeShellLayoutPersisted({ paneAreaWidth: 50 }).paneAreaWidth).toBe(
      paneAreaMinWidth(1)
    );
    expect(sanitizeShellLayoutPersisted({ paneAreaSplitWidth: 50 }).paneAreaSplitWidth).toBe(
      paneAreaMinWidth(2)
    );
    expect(sanitizeShellLayoutPersisted({ paneAreaWidth: 'x' }).paneAreaWidth).toBe(
      PANE_AREA_DEFAULT_WIDTH[1]
    );
    expect(
      sanitizeShellLayoutPersisted({ paneSplits: { column: 0.7, rows: [0.4] } }).paneSplits
    ).toEqual({ column: 0.7, rows: [0.4, 0.5] });
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

describe('migrateShellLayoutPersisted (v1–v3 → v5, layouts 5a and 5d)', () => {
  /** A real v3 profile: D08 dock open on git, a rail order, a ratio. */
  const v3 = {
    sidebarWidth: 380,
    activeSurfaceId: 'git',
    lastSurfaceId: 'git',
    expanded: true,
    panelWidth: 700,
    railOrder: ['chat', 'git', 'editor', 'context', 'run'],
    readingWidthMode: 'wide',
    editorRatio: 0.6,
  };

  it('is the current version', () => {
    expect(SHELL_LAYOUT_VERSION).toBe(5);
  });

  it('subtracts the retired rail from the sidebar width, then clamps', () => {
    expect(LEGACY_DOCK_RAIL_WIDTH).toBe(44);
    expect(migrateShellLayoutPersisted(v3, 3).sidebarWidth).toBe(380 - 44);
    // The old 324 default (280 panel + rail) lands on the panel it measured.
    expect(migrateShellLayoutPersisted({ ...v3, sidebarWidth: 324 }, 3).sidebarWidth).toBe(280);
    // The old 544 maximum is wider than the new 480 one.
    expect(migrateShellLayoutPersisted({ ...v3, sidebarWidth: 544 }, 3).sidebarWidth).toBe(480);
    expect(migrateShellLayoutPersisted({ ...v3, sidebarWidth: 'x' }, 3).sidebarWidth).toBe(
      SIDEBAR_DEFAULT_WIDTH
    );
  });

  it('drops the last surface: panes start closed (layout 5d)', () => {
    expect(Object.keys(migrateShellLayoutPersisted(v3, 3))).not.toContain('workPanelTab');
  });

  it('a v3 dock with nothing active was collapsed, and stays so', () => {
    expect(migrateShellLayoutPersisted({ ...v3, activeSurfaceId: null }, 3).sidebarCollapsed).toBe(
      true
    );
    expect(migrateShellLayoutPersisted(v3, 3).sidebarCollapsed).toBe(false);
    // v1/v2 always showed the session list.
    expect(migrateShellLayoutPersisted({ ...v3, activeSurfaceId: null }, 2).sidebarCollapsed).toBe(
      false
    );
  });

  it('drops the rail order, the widths and the ratio without leaking them', () => {
    const migrated = migrateShellLayoutPersisted(
      { ...v3, widthBySurface: { git: 500 }, shellColumnMode: 'three-column' },
      1
    );
    expect(Object.keys(migrated).sort()).toEqual(Object.keys(defaultShellLayout).sort());
    expect(migrated.paneAreaWidth).toBe(PANE_AREA_DEFAULT_WIDTH[1]);
    expect(migrated.readingWidthMode).toBe('wide');
  });

  it('never throws on garbage', () => {
    for (const raw of [null, undefined, 'x', 42, [], { sidebarWidth: Number.NaN }]) {
      expect(() => migrateShellLayoutPersisted(raw, 0)).not.toThrow();
    }
    expect(migrateShellLayoutPersisted(null, 3)).toEqual(defaultShellLayout);
  });

  it('only sanitises a profile that is already v5', () => {
    const v5 = { ...defaultShellLayout, sidebarWidth: 300, paneAreaSplitWidth: 900 };
    expect(migrateShellLayoutPersisted(v5, 5)).toEqual(v5);
  });
});

describe('migrateShellLayoutPersisted (v4 → v5, layout 5d)', () => {
  /** A real v4 profile: the 5a work panel dragged to 640, last on git. */
  const v4 = {
    sidebarWidth: 300,
    sidebarCollapsed: true,
    workPanelTab: 'git',
    workPanelWidth: 640,
    readingWidthMode: 'wide',
  };

  it('keeps the sidebar and the reading width as they were', () => {
    const migrated = migrateShellLayoutPersisted(v4, 4);
    expect(migrated.sidebarWidth).toBe(300);
    expect(migrated.sidebarCollapsed).toBe(true);
    expect(migrated.readingWidthMode).toBe('wide');
  });

  it('the panel width becomes the one-column pane area width; two columns start at the default', () => {
    const migrated = migrateShellLayoutPersisted(v4, 4);
    expect(migrated.paneAreaWidth).toBe(640);
    expect(migrated.paneAreaSplitWidth).toBe(PANE_AREA_DEFAULT_WIDTH[2]);
    expect(migrated.paneSplits).toEqual({ column: 0.5, rows: [0.5, 0.5] });
    // A 5a width under the new floor is lifted to it.
    expect(migrateShellLayoutPersisted({ ...v4, workPanelWidth: 320 }, 4).paneAreaWidth).toBe(
      paneAreaMinWidth(1)
    );
  });

  it('drops the old keys without leaking them', () => {
    const migrated = migrateShellLayoutPersisted(v4, 4);
    expect(Object.keys(migrated).sort()).toEqual(Object.keys(defaultShellLayout).sort());
  });
});

describe('resolveContentColumnWidth', () => {
  it('uses the panel width while open', () => {
    expect(resolveContentColumnWidth({ width: 600, lastOpenWidth: 380 })).toBe(600);
  });

  it('keeps the last open width through the close transition and while closed', () => {
    expect(resolveContentColumnWidth({ width: 0, lastOpenWidth: 900 })).toBe(900);
  });

  it('never returns below the CONTEXT_PANEL_MIN_WIDTH floor — F-b, whatever the outer panel animates to', () => {
    const inputs = [0, -1, 12, 379, 380, 1400, Number.NaN, Number.POSITIVE_INFINITY];
    for (const width of inputs) {
      for (const lastOpenWidth of inputs) {
        expect(resolveContentColumnWidth({ width, lastOpenWidth })).toBeGreaterThanOrEqual(
          CONTEXT_PANEL_MIN_WIDTH
        );
      }
    }
  });

  it('replays the open→close render sequence without ever dropping to 0', () => {
    // Mirrors ContextPanel: the ref is only written while the panel is open.
    let lastOpenWidth = CONTEXT_PANEL_MIN_WIDTH;
    const widths: number[] = [];
    for (const width of [0, 720, 720, 0, 0]) {
      const content = resolveContentColumnWidth({ width, lastOpenWidth });
      if (width > 0) {
        lastOpenWidth = content;
      }
      widths.push(content);
    }
    // D34: the seed is CONTEXT_PANEL_MIN_WIDTH (now 250, was 380) — this floor
    // is F-b's protection, not the panel's default width.
    expect(widths).toEqual([CONTEXT_PANEL_MIN_WIDTH, 720, 720, 720, 720]);
  });
});

// ── deriveMountedSurfaceIds (S0) ────────────────────────────────────────
const MOUNT_REGISTRATIONS: DeriveMountedSurfaceIdsInput['registrations'] = {
  context: { mountPolicy: 'active' },
  git: { mountPolicy: 'active' },
  terminal: { mountPolicy: 'keep-alive' },
  // `editor` is deliberately absent: an unwired surface must never mount.
};

/** Replays a sequence of active surfaces the way ContextPanel accumulates state. */
function replayMounts(
  steps: readonly (ContextSurfaceId | null)[],
  registrations = MOUNT_REGISTRATIONS
): ContextSurfaceId[][] {
  const visited: ContextSurfaceId[] = [];
  let lastSurfaceId: ContextSurfaceId | null = null;
  return steps.map((activeSurfaceId) => {
    if (activeSurfaceId) {
      if (!visited.includes(activeSurfaceId)) {
        visited.push(activeSurfaceId);
      }
      lastSurfaceId = activeSurfaceId;
    }
    return deriveMountedSurfaceIds({ visited, activeSurfaceId, lastSurfaceId, registrations });
  });
}

describe('deriveMountedSurfaceIds', () => {
  it('mounts nothing before any surface has been opened', () => {
    expect(
      deriveMountedSurfaceIds({
        visited: [],
        activeSurfaceId: null,
        lastSurfaceId: null,
        registrations: MOUNT_REGISTRATIONS,
      })
    ).toEqual([]);
  });

  it('mounts an active-policy view only while it is the active surface', () => {
    const [openGit, openContext] = replayMounts(['git', 'context']);
    expect(openGit).toEqual(['git']);
    expect(openContext).toEqual(['context']);
  });

  it('keeps an active-policy view mounted while the panel is closed', () => {
    // Batch-3 correction: a close/open toggle must not reset the view.
    const [, closed] = replayMounts(['git', null]);
    expect(closed).toEqual(['git']);
  });

  it('keeps a keep-alive view mounted after switching to another surface', () => {
    const [openTerminal, openGit] = replayMounts(['terminal', 'git']);
    expect(openTerminal).toEqual(['terminal']);
    expect(openGit).toEqual(['git', 'terminal']);
  });

  it('keeps a keep-alive view mounted while the panel is closed', () => {
    const [, , closed] = replayMounts(['terminal', 'git', null]);
    expect(closed).toContain('terminal');
  });

  it('survives the R2 scenario: terminal → git → terminal → closed, always mounted', () => {
    const frames = replayMounts(['terminal', 'git', 'terminal', null]);
    for (const frame of frames) {
      expect(frame).toContain('terminal');
    }
  });

  it('does not mount a keep-alive view before its first activation', () => {
    const [openGit] = replayMounts(['git']);
    expect(openGit).not.toContain('terminal');
  });

  it('never mounts a surface without a registered view', () => {
    const frames = replayMounts(['editor', 'git', 'editor', null]);
    for (const frame of frames) {
      expect(frame).not.toContain('editor');
    }
  });

  it('mounts nothing at all when no view is registered', () => {
    expect(replayMounts(['git', 'terminal', null], {})).toEqual([[], [], []]);
  });

  it('returns registry order, deduped, so React keys stay stable', () => {
    const mounted = deriveMountedSurfaceIds({
      visited: ['terminal', 'git', 'terminal'],
      activeSurfaceId: 'git',
      lastSurfaceId: 'git',
      registrations: { ...MOUNT_REGISTRATIONS, git: { mountPolicy: 'keep-alive' } },
    });
    expect(mounted).toEqual(['git', 'terminal']);
    expect(mounted.indexOf('git')).toBeLessThan(mounted.indexOf('terminal'));
  });

  it('ignores unknown ids in the visited list', () => {
    expect(
      deriveMountedSurfaceIds({
        visited: ['bogus' as ContextSurfaceId, 'terminal'],
        activeSurfaceId: null,
        lastSurfaceId: 'terminal',
        registrations: MOUNT_REGISTRATIONS,
      })
    ).toEqual(['terminal']);
  });

  it('mounts an active keep-alive surface even before the caller records it', () => {
    expect(
      deriveMountedSurfaceIds({
        visited: [],
        activeSurfaceId: 'terminal',
        registrations: MOUNT_REGISTRATIONS,
      })
    ).toEqual(['terminal']);
  });
});

// ── seedVisitedSurfaceIds (m14) ─────────────────────────────────────────
describe('shouldCloseOnEscape', () => {
  it('closes on Escape from a panel-owned target', () => {
    expect(shouldCloseOnEscape({ key: 'Escape', isOpen: true, holdsEscape: false })).toBe(true);
  });

  it('ignores any other key', () => {
    expect(shouldCloseOnEscape({ key: 'Enter', isOpen: true, holdsEscape: false })).toBe(false);
    expect(shouldCloseOnEscape({ key: 'Esc', isOpen: true, holdsEscape: false })).toBe(false);
  });

  it('ignores Escape while the panel is closed', () => {
    expect(shouldCloseOnEscape({ key: 'Escape', isOpen: false, holdsEscape: false })).toBe(false);
  });

  it('yields Escape to a surface that holds it (vim / Monaco find)', () => {
    expect(shouldCloseOnEscape({ key: 'Escape', isOpen: true, holdsEscape: true })).toBe(false);
  });

  it('yields Escape to an open popup instead of collapsing the panel under it', () => {
    // Found in the real app during the H/18 point-check: with a sidebar context
    // menu open, Escape collapsed the panel and left the menu on screen. The
    // popup is portaled out of the panel, so `holdsEscape` stays false — this
    // flag is the only thing that can tell the panel to keep its hands off.
    expect(
      shouldCloseOnEscape({ key: 'Escape', isOpen: true, holdsEscape: false, popupOpen: true })
    ).toBe(false);
    expect(
      shouldCloseOnEscape({ key: 'Escape', isOpen: true, holdsEscape: false, popupOpen: false })
    ).toBe(true);
  });

  it('exposes the opt-out attribute surfaces must spell', () => {
    expect(SURFACE_ESCAPE_HOLD_ATTR).toBe('data-surface-holds-escape');
  });
});

// ── round-10 GUI review ② — one width budget, two consumers ─────────────

describe('resolveDockedPanelBudget', () => {
  it('caps a docked panel at the content floor`s leftovers', () => {
    expect(
      resolveDockedPanelBudget({ expanded: false, availableWidth: 1200, maxDockedWidth: 700 })
    ).toBe(700);
  });

  it('gives the expanded overlay the whole row — it must cover chat and the editor', () => {
    expect(
      resolveDockedPanelBudget({ expanded: true, availableWidth: 1200, maxDockedWidth: 700 })
    ).toBe(1200);
  });

  it('falls back to the measured row when no cap has been computed yet', () => {
    expect(
      resolveDockedPanelBudget({ expanded: false, availableWidth: 1200, maxDockedWidth: null })
    ).toBe(1200);
    expect(resolveDockedPanelBudget({ expanded: false, availableWidth: 1200 })).toBe(1200);
  });

  it('stays null before the first measurement rather than inventing a budget', () => {
    expect(
      resolveDockedPanelBudget({ expanded: false, availableWidth: null, maxDockedWidth: null })
    ).toBeNull();
    expect(resolveDockedPanelBudget({ expanded: true, availableWidth: null })).toBeNull();
  });

  it('honours a cap of 0 instead of falling through to the row width', () => {
    // `maxPanelWidth` returns 0 when even the content floor cannot be met;
    // `??` (not `||`) is what keeps that from silently becoming the full row.
    expect(
      resolveDockedPanelBudget({ expanded: false, availableWidth: 1200, maxDockedWidth: 0 })
    ).toBe(0);
  });

  it('is what a drag can reach: clamping through it never exceeds the cap', () => {
    // The end-to-end property behind ②: whatever the pointer asks for, the
    // committed width is one the panel is allowed to render at.
    for (const cap of [400, 700, 1000]) {
      const budget = resolveDockedPanelBudget({
        expanded: false,
        availableWidth: 4000,
        maxDockedWidth: cap,
      });
      for (const candidate of [0, 380, 900, 5000]) {
        const clamped = clampContextPanelWidth(candidate, budget);
        expect(clamped).toBeLessThanOrEqual(Math.max(cap, CONTEXT_PANEL_MIN_WIDTH));
        expect(clamped).toBeGreaterThanOrEqual(CONTEXT_PANEL_MIN_WIDTH);
      }
    }
  });
});
