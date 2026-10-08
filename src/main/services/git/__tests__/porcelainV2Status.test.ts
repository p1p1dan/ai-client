import { describe, expect, it } from 'vitest';
import { PorcelainV2StatusAccumulator, parsePorcelainV2Status } from '../porcelainV2Status';

/**
 * The record parser shared by the streaming `git status` reader and the F3
 * node-runner fallback. Fixtures are real `git status --porcelain=v2 --branch
 * -z --untracked-files=normal` output (git 2.53), captured from scratch repos
 * and only re-joined with NUL here.
 */

const z = (records: string[]): string => records.map((record) => `${record}\0`).join('');

const WORKTREE_RECORDS = [
  '# branch.oid a137f7993853cd1a8c6b3f454fd4ce3d0e0ab671',
  '# branch.head main',
  '# branch.upstream origin/main',
  '# branch.ab +2 -3',
  '1 MM N... 100644 100644 100644 f2ad6c76f0115a6ba5b00456a849810e7ec0af20 b51b4b797587fb260d20338ae19470758254e48c both.txt',
  '2 R. N... 100644 100644 100644 6a69f92020f5df77af6e8813ff1232493383b708 6a69f92020f5df77af6e8813ff1232493383b708 R100 new name.txt',
  'old-name.txt',
  '1 D. N... 100644 000000 000000 4bcfe98e640c8284511312660fb8709b0afa888e 0000000000000000000000000000000000000000 staged-del.txt',
  '1 M. N... 100644 100644 100644 61780798228d17af2d34fce4cfbdf35556832472 0505b3b1df17e3fedbe98668cf073a5649215560 staged.txt',
  '1 .M N... 100644 100644 100644 78981922613b2afb6025042ff6bd878ac1994e85 78981922613b2afb6025042ff6bd878ac1994e85 unstaged.txt',
  '1 .M N... 100644 100644 100644 01058d844a98d293a3b03a8615a34700e4ed2be3 01058d844a98d293a3b03a8615a34700e4ed2be3 with space.txt',
  '1 .D N... 100644 100644 000000 d905d9da82c97264ab6f4920e20242e088850ce9 d905d9da82c97264ab6f4920e20242e088850ce9 wt-del.txt',
  '1 .M N... 100644 100644 100644 6e9f0da13f19b444ec3a9c3d6e795ad35c0554a2 6e9f0da13f19b444ec3a9c3d6e795ad35c0554a2 中文 文件.md',
  '? untracked 新.txt',
];

const CONFLICT_RECORDS = [
  '# branch.oid 13f1774239b8dee65a43d2d8240f873f034689e2',
  '# branch.head main',
  'u AA N... 000000 100644 100644 100644 0000000000000000000000000000000000000000 b7be8a680d94b3621bcd9b8fb3d96f13fcab84e1 94f47e36cca8cd06ae43b87fead04591f986f4bf aa.txt',
  'u AU N... 000000 100644 000000 100644 0000000000000000000000000000000000000000 df967b96a579e45a18b8251732d16804b2e56a55 0000000000000000000000000000000000000000 dd-main.txt',
  'u UA N... 000000 000000 100644 100644 0000000000000000000000000000000000000000 0000000000000000000000000000000000000000 df967b96a579e45a18b8251732d16804b2e56a55 dd-other.txt',
  'u DD N... 100644 000000 000000 000000 df967b96a579e45a18b8251732d16804b2e56a55 0000000000000000000000000000000000000000 0000000000000000000000000000000000000000 dd.txt',
  'u UU N... 100644 100644 100644 100644 df967b96a579e45a18b8251732d16804b2e56a55 ba2906d0666cf726c7eaadd2cd3db615dedfdf3a e45c9c2666d44e0327c1f9c239a74c508336053e conflict file.txt',
];

