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

/**
 * Runs a command with its stdin closed. Windows PowerShell can sit on an open stdin pipe
 * until its timeout: on GitHub's Windows runners the snapshot below came back empty after
 * 15 s every time while the same query from the probe took 0.3 s (README §11.2 #52).
 */
function runClosed(file: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      { windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(Object.assign(error, { stderrText: String(stderr ?? '') }));
        else resolve(String(stdout));
      }
    );
    child.stdin?.end();
  });
}

function describeFailure(error: unknown): string {
  const e = error as { killed?: boolean; code?: unknown; message?: string; stderrText?: string };
  const what = e.killed ? 'timed out' : `code ${String(e.code ?? '?')}`;
  // A timeout's message only repeats the command line.
  const detail = (e.stderrText || (e.killed ? '' : e.message) || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
  return detail ? `${what}: ${detail}` : what;
}

export interface SampleOptions {
  /** Default 15 s. */
  timeoutMs?: number;
  /** Told why a sample came back empty, and how long it took. */
  log?: (message: string) => void;
}

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

/**
 * The Windows sample: CimCmdlets imported by path (left to auto-loading, Get-CimInstance is
 * looked up across every installed module), only the four properties used, and a process
 * without a creation date (the idle process) does not fail the whole query. Exported so
 * the host probe can time exactly this query in other environments (README §11.2 #52).
 */
export const WINDOWS_POWERSHELL_ARGS: readonly string[] = [
  '-NoProfile',
  '-NonInteractive',
  '-InputFormat',
  'None',
  '-Command',
];
export const WINDOWS_PROCESS_QUERY =
  "Import-Module (Join-Path $PSHOME 'Modules/CimCmdlets'); Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,Name | ForEach-Object { $t = if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }; '{0} {1} {2} {3}' -f $_.ProcessId,$_.ParentProcessId,$t,$_.Name }";

export async function sampleProcesses(
  options: SampleOptions = {}
): Promise<Map<number, ProcessRow>> {
  const table = new Map<number, ProcessRow>();
  const timeout = options.timeoutMs ?? 15_000;
  const started = Date.now();
  try {
    if (process.platform === 'win32') {
      const stdout = await runClosed(
        'powershell',
        [...WINDOWS_POWERSHELL_ARGS, WINDOWS_PROCESS_QUERY],
        timeout
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
      const stdout = await runClosed('ps', ['-A', '-o', 'pid=,ppid=,comm='], timeout);
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
  } catch (error) {
    // No sample, nothing to reap; the stop itself goes on.
    options.log?.(
      `process sample failed after ${Date.now() - started} ms: ${describeFailure(error)}`
    );
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

export interface MsysRow {
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
/** Git Bash's own process table (`usr\\bin\\ps.exe`); empty when it cannot be read. */
export async function msysProcessTable(
  gitBashPath: string,
  timeoutMs = 15_000
): Promise<MsysRow[]> {
  const ps = gitBashPath.replace(/[\\/]bin[\\/]bash\.exe$/i, '\\usr\\bin\\ps.exe');
  let stdout = '';
  try {
    stdout = await runClosed(ps, [], timeoutMs);
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
  return rows;
}

export async function msysToolProcesses(
  gitBashPath: string,
  shells: ProcessRow[],
  timeoutMs = 15_000
): Promise<ProcessRow[]> {
  const rows = await msysProcessTable(gitBashPath, timeoutMs);
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

/** Ends one process; false when it could not be signalled. */
export type KillProcess = (pid: number) => boolean;

/**
 * The real signal. Injectable in `reap` so a test never reaches it with a
 * made-up pid (engineering standard, appendix B1).
 */
export const killProcess: KillProcess = (pid) => {
  if (process.platform === 'win32') {
    return spawnSync('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true }).status === 0;
  }
  try {
    process.kill(pid, 'SIGKILL');
    return true;
  } catch {
    return false;
  }
};

/**
 * End the processes of `before` whose parent is gone in `after` (orphans), or,
 * with `all`, every one of them still alive. The same pid must still carry the
 * same name (and, for a Windows row, the same creation time), so a reused pid
 * is never killed.
 */
export function reap(
  before: ProcessRow[],
  after: Map<number, ProcessRow>,
  all = false,
  kill: KillProcess = killProcess
): ProcessRow[] {
  const killed: ProcessRow[] = [];
  for (const row of before) {
    const now = after.get(row.pid);
    if (!now || now.name.toLowerCase() !== row.name.toLowerCase()) continue;
    if (!row.msys && Math.abs(now.start - row.start) > CREATION_TOLERANCE_MS) continue;
    const parentAlive = !row.msys && after.has(row.ppid);
    if (!all && parentAlive) continue;
    if (!kill(row.pid)) continue;
    killed.push(row);
  }
  return killed;
}
