import { describe, expect, it } from 'vitest';
import { isAbsoluteIntentPath, resolveIntentPath } from '../resolveIntentPath';

describe('resolveIntentPath', () => {
  it('returns null for an empty path, with or without a workspace', () => {
    expect(resolveIntentPath('', '/home/dan/project')).toBeNull();
    expect(resolveIntentPath('', null)).toBeNull();
  });

  it('passes a POSIX absolute path through unchanged, workspace or not', () => {
    expect(resolveIntentPath('/home/dan/other/file.ts', '/home/dan/project')).toBe(
      '/home/dan/other/file.ts'
    );
    expect(resolveIntentPath('/etc/hosts', null)).toBe('/etc/hosts');
  });

  it('normalizes and passes a Windows drive-letter absolute path through', () => {
    expect(resolveIntentPath('C:\\Users\\dan\\file.ts', null)).toBe('C:/Users/dan/file.ts');
    expect(resolveIntentPath('C:/Users/dan/file.ts', '/home/dan/project')).toBe(
      'C:/Users/dan/file.ts'
    );
  });

  it('normalizes and passes a UNC path through', () => {
    expect(resolveIntentPath('\\\\server\\share\\file.ts', null)).toBe('//server/share/file.ts');
  });

  it('passes a WSL UNC path through unchanged', () => {
    expect(resolveIntentPath('//wsl.localhost/Ubuntu/home/dan/file.ts', null)).toBe(
      '//wsl.localhost/Ubuntu/home/dan/file.ts'
    );
  });

  it('joins a relative path onto the workspace root', () => {
    expect(resolveIntentPath('src/foo.ts', '/home/dan/project')).toBe(
      '/home/dan/project/src/foo.ts'
    );
  });

  it('normalizes backslashes in both the relative path and the root before joining', () => {
    expect(resolveIntentPath('src\\foo.ts', 'C:\\Users\\dan\\project')).toBe(
      'C:/Users/dan/project/src/foo.ts'
    );
  });

  it('trims a trailing separator on the workspace root before joining', () => {
    expect(resolveIntentPath('a.ts', '/home/dan/project/')).toBe('/home/dan/project/a.ts');
  });

  it('preserves a UNC workspace root double-slash prefix when joining', () => {
    expect(resolveIntentPath('a/b.ts', '//server/share')).toBe('//server/share/a/b.ts');
  });

  it('returns null for a relative path when no workspace is resolved', () => {
    expect(resolveIntentPath('src/foo.ts', null)).toBeNull();
    expect(resolveIntentPath('src/foo.ts', undefined)).toBeNull();
    expect(resolveIntentPath('src/foo.ts', '')).toBeNull();
  });

  it('resolves a "../" that stays within the workspace root', () => {
    expect(resolveIntentPath('src/../lib/file.ts', '/home/dan/project')).toBe(
      '/home/dan/project/lib/file.ts'
    );
  });

  it('returns null for a "../" that escapes the workspace root', () => {
    expect(resolveIntentPath('../../etc/passwd', '/home/dan/project')).toBeNull();
    expect(resolveIntentPath('..', '/home/dan/project')).toBeNull();
    expect(resolveIntentPath('../sibling/file.ts', '/home/dan/project')).toBeNull();
  });

  // Adversarial review m7: a leading drive letter with no separator right
  // after it (bare "C:" or drive-relative "C:foo") is neither a full
  // absolute path nor an ordinary relative segment — it used to fall through
  // to the relative-join branch and produce "/repo/C:foo".
  it('returns null for a bare drive letter, with or without a workspace', () => {
    expect(resolveIntentPath('C:', '/home/dan/project')).toBeNull();
    expect(resolveIntentPath('C:', null)).toBeNull();
  });

  it('returns null for a drive-relative path (no separator after the colon)', () => {
    expect(resolveIntentPath('C:foo\\bar', '/home/dan/project')).toBeNull();
    expect(resolveIntentPath('C:foo/bar', '/home/dan/project')).toBeNull();
    expect(resolveIntentPath('C:foo\\bar', null)).toBeNull();
  });

  // Adversarial review m8: an absolute path's own "../" segments must
  // collapse too, so the same file opened two different ways resolves to
  // the same string (tab identity is plain string equality downstream).
  describe('absolute path "../" collapsing (m8)', () => {
    it('resolves a "../" that stays within a POSIX absolute path', () => {
      expect(resolveIntentPath('/home/dan/project/src/../lib/file.ts', null)).toBe(
        '/home/dan/project/lib/file.ts'
      );
    });

    it('clamps at "/" instead of escaping when "../" climbs past a POSIX root', () => {
      expect(resolveIntentPath('/a/../../b', null)).toBe('/b');
      expect(resolveIntentPath('/..', null)).toBe('/');
    });

    it('resolves a "../" that stays within a drive-letter absolute path', () => {
      expect(resolveIntentPath('C:/Users/dan/../file.ts', null)).toBe('C:/Users/file.ts');
    });

    it('clamps at the drive root instead of escaping when "../" climbs past it', () => {
      expect(resolveIntentPath('C:/a/../../b', null)).toBe('C:/b');
    });

    it('clamps at the share root ("//server/share") instead of escaping for a UNC path', () => {
      expect(resolveIntentPath('//server/share/a/../../../b', null)).toBe('//server/share/b');
    });

    it('collapses two spellings of the same file to the same resolved path (tab identity)', () => {
      const direct = resolveIntentPath('/home/dan/project/src/file.ts', null);
      const viaDotDot = resolveIntentPath('/home/dan/project/lib/../src/file.ts', null);
      expect(viaDotDot).toBe(direct);
    });
  });
});

describe('isAbsoluteIntentPath', () => {
  it('recognizes POSIX, Windows drive-letter and UNC forms (already backslash-normalized)', () => {
    expect(isAbsoluteIntentPath('/home/dan/file.ts')).toBe(true);
    expect(isAbsoluteIntentPath('C:/Users/dan/file.ts')).toBe(true);
    expect(isAbsoluteIntentPath('//server/share/file.ts')).toBe(true);
    expect(isAbsoluteIntentPath('//wsl.localhost/Ubuntu/home/dan')).toBe(true);
  });

  it('rejects relative paths', () => {
    expect(isAbsoluteIntentPath('src/foo.ts')).toBe(false);
    expect(isAbsoluteIntentPath('../foo.ts')).toBe(false);
    expect(isAbsoluteIntentPath('foo.ts')).toBe(false);
  });
});
