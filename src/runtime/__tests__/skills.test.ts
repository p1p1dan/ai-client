/**
 * P5-1 gate — skills, prompt templates and slash expansion.
 *
 * Two halves, deliberately split:
 *
 * - The **pure** half runs the loader against an in-memory tree through
 *   {@link SkillSource}, the same way `projectInstructions.test.ts` does. Every
 *   discovery rule ported from pi is pinned here, because each of them fails
 *   SILENTLY: a skill in the wrong kind of root, a missing description, a name
 *   that cannot be a command — none of those throws, they just make the user's
 *   skill not exist.
 * - The **wired** half builds a real runtime over a real directory, because the
 *   two things worth proving end to end are that the catalog reaches the system
 *   prompt the provider actually receives, and that the `skill` tool loads a
 *   file OUTSIDE the workspace without raising a permission card — which is the
 *   entire reason the tool exists instead of telling the model to use `read`.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRuntime, type RuntimeBootstrapOptions, type RuntimeHandle } from '../bootstrap.ts';
import type { RuntimeFileKind, RuntimeHostIoService } from '../contracts.ts';
import {
  expandPrompt,
  formatSkillInvocation,
  parseCommandArgs,
  parseSlashInvocation,
  substituteArgs,
} from '../plugins/skills/expand.ts';
import { skillRoots, skillSource, templateRoots } from '../plugins/skills/index.ts';
import {
  loadSkills,
  MAX_DESCRIPTION_BYTES,
  MAX_SKILL_DEPTH,
  MAX_SKILLS,
  parseFrontmatter,
  type SkillDiagnostic,
  type SkillRoot,
  type SkillSource,
} from '../plugins/skills/loader.ts';
import { skillsSegment } from '../plugins/skills/prompt.ts';
import { loadPromptTemplates, templateBody } from '../plugins/skills/templates.ts';
import { neverAsked } from './fixtures/approval.ts';

/**
 * In-memory tree. Directories are implied by the keys, as on a real filesystem.
 * `symlinks` maps a symlink's own path to the path it points at (which may or
 * may not exist, and chains of symlinks are followed) — enough to exercise
 * skills-mcp-08 without a real filesystem.
 */
function fakeSource(
  files: Record<string, string>,
  symlinks: Record<string, string> = {}
): SkillSource {
  const directories = new Set<string>();
  const addAncestors = (path: string) => {
    for (
      let parent = join(path, '..');
      parent !== join(parent, '..');
      parent = join(parent, '..')
    ) {
      directories.add(parent);
    }
  };
  for (const path of Object.keys(files)) addAncestors(path);
  for (const path of Object.keys(symlinks)) addAncestors(path);
  const exists = (path: string) => directories.has(path) || Object.hasOwn(files, path);

  /**
   * Real symlink transparency: a path whose PREFIX (not just the whole path)
   * is a symlink still resolves, e.g. `<link-to-dir>/SKILL.md`. Walk from the
   * full path up to shorter prefixes; the first prefix found in `symlinks` is
   * substituted and the walk restarts from the rebuilt path (for chains and
   * nested links). No symlink anywhere in the chain: return `path` as-is,
   * which may legitimately not exist. A cycle or a dangling target: give up
   * and return the original `path` too, which then correctly fails `exists`.
   */
  const resolveFullPath = (path: string, seen = new Set<string>()): string => {
    if (exists(path)) return path;
    if (seen.has(path)) return path; // cycle guard
    seen.add(path);
    const suffix: string[] = [];
    let prefix = path;
    while (prefix !== join(prefix, '..')) {
      if (symlinks[prefix] !== undefined) {
        const rebuilt = suffix.length
          ? join(symlinks[prefix], ...[...suffix].reverse())
          : symlinks[prefix];
        return resolveFullPath(rebuilt, seen);
      }
      suffix.push(basename(prefix));
      prefix = join(prefix, '..');
    }
    return path;
  };

  const childrenOf = (dir: string) => {
    const children = new Map<string, RuntimeFileKind>();
    for (const file of Object.keys(files)) {
      if (!file.startsWith(`${dir}/`)) continue;
      const rest = file.slice(dir.length + 1);
      const slash = rest.indexOf('/');
      children.set(slash < 0 ? rest : rest.slice(0, slash), slash < 0 ? 'file' : 'directory');
    }
    // A directory that exists only to hold a nested symlink (no real file of
    // its own directly under `dir`) still needs to show up as a child, e.g.
    // `linked/` in `agent/skills/linked/SKILL.md` when only the `.md` is a
    // symlink and `linked/` itself is an ordinary directory.
    for (const candidate of directories) {
      if (join(candidate, '..') !== dir || symlinks[candidate] !== undefined) continue;
      if (!children.has(basename(candidate))) children.set(basename(candidate), 'directory');
    }
    for (const link of Object.keys(symlinks)) {
      if (join(link, '..') !== dir) continue;
      children.set(basename(link), 'symlink');
    }
    return children;
  };

  return {
    async readText(path) {
      return files[resolveFullPath(path)];
    },
    async list(path) {
      const dir = resolveFullPath(path);
      if (!directories.has(dir)) return undefined;
      return [...childrenOf(dir)].map(([name, kind]) => ({ name, kind }));
    },
    async stat(path) {
      const resolved = resolveFullPath(path);
      if (directories.has(resolved)) return { kind: 'directory' };
      if (Object.hasOwn(files, resolved)) return { kind: 'file' };
      return undefined;
    },
  };
}

