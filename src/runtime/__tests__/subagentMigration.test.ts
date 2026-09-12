/**
 * P5-2-5 gate — SA19's migration half, plus the native on/off decision.
 *
 * Migration is the one place a silent change does real damage: a delegate that
 * comes across with a different tool set, a different model or a wider approval
 * gear than the user set is still a working delegate, so nothing complains. The
 * cases here pin what must be VISIBLE before anything is written, and that
 * nothing is written for a document that cannot be migrated cleanly.
 */

import { describe, expect, it } from 'vitest';
import { nativeSubagentSettings } from '../../main/services/agent-host/nativeSubagentSettings.ts';
import { parseSubagentDefinition } from '../plugins/subagent/definition.ts';
import {
  type LegacyDocument,
  previewLegacyMigration,
  previewLegacyMigrations,
} from '../plugins/subagent/migrate.ts';

const TARGET = '/agent/subagents';

function legacy(raw: string, overrides: Partial<LegacyDocument> = {}): LegacyDocument {
  return {
    filePath: '/agent/agents/helper.md',
    name: 'helper',
    scope: 'global',
    raw,
    ...overrides,
  };
}

function noteFor(preview: ReturnType<typeof previewLegacyMigration>, field: string): string[] {
  return preview.notes.filter((note) => note.field === field).map((note) => note.message);
}

