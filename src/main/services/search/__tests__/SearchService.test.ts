import { describe, expect, it } from 'vitest';
import {
  collectDirectoryEntries,
  compareFileResults,
  rankFileEntries,
  type SearchFileEntry,
  toPosixRelative,
} from '../SearchService';

/**
 * Regression: `path.relative` returns backslashes on win32, and the `@` mention
 * chain treats `relativePath` as a POSIX string end to end — fuzzy queries are
 * matched against it, `lastIndexOf('/')` splits it for the popup's directory
 * suffix, and it is inserted verbatim as `@<path>`. A backslash value broke all
 * three: `@src/renderer` scored zero, the directory suffix never rendered, and
 * the inserted mention carried backslashes downstream.
 *
 * These assertions hold on every platform (on POSIX hosts `path.relative`
 * already yields forward slashes); on win32 they fail without the normalization.
 */
describe('toPosixRelative', () => {
  it('returns forward slashes for a nested path', () => {
    const rel = toPosixRelative('/repo', '/repo/src/renderer/components/Chat.tsx');
    expect(rel).toBe('src/renderer/components/Chat.tsx');
  });

  it('never emits a backslash', () => {
    const rel = toPosixRelative('/repo', '/repo/src/main/AGENTS.md');
    expect(rel).not.toContain('\\');
  });

  it('keeps a slash-containing query matchable as a substring', () => {
    const rel = toPosixRelative('/repo', '/repo/src/renderer/index.ts');
    expect(rel.includes('src/renderer')).toBe(true);
  });

  it('splits into directory and file parts the way the popup does', () => {
    const rel = toPosixRelative('/repo', '/repo/docs/design-system.md');
    const lastSep = rel.lastIndexOf('/');
    expect(lastSep).toBeGreaterThan(0);
    expect(rel.slice(0, lastSep)).toBe('docs');
    expect(rel.slice(lastSep + 1)).toBe('design-system.md');
  });

  it('leaves a root-level file without a directory part', () => {
    const rel = toPosixRelative('/repo', '/repo/CLAUDE.md');
    expect(rel).toBe('CLAUDE.md');
    expect(rel.lastIndexOf('/')).toBe(-1);
  });
});

/**
 * T-07① directories. `rg --files` only lists files, so a directory could never
 * be picked in the `@` popup — but `@src/renderer` is a legitimate reference
 * (CC reads the whole subtree). Directories are derived from the file list
 * rather than statted, keeping this a pure function over rg's output.
 */
function file(relativePath: string): SearchFileEntry {
  return {
    path: `/repo/${relativePath}`,
    name: relativePath.slice(relativePath.lastIndexOf('/') + 1),
    relativePath,
    isDirectory: false,
  };
}

describe('collectDirectoryEntries', () => {
  it('derives every ancestor directory level from file paths', () => {
    const dirs = collectDirectoryEntries('/repo', [
      file('src/renderer/components/Chat.tsx'),
      file('src/main/index.ts'),
    ]);
    expect(dirs.map((d) => d.relativePath).sort()).toEqual([
      'src',
      'src/main',
      'src/renderer',
      'src/renderer/components',
    ]);
  });

  it('marks entries as directories and names them by their last segment', () => {
    const [dir] = collectDirectoryEntries('/repo', [file('docs/plans/ard.md')]).filter(
      (d) => d.relativePath === 'docs/plans'
    );
    expect(dir.isDirectory).toBe(true);
    expect(dir.name).toBe('plans');
  });

  it('deduplicates directories shared by many files', () => {
    const dirs = collectDirectoryEntries('/repo', [
      file('src/a.ts'),
      file('src/b.ts'),
      file('src/c.ts'),
    ]);
    expect(dirs.filter((d) => d.relativePath === 'src')).toHaveLength(1);
  });

  it('yields no directories when every file sits at the root', () => {
    expect(collectDirectoryEntries('/repo', [file('README.md')])).toEqual([]);
  });

  it('builds absolute directory paths under the root', () => {
    const [dir] = collectDirectoryEntries('/repo', [file('src/index.ts')]);
    expect(dir.path.replace(/\\/g, '/')).toBe('/repo/src');
  });

  it('ignores entries that are already directories', () => {
    const dirs = collectDirectoryEntries('/repo', [
      { path: '/repo/src', name: 'src', relativePath: 'src', isDirectory: true },
    ]);
    expect(dirs).toEqual([]);
  });
});

/**
 * T-07④ deterministic ordering. Equal fuzzy scores previously fell back to
 * whatever order ripgrep emitted, so the popup's top hit could shift between
 * identical queries and no assertion could pin it.
 */
