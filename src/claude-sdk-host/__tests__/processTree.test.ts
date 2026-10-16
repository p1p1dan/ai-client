import { afterEach, describe, expect, it, vi } from 'vitest';
import { killProcess, type ProcessRow, reap } from '../processTree.ts';

// No test here may send a real signal (engineering standard, appendix B1): both ways
// out, `taskkill` and `process.kill`, are replaced before processTree.ts loads, and
// every pid below is made up.
const spawnSync = vi.hoisted(() => vi.fn(() => ({ status: 0 })));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawnSync,
}));
const signal = vi.spyOn(process, 'kill').mockImplementation(() => true);

afterEach(() => {
  spawnSync.mockClear();
  signal.mockClear();
});

const T0 = 1_792_000_000_000;

function row(pid: number, ppid: number, name: string, start = T0, msys = false): ProcessRow {
  return { pid, ppid, start, name, ...(msys ? { msys: true } : {}) };
}

function table(...rows: ProcessRow[]): Map<number, ProcessRow> {
  return new Map(rows.map((r) => [r.pid, r]));
}

describe('reap', () => {
  afterEach(() => {
    // reap reaches a process only through the killer it is given.
    expect(spawnSync).not.toHaveBeenCalled();
    expect(signal).not.toHaveBeenCalled();
  });

  it('ends an orphan whose parent is gone and leaves a child of a live parent', () => {
    const kill = vi.fn(() => true);
    const orphan = row(4101, 4100, 'sleep.exe');
    const kept = row(4201, 4200, 'node.exe');
    const killed = reap(
      [orphan, kept],
      table(orphan, kept, row(4200, 1, 'claude.exe')),
      false,
      kill
    );
    expect(killed).toEqual([orphan]);
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(4101);
  });

  it('with all, ends every listed process still alive', () => {
    const kill = vi.fn(() => true);
    const child = row(4201, 4200, 'node.exe');
    const killed = reap([child], table(child, row(4200, 1, 'claude.exe')), true, kill);
    expect(killed).toEqual([child]);
  });

  it('never ends a reused pid: other name, or a Windows row created at another time', () => {
    const kill = vi.fn(() => true);
    const before = [row(4301, 4300, 'sleep.exe'), row(4302, 4300, 'sleep.exe')];
    const after = table(row(4301, 4300, 'notepad.exe'), row(4302, 4300, 'sleep.exe', T0 + 10_000));
    expect(reap(before, after, true, kill)).toEqual([]);
    expect(kill).not.toHaveBeenCalled();
  });

  it('ends an MSYS row whenever it outlives the stop, its Windows parent being meaningless', () => {
    const kill = vi.fn(() => true);
    const msys = row(4401, -1, 'sleep.exe', 0, true);
    // An MSYS row matches on pid and name only: its ppid and creation time are not compared.
    const killed = reap([msys], table(row(4401, 77, 'sleep.exe', T0)), false, kill);
    expect(killed).toEqual([msys]);
  });

  it('skips what is already gone and what could not be signalled', () => {
    const kill = vi.fn((pid: number) => pid !== 4502);
    const gone = row(4501, 4500, 'sleep.exe');
    const stubborn = row(4502, 4500, 'sleep.exe');
    expect(reap([gone, stubborn], table(stubborn), false, kill)).toEqual([]);
    expect(kill).toHaveBeenCalledWith(4502);
  });
});

describe('killProcess', () => {
  it('is the one path to a real signal: taskkill on Windows, SIGKILL elsewhere', () => {
    expect(killProcess(4601)).toBe(true);
    if (process.platform === 'win32') {
      expect(spawnSync).toHaveBeenCalledWith('taskkill', ['/PID', '4601', '/F'], {
        windowsHide: true,
      });
      expect(signal).not.toHaveBeenCalled();
    } else {
      expect(signal).toHaveBeenCalledWith(4601, 'SIGKILL');
      expect(spawnSync).not.toHaveBeenCalled();
    }
  });

  it('reports a process it could not signal as not ended', () => {
    if (process.platform === 'win32') spawnSync.mockReturnValueOnce({ status: 128 });
    else
      signal.mockImplementationOnce(() => {
        throw new Error('ESRCH');
      });
    expect(killProcess(4602)).toBe(false);
  });
});
