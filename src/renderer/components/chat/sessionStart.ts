/**
 * dsh-rebase decision 176 — run an operation on a conversation the engine may
 * not be running.
 *
 * A conversation is on screen without running more often than not: reopened
 * after the app restarted (its history is a preview read off the file,
 * decision 030), reclaimed after 15 idle minutes, let go when a login, model
 * or plugin change rebuilt the engine. A send starts it on its way — the
 * resume in `runSend`'s preamble, which also moves a 1.0.x chat to the current
 * engine, checks the workspace against the index, and brings the engine up
 * with its credentials and model plan. `/compact`, the goal bar and the session
 * tree went straight to Main instead, which answered `session_not_found`; the
 * screen showed 「压缩上下文失败：No ready Pi WorkerSlot exists for …」.
 *
 * They now start the conversation the way a send does, then run:
 *
 *  - {@link startSessionAsSendDoes} is the send path's start with the send
 *    path's arguments: the same resume IPC through the same migration
 *    wrapper, the same model, effort and permissions. A send pressed
 *    meanwhile therefore joins the very same resume in Main (two resumes are
 *    one only when their fingerprints match). A failure is filed on the
 *    conversation's history card, as a send's is — the card is the friendly
 *    report (a workspace mismatch gets its non-retryable card) — but nothing
 *    raw goes above the composer: the operation says it in its own words.
 *  - {@link runWithSessionStarted} starts first when this window knows the
 *    conversation is not running; otherwise it runs, and when Main answers
 *    that it is not (the window missed a reclaim), starts it and runs once
 *    more — the shape of the send path's `session_not_found` fallback.
 *
 * Pure: every effect is injected (`sessionStartDeps.ts` wires the app's), so
 * the node suite runs all of it.
 */

import type { SessionEffortLevel } from '@shared/types/agentHost';
import type { RuntimePermissionSettings } from '@shared/types/runtimePermission';
import type { ChatSession, ChatWorkspace } from '@/stores/chatSessions';
import {
  encodePiResumeError,
  type HistoryErrorCode,
  isLegacyMigrationRefusal,
} from './historyError';
import {
  isLegacyMigrationRequiredError,
  LEGACY_MIGRATION_OPERATION_FAILED,
  type ResumeSessionArgs,
} from './sessionIndex/legacyMigration';
import { shouldResumeSession } from './sessionIndex/resumeIntent';

/** Why a conversation was not started, with nothing asked of Main or nothing filed. */
export type SessionStartRefusal =
  /** No row for it in this window. */
  | 'no-session'
  /** It never ran: nothing on disk to start from. A send would create it; an operation has nothing to act on. */
  | 'no-transcript'
  /** No folder to run it in. */
  | 'no-workspace'
  /** A turn runs in it already. */
  | 'busy'
  /** Main is reopening it after an engine restart; it runs again in a moment. */
  | 'restarting';

export type SessionStartOutcome =
  /** The engine runs it already; nothing was done. */
  | { kind: 'running' }
  /** Started now, by the send path's resume. */
  | { kind: 'started' }
  | { kind: 'refused'; reason: SessionStartRefusal }
  /** Main could not start it; the reason is on the conversation's history card. */
  | { kind: 'failed'; code: HistoryErrorCode };

export type SessionStartFailure = Extract<SessionStartOutcome, { kind: 'refused' | 'failed' }>;

/** What a send would start the conversation on: `runSend`'s own three reads. */
export interface SessionStartPreferences {
  model?: string;
  effort?: SessionEffortLevel;
  permissions?: RuntimePermissionSettings;
}

