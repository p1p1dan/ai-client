/**
 * dsh-rebase P1-9d (decisions 050, 051, 054, 121, 122): a 1.0.x pi chat made a
 * DSH session on its first continue.
 *
 * One migration, for the resume that needs it (`prepareResume`):
 *
 *   1. stat    Main's own look at the pi file the row names: gone is
 *              `read/source_missing`; its size and mtime go to the host as
 *              `expect`, so a file written in between is `source_busy`.
 *   2. seed    the shared host converts and writes it (`seedSession`,
 *              `bridge/seedSession.ts`): the DSH log, the grant sidecar and,
 *              last, the identity stub. Nothing in the index changes yet.
 *   3. commit  one atomic index write (`commitMigrated`, decision 051): the
 *              pi row kept under `<id>_pi`, the chat's own row now `dsh`,
 *              naming the stub, with `migratedFrom` taken from the host's
 *              `result.source`. This is the migration's commit point: a
 *              failure before it leaves the row `pi` and a preview as it was.
 *
 * One migration per chat at a time: a second continue of the same chat while
 * one runs gets the same outcome. A failure the host marks `retryable` (the
 * file was being written, the sidecar or stub write failed) is tried again, up
 * to `retryDelaysMs.length` more times, each time with a fresh stat. Failures
 * of the host itself (it could not start, died, or did not answer in time) are
 * not retried here: a migration that brought the host down would take it down
 * again and spend the restart budget, and a late one is still running. They
 * are reported retryable, and the host's answer is idempotent, so the next
 * continue reuses whatever the late or interrupted one made.
 *
 * What leaves this module is the stage and the code
 * (`legacy_migration_failed:<stage>/<code>`, `@shared/types/legacyMigration`):
 * the host's message can name a path (decision 121 rule 17), so it goes to
 * Main's log only, redacted, and never into the error the renderer gets.
 */

import { stat } from 'node:fs/promises';
import { DSH_AGENT, PI_AGENT } from '@shared/types/agentWire';
import type { DshHostSeeded, DshSeedSessionResult } from '@shared/types/dshHostProtocol';
import {
  formatLegacyMigrationFailure,
  LEGACY_MIGRATION_FAILED,
  LEGACY_MIGRATION_MAIN_CODES,
  type LegacyMigrationFailure,
  type LegacyMigrationSummary,
} from '@shared/types/legacyMigration';
import type { SessionIndexEntry } from '@shared/types/sessionIndex';
import { sanitizeStderrLine } from '../../../agent-host/stderrRedaction';
import { type DshHostSeedInput, dshHostSupervisor } from '../agent-host/DshHostSupervisor';
import { type SessionMigrationCommit, sessionIndexService } from './SessionIndexService';

/** The host's `read` stage codes Main also answers from its own stat. */
const SOURCE_MISSING = 'source_missing';
const SOURCE_BUSY = 'source_busy';
const SOURCE_UNREADABLE = 'source_unreadable';

/**
 * Decision 122: two more attempts for a failure the host marks retryable,
 * after 1 s and 3 s. `source_busy` means something was writing the file
 * (a 1.0.x process still running on it); a few seconds is what such a write
 * takes, and the user is waiting on the continue meanwhile.
 */
export const LEGACY_MIGRATION_RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000];

export interface LegacyMigrationHost {
  seedSession(
    input: DshHostSeedInput,
    options?: { userInitiated?: boolean }
  ): Promise<DshHostSeeded>;
}

export interface LegacyMigrationIndex {
  commitMigrated(input: SessionMigrationCommit): Promise<SessionIndexEntry>;
}

export interface LegacyMigrationServiceOptions {
  host?: LegacyMigrationHost;
  index?: LegacyMigrationIndex;
  statFile?: (file: string) => Promise<{ size: number; mtimeMs: number; isFile(): boolean }>;
  sleep?: (ms: number) => Promise<void>;
  retryDelaysMs?: readonly number[];
  now?: () => number;
  log?: Pick<Console, 'info' | 'warn'>;
}

/** An indexed row with a durable identity, as the resume path holds it. */
export type IndexedSession = SessionIndexEntry & { runtimeIdentity: string };

/** What a migration gives the resume: the row it now opens, and what to tell the renderer. */
export interface LegacyMigrationOutcome {
  row: IndexedSession;
  summary: Omit<LegacyMigrationSummary, 'legacyPermissionsApplied'>;
}

/** The rejection of a failed migration; its message is what crosses the IPC boundary. */
export class LegacyMigrationError extends Error {
  readonly code = LEGACY_MIGRATION_FAILED;

  constructor(
    readonly sessionId: string,
    readonly failure: LegacyMigrationFailure
  ) {
    super(formatLegacyMigrationFailure(sessionId, failure));
    this.name = 'LegacyMigrationError';
  }
}

function errnoOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Main's own stat of the source, in the host's `read` vocabulary. */
function statFailure(error: unknown): LegacyMigrationFailure {
  const errno = errnoOf(error);
  if (errno === 'ENOENT' || errno === 'ENOTDIR') {
    return { stage: 'read', code: SOURCE_MISSING, retryable: false };
  }
  if (errno === 'EBUSY' || errno === 'EAGAIN') {
    return { stage: 'read', code: SOURCE_BUSY, retryable: true };
  }
  return { stage: 'read', code: SOURCE_UNREADABLE, retryable: false };
}

/** A supervisor rejection (`DshHostSupervisorError.code`) as Main's `host` stage. */
function hostFailure(error: unknown): LegacyMigrationFailure {
  switch (errnoOf(error)) {
    case 'DSH_HOST_SEED_TIMEOUT':
      return { stage: 'host', code: LEGACY_MIGRATION_MAIN_CODES.seedTimeout, retryable: true };
    case 'DSH_HOST_SEED_INTERRUPTED':
      return { stage: 'host', code: LEGACY_MIGRATION_MAIN_CODES.hostExited, retryable: true };
    case 'DSH_HOST_SEED_MALFORMED':
      return {
        stage: 'host',
        code: LEGACY_MIGRATION_MAIN_CODES.seedAnswerInvalid,
        retryable: false,
      };
    case 'DSH_HOST_DISPOSED':
      // The app is quitting: there is no later continue in this run.
      return { stage: 'host', code: LEGACY_MIGRATION_MAIN_CODES.hostUnavailable, retryable: false };
    default:
      return { stage: 'host', code: LEGACY_MIGRATION_MAIN_CODES.hostUnavailable, retryable: true };
  }
}

/** An index transaction failure as Main's `index` stage. */
function indexFailure(error: unknown): LegacyMigrationFailure {
  const code = errnoOf(error);
  if (code === LEGACY_MIGRATION_MAIN_CODES.indexRowChanged) {
    return { stage: 'index', code, retryable: true };
  }
  if (code === LEGACY_MIGRATION_MAIN_CODES.legacyKeyTaken) {
    return { stage: 'index', code, retryable: false };
  }
  // The stub is on disk and the host reuses it: the next continue only commits.
  return { stage: 'index', code: LEGACY_MIGRATION_MAIN_CODES.indexCommitFailed, retryable: true };
}

export class LegacyMigrationService {
  private readonly host: LegacyMigrationHost;
  private readonly index: LegacyMigrationIndex;
  private readonly statFile: NonNullable<LegacyMigrationServiceOptions['statFile']>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly retryDelaysMs: readonly number[];
  private readonly now: () => number;
  private readonly log: Pick<Console, 'info' | 'warn'>;
  private readonly flights = new Map<string, Promise<LegacyMigrationOutcome>>();

  constructor(options: LegacyMigrationServiceOptions = {}) {
    this.host = options.host ?? dshHostSupervisor;
    this.index = options.index ?? sessionIndexService;
    this.statFile = options.statFile ?? ((file) => stat(file));
    this.sleep =
      options.sleep ??
      ((ms) =>
        new Promise<void>((done) => {
          setTimeout(done, ms).unref?.();
        }));
    this.retryDelaysMs = options.retryDelaysMs ?? LEGACY_MIGRATION_RETRY_DELAYS_MS;
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? console;
  }

  /**
   * Decision 050: the row a resume opens. A legacy pi row that names a
   * transcript is migrated first, into `cwd` (the workspace the resume uses);
   * any other row is answered as it is. Rejects with `LegacyMigrationError`.
   */
  async prepareResume(
    row: IndexedSession,
    cwd: string
  ): Promise<{ row: IndexedSession; migration?: LegacyMigrationOutcome['summary'] }> {
    if (row.agent !== PI_AGENT) return { row };
    const outcome = await this.migrate(row, cwd);
    return { row: outcome.row, migration: outcome.summary };
  }

  /** One migration per chat at a time; a second call while one runs gets its outcome. */
  migrate(row: IndexedSession, cwd: string): Promise<LegacyMigrationOutcome> {
    const running = this.flights.get(row.sessionId);
    if (running) return running;
    const flight: Promise<LegacyMigrationOutcome> = this.run(row, cwd).finally(() => {
      if (this.flights.get(row.sessionId) === flight) this.flights.delete(row.sessionId);
    });
    this.flights.set(row.sessionId, flight);
    return flight;
  }

  /** Whether a migration of this chat is in flight. */
  isMigrating(sessionId: string): boolean {
    return this.flights.has(sessionId);
  }

