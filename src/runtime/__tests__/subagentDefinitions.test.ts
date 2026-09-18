/**
 * P5-2-1 gate — SA01 (definition parsing) and SA02 (sources, inventory, caps).
 *
 * Every rule pinned here fails SILENTLY if it breaks: a delegate that quietly
 * loses its `permission` field, a user document that stops shadowing the
 * builtin it was written to replace, a pinned model that falls back to the
 * session's expensive one. None of those throws. They just make the delegate
 * behave like a different delegate, which is exactly the class of defect the
 * P5-2 contract's "整体等价基线" exists to prevent.
 */

import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILTIN_SUBAGENT_DOCUMENTS } from '../../shared/subagentBuiltins.ts';
import {
  formatSubagentDefinition,
  MAX_SUBAGENT_DEFINITIONS,
  MAX_SUBAGENT_DOCUMENT_BYTES,
  MAX_SUBAGENT_MAX_TURNS,
  MAX_SUBAGENT_PROVIDERS,
  mergeSubagentDefinitions,
  parseSubagentDefinition,
  runtimeToolName,
  type SubagentDefinition,
  subagentCanMutate,
  subagentPinnedProviders,
} from '../../shared/subagentDefinition.ts';
import type { RuntimeFileKind, RuntimeModelRef } from '../contracts.ts';
import {
  applySubagentActivation,
  loadSubagentCatalog,
  resolveSubagentPin,
  type SubagentDocumentSource,
  subagentPinDiagnostics,
  subagentRoots,
} from '../plugins/subagent/catalog.ts';

const AGENT_DIR = '/agent';
const HOME = '/home/probe';
const USER_ROOT = join(AGENT_DIR, 'subagents');

/** In-memory tree behind the document source port. */
function fakeSource(files: Record<string, string>): SubagentDocumentSource {
  const directories = new Set<string>();
  for (const path of Object.keys(files)) {
    for (let parent = join(path, '..'); parent !== join(parent, '..'); parent = join(parent, '..'))
      directories.add(parent);
  }
  return {
    async readText(path) {
      return files[path];
    },
    async list(path) {
      if (!directories.has(path)) return undefined;
      const children = new Map<string, RuntimeFileKind>();
      for (const file of Object.keys(files)) {
        // Keys are built with `join()`, the same way the catalog builds every
        // path it reads, so child matching has to use the native separator too.
        if (!file.startsWith(`${path}${sep}`)) continue;
        const rest = file.slice(path.length + 1);
        const slash = rest.indexOf(sep);
        children.set(slash < 0 ? rest : rest.slice(0, slash), slash < 0 ? 'file' : 'directory');
      }
      return [...children].map(([name, kind]) => ({ name, kind }));
    },
  };
}

function load(files: Record<string, string> = {}) {
  return loadSubagentCatalog(fakeSource(files), { agentDir: AGENT_DIR, home: HOME });
}

function document(frontmatter: string, body = 'Do the thing.'): string {
  return `---\n${frontmatter}\n---\n\n${body}`;
}

function named(
  catalog: { definitions: readonly SubagentDefinition[] },
  name: string
): SubagentDefinition {
  const found = catalog.definitions.find((definition) => definition.name === name);
  if (!found) throw new Error(`no definition named ${name}`);
  return found;
}

