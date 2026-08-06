/**
 * T-34: the size/privacy gate every subagent fact crosses before it becomes a
 * `subagent.activity` event. Same role `stderrRedaction.ts` plays for CLI
 * stderr — the Main-process bridge is a content-agnostic passthrough, so this
 * module is the only place between a subagent's raw tool input and the
 * renderer (and anything that screenshots it).
 *
 * Two independent jobs, both deliberate:
 *
 *  - **Whitelist projection** of tool inputs. A subagent's `Write`/`Edit` input
 *    carries whole file bodies; a `Bash` input carries the command. Forwarding
 *    the raw object would put file contents on IPC for a row that only ever
 *    renders a one-line argument. Only the fields `toolCard.ts`'s own arg
 *    formatter reads survive, so the projection is bounded by what the UI can
 *    actually display rather than by what the tool happened to send.
 *  - **Length clamps** on every free-text body that does survive (tool arg
 *    fields, assistant text/thinking, failure text). The per-delegation event
 *    CAP below bounds the event COUNT; these bound each event's SIZE. Both are
 *    needed for acceptance ④ to be a structural guarantee rather than an
 *    estimate off one probe run.
 *
 * Pure, no imports — assertable under the repo's node-env vitest.
 */

/**
 * Tool-input fields that survive projection: exactly the keys
 * `formatToolArgDetail` (src/renderer/components/chat/toolCard.ts) reads to
 * build a row's one-line argument, plus the two numeric Read-range fields its
 * `L{offset}-{end}` suffix needs.
 *
 * Everything else is dropped, including — by name, because these are the ones
 * that would actually hurt — `content`, `new_string`, `old_string`, `prompt`,
 * `todos`, `edits`. A subagent's delegation prompt is likewise absent: the
 * main Agent row's own input body already shows it (T-34 §1 Q5).
 */
export const SUBAGENT_INPUT_FIELDS: readonly string[] = [
  'file_path',
  'notebook_path',
  'path',
  'pattern',
  'query',
  'url',
  'command',
  'description',
  'offset',
  'limit',
  'subagent_type',
];

/** Per-field clamp for projected string inputs (a path/command/description). */
export const SUBAGENT_INPUT_FIELD_MAX_CHARS = 300;

/**
 * Clamp for a forwarded subagent assistant text/thinking body. Whole-message
 * granularity means one of these can be a full report; the panel row shows its
 * first line and an expandable body, neither of which needs more than this.
 */
export const SUBAGENT_TEXT_MAX_CHARS = 4000;

/**
 * Clamp for the ONLY tool output that is forwarded at all — a failure's text.
 * Successful subagent tool results carry no body across IPC (T-34 L2): the
 * live panel answers "what is it doing", and the delegation's actual answer
 * arrives on the main Agent row's own tool_result.
 */
export const SUBAGENT_ERROR_TEXT_MAX_CHARS = 400;

/**
 * Hard ceiling on `subagent.activity` events forwarded for ONE delegation.
 * Mirrors `STDERR_FORWARD_MAX_LINES_PER_TURN`: past this the carrier emits a
 * single `kind:'capped'` and goes silent, so a runaway subagent cannot flood
 * IPC no matter how long it loops.
 */
export const SUBAGENT_EVENTS_MAX_PER_DELEGATION = 200;

/** Appended to any body this module shortened, so truncation is never silent. */
export const SUBAGENT_TRUNCATION_MARKER = '…';

/**
 * Clamp `text` to `maxChars`, appending the marker when anything was dropped.
 * The marker replaces the last character rather than extending past the limit,
 * so the return value is never longer than `maxChars`.
 */
export function clampSubagentText(text: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - SUBAGENT_TRUNCATION_MARKER.length) + SUBAGENT_TRUNCATION_MARKER;
}

/**
 * Project a subagent tool_use `input` down to the whitelist above.
 *
 * Returns `undefined` — not an empty object — when there is nothing to say:
 * a non-object input, an array (tool inputs are always objects; an array is a
 * shape we do not understand and must not guess at), or an object whose every
 * field was dropped. The protocol field is optional precisely so "nothing
 * survived" can be expressed by absence instead of an empty husk.
 *
 * Only strings and finite numbers are kept, matching the payload type
 * (`Record<string, string | number>`): a boolean like `run_in_background` has
 * no row rendering, and an object/array value is exactly the shape that could
 * smuggle a file body back in.
 */
export function projectSubagentToolInput(
  input: unknown
): Record<string, string | number> | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const source = input as Record<string, unknown>;
  const projected: Record<string, string | number> = {};
  let kept = 0;
  for (const field of SUBAGENT_INPUT_FIELDS) {
    const value = source[field];
    if (typeof value === 'string') {
      if (value.length === 0) continue;
      projected[field] = clampSubagentText(value, SUBAGENT_INPUT_FIELD_MAX_CHARS);
      kept += 1;
      continue;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      projected[field] = value;
      kept += 1;
    }
  }
  return kept > 0 ? projected : undefined;
}

/**
 * Flatten an SDK `tool_result.content` (string, or `[{type:'text',text}]`) to
 * the clamped failure text a failed subagent row renders. Returns `undefined`
 * when there is no text to show — a blank row would be noise pretending to be
 * a fact (`foldStderrLine`'s own rule).
 *
 * Non-text content parts (images, nested structures) contribute nothing: this
 * is an error label, not a transcript.
 */
export function subagentErrorText(content: unknown): string | undefined {
  const flat = flattenTextContent(content).trim();
  if (flat.length === 0) return undefined;
  return clampSubagentText(flat, SUBAGENT_ERROR_TEXT_MAX_CHARS);
}

function flattenTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const chunks: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      chunks.push(part);
      continue;
    }
    if (!part || typeof part !== 'object') continue;
    const p = part as { type?: unknown; text?: unknown };
    if ((p.type === 'text' || p.type === undefined) && typeof p.text === 'string') {
      chunks.push(p.text);
    }
  }
  return chunks.join('\n');
}
