import {
  countStreamingLines,
  STREAMING_TOOL_ARGS_KEY,
  type StreamingToolArgs,
} from '../../shared/streamingToolArgs.ts';

/**
 * T101 — what a tool row may say about itself while its arguments are still
 * being dictated by the model.
 *
 * pi hands us a partially-parsed arguments object on every `message_update`
 * (`parseStreamingJson` over the accumulated partial JSON), so the fields that
 * arrived first are already readable — and for `write` and `edit` the first
 * one is the `path`, which is exactly what a person needs to see.
 *
 * What must NOT travel is the rest. `write` takes `{ path, content }` with
 * `content` capped at 8 MiB, and `edit` takes whole before/after texts; sending
 * a growing snapshot of those on every chunk would push the same file across
 * the worker port hundreds of times, and would hand the renderer a TRUNCATED
 * file that `deriveToolDiff` would happily render as a complete one.
 *
 * So this is an ALLOW list, not a deny list. A deny list would have to
 * enumerate every long field of every tool — including MCP tools, whose
 * schemas are written by someone else and cannot be enumerated at all — and
 * the failure mode of missing one is leaking a blob, silently. Missing one here
 * instead means a short field is described by the size summary rather than
 * shown, which costs a line of detail for the second or two before the call
 * settles and the complete arguments replace this entirely.
 */

/**
 * Short, identifying fields, taken from the typebox schemas in
 * `src/runtime/plugins/tools/index.ts` plus the Claude-era spellings a replayed
 * transcript still uses (`file_path` where pi says `path`).
 *
 * Every one of them is either what the row's argument column already displays
 * (`formatToolArgDetail`) or a small modifier of it.
 */
const SHORT_ARG_FIELDS: ReadonlySet<string> = new Set([
  // read / write / edit / ls / browser_preview / glob / grep
  'path',
  'file_path',
  // read
  'offset',
  'limit',
  // bash
  'command',
  'timeoutSeconds',
  'timeoutMs',
  // glob / grep
  'pattern',
  'include',
  'caseInsensitive',
  'regex',
  'respectGitignore',
  // skill
  'name',
  // Task, and the two CLI spellings a replayed transcript carries
  'agent',
  'subagent_type',
  'description',
  // Claude-era web tools, still reachable from history
  'query',
  'url',
]);

/**
 * Longest short field forwarded verbatim. A `bash` command may be up to 32 KiB
 * by schema; the row shows one CSS-truncated line of it either way, and the
 * complete text arrives with the settled arguments moments later.
 */
const SHORT_ARG_MAX_CHARS = 512;

/** Text withheld from the summary, measured so the row can say how much there is. */
interface TextSize {
  bytes: number;
  lines: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Add up every string inside `value`, however deeply it is nested. */
function measure(value: unknown, into: TextSize): void {
  if (typeof value === 'string') {
    into.bytes += Buffer.byteLength(value, 'utf8');
    into.lines += countStreamingLines(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) measure(item, into);
    return;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) measure(item, into);
  }
}

function isShortValue(value: unknown): boolean {
  if (typeof value === 'string') return true;
  if (typeof value === 'boolean') return true;
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * The redacted arguments a streaming tool row is drawn from: the allow-listed
 * short fields that have arrived, plus one summary of everything else.
 *
 * The summary key is present even when nothing has been withheld yet — its
 * presence is what tells the renderer these arguments are not final, and a
 * `write` whose `content` has not started arriving still has an unfinished
 * `path`.
 */
export function summarizeStreamingToolArgs(args: unknown): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  const withheld: TextSize = { bytes: 0, lines: 0 };
  if (isRecord(args)) {
    for (const [key, value] of Object.entries(args)) {
      if (SHORT_ARG_FIELDS.has(key) && isShortValue(value)) {
        summary[key] =
          typeof value === 'string' && value.length > SHORT_ARG_MAX_CHARS
            ? value.slice(0, SHORT_ARG_MAX_CHARS)
            : value;
        continue;
      }
      measure(value, withheld);
    }
  }
  const streaming: StreamingToolArgs = { bytes: withheld.bytes, lines: withheld.lines };
  summary[STREAMING_TOOL_ARGS_KEY] = streaming;
  return summary;
}

/**
 * A comparable rendering of a summary, for "has anything actually changed".
 *
 * Key order follows the order the provider emitted the fields in, which is
 * stable within one call — a new field only ever appends. Two summaries that
 * stringify identically describe the same row, so the update they would carry
 * is a no-op and is never sent.
 */
export function streamingToolArgsKey(summary: Record<string, unknown>): string {
  return JSON.stringify(summary);
}
