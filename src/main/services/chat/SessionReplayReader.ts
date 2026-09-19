/**
 * T102 (decision 030) — read one page of a session's transcript WITHOUT a worker.
 *
 * Opening a conversation used to mean resuming it: `chat:resumeSession` spawns
 * (or reuses) a Pi worker, and `chat:loadHistoryPage` refuses outright unless
 * one is ready. So merely LOOKING at yesterday's chat cost a worker slot, and
 * with the pool full (3 / 6 / 10 by memory) it could be refused with
 * `worker_capacity_reached` — the user's report was "after I end a chat I cannot
 * even see its history any more".
 *
 * This module is the other half of that decision: the same projection the worker
 * produces, built in Main from the file alone.
 *
 * ## The rules that make it safe to read a session file from here
 *
 * 1. **Never `JsonlSessionStore.open`.** That entry point takes the advisory
 *    writer lock unconditionally (`writerLock.ts`) and writes back repairs — a
 *    reader that does either is a second writer. Same for pi's own
 *    `SessionManager.open()`, which appends a missing newline, rewrites an old
 *    version and writes a header into an empty file. Nothing here opens the
 *    file for writing, creates a lock, or touches its mtime.
 * 2. **Only for a session with no live worker.** A worker's in-memory branch is
 *    the authority while it exists, and the file can legitimately lag it. The
 *    caller (`chat:readSessionPage`) enforces that; this module states the
 *    dependency but cannot check it. It also happens to be what makes rule 3
 *    workable: `decodeSession` refuses a file with an unfinished SDK operation,
 *    which is exactly the shape a RUNNING session's file has mid-turn.
 * 3. **Every decode failure is one code.** A caller's only recovery is to fall
 *    back to the resume path, so the many ways a file can refuse to decode are
 *    reported as a single {@link SESSION_REPLAY_UNAVAILABLE}, with the original
 *    code kept in the message for the log.
 *
 * The chain itself is the repo's existing pure functions, in the order the
 * store uses them, so the two paths cannot drift:
 * `decodeSession` → `branchEntries` → ISO timestamps → `projectPiSessionHistory`
 * → `paginatePiSessionHistory`. `sessionReplayReader.test.ts` pins that equality
 * against `JsonlSessionStore.history()` on the same file.
 *
 * No subagent summaries: the resume path rides them on its history read, but
 * `subagentHistorySummaries` sits behind `plugins/subagent/run.ts`, which pulls
 * the provider-retry and stream-recovery stack — and with it `@earendil-works/pi-ai`
 * — into the Main bundle. A read-only preview would gain restored delegation
 * panels; the first send resumes and publishes them anyway. Revisit if a
 * standalone summary reader lands.
 */

import { readFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  paginatePiSessionHistory,
  projectPiSessionHistory,
} from '../../../agent-host/piSessionTimeline';
import {
  branchEntries,
  decodeSession,
  SESSION_MAX_BYTES,
} from '../../../runtime/plugins/session/codec';
import { convertLegacySession } from '../../../runtime/plugins/session/legacy';
import type { SessionHistoryPage } from '../../../shared/types/sessionHistory';

/** The one code a caller branches on: fall back to the resume path. */
export const SESSION_REPLAY_UNAVAILABLE = 'session_replay_unavailable';

/**
 * A session this reader declined to replay.
 *
 * `cause` keeps the underlying vocabulary (`session_operation_unfinished`,
 * `session_format_unsupported`, `ENOENT`, …) for the log; callers branch on
 * `code`, which is always {@link SESSION_REPLAY_UNAVAILABLE}.
 */
export class SessionReplayError extends Error {
  readonly code = SESSION_REPLAY_UNAVAILABLE;
  readonly cause?: string;
  constructor(message: string, cause?: string) {
    super(`${SESSION_REPLAY_UNAVAILABLE}: ${message}`);
    this.name = 'SessionReplayError';
    if (cause !== undefined) this.cause = cause;
  }
}

function codeOf(error: unknown): string | undefined {
  const value = (error as { code?: unknown } | null)?.code;
  return typeof value === 'string' ? value : undefined;
}

function unavailable(error: unknown, what: string): never {
  const cause = codeOf(error);
  const detail = error instanceof Error ? error.message : String(error);
  throw new SessionReplayError(`${what}: ${detail}`, cause);
}

