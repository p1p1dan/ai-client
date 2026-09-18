/**
 * Chats pi started inside the terminal, which the sidebar cannot show.
 *
 * ## What actually happens
 *
 * `/new` in the Pi TUI is a literal string match in the CLI's input handler
 * (`dist/modes/interactive/interactive-mode.js`) with nothing behind it: no
 * flag, env var or setting disables it, and in TUI mode pi reports the new
 * session's path nowhere — only `--mode rpc` returns a `sessionFile`. What the
 * command does is build a fresh `SessionManager` in the session directory the
 * CLI was started with, which `buildPiTuiArgs` pins to the chat's own folder
 * (`--session-dir`). So a new `<iso-timestamp>_<id>.jsonl` simply appears next
 * to the file the app handed over, and the terminal starts writing there.
 *
 * `session-index.json` is written only by explicit registration — it has no
 * directory scan and no watcher (`services/chat/SessionIndexService.ts`) — so
 * that file is invisible in the sidebar, and the user reads it as "my chat is
 * gone".
 *
 * ## Why the file can simply be indexed
 *
 * pi's JSONL differs from this app's in the FIRST LINE and nothing else: pi
 * writes `{"type":"session","version":3,…}` where the native runtime wants
 * `{"kind":"header","version":4,…}`. Every open goes through
 * `prepareSessionConfig` (`runtime/plugins/session/legacy.ts`), which converts a
 * v3 file into a sibling `<file>.native-v4.jsonl`, resumes from THAT, and
 * reports the original as `metadata.sourceFile`; the conversion is idempotent,
 * and Main already re-binds an index row to the copy when it sees that
 * (`chat/NativeSessionIndexAdapter.ts`, `agent-host/WorkerManager.ts`). A row
 * pointing straight at pi's file therefore opens when it is clicked, and nothing
 * here has to convert anything.
 *
 * The one hard requirement is the workspace: the conversion refuses with
 * `session_cwd_mismatch` unless the resume cwd equals the `cwd` written in pi's
 * own header. That is why `readStrandedSessionIdentity` reads the cwd out of the
 * FILE instead of reusing the cwd the terminal was opened with — pi asks the
 * user to pick another directory when a session's cwd is gone, so the two can
 * legitimately disagree, and only the file knows where the chat actually ran.
 * When they turn out to be the SAME directory under two names, the terminal's
 * spelling is recorded instead; `StrandedSession.workspacePath` says why.
 *
 * Identification happens once the terminal is DEAD, never from a watcher. While
 * pi is still writing, opening the chat in the app would produce the v4 copy and
 * re-bind the row to it, and the TUI would go on appending to the original — one
 * conversation forked into two files.
 *
 * Pure fs + path: no Electron, no PTY, so the diff below is unit-testable
 * against a temp directory.
 */

