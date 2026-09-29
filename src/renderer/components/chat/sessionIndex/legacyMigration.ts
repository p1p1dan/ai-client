import {
  LEGACY_MIGRATION_REQUIRED,
  type LegacyMigrationSummary,
} from '@shared/types/legacyMigration';
import { isRuntimePermissionSettings } from '@shared/types/runtimePermission';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { useLegacyMigrationStore } from '@/stores/legacyMigration';
import { copySessionPreferences, writeSessionPermissions } from '../sessionPreferenceStore';
import { willMigrateOnResume } from './resumeIntent';

/**
 * dsh-rebase P1-9e (decisions 050, 051, 122, 123) — the renderer's half of
 * moving a 1.0.x chat to the current engine.
 *
 * Main migrates a legacy chat inside the resume that continues it, and reports
 * only through that call (decision 122 rule 15). So every resume goes through
 * {@link resumeSessionWithMigration}, which does the three things the answer
 * asks of this side:
 *
 *  - while a resume that will migrate is in flight, the chat is "migrating"
 *    (`useLegacyMigrationStore`), which the timeline and the composer show;
 *  - on success with a `migration` summary, the chat's stored preferences are
 *    copied to the key its legacy row now lives under (decision 051 rule 3),
 *    and the posture Main fell back to is written where the chip reads it;
 *  - a failure is left to the caller, which files it on the history card.
 *
 * Every other engine operation on a chat that is still legacy is refused with
 * `legacy_migration_required` (decision 122 rule 14); {@link
 * runAfterLegacyMigration} resumes the chat (which migrates it) and asks again.
 */

type ChatApi = Window['electronAPI']['chat'];
export type ResumeSessionArgs = Parameters<ChatApi['resumeSession']>[0];
export type ResumeSessionAnswer = Awaited<ReturnType<ChatApi['resumeSession']>>;

export interface LegacyMigrationSummaryEffects {
  copyPreferences: (fromSessionId: string, toSessionId: string) => unknown;
  writePermissions: typeof writeSessionPermissions;
  notePostureSynced: (sessionId: string) => void;
}

const defaultSummaryEffects = (): LegacyMigrationSummaryEffects => ({
  copyPreferences: copySessionPreferences,
  writePermissions: writeSessionPermissions,
  notePostureSynced: (sessionId) => useLegacyMigrationStore.getState().notePostureSynced(sessionId),
});

/**
 * What a successful migration's summary asks of the renderer.
 *
 * The copy runs first, so the legacy row inherits the values the chat had
 * BEFORE this resume: when Main fell back to the file's own posture, the file
 * already carries it for 1.0.x, and the renderer had stored none.
 */
export function applyLegacyMigrationSummary(
  sessionId: string,
  summary: LegacyMigrationSummary,
  effects: LegacyMigrationSummaryEffects = defaultSummaryEffects()
): void {
  effects.copyPreferences(sessionId, summary.legacySessionId);
  if (summary.legacyPermissionsApplied && isRuntimePermissionSettings(summary.legacyPermissions)) {
    effects.writePermissions(sessionId, summary.legacyPermissions);
    effects.notePostureSynced(sessionId);
  }
}

export interface MigratingResumeDeps {
  invoke: (args: ResumeSessionArgs) => Promise<ResumeSessionAnswer>;
  /** The resume will move this chat to the current engine (`willMigrateOnResume`). */
  migrates: (sessionId: string) => boolean;
  begin: (sessionId: string) => void;
  end: (sessionId: string) => void;
  applySummary: (sessionId: string, summary: LegacyMigrationSummary) => void;
}

const defaultResumeDeps = (): MigratingResumeDeps => ({
  invoke: (args) => window.electronAPI.chat.resumeSession(args),
  migrates: (sessionId) =>
    willMigrateOnResume(
      useChatSessionsStore.getState().sessions.find((session) => session.id === sessionId)
    ),
  begin: (sessionId) => useLegacyMigrationStore.getState().begin(sessionId),
  end: (sessionId) => useLegacyMigrationStore.getState().end(sessionId),
  applySummary: (sessionId, summary) => applyLegacyMigrationSummary(sessionId, summary),
});

/**
 * `chat.resumeSession`, with a legacy chat's migration made visible and its
 * summary applied. Resolves and rejects exactly as the call does.
 *
 * Wraps the call itself, not whatever races it: a Stop that abandons the wait
 * leaves the migration running in Main, and its summary still has to land.
 */
export async function resumeSessionWithMigration(
  args: ResumeSessionArgs,
  deps: MigratingResumeDeps = defaultResumeDeps()
): Promise<ResumeSessionAnswer> {
  const migrating = deps.migrates(args.sessionId);
  if (migrating) deps.begin(args.sessionId);
  try {
    const answer = await deps.invoke(args);
    if (answer?.migration) {
      try {
        deps.applySummary(args.sessionId, answer.migration);
      } catch (error) {
        // The chat is migrated and open; a preference copy that could not be
        // written costs a rollback its model pick, not this resume.
        console.warn('[legacy-migration] could not apply the migration summary', error);
      }
    }
    return answer;
  } finally {
    if (migrating) deps.end(args.sessionId);
  }
}

const MIGRATION_REQUIRED_PATTERN = new RegExp(`\\b${LEGACY_MIGRATION_REQUIRED}\\b`);

/** Main refused an engine operation because the chat has not been moved yet. */
export function isLegacyMigrationRequiredError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return MIGRATION_REQUIRED_PATTERN.test(message);
}

/**
 * Decision 122 rule 14: run an engine operation (the tree, a rewind, a fork,
 * `/compact`) and, when Main answers that the chat is still legacy, resume it
 * — which moves it to the current engine — and ask once more.
 *
 * A resume that fails has already put its reason on the chat's history card,
 * so the operation's own refusal is what rethrows: the caller shows it as
 * "could not be moved" ({@link LEGACY_MIGRATION_OPERATION_FAILED}).
 */
export async function runAfterLegacyMigration<T>(
  sessionId: string,
  operation: () => Promise<T>,
  resume: (sessionId: string) => Promise<boolean>
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!isLegacyMigrationRequiredError(error)) throw error;
    if (!(await resume(sessionId))) throw error;
    return operation();
  }
}

/** What a dialog says when the move an operation needed did not happen; a dictionary key. */
export const LEGACY_MIGRATION_OPERATION_FAILED =
  'This chat could not be moved to the current engine; the notice in the conversation says why.';

/** The timeline's notice while a chat is being moved; dictionary keys. */
export const LEGACY_MIGRATION_PROGRESS_TITLE = 'Moving this chat to the current engine…';
export const LEGACY_MIGRATION_PROGRESS_DETAIL =
  'A chat from the previous version is moved once, the first time it continues. Its original file is not changed.';
