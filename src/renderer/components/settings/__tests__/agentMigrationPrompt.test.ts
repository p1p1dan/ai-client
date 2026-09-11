import type { MigrationItem, MigrationItemKind, MigrationPlan } from '@shared/agentMigration';
import { describe, expect, it } from 'vitest';
import {
  defaultMigrationSelection,
  itemWouldCopy,
  MIGRATION_SECRET_KINDS,
  migrationKindLabel,
  selectionCarriesSecrets,
  shouldPromptMigration,
} from '../agentMigrationPrompt';

/**
 * H/21 P1. The decision under test is "do we interrupt this user at all", which
 * is the one thing about a once-per-install dialog that cannot be corrected
 * later: ask the wrong person and they dismiss it, and the one chance is spent.
 */

function item(kind: MigrationItemKind, counts: Partial<MigrationItem> = {}): MigrationItem {
  return {
    kind,
    sourcePath: `/home/u/.pi/agent/${kind}`,
    targetPath: `/home/u/.app/pi-agent/${kind}`,
    entries: [],
    total: 3,
    conflicts: 0,
    blocked: 0,
    ...counts,
  };
}

function plan(items: MigrationItem[], overrides: Partial<MigrationPlan> = {}): MigrationPlan {
  return {
    sourceDir: '/home/u/.pi/agent',
    targetDir: '/home/u/.app/pi-agent',
    sourceExists: true,
    items,
    nothingToDo: items.length === 0,
    ...overrides,
  };
}

describe('shouldPromptMigration (H/21 P1)', () => {
  it('[MP-01] offers the migration to a user who has one and has not been asked', () => {
    expect(shouldPromptMigration({ plan: plan([item('skills')]), asked: false })).toBe(true);
  });

  it('[MP-02] never asks twice', () => {
    expect(shouldPromptMigration({ plan: plan([item('skills')]), asked: true })).toBe(false);
  });

  it('[MP-03] says nothing to a user with no Pi directory', () => {
    // The overwhelmingly common case, and the one where a dialog would be pure
    // noise: someone who has never run `pi`.
    expect(shouldPromptMigration({ plan: plan([], { sourceExists: false }), asked: false })).toBe(
      false
    );
  });

  it('[MP-04] stays silent while the inspection has not answered yet', () => {
    expect(shouldPromptMigration({ plan: null, asked: false })).toBe(false);
  });

  it('[MP-05] stays silent when the Host says there is nothing to do', () => {
    expect(
      shouldPromptMigration({ plan: plan([item('skills')], { nothingToDo: true }), asked: false })
    ).toBe(false);
  });

  it('[MP-06] does not ask when every item would only collide', () => {
    // Pressing Start here copies nothing and reports success, AND burns the one
    // time we get to ask. Worse than staying quiet.
    const allConflicts = plan([
      item('skills', { total: 3, conflicts: 3 }),
      item('providers', { total: 2, conflicts: 2 }),
    ]);
    expect(shouldPromptMigration({ plan: allConflicts, asked: false })).toBe(false);
  });

  it('[MP-07] does not ask when every item is blocked', () => {
    const allBlocked = plan([item('providers', { total: 2, blocked: 2 })]);
    expect(shouldPromptMigration({ plan: allBlocked, asked: false })).toBe(false);
  });

  it('[MP-08] still asks when only one of several items would copy', () => {
    const mixed = plan([
      item('skills', { total: 3, conflicts: 3 }),
      item('sessions', { total: 40 }),
    ]);
    expect(shouldPromptMigration({ plan: mixed, asked: false })).toBe(true);
  });
});

describe('defaultMigrationSelection (H/21 P1)', () => {
  it('[MP-09] pre-ticks everything that would actually copy something', () => {
    const mixed = plan([
      item('skills'),
      item('promptTemplates', { total: 2, conflicts: 2 }),
      item('sessions', { total: 40 }),
    ]);
    expect(defaultMigrationSelection(mixed)).toEqual(['skills', 'sessions']);
  });

  it('[MP-10] leaves an item that can only skip or fail unticked', () => {
    // Ticking it would promise a copy that cannot happen.
    expect(defaultMigrationSelection(plan([item('providers', { total: 2, blocked: 2 })]))).toEqual(
      []
    );
  });

  it('[MP-11] counts conflicts and blocks together, not separately', () => {
    // 3 total, 2 collide, 1 blocked — nothing left. An implementation checking
    // only one of the two would tick this.
    expect(itemWouldCopy(item('skills', { total: 3, conflicts: 2, blocked: 1 }))).toBe(false);
    expect(itemWouldCopy(item('skills', { total: 4, conflicts: 2, blocked: 1 }))).toBe(true);
  });
});

describe('migration secrets consent (H/21 P1)', () => {
  it('[MP-12] AI services is the kind that carries a secret', () => {
    // This is what made the silent option unacceptable (decision one, option
    // A). If another kind ever starts carrying a key, this list is what the
    // dialog's warning reads.
    expect([...MIGRATION_SECRET_KINDS]).toEqual(['providers']);
  });

  it('[MP-13] warns exactly when the secret-carrying item is ticked', () => {
    expect(selectionCarriesSecrets(['providers'])).toBe(true);
    expect(selectionCarriesSecrets(['skills', 'providers', 'sessions'])).toBe(true);
    expect(selectionCarriesSecrets(['skills', 'sessions', 'agentsFile'])).toBe(false);
    expect(selectionCarriesSecrets([])).toBe(false);
  });
});

describe('migrationKindLabel (H/21 P1)', () => {
  it('[MP-14] gives all five kinds a distinct, non-empty label', () => {
    const kinds: MigrationItemKind[] = [
      'skills',
      'promptTemplates',
      'agentsFile',
      'providers',
      'sessions',
    ];
    const labels = kinds.map(migrationKindLabel);
    for (const label of labels) expect(label.trim().length).toBeGreaterThan(0);
    expect(new Set(labels).size).toBe(kinds.length);
  });
});
