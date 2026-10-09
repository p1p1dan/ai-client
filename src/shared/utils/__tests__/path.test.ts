import { describe, expect, it } from 'vitest';
import { canonicalPathKey, isWindowsStylePath, relativeToRoot } from '../path';

describe('canonicalPathKey', () => {
  it('trims a trailing separator so "/aaa" and "/aaa/" compare equal', () => {
    expect(canonicalPathKey('/aaa/')).toBe(canonicalPathKey('/aaa'));
    expect(canonicalPathKey('/aaa/')).toBe('/aaa');
  });

  it('normalizes backslashes to forward slashes before comparing', () => {
    expect(canonicalPathKey('C:\\Code\\repo')).toBe(canonicalPathKey('C:/Code/repo'));
    expect(canonicalPathKey('C:\\Code\\repo')).toBe('c:/code/repo');
  });

  it('lowercases so case-drifted paths compare equal', () => {
    expect(canonicalPathKey('/Repo/Aaa')).toBe(canonicalPathKey('/repo/aaa'));
  });

  it('does not trim root paths down to an empty key', () => {
    expect(canonicalPathKey('/')).toBe('/');
    expect(canonicalPathKey('C:/')).toBe('c:/');
  });
});

/**
 * GitHub issue #1 follow-up (decision 163): a workspace root and the file
 * paths under it can be spelled differently on Windows (`E:\x` registered,
 * `E:/x` from git, `E:\x\src` from Main's joins).
 */
describe('relativeToRoot', () => {
  it('strips a backslash root from a backslash path', () => {
    expect(relativeToRoot('E:\\x', 'E:\\x\\src\\a.ts')).toBe('src\\a.ts');
  });

  it('matches a forward-slash root against a backslash path, keeping the path spelling', () => {
    expect(relativeToRoot('E:/x', 'E:\\x\\src\\a.ts')).toBe('src\\a.ts');
    expect(relativeToRoot('E:\\x\\', 'E:/x/src/a.ts')).toBe('src/a.ts');
  });

  it('ignores case for Windows-style paths only', () => {
    expect(relativeToRoot('e:\\X', 'E:\\x\\Src\\a.ts')).toBe('Src\\a.ts');
    expect(relativeToRoot('/repo', '/Repo/src/a.ts')).toBeNull();
  });

  it('handles POSIX roots, including the filesystem root', () => {
    expect(relativeToRoot('/repo', '/repo/src/a.ts')).toBe('src/a.ts');
    expect(relativeToRoot('/repo/', '/repo/src/a.ts')).toBe('src/a.ts');
    expect(relativeToRoot('/', '/src/a.ts')).toBe('src/a.ts');
    expect(relativeToRoot('C:\\', 'C:\\src\\a.ts')).toBe('src\\a.ts');
  });

  it('returns an empty string for the root itself', () => {
    expect(relativeToRoot('/repo', '/repo')).toBe('');
    expect(relativeToRoot('E:\\x', 'E:/x/')).toBe('');
  });

  it('returns null for a path outside the root', () => {
    expect(relativeToRoot('/repo', '/repo2/a.ts')).toBeNull();
    expect(relativeToRoot('/repo', '/other/a.ts')).toBeNull();
    expect(relativeToRoot('E:\\x', 'E:\\xy\\a.ts')).toBeNull();
    expect(relativeToRoot('E:\\x', 'D:\\x\\a.ts')).toBeNull();
    expect(relativeToRoot('/repo/src', '/repo')).toBeNull();
    expect(relativeToRoot('', '/repo/a.ts')).toBeNull();
  });

  it('does not treat a backslash as a separator under a POSIX root', () => {
    expect(relativeToRoot('/repo', '/repo\\a.ts')).toBeNull();
  });

  it('classifies spellings, not platforms', () => {
    expect(isWindowsStylePath('E:\\x')).toBe(true);
    expect(isWindowsStylePath('e:/x')).toBe(true);
    expect(isWindowsStylePath('\\\\srv\\share')).toBe(true);
    expect(isWindowsStylePath('/repo')).toBe(false);
    expect(isWindowsStylePath('/__aiclient_remote__/conn/repo')).toBe(false);
  });
});
