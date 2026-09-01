import { describe, expect, it } from 'vitest';
import {
  normalizedWorkerPathIdentity,
  normalizeWorkerPath,
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
