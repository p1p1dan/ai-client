/**
 * What an approval card shows for a call's arguments (PiLab R1, FR-05.5): the
 * parameters of the thing being approved, in full up to a size cap — not a
 * reduced summary that hides what an edit replaces or what a generic tool is
 * called with. Shared by the DSH host's request builder and the Claude SDK
 * host's `describeCall`, so the two engines' cards say the same thing.
 */

/** Cap on a preview body; the card scrolls, this keeps a huge payload off the IPC. */
export const APPROVAL_PREVIEW_MAX_CHARS = 4000;

/** Pretty-printed JSON of the arguments, capped. */
export function argumentsPreview(args: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(args, null, 2) ?? '';
  } catch {
    text = String(args);
  }
  return text.length > APPROVAL_PREVIEW_MAX_CHARS
    ? `${text.slice(0, APPROVAL_PREVIEW_MAX_CHARS)}…`
    : text;
}

/**
 * An edit's arguments without the path keys (the card already names the file
 * as a file row): `old_string`, `new_string`, `replace_all`, or a multi-edit's
 * `edits` — everything that decides what the edit does.
 */
export function editArgumentsPreview(args: Record<string, unknown>): string {
  const { file_path: _file, notebook_path: _notebook, path: _path, ...rest } = args;
  return argumentsPreview(rest);
}
