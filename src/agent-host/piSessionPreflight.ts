/**
 * Comparing two pi session file paths.
 *
 * ## What used to be here, and why it went (audit cutover-12, T028)
 *
 * This file was the exact-file preflight the legacy worker ran before letting
 * the pi SDK open a session JSONL: 106 lines that scanned up to 64 KiB for a
 * complete first record, validated the header's `type` / `id` / `cwd`, and then
 * re-`stat`ed the path so a file swapped between the check and the open was
 * caught (`preflightPiSessionFile`, `assertPiSessionFileIdentity`). It existed
 * because `SessionManager.open()` would CREATE a session for a missing or
 * foreign path, turning a mistake into a new empty conversation.
 *
 * P6-5 retired that engine. The self-owned runtime reads and writes session
 * files itself (`src/runtime/plugins/session/`), never hands a path to the pi
 * SDK, and so never needed the guard; both functions had no caller left in the
 * app — only their own tests. The plan documents said the decision to delete
 * them was still open, which is why the file is named for a preflight it no
 * longer performs.
 *
 * What survived is the three lines the runtime does use: the path comparison in
 * `NativeWorkerRuntime.resume()`, which decides whether an incoming request
 * names the session this worker already has open. The file name is kept so that
 * import does not have to change while another agent is editing that file.
 */

import path from 'node:path';

/**
 * Windows compares paths case-insensitively; POSIX does not.
 *
 * Normalising first collapses `..` and separator noise, so two spellings of one
 * path compare equal without touching the filesystem — the comparison has to
 * work for a file that does not exist yet, which is the normal case: pi writes
 * a session file lazily, on its first assistant message.
 */
function comparablePath(value: string): string {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function samePiSessionPath(left: string, right: string): boolean {
  return comparablePath(left) === comparablePath(right);
}
