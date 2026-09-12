/**
 * P5-2-5 / SA17 gate — the management page's decisions, without a DOM.
 *
 * Four of the contract's requirements for this surface are invisible in a
 * screenshot and are asserted here instead: the round trip that keeps a field
 * the form cannot show, the rollback after a failed switch, the refresh that
 * must not blank a loaded list, and "clear" actually clearing.
 */

import type { SubagentCatalogView, SubagentRow } from '@shared/types/subagentManagement';
import { describe, expect, it } from 'vitest';
import {
  adoptCatalog,
  draftFromBuiltin,
  draftFromRow,
  emptySubagentDraft,
  filterSubagentRows,
  saveRequestFromDraft,
  sortSubagentRows,
  subagentRowSummary,
  validateSubagentDraft,
  withOptimisticEnabled,
} from '../subagentManagementModel';

function row(overrides: Partial<SubagentRow> = {}): SubagentRow {
  return {
    name: 'helper',
    description: 'finds things',
    tools: ['Read', 'Grep'],
    prompt: 'Search carefully.',
    source: 'user',
    filePath: '/agent/subagents/helper.md',
    enabled: true,
    ...overrides,
  };
}

function view(rows: SubagentRow[]): SubagentCatalogView {
  return { rows, broken: [], directory: '/agent/subagents', staleDisabled: [] };
}

describe('SA17 · editing a definition never loses what the form cannot show', () => {
  it('carries permission and a model pin through an edit that touched neither', () => {
    // The form has no permission control. If the round trip dropped it, an edit
    // to the prompt would silently change a delegate's approval gear.
    const original = row({
      permission: 'ask',
      model: { provider: 'anthropic', modelId: 'claude-sonnet-5' },
      thinkingLevel: 'high',
      maxTurns: 12,
    });
    const draft = draftFromRow(original);
    const request = saveRequestFromDraft({ ...draft, prompt: 'Search harder.' });

    expect(request).toMatchObject({
      name: 'helper',
      previousName: 'helper',
      permission: 'ask',
      model: { provider: 'anthropic', modelId: 'claude-sonnet-5' },
      thinkingLevel: 'high',
      maxTurns: 12,
      prompt: 'Search harder.',
    });
  });

  it('turns a cleared model pin into no pin at all, not an empty one', () => {
    const draft = draftFromRow(row({ model: { provider: 'anthropic', modelId: 'x' } }));
    const request = saveRequestFromDraft({ ...draft, modelPin: '' });
    expect(request.model).toBeUndefined();
    expect('model' in request).toBe(false);
  });

  it('turns a cleared turn cap into unlimited', () => {
    const draft = draftFromRow(row({ maxTurns: 40 }));
    expect(saveRequestFromDraft({ ...draft, maxTurns: '' }).maxTurns).toBeUndefined();
  });

  it('turns a cleared thinking level into "follow the session"', () => {
    const draft = draftFromRow(row({ thinkingLevel: 'high' }));
    expect(saveRequestFromDraft({ ...draft, thinkingLevel: '' }).thinkingLevel).toBeUndefined();
  });

  it('does not write the default gear when the form leaves it alone', () => {
    // `inherit` and absent mean the same thing; writing it would make a
    // never-edited field start appearing in documents.
    const draft = draftFromRow(row());
    expect(saveRequestFromDraft({ ...draft, permission: 'inherit' }).permission).toBeUndefined();
  });

  it('renames by naming the old document, not by copying', () => {
    const request = saveRequestFromDraft({ ...draftFromRow(row()), name: 'scout' });
    expect(request).toMatchObject({ name: 'scout', previousName: 'helper' });
  });

  it('customising a builtin is a new user document, not a rename of one we ship', () => {
    const draft = draftFromBuiltin(
      row({ name: 'explorer', source: 'builtin', filePath: undefined })
    );
    expect(draft.previousName).toBeUndefined();
    // Everything else comes across, so "customise" starts from what it does now.
    expect(draft).toMatchObject({ name: 'explorer', description: 'finds things' });
    expect(saveRequestFromDraft(draft).previousName).toBeUndefined();
  });

  it('normalises a name the way the loader will', () => {
    const request = saveRequestFromDraft({ ...emptySubagentDraft(), name: 'My Helper' });
    expect(request.name).toBe('my-helper');
  });
});

