import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn();
const existsSyncMock = vi.fn();
const getAllWindowsMock = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

vi.mock('node:fs', () => ({
  default: {
    existsSync: existsSyncMock,
  },
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: vi.fn(() => 'C:\\fake\\app'),
  },
  BrowserWindow: {
    getAllWindows: getAllWindowsMock,
  },
}));

vi.mock('../../../utils/processUtils', () => ({
  killProcessTree: vi.fn(),
}));

vi.mock('../../../utils/shell', () => ({
  getEnvForCommand: () => ({}),
}));

function createSpawnProcess({
  stderr = '',
  exitCode = 0,
}: {
  stderr?: string;
  exitCode?: number;
}) {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.pid = 4321;
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  queueMicrotask(() => {
    if (stderr) {
      child.stderr.emit('data', Buffer.from(stderr));
    }
    child.emit('close', exitCode);
  });
  return child;
}

function fakeWindow() {
  return {
    isDestroyed: vi.fn(() => false),
    webContents: { send: vi.fn() },
  };
}

describe('VflowService', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    spawnMock.mockReset();
    existsSyncMock.mockReset();
    getAllWindowsMock.mockReset();
  });

  it('broadcasts vflow:project-initialized after a successful global init', async () => {
    const win = fakeWindow();
    getAllWindowsMock.mockReturnValue([win]);

    // .vflow/ does not exist yet, so init runs and the broadcast fires.
    existsSyncMock.mockReturnValue(false);

    spawnMock.mockImplementation(() => createSpawnProcess({ exitCode: 0 }));

    const { vflowService } = await import('../VflowService');
    await vflowService.ensureInitialized('C:\\projects\\fresh');

    expect(win.webContents.send).toHaveBeenCalledTimes(1);
    expect(win.webContents.send).toHaveBeenCalledWith(
      'vflow:project-initialized',
      { cwd: 'C:\\projects\\fresh' }
    );
  });

  it('does not broadcast when .vflow/ already exists (early return)', async () => {
    const win = fakeWindow();
    getAllWindowsMock.mockReturnValue([win]);

    // .vflow/ already present → ensureInitialized returns immediately.
    existsSyncMock.mockReturnValue(true);

    const { vflowService } = await import('../VflowService');
    await vflowService.ensureInitialized('C:\\projects\\already-init');

    expect(win.webContents.send).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('skips destroyed windows when broadcasting', async () => {
    const live = fakeWindow();
    const dead = fakeWindow();
    dead.isDestroyed.mockReturnValue(true);
    getAllWindowsMock.mockReturnValue([live, dead]);

    existsSyncMock.mockReturnValue(false);
    spawnMock.mockImplementation(() => createSpawnProcess({ exitCode: 0 }));

    const { vflowService } = await import('../VflowService');
    await vflowService.ensureInitialized('C:\\projects\\multi-win');

    expect(live.webContents.send).toHaveBeenCalledTimes(1);
    expect(dead.webContents.send).not.toHaveBeenCalled();
  });

  it('does not broadcast when both global and embedded init fail', async () => {
    const win = fakeWindow();
    getAllWindowsMock.mockReturnValue([win]);

    // .vflow/ missing AND embedded cli.mjs missing → both paths fail.
    existsSyncMock.mockImplementation((p: string) => {
      if (p.endsWith('.vflow')) return false;
      if (p.endsWith('cli.mjs')) return false;
      return false;
    });

    // Global vflow command fails (e.g. not on PATH).
    spawnMock.mockImplementation(() =>
      createSpawnProcess({ stderr: 'vflow: command not found', exitCode: 127 })
    );

    const { vflowService } = await import('../VflowService');
    await vflowService.ensureInitialized('C:\\projects\\no-vflow');

    expect(win.webContents.send).not.toHaveBeenCalled();
  });
});