describe('SA01 · the four builtins and full-field parsing', () => {
  it('ships exactly the four roles with the reference tool sets and turn caps', async () => {
    const catalog = await load();
    expect(catalog.definitions.map((definition) => definition.name).sort()).toEqual([
      'code-reviewer',
      'explorer',
      'fixer',
      'test-runner',
    ]);
    expect(catalog.diagnostics).toEqual([]);

    // The exact values from the reference table. A drift here is a delegate
    // that can suddenly write files, or one that gives up mid-task.
    expect(named(catalog, 'explorer')).toMatchObject({
      tools: ['Read', 'Glob', 'Grep', 'Bash'],
      maxTurns: 60,
      source: 'builtin',
    });
    expect(named(catalog, 'code-reviewer')).toMatchObject({
      tools: ['Read', 'Glob', 'Grep'],
      maxTurns: 50,
    });
    expect(named(catalog, 'test-runner')).toMatchObject({
      tools: ['Read', 'Glob', 'Grep', 'Bash'],
      maxTurns: 40,
    });
    expect(named(catalog, 'fixer')).toMatchObject({
      tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'],
      maxTurns: 80,
    });
  });

  it('does not call code-reviewer read-only by accident, and does call it that', async () => {
    // The research pass is explicit that only code-reviewer is pure
    // Read/Glob/Grep: explorer and test-runner carry Bash, so "no Edit/Write"
    // must never be reported to a user as "cannot change anything".
    const catalog = await load();
    expect(subagentCanMutate(named(catalog, 'code-reviewer'))).toBe(false);
    expect(subagentCanMutate(named(catalog, 'explorer'))).toBe(true);
    expect(subagentCanMutate(named(catalog, 'test-runner'))).toBe(true);
    expect(subagentCanMutate(named(catalog, 'fixer'))).toBe(true);
  });

  it('no builtin declares a tool this runtime cannot supply', async () => {
    // BrowserPreview has no implementation until P5-2-3. It is assignable, so
    // a user document may name it, but a BUILTIN that needed it would ship
    // broken - this is the case that would catch that.
    const catalog = await load();
    for (const definition of catalog.definitions) {
      for (const tool of definition.tools) {
        expect(runtimeToolName(tool), `${definition.name} declares ${tool}`).toBeDefined();
      }
    }
  });

  it('parses every executable field, not just the ones a UI happens to show', () => {
    const parsed = parseSubagentDefinition(
      document(
        [
          'name: full',
          'description: every field at once',
          'tools: [Read, Bash, Write]',
          'model: anthropic/claude-sonnet-5',
          'thinkingLevel: high',
          'permission: accept-edits',
          'maxTurns: 12',
          'idle-timeout: 600',
          'max-duration: 3600',
        ].join('\n')
      ),
      { source: 'user', filePath: '/x/full.md' }
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.definition).toMatchObject({
      name: 'full',
      description: 'every field at once',
      tools: ['Read', 'Bash', 'Write'],
      model: { provider: 'anthropic', modelId: 'claude-sonnet-5' },
      thinkingLevel: 'high',
      permission: 'accept-edits',
      maxTurns: 12,
      idleTimeoutSeconds: 600,
      maxDurationSeconds: 3600,
      source: 'user',
      filePath: '/x/full.md',
    });
  });

  it('treats absent, none and 0 maxTurns as unlimited, and clamps above the cap', () => {
    const unlimited = ['maxTurns: none', 'maxTurns: 0', 'maxTurns: -3', ''];
    for (const line of unlimited) {
      const parsed = parseSubagentDefinition(
        document(['name: t', 'description: d', line].filter(Boolean).join('\n')),
        { source: 'user' }
      );
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.definition.maxTurns, line).toBeUndefined();
    }
    const clamped = parseSubagentDefinition(
      document(['name: t', 'description: d', 'maxTurns: 500'].join('\n')),
      { source: 'user' }
    );
    expect(clamped.ok).toBe(true);
    if (clamped.ok) {
      expect(clamped.definition.maxTurns).toBe(MAX_SUBAGENT_MAX_TURNS);
      expect(clamped.warnings.join(' ')).toContain('clamping');
    }
  });

  it('accepts either model spelling and refuses a provider with no model', () => {
    const compact = parseSubagentDefinition(
      document(['name: t', 'description: d', 'model: openrouter/meta/llama-3'].join('\n')),
      { source: 'user' }
    );
    // Only the FIRST segment is the provider: an openrouter id has slashes.
    expect(compact.ok && compact.definition.model).toEqual({
      provider: 'openrouter',
      modelId: 'meta/llama-3',
    });

    const explicit = parseSubagentDefinition(
      document(['name: t', 'description: d', 'provider: anthropic', 'model: sonnet'].join('\n')),
      { source: 'user' }
    );
    expect(explicit.ok && explicit.definition.model).toEqual({
      provider: 'anthropic',
      modelId: 'sonnet',
    });

    const orphan = parseSubagentDefinition(
      document(['name: t', 'description: d', 'provider: anthropic'].join('\n')),
      { source: 'user' }
    );
    expect(orphan.ok).toBe(false);
    if (!orphan.ok) expect(orphan.errors.join(' ')).toContain('`provider` given without `model`');
  });

  it('defaults to read-only tools and expands a bare *', () => {
    const silent = parseSubagentDefinition(document(['name: t', 'description: d'].join('\n')), {
      source: 'user',
    });
    expect(silent.ok && silent.definition.tools).toEqual(['Read', 'Glob', 'Grep']);

    const all = parseSubagentDefinition(
      document(['name: t', 'description: d', 'tools: "*"'].join('\n')),
      { source: 'user' }
    );
    expect(all.ok && all.definition.tools).toContain('BrowserPreview');
  });

  it('accepts a tool list in any casing and stores the canonical spelling', () => {
    // Documents are portable: the same file may have been written for the
    // reference app (capitalised) or against our lowercase registry.
    const parsed = parseSubagentDefinition(
      document(['name: t', 'description: d', 'tools: [read, GLOB, gReP]'].join('\n')),
      { source: 'user' }
    );
    expect(parsed.ok && parsed.definition.tools).toEqual(['Read', 'Glob', 'Grep']);
    expect(runtimeToolName('Read')).toBe('read');
    // P5-2-3 gave BrowserPreview a runtime name. Whether the tool EXISTS is a
    // separate question — it is registered only on a host with a preview
    // surface — and that is settled by the live-registry intersection, not here.
    expect(runtimeToolName('BrowserPreview')).toBe('browser_preview');
    expect(runtimeToolName('Telepathy')).toBeUndefined();
  });

  it('keeps a block list and ignores unknown tools with a warning', () => {
    const parsed = parseSubagentDefinition(
      document(['name: t', 'description: d', 'tools:', '  - Read', '  - Telepathy'].join('\n')),
      { source: 'user' }
    );
    expect(parsed.ok && parsed.definition.tools).toEqual(['Read']);
    expect(parsed.warnings.join(' ')).toContain('Telepathy');
  });

  it('rejects an unusable document rather than half-loading it', () => {
    const noDescription = parseSubagentDefinition(document('name: t'), { source: 'user' });
    expect(noDescription.ok).toBe(false);

    const emptyBody = parseSubagentDefinition(document('name: t\ndescription: d', ''), {
      source: 'user',
    });
    expect(emptyBody.ok).toBe(false);
    if (!emptyBody.ok) expect(emptyBody.errors.join(' ')).toContain('body is empty');

    const badName = parseSubagentDefinition(document('name: Not A Name!\ndescription: d'), {
      source: 'user',
    });
    expect(badName.ok).toBe(false);
  });

  it('ignores an unknown permission instead of guessing one', () => {
    const parsed = parseSubagentDefinition(
      document(['name: t', 'description: d', 'permission: yolo'].join('\n')),
      { source: 'user' }
    );
    expect(parsed.ok && parsed.definition.permission).toBeUndefined();
    expect(parsed.warnings.join(' ')).toContain('yolo');
  });

  it('refuses a declared bypass the same way it refuses a made-up gear', () => {
    // `bypass` is a real session gear, which is exactly why a file on disk may
    // not assert it: turning off every approval prompt is a decision a person
    // makes for one live thread, not a property a definition carries into
    // every future session that loads it. A delegate still RUNS under bypass
    // when the session is on it — that is what `inherit` means.
    const parsed = parseSubagentDefinition(
      document(['name: t', 'description: d', 'permission: bypass'].join('\n')),
      { source: 'user' }
    );
    expect(parsed.ok && parsed.definition.permission).toBeUndefined();
    expect(parsed.warnings.join(' ')).toContain('bypass');
    expect(parsed.warnings.join(' ')).toContain('use inherit, ask, accept-edits or auto');
  });

  it('does not store the default permission as an explicit override', () => {
    // `inherit` written out and `inherit` by omission must be the same
    // definition, or a management UI save would turn one into the other.
    const parsed = parseSubagentDefinition(
      document(['name: t', 'description: d', 'permission: inherit'].join('\n')),
      { source: 'user' }
    );
    expect(parsed.ok && parsed.definition.permission).toBeUndefined();
  });

  it('falls back to the filename when the document omits a name', () => {
    const parsed = parseSubagentDefinition(document('description: d'), {
      source: 'user',
      fallbackName: 'My_Helper.md',
    });
    expect(parsed.ok && parsed.definition.name).toBe('my-helper');
  });
});

