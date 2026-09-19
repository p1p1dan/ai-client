/**
 * T101 — the marker a tool call's `input` carries while its arguments are
 * still being dictated by the model, and how to read it.
 *
 * A tool row now opens on the FIRST partial arguments pi reports, not at
 * `tool_execution_start`. At that moment the arguments are a partially-parsed
 * JSON object whose long fields can be an entire file, so the projector
 * forwards only the short identifying ones (`path`, `command`, `pattern`, …)
 * and replaces the rest with the size summary below. The complete arguments
 * arrive in one later `tool.updated`, without this key.
 *
 * The key's PRESENCE is therefore also the "not final yet" signal, and three
 * renderer decisions hang off it: a Write/Edit row says how much of the file
 * has arrived instead of showing a path alone, no diff is computed from a
 * half-written file, and the raw-argument body stays closed.
 *
 * Its own module, deliberately small. `types/runtimeEvents.ts` is where this
 * belongs by subject, but that file is imported `type`-only almost everywhere
 * and therefore erased from the renderer bundle; importing a VALUE out of it
 * from `toolCard.ts` would pull the whole thing into a chat chunk and add a
 * cross-chunk edge this repo has already been bitten by (2026-08 circular
 * chunk incident). A leaf module with no imports of its own cannot do that.
 */

/** Key under which a streaming tool `input` carries {@link StreamingToolArgs}. */
export const STREAMING_TOOL_ARGS_KEY = '__streaming';

/** Size of the long text fields the streaming summary stands in for. */
export interface StreamingToolArgs {
  /** UTF-8 bytes of withheld text received so far. */
  bytes: number;
  /** Lines that text spans so far; `0` before any of it has arrived. */
  lines: number;
}

/**
 * Lines a partial text spans so far.
 *
 * A trailing newline has not opened a line with anything in it yet, so it does
 * not count: `"a\nb"` is two lines, `"a\n"` is one, and `""` is none. Shared
 * with the producer so "received N lines" means one thing on both sides.
 */
export function countStreamingLines(text: string): number {
  if (!text) return 0;
  let lines = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) lines += 1;
  }
  return text.endsWith('\n') ? lines - 1 : lines;
}

/**
 * The summary on a tool `input`, or `undefined` when the arguments are final.
 *
 * Tolerant about the payload's shape on purpose: it crossed a process boundary
 * and a malformed one must degrade to "streaming, size unknown" rather than
 * throw inside a pure view derivation.
 */
export function readStreamingToolArgs(input: unknown): StreamingToolArgs | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  const marker = (input as Record<string, unknown>)[STREAMING_TOOL_ARGS_KEY];
  if (typeof marker !== 'object' || marker === null) return undefined;
  const { bytes, lines } = marker as { bytes?: unknown; lines?: unknown };
  return {
    bytes: typeof bytes === 'number' && Number.isFinite(bytes) ? bytes : 0,
    lines: typeof lines === 'number' && Number.isFinite(lines) ? lines : 0,
  };
}