const SUBMODULE_RECORDS = [
  '# branch.oid 5c91b4e6cac7628889ab04473b9f9c78b3722d5e',
  '# branch.head main',
  // Modified content inside the submodule (short format: " m").
  '1 .M S.M. 160000 160000 160000 ef2eb85a979638d986ff13ba26f9f170323464bf ef2eb85a979638d986ff13ba26f9f170323464bf mods/sub-a',
  // Untracked content inside the submodule (short format: " ?").
  '1 .M S..U 160000 160000 160000 ef2eb85a979638d986ff13ba26f9f170323464bf ef2eb85a979638d986ff13ba26f9f170323464bf mods/sub-b',
];

describe('parsePorcelainV2Status classifies every record by its XY sides', () => {
  const { status, sawBranchHeader, entries } = parsePorcelainV2Status(z(WORKTREE_RECORDS), 5000);

  it('reads the branch headers', () => {
    expect(sawBranchHeader).toBe(true);
    expect(status).toMatchObject({
      current: 'main',
      tracking: 'origin/main',
      ahead: 2,
      behind: 3,
      truncated: false,
    });
    // The rename's original-path record is not an entry of its own.
    expect(entries).toBe(9);
  });

  it('files an unstaged-only edit as modified, not staged', () => {
    expect(status.modified).toContain('unstaged.txt');
    expect(status.staged).not.toContain('unstaged.txt');
  });

  it('files a staged-only edit as staged, not modified', () => {
    expect(status.staged).toContain('staged.txt');
    expect(status.modified).not.toContain('staged.txt');
  });

  it('files an edit on both sides as staged and modified', () => {
    expect(status.staged).toContain('both.txt');
    expect(status.modified).toContain('both.txt');
  });

  it('files a staged delete as staged only', () => {
    expect(status.staged).toContain('staged-del.txt');
    expect(status.deleted).not.toContain('staged-del.txt');
    expect(status.modified).not.toContain('staged-del.txt');
  });

  it('files a worktree delete as deleted, not staged or modified', () => {
    expect(status.deleted).toContain('wt-del.txt');
    expect(status.staged).not.toContain('wt-del.txt');
    expect(status.modified).not.toContain('wt-del.txt');
  });

  it('records a rename under its new path and drops the original path', () => {
    expect(status.staged).toContain('new name.txt');
    const all = [
      ...status.staged,
      ...status.modified,
      ...status.deleted,
      ...status.untracked,
      ...status.conflicted,
    ];
    expect(all).not.toContain('old-name.txt');
    expect(all).not.toContain('name.txt');
    expect(all).not.toContain('R100 new name.txt');
  });

  it('keeps whole paths with spaces and non-ASCII characters, unquoted', () => {
    expect(status.modified).toContain('with space.txt');
    expect(status.modified).not.toContain('space.txt');
    expect(status.modified).toContain('中文 文件.md');
    expect(status.modified).not.toContain('文件.md');
    expect(status.untracked).toEqual(['untracked 新.txt']);
    expect(JSON.stringify(status)).not.toMatch(/\\\d{3}/);
  });

  it('reports nothing as conflicted', () => {
    expect(status.conflicted).toEqual([]);
  });
});

describe('parsePorcelainV2Status treats unmerged entries as conflicts only', () => {
  const { status } = parsePorcelainV2Status(z(CONFLICT_RECORDS), 5000);

  it.each([
    ['AA', 'aa.txt'],
    ['AU', 'dd-main.txt'],
    ['UA', 'dd-other.txt'],
    ['DD', 'dd.txt'],
    ['UU', 'conflict file.txt'],
  ])('%s', (_xy, file) => {
    expect(status.conflicted).toContain(file);
    expect(status.staged).not.toContain(file);
    expect(status.modified).not.toContain(file);
    expect(status.deleted).not.toContain(file);
  });

  it('lists each conflict once', () => {
    expect(status.conflicted).toHaveLength(5);
  });
});