describe('SA02 · sources, inventory and directory caps', () => {
  it('scans the managed agent directory and the compatibility home root only', () => {
    expect(subagentRoots({ agentDir: AGENT_DIR, home: HOME })).toEqual([
      join(AGENT_DIR, 'subagents'),
      join(HOME, '.agents', 'subagents'),
    ]);
  });

  it('never scans a project directory', async () => {
    // A repository must not be able to add a delegate by being opened. The
    // file below sits where the LEGACY plugin would have found it.
    const catalog = await load({
      '/workspace/.pi/agents/rogue.md': document('name: rogue\ndescription: from a repo'),
      '/workspace/.agents/subagents/rogue2.md': document('name: rogue2\ndescription: from a repo'),
    });
    expect(catalog.definitions.map((definition) => definition.name)).not.toContain('rogue');
    expect(catalog.definitions.map((definition) => definition.name)).not.toContain('rogue2');
  });

  it('lets a user document shadow a builtin of the same name', async () => {
    const catalog = await load({
      [join(USER_ROOT, 'explorer.md')]: document(
        ['name: explorer', 'description: my own explorer', 'tools: [Read]', 'maxTurns: 3'].join(
          '\n'
        )
      ),
    });
    const explorer = named(catalog, 'explorer');
    expect(explorer.source).toBe('user');
    expect(explorer.maxTurns).toBe(3);
    expect(explorer.tools).toEqual(['Read']);
    // Shadowing replaces, it does not add a second entry.
    expect(catalog.definitions.filter((d) => d.name === 'explorer')).toHaveLength(1);
    // The other three builtins survive.
    expect(catalog.definitions).toHaveLength(4);
  });

  it('resolves a name in two roots the same way on every machine', async () => {
    const catalog = await load({
      [join(USER_ROOT, 'dup.md')]: document('name: dup\ndescription: from the agent dir'),
      [join(HOME, '.agents', 'subagents', 'dup.md')]: document(
        'name: dup\ndescription: from the home dir'
      ),
    });
    // The managed agent directory is listed first, so it wins.
    expect(named(catalog, 'dup').description).toBe('from the agent dir');
  });

  it('diagnoses one broken document and keeps the rest usable', async () => {
    const catalog = await load({
      [join(USER_ROOT, 'good.md')]: document('name: good\ndescription: fine'),
      [join(USER_ROOT, 'broken.md')]: document('name: broken'),
    });
    expect(catalog.definitions.map((d) => d.name)).toContain('good');
    expect(catalog.definitions.map((d) => d.name)).not.toContain('broken');
    const diagnostic = catalog.diagnostics.find((entry) =>
      entry.path.endsWith(join('subagents', 'broken.md'))
    );
    expect(diagnostic?.code).toBe('parse_failed');
    expect(diagnostic?.message).toContain('description');
  });

  it('refuses a document past the size cap instead of loading a prompt as a definition', async () => {
    const catalog = await load({
      [join(USER_ROOT, 'huge.md')]: document(
        'name: huge\ndescription: d',
        'x'.repeat(MAX_SUBAGENT_DOCUMENT_BYTES + 1)
      ),
    });
    expect(catalog.definitions.map((d) => d.name)).not.toContain('huge');
    expect(catalog.diagnostics.some((entry) => entry.code === 'document_too_large')).toBe(true);
  });

  it('drops past the runtime cap with a diagnostic, never silently', () => {
    const many: SubagentDefinition[] = Array.from({ length: MAX_SUBAGENT_DEFINITIONS + 3 }).map(
      (_, index) => ({
        name: `agent-${index}`,
        description: 'd',
        tools: ['Read'],
        idleTimeoutSeconds: 300,
        maxDurationSeconds: 21_600,
        prompt: 'p',
        source: 'user' as const,
      })
    );
    const merged = mergeSubagentDefinitions(many);
    expect(merged.definitions).toHaveLength(MAX_SUBAGENT_DEFINITIONS);
    expect(merged.dropped).toHaveLength(3);
  });

  it('caps distinct pinned providers', () => {
    const definitions: SubagentDefinition[] = Array.from({
      length: MAX_SUBAGENT_PROVIDERS + 2,
    }).map((_, index) => ({
      name: `agent-${index}`,
      description: 'd',
      tools: ['Read'],
      model: { provider: `provider-${index}`, modelId: 'm' },
      idleTimeoutSeconds: 300,
      maxDurationSeconds: 21_600,
      prompt: 'p',
      source: 'user' as const,
    }));
    expect(subagentPinnedProviders(definitions)).toHaveLength(MAX_SUBAGENT_PROVIDERS);
  });

  it('reports disabled names that no longer match a document', async () => {
    const catalog = await load();
    const applied = applySubagentActivation(catalog, ['explorer', 'renamed-away']);
    expect(applied.definitions.map((d) => d.name)).not.toContain('explorer');
    expect(applied.definitions).toHaveLength(3);
    // A tombstone left by a rename would silently disable a future definition
    // that happens to reuse the name.
    expect(applied.stale).toEqual(['renamed-away']);
  });

  it('keeps enablement out of the Markdown', async () => {
    // Documents are shareable; the switch is this install's state. A parser
    // that honoured `enabled: false` would make the two inseparable.
    const catalog = await load({
      [join(USER_ROOT, 'off.md')]: document('name: off\ndescription: d\nenabled: false'),
    });
    expect(catalog.definitions.map((d) => d.name)).toContain('off');
    expect(JSON.stringify(named(catalog, 'off'))).not.toContain('enabled');
  });
});

