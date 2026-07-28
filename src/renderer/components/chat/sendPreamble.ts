/**
 * Decide what has to happen to the Host session *before* a turn is sent.
 *
 * Context (2026-07-28 context-loss bug): ChatComposer.runSend used to close
 * and recreate the Host session on every send. Host-side resume already
 * works — claudeRuntime passes `resume: session.runtimeIdentity` whenever the
 * registry entry carries one — but `session.close` (registry.delete) destroys
 * that entry each turn, so every send started a brand-new conversation. The
 * GUI-mirror probe confirmed it: a fresh runtimeIdentity came back on every
 * turn and the model reported no memory of the prior one; keeping the Host
 * registry entry alive across sends recalled the fact correctly.
 *
 * The fix is to stop treating "close + create" as the only way to talk to a
 * session:
 * - If the Host registry entry is still alive (`hostBound`), send directly —
 *   no close/create round-trip, and no `resume` is even needed because the
 *   entry never left the registry.
 * - If the entry is gone (fresh session, Host restart, or a session opened
 *   from history) but we know its prior `runtimeIdentity`, ask the Host to
 *   resume with that identity instead of starting a new conversation.
 * - Only when neither is true (truly first turn) do we create a new session.
 */
export type SendPreamble =
  | { action: 'direct' }
  | { action: 'resume'; runtimeIdentity: string }
  | { action: 'create' };

export function decideSendPreamble(input: {
  hostBound: boolean;
  runtimeIdentity: string | null | undefined;
}): SendPreamble {
  if (input.hostBound) {
    return { action: 'direct' };
  }
  if (input.runtimeIdentity) {
    return { action: 'resume', runtimeIdentity: input.runtimeIdentity };
  }
  return { action: 'create' };
}
