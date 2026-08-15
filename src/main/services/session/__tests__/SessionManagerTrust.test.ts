import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetManagedFileWriterQueuesForTests } from '../../auth/managedFileWriter';

/**
 * D47 S2a trust call matrix entry ③ — `SessionManager.create`'s local
 * branch. Fake helper (ensureWorkspaceTrusted call recorded via reading the
 * resulting .claude.json) must complete BEFORE the fake PTY spawn
 * (`localPtyManager.create`) is invoked — this is the "fake helper asserted
 * before fake spawn" ordering the spec calls for.
 */

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => globalThis.__testUserDataDir as string) },
  BrowserWindow: {
    fromWebContents: vi.fn(),
    fromId: vi.fn(() => null),
  },
}));

vi.mock('../../remote/RemoteConnectionManager', () => ({
  remoteConnectionManager: {
    getStatus: vi.fn(),
    call: vi.fn(),
    addEventListener: vi.fn(),
    onDidDisconnect: vi.fn(),
    onDidStatusChange: vi.fn(),
  },
}));

declare global {
  // eslint-disable-next-line no-var
  var __testUserDataDir: string;
}

describe('SessionManager.create trust call matrix entry ③ (D47 S2a)', () => {
  const originalFlag = process.env.AICLIENT_MANAGED_CREDENTIALS;
  let userDataDir: string;

  beforeEach(() => {
    vi.resetModules();
    userDataDir = mkdtempSync(join(tmpdir(), 'session-manager-trust-'));
    globalThis.__testUserDataDir = userDataDir;
    resetManagedFileWriterQueuesForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(userDataDir, { recursive: true, force: true });
    if (originalFlag === undefined) delete process.env.AICLIENT_MANAGED_CREDENTIALS;
    else process.env.AICLIENT_MANAGED_CREDENTIALS = originalFlag;
  });

  function claudeJsonPath(): string {
    return join(userDataDir, 'claude-home', '.claude.json');
  }

  it('flag on + local cwd: trust write completes before the PTY spawn fires', async () => {
    process.env.AICLIENT_MANAGED_CREDENTIALS = '1';
    const { SessionManager } = await import('../SessionManager');
    const manager = new SessionManager();

    const callOrder: string[] = [];
    vi.spyOn(manager.localPtyManager, 'allocateId').mockReturnValue('s1');
    vi.spyOn(manager.localPtyManager, 'create').mockImplementation(() => {
      // By the time the fake spawn fires, the trust file must already exist
      // on disk (ensureWorkspaceTrusted awaited to completion first).
      callOrder.push('spawn');
      expect(() => readFileSync(claudeJsonPath(), 'utf-8')).not.toThrow();
      return 's1';
    });

    await manager.create(1, { cwd: '/repo/local', kind: 'terminal' });

    const doc = JSON.parse(readFileSync(claudeJsonPath(), 'utf-8')) as {
      projects: Record<string, unknown>;
    };
    expect(doc.projects['/repo/local']).toEqual({
      hasTrustDialogAccepted: true,
      hasCompletedProjectOnboarding: true,
    });
    expect(callOrder).toEqual(['spawn']);
  });

  it('flag off: no .claude.json is written', async () => {
    process.env.AICLIENT_MANAGED_CREDENTIALS = '0';
    const { SessionManager } = await import('../SessionManager');
    const manager = new SessionManager();

    vi.spyOn(manager.localPtyManager, 'allocateId').mockReturnValue('s1');
    vi.spyOn(manager.localPtyManager, 'create').mockImplementation(() => 's1');

    await manager.create(1, { cwd: '/repo/local', kind: 'terminal' });

    const { existsSync } = await import('node:fs');
    expect(existsSync(claudeJsonPath())).toBe(false);
  });

  it('flag on + remote virtual cwd: no-op (I8) — never writes .claude.json', async () => {
    process.env.AICLIENT_MANAGED_CREDENTIALS = '1';
    const { SessionManager } = await import('../SessionManager');
    const { remoteConnectionManager } = await import('../../remote/RemoteConnectionManager');
    vi.mocked(remoteConnectionManager.call).mockResolvedValue({
      session: {
        sessionId: 'r1',
        backend: 'remote',
        kind: 'terminal',
        cwd: '/remote/path',
        persistOnDisconnect: true,
        createdAt: Date.now(),
      },
      replay: '',
    });
    vi.mocked(remoteConnectionManager.getStatus).mockReturnValue({
      connectionId: 'conn-1',
      connected: true,
      recoverable: false,
    });
    vi.mocked(remoteConnectionManager.addEventListener).mockResolvedValue(() => {});

    const manager = new SessionManager();
    await manager.create(1, {
      cwd: '/__aiclient_remote__/conn-1/remote/path',
      kind: 'terminal',
    });

    const { existsSync } = await import('node:fs');
    expect(existsSync(claudeJsonPath())).toBe(false);
  });

  it('idempotent: two local creates for the same workspace converge to one trust entry', async () => {
    process.env.AICLIENT_MANAGED_CREDENTIALS = '1';
    const { SessionManager } = await import('../SessionManager');
    const manager = new SessionManager();

    let idCounter = 0;
    vi.spyOn(manager.localPtyManager, 'allocateId').mockImplementation(() => `s${++idCounter}`);
    vi.spyOn(manager.localPtyManager, 'create').mockImplementation(() => `s${idCounter}`);

    await manager.create(1, { cwd: '/repo/local', kind: 'terminal' });
    await manager.create(1, { cwd: '/repo/local', kind: 'terminal' });

    const doc = JSON.parse(readFileSync(claudeJsonPath(), 'utf-8')) as {
      projects: Record<string, unknown>;
    };
    expect(Object.keys(doc.projects)).toEqual(['/repo/local']);
  });
});