describe('compareFileResults', () => {
  it('ranks a higher score first', () => {
    const a = { ...file('z.ts'), score: 900 };
    const b = { ...file('a.ts'), score: 100 };
    expect(compareFileResults(a, b)).toBeLessThan(0);
  });

  it('breaks score ties by shallower path depth', () => {
    const shallow = { ...file('chat.ts'), score: 500 };
    const deep = { ...file('src/renderer/components/chat.ts'), score: 500 };
    expect(compareFileResults(shallow, deep)).toBeLessThan(0);
  });

  it('breaks depth ties alphabetically for a stable order', () => {
    const a = { ...file('src/a.ts'), score: 500 };
    const b = { ...file('src/b.ts'), score: 500 };
    expect(compareFileResults(a, b)).toBeLessThan(0);
    expect(compareFileResults(b, a)).toBeGreaterThan(0);
  });

  it('is antisymmetric so sort order is independent of input order', () => {
    const entries = [
      { ...file('src/renderer/x.ts'), score: 500 },
      { ...file('x.ts'), score: 500 },
      { ...file('src/x.ts'), score: 500 },
    ];
    const forward = [...entries].sort(compareFileResults).map((e) => e.relativePath);
    const backward = [...entries]
      .reverse()
      .sort(compareFileResults)
      .map((e) => e.relativePath);
    expect(forward).toEqual(backward);
    expect(forward).toEqual(['x.ts', 'src/x.ts', 'src/renderer/x.ts']);
  });
});

/**
 * T-07③ truncation is reported rather than silent. Searching `chat` in this repo
 * matched 304 files while the popup showed 10, with no indication more existed.
 * The page is an explicit `{items, total, truncated}` wrapper: only own
 * enumerable properties survive structured clone across the IPC bridge, so
 * bolting `total` onto the array would have silently lost it in the Renderer.
 */
describe('rankFileEntries', () => {
  const entries: SearchFileEntry[] = [
    file('src/renderer/components/chat/ChatComposer.tsx'),
    file('src/renderer/components/chat/MessageTimeline.tsx'),
    file('src/renderer/components/chat/fileMention.ts'),
    file('docs/design-system.md'),
  ];

  it('reports the pre-truncation total alongside a truncated page', () => {
    const page = rankFileEntries(entries, 'chat', 2);
    expect(page.items).toHaveLength(2);
    expect(page.total).toBe(3);
    expect(page.truncated).toBe(true);
  });

  it('is not truncated when everything fits', () => {
    const page = rankFileEntries(entries, 'chat', 10);
    expect(page.total).toBe(page.items.length);
    expect(page.truncated).toBe(false);
  });

  it('survives a structured-clone round trip with total intact', () => {
    // The IPC bridge clones this; a non-enumerable `total` would vanish here.
    const page = rankFileEntries(entries, 'chat', 2);
    const cloned = structuredClone(page);
    expect(cloned.total).toBe(3);
    expect(cloned.truncated).toBe(true);
    expect(cloned.items).toHaveLength(2);
  });

  it('drops non-matching entries entirely', () => {
    const page = rankFileEntries(entries, 'design', 10);
    expect(page.items.map((r) => r.relativePath)).toEqual(['docs/design-system.md']);
    expect(page.total).toBe(1);
  });

  it('returns a path-sorted page with a full total for an empty query', () => {
    const page = rankFileEntries(entries, '   ', 2);
    expect(page.items).toHaveLength(2);
    expect(page.total).toBe(4);
    expect(page.truncated).toBe(true);
    expect(page.items[0].relativePath).toBe('docs/design-system.md');
  });

  it('applies the deterministic tie-break to ranked output', () => {
    const sameName: SearchFileEntry[] = [
      file('src/renderer/deep/index.ts'),
      file('index.ts'),
      file('src/index.ts'),
    ];
    const page = rankFileEntries(sameName, 'index.ts', 10);
    expect(page.items.map((r) => r.relativePath)).toEqual([
      'index.ts',
      'src/index.ts',
      'src/renderer/deep/index.ts',
    ]);
  });

  it('lets a directory entry match and survive ranking', () => {
    const withDir: SearchFileEntry[] = [
      file('src/renderer/index.ts'),
      {
        path: '/repo/src/renderer',
        name: 'renderer',
        relativePath: 'src/renderer',
        isDirectory: true,
      },
    ];
    const page = rankFileEntries(withDir, 'renderer', 10);
    expect(page.items.some((r) => r.isDirectory && r.relativePath === 'src/renderer')).toBe(true);
  });
});
