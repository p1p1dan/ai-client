/**
 * D48 S1: the ONE criterion for "this chat session's runtime binding is already
 * settled", extracted so every consumer reaches the same symbol.
 *
 * Three copies of this judgement existed before this slice, and two of them say
 * so in their own comments: `isLiveOnlySession` (`sessionIndex/useSessionIndex`,
 * "Same criterion as `computeEverHostBound`") and `MiddleColumnModeInput`
 * (`middleColumnLayout.ts`, "mirrors `computeEverHostBound`"). A fourth copy is
 * not a cosmetic inconsistency: a session restored from `session-index.json`
 * that one reader judges "not yet materialized" can have its agent switched,
 * and the next message then carries the OLD agent's resume handle into the NEW
 * agent's resume branch — the same shape as the accident recorded in
 * `useComposerTarget.ts`'s own target-change header.
 *
 * Zero value imports on purpose (`pureModuleImports.test.ts` scans this file):
 * the store, the target bar, the composer chain and the picker's view model all
 * read it, and it stays testable under the node-env vitest run.
 */

import type { ChatSession } from '@/stores/chatSessions';

/**
 * "Ever host-bound" for a session: true when the session is currently
 * registered with Agent Host (`hostBoundSessionIds`) OR it carries a
 * persisted `runtimeIdentity` even though it isn't in that list right now —
 * the case for a session restored from session-index.json (messageCount=0,
 * history not yet loaded, Host not running). A restored session must still
 * be judged as host-bound: retargeting it in place would send the first
 * message through `decideSendPreamble`'s 'resume' path (it only checks
 * hostBound + runtimeIdentity, not "is Host live right now"), which resumes
 * the OLD conversation into the NEW cwd instead of starting a fresh one.
 */
export function computeEverHostBound(
  session: Pick<ChatSession, 'id' | 'runtimeIdentity'> | undefined,
  hostBoundSessionIds: readonly string[]
): boolean {
  if (!session) {
    return false;
  }
  return hostBoundSessionIds.includes(session.id) || session.runtimeIdentity != null;
}

/**
 * The three facts that decide whether a chat session's agent may still change.
 *
 * Deliberately the same triple `MiddleColumnModeInput` already carries: the
 * middle column docks on exactly these inputs, so "the composer looks like a
 * live session" and "the binding is settled" are answers to one question, not
 * two that happen to agree today.
 */
export interface ChatAgentBindingInput {
  /**
   * This app run already committed a send for this session. Sticky, and it
   * lives in `ChatWorkspace`'s own `useState` (`rememberSendAttempt`) — no
   * store holds it, so any consumer below the workspace must be handed it.
   */
  sendAttempted: boolean;
  /** sessionId ∈ `hostBoundSessionIds`. */
  hostBound: boolean;
  /** `session.runtimeIdentity != null` — the restored-session arm. */
  hasRuntimeIdentity: boolean;
}

/**
 * Whether the agent binding is locked for this session.
 *
 * `hostBound`/`hasRuntimeIdentity` alone would leave a real window open: the
 * create IPC is dispatched several `await`s before either becomes true, so a
 * user could repoint a session whose first turn is already on the wire.
 * `sendAttempted` alone would miss every session restored from the index.
 * Both halves are needed, which is why they are one function.
 */
export function isChatAgentBindingLocked(input: ChatAgentBindingInput): boolean {
  return input.sendAttempted || input.hostBound || input.hasRuntimeIdentity;
}
