import { type AgentWireName, sessionAgent } from '@shared/types/agentWire';
import type { SessionRuntimeStatus } from '@shared/types/runtimeEvents';
import type { ChatSession, ChatWorkspace } from '@/stores/chatSessions';
import { isPlaceholderTitle } from './sessionTitle';

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
    /** S2 (b): which runtime resumes it — `runtimeIdentity` is opaque without it. */
    agent: AgentWireName;
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
  if (!workspace.path) {
    // Demo placeholder workspace (path '') — resuming against it would hand
    // the Host an empty cwd. Real workspaces always carry a repository path.
    return { shouldResume: false, reason: 'no-workspace-path' };
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
      // D48 S2 (B11): `Automatic` reaches here as `undefined`, and the key is
      // dropped rather than sent with an undefined value — "no model" has to be
      // indistinguishable from "field absent" for the runtime default to apply.
      ...(options.model ? { model: options.model } : {}),
      agent: sessionAgent(session),
    },
  };
}

/**
 * Choose a placeholder for the restored session title when no explicit one is
 * known. Uses the first-user-preview from the persisted summary when present.
 *
 * "What counts as a placeholder title" is defined once, in `sessionTitle.ts`'s
 * `isPlaceholderTitle` — round-3's first-message auto-title wiring (T-27
 * point-check #10) reuses the exact same function so the two call sites can
 * never disagree on the rule (round-3 fix: this used to inline its own
 * `!== 'New chat' && !== 'Live Agent Host'` check, which — unlike
 * `isPlaceholderTitle` — did not recognize the `Session xxxxxx` fallback
 * shape from `sessionIndexMerge.ts`'s `fallbackSessionTitle` as a
 * placeholder).
 */
export function resumeDisplayTitle(
  session: ChatSession | undefined,
  fallback: { firstMessage: string | null }
): string {
  if (session?.title && !isPlaceholderTitle(session.title)) {
    return session.title;
  }
  const fm = fallback.firstMessage;
  return fm ? truncatePreview(fm, 60) : 'Untitled session';
}

/**
 * F2 (D29 adversarial-review, major): guards `useResumeSession`'s post-await
 * store write.
 *
 * `resume()` awaits `chat.resumeSession` before writing `activeSessionId`
 * back to the store. Both callers (LeftNav's `handleSelectSession`,
 * MessageTimeline's `HistoryErrorNotice` retry) already set `activeSessionId`
 * to this same session synchronously before calling `resume()`, so that write
 * is a redundant backstop, not the primary selection path — writing it
 * unconditionally after the await raced the user: if they picked a different
 * session while the Host round-trip was in flight (most visible on a cold
 * start, where the first resume can take a while), the stale write would
 * silently drag them back to the session they had just left.
 *
 * Skip the write whenever the store has already moved on.
 */
export function shouldApplyResumeResult(
  currentActiveSessionId: string | null,
  resumedSessionId: string
): boolean {
  return currentActiveSessionId === resumedSessionId;
}

function truncatePreview(text: string, max: number): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}
