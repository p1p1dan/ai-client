/**
 * Host stderr line assembly (pure).
 *
 * Utility workers emit raw stderr chunks: one chunk may carry several
 * lines, and it may end mid-line. Logging chunks verbatim interleaves partial
 * lines in main.log, which is what made the 2026-07-28 Linux launch failure
 * unreadable — the Host's own diagnostics never reached any sink at all.
 *
 * Callers keep a `pending` string between chunks and drain complete lines
 * through here. Kept separate from the manager so the buffering rules are unit
 * testable: the manager's stderr path runs inside `startInternal()`, which
 * spawns a real process and is unreachable from vitest.
 *
 * §12 verification first: __tests__/hostStderr.test.ts.
 */

/**
 * Longest line written to the log. The Host can emit a whole serialized SDK
 * payload on one line; the tail is noise once the failure is identifiable.
 */
export const MAX_STDERR_LINE_CHARS = 2000;

export const TRUNCATION_SUFFIX = ' …[truncated]';

export interface StderrDrain {
  /** Complete lines, already trimmed and truncated — ready to log. */
  lines: string[];
  /** Bytes after the last newline; feed back on the next chunk. */
  pending: string;
  /**
   * main-aux-08 — characters already thrown away from a logical line that has
   * run past the cap without a newline. Non-zero means "still inside that
   * line"; `pending` is then always empty, because the two states are
   * exclusive. Feed it back with `pending` on the next chunk.
   */
  dropped: number;
}

/** One line that accounts for what an over-long unterminated line cost. */
function droppedNotice(chars: number): string {
  return `…[dropped ${chars} chars of an unterminated line]`;
}

function clampLine(line: string): string {
  if (line.length <= MAX_STDERR_LINE_CHARS) return line;
  return line.slice(0, MAX_STDERR_LINE_CHARS) + TRUNCATION_SUFFIX;
}

/**
 * Split `pending + chunk` into complete lines.
 *
 * Blank lines are dropped — the Host separates its diagnostic blocks with
 * them and they carry no information once each line is logged separately.
 *
 * A `pending` that grows past the cap without ever seeing a newline is
 * emitted as a truncated line and reset. Without that guard a Host that
 * streams a newline-free payload would grow this buffer without bound.
 *
 * main-aux-08 — that guard bounded MEMORY only. The rest of the same logical
 * line came back on the next chunk and was emitted as another line, so a
 * newline-free megabyte turned into one 2000-char line per over-long chunk
 * instead of the "tail is noise" the cap's comment promises. Those slices then
 * evicted the boot banner and the SDK stack from the 50-line crash-replay
 * window below, which is the only thing that window exists to hold. So the
 * remainder is now SWALLOWED until the line ends, and one accounting line says
 * how much went: bounded in memory and in line count, with nothing silently
 * missing.
 */
export function drainStderrLines(pending: string, chunk: string, dropped = 0): StderrDrain {
  const combined = pending + chunk;
  const parts = combined.split(/\r?\n/);
  // split() always returns at least one element; the last is the incomplete tail.
  const tail = parts.pop() ?? '';
  const lines: string[] = [];
  let discarding = dropped > 0;
  let discarded = dropped;

  for (const part of parts) {
    if (discarding) {
      // The first complete segment while discarding is the END of the
      // over-long line, not a line of its own.
      discarded += part.length;
      lines.push(droppedNotice(discarded));
      discarding = false;
      discarded = 0;
      continue;
    }
    const trimmed = part.trim();
    if (trimmed) lines.push(clampLine(trimmed));
  }

  // Still no newline: the whole tail belongs to the line being discarded.
  if (discarding) return { lines, pending: '', dropped: discarded + tail.length };

  if (tail.length > MAX_STDERR_LINE_CHARS) {
    const trimmed = tail.trim();
    if (trimmed) lines.push(clampLine(trimmed));
    // The head was just emitted; everything past the cap starts the discard.
    return { lines, pending: '', dropped: tail.length - MAX_STDERR_LINE_CHARS };
  }

  return { lines, pending: tail, dropped: 0 };
}

/**
 * Emit whatever is left when the Host exits, so the last line is not lost.
 *
 * A worker that dies mid-payload leaves `dropped` instead of `pending`; the
 * accounting line is still worth emitting, because "the last thing this worker
 * printed was 800 KB without a newline" is itself the diagnosis.
 */
export function flushStderrPending(pending: string, dropped = 0): string[] {
  if (dropped > 0) return [droppedNotice(dropped)];
  const trimmed = pending.trim();
  return trimmed ? [clampLine(trimmed)] : [];
}

/**
 * How many recent stderr lines to keep for the failure dump. The Host's boot
 * banner plus an SDK stack fits well inside this.
 */
export const RECENT_STDERR_LIMIT = 50;

/**
 * Keep the last N lines for replay on failure.
 *
 * Per-line logging runs at `info`, and this app ships with file logging at
 * `error` only unless the user turns it on (logger.ts initLogger defaults
 * `enabled` to false) — so info-level lines are dropped in the configuration
 * almost everyone runs. Without this buffer the stderr wiring would look
 * correct and still tell you nothing on the one day it matters.
 */
export function pushRecentStderr(
  recent: readonly string[],
  lines: readonly string[],
  limit = RECENT_STDERR_LIMIT
): string[] {
  if (lines.length === 0) return [...recent];
  const merged = [...recent, ...lines];
  return merged.length <= limit ? merged : merged.slice(merged.length - limit);
}