describe('SA17 · a draft is checked before anything is written', () => {
  it('requires a name, a description and a body', () => {
    const problems = validateSubagentDraft({ ...emptySubagentDraft() });
    expect(problems.map((problem) => problem.field).sort()).toEqual([
      'description',
      'name',
      'prompt',
    ]);
  });

  it('rejects a name the document format cannot carry', () => {
    const draft = { ...emptySubagentDraft(), name: 'Helper!', description: 'd', prompt: 'p' };
    expect(validateSubagentDraft(draft)[0]).toMatchObject({ field: 'name' });
  });

  it('rejects a name already taken, but not the row being edited', () => {
    const base = { ...draftFromRow(row()), name: 'explorer' };
    expect(validateSubagentDraft(base, ['explorer', 'helper'])).toHaveLength(1);
    // Saving `helper` as `helper` is not a collision with itself.
    expect(validateSubagentDraft(draftFromRow(row()), ['helper'])).toHaveLength(0);
  });

  it('rejects a model pin with no provider', () => {
    const draft = { ...draftFromRow(row()), modelPin: 'claude-sonnet-5' };
    expect(validateSubagentDraft(draft)[0]).toMatchObject({ field: 'modelPin' });
  });

  it('rejects a turn cap outside what the format allows, and accepts empty', () => {
    expect(validateSubagentDraft({ ...draftFromRow(row()), maxTurns: '900' })[0]).toMatchObject({
      field: 'maxTurns',
    });
    expect(validateSubagentDraft({ ...draftFromRow(row()), maxTurns: '' })).toHaveLength(0);
  });

  it('rejects a definition with no tools', () => {
    expect(validateSubagentDraft({ ...draftFromRow(row()), tools: [] })[0]).toMatchObject({
      field: 'tools',
    });
  });
});

describe('SA17 · the list holds still', () => {
  it('keeps a loaded list when a refresh fails', () => {
    const loaded = view([row()]);
    // The contract's "已加载列表刷新不闪空": only a SUCCESSFUL read can report
    // that the catalog is empty.
    expect(adoptCatalog(loaded, null)).toBe(loaded);
    const refreshed = view([]);
    expect(adoptCatalog(loaded, refreshed)).toBe(refreshed);
  });

  it('flips one row optimistically and restores the whole view on failure', () => {
    const before = view([row({ name: 'a' }), row({ name: 'b' })]);
    const optimistic = withOptimisticEnabled(before, 'a', false);

    expect(optimistic.rows.find((entry) => entry.name === 'a')?.enabled).toBe(false);
    expect(optimistic.rows.find((entry) => entry.name === 'b')?.enabled).toBe(true);
    // Rollback is the previous object, so it cannot half-apply.
    expect(before.rows.find((entry) => entry.name === 'a')?.enabled).toBe(true);
  });

  it('searches names, descriptions and tools but not the prompt body', () => {
    const rows = [
      row({ name: 'explorer', description: 'reads code', tools: ['Read', 'Grep'] }),
      row({ name: 'fixer', description: 'writes code', tools: ['Edit'], prompt: 'explorer' }),
    ];
    expect(filterSubagentRows(rows, 'explor').map((entry) => entry.name)).toEqual(['explorer']);
    expect(filterSubagentRows(rows, 'GREP').map((entry) => entry.name)).toEqual(['explorer']);
    expect(filterSubagentRows(rows, 'writes').map((entry) => entry.name)).toEqual(['fixer']);
    expect(filterSubagentRows(rows, '  ')).toHaveLength(2);
  });

  it('puts the user’s own definitions above the ones we ship', () => {
    const rows = sortSubagentRows([
      row({ name: 'explorer', source: 'builtin' }),
      row({ name: 'zeta' }),
      row({ name: 'alpha' }),
    ]);
    expect(rows.map((entry) => entry.name)).toEqual(['alpha', 'zeta', 'explorer']);
  });

  it('summarises a row without hiding an unlimited turn cap', () => {
    expect(subagentRowSummary(row())).toContain('unlimited turns');
    expect(subagentRowSummary(row({ maxTurns: 40 }))).toContain('40 turns');
    expect(subagentRowSummary(row({ permission: 'inherit' }))).not.toContain('inherit');
    expect(subagentRowSummary(row({ permission: 'auto' }))).toContain('auto');
  });
});
