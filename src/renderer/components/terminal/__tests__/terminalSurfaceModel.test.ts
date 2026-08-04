import { describe, expect, it } from 'vitest';
import {
  canManageTerminalSplits,
  deriveTerminalPresentation,
  HIDDEN_TERMINAL_GROUP_BOX,
  hiddenTerminalGroupCount,
  resolveTerminalGroupLayout,
  type TerminalGroupLike,
  visibleTerminalGroupIds,
} from '../terminalSurfaceModel';

const GROUPS: TerminalGroupLike[] = [{ id: 'g1' }, { id: 'g2' }, { id: 'g3' }];

describe('deriveTerminalPresentation', () => {
  it('maps the expanded overlay to the legacy multi-group layout', () => {
    expect(deriveTerminalPresentation({ expanded: true })).toBe('full');
  });

  it('maps the narrow panel to compact', () => {
    expect(deriveTerminalPresentation({ expanded: false })).toBe('compact');
  });
});

describe('canManageTerminalSplits', () => {
  it('allows split management only in full', () => {
    expect(canManageTerminalSplits('full')).toBe(true);
    expect(canManageTerminalSplits('compact')).toBe(false);
  });
});

describe('visibleTerminalGroupIds', () => {
  it('keeps every group in source order in full', () => {
    expect(
      visibleTerminalGroupIds({ presentation: 'full', groups: GROUPS, activeGroupId: 'g2' })
    ).toEqual(['g1', 'g2', 'g3']);
  });

  it('keeps source order in full even when the active group is unknown', () => {
    expect(
      visibleTerminalGroupIds({ presentation: 'full', groups: GROUPS, activeGroupId: null })
    ).toEqual(['g1', 'g2', 'g3']);
  });

  it('shows only the active group in compact', () => {
    expect(
      visibleTerminalGroupIds({ presentation: 'compact', groups: GROUPS, activeGroupId: 'g2' })
    ).toEqual(['g2']);
  });

  it('falls back to the first group when activeGroupId is null', () => {
    expect(
      visibleTerminalGroupIds({ presentation: 'compact', groups: GROUPS, activeGroupId: null })
    ).toEqual(['g1']);
  });

  it('falls back to the first group when activeGroupId names a group that is gone', () => {
    expect(
      visibleTerminalGroupIds({ presentation: 'compact', groups: GROUPS, activeGroupId: 'deleted' })
    ).toEqual(['g1']);
  });

  it('falls back to the first group when activeGroupId is absent entirely', () => {
    expect(visibleTerminalGroupIds({ presentation: 'compact', groups: GROUPS })).toEqual(['g1']);
  });

  it('returns nothing rather than a phantom id when there are no groups', () => {
    expect(
      visibleTerminalGroupIds({ presentation: 'compact', groups: [], activeGroupId: 'g1' })
    ).toEqual([]);
    expect(
      visibleTerminalGroupIds({ presentation: 'full', groups: [], activeGroupId: 'g1' })
    ).toEqual([]);
  });
});

describe('resolveTerminalGroupLayout', () => {
  it('lays groups out cumulatively from flexPercents in full', () => {
    expect(
      resolveTerminalGroupLayout({
        presentation: 'full',
        groups: GROUPS,
        flexPercents: [50, 30, 20],
        activeGroupId: 'g1',
      })
    ).toEqual([
      { id: 'g1', left: 0, width: 50 },
      { id: 'g2', left: 50, width: 30 },
      { id: 'g3', left: 80, width: 20 },
    ]);
  });

  it('substitutes an even share for a missing percentage instead of dropping the group', () => {
    // The legacy component indexed flexPercents directly and rendered `null`
    // for a group whose percentage was absent — an unmount, and an unmount
    // detaches (and therefore destroys) that group's ptys.
    const boxes = resolveTerminalGroupLayout({
      presentation: 'full',
      groups: GROUPS,
      flexPercents: [50],
      activeGroupId: 'g1',
    });
    expect(boxes.map((box) => box.id)).toEqual(['g1', 'g2', 'g3']);
    expect(boxes[1]).toEqual({ id: 'g2', left: 50, width: 100 / 3 });
  });

  it('substitutes an even share for a non-finite or non-positive percentage', () => {
    const boxes = resolveTerminalGroupLayout({
      presentation: 'full',
      groups: [{ id: 'g1' }, { id: 'g2' }],
      flexPercents: [Number.NaN, 0],
      activeGroupId: 'g1',
    });
    expect(boxes).toEqual([
      { id: 'g1', left: 0, width: 50 },
      { id: 'g2', left: 50, width: 50 },
    ]);
  });

  it('gives the single visible group the whole width in compact', () => {
    expect(
      resolveTerminalGroupLayout({
        presentation: 'compact',
        groups: GROUPS,
        flexPercents: [50, 30, 20],
        activeGroupId: 'g3',
      })
    ).toEqual([{ id: 'g3', left: 0, width: 100 }]);
  });

  it('returns an empty layout for an empty group list', () => {
    expect(
      resolveTerminalGroupLayout({ presentation: 'full', groups: [], activeGroupId: null })
    ).toEqual([]);
  });

  it('never hands a zero-width box to a hidden group', () => {
    // cols: 2 guard — FitAddon floors at two columns when the parent measures
    // zero, and the pty is resized to that floor for good.
    expect(HIDDEN_TERMINAL_GROUP_BOX.width).toBeGreaterThan(0);
  });
});

describe('hiddenTerminalGroupCount', () => {
  it('is zero in full', () => {
    expect(
      hiddenTerminalGroupCount({ presentation: 'full', groups: GROUPS, activeGroupId: 'g1' })
    ).toBe(0);
  });

  it('counts every non-active group in compact', () => {
    expect(
      hiddenTerminalGroupCount({ presentation: 'compact', groups: GROUPS, activeGroupId: 'g1' })
    ).toBe(2);
  });

  it('is zero when compact has nothing to hide', () => {
    expect(
      hiddenTerminalGroupCount({
        presentation: 'compact',
        groups: [{ id: 'g1' }],
        activeGroupId: 'g1',
      })
    ).toBe(0);
    expect(hiddenTerminalGroupCount({ presentation: 'compact', groups: [] })).toBe(0);
  });
});
