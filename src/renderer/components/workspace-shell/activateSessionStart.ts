/**
 * "Does clicking this session have to start a worker for it?" — the three-part
 * rule behind `useActivateSession`, alone in a leaf module so it can be tested.
 *
 * It lives apart from the hook for two reasons. The hook reaches for the store,
 * the resume hook and the model resolver, none of which this decision needs, and
 * the repo's vitest environment is `node` and collects `.ts` only — a rule
 * buried in a React callback is a rule no test can state. This module therefore
 * imports nothing but one pure shared constant; every input is a plain field
 * the caller already has.
 *
 * The rule is unchanged from the inline version it replaces:
 *
 *   1. No runtime identity → nothing to resume FROM. A brand-new chat has no
 *      session file yet; its first send is what creates one.
 *   2. No workspace AND not a temporary chat → nothing to resume INTO. U13:
 *      a temporary chat has no workspace on purpose and would otherwise open
 *      with an empty timeline forever.
 *   3. A timeline already in memory → nothing to resume FOR. This is the clause
 *      T092 leans on: a conversation the user ended (or one the pool reclaimed)
 *      keeps its transcript, so activating it just shows it, and the runtime
 *      comes back on the next send instead of on a click. Inverting this to
 *      "start whenever the host binding is gone" would make every reclaimed
 *      session grab a worker the moment it is clicked, which is exactly the
 *      pressure reclamation exists to relieve.
 *
 * T102 (decision 030) adds what happens once the three-part rule says yes. It
 * no longer says "resume": a session with no live worker is PREVIEWED first —
 * Main reads its transcript off the file and publishes one `session.history`
 * event — and the worker is left for the first send. Resume stays as the
 * fallback, for a session that already has a worker and for a file that cannot
 * be replayed; an Agent SDK chat resumes straight away (decision 197).
 */

import { CLAUDE_SDK_STUB_SUFFIX } from '@shared/claudeSdkEngine';

export interface SessionActivation {
  /** The session file this row can be resumed from, if it has one yet. */
  runtimeIdentity: string | undefined;
  /** The session's workspace resolved to a real entry in the store. */
  hasWorkspace: boolean;
  /** U13: a deliberate temporary chat, which runs without a workspace. */
  unbound: boolean;
  /** The transcript is already in memory for this session. */
  hasTimeline: boolean;
}

/**
 * The identity to resume from, or `null` when this activation must not start a
 * worker. Returning the identity rather than a boolean keeps the caller's
 * `persistedRuntimeIdentity` argument type-safe without a second check.
 */
export function resumeIdentityForActivation(input: SessionActivation): string | null {
  if (!input.runtimeIdentity) return null;
  if (!input.hasWorkspace && !input.unbound) return null;
  if (input.hasTimeline) return null;
  return input.runtimeIdentity;
}

/** What one activation actually did, for the caller and for the tests. */
export type SessionActivationOutcome = 'idle' | 'previewed' | 'resumed';

/**
 * The two things an activation can ask for, injected rather than imported.
 *
 * Injection is what keeps this module dependency-free (see the header): the
 * preview is an IPC call and the resume is a hook, neither of which the repo's
 * `node` vitest environment can load, while the RULE between them is exactly
 * what needs a test.
 */
export interface SessionActivationEffects {
  /** Ask Main to publish this session's transcript straight off its file. */
  preview: (input: { sessionId: string; runtimeIdentity: string }) => Promise<unknown>;
  /** The existing resume path: index check, worker spawn, `session.resumed`. */
  resume: (input: { sessionId: string; runtimeIdentity: string }) => Promise<unknown>;
  /**
   * This click is about to load a transcript that is not in memory, so the
   * timeline should say "loading" instead of "no messages yet" until it
   * arrives (`historyLoading.ts` — the bug that store exists for).
   *
   * Called once the decision to load has been made, before either branch, and
   * never on the `idle` path: a session whose transcript is already on screen
   * loads nothing, so nothing about it should change appearance.
   * Optional so a caller that does not paint a timeline can omit it.
   */
  onLoad?: (input: { sessionId: string }) => void;
}

export interface SessionActivationInput extends SessionActivation {
  sessionId: string;
  /**
   * This session already has a live worker (the store's `hostBoundSessionIds`).
   *
   * Then the worker's in-memory branch is the authority and its file may lag,
   * so the preview channel refuses it anyway — asking would cost a round trip
   * to be told `worker_active`.
   */
  hostBound: boolean;
}

/**
 * Run one activation: preview if we can, resume if we must, nothing if the
 * three-part rule says this click starts nothing.
 *
 * ## Why a failed preview falls back instead of reporting
 *
 * Every preview failure means the same thing to the user — the transcript did
 * not appear — and the resume path is the one that has always been able to
 * produce it (it can recover an unfinished SDK operation, convert a legacy
 * file on disk, take over a stranded writer lock). So a refusal here is not an
 * error to show; it is the signal to do what this code did before T102. The
 * failure the user does see is the resume's own, through the existing
 * `historyErrors` channel.
 *
 * ## Why a preview must not mark the session host-bound
 *
 * `hostBoundSessionIds` is the store's answer to "does this session have a
 * worker", and the next send reads it to decide between `createSession` and a
 * plain `send`. Nothing here may set it: a previewed session has no worker, and
 * claiming otherwise would have the composer address one that does not exist.
 * The binding is set by the `session.resumed` event, which only `resume` can
 * produce — hence the strict split below, and the test that a previewed
 * activation never calls `resume`.
 */
export async function runSessionActivation(
  input: SessionActivationInput,
  effects: SessionActivationEffects
): Promise<SessionActivationOutcome> {
  const runtimeIdentity = resumeIdentityForActivation(input);
  if (!runtimeIdentity) return 'idle';
  // Every path past this point loads a transcript the timeline does not have,
  // so the load is announced once, here — a preview that falls back to a resume
  // is still one load, and announcing it again would restart its deadline.
  effects.onLoad?.({ sessionId: input.sessionId });
  const resume = async (): Promise<SessionActivationOutcome> => {
    await effects.resume({ sessionId: input.sessionId, runtimeIdentity });
    return 'resumed';
  };
  if (input.hostBound) return resume();
  // Decision 197: an Agent SDK chat's transcript is the CLI's own and only its
  // host reads it, so Main refuses that preview every time; asking would cost
  // a round trip and an error in Main's log. The stub's suffix is the rule
  // Main reopens on.
  if (runtimeIdentity.endsWith(CLAUDE_SDK_STUB_SUFFIX)) return resume();
  try {
    await effects.preview({ sessionId: input.sessionId, runtimeIdentity });
    return 'previewed';
  } catch {
    return resume();
  }
}
