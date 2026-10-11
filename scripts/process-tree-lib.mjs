/**
 * Pure helpers for the packaged DSH host smoke's process-tree walk
 * (scripts/packaged-dsh-host-smoke.mjs), kept apart so scripts/__tests__ can
 * exercise them with a synthetic table instead of spawning anything (same
 * reason scripts/dsh-host-smoke-lib.mjs exists for the hook-record helpers).
 *
 * Windows never clears an orphan's ppid when its real parent dies, and pids
 * get reused, so a long-dead ancestor's pid can coincide with a later
 * process's own pid and make an unrelated subtree look descended from it
 * (seen for real in CI: every system process showed up as a packaged host's
 * "leftover" after it had already exited 0). descendantsOf()'s `floorMs`
 * guards against that: a claimed child must have been created no earlier
 * than its claimed parent.
 */

/** Windows FILETIME epoch (1601-01-01) to Unix epoch (1970-01-01), in milliseconds. */
export const FILETIME_EPOCH_DIFF_MS = 11_644_473_600_000;
/** Allowance for the gap between a script's Date.now() and a CIM CreationDate read. */
export const CREATION_TIME_TOLERANCE_MS = 2_000;

/** Windows CIM `CreationDate.ToFileTimeUtc()` (100 ns ticks) to Unix epoch ms, or 0 if unknown. */
export function winFileTimeToUnixMs(fileTime) {
  return fileTime > 0 ? fileTime / 10_000 - FILETIME_EPOCH_DIFF_MS : 0;
}

/** One `<pid> <ppid> <creationFileTime> <name>` line from the PowerShell sample, or null. */
export function parseWindowsProcessLine(line) {
  const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s*(.*)$/);
  if (!match) return null;
  return {
    pid: Number(match[1]),
    ppid: Number(match[2]),
    start: winFileTimeToUnixMs(Number(match[3])),
    name: match[4],
  };
}

/**
 * `floorMs`, when given (Windows only — undefined keeps Linux/macOS behaviour exactly as
 * before), rejects a claimed child created well before it: Windows keeps an orphan's dead
 * parent pid forever, and pids get reused, so a long-dead ancestor's pid can coincide with
 * the host's own and make the whole system tree look descended from it. A real child is
 * created no earlier than its parent, so the floor is raised to each accepted node's own
 * creation time while walking deeper.
 */
export function descendantsOf(rootPid, table, floorMs) {
  const out = [];
  const queue = [{ pid: rootPid, floor: floorMs }];
  while (queue.length > 0) {
    const { pid: parent, floor } = queue.shift();
    for (const [pid, row] of table) {
      if (row.ppid !== parent || out.some((item) => item.pid === pid)) continue;
      if (
        floor !== undefined &&
        typeof row.start === 'number' &&
        row.start > 0 &&
        row.start < floor - CREATION_TIME_TOLERANCE_MS
      ) {
        continue; // Created well before `floor`: a reused pid, not really our descendant.
      }
      out.push({ pid, ...row });
      const nextFloor =
        floor === undefined
          ? undefined
          : Math.max(floor, typeof row.start === 'number' ? row.start : 0);
      queue.push({ pid, floor: nextFloor });
    }
  }
  return out;
}