describe('parsePorcelainV2Status branch states', () => {
  it('names the branch of an unborn repository', () => {
    const { status, sawBranchHeader } = parsePorcelainV2Status(
      z(['# branch.oid (initial)', '# branch.head trunk']),
      5000
    );
    expect(sawBranchHeader).toBe(true);
    expect(status.current).toBe('trunk');
  });

  it('reports a detached HEAD as no current branch', () => {
    const { status } = parsePorcelainV2Status(
      z(['# branch.oid b8c47c2b849b3747251f0251ca65de9d6e7258fd', '# branch.head (detached)']),
      5000
    );
    expect(status.current).toBeNull();
    expect(status.tracking).toBeNull();
  });

  it('keeps a gone upstream with zero ahead/behind', () => {
    // `git status` omits `# branch.ab` when the upstream ref no longer exists.
    const { status } = parsePorcelainV2Status(
      z([
        '# branch.oid 2f440a229c03ca3b56dc60b412949976a0d99c30',
        '# branch.head feature',
        '# branch.upstream origin/feature',
      ]),
      5000
    );
    expect(status).toMatchObject({
      current: 'feature',
      tracking: 'origin/feature',
      ahead: 0,
      behind: 0,
    });
  });

  it('files submodule content changes as modified', () => {
    const { status } = parsePorcelainV2Status(z(SUBMODULE_RECORDS), 5000);
    expect(status.modified).toEqual(['mods/sub-a', 'mods/sub-b']);
    expect(status.untracked).toEqual([]);
    expect(status.staged).toEqual([]);
  });

  it('reports output without branch headers as such', () => {
    const { sawBranchHeader, entries } = parsePorcelainV2Status('', 5000);
    expect(sawBranchHeader).toBe(false);
    expect(entries).toBe(0);
  });

  it('ignores an unterminated trailing fragment, like the streaming reader', () => {
    const { status } = parsePorcelainV2Status(
      `${z(['# branch.oid deadbeef', '# branch.head main'])}? half-writ`,
      5000
    );
    expect(status.untracked).toEqual([]);
  });
});

describe('parsePorcelainV2Status truncation', () => {
  it('stops at maxEntries and marks the result truncated', () => {
    const { status, entries } = parsePorcelainV2Status(z(WORKTREE_RECORDS), 3);
    expect(entries).toBe(3);
    expect(status.truncated).toBe(true);
    expect(status.staged).toEqual(['both.txt', 'new name.txt', 'staged-del.txt']);
    expect(status.modified).toEqual(['both.txt']);
    expect(status.untracked).toEqual([]);
  });

  it('does not count the rename original path toward the cap', () => {
    const { status, entries } = parsePorcelainV2Status(z(WORKTREE_RECORDS), 2);
    expect(entries).toBe(2);
    expect(status.truncated).toBe(true);
    expect(status.staged).toEqual(['both.txt', 'new name.txt']);
    expect(status.staged).not.toContain('old-name.txt');
  });

  it('is not truncated below the cap', () => {
    expect(parsePorcelainV2Status(z(WORKTREE_RECORDS), 10).status.truncated).toBe(false);
  });
});

describe('PorcelainV2StatusAccumulator fed record by record', () => {
  it('matches the whole-output parse', () => {
    const accumulator = new PorcelainV2StatusAccumulator(5000);
    for (const record of WORKTREE_RECORDS) accumulator.push(record);
    expect(accumulator.result()).toEqual(parsePorcelainV2Status(z(WORKTREE_RECORDS), 5000).status);
  });

  it('ignores everything after truncation', () => {
    const accumulator = new PorcelainV2StatusAccumulator(1);
    accumulator.push('# branch.head main');
    accumulator.push(
      '1 .M N... 100644 100644 100644 78981922613b2afb6025042ff6bd878ac1994e85 78981922613b2afb6025042ff6bd878ac1994e85 a.txt'
    );
    expect(accumulator.truncated).toBe(true);
    accumulator.push('# branch.head other');
    accumulator.push('? b.txt');
    expect(accumulator.result()).toMatchObject({
      current: 'main',
      modified: ['a.txt'],
      untracked: [],
    });
  });
});
