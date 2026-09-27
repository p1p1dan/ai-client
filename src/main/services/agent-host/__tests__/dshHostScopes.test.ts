import { describe, expect, it, vi } from 'vitest';
import {
  dshScopePatterns,
  hasSystemdUserBus,
  isDshScopeOf,
  type SystemctlExecFile,
  stopDeadHostScopes,
} from '../dshHostScopes';

/**
 * dsh-rebase P1-3d (decision 075) — stopping the systemd scopes a dead DSH
 * host left behind. systemctl is a fake here: nothing is run or signalled.
 */

const BUS = { XDG_RUNTIME_DIR: '/run/user/1000' };
const withBus = (file: string) => file === '/run/user/1000/bus';

function fakeSystemctl(answers: Array<{ error?: Error; stdout?: string; stderr?: string }>) {
  const calls: Array<{ file: string; args: readonly string[]; timeout: number }> = [];
  const execFile: SystemctlExecFile = (file, args, options, callback) => {
    calls.push({ file, args, timeout: options.timeout });
    const answer = answers.shift() ?? {};
    queueMicrotask(() => callback(answer.error ?? null, answer.stdout ?? '', answer.stderr ?? ''));
    return undefined;
  };
  return { execFile, calls };
}

describe('dshHostScopes naming', () => {
  it('matches the exact pid of a tool or terminal scope and nothing near it', () => {
    expect(dshScopePatterns(4242)).toEqual([
      'dsh-subprocess-4242-*.scope',
      'dsh-terminal-4242-*.scope',
    ]);
    expect(isDshScopeOf('dsh-subprocess-4242-a1b2c3d4e5f6.scope', 4242)).toBe(true);
    expect(isDshScopeOf('dsh-terminal-4242-00ff.scope', 4242)).toBe(true);
    for (const unit of [
      'dsh-subprocess-42421-a1b2.scope',
      'dsh-subprocess-424-a1b2.scope',
      'dsh-subprocess-probe-4242-a1b2.scope',
      'dsh-subprocess-4242-a1b2.service',
      'x-dsh-subprocess-4242-a1b2.scope',
      'dsh-subprocess-4242-.scope',
    ]) {
      expect(isDshScopeOf(unit, 4242), unit).toBe(false);
    }
  });

  it('sees a user bus only on Linux with a runtime dir socket or a session bus address', () => {
    expect(hasSystemdUserBus(BUS, 'linux', withBus)).toBe(true);
    expect(
      hasSystemdUserBus(BUS, 'linux', (file) => file === '/run/user/1000/systemd/private')
    ).toBe(true);
    expect(hasSystemdUserBus(BUS, 'linux', () => false)).toBe(false);
    expect(hasSystemdUserBus({ DBUS_SESSION_BUS_ADDRESS: 'unix:path=/x' }, 'linux')).toBe(true);
    expect(hasSystemdUserBus({}, 'linux')).toBe(false);
    expect(hasSystemdUserBus(BUS, 'darwin', withBus)).toBe(false);
    expect(hasSystemdUserBus(BUS, 'win32', withBus)).toBe(false);
  });
});

describe('stopDeadHostScopes', () => {
  it('lists the dead pid’s scopes, SIGKILLs exactly those units through systemd, then stops what is left', async () => {
    const { execFile, calls } = fakeSystemctl([
      {
        stdout:
          'dsh-subprocess-4242-a1b2c3.scope loaded active running sleep\n' +
          'dsh-subprocess-42421-ffff.scope loaded active running other\n' +
          'dsh-terminal-4242-0a0b.scope loaded active running pwsh\n',
      },
      {},
      {},
    ]);
    const log = vi.fn();
    const ended = await stopDeadHostScopes(4242, {
      execFile,
      env: BUS,
      platform: 'linux',
      exists: withBus,
      log,
    });
    expect(ended).toBe(2);
    expect(calls).toEqual([
      {
        file: 'systemctl',
        args: [
          '--user',
          'list-units',
          '--all',
          '--plain',
          '--no-legend',
          '--no-pager',
          'dsh-subprocess-4242-*.scope',
          'dsh-terminal-4242-*.scope',
        ],
        timeout: 5_000,
      },
      {
        file: 'systemctl',
        args: [
          '--user',
          'kill',
          '--kill-whom=all',
          '--signal=SIGKILL',
          'dsh-subprocess-4242-a1b2c3.scope',
          'dsh-terminal-4242-0a0b.scope',
        ],
        timeout: 5_000,
      },
      {
        file: 'systemctl',
        args: ['--user', 'stop', 'dsh-subprocess-4242-*.scope', 'dsh-terminal-4242-*.scope'],
        timeout: 5_000,
      },
    ]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ended 2 tool scope(s)'));
  });

  it('stops nothing when nothing is left, and runs nothing without a user bus or a real pid', async () => {
    const { execFile, calls } = fakeSystemctl([{ stdout: '' }]);
    const options = { execFile, env: BUS, platform: 'linux' as const, exists: withBus };
    expect(await stopDeadHostScopes(4242, options)).toBe(0);
    expect(calls).toHaveLength(1);
    for (const pid of [0, 1, -1, 1.5]) {
      expect(await stopDeadHostScopes(pid, options)).toBeNull();
    }
    expect(await stopDeadHostScopes(4242, { ...options, env: {}, exists: () => false })).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('only logs when systemctl is missing or fails, and never rejects', async () => {
    const missing = Object.assign(new Error('spawn systemctl ENOENT'), { code: 'ENOENT' });
    const log = vi.fn();
    const first = fakeSystemctl([{ error: missing }]);
    expect(
      await stopDeadHostScopes(4242, {
        execFile: first.execFile,
        env: BUS,
        platform: 'linux',
        exists: withBus,
        log,
      })
    ).toBeNull();
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining('ENOENT'));
    const second = fakeSystemctl([
      { stdout: 'dsh-subprocess-4242-ab.scope loaded active running x\n' },
      { error: new Error('Command failed'), stderr: 'Access denied' },
      {},
    ]);
    expect(
      await stopDeadHostScopes(4242, {
        execFile: second.execFile,
        env: BUS,
        platform: 'linux',
        exists: withBus,
        log,
      })
    ).toBeNull();
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining('Access denied'));
    const throwing: SystemctlExecFile = () => {
      throw new Error('EAGAIN');
    };
    expect(
      await stopDeadHostScopes(4242, {
        execFile: throwing,
        env: BUS,
        platform: 'linux',
        exists: withBus,
        log,
      })
    ).toBeNull();
  });
});
