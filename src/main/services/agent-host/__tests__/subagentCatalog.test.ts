/**
 * P5-2-5 / SA17 gate — the management service, against a real directory.
 *
 * A temp directory rather than a mocked filesystem: what is being checked is
 * that a rename leaves ONE file, that a save produces a document the loader
 * accepts, and that nothing we ship is ever written to — three things a mocked
 * `fs` would happily agree with while the real one did something else.
 *
 * Settings are a plain object, which is also the point: enablement must live in
 * app data and never in the Markdown, so the assertions read both and check
 * that each holds only its own half.
 */

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSubagentDefinition } from '@shared/subagentDefinition';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NATIVE_SUBAGENTS_DISABLED_KEY } from '../nativeSubagentSettings';
import { SubagentCatalogError, SubagentCatalogService } from '../subagentCatalog';

let root: string;
let settings: Record<string, unknown>;
let service: SubagentCatalogService;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aiclient-subagents-'));
  settings = {};
  service = new SubagentCatalogService({
    agentDir: () => join(root, 'agent'),
    readSettings: () => settings,
    writeSettings: (patch) => {
      settings = { ...settings, ...patch };
      return true;
    },
    // Never the developer's real home: a definition sitting in
    // `~/.agents/subagents` would otherwise show up in these assertions.
    home: () => join(root, 'home'),
  });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeDefinition(name: string, body: string): Promise<void> {
  const directory = join(root, 'agent', 'subagents');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${name}.md`), body, 'utf8');
}

const VALID = ['---', 'description: finds things', 'tools: [Read, Grep]', '---', '', 'Look.'].join(
  '\n'
);

describe('SA17 · the catalog the UI lists is the catalog a session loads', () => {
  it('lists the four builtins on a fresh install', async () => {
    const catalog = await service.read();
    expect(catalog.rows.map((row) => row.name).sort()).toEqual([
      'code-reviewer',
      'explorer',
      'fixer',
      'test-runner',
    ]);
    expect(catalog.rows.every((row) => row.source === 'builtin' && row.enabled)).toBe(true);
    // A builtin has no file, so the UI has nothing to reveal — and says so by
    // the field being absent rather than by an empty string.
    expect(catalog.rows.every((row) => row.filePath === undefined)).toBe(true);
  });

  it('lists a user definition above the builtins it does not shadow', async () => {
    await writeDefinition('helper', VALID);
    const catalog = await service.read();
    expect(catalog.rows).toHaveLength(5);
    const helper = catalog.rows.find((row) => row.name === 'helper');
    expect(helper).toMatchObject({ source: 'user', description: 'finds things' });
    expect(helper?.filePath).toContain('helper.md');
  });

  it('shows a user document shadowing a builtin exactly once', async () => {
    await writeDefinition('explorer', VALID);
    const catalog = await service.read();
    const explorers = catalog.rows.filter((row) => row.name === 'explorer');
    // Two rows for one name is a list nobody can act on: which switch is live?
    expect(explorers).toHaveLength(1);
    expect(explorers[0].source).toBe('user');
  });

  it('keeps a document that does not load visible, with its reason', async () => {
    await writeDefinition('broken', '---\ntools: [Read]\n---\n\nbody');
    const catalog = await service.read();
    expect(catalog.broken).toHaveLength(1);
    expect(catalog.broken[0].errors.join(' ')).toContain('description');
    // One bad document must not cost the user the rest of the list.
    expect(catalog.rows).toHaveLength(4);
  });

  it('reports a parse warning without turning it into an error', async () => {
    await writeDefinition(
      'warned',
      '---\ndescription: d\ntools: [Read, Nonsense]\nmaxTurns: 900\n---\n\nbody'
    );
    const catalog = await service.read();
    const warned = catalog.rows.find((row) => row.name === 'warned');
    expect(warned?.warnings?.join(' ')).toContain('Nonsense');
    expect(warned?.maxTurns).toBe(80);
  });
});

describe('SA17 · saving', () => {
  it('writes a document the loader accepts', async () => {
    await service.save({
      name: 'helper',
      description: 'finds things',
      tools: ['Read', 'Grep'],
      prompt: 'Look carefully.',
    });
    const raw = await readFile(join(root, 'agent', 'subagents', 'helper.md'), 'utf8');
    const parsed = parseSubagentDefinition(raw, { source: 'user' });
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.definition).toMatchObject({
      name: 'helper',
      description: 'finds things',
      tools: ['Read', 'Grep'],
      prompt: 'Look carefully.',
    });
  });

  it('round-trips a gear, a pin and a cap through save and read', async () => {
    await service.save({
      name: 'helper',
      description: 'd',
      tools: ['Read'],
      model: { provider: 'anthropic', modelId: 'claude-sonnet-5' },
      thinkingLevel: 'high',
      permission: 'ask',
      maxTurns: 12,
      prompt: 'body',
    });
    const catalog = await service.read();
    expect(catalog.rows.find((row) => row.name === 'helper')).toMatchObject({
      model: { provider: 'anthropic', modelId: 'claude-sonnet-5' },
      thinkingLevel: 'high',
      permission: 'ask',
      maxTurns: 12,
    });
  });

  it('customising a builtin writes a user document and leaves the builtin alone', async () => {
    const before = await service.read();
    const builtin = before.rows.find((row) => row.name === 'explorer');
    if (!builtin) throw new Error('no explorer');

    await service.save({
      name: 'explorer',
      description: builtin.description,
      tools: builtin.tools,
      prompt: 'My own instructions.',
    });
    const after = await service.read();
    const explorer = after.rows.find((row) => row.name === 'explorer');
    expect(explorer).toMatchObject({ source: 'user', prompt: 'My own instructions.' });
    // Switching the user copy away again must bring the shipped one back, which
    // only holds because we never wrote to it.
    await service.remove('explorer');
    const restored = await service.read();
    expect(restored.rows.find((row) => row.name === 'explorer')).toMatchObject({
      source: 'builtin',
      prompt: builtin.prompt,
    });
  });

  it('renames by moving the file, leaving exactly one behind', async () => {
    await service.save({ name: 'helper', description: 'd', tools: ['Read'], prompt: 'body' });
    await service.save({
      name: 'scout',
      previousName: 'helper',
      description: 'd',
      tools: ['Read'],
      prompt: 'body',
    });
    const files = await readdir(join(root, 'agent', 'subagents'));
    expect(files).toEqual(['scout.md']);
  });

  it('carries the switch across a rename', async () => {
    await service.save({ name: 'helper', description: 'd', tools: ['Read'], prompt: 'body' });
    await service.setEnabled('helper', false);
    await service.save({
      name: 'scout',
      previousName: 'helper',
      description: 'd',
      tools: ['Read'],
      prompt: 'body',
    });
    const catalog = await service.read();
    // Renaming a definition is not a way to switch it back on behind the user.
    expect(catalog.rows.find((row) => row.name === 'scout')?.enabled).toBe(false);
    expect(catalog.staleDisabled).toEqual([]);
  });

  it('refuses a rename onto a name that already exists', async () => {
    await service.save({ name: 'helper', description: 'd', tools: ['Read'], prompt: 'body' });
    await service.save({ name: 'scout', description: 'd', tools: ['Read'], prompt: 'body' });
    await expect(
      service.save({
        name: 'scout',
        previousName: 'helper',
        description: 'd',
        tools: ['Read'],
        prompt: 'body',
      })
    ).rejects.toThrow(SubagentCatalogError);
    // Nothing moved: a refused rename must not have deleted the source.
    expect((await readdir(join(root, 'agent', 'subagents'))).sort()).toEqual([
      'helper.md',
      'scout.md',
    ]);
  });

  it('refuses a definition that would not load', async () => {
    await expect(
      service.save({ name: 'helper', description: '', tools: ['Read'], prompt: 'body' })
    ).rejects.toThrow(/description/);
    await expect(
      service.save({ name: '', description: 'd', tools: ['Read'], prompt: 'body' })
    ).rejects.toThrow(/name/);
  });
});

describe('SA17 · switching and deleting', () => {
  it('keeps enablement in app data and out of the document', async () => {
    await service.save({ name: 'helper', description: 'd', tools: ['Read'], prompt: 'body' });
    await service.setEnabled('helper', false);

    expect(settings[NATIVE_SUBAGENTS_DISABLED_KEY]).toEqual(['helper']);
    const raw = await readFile(join(root, 'agent', 'subagents', 'helper.md'), 'utf8');
    // The document stays shareable: it says nothing about this install.
    expect(raw).not.toContain('enabled');
  });

  it('switches a builtin off without writing a document for it', async () => {
    await service.setEnabled('explorer', false);
    const catalog = await service.read();
    expect(catalog.rows.find((row) => row.name === 'explorer')).toMatchObject({
      source: 'builtin',
      enabled: false,
    });
    await expect(readdir(join(root, 'agent', 'subagents'))).rejects.toThrow();
  });

  it('deletes a user definition and forgets its switch', async () => {
    await service.save({ name: 'helper', description: 'd', tools: ['Read'], prompt: 'body' });
    await service.setEnabled('helper', false);
    await service.remove('helper');

    expect(settings[NATIVE_SUBAGENTS_DISABLED_KEY]).toEqual([]);
    const catalog = await service.read();
    expect(catalog.rows.find((row) => row.name === 'helper')).toBeUndefined();
    // Leaving the switch behind is the tombstone case: a later definition
    // reusing the name would arrive silently off.
    expect(catalog.staleDisabled).toEqual([]);
  });

  it('refuses to delete a builtin and says what to do instead', async () => {
    await expect(service.remove('explorer')).rejects.toThrow(/switch it off/);
  });

  it('deletes a document that does not even load', async () => {
    await writeDefinition('broken', '---\ntools: [Read]\n---\n\nbody');
    await service.remove('broken');
    expect(await readdir(join(root, 'agent', 'subagents'))).toEqual([]);
  });

  it('reports a switched-off name that matches nothing, and can clear it', async () => {
    settings[NATIVE_SUBAGENTS_DISABLED_KEY] = ['ghost', 'explorer'];
    const catalog = await service.read();
    expect(catalog.staleDisabled).toEqual(['ghost']);

    const cleared = await service.clearStaleDisabled();
    expect(cleared.staleDisabled).toEqual([]);
    // The live one is untouched: clearing tombstones is not a way to switch
    // everything back on.
    expect(settings[NATIVE_SUBAGENTS_DISABLED_KEY]).toEqual(['explorer']);
    expect(cleared.rows.find((row) => row.name === 'explorer')?.enabled).toBe(false);
  });
});

async function writeLegacy(name: string, body: string): Promise<void> {
  const directory = join(root, 'agent', 'agents');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${name}.md`), body, 'utf8');
}

