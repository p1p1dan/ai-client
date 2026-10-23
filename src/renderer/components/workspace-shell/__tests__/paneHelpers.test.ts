import { describe, expect, it } from 'vitest';
import type { SessionReviewEntry } from '../sessionReview';
import { fileForChangeFocus, groupReviewByFile, shortenDir } from '../sessionReviewFiles';
import { filterFileTree, parseFileFilter } from '../surfaces/fileTreeFilter';

/** Layout 5d: the diff pane's file list and the files pane's filter box. */

function entry(id: string, path: string, overrides: Partial<SessionReviewEntry> = {}) {
  return { id, path, status: 'modified', added: 2, removed: 1, ...overrides } as SessionReviewEntry;
}

describe('groupReviewByFile (the diff pane lists files)', () => {
  it('one row per path in first-change order, its changes inside in order', () => {
    const files = groupReviewByFile([
      entry('m1:a', 'src/a.ts'),
      entry('m1:b', 'b.md', { status: 'added' }),
      entry('m2:a', 'src/a.ts', { added: 5, removed: 0 }),
    ]);
    expect(files.map((file) => file.path)).toEqual(['src/a.ts', 'b.md']);
    expect(files[0]).toMatchObject({
      name: 'a.ts',
      dir: 'src',
      added: 7,
      removed: 1,
      created: false,
    });
    expect(files[0]?.entries.map((item) => item.id)).toEqual(['m1:a', 'm2:a']);
    expect(files[1]).toMatchObject({ name: 'b.md', dir: '', created: true });
  });

  it('does not count a change that has no diff, and says when none has one', () => {
    const [file] = groupReviewByFile([
      entry('x', 'C:\\repo\\big.bin', { unavailable: 'binary', added: 0, removed: 0 }),
    ]);
    expect(file).toMatchObject({ name: 'big.bin', dir: 'C:/repo', unavailable: true, added: 0 });
  });

  it('finds the change card`s file by entry, then by path', () => {
    const files = groupReviewByFile([entry('m1:a', 'a.ts'), entry('m1:b', 'b.ts')]);
    expect(fileForChangeFocus(files, { entryId: 'm1:b', path: 'zzz' })?.path).toBe('b.ts');
    expect(fileForChangeFocus(files, { entryId: 'gone', path: 'a.ts' })?.path).toBe('a.ts');
    expect(fileForChangeFocus(files, { entryId: 'gone', path: 'c.ts' })).toBeUndefined();
  });

  it('shortens a long directory in the middle', () => {
    expect(shortenDir('backend/src')).toBe('backend/src');
    const short = shortenDir('backend/src/main/java/com/example/report/dto', 28);
    expect(short.length).toBeLessThanOrEqual(28);
    expect(short.startsWith('backend/src/')).toBe(true);
    expect(short.endsWith('report/dto')).toBe(true);
    expect(short).toContain('…');
  });
});

describe('the files pane filter', () => {
  const tree = [
    {
      name: 'src',
      path: '/r/src',
      isDirectory: true,
      children: [
        { name: 'app.ts', path: '/r/src/app.ts', isDirectory: false },
        {
          name: 'lib',
          path: '/r/src/lib',
          isDirectory: true,
          children: [{ name: 'apply.ts', path: '/r/src/lib/apply.ts', isDirectory: false }],
        },
      ],
    },
    { name: 'README.md', path: '/r/README.md', isDirectory: false },
    { name: 'apps', path: '/r/apps', isDirectory: true },
  ];

  it('an empty query leaves the tree alone', () => {
    const result = filterFileTree(tree, '  ');
    expect(result.nodes).toEqual(tree);
    expect(result.expand.size).toBe(0);
  });

  it('keeps matches and their folders, opening the folders on the way', () => {
    const result = filterFileTree(tree, 'APP');
    expect(result.matches).toBe(3);
    expect(result.nodes.map((node) => node.name)).toEqual(['src', 'apps']);
    expect(result.nodes[0]?.children?.map((node) => node.name)).toEqual(['app.ts', 'lib']);
    expect([...result.expand].sort()).toEqual(['/r/src', '/r/src/lib']);
  });

  it('`?text` asks for a content search instead', () => {
    expect(parseFileFilter('?  needle ')).toEqual({ kind: 'content', text: 'needle' });
    expect(parseFileFilter(' app ')).toEqual({ kind: 'name', text: 'app' });
  });
});
