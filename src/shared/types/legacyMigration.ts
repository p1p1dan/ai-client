/**
 * dsh-rebase P1-9d (decisions 050, 051, 054, 121, 122): the migration of a
 * 1.0.x pi chat to a DSH session, as Main reports it.
 *
 * A legacy `pi` row that names a real transcript is migrated on its first
 * continue (`chat:resumeSession`, decision 050): the shared host converts the
 * file (`seedSession`, decision 054), Main commits the index (decision 051)
 * and the resume goes on as any DSH resume. The resume either resolves with a
 * `LegacyMigrationSummary`, or rejects with
 *
 *   legacy_migration_failed:<stage>/<code>: <sentence>[ (retryable)]
 *
 * where `<stage>` is one of the host's (`DshSeedStage`) or Main's own (`host`:
 * the engine could not be reached, died or did not answer in time; `index`:
 * the index transaction). Only the stage and the code identify the failure:
 * the host's own message can name a path (decision 121 rule 17), so it never
 * reaches the renderer. `(retryable)` marks a failure the same continue may
 * get past later unchanged.
 *
 * No value imports: shared by Main and the renderer.
 */

import type { DshSeedStage } from './dshHostProtocol';
import type { RuntimePermissionSettings } from './runtimePermission';

/** The resume of a legacy chat failed while migrating it. */
export const LEGACY_MIGRATION_FAILED = 'legacy_migration_failed';

/**
 * An engine operation other than a resume (fork, rewind, compact, the tree, a
 * job or subagent control) asked for a chat that is still a legacy pi row: the
 * renderer resumes it first, which migrates it, then asks again.
 */
export const LEGACY_MIGRATION_REQUIRED = 'legacy_migration_required';

/** Main's own stages, besides the host's: reaching the engine, and the index. */
export type LegacyMigrationMainStage = 'host' | 'index';

export type LegacyMigrationStage = DshSeedStage | LegacyMigrationMainStage;

const STAGES: readonly LegacyMigrationStage[] = [
  'request',
  'read',
  'decode',
  'build',
  'admit',
  'create',
  'verify',
  'sidecar',
  'stub',
  'host',
  'index',
];

/** Main's codes for its own two stages. */
export const LEGACY_MIGRATION_MAIN_CODES = {
  /** The shared host could not be started or reached. */
  hostUnavailable: 'host_unavailable',
  /** The host exited (crash, hang, restart) while the migration was in flight. */
  hostExited: 'host_exited',
  /** The host did not answer within the migration timeout. */
  seedTimeout: 'seed_timeout',
  /** The host answered with something that is not a `seeded` message. */
  seedAnswerInvalid: 'seed_answer_invalid',
  /** The row changed under the migration (another binding, another file, or gone). */
  indexRowChanged: 'index_row_changed',
  /** The key the legacy row moves to is already another row's. */
  legacyKeyTaken: 'legacy_key_taken',
  /** The index could not be written. */
  indexCommitFailed: 'index_commit_failed',
} as const;

export interface LegacyMigrationFailure {
  stage: LegacyMigrationStage;
  /** The host's code (`source_busy`, `seed_stub_conflict`, …) or Main's (above). */
  code: string;
  retryable: boolean;
}

const CODE_PATTERN = /^[A-Za-z0-9_]+$/;

/** The rejection message of a failed migration; never carries a path or any content. */
export function formatLegacyMigrationFailure(
  sessionId: string,
  failure: LegacyMigrationFailure
): string {
  const code = CODE_PATTERN.test(failure.code) ? failure.code : 'unknown';
  return (
    `${LEGACY_MIGRATION_FAILED}:${failure.stage}/${code}: Session ${sessionId} could not be ` +
    `moved to the current chat engine${failure.retryable ? ' (retryable)' : ''}`
  );
}

const FAILURE_PATTERN = new RegExp(
  `\\b${LEGACY_MIGRATION_FAILED}:([a-z]+)/([A-Za-z0-9_]+):[^\\n]*?( \\(retryable\\))?$`,
  'm'
);

/** The failure a rejection message carries, or null when it is not a migration failure. */
export function parseLegacyMigrationFailure(message: string): LegacyMigrationFailure | null {
  const match = FAILURE_PATTERN.exec(message);
  if (!match) return null;
  const stage = match[1] as LegacyMigrationStage;
  if (!STAGES.includes(stage)) return null;
  return { stage, code: match[2] as string, retryable: match[3] !== undefined };
}

/**
 * Decision 051: the key the legacy pi row is kept under once its logical id
 * belongs to the DSH session. Deterministic, so a transaction done again lands
 * on the same key, and made of `[A-Za-z0-9_-]` whenever the id is: a diverged
 * legacy row is later migrated under this very key, which then names a DSH
 * session (`aiclient-<key>`) and a scratch directory.
 */
export const LEGACY_ROW_KEY_SUFFIX = '_pi';

export function legacyRowKeyFor(sessionId: string): string {
  return `${sessionId}${LEGACY_ROW_KEY_SUFFIX}`;
}

/** Decision 051: the `migratedFrom.converter` stamp for a pi file converted by `converterVersion`. */
export function legacyConverterStamp(converterVersion: number): string {
  return `pi-dsh/${converterVersion}`;
}

/**
 * What `chat:resumeSession` adds to its answer when the resume migrated the
 * chat first. Counts and flags only.
 */
export interface LegacyMigrationSummary {
  /** Where the legacy pi row is now kept (decision 051); the renderer copies the chat's preferences there. */
  legacySessionId: string;
  /** An earlier conversion of these same bytes was found complete (decision 121 rule 12). */
  reused: boolean;
  /** The bytes converted: the file itself, or 1.0.x's `.native-v4.jsonl` copy of it. */
  converted: 'source' | 'native-v4-copy';
  images: { admitted: number; refused: number };
  /** Session grants carried into the sidecar (decision 043). */
  grants: number;
  /** The last mode / gear the file recorded (decision 121). */
  legacyPermissions: RuntimePermissionSettings | null;
  /**
   * The resume named no posture, so it came up on `legacyPermissions`, as
   * 1.0.x's `{...file, ...payload}` did. False when the renderer named one.
   */
  legacyPermissionsApplied: boolean;
  /**
   * Decision 131: the chat was a 1.0.x continuation of an already-migrated one
   * (the `1.0.x` mark) and is now a chat of its own. Its row carries `title`
   * (the original's, with the branch suffix) until the first message sent here
   * names it (`SessionIndexEntry.forkTitlePending`). Absent for every other
   * migration.
   */
  fork?: { title: string };
}

/**
 * Decision 131: what a forked chat is called until its first message here
 * names it — the original's title and this suffix. A dictionary key; Main
 * words it in the app's language when it commits the migration.
 */
export const LEGACY_FORK_TITLE_KEY = '{{title}} (1.0.x branch)';