describe('subagent-data-07 · a save stores what it was given, or refuses', () => {
  it('keeps a quoted description identical across two saves', async () => {
    // The writer escapes `'` by doubling it and the reader did not undo that,
    // so this description grew a quote pair on every save — silently, because
    // the document still parsed. The assertion is that the SECOND read equals
    // the first: a rewrite that is stable is a rewrite that is not happening.
    await service.save({
      name: 'helper',
      description: "'quick' helper",
      tools: ['Read'],
      prompt: 'Body.',
    });
    const first = (await service.read()).rows.find((row) => row.name === 'helper');
    expect(first?.description).toBe("'quick' helper");
    await service.save({
      name: 'helper',
      previousName: 'helper',
      description: first?.description ?? '',
      tools: first?.tools ?? [],
      prompt: first?.prompt ?? '',
    });
    const second = (await service.read()).rows.find((row) => row.name === 'helper');
    expect(second?.description).toBe("'quick' helper");
  });

  it('refuses a description carrying a line break instead of writing a second key', async () => {
    // A newline cannot be carried by the flat `key: value` format this parser
    // reads, and writing it produced a document whose second line looked like
    // another frontmatter field. Refused with a reason beats stored-and-changed.
    await expect(
      service.save({
        name: 'helper',
        description: 'Helper\npermission: auto',
        tools: ['Read'],
        prompt: 'Body.',
      })
    ).rejects.toBeInstanceOf(SubagentCatalogError);
    expect((await service.read()).rows.some((row) => row.name === 'helper')).toBe(false);
  });

  it('still accepts a lenient caller that spells its tools in lower case', async () => {
    // The round-trip check compares semantics, not spelling: the parser always
    // reads `read` back as `Read`, so canonicalising before writing is what
    // keeps this a save rather than a rejection.
    await service.save({
      name: 'helper',
      description: 'd',
      tools: ['read', 'GREP'],
      prompt: 'Body.',
    });
    const row = (await service.read()).rows.find((entry) => entry.name === 'helper');
    expect(row?.tools).toEqual(['Read', 'Grep']);
  });
});

