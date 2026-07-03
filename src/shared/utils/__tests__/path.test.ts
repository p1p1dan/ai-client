import { describe, expect, it } from 'vitest';
import { getParentPath, getPathBasename } from '../path';

// ---------------------------------------------------------------------------
// Repro guard for the data-loss bug (P-20260703-001)
//
// Windows FILE_LIST returns node.path via node:path.join, which emits
// backslash separators (e.g. "C:\repo\src\a.txt"). The old rename/drag code
// computed the parent dir with `path.substring(0, path.lastIndexOf('/'))`.
// On a backslash path there is no "/", so lastIndexOf returns -1 and the
// parent collapses to "" — the caller then built "/newName" and fs.rename
// moved the file to the drive root, i.e. it "disappeared" from the folder.
// ---------------------------------------------------------------------------

describe('getParentPath', () => {
  it('documents the old lastIndexOf("/") collapse on Windows paths', () => {
    // The exact defective expression from the pre-fix code path.
    const winPath = 'C:\\repo\\src\\a.txt';
    const brokenParent = winPath.substring(0, winPath.lastIndexOf('/'));
    expect(brokenParent).toBe(''); // -> "/newName" -> moved to drive root
  });

  it('returns the parent of a Windows backslash path', () => {
    expect(getParentPath('C:\\repo\\src\\a.txt')).toBe('C:\\repo\\src');
  });

  it('returns the parent of a POSIX forward-slash path', () => {
    expect(getParentPath('/home/dev/repo/a.txt')).toBe('/home/dev/repo');
  });

  it('ignores a trailing separator', () => {
    expect(getParentPath('C:\\repo\\src\\')).toBe('C:\\repo');
    expect(getParentPath('/home/dev/repo/')).toBe('/home/dev');
  });

  it('returns "" for a root-level file so callers can fall back', () => {
    expect(getParentPath('/a.txt')).toBe('');
  });

  it('returns "" for a bare name with no separator', () => {
    expect(getParentPath('a.txt')).toBe('');
  });

  it('returns "" for empty input', () => {
    expect(getParentPath('')).toBe('');
  });
});

describe('getPathBasename (backslash regression guard)', () => {
  it('extracts the last segment from a Windows backslash path', () => {
    expect(getPathBasename('C:\\repo\\src\\a.txt')).toBe('a.txt');
  });

  it('extracts the last segment from a POSIX path', () => {
    expect(getPathBasename('/home/dev/repo/a.txt')).toBe('a.txt');
  });
});
