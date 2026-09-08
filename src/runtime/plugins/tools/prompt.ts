import type { PromptSegment } from '../prompt/segments.ts';

export function toolSegments(): readonly PromptSegment[] {
  return [
    {
      slot: 'tool-protocol',
      text: 'Call tools through the native tool-call interface. Treat tool errors and denials as results to handle; do not claim an operation succeeded before its tool result confirms it.',
    },
    {
      slot: 'tool-guidance',
      text: 'Use glob to discover files and grep for literal text search; narrow path and include to keep results bounded. Read uses a one-based line offset and a line limit; follow the reported next line after truncation. When Edit is available, it takes an edits array of exact, unique oldText/newText replacements. Prefer the available read/write/edit tools over shell file operations. Bash requires the configured shell and has a time limit; never retry a failed command automatically when it may already have changed files.',
    },
  ];
}
