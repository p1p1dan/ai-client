import type { PromptSegment } from '../prompt/segments.ts';

/**
 * Tool steering, in the `static` band of the slot table.
 *
 * Two rules this text has to keep (context-prompt-14):
 *
 * 1. **Tool names are spelled the way they are registered** — all lower case
 *    (`plugins/tools/index.ts`). This block used to write `Read`, `Edit` and
 *    `Bash` while writing `glob` and `grep` correctly in the same sentence,
 *    which invites the model to call a tool the registry does not have and
 *    lose a turn to it.
 * 2. **Nothing here asserts that a tool exists.** The set is not fixed: plan
 *    mode filters the write-capable tools out (ARD D14), and MCP and skills add
 *    to it. Every mention below is conditional for that reason, and the
 *    authoritative statement of what is unavailable stays in the `mode`
 *    segment, which is in the `turn` band where a mid-session switch belongs.
 *    Making this text itself depend on the mode would move a mode change into
 *    the cached prefix, which is the one thing the slot table exists to avoid.
 */
export function toolSegments(): readonly PromptSegment[] {
  return [
    {
      slot: 'tool-protocol',
      text: 'Call tools through the native tool-call interface. Treat tool errors and denials as results to handle; do not claim an operation succeeded before its tool result confirms it.',
    },
    {
      slot: 'tool-guidance',
      text: 'Use glob to discover files and grep for literal text search; narrow path and include to keep results bounded. read uses a one-based line offset and a line limit; follow the reported next line after truncation. When edit is available, it takes an edits array of exact, unique oldText/newText replacements. Prefer whichever of read, write and edit are available over shell file operations. bash requires the configured shell and has a time limit; never retry a failed command automatically when it may already have changed files.',
    },
  ];
}
