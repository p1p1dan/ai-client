import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * terminal-09 — when `pty.spawn` threw, `PtyManager.create` retried with a shell
 * that exists on Unix and rethrew node-pty's native error on Windows. A user who
 * uninstalled or renamed the shell they had configured (pwsh.exe is a separate
 * install; a custom path can move) therefore got
 * `Error invoking remote method 'session:create'` in the panel and no terminal
 * at all, while the same situation on Linux or macOS recovered silently.
 *
 * `isWindows` is frozen into a module-scope const at import time, so each case
 * stubs the platform and re-imports. node-pty is a native binding and is faked
 * here; nothing in this file starts or signals a process.
 */

interface SpawnCall {
  file: string;
  args: string[];
}

const spawnCalls: SpawnCall[] = [];
let failingShells: string[] = [];

vi.mock('node-pty', () => ({
  spawn: (file: string, args: string[]) => {
    spawnCalls.push({ file, args });
    if (failingShells.includes(file.toLowerCase())) {
      throw new Error(`spawn ${file} ENOENT`);
    }
    return {
      pid: 4242,
      onData: () => ({ dispose: () => {} }),
      onExit: () => ({ dispose: () => {} }),
      write: () => {},
      resize: () => {},
      kill: () => {},
    };
  },
}));

// ProxyConfig reads `session` from electron at import time; nothing here uses it.
vi.mock('electron', () => ({ session: {} }));

const ORIGINAL_PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform');

async function loadManager(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform });
  vi.resetModules();
  const { PtyManager } = await import('../PtyManager');
  return new PtyManager();
}

beforeEach(() => {
  spawnCalls.length = 0;
  failingShells = [];
});

afterEach(() => {
  if (ORIGINAL_PLATFORM) Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM);
});

describe('a shell that cannot spawn falls back on Windows too', () => {
  it('retries PowerShell 5.x when the configured pwsh.exe is not there', async () => {
    failingShells = ['pwsh.exe'];
    const manager = await loadManager('win32');

    const id = manager.create({ cwd: 'C:\\repo', shell: 'pwsh.exe', args: ['-NoLogo'] }, () => {});

    expect(id).toBeTruthy();
    expect(spawnCalls.map((call) => call.file)).toEqual(['pwsh.exe', 'powershell.exe']);
  });

  it('retries cmd.exe when PowerShell itself fails, carrying the initial command over', async () => {
    failingShells = ['pwsh.exe', 'powershell.exe'];
    const manager = await loadManager('win32');

    manager.create(
      { cwd: 'C:\\repo', shell: 'powershell.exe', args: ['-NoLogo'], initialCommand: 'git status' },
      () => {}
    );

    const last = spawnCalls.at(-1);
    expect(last?.file).toBe('cmd.exe');
    // PowerShell's `-NoExit -Command <cmd>` has no meaning to cmd.exe; the
    // equivalent that keeps the shell open is `/k <cmd>`.
    expect(last?.args).toEqual(['/k', 'git status']);
  });

  it('still reports the failure when nothing is left to fall back to', async () => {
    failingShells = ['pwsh.exe', 'powershell.exe', 'cmd.exe'];
    const manager = await loadManager('win32');

    expect(() => manager.create({ cwd: 'C:\\repo', shell: 'cmd.exe' }, () => {})).toThrow(/spawn/);
  });

  it('leaves the Unix pre-check exactly as it was', async () => {
    failingShells = ['/opt/gone/fish'];
    const manager = await loadManager('linux');

    manager.create({ cwd: '/repo', shell: '/opt/gone/fish', args: ['-i', '-l'] }, () => {});

    // An absolute path that is not on disk is swapped out before the spawn is
    // even attempted, so there is only ever one call.
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.file).not.toBe('/opt/gone/fish');
  });
});