export interface SessionStartDeps {
  /** The window's store as it is now. `running`: `hostBoundSessionIds` names it. */
  snapshot: (sessionId: string) => {
    running: boolean;
    session: ChatSession | undefined;
    workspace: ChatWorkspace | undefined;
  };
  /** The send path's model, effort and permissions for it (pinning defaults the way a send does). */
  preferences: (sessionId: string) => SessionStartPreferences;
  ensureHost: () => Promise<unknown>;
  /** `resumeSessionWithMigration`: the send path's resume, a 1.0.x chat's move included. */
  resume: (args: ResumeSessionArgs) => Promise<unknown>;
  /** Write the window's belief (`hostBoundSessionIds`), as a send does around its resume. */
  markRunning: (sessionId: string, running: boolean) => void;
  /** File a failed start on the conversation's history card (`historyErrors`). */
  fileFailure: (sessionId: string, encoded: string) => void;
}

/**
 * `<code>` inside Electron's wrapper, word-guarded so `pi_session_not_found`
 * (the index has no row) is never read as `session_not_found`.
 */
function codePattern(code: string): RegExp {
  return new RegExp(`(?:^|[^A-Za-z0-9_])${code}(?![A-Za-z0-9_])`);
}

const SESSION_NOT_FOUND = codePattern('session_not_found');
const SESSION_NOT_READY = codePattern('session_not_ready');
const SESSION_BUSY = codePattern('session_busy');

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '');
}

/**
 * Main refused an operation because the engine does not run the conversation:
 * no ready slot (`session_not_found`), or a 1.0.x chat not moved yet
 * (`legacy_migration_required`, decision 122 rule 14). Either way, starting it
 * the way a send does is the answer.
 */
export function isSessionNotRunningError(error: unknown): boolean {
  return SESSION_NOT_FOUND.test(messageOf(error)) || isLegacyMigrationRequiredError(error);
}

/**
 * Start the conversation the way a send does, unless it runs already.
 *
 * Differs from `runSend`'s preamble in two places only, both on purpose: a
 * conversation that never ran is not created (a send would; an operation has
 * nothing to act on in it), and a failure is not copied above the composer as
 * Main's sentence (`lastError`): the caller reports it in words, next to the
 * card the failure is filed on.
 */
export async function startSessionAsSendDoes(
  sessionId: string,
  deps: SessionStartDeps
): Promise<SessionStartOutcome> {
  const { running, session, workspace } = deps.snapshot(sessionId);
  if (running) return { kind: 'running' };
  if (!session) return { kind: 'refused', reason: 'no-session' };
  if (!session.runtimeIdentity) return { kind: 'refused', reason: 'no-transcript' };
  const intent = shouldResumeSession(session, workspace, deps.preferences(sessionId));
  if (!intent.shouldResume || !intent.args) {
    return {
      kind: 'refused',
      reason: intent.reason?.startsWith('busy:') ? 'busy' : 'no-workspace',
    };
  }
  try {
    await deps.ensureHost();
    await deps.resume(intent.args);
  } catch (error) {
    const message = messageOf(error);
    // Main's recovery after an engine restart holds the conversation: it is
    // about to run again, which no card should say otherwise.
    if (SESSION_NOT_READY.test(message)) return { kind: 'refused', reason: 'restarting' };
    if (SESSION_BUSY.test(message)) return { kind: 'refused', reason: 'busy' };
    const encoded = encodePiResumeError(error);
    deps.markRunning(sessionId, false);
    deps.fileFailure(sessionId, encoded.encoded);
    return { kind: 'failed', code: encoded.code };
  }
  deps.markRunning(sessionId, true);
  return { kind: 'started' };
}

export type SessionOperationPhase = 'starting' | 'running';

export type StartedOperationResult<T> =
  /** `started`: the conversation was started for this operation. */
  | { kind: 'done'; value: T; started: boolean }
  | { kind: 'not-started'; start: SessionStartFailure }
  /** The conversation was ended while it was being started; the operation was not run. */
  | { kind: 'cancelled' };

export interface SessionStartEffects {
  /** {@link startSessionAsSendDoes}, with the window's effects. */
  start: (sessionId: string) => Promise<SessionStartOutcome>;
  /** The window's belief that the engine runs it (`hostBoundSessionIds`). */
  isRunning: (sessionId: string) => boolean;
  /** Drop that belief: Main said otherwise. */
  forgetRunning: (sessionId: string) => void;
}

