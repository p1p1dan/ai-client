import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  // D64/S3 — `credentialMode.ts` reads `app.isPackaged` (the dev-only override
  // is forced off in a packaged build) and, when it consults the settings file,
  // `app.getPath('userData')`. `isPackaged:false` keeps the env override live,
  // which is how this suite still controls the mode.
  app: {
    isPackaged: false,
    getPath: vi.fn((name: string) =>
      name === 'userData' ? '/tmp/aiclient-test-userdata' : '/tmp'
    ),
  },
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

describe('SessionManager', () => {
  const originalMode = process.env.AICLIENT_MANAGED_CREDENTIALS;

  beforeEach(() => {
    // D64/S3 — with nothing recorded the mode is MANAGED, and the spawn gate
    // then refuses a session on an unauthenticated machine. These cases are
    // about detach/persist behaviour, not about auth, so they run in local
    // mode — the dev-only override's explicit `'0'`.
    process.env.AICLIENT_MANAGED_CREDENTIALS = '0';
    vi.resetModules();
  });

  afterEach(() => {
    if (originalMode === undefined) delete process.env.AICLIENT_MANAGED_CREDENTIALS;
    else process.env.AICLIENT_MANAGED_CREDENTIALS = originalMode;
    vi.restoreAllMocks();
  });

  it('keeps a local session alive after detach when persistOnDisconnect is enabled', async () => {
    const { SessionManager } = await import('../SessionManager');
    const manager = new SessionManager();

    const allocateIdSpy = vi.spyOn(manager.localPtyManager, 'allocateId').mockReturnValue('s1');
    const createSpy = vi.spyOn(manager.localPtyManager, 'create').mockImplementation(() => 's1');
    const destroySpy = vi.spyOn(manager.localPtyManager, 'destroy').mockImplementation(() => {});

    const created = await manager.create(1, {
      cwd: 'C:/repo',
      kind: 'agent',
      persistOnDisconnect: true,
    });

    await manager.attach(1, {
      sessionId: created.session.sessionId,
      cwd: 'C:/repo',
    });

    await manager.detach(1, created.session.sessionId);

    await expect(
      manager.attach(1, {
        sessionId: created.session.sessionId,
        cwd: 'C:/repo',
      })
    ).resolves.toMatchObject({
      session: expect.objectContaining({
        sessionId: 's1',
        persistOnDisconnect: true,
      }),
    });

    expect(allocateIdSpy).toHaveBeenCalledOnce();
    expect(createSpy).toHaveBeenCalledOnce();
    expect(destroySpy).not.toHaveBeenCalled();
  });

  it('destroys a local session after detach when persistOnDisconnect is disabled', async () => {
    const { SessionManager } = await import('../SessionManager');
    const manager = new SessionManager();

    vi.spyOn(manager.localPtyManager, 'allocateId').mockReturnValue('s2');
    vi.spyOn(manager.localPtyManager, 'create').mockImplementation(() => 's2');
    const destroySpy = vi.spyOn(manager.localPtyManager, 'destroy').mockImplementation(() => {});

    const created = await manager.create(1, {
      cwd: 'C:/repo',
      kind: 'terminal',
      persistOnDisconnect: false,
    });

    await manager.attach(1, {
      sessionId: created.session.sessionId,
      cwd: 'C:/repo',
    });

    await manager.detach(1, created.session.sessionId);

    expect(destroySpy).toHaveBeenCalledWith('s2');
    await expect(
      manager.attach(1, {
        sessionId: created.session.sessionId,
        cwd: 'C:/repo',
      })
    ).rejects.toThrow('Session not found: s2');
  });
});
