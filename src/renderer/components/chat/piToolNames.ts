/**
 * T12-b: pi's built-in tools, taken from the SDK itself
 * (`dist/core/tools/*.js`, each file's `name:` literal) rather than guessed.
 *
 * They are LOWERCASE, and none of them collide with the capitalised Claude
 * names — which is exactly how this went unnoticed for a whole backend swap:
 * every lookup in `toolCard.ts` missed, silently and without a type error, so
 * on the pi backend every tool row read `Ran`, nothing was ever classified
 * read/search (so tool aggregation never fired at all), and paths rendered
 * proportional instead of mono.
 *
 * `powershell` is pi's Windows sibling of `bash` (same file layout, same
 * `command` argument), so it shares bash's row treatment.
 *
 * Their argument names come from the same source (the `Type.TObject` schema in
 * each tool's `.d.ts`) and differ from Claude's: pi says `path`, Claude says
 * `file_path`. Anything keyed on a field name has to read both.
 *
 * Lives in its own module so `toolCard.ts` and `toolDiff.ts` can both use it
 * without importing each other — a cycle between two chat modules is not
 * hypothetical here, it is a shape this repo has already been bitten by at
 * bundle level.
 */
export const PI_TOOL_NAMES = {
  read: 'read',
  edit: 'edit',
  write: 'write',
  bash: 'bash',
  powershell: 'powershell',
  grep: 'grep',
  find: 'find',
  ls: 'ls',
} as const;