describe('subagent-data-15 · a document saved with a byte-order mark still loads', () => {
  it('lists it as a definition rather than as broken', async () => {
    await writeDefinition('notepad', `\uFEFF${VALID}`);
    const catalog = await service.read();
    expect(catalog.broken).toEqual([]);
    expect(catalog.rows.some((row) => row.name === 'notepad')).toBe(true);
  });
});

describe('subagent-data-01 · the legacy import has a scan, a preview and a write', () => {
  it('previews an old document without writing anything', async () => {
    await writeLegacy(
      'oldie',
      ['---', 'description: an old helper', 'tools: [read, find]', '---', '', 'Look.'].join('\n')
    );
    const preview = await service.previewLegacyImport();
    expect(preview.sourceDirectory).toBe(join(root, 'agent', 'agents'));
    expect(preview.rows.map((row) => row.name)).toEqual(['oldie']);
    expect(preview.rows[0].blocked).toBe(false);
    // `find` becomes `Glob`, which takes different arguments — the kind of
    // change SA19 promises is visible before anything is written.
    expect(preview.rows[0].notes.some((note) => note.kind === 'adapted')).toBe(true);
    // Nothing written: the preview is a read.
    expect(await readdir(join(root, 'agent')).catch(() => [])).not.toContain('subagents');
  });

  it('blocks a document that cannot be migrated, and says why', async () => {
    await writeLegacy('nodesc', ['---', 'tools: [read]', '---', '', 'Body.'].join('\n'));
    const preview = await service.previewLegacyImport();
    expect(preview.rows[0].blocked).toBe(true);
    expect(preview.rows[0].notes.some((note) => note.kind === 'conflict')).toBe(true);
    // Blocked means nothing is written for it even when it is asked for.
    const result = await service.applyLegacyImport(['nodesc']);
    expect(result.imported).toEqual([]);
    expect(result.skipped[0].reason).toContain('decision');
  });

  it('writes only what was ticked, and leaves the original where it is', async () => {
    await writeLegacy('oldie', ['---', 'description: d', '---', '', 'Look.'].join('\n'));
    await writeLegacy('other', ['---', 'description: d', '---', '', 'Look.'].join('\n'));
    const result = await service.applyLegacyImport(['oldie']);
    expect(result.imported).toEqual(['oldie']);
    expect(result.catalog.rows.some((row) => row.name === 'oldie')).toBe(true);
    expect(result.catalog.rows.some((row) => row.name === 'other')).toBe(false);
    // Rule 1 of the migration contract: the legacy file is kept, so a user who
    // switches back still has it.
    expect(await readFile(join(root, 'agent', 'agents', 'oldie.md'), 'utf8')).toContain('Look.');
  });

  it('never overwrites a user definition that already holds the name', async () => {
    await writeDefinition('oldie', VALID);
    await writeLegacy('oldie', ['---', 'description: from legacy', '---', '', 'Other.'].join('\n'));
    const result = await service.applyLegacyImport(['oldie']);
    expect(result.imported).toEqual([]);
    expect(result.skipped[0].reason).toContain('already exists');
    expect(await readFile(join(root, 'agent', 'subagents', 'oldie.md'), 'utf8')).toContain(
      'finds things'
    );
  });

  it('answers with nothing to do when the old folder is not there', async () => {
    const preview = await service.previewLegacyImport();
    expect(preview.rows).toEqual([]);
  });
});

