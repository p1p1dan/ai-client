/**
 * Chats pi started inside the terminal, which the sidebar cannot show.
 *
 * ## What actually happens
 *
 * `/new` in the Pi TUI is a literal string match in the CLI's input handler
 * (`dist/modes/interactive/interactive-mode.js`) with nothing behind it: no
 * flag, env var or setting disables it, and in TUI mode pi reports the new
 * session's path nowhere — only `--mode rpc` returns a `sessionFile`. What the
 * command does is build a fresh `SessionManager` in the SAME directory the
 * current session came from: the app spawns `pi --session <file>` without
 * `--session-dir`, and `SessionManager.open` then derives that directory from
 * the file's own parent. So a new `<iso-timestamp>_<id>.jsonl` simply appears
 * next to the file the app handed over, and the terminal starts writing there.
 *
 * `session-index.json` is written only by explicit registration — it has no
 * directory scan and no watcher (`services/chat/SessionIndexService.ts`) — so
 * that file is invisible in the sidebar, and the user reads it as "my chat is
 * gone".
 *
 * ## Why this only reports, and does not index the file
 *
 * The pi CLI writes its own session format, which the app's runtime refuses to
 * open without the legacy-import conversion (see `inspectPiTuiSessionSupport`
 * for the same boundary in the other direction). An index row pointing straight
 * at it would put a chat in the sidebar that fails the moment it is clicked.
 * Naming the file, and saying plainly that it is not in the list, is the part
 * that is true.
 *
 * Pure fs + path: no Electron, no PTY, so the diff below is unit-testable
 * against a temp directory.
 */

import { readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const SESSION_FILE_SUFFIX = '.jsonl';

export type ReadSessionDirectory = (directory: string) => Promise<string[]>;

const defaultRead: ReadSessionDirectory = (directory) => readdir(directory);

/**
 * Session file NAMES in a directory, or none.
 *
 * A failed read is not an error here: the directory may not exist yet (pi
 * creates it lazily), and a terminal must never fail to open because this
 * bookkeeping could not list a folder.
 */
async function listSessionFiles(directory: string, read: ReadSessionDirectory): Promise<string[]> {
  try {
    const names = await read(directory);
    return names.filter((name) => name.endsWith(SESSION_FILE_SUFFIX));
  } catch {
    return [];
  }
}

/** What the session directory held before a terminal started writing to it. */
export interface StrandedSessionSnapshot {
  /** Directory pi will create a `/new` session in: the parent of its session file. */
  directory: string;
  /** The file the terminal was opened on; never reported as stranded. */
  sessionFile: string;
  /** File names already present, so only later arrivals are reported. */
  before: readonly string[];
}

export async function snapshotSessionDirectory(
  sessionFile: string,
  read: ReadSessionDirectory = defaultRead
): Promise<StrandedSessionSnapshot> {
  const directory = dirname(sessionFile);
  return { directory, sessionFile, before: await listSessionFiles(directory, read) };
}

export interface StrandedSessionSweepOptions {
  read?: ReadSessionDirectory;
  /**
   * Does `session-index.json` already know this file?
   *
   * The GUI writes its own sessions into the same directory, so a chat created
   * in another window while the terminal was open would otherwise be reported
   * as stranded — a warning about a chat that is sitting in the sidebar.
   */
  isIndexed?: (sessionFile: string) => Promise<boolean>;
}

/**
 * Session files that appeared while the terminal ran and that the app does not
 * know about, as absolute paths.
 */
export async function sweepStrandedSessions(
  snapshot: StrandedSessionSnapshot,
  options: StrandedSessionSweepOptions = {}
): Promise<string[]> {
  const read = options.read ?? defaultRead;
  const own = basename(snapshot.sessionFile);
  const before = new Set(snapshot.before);
  const after = await listSessionFiles(snapshot.directory, read);
  const stranded: string[] = [];
  for (const name of after) {
    if (name === own || before.has(name)) continue;
    const file = join(snapshot.directory, name);
    if (options.isIndexed && (await options.isIndexed(file))) continue;
    stranded.push(file);
  }
  return stranded;
}

/**
 * The sentences the user sees, as `@shared/i18n` keys.
 *
 * Main has no `useI18n`, so it translates them itself through
 * `translate(getCurrentLocale(), …)` — the same route `MenuBuilder` and the
 * dialogs take.
 */
export const STRANDED_SESSION_TITLE = 'A new chat was created in the terminal';
export const STRANDED_SESSION_BODY =
  'Chats started with /new in the Pi terminal are not listed in the sidebar. This one was saved to {{path}}';
