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
  if (skipBusy) {
    const status = session.status;
    if (
      status === 'starting' ||
      status === 'running' ||
      status === 'waiting_permission' ||
      status === 'waiting_question' ||
      status === 'stopping'
    ) {
      return { shouldResume: false, reason: `busy:${status}` };
    }
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