/**
 * Run `operation` once the engine runs the conversation.
 *
 * Not running (as far as this window knows): start it first. Running: run, and
 * if Main answers that it is not after all — the window missed a reclaim or a
 * restart — start it and run once more. An operation that fails that way right
 * after this call started it is not tried a third time: something took the
 * conversation away again (it was ended, or released), and that is what the
 * caller reports.
 *
 * `cancelled` is asked after a start: the user ended the conversation while it
 * was being started, so the operation is not run on what is left of it.
 */
export async function runWithSessionStarted<T>(
  input: SessionStartEffects & {
    sessionId: string;
    operation: () => Promise<T>;
    onPhase?: (phase: SessionOperationPhase) => void;
    cancelled?: () => boolean;
  }
): Promise<StartedOperationResult<T>> {
  const { sessionId } = input;
  const run = async (started: boolean): Promise<StartedOperationResult<T>> => {
    input.onPhase?.('running');
    return { kind: 'done', value: await input.operation(), started };
  };
  const startThenRun = async (): Promise<StartedOperationResult<T>> => {
    input.onPhase?.('starting');
    const outcome = await input.start(sessionId);
    if (outcome.kind === 'refused' || outcome.kind === 'failed') {
      return { kind: 'not-started', start: outcome };
    }
    if (input.cancelled?.()) return { kind: 'cancelled' };
    return run(outcome.kind === 'started');
  };

  if (!input.isRunning(sessionId)) return startThenRun();
  try {
    return await run(false);
  } catch (error) {
    if (!isSessionNotRunningError(error)) throw error;
  }
  input.forgetRunning(sessionId);
  return startThenRun();
}

/** The status line while a conversation is being started for an operation; a dictionary key. */
export const SESSION_STARTING_LINE = 'Starting the conversation…';

/** Dictionary keys: why an operation could not start the conversation it needed. */
export const SESSION_START_FAILED =
  'The conversation could not be started; the notice in the conversation says why.';
export const SESSION_START_RESTARTING =
  'The engine is reopening this conversation. Try again in a moment.';
export const SESSION_START_BUSY =
  'A reply is running in this conversation. Try again when it ends.';
export const SESSION_START_NO_TRANSCRIPT = 'This conversation has no messages yet.';
export const SESSION_START_NO_WORKSPACE = 'This conversation has no folder to run in.';
/** The conversation stopped running again before the operation reached it (ended, or let go). */
export const SESSION_STOPPED_BEFORE_RUN =
  'The conversation stopped running before this could be done. Nothing was changed.';
/**
 * The jobs and subagents windows: their stop and interrupt act on work that
 * only exists while the conversation runs, so nothing is started for them.
 */
export const SESSION_TASKS_ENDED =
  'This conversation is no longer running, and its tasks ended with it.';

/** The words for a start that did not happen; a dictionary key. */
export function sessionStartFailureKey(failure: SessionStartFailure): string {
  if (failure.kind === 'failed') {
    // A 1.0.x chat that could not be moved keeps the sentence it always had.
    return isLegacyMigrationRefusal(failure.code)
      ? LEGACY_MIGRATION_OPERATION_FAILED
      : SESSION_START_FAILED;
  }
  switch (failure.reason) {
    case 'restarting':
      return SESSION_START_RESTARTING;
    case 'busy':
      return SESSION_START_BUSY;
    case 'no-transcript':
      return SESSION_START_NO_TRANSCRIPT;
    default:
      return SESSION_START_NO_WORKSPACE;
  }
}

/** Every key above, for the surfaces that translate a stored key when they show it. */
export const SESSION_START_KEYS: readonly string[] = [
  SESSION_START_FAILED,
  SESSION_START_RESTARTING,
  SESSION_START_BUSY,
  SESSION_START_NO_TRANSCRIPT,
  SESSION_START_NO_WORKSPACE,
  SESSION_STOPPED_BEFORE_RUN,
  LEGACY_MIGRATION_OPERATION_FAILED,
];
