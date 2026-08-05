import { describe, expect, it } from 'vitest';
import { derivePanelTabs } from '../panelTabsModel';
import { DEFAULT_SURFACE_ORDER } from '../surfaceRegistry';

/**
 * T-32 (D27): the panel tab strip and the rail are two renderings of one list.
 * These pins are what stops them drifting — if a future change gives the rail
 * a surface the tab strip lacks (or a dot one shows and the other doesn't),
 * it fails here rather than in a screenshot months later.
 */
describe('derivePanelTabs', () => {
  const noChanges = { changedFilesCount: 0 };

  it('returns A08 tab order: git | files | context, plus terminal (exemption ①)', () => {
    expect(derivePanelTabs(DEFAULT_SURFACE_ORDER, noChanges).map((tab) => tab.id)).toEqual([
      'git',
      'editor',
      'context',
      'terminal',
    ]);
  });

  it('labels the editor surface "Files" — the editor itself lives in the center column', () => {
    const files = derivePanelTabs(DEFAULT_SURFACE_ORDER, noChanges).find(
      (tab) => tab.id === 'editor'
    );
    expect(files?.labelKey).toBe('Files');
    expect(files?.descriptionKey).toBe('Browse workspace files');
  });

  it('shows the activity dot on git only, and only with changes', () => {
    const clean = derivePanelTabs(DEFAULT_SURFACE_ORDER, noChanges);
    expect(clean.filter((tab) => tab.showDot)).toEqual([]);

    const dirty = derivePanelTabs(DEFAULT_SURFACE_ORDER, { changedFilesCount: 3 });
    expect(dirty.filter((tab) => tab.showDot).map((tab) => tab.id)).toEqual(['git']);
  });

  it('honours a persisted reorder and re-appends anything the order omits', () => {
    expect(derivePanelTabs(['terminal', 'context'], noChanges).map((tab) => tab.id)).toEqual([
      'terminal',
      'context',
      'git',
      'editor',
    ]);
  });

  it('drops ids the registry does not expose on the rail', () => {
    // `chat` is content-driven with no split sessions in MVP; `pr` is a
    // registry slot only. Neither may reach the tab strip.
    expect(derivePanelTabs(['chat', 'pr', 'git'], noChanges).map((tab) => tab.id)).not.toContain(
      'chat'
    );
    expect(derivePanelTabs(['chat', 'pr', 'git'], noChanges).map((tab) => tab.id)).not.toContain(
      'pr'
    );
  });

  it('ignores garbage ids instead of throwing', () => {
    expect(derivePanelTabs(['nope', '', 'git'], noChanges)[0]?.id).toBe('git');
  });
});
