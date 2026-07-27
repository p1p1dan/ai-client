import type { SessionRuntimeStatus } from '@shared/types/runtimeEvents';
import type { ChatSession, ChatWorkspace } from '@/stores/chatSessions';

/**
 * Decide whether a session needs an explicit resume (T-03).
 *
 * Why: resume replay only makes sense for sessions that already carry a
 * runtime identity (the Host recorded one). New "New" sessions or never-bound
 * sessions have nothing to replay; resuming them would error on the Host
 * side. Calling chat.resumeSession for them would surface `session_busy` or
 * `invalid_payload`, so the UI should just open them as a fresh idle session.
 */

export interface ResumeIntent {
  /** True when a resume is actionable for this session. */
  shouldResume: boolean;
  /** Args to pass to chat.resumeSession when shouldResume is true. */
  args?: {
    sessionId: string;
    runtimeIdentity: string;
    workspacePath: string;
    model?: string;
  };
  /** Reason the resume was skipped (for telemetry / diags). */
  reason?: string;
}

/**
 * Statuses where the Host would reject a resume with `session_busy`.
 *
 * Single source of truth: `shouldResumeSession` skips these, and the UI must
 * disable any resume-backed control for the same set — otherwise the button is
 * a guaranteed no-op (T-03 review).
 */
export function isSessionBusy(status: SessionRuntimeStatus): boolean {
  return (
    status === 'starting' ||
    status === 'running' ||
    status === 'waiting_permission' ||
    status === 'waiting_question' ||
    status === 'stopping'
  );
}

export function shouldResumeSession(
  session: ChatSession | undefined,
  workspace: ChatWorkspace | undefined,
  options: {
    /**
     * Skip when the session is mid-turn — resume would be rejected by Host
     * (`session_busy`) and any in-flight stream would be discarded. Default true.
     */
    skipBusy?: boolean;
    /**
     * Pending runtime identity override (from sessionIndex by id). Pass when
     * the live ChatSession lacks runtimeIdentity but the persistent index has
     * one — resume still applies.
     */
    persistedRuntimeIdentity?: string;
    /** Model id to bind for the resumed turn (optional). */
    model?: string;
  } = {}
): ResumeIntent {
  const skipBusy = options.skipBusy ?? true;
  if (!session) {
    return { shouldResume: false, reason: 'no-session' };
  }
  if (!workspace) {
    return { shouldResume: false, reason: 'no-workspace' };
  }
  const runtimeIdentity = session.runtimeIdentity ?? options.persistedRuntimeIdentity;
  if (!runtimeIdentity) {
    return { shouldResume: false, reason: 'no-runtime-identity' };
  }
  if (skipBusy && isSessionBusy(session.status)) {
    return { shouldResume: false, reason: `busy:${session.status}` };
  }
  return {
    shouldResume: true,
    args: {
      sessionId: session.id,
      runtimeIdentity,
      workspacePath: workspace.path,
      model: options.model,
    },
  };
}

/**
 * Choose a placeholder for the restored session title when no explicit one is
 * known. Uses the first-user-preview from the persisted summary when present.
 */
export function resumeDisplayTitle(
  session: ChatSession | undefined,
  fallback: { firstMessage: string | null }
): string {
  if (session?.title && session.title !== 'New chat' && session.title !== 'Live Agent Host') {
    return session.title;
  }
  const fm = fallback.firstMessage;
  return fm ? truncatePreview(fm, 60) : 'Untitled session';
}

function truncatePreview(text: string, max: number): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}