describe('SA02 · model pins resolve or fail, they never fall back', () => {
  const available: RuntimeModelRef[] = [
    { provider: 'anthropic', id: 'claude-sonnet-5' },
    { provider: 'openai', id: 'gpt-5' },
  ];

  it('resolves an exact pin', () => {
    expect(
      resolveSubagentPin({ provider: 'anthropic', modelId: 'claude-sonnet-5' }, available)
    ).toEqual({ provider: 'anthropic', id: 'claude-sonnet-5' });
  });

  it('resolves a hand-written pin whose casing differs', () => {
    expect(
      resolveSubagentPin({ provider: 'Anthropic', modelId: 'Claude-Sonnet-5' }, available)
    ).toEqual({ provider: 'anthropic', id: 'claude-sonnet-5' });
  });

  it('returns nothing for a near miss rather than guessing', () => {
    // Guessing is how a definition that asked for a cheap model ends up
    // spending the expensive one.
    expect(
      resolveSubagentPin({ provider: 'anthropic', modelId: 'claude-sonnet' }, available)
    ).toBeUndefined();
    expect(resolveSubagentPin({ provider: 'nope', modelId: 'gpt-5' }, available)).toBeUndefined();
  });

  it('names an unresolvable pin in the diagnostics, and keeps the definition', () => {
    const definitions: SubagentDefinition[] = [
      {
        name: 'pinned',
        description: 'd',
        tools: ['Read'],
        model: { provider: 'anthropic', modelId: 'not-configured' },
        idleTimeoutSeconds: 300,
        maxDurationSeconds: 21_600,
        prompt: 'p',
        source: 'user',
        filePath: '/x/pinned.md',
      },
    ];
    const diagnostics = subagentPinDiagnostics(definitions, available);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain('anthropic/not-configured');
    expect(diagnostics[0].path).toBe('/x/pinned.md');
  });

  it('says nothing about a definition that pins nothing', async () => {
    const catalog = await load();
    expect(subagentPinDiagnostics(catalog.definitions, available)).toEqual([]);
  });
});