describe('SA19 · legacy definitions migrate with every difference on screen', () => {
  it('produces a native document that actually parses', () => {
    const preview = previewLegacyMigration(
      legacy(
        [
          '---',
          'description: finds things',
          'tools: [read, grep, find]',
          'max_turns: 12',
          'thinking: high',
          '---',
          '',
          'Search carefully.',
        ].join('\n')
      ),
      { targetDir: TARGET }
    );
    expect(preview.blocked).toBe(false);
    expect(preview.targetPath).toBe('/agent/subagents/helper.md');

    // The point of the preview is a document that loads, not a plausible one.
    const parsed = parseSubagentDefinition(preview.document ?? '', { source: 'user' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.definition).toMatchObject({
      name: 'helper',
      description: 'finds things',
      tools: ['Read', 'Grep', 'Glob'],
      maxTurns: 12,
      thinkingLevel: 'high',
    });
    expect(parsed.definition.prompt).toBe('Search carefully.');
  });

  it('says so when a tool changes into a different tool', () => {
    const preview = previewLegacyMigration(
      legacy('---\ndescription: d\ntools: [read, find]\n---\n\nbody'),
      { targetDir: TARGET }
    );
    // `read` to `Read` is noise; `find` to `Glob` is a different tool.
    expect(noteFor(preview, 'tools').join(' ')).toContain('"find" becomes "Glob"');
    expect(noteFor(preview, 'tools').join(' ')).not.toContain('"read"');
  });

  it('reports a legacy tool that has no native counterpart at all', () => {
    const preview = previewLegacyMigration(
      legacy('---\ndescription: d\ntools: [read, ls]\n---\n\nbody'),
      { targetDir: TARGET }
    );
    expect(noteFor(preview, 'tools').join(' ')).toContain('no native equivalent');
    const parsed = parseSubagentDefinition(preview.document ?? '', { source: 'user' });
    expect(parsed.ok && parsed.definition.tools).toEqual(['Read']);
  });

  it('blocks a bare model id instead of guessing a provider', () => {
    // Guessing is how a definition that asked for a cheap model ends up on the
    // expensive one. The user picks, and until they do nothing is written.
    const preview = previewLegacyMigration(
      legacy('---\ndescription: d\nmodel: claude-sonnet-5\n---\n\nbody'),
      { targetDir: TARGET }
    );
    expect(preview.blocked).toBe(true);
    expect(preview.document).toBeUndefined();
    expect(noteFor(preview, 'model').join(' ')).toContain('names no provider');
  });

  it('keeps a qualified model pin as it is', () => {
    const preview = previewLegacyMigration(
      legacy('---\ndescription: d\nmodel: anthropic/claude-sonnet-5\n---\n\nbody'),
      { targetDir: TARGET }
    );
    expect(preview.blocked).toBe(false);
    const parsed = parseSubagentDefinition(preview.document ?? '', { source: 'user' });
    expect(parsed.ok && parsed.definition.model).toEqual({
      provider: 'anthropic',
      modelId: 'claude-sonnet-5',
    });
  });

  it('always states what happens to permissions, even though nothing changes', () => {
    // A batch migration that quietly widened an approval gear is the outcome
    // the contract forbids, so the answer is stated rather than assumed.
    const preview = previewLegacyMigration(legacy('---\ndescription: d\n---\n\nbody'), {
      targetDir: TARGET,
    });
    expect(noteFor(preview, 'permission').join(' ')).toContain('inherit');
    const parsed = parseSubagentDefinition(preview.document ?? '', { source: 'user' });
    expect(parsed.ok && parsed.definition.permission).toBeUndefined();
  });

  it('names the three legacy behaviours native simply does not have', () => {
    const preview = previewLegacyMigration(
      legacy(
        [
          '---',
          'description: d',
          'display_name: Helpful Helper',
          'prompt_mode: append',
          'inherit_context: true',
          'run_in_background: false',
          'locked: model',
          '---',
          '',
          'body',
        ].join('\n')
      ),
      { targetDir: TARGET }
    );
    const dropped = preview.notes.filter((note) => note.kind === 'dropped').map((n) => n.field);
    expect(dropped).toContain('inherit_context');
    expect(dropped).toContain('run_in_background');
    expect(dropped).toContain('prompt_mode');
    expect(dropped).toContain('display_name');
    expect(dropped).toContain('locked');
  });

  it('moves a disabled flag out of the document and into app state', () => {
    const preview = previewLegacyMigration(
      legacy('---\ndescription: d\nenabled: false\n---\n\nbody'),
      { targetDir: TARGET }
    );
    expect(noteFor(preview, 'enabled').join(' ')).toContain('app data');
    // The written document is shareable: it says nothing about this install.
    expect(preview.document).not.toContain('enabled');
  });

  it('refuses a document native cannot load, rather than writing a broken one', () => {
    const noDescription = previewLegacyMigration(legacy('---\ntools: [read]\n---\n\nbody'), {
      targetDir: TARGET,
    });
    expect(noDescription.blocked).toBe(true);

    const noBody = previewLegacyMigration(legacy('---\ndescription: d\n---\n'), {
      targetDir: TARGET,
    });
    expect(noBody.blocked).toBe(true);
    expect(noteFor(noBody, 'prompt').join(' ')).toContain('empty body');
  });

  it('will not quietly promote a project document into the global catalog', () => {
    // A checkout must not be able to add a trusted delegate.
    const preview = previewLegacyMigration(
      legacy('---\ndescription: d\n---\n\nbody', {
        scope: 'project',
        filePath: '/work/.pi/agents/helper.md',
      }),
      { targetDir: TARGET }
    );
    expect(preview.blocked).toBe(true);
    expect(noteFor(preview, 'source').join(' ')).toContain('repository');
  });

  it('flags a name that would shadow an existing definition without blocking it', () => {
    const preview = previewLegacyMigration(
      legacy('---\ndescription: d\n---\n\nbody', { name: 'explorer' }),
      { targetDir: TARGET, existingNames: ['explorer'] }
    );
    // Shadowing a builtin is legitimate; doing it unknowingly is not.
    expect(preview.collides).toBe(true);
    expect(preview.blocked).toBe(false);
  });

  it('never points at the original file as the write target', () => {
    // The legacy document is kept: a user who switches back still has it.
    const preview = previewLegacyMigration(legacy('---\ndescription: d\n---\n\nbody'), {
      targetDir: TARGET,
    });
    expect(preview.targetPath).not.toBe(preview.source.filePath);
    expect(preview.source.filePath).toBe('/agent/agents/helper.md');
  });

  it('previews a directory in a stable order', () => {
    const previews = previewLegacyMigrations(
      [
        legacy('---\ndescription: d\n---\n\nbody', { name: 'zeta' }),
        legacy('---\ndescription: d\n---\n\nbody', { name: 'alpha' }),
      ],
      { targetDir: TARGET }
    );
    expect(previews.map((preview) => preview.name)).toEqual(['alpha', 'zeta']);
  });
});

describe('P5-2-5 · native delegation is on unless the user turned it off', () => {
  it('defaults on for an install that has never been asked', () => {
    expect(nativeSubagentSettings({})).toEqual({ enabled: true });
  });

  it('reads an explicit opt-in override as the decision', () => {
    expect(nativeSubagentSettings({ piOptInFeatures: { subagents: false } }).enabled).toBe(false);
    expect(nativeSubagentSettings({ piOptInFeatures: { subagents: true } }).enabled).toBe(true);
  });

  it('honours the older boolean when no override exists', () => {
    expect(nativeSubagentSettings({ enablePiSubagents: false }).enabled).toBe(false);
  });

  it('lets the override win over the older boolean', () => {
    expect(
      nativeSubagentSettings({
        enablePiSubagents: false,
        piOptInFeatures: { subagents: true },
      }).enabled
    ).toBe(true);
  });

  it('ignores an unrelated opt-in feature', () => {
    // `false` for something else is not a statement about delegation.
    expect(nativeSubagentSettings({ piOptInFeatures: { jingle: false } }).enabled).toBe(true);
  });

  it('carries the per-install disabled list, and only strings', () => {
    expect(
      nativeSubagentSettings({ nativeSubagentsDisabled: ['fixer', 7, 'explorer'] }).disabled
    ).toEqual(['fixer', 'explorer']);
    expect(nativeSubagentSettings({ nativeSubagentsDisabled: [] }).disabled).toBeUndefined();
  });
});
