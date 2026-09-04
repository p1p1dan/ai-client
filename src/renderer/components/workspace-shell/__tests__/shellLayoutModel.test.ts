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
  initialShellSurfaceState,
  nextReadingWidthMode,
  READING_COLUMN_CLASS,
  type ReadingWidthMode,
  readingColumnClass,
  reduceColumnModeChange,
  reduceShellSurface,
  resolveContentColumnWidth,
  resolveContextPanelWidth,
  resolveDockedPanelBudget,
  type ShellSurfaceState,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SURFACE_ESCAPE_HOLD_ATTR,
  sanitizeShellLayoutPersisted,
  seedVisitedSurfaceIds,
  shouldCloseOnEscape,
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
    // Any rail-selectable surface does; `terminal` used to stand in here and
    // stopped being selectable on 2026-09-04.
    const opened = reduceShellSurface(initialShellSurfaceState, {
      type: 'select',
      surfaceId: 'editor',
    });
    const closed = reduceShellSurface(opened, { type: 'close' });
    expect(closed.activeSurfaceId).toBeNull();
    expect(closed.lastSurfaceId).toBe('editor');
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
    // T-32: the first always-surface is `git` under A08's tab order.
    expect(result.activeSurfaceId).toBe('git');
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
    // T-32: the first always-surface is `git` under A08's tab order.
    expect(result.activeSurfaceId).toBe('git');
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

describe('reduceShellSurface — two-column guard (U02-b)', () => {
  it('blocks selecting a non-context surface in two-column', () => {
    expect(
      reduceShellSurface(
        initialShellSurfaceState,
        { type: 'select', surfaceId: 'git' },
        'two-column'
      )
    ).toBe(initialShellSurfaceState);
  });

  it('allows selecting context in two-column', () => {
    expect(
      reduceShellSurface(
        initialShellSurfaceState,
        { type: 'select', surfaceId: 'context' },
        'two-column'
      )
    ).toEqual({ activeSurfaceId: 'context', lastSurfaceId: 'context', expanded: false });
  });

  it('blocks an explicit open of a hidden surface in two-column', () => {
    expect(
      reduceShellSurface(
        initialShellSurfaceState,
        { type: 'open', surfaceId: 'terminal' },
        'two-column'
      )
    ).toBe(initialShellSurfaceState);
  });

  it('opens context on a bare open and on toggle-panel in two-column', () => {
    expect(
      reduceShellSurface(initialShellSurfaceState, { type: 'open' }, 'two-column').activeSurfaceId
    ).toBe('context');
    expect(
      reduceShellSurface(initialShellSurfaceState, { type: 'toggle-panel' }, 'two-column')
        .activeSurfaceId
    ).toBe('context');
  });

  it('does not reuse a remembered non-context surface on a bare open in two-column', () => {
    const prev: ShellSurfaceState = {
      activeSurfaceId: null,
      lastSurfaceId: 'git',
      expanded: false,
    };
    expect(reduceShellSurface(prev, { type: 'open' }, 'two-column').activeSurfaceId).toBe(
      'context'
    );
  });

  it('still binds every rail surface in the default (three-column) mode', () => {
    expect(
      reduceShellSurface(initialShellSurfaceState, { type: 'select', surfaceId: 'git' })
        .activeSurfaceId
    ).toBe('git');
  });
});

