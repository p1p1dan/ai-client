import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loadSkillCatalog,
  MAX_SCAN_BYTES,
  readCatalogBody,
  rescanSkillCatalog,
  type SkillCatalogFiles,
} from '../catalog.ts';
import type { SkillFileKind } from '../loader.ts';

/**
 * dsh-rebase P1-16 prep — the seam a host plugs into the shared skills library.
 *
 * The discovery rules are pinned by `skills.test.ts` next to this file and by
 * the runtime's wired suite, which runs this library through the runtime's
 * thin wrappers. What is new is only the injection: the three file calls a
 * host brings ({@link SkillCatalogFiles}). They are exercised here over an
 * in-memory tree with no runtime and no Cordis — the shape a DSH host (P1-16a
 * compatibility report, P1-16c templates) will drive it in.
 */

const coded = (code: string) => Object.assign(new Error(code), { code });

/** A host file port over an in-memory tree; directories are implied by the keys. */
function memoryFiles(
  initial: Record<string, string>,
  failures: { stat?: Record<string, string>; list?: Record<string, string> } = {}
): SkillCatalogFiles & { files: Record<string, string> } {
  const files: Record<string, string> = Object.fromEntries(
    Object.entries(initial).map(([path, text]) => [join(path), text])
  );
  const isDirectory = (path: string) =>
    Object.keys(files).some((file) => file.startsWith(`${path}/`) || file.startsWith(`${path}\\`));
  return {
    files,
    async readFile(path, options) {
      const text = files[join(path)];
      if (text === undefined) throw coded('ENOENT');
      const bytes = Buffer.from(text, 'utf8');
      const truncated = bytes.length > options.maxBytes;
      return { bytes: truncated ? bytes.subarray(0, options.maxBytes) : bytes, truncated };
    },
    async *readDirectory(path) {
      const dir = join(path);
      if (failures.list?.[dir]) throw coded(failures.list[dir]);
      if (!isDirectory(dir)) throw coded('ENOENT');
      const seen = new Map<string, SkillFileKind>();
      for (const file of Object.keys(files)) {
        if (!file.startsWith(`${dir}/`) && !file.startsWith(`${dir}\\`)) continue;
        const rest = file.slice(dir.length + 1);
        const [head, ...more] = rest.split(/[\\/]/);
        seen.set(head, more.length > 0 ? 'directory' : 'file');
      }
      for (const [name, kind] of seen) yield { name, kind };
    },
    async stat(path) {
      const target = join(path);
      if (failures.stat?.[target]) throw coded(failures.stat[target]);
      if (files[target] !== undefined) return { kind: 'file' };
      if (isDirectory(target)) return { kind: 'directory' };
      throw coded('ENOENT');
    },
  };
}

const skill = (name: string, description: string, body = 'Do the thing.') =>
  `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;

describe('a catalog over a host file port', () => {
  it('scans the user roots and, once trusted, the project roots', async () => {
    const io = memoryFiles({
      '/agent/skills/pdf/SKILL.md': skill('pdf', 'Read PDFs'),
      '/agent/prompts/review.md': '---\ndescription: Review it\n---\nReview $1.\n',
      '/repo/.git/HEAD': 'ref: main',
      '/repo/app/.agents/skills/lint/SKILL.md': skill('lint', 'Lint the app'),
      '/repo/app/.pi/prompts/ship.md': 'Ship it.\n',
    });
    const config = { agentDir: '/agent', cwd: '/repo/app', home: '/home' };

    const untrusted = await loadSkillCatalog(io, config);
    expect(untrusted.skills.map((item) => item.name)).toEqual(['pdf']);
    expect(untrusted.templates.map((item) => item.name)).toEqual(['review']);

    const trusted = await loadSkillCatalog(io, { ...config, projectTrusted: true });
    expect(trusted.skills.map((item) => [item.name, item.scope])).toEqual([
      ['lint', 'project'],
      ['pdf', 'user'],
    ]);
    expect(trusted.templates.map((item) => [item.name, item.scope])).toEqual([
      ['review', 'user'],
      ['ship', 'project'],
    ]);
    // decision 004 — the ancestor walk stopped at the repo root it found.
    expect(trusted.resolvedSkillRoots.map((root) => root.path)).toEqual([
      join('/agent', 'skills'),
      join('/home', '.agents', 'skills'),
      join('/repo', 'app', '.pi', 'skills'),
      join('/repo', '.agents', 'skills'),
      join('/repo', 'app', '.agents', 'skills'),
    ]);
    expect(trusted.diagnostics).toEqual([]);
  });

  it('reads a body past the scan budget, frontmatter stripped', async () => {
    const long = 'x'.repeat(MAX_SCAN_BYTES * 2);
    const io = memoryFiles({ '/agent/skills/big/SKILL.md': skill('big', 'A long one', long) });
    const catalog = await loadSkillCatalog(io, { agentDir: '/agent', home: '/home' });
    expect(catalog.skills.map((item) => item.name)).toEqual(['big']);
    await expect(readCatalogBody(io, catalog.skills[0].filePath)).resolves.toBe(long);
    await expect(readCatalogBody(io, '/agent/skills/gone/SKILL.md')).resolves.toBeUndefined();
  });

  it('re-scans the roots it was built from, not a new configuration', async () => {
    const io = memoryFiles({ '/agent/skills/pdf/SKILL.md': skill('pdf', 'Read PDFs') });
    const first = await loadSkillCatalog(io, { agentDir: '/agent', home: '/home' });
    io.files[join('/agent/skills/new/SKILL.md')] = skill('new', 'Installed later');
    const second = await rescanSkillCatalog(io, first);
    expect(second.skills.map((item) => item.name)).toEqual(['new', 'pdf']);
    expect(second.resolvedSkillRoots).toBe(first.resolvedSkillRoots);
    expect(second.resolvedTemplateRoots).toBe(first.resolvedTemplateRoots);
  });

  it('reads a permission error as "not there" and any other host failure as a failure', async () => {
    const denied = memoryFiles(
      { '/agent/skills/pdf/SKILL.md': skill('pdf', 'Read PDFs') },
      { list: { [join('/home/.agents/skills')]: 'EACCES' } }
    );
    const catalog = await loadSkillCatalog(denied, { agentDir: '/agent', home: '/home' });
    expect(catalog.skills.map((item) => item.name)).toEqual(['pdf']);
    expect(catalog.diagnostics).toEqual([]);

    // On the encrypted target a transport fault is not "the user has no skills".
    const broken = memoryFiles({}, { list: { [join('/agent/skills')]: 'EIO' } });
    const reported = await loadSkillCatalog(broken, { agentDir: '/agent', home: '/home' });
    expect(reported.diagnostics).toEqual([
      { code: 'read_failed', path: join('/agent/skills'), message: 'EIO' },
    ]);

    const unstatable = memoryFiles({}, { stat: { [join('/work/.git')]: 'EIO' } });
    await expect(
      loadSkillCatalog(unstatable, { cwd: '/work', projectTrusted: true, home: '/home' })
    ).rejects.toMatchObject({ code: 'EIO' });
  });
});