const USER: SkillRoot = { path: '/agent/skills', scope: 'user', rootMarkdown: true };
const AGENTS: SkillRoot = { path: '/home/.agents/skills', scope: 'user', rootMarkdown: false };
const PROJECT: SkillRoot = { path: '/work/.pi/skills', scope: 'project', rootMarkdown: true };

const front = (name: string, description: string, body = 'Do the thing.') =>
  `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;

/** One assistant turn that does nothing but call the `skill` tool. */
function skillCall(name: string) {
  const message = fauxAssistantMessage('');
  message.content = [{ type: 'toolCall', id: `call-${name}`, name: 'skill', arguments: { name } }];
  message.stopReason = 'toolUse';
  return message;
}

describe('P5-1 frontmatter', () => {
  it('reads one-line scalars and strips matching quotes', () => {
    expect(
      parseFrontmatter('---\nname: a\ndescription: "b: c"\nargument-hint: \'<x>\'\n---\nbody')
    ).toEqual({ name: 'a', description: 'b: c', argumentHint: '<x>' });
  });

  it('answers undefined without a leading delimiter block', () => {
    expect(parseFrontmatter('# Just a document\n')).toBeUndefined();
  });

  it('ignores indented lines rather than reading a nested key as a scalar', () => {
    // `allowed-tools:` with a YAML list under it is legal in the standard and
    // this reader does not model it. What matters is that it does not turn the
    // first list item into the value of some key.
    const parsed = parseFrontmatter(
      '---\nname: a\nallowed-tools:\n  - read\n  - bash\ndescription: d\n---\nbody'
    );
    expect(parsed).toEqual({ name: 'a', description: 'd' });
  });

  it('tolerates CRLF and a BOM', () => {
    expect(parseFrontmatter('﻿---\r\nname: a\r\ndescription: d\r\n---\r\nbody')).toEqual({
      name: 'a',
      description: 'd',
    });
  });

  it('parses disable-model-invocation as a boolean', () => {
    expect(
      parseFrontmatter('---\nname: a\ndescription: d\ndisable-model-invocation: true\n---\nbody')
    ).toEqual({ name: 'a', description: 'd', disableModelInvocation: true });
    expect(
      parseFrontmatter('---\nname: a\ndescription: d\ndisable-model-invocation: false\n---\nbody')
    ).toEqual({ name: 'a', description: 'd', disableModelInvocation: false });
  });

  // skills-mcp-10 — a folded (`>`) or literal (`|`) block scalar leaves only
  // the indicator on the key's own line; this reader must not read that
  // character as the actual value, and must report it when asked to.
  it('drops a YAML block-scalar value instead of reading the indicator as the value', () => {
    const folded = parseFrontmatter(
      '---\nname: a\ndescription: >\n  Extract text\n  from PDFs.\n---\nbody'
    );
    expect(folded).toEqual({ name: 'a' });
    const diagnostics: SkillDiagnostic[] = [];
    const reported = parseFrontmatter('---\nname: a\ndescription: |-\n  Literal text.\n---\nbody', {
      diagnostics,
      path: '/agent/skills/a/SKILL.md',
    });
    expect(reported).toEqual({ name: 'a' });
    expect(diagnostics).toEqual([
      {
        code: 'invalid_metadata',
        path: '/agent/skills/a/SKILL.md',
        message: expect.stringContaining('description'),
      },
    ]);
  });
});

describe('P5-1 skill discovery', () => {
  it('finds SKILL.md directories and, in a pi-style root only, loose markdown', async () => {
    const source = fakeSource({
      '/agent/skills/loose.md': front('loose', 'A loose skill'),
      '/agent/skills/packaged/SKILL.md': front('packaged', 'A packaged skill'),
      '/home/.agents/skills/ignored.md': front('ignored', 'Root markdown in an .agents root'),
      '/home/.agents/skills/group/nested.md': front('nested', 'Nested markdown declares itself'),
    });
    const { skills } = await loadSkills(source, [USER, AGENTS]);
    expect(skills.map((skill) => skill.name)).toEqual(['loose', 'nested', 'packaged']);
  });

  it('treats SKILL.md at the top of a pi-style root as a loose root file', async () => {
    // There is no directory to name it after, so the filename supplies the
    // fallback. Below the root the directory branch consumes it instead.
    const source = fakeSource({ '/agent/skills/SKILL.md': front('toplevel', 'At the root') });
    const { skills } = await loadSkills(source, [USER]);
    expect(skills.map((skill) => skill.name)).toEqual(['toplevel']);
  });

  it("does not treat a skill directory's subdirectories as more skills", async () => {
    const source = fakeSource({
      '/agent/skills/outer/SKILL.md': front('outer', 'The skill'),
      '/agent/skills/outer/reference/SKILL.md': front('inner', 'An asset that looks like a skill'),
    });
    const { skills } = await loadSkills(source, [USER]);
    expect(skills.map((skill) => skill.name)).toEqual(['outer']);
  });

  it('falls back to the directory name and keeps a name that differs from it', async () => {
    const source = fakeSource({
      '/agent/skills/by-dir/SKILL.md': '---\ndescription: No name field\n---\nbody',
      '/agent/skills/other-dir/SKILL.md': front('declared', 'Name differs from directory'),
    });
    const { skills } = await loadSkills(source, [USER]);
    expect(skills.map((skill) => skill.name).sort()).toEqual(['by-dir', 'declared']);
  });

  it('reports a declared skill with no description and stays silent about undeclared files', async () => {
    const source = fakeSource({
      '/agent/skills/broken/SKILL.md': '---\nname: broken\n---\nbody',
      '/agent/skills/README.md': '# Not a skill\n',
    });
    const { skills, diagnostics } = await loadSkills(source, [USER]);
    expect(skills).toEqual([]);
    expect(diagnostics).toEqual([
      {
        code: 'invalid_metadata',
        path: join('/agent/skills/broken', 'SKILL.md'),
        message: 'frontmatter has no non-empty description',
      },
    ]);
  });

  it('refuses a name that cannot address the skill tool', async () => {
    const source = fakeSource({
      '/agent/skills/a/SKILL.md': front('has space', 'd'),
      '/agent/skills/b/SKILL.md': front('../escape', 'd'),
    });
    const { skills, diagnostics } = await loadSkills(source, [USER]);
    expect(skills).toEqual([]);
    expect(diagnostics.map((item) => item.code)).toEqual(['invalid_metadata', 'invalid_metadata']);
  });

  it('lets a project root override a user skill of the same name', async () => {
    const source = fakeSource({
      '/agent/skills/review/SKILL.md': front('review', 'User version'),
      '/work/.pi/skills/review/SKILL.md': front('review', 'Project version'),
    });
    const { skills } = await loadSkills(source, [USER, PROJECT]);
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({ description: 'Project version', scope: 'project' });
  });

  it('collapses a multi-line description and caps it', async () => {
    const long = 'x'.repeat(MAX_DESCRIPTION_BYTES + 50);
    const source = fakeSource({
      '/agent/skills/a/SKILL.md': `---\nname: a\ndescription: ${long}\n---\nbody`,
    });
    const { skills } = await loadSkills(source, [USER]);
    expect(Buffer.byteLength(skills[0].description)).toBe(MAX_DESCRIPTION_BYTES);
  });

  it('returns names in a stable order regardless of directory listing order', async () => {
    const source = fakeSource({
      '/agent/skills/zebra/SKILL.md': front('zebra', 'z'),
      '/agent/skills/alpha/SKILL.md': front('alpha', 'a'),
      '/agent/skills/mid/SKILL.md': front('mid', 'm'),
    });
    const { skills } = await loadSkills(source, [USER]);
    expect(skills.map((skill) => skill.name)).toEqual(['alpha', 'mid', 'zebra']);
  });

  it('skips a root that is not there at all', async () => {
    const { skills, diagnostics } = await loadSkills(fakeSource({}), [USER, AGENTS]);
    expect(skills).toEqual([]);
    expect(diagnostics).toEqual([]);
  });

  // skills-mcp-08 — a symlinked skill directory or SKILL.md loads exactly
  // like a real one; `list()`'s Dirent kind does not follow the link, so
  // this exercises the `stat()`-based resolution added for it.
  it('follows a symlinked skill directory to its SKILL.md', async () => {
    const source = fakeSource(
      { '/real/pdf-tools/SKILL.md': front('pdf-tools', 'Extract text from PDFs') },
      { '/home/.agents/skills/pdf-tools': '/real/pdf-tools' }
    );
    const { skills, diagnostics } = await loadSkills(source, [AGENTS]);
    expect(skills.map((skill) => skill.name)).toEqual(['pdf-tools']);
    expect(diagnostics).toEqual([]);
  });

  it('follows a symlinked SKILL.md file', async () => {
    const source = fakeSource(
      { '/real/SKILL.md': front('linked', 'The real file lives elsewhere') },
      { '/agent/skills/linked/SKILL.md': '/real/SKILL.md' }
    );
    const { skills } = await loadSkills(source, [USER]);
    expect(skills.map((skill) => skill.name)).toEqual(['linked']);
  });

  it('reports a dangling symlink with a diagnostic instead of skipping it silently', async () => {
    const source = fakeSource(
      {},
      { '/home/.agents/skills/broken-link': '/nowhere/does-not-exist' }
    );
    const { skills, diagnostics } = await loadSkills(source, [AGENTS]);
    expect(skills).toEqual([]);
    expect(diagnostics).toEqual([
      {
        code: 'read_failed',
        path: join('/home/.agents/skills', 'broken-link'),
        message: expect.stringContaining('symlink'),
      },
    ]);
  });

  it('drops skills past MAX_SKILLS with a diagnostic for the root that was not scanned', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < MAX_SKILLS; i++) {
      files[`/agent/skills/s${i}/SKILL.md`] = front(`s${i}`, `Skill number ${i}`);
    }
    files['/home/.agents/skills/overflow/SKILL.md'] = front('overflow', 'One too many');
    const { skills, diagnostics } = await loadSkills(fakeSource(files), [USER, AGENTS]);
    expect(skills).toHaveLength(MAX_SKILLS);
    expect(diagnostics).toEqual([
      {
        code: 'too_many',
        path: AGENTS.path,
        message: `stopped after ${MAX_SKILLS} skills; this root was not scanned`,
      },
    ]);
  });

  it('does not descend past MAX_SKILL_DEPTH', async () => {
    const segment = (n: number) => Array.from({ length: n }, (_, i) => `d${i}`).join('/');
    const shallow = `/agent/skills/${segment(MAX_SKILL_DEPTH)}`;
    const deep = `/agent/skills/${segment(MAX_SKILL_DEPTH + 1)}`;
    const source = fakeSource({
      [`${shallow}/SKILL.md`]: front('shallow', 'Within the depth budget'),
      [`${deep}/SKILL.md`]: front('deep', 'One level past the budget'),
    });
    const { skills } = await loadSkills(source, [USER]);
    expect(skills.map((skill) => skill.name)).toEqual(['shallow']);
  });

  // Decision 004 — same-name skills at two project levels: the one closer to
  // cwd (later in the roots array, per `skillRoots`'s ordering) wins.
  it('lets a project skill closer to cwd override one from an ancestor directory', async () => {
    const ANCESTOR: SkillRoot = {
      path: '/repo/.agents/skills',
      scope: 'project',
      rootMarkdown: false,
    };
    const CLOSER: SkillRoot = {
      path: '/repo/packages/app/.agents/skills',
      scope: 'project',
      rootMarkdown: false,
    };
    const source = fakeSource({
      '/repo/.agents/skills/review/SKILL.md': front('review', 'Ancestor version'),
      '/repo/packages/app/.agents/skills/review/SKILL.md': front('review', 'Closest version'),
    });
    const { skills } = await loadSkills(source, [ANCESTOR, CLOSER]);
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({ description: 'Closest version', scope: 'project' });
  });
});

/** No path ever has a `.git`, i.e. "not inside a git checkout at all". */
const NO_GIT: Pick<RuntimeHostIoService, 'stat'> = {
  async stat() {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  },
};

/** `.git` exists at exactly `repoRoot` and nowhere else in the climb. */
function gitAt(repoRoot: string): Pick<RuntimeHostIoService, 'stat'> {
  return {
    async stat(path: string) {
      if (path === join(repoRoot, '.git')) return { kind: 'directory', size: 0, mtimeMs: 0 };
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
  };
}

describe('P5-1 root selection', () => {
  it('withholds project roots until the folder is trusted', async () => {
    const untrusted = await skillRoots(NO_GIT, { agentDir: '/agent', cwd: '/work', home: '/home' });
    expect(untrusted.map((root) => root.path)).toEqual([
      join('/agent', 'skills'),
      join('/home', '.agents', 'skills'),
    ]);
    const trusted = await skillRoots(NO_GIT, {
      agentDir: '/agent',
      cwd: '/work',
      home: '/home',
      projectTrusted: true,
    });
    expect(trusted.map((root) => root.path)).toEqual([
      join('/agent', 'skills'),
      join('/home', '.agents', 'skills'),
      join('/work', '.pi', 'skills'),
      join('/work', '.agents', 'skills'),
    ]);
    expect(templateRoots({ agentDir: '/agent', cwd: '/work' }).map((root) => root.path)).toEqual([
      join('/agent', 'prompts'),
    ]);
  });

  // Decision 004 — `.agents/skills` is looked up from cwd through every
  // ancestor up to (and including) the repo root, not cwd alone.
  it('walks cwd up through ancestors to the repo root for .agents/skills', async () => {
    const cwd = join('/repo', 'packages', 'app');
    const roots = await skillRoots(gitAt('/repo'), { cwd, projectTrusted: true });
    const agentsRoots = roots.filter(
      (root) => root.scope === 'project' && root.path.endsWith(join('.agents', 'skills'))
    );
    // Repo root first (least specific), cwd last — last-wins in `loadSkills`
    // means the level closest to cwd overrides one declared further away.
    expect(agentsRoots.map((root) => root.path)).toEqual([
      join('/repo', '.agents', 'skills'),
      join('/repo', 'packages', '.agents', 'skills'),
      join('/repo', 'packages', 'app', '.agents', 'skills'),
    ]);
    // `.pi/skills` is unaffected by decision 004: still cwd only.
    expect(roots.filter((root) => root.path.includes(join('.pi', 'skills')))).toHaveLength(1);
  });

  it('falls back to cwd alone when no ancestor has a .git', async () => {
    const roots = await skillRoots(NO_GIT, { cwd: '/work/nested', projectTrusted: true });
    const projectAgentsRoots = roots.filter(
      (root) => root.scope === 'project' && root.path.endsWith(join('.agents', 'skills'))
    );
    expect(projectAgentsRoots).toEqual([
      { path: join('/work', 'nested', '.agents', 'skills'), scope: 'project', rootMarkdown: false },
    ]);
  });
});

describe('P5-1 skillSource adapter', () => {
  // skills-mcp-25 — a permission error while scanning is not the same fact as
  // "no skills directory"; it must not fail the catalog build. This is the
  // one path `fakeSource` (a plain in-memory map) cannot exercise, because it
  // never throws: only the real `skillSource()` adapter has the try/catch
  // that turns a host EACCES into `undefined`.
  it('treats a readText EACCES the same as a missing file, not an error', async () => {
    const io = {
      async readFile() {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      },
    } as unknown as RuntimeHostIoService;
    await expect(skillSource(io, 1024).readText('/locked/SKILL.md')).resolves.toBeUndefined();
  });
});

describe('P5-1 prompt templates', () => {
  it('reads description and argument hint, and falls back to the first body line', async () => {
    const source = fakeSource({
      '/agent/prompts/review.md':
        '---\ndescription: Review staged changes\nargument-hint: "<PR-URL>"\n---\nReview $1 now.\n',
      '/agent/prompts/plain.md': 'Just do the work.\nSecond line.\n',
      '/agent/prompts/notes.txt': 'ignored',
    });
    const { templates } = await loadPromptTemplates(source, [
      { path: '/agent/prompts', scope: 'user' },
    ]);
    expect(templates).toEqual([
      {
        name: 'plain',
        description: 'Just do the work.',
        filePath: join('/agent/prompts', 'plain.md'),
        scope: 'user',
      },
      {
        name: 'review',
        description: 'Review staged changes',
        argumentHint: '<PR-URL>',
        filePath: join('/agent/prompts', 'review.md'),
        scope: 'user',
      },
    ]);
  });

  it('is not recursive, because /name has no syntax for a subdirectory', async () => {
    const source = fakeSource({ '/agent/prompts/group/deep.md': 'body' });
    const { templates } = await loadPromptTemplates(source, [
      { path: '/agent/prompts', scope: 'user' },
    ]);
    expect(templates).toEqual([]);
  });

  it('strips the frontmatter from the body', () => {
    expect(templateBody('---\ndescription: d\n---\nthe body\n')).toBe('the body');
    expect(templateBody('no frontmatter\n')).toBe('no frontmatter');
  });

  it('strips CRLF and a BOM-prefixed frontmatter block the same as LF', () => {
    expect(templateBody('﻿---\r\ndescription: d\r\n---\r\nthe body\r\n')).toBe('the body');
  });

  // skills-mcp-19 — the first-line fallback is capped, same length pi uses.
  it('caps the first-line fallback description at 60 characters', async () => {
    const long = 'x'.repeat(80);
    const source = fakeSource({ '/agent/prompts/long.md': `${long}\nmore text\n` });
    const { templates } = await loadPromptTemplates(source, [
      { path: '/agent/prompts', scope: 'user' },
    ]);
    expect(templates[0].description).toBe(`${'x'.repeat(60)}...`);
  });
});

describe('P5-1 slash expansion', () => {
  it('recognises only a leading slash command', () => {
    expect(parseSlashInvocation('/review the diff')).toEqual({
      kind: 'template',
      name: 'review',
      args: 'the diff',
    });
    expect(parseSlashInvocation('/skill:pdf-tools extract')).toEqual({
      kind: 'skill',
      name: 'pdf-tools',
      args: 'extract',
    });
    expect(parseSlashInvocation('look in /tmp for it')).toBeUndefined();
    expect(parseSlashInvocation('/usr/bin/env')).toBeUndefined();
  });

  it('keeps trailing lines as the argument text, on the same line or below it', () => {
    expect(parseSlashInvocation('/review line one\nline two')?.args).toBe('line one\nline two');
    expect(parseSlashInvocation('/review\nline one\nline two')?.args).toBe('line one\nline two');
    expect(parseSlashInvocation('/review')?.args).toBe('');
  });

  it('substitutes positional, slice and all-argument placeholders like pi does', () => {
    const args = parseCommandArgs('one "two three" four');
    expect(args).toEqual(['one', 'two three', 'four']);
    expect(substituteArgs('[$1][$2][$9]', args)).toBe('[one][two three][]');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: `${@:N}` is pi's slice placeholder, not a JS template
    const slices = '[${@:2}][${@:1:2}]';
    expect(substituteArgs(slices, args)).toBe('[two three four][one two three]');
    expect(substituteArgs('[$ARGUMENTS][$@]', args)).toBe(
      '[one two three four][one two three four]'
    );
  });

  // skills-mcp-18 — a string replacement value lets String.replace read `$&`,
  // `$'`, `` $` `` and `$1` inside the argument text as replacement patterns
  // instead of literal characters. A user pasting a `$1` or `$&` as an
  // argument must see it come back unchanged.
  it('treats special replacement patterns in $ARGUMENTS and $@ as literal text', () => {
    const args = parseCommandArgs('$& $1 literal');
    expect(substituteArgs('before [$ARGUMENTS] after', args)).toBe('before [$& $1 literal] after');
    expect(substituteArgs('before [$@] after', args)).toBe('before [$& $1 literal] after');
  });

  it('expands a template and a skill, and passes unknown commands through untouched', async () => {
    const skill = {
      name: 'pdf',
      description: 'd',
      filePath: '/agent/skills/pdf/SKILL.md',
      scope: 'user' as const,
      disableModelInvocation: false,
    };
    const catalog = {
      skills: [skill],
      templates: [
        {
          name: 'review',
          description: 'd',
          filePath: '/agent/prompts/review.md',
          scope: 'user' as const,
        },
      ],
      readBody: async (path: string) =>
        path.endsWith('review.md') ? 'Review $1.' : 'Skill instructions.',
    };
    await expect(expandPrompt('/review HEAD', catalog)).resolves.toEqual({
      expanded: true,
      text: 'Review HEAD.',
      invocation: { kind: 'template', name: 'review', args: 'HEAD' },
    });
    const skillResult = await expandPrompt('/skill:pdf extract page 2', catalog);
    expect(skillResult).toMatchObject({ expanded: true });
    if (skillResult.expanded) {
      expect(skillResult.text).toBe(
        formatSkillInvocation(skill, 'Skill instructions.', 'extract page 2')
      );
      expect(skillResult.text).toContain('User: extract page 2');
      expect(skillResult.text).toContain('location="/agent/skills/pdf/SKILL.md"');
    }
    // `/new`, `/settings` and `/compact` never reach the worker; anything else
    // the catalog does not know goes to the model exactly as typed.
    await expect(expandPrompt('/unknown thing', catalog)).resolves.toEqual({
      expanded: false,
      reason: 'unknown_command',
    });
    await expect(expandPrompt('plain prompt', catalog)).resolves.toEqual({ expanded: false });
  });
});

