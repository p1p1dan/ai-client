/**
 * dsh-rebase decision 179: the instructions a person types after `/compact`
 * (`/compact keep the open tasks and what failed`), read the same way by the
 * composer (which refuses before anything is sent), the bridge (which refuses
 * what a caller other than the composer sends) and the history (the line a
 * summary row carries about them).
 *
 * Plain text: line endings become `\n`, control characters other than tab and
 * line feed are dropped, the ends are trimmed. Nothing is interpreted.
 */

/** The most one `/compact` takes, in characters (a CJK character counts one). */
export const COMPACT_INSTRUCTIONS_MAX_CHARS = 2000;

export type CompactInstructionsInput =
  /** Nothing, or nothing but white space: `/compact` alone. */
  | { kind: 'none' }
  | { kind: 'ok'; text: string }
  /** Refused whole; `length` in the same characters as the limit. */
  | { kind: 'too-long'; length: number; max: number };

function keptChar(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return code === 0x09 || code === 0x0a || (code >= 0x20 && code !== 0x7f);
}

export function readCompactInstructions(raw: unknown): CompactInstructionsInput {
  if (typeof raw !== 'string') return { kind: 'none' };
  const chars = [...raw.replace(/\r\n?/g, '\n')].filter(keptChar);
  const text = chars.join('').trim();
  if (!text) return { kind: 'none' };
  const length = [...text].length;
  return length > COMPACT_INSTRUCTIONS_MAX_CHARS
    ? { kind: 'too-long', length, max: COMPACT_INSTRUCTIONS_MAX_CHARS }
    : { kind: 'ok', text };
}

/**
 * The line under a summary that `/compact <instructions>` wrote: a dictionary
 * key in English, like every projected byte (`HistoryNotice`); the renderer
 * shows it in the UI language with the instructions as they were typed.
 */
export const COMPACT_INSTRUCTIONS_NOTE_KEY = 'Instructions for this summary: {{instructions}}';

/** The English rendering of {@link COMPACT_INSTRUCTIONS_NOTE_KEY}. */
export function compactInstructionsNoteText(instructions: string): string {
  // A function replacer: `$&` and friends in the instructions stay as typed.
  return COMPACT_INSTRUCTIONS_NOTE_KEY.replace('{{instructions}}', () => instructions);
}
