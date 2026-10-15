/**
 * Route-B prototype: reap what the Claude Code CLI leaves behind on Windows.
 *
 * Measured on Windows 10 with Git Bash (2026-10-14): after `interrupt()` the
 * CLI reports the running Bash call as cancelled and kills its `bash.exe`, but
 * the MSYS children that shell started (`sleep 97 & sleep 97; wait`) keep
 * running as orphans, and still run after the CLI itself has exited. So the
 * host snapshots what the tool call started before it interrupts, and ends
 * whatever of that is still alive afterwards. Processes the CLI keeps on
 * purpose (an MCP server, say) still have a live parent and are left alone.
 *
 * Same guard as `scripts/process-tree-lib.mjs`: Windows keeps an orphan's dead
 * parent pid and reuses pids, so a child must not predate its parent.
 */

import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface ProcessRow {
  pid: number;
  ppid: number;
  /** Creation time, Unix ms; 0 when unknown (POSIX sample, MSYS rows). */
  start: number;
  name: string;
  /**
   * Found through Git Bash's own process table (an MSYS process of a tool
   * call's process group): its Windows parent is meaningless, so it is ended
   * whenever it outlives the stop.
   */
  msys?: boolean;
}

const FILETIME_EPOCH_DIFF_MS = 11_644_473_600_000;
const CREATION_TOLERANCE_MS = 2_000;

export async function sampleProcesses(): Promise<Map<number, ProcessRow>> {
  const table = new Map<number, ProcessRow>();
  try {
    if (process.platform === 'win32') {
      const script =
        "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2} {3}' -f $_.ProcessId,$_.ParentProcessId,$_.CreationDate.ToFileTimeUtc(),$_.Name }";
      const { stdout } = await run(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        {
          windowsHide: true,
          timeout: 15_000,
        }
      );
      for (const line of stdout.split(/\r?\n/)) {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s*(.*)$/);
        if (!match) continue;
        const fileTime = Number(match[3]);
        table.set(Number(match[1]), {
          pid: Number(match[1]),
          ppid: Number(match[2]),
          start: fileTime > 0 ? fileTime / 10_000 - FILETIME_EPOCH_DIFF_MS : 0,
          name: match[4],
        });
      }
    } else {
      const { stdout } = await run('ps', ['-A', '-o', 'pid=,ppid=,comm='], { timeout: 15_000 });
      for (const line of stdout.split('\n')) {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
        if (match) {
          table.set(Number(match[1]), {
            pid: Number(match[1]),
            ppid: Number(match[2]),
            start: 0,
            name: match[3],
          });
        }
      }
    }
  } catch {
    // No sample, nothing to reap; the stop itself already happened.
  }
  return table;
}

export function descendantsOf(rootPid: number, table: Map<number, ProcessRow>): ProcessRow[] {
  const out: ProcessRow[] = [];
  const root = table.get(rootPid);
  const queue: Array<{ pid: number; floor: number }> = [{ pid: rootPid, floor: root?.start ?? 0 }];
  while (queue.length > 0) {
    const { pid: parent, floor } = queue.shift() as { pid: number; floor: number };
    for (const row of table.values()) {
      if (row.ppid !== parent || row.pid === rootPid || out.some((item) => item.pid === row.pid))
        continue;
      if (floor > 0 && row.start > 0 && row.start < floor - CREATION_TOLERANCE_MS) continue;
      out.push(row);
      queue.push({ pid: row.pid, floor: row.start || floor });
    }
  }
  return out;
}

interface MsysRow {
  pid: number;
  ppid: number;
  pgid: number;
  winpid: number;
  command: string;
}

/**
 * Git Bash (MSYS) processes started by the shells in `shells`.
 *
 * MSYS emulates fork and exec with new Windows processes, so a command's
 * Windows parent has usually exited while it still runs (measured: every
 * `sleep` of `sleep 97 & sleep 97; wait` had a dead parent pid). MSYS keeps
 * its own tree, which `usr\bin\ps.exe` prints with each process's Windows pid:
 * the shells the CLI started are matched by Windows pid, and their process
 * groups and MSYS descendants are what the tool call started.
 */
export async function msysToolProcesses(
  gitBashPath: string,
  shells: ProcessRow[]
): Promise<ProcessRow[]> {
  const ps = gitBashPath.replace(/[\\/]bin[\\/]bash\.exe$/i, '\\usr\\bin\\ps.exe');
  let stdout = '';
  try {
    ({ stdout } = await run(ps, [], { windowsHide: true, timeout: 15_000 }));
  } catch {
    return [];
  }
  const rows: MsysRow[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    // PID PPID PGID WINPID TTY UID STIME COMMAND, with an optional status letter first.
    const match = line.match(
      /^\s*[A-Z]?\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+\S+\s+\d+\s+\S+\s+(.*)$/
    );
    if (match) {
      rows.push({
        pid: Number(match[1]),
        ppid: Number(match[2]),
        pgid: Number(match[3]),
        winpid: Number(match[4]),
        command: match[5].trim(),
      });
    }
  }
  const shellWinPids = new Set(shells.map((row) => row.pid));
  const roots = rows.filter((row) => shellWinPids.has(row.winpid));
  const groups = new Set(roots.map((row) => row.pgid));
  const tree = new Set(roots.map((row) => row.pid));
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows) {
      if (!tree.has(row.pid) && (tree.has(row.ppid) || groups.has(row.pgid))) {
        tree.add(row.pid);
        grew = true;
      }
    }
  }
  return rows
    .filter((row) => tree.has(row.pid) && !shellWinPids.has(row.winpid))
    .map((row) => ({
      pid: row.winpid,
      ppid: -1,
      start: 0,
      name: `${row.command.split('/').pop() ?? row.command}.exe`,
      msys: true,
    }));
}

/**
 * End the processes of `before` whose parent is gone in `after` (orphans), or,
 * with `all`, every one of them still alive. The same pid must still carry the
 * same name (and, for a Windows row, the same creation time), so a reused pid
 * is never killed.
 */
export function reap(
  before: ProcessRow[],
  after: Map<number, ProcessRow>,
  all = false
): ProcessRow[] {
  const killed: ProcessRow[] = [];
  for (const row of before) {
    const now = after.get(row.pid);
    if (!now || now.name.toLowerCase() !== row.name.toLowerCase()) continue;
    if (!row.msys && Math.abs(now.start - row.start) > CREATION_TOLERANCE_MS) continue;
    const parentAlive = !row.msys && after.has(row.ppid);
    if (!all && parentAlive) continue;
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(row.pid), '/F'], { windowsHide: true });
    } else {
      try {
        process.kill(row.pid, 'SIGKILL');
      } catch {
        continue;
      }
    }
    killed.push(row);
  }
  return killed;
}