describe('P5-1 prompt block', () => {
  it('emits nothing for an empty catalog and escapes what it emits', () => {
    expect(skillsSegment([])).toBeUndefined();
    const segment = skillsSegment([
      {
        name: 'a&b',
        description: '<danger>',
        filePath: '/x/SKILL.md',
        scope: 'user',
        disableModelInvocation: false,
      },
    ]);
    expect(segment?.slot).toBe('skills');
    expect(segment?.text).toContain('<name>a&amp;b</name>');
    expect(segment?.text).toContain('<description>&lt;danger&gt;</description>');
    expect(segment?.text).toContain('<location>/x/SKILL.md</location>');
  });

  // skills-mcp-09 — the author's opt-out removes the skill from the prompt
  // segment entirely; it does not just hide the description.
  it('drops a disable-model-invocation skill from the segment', () => {
    const hidden = {
      name: 'hidden',
      description: 'd',
      filePath: '/x/SKILL.md',
      scope: 'user' as const,
      disableModelInvocation: true,
    };
    expect(skillsSegment([hidden])).toBeUndefined();
    const shown = {
      name: 'shown',
      description: 'd',
      filePath: '/y/SKILL.md',
      scope: 'user' as const,
      disableModelInvocation: false,
    };
    const segment = skillsSegment([hidden, shown]);
    expect(segment?.text).not.toContain('<name>hidden</name>');
    expect(segment?.text).toContain('<name>shown</name>');
  });
});

