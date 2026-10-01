import { describe, expect, it } from 'vitest';
import { normalizeShellPath, shellOperandPath, splitShellPath } from '../bashWalker.ts';
import { pathPolicy } from '../pathPolicy.ts';
import { normalizeWindowsPathForm } from '../windowsPaths.ts';

/**
 * Moved from the pure-helper cases of src/runtime/__tests__/shellPolicy.test.ts
 * (dsh-rebase P1-12 step 2): one file, several spellings, and gates that
 * compare strings. Platform and home are injected, so no Windows machine is
 * needed and the POSIX reading is asserted next to the Windows one. The cases
 * that run a command line through the bash analysis live in
 * src/dsh-host/permissions/__tests__/bashGate.test.ts.
 */

// T001 — Windows commands are written with '/' while node's `sep` is '\\', and
// splitting on `sep` alone glued the wildcard to its parent so nothing matched.
describe('shell path separator folding', () => {
  it('keeps a wildcard its own segment when the command used the other separator', () => {
    expect(normalizeShellPath('C:\\work\\conf/*', '\\')).toBe('C:\\work\\conf\\*');
    expect(splitShellPath('C:\\work\\conf/*', '\\')).toEqual(['C:', 'work', 'conf', '*']);
    expect(splitShellPath(normalizeShellPath('C:\\work\\conf/*', '\\'), '\\')).toEqual([
      'C:',
      'work',
      'conf',
      '*',
    ]);
  });
  it('leaves a POSIX path alone, backslashes in names included', () => {
    expect(normalizeShellPath('/work/conf/*', '/')).toBe('/work/conf/*');
    expect(splitShellPath('/work/od\\d/*', '/')).toEqual(['', 'work', 'od\\d', '*']);
  });
});

// T039 / windows-01 — Git Bash writes `/c/Users/...`, Cygwin `/cygdrive/c/...`
// and the kernel `\\?\C:\...`; only the native spelling once matched the deny
// for `~/.ssh/*`.
describe('windows path spellings', () => {
  const win = { platform: 'win32' as const, home: 'C:\\Users\\JC' };
  const posixEnvironment = { platform: 'linux' as const, home: '/home/jc' };

  it('folds MSYS, Cygwin and extended-length spellings onto the native one', () => {
    expect(normalizeWindowsPathForm('/c/Users/JC/.ssh/id_ed25519', 'win32')).toBe(
      'C:/Users/JC/.ssh/id_ed25519'
    );
    expect(normalizeWindowsPathForm('/cygdrive/d/data/app.env', 'win32')).toBe('D:/data/app.env');
    expect(normalizeWindowsPathForm('\\\\?\\C:\\Users\\JC\\.ssh\\config', 'win32')).toBe(
      'C:\\Users\\JC\\.ssh\\config'
    );
    expect(normalizeWindowsPathForm('\\\\?\\UNC\\srv\\share\\key.pem', 'win32')).toBe(
      '\\\\srv\\share\\key.pem'
    );
    expect(normalizeWindowsPathForm('c:\\work\\app.ts', 'win32')).toBe('C:\\work\\app.ts');
    expect(normalizeWindowsPathForm('/c', 'win32')).toBe('C:/');
    // Not a drive letter: a real directory named `conf` keeps its own spelling.
    expect(normalizeWindowsPathForm('/conf/app.ts', 'win32')).toBe('/conf/app.ts');
    // Off Windows every one of those is an ordinary path and stays untouched.
    expect(normalizeWindowsPathForm('/c/Users/JC/.ssh/id_ed25519', 'linux')).toBe(
      '/c/Users/JC/.ssh/id_ed25519'
    );
  });

  it('matches the uncoverable deny whatever spelling the shell used', () => {
    for (const spelling of [
      'C:\\Users\\JC\\.ssh\\id_ed25519',
      '/c/Users/JC/.ssh/id_ed25519',
      '/c/Users/JC/.ssh/config',
      '/cygdrive/c/Users/JC/.ssh/known_hosts',
      '\\\\?\\C:\\Users\\JC\\.ssh\\id_ed25519',
      '/c/Users/JC/.aws/credentials',
      'c:/users/jc/.aws/credentials',
    ]) {
      expect(pathPolicy(spelling, win), spelling).toBe('deny');
    }
    expect(pathPolicy('/c/Users/JC/work/app.ts', win)).toBe('allow');
    // The basename rules never depended on the spelling, and still do not.
    expect(pathPolicy('/c/Users/JC/work/.env', win)).toBe('deny');
  });

  it('leaves the POSIX reading of the same strings alone', () => {
    // `/c/...` is an ordinary absolute path here and names nobody's key.
    expect(pathPolicy('/c/Users/JC/.ssh/id_ed25519', posixEnvironment)).toBe('allow');
    expect(pathPolicy('/home/jc/.ssh/id_ed25519', posixEnvironment)).toBe('deny');
    expect(pathPolicy('/home/jc/.aws/credentials', posixEnvironment)).toBe('deny');
    expect(pathPolicy('/home/jc/work/app.ts', posixEnvironment)).toBe('allow');
  });

  it('registers a Git Bash operand under the spelling every gate compares', () => {
    expect(shellOperandPath('/c/Users/JC/.ssh/id_ed25519', 'C:\\work', 'win32')).toBe(
      'C:\\Users\\JC\\.ssh\\id_ed25519'
    );
    expect(shellOperandPath('notes.txt', 'C:\\work', 'win32')).toBe('C:\\work\\notes.txt');
    expect(shellOperandPath('conf/*', 'C:\\work', 'win32')).toBe('C:\\work\\conf\\*');
    expect(shellOperandPath('/etc/hosts', '/work', 'linux')).toBe('/etc/hosts');
    expect(shellOperandPath('notes.txt', '/work', 'linux')).toBe('/work/notes.txt');
  });
});
