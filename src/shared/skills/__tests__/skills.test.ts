/**
 * P5-1 gate, the pure half — skills and prompt templates.
 *
 * Moved from `src/runtime/__tests__/skills.test.ts` (dsh-rebase P1-16 prep)
 * with the library it pins; the case bodies are unchanged, only the imports
 * point at `src/shared/skills` and the host-IO fakes are typed against the
 * library's own port. The wired half went with the runtime in P1-12 step 3,
 * and so did slash expansion (`expand.ts`, decision 103 rule 3): DSH loads
 * and runs skills natively (decision 101), and what is left here feeds the
 * legacy-asset notice.
 *
 * The loader runs against an in-memory tree through {@link SkillSource}, the
 * same way `projectInstructions.test.ts` does. Every discovery rule ported
 * from pi is pinned here, because each of them fails SILENTLY: a skill in the
 * wrong kind of root, a missing description, a name that cannot be a command —
 * none of those throws, they just make the user's skill not exist.
 */

import { basename, join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type SkillCatalogFiles, skillRoots, skillSource, templateRoots } from '../catalog.ts';
import {
  loadSkills,
  MAX_DESCRIPTION_BYTES,
  MAX_SKILL_DEPTH,
  MAX_SKILLS,
  parseFrontmatter,
  type SkillDiagnostic,
  type SkillFileKind,
  type SkillRoot,
  type SkillSource,
} from '../loader.ts';
import { loadPromptTemplates, templateBody } from '../templates.ts';

/**
 * In-memory tree. Directories are implied by the keys, as on a real filesystem.
 * `symlinks` maps a symlink's own path to the path it points at (which may or
 * may not exist, and chains of symlinks are followed) — enough to exercise
 * skills-mcp-08 without a real filesystem.
 */
function fakeSource(
  rawFiles: Record<string, string>,
  rawSymlinks: Record<string, string> = {}
): SkillSource {
  // Keys above are written posix-style for readability, while the loader builds
  // every path it looks up with `join()`. Normalise both sides through the same
  // `join()` so the fake matches the way a real filesystem would.
  const files: Record<string, string> = Object.fromEntries(
    Object.entries(rawFiles).map(([path, text]) => [join(path), text])
  );
  const symlinks: Record<string, string> = Object.fromEntries(
    Object.entries(rawSymlinks).map(([path, target]) => [join(path), join(target)])
  );
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
  const resolveFullPath = (rawPath: string, seen = new Set<string>()): string => {
    const path = join(rawPath);
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
    const children = new Map<string, SkillFileKind>();
    for (const file of Object.keys(files)) {
      if (!file.startsWith(`${dir}${sep}`)) continue;
      const rest = file.slice(dir.length + 1);
      const slash = rest.indexOf(sep);
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
const NO_GIT: Pick<SkillCatalogFiles, 'stat'> = {
  async stat() {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  },
};

/** `.git` exists at exactly `repoRoot` and nowhere else in the climb. */
function gitAt(repoRoot: string): Pick<SkillCatalogFiles, 'stat'> {
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
    } as unknown as SkillCatalogFiles;
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