describe('P5-1 wired into a real runtime', () => {
  let dir: string;
  let root: string;
  let agentDir: string;
  const runtimes: RuntimeHandle[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'runtime-skills-'));
    root = join(dir, 'project');
    agentDir = join(dir, 'agent');
    await mkdir(join(agentDir, 'skills', 'pdf'), { recursive: true });
    await mkdir(join(agentDir, 'prompts'), { recursive: true });
    await mkdir(root, { recursive: true });
    await writeFile(
      join(agentDir, 'skills', 'pdf', 'SKILL.md'),
      front('pdf', 'Extract text from PDFs', 'STEP ONE: open the file.')
    );
    await writeFile(
      join(agentDir, 'prompts', 'review.md'),
      '---\ndescription: Review staged changes\n---\nReview $1 carefully.\n'
    );
  });

  afterEach(async () => {
    for (const handle of runtimes.splice(0)) await handle.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  /** T002 — writes a global policy override, same location `shellPolicy.test.ts` uses. */
  async function policy(document: unknown) {
    const path = join(agentDir, 'extensions', 'pi-permission-system', 'config.json');
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, JSON.stringify(document));
  }

  async function runtime(options: Partial<RuntimeBootstrapOptions> = {}) {
    const faux = fauxProvider({
      provider: 'test',
      models: [{ id: 'test', name: 'Test', contextWindow: 128_000 }],
    });
    const handle = await createRuntime({
      env: {},
      traceDir: null,
      providers: [faux.provider],
      tools: { cwd: root },
      agentDir,
      // `home` points at an empty directory so the developer's own
      // `~/.agents/skills` cannot leak into the assertion.
      skills: { home: join(dir, 'empty-home') },
      ...options,
      permissions: { approve: neverAsked, ...options.permissions },
    });
    runtimes.push(handle);
    return { handle, faux };
  }

  it('puts the catalog in the system prompt the provider receives', async () => {
    const { handle, faux } = await runtime();
    const prompts: string[] = [];
    faux.setResponses([
      (context) => {
        prompts.push(context.systemPrompt ?? '');
        return fauxAssistantMessage('done');
      },
    ]);
    await handle.run({ prompt: 'hello' });
    expect(prompts[0]).toContain('<available_skills>');
    expect(prompts[0]).toContain('<name>pdf</name>');
    expect(prompts[0]).toContain('<description>Extract text from PDFs</description>');
    // A template is the user's shortcut, not something the model is told about.
    expect(prompts[0]).not.toContain('Review staged changes');
    expect(prompts[0]).not.toContain('Review $1 carefully.');
    expect(handle.skills?.templates.map((item) => item.name)).toEqual(['review']);
  });

  it('says nothing at all when discovery is not configured', async () => {
    const { handle, faux } = await runtime({ skills: undefined });
    const prompts: string[] = [];
    faux.setResponses([
      (context) => {
        prompts.push(context.systemPrompt ?? '');
        return fauxAssistantMessage('done');
      },
    ]);
    await handle.run({ prompt: 'hello' });
    expect(prompts[0]).not.toContain('available_skills');
    expect(handle.skills).toBeUndefined();
  });

  it('loads a skill outside the workspace through the tool without asking for approval', async () => {
    const { handle, faux } = await runtime({
      // No `approve` at all: the permission engine throws "approval UI is not
      // connected" if anything reaches the ask path, so this run PROVES the
      // skill tool never gates. That is the property the tool exists for — the
      // same file read through `read` would be outside cwd and therefore `ask`.
      permissions: { gear: 'ask' },
    });
    faux.setResponses([skillCall('pdf'), fauxAssistantMessage('loaded')]);
    const results: string[] = [];
    const result = await handle.run({
      prompt: 'use the pdf skill',
      onEvent: (event) => {
        if (event.type === 'tool_execution_end' && event.toolName === 'skill') {
          for (const part of event.result.content)
            if (part.type === 'text') results.push(part.text);
        }
      },
    });
    expect(result.success).toBe(true);
    expect(results.join('\n')).toContain('STEP ONE: open the file.');
    expect(results.join('\n')).toContain('location=');
  });

  // T002/skills-mcp-11 — before the fix, the `skill` tool never called
  // `authorize` at all, so `permission.activity` had no row proving a skill
  // load was ever gated. `source: 'policy'` (not `'session-grant'`) also
  // proves this was the bundled default's `allow`, not a leftover grant.
  it('records a permission.activity row for the skill tool', async () => {
    const { handle, faux } = await runtime({ permissions: { gear: 'ask' } });
    const decisions: Array<{ decision: string; source: string }> = [];
    const unsubscribe = handle.ctx.runtimePermissions.onActivity((record) => {
      if (record.phase === 'decision' && record.request.tool === 'skill')
        decisions.push({ decision: record.decision, source: record.source });
    });
    faux.setResponses([skillCall('pdf'), fauxAssistantMessage('loaded')]);
    await handle.run({ prompt: 'use the pdf skill' });
    unsubscribe();
    expect(decisions).toEqual([{ decision: 'allow', source: 'policy' }]);
  });

  // T002/skills-mcp-11 — before the fix, the `skill` tool read the file
  // straight off the catalog with no gate at all, so a managed environment's
  // `"skill": "deny"` (or a per-name deny) could not stop it.
  it('lets an explicit skill deny policy rule actually block the tool call', async () => {
    await policy({ permission: { skill: 'deny' } });
    const { handle, faux } = await runtime({ permissions: { gear: 'auto' } });
    faux.setResponses([skillCall('pdf'), fauxAssistantMessage('blocked')]);
    let errored = false;
    const result = await handle.run({
      prompt: 'use the pdf skill',
      onEvent: (event) => {
        if (event.type === 'tool_execution_end' && event.toolName === 'skill')
          errored = event.isError;
      },
    });
    expect(result.success).toBe(true);
    expect(errored).toBe(true);
  });

  // T002/skills-mcp-11 — `/skill:name` expansion read the body through the
  // exact same unguarded path as the tool; a deny rule has to reach it too.
  it('lets an explicit skill deny policy rule block /skill:name expansion', async () => {
    await policy({ permission: { skill: { pdf: 'deny' } } });
    const { handle } = await runtime({ permissions: { gear: 'auto' } });
    await expect(handle.skills?.expand('/skill:pdf')).rejects.toMatchObject({
      code: 'tool_denied',
    });
  });

  it('answers an unknown skill name with the list instead of failing the turn', async () => {
    const { handle, faux } = await runtime();
    faux.setResponses([skillCall('nope'), fauxAssistantMessage('ok')]);
    const texts: string[] = [];
    const result = await handle.run({
      prompt: 'use nope',
      onEvent: (event) => {
        if (event.type === 'tool_execution_end' && event.toolName === 'skill') {
          expect(event.isError).toBeFalsy();
          for (const part of event.result.content) if (part.type === 'text') texts.push(part.text);
        }
      },
    });
    expect(result.success).toBe(true);
    expect(texts.join('\n')).toContain('No skill named "nope"');
    expect(texts.join('\n')).toContain('Available: pdf');
  });

  it('expands what the user typed against the live catalog', async () => {
    const { handle } = await runtime();
    await expect(handle.skills?.expand('/review HEAD~1')).resolves.toEqual({
      expanded: true,
      text: 'Review HEAD~1 carefully.',
      invocation: { kind: 'template', name: 'review', args: 'HEAD~1' },
    });
    const skill = await handle.skills?.expand('/skill:pdf');
    expect(skill).toMatchObject({ expanded: true });
    if (skill?.expanded) expect(skill.text).toContain('STEP ONE: open the file.');
  });

  // skills-mcp-25 — the catalog knows about a skill (it was there at scan
  // time) but the file is gone by the time the tool reads it; the fallback
  // text at index.ts:225-235 was never covered.
  it('answers the skill tool fallback text when the catalog file can no longer be read', async () => {
    const { handle, faux } = await runtime();
    await rm(join(agentDir, 'skills', 'pdf', 'SKILL.md'));
    faux.setResponses([skillCall('pdf'), fauxAssistantMessage('done')]);
    const texts: string[] = [];
    let errored = false;
    const result = await handle.run({
      prompt: 'use the pdf skill',
      onEvent: (event) => {
        if (event.type === 'tool_execution_end' && event.toolName === 'skill') {
          errored = event.isError;
          for (const part of event.result.content) if (part.type === 'text') texts.push(part.text);
        }
      },
    });
    expect(result.success).toBe(true);
    expect(errored).toBeFalsy();
    expect(texts.join('\n')).toContain('could not be read from');
  });

  // skills-mcp-20 — the catalog is a snapshot from worker start; `refresh()`
  // is the missing capability that lets a newly installed skill (or template)
  // become visible without a worker restart.
  it('picks up a newly installed skill and template after refresh()', async () => {
    const { handle, faux } = await runtime();
    let prompt = '';
    faux.setResponses([
      (context) => {
        prompt = context.systemPrompt ?? '';
        return fauxAssistantMessage('done');
      },
    ]);
    await handle.run({ prompt: 'hello' });
    expect(prompt).not.toContain('<name>new-skill</name>');
    expect(handle.skills?.templates.map((item) => item.name)).not.toContain('new-template');

    await mkdir(join(agentDir, 'skills', 'new-skill'), { recursive: true });
    await writeFile(
      join(agentDir, 'skills', 'new-skill', 'SKILL.md'),
      front('new-skill', 'Installed after the worker started')
    );
    await writeFile(
      join(agentDir, 'prompts', 'new-template.md'),
      '---\ndescription: Installed after the worker started\n---\nBody.\n'
    );
    await handle.skills?.refresh();

    let prompt2 = '';
    faux.setResponses([
      (context) => {
        prompt2 = context.systemPrompt ?? '';
        return fauxAssistantMessage('done');
      },
    ]);
    await handle.run({ prompt: 'hello again' });
    expect(prompt2).toContain('<name>new-skill</name>');
    expect(handle.skills?.templates.map((item) => item.name)).toContain('new-template');
  });
});