/** The first non-blank row, which is where every session format declares itself. */
function headerRow(content: string): Record<string, unknown> {
  const line = content.split('\n').find((entry) => entry.trim());
  if (line === undefined) throw new SessionReplayError('session file is empty');
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    unavailable(error, 'session file does not begin with a JSON record');
  }
  if (typeof parsed !== 'object' || parsed === null)
    throw new SessionReplayError('session header is not an object');
  return parsed as Record<string, unknown>;
}

async function readSessionText(file: string): Promise<string> {
  let size: number;
  try {
    size = (await stat(file)).size;
  } catch (error) {
    unavailable(error, `cannot stat ${file}`);
  }
  // The store's budget, checked before the read rather than after it: this runs
  // on the main thread, and a file past the budget could not be opened by the
  // worker either.
  if (size > SESSION_MAX_BYTES)
    throw new SessionReplayError(`session exceeds the ${SESSION_MAX_BYTES} byte budget`);
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch (error) {
    unavailable(error, `cannot read ${file}`);
  }
  try {
    // `stream: true` on a tail that is not a newline, exactly as the store
    // decodes: an append cut mid-character must read as a torn tail (which the
    // codec tolerates), not as invalid UTF-8.
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes, {
      stream: bytes.at(-1) !== 10,
    });
  } catch (error) {
    unavailable(error, `session file is not valid UTF-8: ${file}`);
  }
}

export interface SessionReplayRequest {
  /** Absolute path of the session JSONL, as the index recorded it. */
  sessionFile: string;
  /** Newer projected messages to skip from the branch leaf. Defaults to 0. */
  offset?: number;
  /** Page size; `paginatePiSessionHistory` clamps it to 1..500. Defaults to 80. */
  limit?: number;
  /**
   * The indexed workspace, used ONLY as the conversion cwd for a legacy file
   * whose own header names none. A v4 file ignores it — the projection reads
   * entries, never the header's cwd.
   */
  workspacePath?: string;
}

/**
 * One page of `sessionFile`, projected exactly as a worker would project it.
 *
 * @throws {SessionReplayError} for every reason this file cannot be replayed.
 */
export async function readSessionReplayPage(
  request: SessionReplayRequest
): Promise<SessionHistoryPage> {
  const content = await readSessionText(request.sessionFile);
  const first = headerRow(content);
  let native = content;
  if (first.kind !== 'header' || first.version !== 4) {
    if (first.type !== 'session')
      throw new SessionReplayError(
        `unrecognised session format in ${request.sessionFile}`,
        'session_format_unsupported'
      );
    // A legacy (v1–v3 / pi-desktop) file, converted IN MEMORY. The on-disk
    // conversion `prepareSessionConfig` performs — a `.native-v4.jsonl` sibling
    // plus its own writer lock — is a write, and this path does not write.
    //
    // The cwd is the file's own, so the relocation guard inside
    // `convertLegacySession` compares a value with itself and passes: a reader
    // has no business deciding a session moved.
    const cwd =
      typeof first.cwd === 'string' && first.cwd
        ? first.cwd
        : (request.workspacePath ?? dirname(request.sessionFile));
    try {
      native = convertLegacySession(content, cwd, request.sessionFile);
    } catch (error) {
      unavailable(error, `cannot convert the legacy session ${request.sessionFile}`);
    }
  }
  let document: ReturnType<typeof decodeSession>;
  try {
    document = decodeSession(native);
  } catch (error) {
    // `session_operation_unfinished` lands here: a session whose last SDK
    // operation never closed needs explicit recovery, which only the resume
    // path can perform.
    unavailable(error, `cannot decode ${request.sessionFile}`);
  }
  // `store.ts`'s projection adapter, verbatim: the branch entries with their
  // epoch timestamps rendered as ISO strings, which is the shape
  // `projectPiSessionHistory` reads.
  const branch = branchEntries(document).map((entry) => ({
    ...entry,
    timestamp: new Date(entry.timestamp).toISOString(),
  }));
  return paginatePiSessionHistory(
    projectPiSessionHistory({ getBranch: () => branch }),
    request.offset,
    request.limit
  );
}