  private async run(row: IndexedSession, cwd: string): Promise<LegacyMigrationOutcome> {
    const started = this.now();
    const sessionId = row.sessionId;
    let result: DshSeedSessionResult;
    for (let attempt = 0; ; attempt += 1) {
      const outcome = await this.attempt(row, cwd);
      if (outcome.ok) {
        result = outcome.result;
        break;
      }
      const { failure, detail } = outcome;
      const delay = this.retryDelaysMs[attempt];
      if (outcome.again && delay !== undefined) {
        this.log.warn(
          `[chat] Legacy session ${sessionId} migration attempt ${attempt + 1} failed ` +
            `(${failure.stage}/${failure.code}); trying again in ${delay} ms`
        );
        await this.sleep(delay);
        continue;
      }
      this.log.warn(
        `[chat] Legacy session ${sessionId} could not be migrated ` +
          `(${failure.stage}/${failure.code}${failure.retryable ? ', retryable' : ''})` +
          (detail ? `: ${sanitizeStderrLine(detail)}` : '')
      );
      throw new LegacyMigrationError(sessionId, failure);
    }

    let committed: SessionIndexEntry;
    try {
      committed = await this.index.commitMigrated({
        sessionId,
        legacyRuntimeIdentity: row.runtimeIdentity,
        stubFile: result.stubFile,
        workspacePath: cwd,
        source: {
          sha256: result.source.sha256,
          bytes: result.source.bytes,
          mtimeMs: result.source.mtimeMs,
        },
        converterVersion: result.report.converterVersion,
      });
    } catch (error) {
      const failure = indexFailure(error);
      this.log.warn(
        `[chat] Legacy session ${sessionId} was converted but its index row could not be ` +
          `committed (${failure.stage}/${failure.code}): ${sanitizeStderrLine(messageOf(error))}`
      );
      throw new LegacyMigrationError(sessionId, failure);
    }
    if (committed.agent !== DSH_AGENT || !committed.runtimeIdentity || !committed.migratedFrom) {
      throw new LegacyMigrationError(sessionId, {
        stage: 'index',
        code: LEGACY_MIGRATION_MAIN_CODES.indexRowChanged,
        retryable: true,
      });
    }
    this.log.info(
      `[chat] Migrated legacy session ${sessionId} to the current chat engine in ` +
        `${Math.round(this.now() - started)} ms (${result.reused ? 'reused an earlier conversion' : 'converted'}; ` +
        `images ${result.images.admitted} admitted, ${result.images.refused} refused; ` +
        `${result.grants} grant(s))`
    );
    return {
      row: committed as IndexedSession,
      summary: {
        legacySessionId: committed.migratedFrom.legacySessionId,
        reused: result.reused,
        converted: result.converted,
        images: { admitted: result.images.admitted, refused: result.images.refused },
        grants: result.grants,
        legacyPermissions: result.legacyPermissions,
      },
    };
  }

  /**
   * One stat and one host round trip. `again`: whether this failure is tried
   * again here — the retryable ones the file or the host's own writes caused,
   * never a failure of the host itself (see the module comment).
   */
  private async attempt(
    row: IndexedSession,
    cwd: string
  ): Promise<
    | { ok: true; result: DshSeedSessionResult }
    | { ok: false; failure: LegacyMigrationFailure; again: boolean; detail?: string }
  > {
    let expect: { bytes: number; mtimeMs: number };
    try {
      const source = await this.statFile(row.runtimeIdentity);
      if (!source.isFile()) {
        return {
          ok: false,
          failure: { stage: 'read', code: SOURCE_UNREADABLE, retryable: false },
          again: false,
          detail: 'the session file is not a regular file',
        };
      }
      expect = { bytes: source.size, mtimeMs: source.mtimeMs };
    } catch (error) {
      const failure = statFailure(error);
      return { ok: false, failure, again: failure.retryable, detail: messageOf(error) };
    }
    let answer: DshHostSeeded;
    try {
      answer = await this.host.seedSession(
        { sourceFile: row.runtimeIdentity, logicalSessionId: row.sessionId, cwd, expect },
        // A continue is the user's action: it may bring a failed host back.
        { userInitiated: true }
      );
    } catch (error) {
      return { ok: false, failure: hostFailure(error), again: false, detail: messageOf(error) };
    }
    if (answer.ok && answer.result) return { ok: true, result: answer.result };
    const error = answer.error;
    if (!error) {
      return {
        ok: false,
        failure: {
          stage: 'host',
          code: LEGACY_MIGRATION_MAIN_CODES.seedAnswerInvalid,
          retryable: false,
        },
        again: false,
      };
    }
    return {
      ok: false,
      failure: { stage: error.stage, code: error.code, retryable: error.retryable },
      again: error.retryable,
      detail: error.message,
    };
  }
}

/** Singleton used by the chat IPC handlers. */
export const legacyMigrationService = new LegacyMigrationService();
