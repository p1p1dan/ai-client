import { useChatSessionsStore } from '@/stores/chatSessions';
import { encodePiResumeError, isLegacyMigrationRefusal } from '../historyError';
import { ensureScratchRunDirectory, knownRunDirectory } from '../runDirectory';
import { readDefaultPermissions, readSessionPermissions } from '../sessionPreferenceStore';
import { resumeSessionWithMigration } from './legacyMigration';
import { isSessionBusy, shouldApplyResumeResult, shouldResumeSession } from './resumeIntent';

/**
 * Hook exposing the user-driven "resume historical session" action (T-03).
 *
 * Brings a session into focus and asks the Agent Host to replay its
 * transcript. The Host emits `session.resumed → session.history → status
 * idle`; the red-line store already folds `session.history` into the
 * timeline (history messages use `h:` prefix, runtime messages untouched).
 *
 * Renderer-only: does not read Pi JSONL. Session metadata comes from the
 * durable index; branch history arrives only through WorkerSlot RuntimeEvents.
 *
 * dsh-rebase P1-9e: a legacy chat is moved to the current engine by this very
 * resume (decision 050); `resumeSessionWithMigration` shows that while it runs
 * and applies what the answer reports.
 */

export interface ResumeSessionOptions {
  persistedRuntimeIdentity?: string;
  model?: string;
  /**
   * concurrency-02 — reopen a session whose writer lock still looks held.
   * Passed only by the `session_locked` notice's "Restart engine" button;
   * on DSH, Main restarts the shared engine before it reopens (P1-3c).
   */
  forceTakeover?: boolean;
}

export interface UseResumeSessionResult {
  resume: (sessionId: string, options?: ResumeSessionOptions) => Promise<boolean>;
}

/**
 * The resume action itself, outside React: it reads the store at call time and
 * holds no component state, so the hook below only hands it out. (An operation
 * that needs the chat running starts it through `sessionStart.ts` instead,
 * with the send path's arguments — decision 176.)
 */
export async function resumeSessionById(
  sessionId: string,
  options: ResumeSessionOptions = {}
): Promise<boolean> {
  const state = useChatSessionsStore.getState();
  const session = state.sessions.find((item) => item.id === sessionId);
  const workspace = state.workspaces.find((ws) => ws.id === session?.workspaceId);
  // U12 fix: read from the same per-session store the composer chip writes.
  // Without it a sidebar resume spawns a worker on the default tier while
  // the chip still shows the tier the user chose.
  const storedPermissions = readSessionPermissions(sessionId) ?? readDefaultPermissions();
  // Decision 176, GUI point-check fix (2026-10-11): the directory a send would
  // run it in (`runDirectory.ts`). A temporary chat made in this run has no
  // record of its scratch directory, so the history card's Retry refused it
  // while a send went through; it is asked for, as a send asks — only for a
  // chat this resume would open, and only then awaited, so every other resume
  // still leaves on this tick.
  let workspacePath = knownRunDirectory(session, workspace) ?? undefined;
  const opens =
    session !== undefined &&
    Boolean(session.runtimeIdentity ?? options.persistedRuntimeIdentity) &&
    !isSessionBusy(session.status);
  if (!workspacePath && opens) {
    workspacePath = await ensureScratchRunDirectory(sessionId).catch(() => undefined);
  }
  const intent = shouldResumeSession(session, workspace, {
    persistedRuntimeIdentity: options.persistedRuntimeIdentity,
    model: options.model,
    ...(options.forceTakeover ? { forceTakeover: true } : {}),
    ...(storedPermissions ? { permissions: storedPermissions } : {}),
    ...(workspacePath ? { workspacePath } : {}),
  });
  if (!intent.shouldResume || !intent.args) return false;

  try {
    await resumeSessionWithMigration(intent.args);
    // F2 (D29 adversarial-review, major): guard against the race where
    // the user selects a different session while resumeSession is in
    // flight (see shouldApplyResumeResult's doc comment — most visible on
    // a cold-start resume). Both callers already set activeSessionId to
    // sessionId synchronously before calling resume(), so this write is a
    // redundant backstop; skipping it here is zero-risk when the guard
    // fails and prevents dragging the user back to a session they left.
    if (shouldApplyResumeResult(useChatSessionsStore.getState().activeSessionId, sessionId)) {
      useChatSessionsStore.setState({
        activeSessionId: sessionId,
        lastError: null,
      });
    }
    return true;
  } catch (error) {
    const encodedError = encodePiResumeError(error);
    useChatSessionsStore.setState((current) => ({
      // dsh-rebase P1-9e: a legacy chat that could not be moved (or has to be
      // moved first) is reported by its history card alone; no raw copy of
      // Main's sentence above the composer.
      lastError: isLegacyMigrationRefusal(encodedError.code) ? null : encodedError.message,
      historyErrors: {
        ...current.historyErrors,
        [sessionId]: encodedError.encoded,
      },
    }));
    return false;
  }
}

const RESULT: UseResumeSessionResult = { resume: resumeSessionById };

export function useResumeSession(): UseResumeSessionResult {
  return RESULT;
}
