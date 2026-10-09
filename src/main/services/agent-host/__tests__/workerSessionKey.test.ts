import { describe, expect, it } from 'vitest';
import {
  normalizedWorkerPathIdentity,
  normalizeWorkerPath,
  sameWorkerDirectory,
  sessionWorkerKey,
  workspaceWorkerKey,
} from '../workerSessionKey';

describe('worker session keys', () => {
  it('normalizes POSIX paths without folding case', () => {
    expect(normalizeWorkerPath('/tmp/repo/./sessions/../session.jsonl')).toBe(
      '/tmp/repo/session.jsonl'
    );
    expect(normalizedWorkerPathIdentity('/Tmp/Session.jsonl')).toBe('/Tmp/Session.jsonl');
  });

  it('normalizes Windows drive, separators, case identity, and UNC paths', () => {
    expect(normalizeWorkerPath('c:/Users/A/../B/session.jsonl')).toBe(
      'C:\\Users\\B\\session.jsonl'
    );
    expect(sessionWorkerKey('C:\\Users\\B\\SESSION.jsonl')).toBe(
      sessionWorkerKey('c:/users/b/session.jsonl')
    );
    expect(sessionWorkerKey('\\\\Server\\Share\\A\\..\\s.jsonl')).toBe(
      sessionWorkerKey('//server/share/s.jsonl')
    );
  });

  it('refuses a relative path instead of resolving it against this process', () => {
    // The key has to name the same file from any host, so there is no cwd to
    // resolve against — and on Windows `path.resolve` would silently mount a
    // POSIX path onto the current drive.
    expect(() => normalizeWorkerPath('sessions/session.jsonl')).toThrow(/absolute path/);
    expect(() => sessionWorkerKey('./session.jsonl')).toThrow(/absolute path/);
    expect(() =>
      workspaceWorkerKey({ workspacePath: 'repo', logicalSessionId: 's1', createToken: 'one' })
    ).toThrow(/absolute path/);
  });

  it('keeps workspace and durable namespaces separate and create keys unique', () => {
    const first = workspaceWorkerKey({
      workspacePath: '/repo',
      logicalSessionId: 's1',
      createToken: 'one',
    });
    const second = workspaceWorkerKey({
      workspacePath: '/repo',
      logicalSessionId: 's2',
      createToken: 'two',
    });
    expect(first).not.toBe(second);
    expect(first.startsWith('workspace:')).toBe(true);
    expect(sessionWorkerKey('/repo/session.jsonl').startsWith('session:')).toBe(true);
  });
});

/**
 * GitHub issue #1 (decision 163): one directory, judged by the path's own
 * style rather than the host platform.
 */
describe('sameWorkerDirectory', () => {
  it.each([
    ['E:\\Projects\\repo', 'E:/Projects/repo'],
    ['e:/projects/Repo/', 'E:\\Projects\\repo'],
    ['/repo/', '/repo'],
    ['/a/./b/../repo', '/a/repo'],
    ['C:\\', 'C:/'],
    ['/', '/'],
    ['\\\\srv\\share\\x', '//srv/share/x/'],
  ])('treats %s and %s as one directory', (a, b) => {
    expect(sameWorkerDirectory(a, b)).toBe(true);
    expect(sameWorkerDirectory(b, a)).toBe(true);
  });

  it.each([
    ['E:\\x', 'E:\\y'],
    // POSIX stays case-sensitive whatever platform runs the comparison.
    ['/repo', '/Repo'],
    // Lexical only: the extended-length prefix is not folded.
    ['\\\\?\\E:\\x', 'E:\\x'],
    // A root is not the directory below it.
    ['C:\\', 'C:\\x'],
  ])('keeps %s and %s apart', (a, b) => {
    expect(sameWorkerDirectory(a, b)).toBe(false);
    expect(sameWorkerDirectory(b, a)).toBe(false);
  });

  it('answers false for an empty or relative path instead of throwing', () => {
    expect(() => sameWorkerDirectory('', '/repo')).not.toThrow();
    expect(sameWorkerDirectory('', '/repo')).toBe(false);
    expect(sameWorkerDirectory('   ', '/repo')).toBe(false);
    expect(sameWorkerDirectory('repo', '/repo')).toBe(false);
    expect(sameWorkerDirectory('repo', 'repo/')).toBe(false);
    expect(sameWorkerDirectory('/repo', 'E:repo')).toBe(false);
  });

  it('accepts identical strings without normalizing them', () => {
    expect(sameWorkerDirectory('E:\\Projects\\repo', 'E:\\Projects\\repo')).toBe(true);
    expect(sameWorkerDirectory('/Repo', '/Repo')).toBe(true);
  });
});
