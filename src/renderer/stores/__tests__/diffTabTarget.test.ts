import { describe, expect, it } from 'vitest';
import { diffTabPath, diffTabTitle } from '../diffTabTarget';

describe('diffTabPath', () => {
  it('uses a git-diff:// scheme so it can never collide with a real fs path', () => {
    const path = diffTabPath({ kind: 'workdir', path: 'src/a.ts', staged: false });
    expect(path.startsWith('git-diff://')).toBe(true);
  });

  it('keys a workdir target by staged/unstaged AND path — staged and unstaged are distinct tabs', () => {
    const unstaged = diffTabPath({ kind: 'workdir', path: 'src/a.ts', staged: false });
    const staged = diffTabPath({ kind: 'workdir', path: 'src/a.ts', staged: true });
    expect(unstaged).not.toBe(staged);
  });

  it('re-deriving the SAME workdir target twice yields the SAME path (reuse-not-duplicate key)', () => {
    const target = { kind: 'workdir' as const, path: 'src/a.ts', staged: true };
    expect(diffTabPath(target)).toBe(diffTabPath({ ...target }));
  });

  it('keys a commit target by hash AND path — same file in two commits is two distinct tabs', () => {
    const a = diffTabPath({ kind: 'commit', path: 'src/a.ts', hash: 'abc123' });
    const b = diffTabPath({ kind: 'commit', path: 'src/a.ts', hash: 'def456' });
    expect(a).not.toBe(b);
  });

  it('a workdir and a commit target for the same path never collide', () => {
    const workdir = diffTabPath({ kind: 'workdir', path: 'src/a.ts', staged: false });
    const commit = diffTabPath({ kind: 'commit', path: 'src/a.ts', hash: 'abc123' });
    expect(workdir).not.toBe(commit);
  });

  it('ends in the real relative path — EditorTabs.tsx file-icon lookup keys off the extension', () => {
    const path = diffTabPath({ kind: 'workdir', path: 'src/components/Foo.tsx', staged: false });
    expect(path.endsWith('src/components/Foo.tsx')).toBe(true);
  });
});

describe('diffTabTitle', () => {
  it('formats a workdir tab as "filename · STATUS" (spec example: ChangesList.tsx · M)', () => {
    expect(
      diffTabTitle({ kind: 'workdir', path: 'src/ChangesList.tsx', staged: false, status: 'M' })
    ).toBe('ChangesList.tsx · M');
  });

  it('drops the "· STATUS" suffix entirely when no status is known', () => {
    expect(diffTabTitle({ kind: 'workdir', path: 'src/ChangesList.tsx', staged: false })).toBe(
      'ChangesList.tsx'
    );
  });

  it('formats a commit tab as "filename @ short-hash" (spec example: ChangesList.tsx @ 9b17dc6)', () => {
    expect(
      diffTabTitle({ kind: 'commit', path: 'src/ChangesList.tsx', hash: '9b17dc6abcdef0123' })
    ).toBe('ChangesList.tsx @ 9b17dc6');
  });

  it('does not truncate a hash already shorter than 7 chars', () => {
    expect(diffTabTitle({ kind: 'commit', path: 'a.ts', hash: 'abc' })).toBe('a.ts @ abc');
  });

  it('uses only the filename, not the full relative path', () => {
    expect(
      diffTabTitle({
        kind: 'workdir',
        path: 'src/deep/nested/dir/File.ts',
        staged: true,
        status: 'A',
      })
    ).toBe('File.ts · A');
  });
});
