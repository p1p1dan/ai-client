import { describe, expect, it } from 'vitest';
import { isDirectChildOf, isInsideDirectory } from '../workspaceContainment';

/**
 * T037 review follow-up (main-aux-01 FIX) — Windows folds case (NTFS/ReFS are
 * case-insensitive by default), so a scratch root and a candidate spelled with
 * different casing must still be recognised as the same directory. `platform`
 * is injected here exactly like `windows-paths.test.ts` does, so this runs on
 * any host regardless of its real OS.
 */
describe('workspaceContainment — Windows case folding', () => {
  const root = 'C:\\Users\\JC\\scratch';

  it('treats differently-cased spellings of the same directory as one root on win32', () => {
    expect(isInsideDirectory(root, 'C:\\Users\\JC\\scratch\\abc', 'win32')).toBe(true);
    // Drive letter, user segment and the "scratch" segment itself all
    // re-cased; the directory and the candidate are still the same root.
    expect(isInsideDirectory(root, 'c:\\users\\jc\\SCRATCH\\abc', 'win32')).toBe(true);
  });

  it('still rejects an escape through .. on win32, even case-folded', () => {
    expect(isInsideDirectory(root, 'C:\\Users\\JC\\scratch\\..\\secret', 'win32')).toBe(false);
    expect(isInsideDirectory(root, 'c:\\users\\jc\\SCRATCH\\..\\secret', 'win32')).toBe(false);
  });

  it('folds case for isDirectChildOf on win32 as well', () => {
    expect(isDirectChildOf(root, 'c:\\users\\jc\\SCRATCH\\dir-1', 'win32')).toBe(true);
    expect(isDirectChildOf(root, 'c:\\users\\jc\\SCRATCH\\dir-1\\nested', 'win32')).toBe(false);
  });

  it('stays case-sensitive on POSIX: a re-cased candidate is a different directory', () => {
    const posixRoot = '/tmp/Scratch';
    expect(isInsideDirectory(posixRoot, '/tmp/Scratch/abc', 'linux')).toBe(true);
    expect(isInsideDirectory(posixRoot, '/tmp/scratch/abc', 'linux')).toBe(false);
    expect(isDirectChildOf(posixRoot, '/tmp/SCRATCH/dir-1', 'linux')).toBe(false);
  });
});