describe('reduceColumnModeChange (U02-b)', () => {
  it('swaps a hidden active surface to context, remembering it as lastSurfaceId', () => {
    const prev: ShellSurfaceState = {
      activeSurfaceId: 'git',
      lastSurfaceId: 'git',
      expanded: false,
    };
    expect(reduceColumnModeChange(prev, 'two-column')).toEqual({
      activeSurfaceId: 'context',
      lastSurfaceId: 'git',
      expanded: false,
    });
  });

  it('preserves the expanded overlay while converging', () => {
    const prev: ShellSurfaceState = {
      activeSurfaceId: 'git',
      lastSurfaceId: 'terminal',
      expanded: true,
    };
    expect(reduceColumnModeChange(prev, 'two-column')).toEqual({
      activeSurfaceId: 'context',
      lastSurfaceId: 'git',
      expanded: true,
    });
  });

  it('leaves an already-context surface untouched', () => {
    const prev: ShellSurfaceState = {
      activeSurfaceId: 'context',
      lastSurfaceId: 'context',
      expanded: false,
    };
    expect(reduceColumnModeChange(prev, 'two-column')).toBe(prev);
  });

  it('is a no-op with the panel closed', () => {
    expect(reduceColumnModeChange(initialShellSurfaceState, 'two-column')).toBe(
      initialShellSurfaceState
    );
  });

  it('never touches surfaces when switching to three-column', () => {
    const prev: ShellSurfaceState = {
      activeSurfaceId: 'git',
      lastSurfaceId: 'git',
      expanded: true,
    };
    expect(reduceColumnModeChange(prev, 'three-column')).toBe(prev);
  });

  it('round-trips without losing lastSurfaceId (two-column then three-column)', () => {
    const three: ShellSurfaceState = {
      activeSurfaceId: 'git',
      lastSurfaceId: 'git',
      expanded: false,
    };
    const two = reduceColumnModeChange(three, 'two-column');
    const back = reduceColumnModeChange(two, 'three-column');
    expect(back.lastSurfaceId).toBe('git');
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

  it('clamps a persisted panel width and rejects a non-number', () => {
    // D34: the floor this clamps to is 250 now, not 380 — `sanitizePanelWidth`
    // calls `clampContextPanelWidth` with no `availableWidth`, i.e. the plain
    // MIN..MAX clamp, not the DEFAULT fallback (that only applies to `null`).
    expect(sanitizeShellLayoutPersisted({ panelWidth: 50 }).panelWidth).toBe(
      CONTEXT_PANEL_MIN_WIDTH
    );
    expect(sanitizeShellLayoutPersisted({ panelWidth: 9999 }).panelWidth).toBe(1400);
    expect(sanitizeShellLayoutPersisted({ panelWidth: 700 }).panelWidth).toBe(700);
    // A v1 profile carried a per-surface MAP here; anything but a number is
    // discarded to `null`, so downstream (`WorkspaceShell`) falls back to the
    // 380 DEFAULT rather than NaN.
    expect(sanitizeShellLayoutPersisted({ panelWidth: { git: 500 } }).panelWidth).toBeNull();
    expect(sanitizeShellLayoutPersisted({}).panelWidth).toBeNull();
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

  it('defaults a column mode absent from an old profile to three-column (U02-a)', () => {
    // Old persisted layouts predate the field; the sanitiser must supply the
    // default so no existing user's layout moves.
    expect(sanitizeShellLayoutPersisted({}).shellColumnMode).toBe('three-column');
    expect(defaultShellLayout.shellColumnMode).toBe('three-column');
  });

  it('keeps a persisted two-column mode and a persisted three-column mode (U02-a)', () => {
    expect(sanitizeShellLayoutPersisted({ shellColumnMode: 'two-column' }).shellColumnMode).toBe(
      'two-column'
    );
    expect(sanitizeShellLayoutPersisted({ shellColumnMode: 'three-column' }).shellColumnMode).toBe(
      'three-column'
    );
  });

  it('normalises an unknown column mode to three-column (U02-a)', () => {
    expect(sanitizeShellLayoutPersisted({ shellColumnMode: 'four-column' }).shellColumnMode).toBe(
      'three-column'
    );
    expect(sanitizeShellLayoutPersisted({ shellColumnMode: 42 }).shellColumnMode).toBe(
      'three-column'
    );
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
describe('seedVisitedSurfaceIds', () => {
  it('seeds a keep-alive lastSurfaceId', () => {
    expect(seedVisitedSurfaceIds('terminal', MOUNT_REGISTRATIONS)).toEqual(['terminal']);
  });

  it('does not seed an active-policy lastSurfaceId (never needed the seed)', () => {
    expect(seedVisitedSurfaceIds('git', MOUNT_REGISTRATIONS)).toEqual([]);
  });

  it('does not seed when lastSurfaceId is null', () => {
    expect(seedVisitedSurfaceIds(null, MOUNT_REGISTRATIONS)).toEqual([]);
  });

  it('does not seed a surface with no registered view', () => {
    expect(seedVisitedSurfaceIds('editor', MOUNT_REGISTRATIONS)).toEqual([]);
  });

  it('composes with deriveMountedSurfaceIds to close the m14 restore gap', () => {
    // {activeSurfaceId: null, lastSurfaceId: 'terminal'} restored from
    // persistence, panel closed on the very first render.
    const seeded = seedVisitedSurfaceIds('terminal', MOUNT_REGISTRATIONS);
    const mounted = deriveMountedSurfaceIds({
      visited: seeded,
      activeSurfaceId: null,
      lastSurfaceId: 'terminal',
      registrations: MOUNT_REGISTRATIONS,
    });
    expect(mounted).toEqual(['terminal']);
  });

  it('documents the bug this closes: the same restore without the seed mounts nothing', () => {
    const mounted = deriveMountedSurfaceIds({
      visited: [],
      activeSurfaceId: null,
      lastSurfaceId: 'terminal',
      registrations: MOUNT_REGISTRATIONS,
    });
    expect(mounted).toEqual([]);
  });
});

// ── shouldCloseOnEscape (S0, F-c/R1) ────────────────────────────────────
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
