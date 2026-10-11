import { describe, expect, it } from 'vitest';
import {
  descendantsOf,
  parseWindowsProcessLine,
  winFileTimeToUnixMs,
} from '../process-tree-lib.mjs';

/**
 * CI run 38161740769 (Windows, L1): every system process (csrss.exe, wininit.exe,
 * services.exe, lsass.exe, dozens of svchost.exe) showed up as an l1NoLeftovers
 * "leftover" after the host had already exited 0. Windows never clears an orphan's
 * ppid when its real parent dies, and pids are reused, so a boot-time process whose
 * dead parent happened to get the host's own (now reused) pid makes the whole system
 * tree look descended from the host. descendantsOf()'s `floorMs` guards against this:
 * a claimed child must have been created no earlier than its claimed parent.
 */
describe('descendantsOf: Windows pid-reuse guard', () => {
  const HOST_PID = 4321;
  const BOOT_TIME = 1_000_000; // some far-past epoch ms, e.g. system boot
  const HOST_START = BOOT_TIME + 10 * 24 * 60 * 60 * 1000; // host started 10 days after boot

  it('rejects a system tree whose ppid is a dead, reused pid created long before the host', () => {
    // The host itself is gone from the table (it already exited); only `floorMs`
    // carries its creation time into the walk. 100's real parent died long ago and
    // Windows reused its pid for the host; 100 still reports ppid === HOST_PID.
    const table = new Map([
      [100, { ppid: HOST_PID, start: BOOT_TIME, name: 'csrss.exe' }],
      [101, { ppid: 100, start: BOOT_TIME + 10, name: 'svchost.exe' }],
    ]);
    expect(descendantsOf(HOST_PID, table, HOST_START)).toEqual([]);
  });

  it('still accepts a real child created after the host, including grandchildren', () => {
    const childStart = HOST_START + 5_000;
    const grandchildStart = childStart + 1_000;
    const table = new Map([
      [200, { ppid: HOST_PID, start: childStart, name: 'node.js' }],
      [201, { ppid: 200, start: grandchildStart, name: 'rg.exe' }],
    ]);
    const found = descendantsOf(HOST_PID, table, HOST_START);
    expect(found.map((row) => row.pid).sort()).toEqual([200, 201]);
  });

  it('rejects a grandchild older than its own claimed (real) parent', () => {
    // 200 is a real child created after the host; 201 claims 200 as parent but was
    // actually created earlier — another pid-reuse coincidence one level down.
    const childStart = HOST_START + 5_000;
    const table = new Map([
      [200, { ppid: HOST_PID, start: childStart, name: 'node.js' }],
      [201, { ppid: 200, start: HOST_START + 1_000, name: 'old.exe' }],
    ]);
    const found = descendantsOf(HOST_PID, table, HOST_START);
    expect(found.map((row) => row.pid)).toEqual([200]);
  });

  it('keeps the old, unfiltered behaviour when no floor is given (Linux/macOS)', () => {
    const table = new Map([
      [100, { ppid: HOST_PID, start: BOOT_TIME, name: 'ancient' }],
      [101, { ppid: 100, start: BOOT_TIME + 10, name: 'child-of-ancient' }],
    ]);
    const found = descendantsOf(HOST_PID, table);
    expect(found.map((row) => row.pid).sort()).toEqual([100, 101]);
  });

  it('tolerates a couple seconds of skew between Date.now() and a CIM CreationDate read', () => {
    const table = new Map([[300, { ppid: HOST_PID, start: HOST_START - 500, name: 'node.js' }]]);
    expect(descendantsOf(HOST_PID, table, HOST_START).map((row) => row.pid)).toEqual([300]);
  });

  it('does not reject a row with an unknown (0) creation time', () => {
    const table = new Map([[400, { ppid: HOST_PID, start: 0, name: 'unknown-creation-date' }]]);
    expect(descendantsOf(HOST_PID, table, HOST_START).map((row) => row.pid)).toEqual([400]);
  });
});

describe('winFileTimeToUnixMs', () => {
  it('converts a Win32_Process CreationDate.ToFileTimeUtc() value to Unix epoch ms', () => {
    // 2026-01-01T00:00:00Z in FILETIME ticks (100 ns since 1601-01-01).
    const unixMs = Date.UTC(2026, 0, 1);
    const fileTime = (unixMs + 11_644_473_600_000) * 10_000;
    expect(Math.abs(winFileTimeToUnixMs(fileTime) - unixMs)).toBeLessThan(1);
  });

  it('returns 0 for an unknown (0) creation time', () => {
    expect(winFileTimeToUnixMs(0)).toBe(0);
  });
});

describe('parseWindowsProcessLine', () => {
  it('parses a normal CIM-derived line', () => {
    expect(parseWindowsProcessLine('4321 1 132000000000000000 svchost.exe')).toEqual({
      pid: 4321,
      ppid: 1,
      start: winFileTimeToUnixMs(132000000000000000),
      name: 'svchost.exe',
    });
  });

  it('keeps a process name containing spaces', () => {
    expect(parseWindowsProcessLine('8 4 0 System Idle Process')).toEqual({
      pid: 8,
      ppid: 4,
      start: 0,
      name: 'System Idle Process',
    });
  });

  it('returns null for a line that does not match', () => {
    expect(parseWindowsProcessLine('not a process line')).toBeNull();
    expect(parseWindowsProcessLine('')).toBeNull();
  });
});