describe('builtin documents stay parseable on their own terms', () => {
  it('every shipped document parses with no warnings', () => {
    for (const raw of BUILTIN_SUBAGENT_DOCUMENTS) {
      const parsed = parseSubagentDefinition(raw, { source: 'builtin' });
      expect(parsed.ok).toBe(true);
      expect(parsed.warnings).toEqual([]);
    }
  });

  it('keeps explorer pointed at regex search even though ours is literal today', () => {
    // P5-2-3 owes this prompt a real regex `grep`. The contract forbids
    // closing the gap by deleting the sentence, so this case exists to make a
    // future "tidy-up" of the prompt fail loudly instead of quietly shrinking
    // the delegate's advertised capability.
    const explorer = BUILTIN_SUBAGENT_DOCUMENTS.find((raw) => raw.includes('name: explorer'));
    expect(explorer).toBeDefined();
    expect(explorer).toContain('regex');
  });
});

describe('subagent-data-07 / subagent-data-15 · a document survives being stored', () => {
  function parse(raw: string) {
    const parsed = parseSubagentDefinition(raw, { source: 'user' });
    if (!parsed.ok) throw new Error(parsed.errors.join('; '));
    return parsed.definition;
  }

  it('restores the doubled quote the writer put in', () => {
    // `writeScalar` escapes an embedded `'` by doubling it, the way a YAML
    // single-quoted scalar does. The reader only stripped the outer pair, so
    // every save added one more quote to the user's own words.
    const definition = {
      name: 'helper',
      description: "'quick' helper for X",
      tools: ['Read'],
      prompt: 'Body.',
    };
    const document = formatSubagentDefinition(definition);
    expect(parse(document).description).toBe("'quick' helper for X");
    // The fixpoint is the property that matters: storing twice changes nothing.
    expect(formatSubagentDefinition(parse(document) as never)).toBe(document);
  });

  it('round-trips a description that is entirely quoted', () => {
    const document = formatSubagentDefinition({
      name: 'helper',
      description: "'all of it'",
      tools: ['Read'],
      prompt: 'Body.',
    });
    expect(parse(document).description).toBe("'all of it'");
  });

  it('leaves a double-quoted value alone, which the writer never produces', () => {
    const definition = parse('---\nname: h\ndescription: "plain"\n---\n\nBody.');
    expect(definition.description).toBe('plain');
  });

  it('reads a document that starts with a byte-order mark', () => {
    // Main reads with `readFile(path, "utf8")`, which keeps the BOM; the
    // runtime reads through a `TextDecoder`, which strips it. Without the strip
    // in `splitFrontmatter` the same Notepad-written file loads in a session
    // and is reported as broken on the settings page.
    const definition = parse('\uFEFF---\nname: h\ndescription: from notepad\n---\n\nBody.');
    expect(definition.description).toBe('from notepad');
    expect(definition.name).toBe('h');
  });
});
