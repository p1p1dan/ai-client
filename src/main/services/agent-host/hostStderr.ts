/**
 * Host stderr line assembly (pure).
 *
 * `AgentHostProcess` emits raw stderr chunks: one chunk may carry several
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
 */
export function drainStderrLines(pending: string, chunk: string): StderrDrain {
  const combined = pending + chunk;
  const parts = combined.split(/\r?\n/);
  // split() always returns at least one element; the last is the incomplete tail.
  const tail = parts.pop() ?? '';
  const lines: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed) lines.push(clampLine(trimmed));
  }

  if (tail.length > MAX_STDERR_LINE_CHARS) {
    const trimmed = tail.trim();
    if (trimmed) lines.push(clampLine(trimmed));
    return { lines, pending: '' };
  }

  return { lines, pending: tail };
}

/** Emit whatever is left when the Host exits, so the last line is not lost. */
export function flushStderrPending(pending: string): string[] {
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