import { open, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const SESSION_FILE_SUFFIX = '.jsonl';

/**
 * How much of a session file is read to identify it.
 *
 * The header is the first line, but the chat's NAME is a `session_info` row that
 * can sit anywhere after it, so this reads a prefix rather than one line. Capped
 * because a long conversation is an unbounded file and this runs on the main
 * thread while a terminal is being torn down; a name set past the cap is simply
 * not found, which costs a fallback title and nothing else.
 */
const SESSION_HEAD_BYTES = 1024 * 1024;

export type ReadSessionDirectory = (directory: string) => Promise<string[]>;
export type ReadSessionHead = (file: string) => Promise<string>;
export type ResolveRealPath = (path: string) => Promise<string>;

const defaultRead: ReadSessionDirectory = (directory) => readdir(directory);

const defaultReadHead: ReadSessionHead = async (file) => {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(SESSION_HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
};

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
  /**
   * The cwd the terminal was opened with — this app's own spelling of the
   * workspace, and the one its registered folders are keyed by.
   *
   * Kept only to answer "is pi's cwd the same directory under another name";
   * see `StrandedSession.workspacePath`.
   */
  cwd: string;
  /** File names already present, so only later arrivals are reported. */
  before: readonly string[];
}

export async function snapshotSessionDirectory(
  sessionFile: string,
  cwd: string,
  read: ReadSessionDirectory = defaultRead
): Promise<StrandedSessionSnapshot> {
  const directory = dirname(sessionFile);
  return { directory, sessionFile, cwd, before: await listSessionFiles(directory, read) };
}

/** What a session file says about itself, as far as indexing it needs. */
export interface StrandedSessionIdentity {
  /** pi's own session id from the header row; `''` when it carries none. */
  piSessionId: string;
  /**
   * The directory pi ran this chat in, straight from the header.
   *
   * Load-bearing, not decoration: resuming the chat fails with
   * `session_cwd_mismatch` unless the cwd it is given is this directory (see
   * this file's header comment). What gets RECORDED is `workspacePath` below,
   * which may spell the same directory differently.
   */
  cwd: string;
  /** The name the chat was given in pi, or `''` when it was never named. */
  title: string;
  /** Epoch ms from the header, or `0` when it carries no usable timestamp. */
  createdAt: number;
}

/** A session file that appeared while the terminal ran. */
export interface StrandedSession {
  /** Absolute path of the file pi wrote. */
  file: string;
  /**
   * `null` when the file has no readable pi header — an empty or truncated
   * file, or something that is not a session at all. Nothing can be indexed
   * from it (there is no cwd to resume in), so the caller falls back to naming
   * the file for the user.
   */
  identity: StrandedSessionIdentity | null;
  /**
   * The directory to record on the index row; `''` when the file could not be
   * identified.
   *
   * `identity.cwd` almost always — and the TERMINAL's spelling of it when the
   * two name one directory by different paths. pi writes the path its process
   * resolved to, so a workspace reached through a symlink (or the macOS
   * `/var` → `/private/var` firmlink) comes back spelled differently than the
   * folder this app registered; the sidebar matches a row to a workspace by
   * comparing those strings, so pi's spelling would leave the chat indexed and
   * invisible — a worse failure than the notice it replaces, because nothing
   * says anything at all.
   *
   * Safe for opening the chat either way: the runtime realpaths the resume cwd
   * before comparing it with the header (`prepareSessionConfig`), so both
   * spellings pass the same gate. Only a PROVEN match is substituted — when
   * either path cannot be resolved, pi's own answer stands.
   */
  workspacePath: string;
}

function parseRow(line: string): Record<string, unknown> | null {
  const text = line.trim();
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    // A half-written line (pi is appending as this runs, and the read is
    // capped) is skipped, never fatal.
    return null;
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Epoch ms from pi's header, which dates it as an ISO string. */
function headerTimestamp(header: Record<string, unknown>): number {
  const raw = header.timestamp ?? header.createdAt;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

/**
 * Read enough of a session file to put it in the chat list, or `null`.
 *
 * `null` is a statement about THIS file only — an unreadable or headerless file
 * is reported to the user by path instead of being indexed — and never an error:
 * a terminal must not fail to tear down because one file could not be parsed.
 */
export async function readStrandedSessionIdentity(
  file: string,
  readHead: ReadSessionHead = defaultReadHead
): Promise<StrandedSessionIdentity | null> {
  let head: string;
  try {
    head = await readHead(file);
  } catch {
    return null;
  }
  const rows = head.split('\n');
  const header = parseRow(rows[0] ?? '');
  // pi's own marker. A native v4 header carries it too (H/20 interop), which is
  // correct here: such a file is opened directly, with no conversion at all.
  if (!header || header.type !== 'session') return null;
  const cwd = text(header.cwd);
  // Without a workspace there is nothing to resume the chat in, and a row with
  // the wrong one is a chat that fails when it is clicked.
  if (!cwd) return null;
  let title = text(header.name);
  for (const line of rows.slice(1)) {
    const row = parseRow(line);
    if (!row) continue;
    // Last one wins: naming a chat again appends another row rather than
    // rewriting the first. `session_info` is pi's spelling, `fact: 'name'` the
    // native runtime's.
    if (row.type === 'session_info' && text(row.name)) title = text(row.name);
    else if (row.kind === 'fact' && row.fact === 'name' && text(row.name)) title = text(row.name);
  }
  return {
    piSessionId: text(header.id) || text(header.sessionId),
    cwd,
    title,
    createdAt: headerTimestamp(header),
  };
}

/**
 * Which spelling of pi's workspace goes on the index row.
 *
 * The terminal's own, but only once the two paths are PROVEN to be one
 * directory: a guess here would record a workspace the chat cannot be resumed
 * in. Anything unresolvable (a folder deleted since, a permission error, a cwd
 * from another machine) keeps pi's answer, which is the one the runtime checks
 * against.
 */
async function workspaceSpelling(
  headerCwd: string,
  terminalCwd: string,
  resolveRealPath: ResolveRealPath
): Promise<string> {
  const terminal = terminalCwd.trim();
  if (!terminal || terminal === headerCwd) return headerCwd;
  try {
    const [resolvedHeader, resolvedTerminal] = await Promise.all([
      resolveRealPath(headerCwd),
      resolveRealPath(terminal),
    ]);
    return resolvedHeader === resolvedTerminal ? terminal : headerCwd;
  } catch {
    return headerCwd;
  }
}

export interface StrandedSessionSweepOptions {
  read?: ReadSessionDirectory;
  readHead?: ReadSessionHead;
  resolveRealPath?: ResolveRealPath;
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
 * know about, each with whatever the file says about itself.
 */
export async function sweepStrandedSessions(
  snapshot: StrandedSessionSnapshot,
  options: StrandedSessionSweepOptions = {}
): Promise<StrandedSession[]> {
  const read = options.read ?? defaultRead;
  const resolveRealPath = options.resolveRealPath ?? realpath;
  const own = basename(snapshot.sessionFile);
  const before = new Set(snapshot.before);
  const after = await listSessionFiles(snapshot.directory, read);
  const stranded: StrandedSession[] = [];
  for (const name of after) {
    if (name === own || before.has(name)) continue;
    const file = join(snapshot.directory, name);
    if (options.isIndexed && (await options.isIndexed(file))) continue;
    const identity = await readStrandedSessionIdentity(file, options.readHead);
    stranded.push({
      file,
      identity,
      workspacePath: identity
        ? await workspaceSpelling(identity.cwd, snapshot.cwd, resolveRealPath)
        : '',
    });
  }
  return stranded;
}

/**
 * The sentences the user sees, as `@shared/i18n` keys.
 *
 * Main has no `useI18n`, so it translates them itself through
 * `translate(getCurrentLocale(), …)` — the same route `MenuBuilder` and the
 * dialogs take.
 *
 * Shown only for a file that could NOT be added to the chat list: one that is
 * indexed is in the sidebar, which is the answer the user wanted, and a
 * notification about it would be noise.
 */
export const STRANDED_SESSION_TITLE = 'A new chat was created in the terminal';
export const STRANDED_SESSION_BODY =
  'This chat could not be added to the chat list. Its file is at {{path}}';