describe('concurrency-06 · a save never shows a rescanning worker half a document', () => {
  /** A save whose document is the same length every time, so a short read is a torn one. */
  function edit(index: number) {
    return {
      name: 'researcher',
      description: `finds things ${String(index).padStart(3, '0')}`,
      tools: ['Read'],
      prompt: 'x'.repeat(8_000),
    };
  }

  it('replaces the file atomically while a reader is scanning it', async () => {
    await service.save(edit(0));
    const target = join(root, 'agent', 'subagents', 'researcher.md');
    const expected = (await readFile(target, 'utf8')).length;

    // What the runtime does at the top of every turn since T020: reread the
    // whole definition directory. Here it is one file, read as fast as the
    // filesystem allows, for as long as the saves run.
    let reads = 0;
    let torn = 0;
    let stop = false;
    const rescan = (async () => {
      while (!stop) {
        let raw: string;
        try {
          raw = await readFile(target, 'utf8');
        } catch (error) {
          // The name itself vanishing is the same defect seen from the outside.
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          torn++;
          continue;
        }
        reads++;
        if (raw.length !== expected || !parseSubagentDefinition(raw, { source: 'user' }).ok) torn++;
      }
    })();

    try {
      for (let index = 1; index <= 30; index++) await service.save(edit(index));
    } finally {
      stop = true;
      await rescan;
    }

    expect(reads).toBeGreaterThan(0);
    expect(torn).toBe(0);
    // And the last save is what is on disk: atomicity must not cost the write.
    expect(await readFile(target, 'utf8')).toContain('finds things 030');
    // No staging file left beside it for the scanner to trip over.
    expect((await readdir(join(root, 'agent', 'subagents'))).sort()).toEqual(['researcher.md']);
  });
});
