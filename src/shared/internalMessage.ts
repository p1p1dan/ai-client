/**
 * Messages the runtime feeds a model on its own behalf.
 *
 * ## Why a mark is needed at all
 *
 * The delegation auto-resume hands a subagent's report back to the parent with
 * `agent.prompt(report)`, and pi wraps every prompt as a `role: 'user'` message
 * — the same shape a person's typing produces. Downstream, nothing could tell
 * the two apart: the projector minted a user bubble for the report and stamped
 * it with the real send's `attemptId` and attachment chips, and the session file
 * ended up with a report the user never wrote as its newest user message. The
 * P5-2 contract says the opposite in as many words: an internal report gets no
 * user bubble, and must not displace "the latest real user task".
 *
 * ## Why the mark rides on the message
 *
 * A flag held beside the stream would only work while the stream is live. This
 * has to survive the JSONL round trip, because the reopen is exactly where the
 * report gets mistaken for the user's newest instruction. The session codec
 * carries unknown message fields through untouched, so the mark persists with
 * the message it describes — the text stays in the model's context, which is
 * what it is for, and everything that projects or summarizes can see what it is.
 */

/** What produced a message the user did not write. */
export type InternalMessageOrigin = 'subagent-report';

const FIELD = 'aiclientInternal';

/** The mark, as fields to merge onto a message. */
export function internalMessageMark(origin: InternalMessageOrigin): {
  aiclientInternal: InternalMessageOrigin;
} {
  return { [FIELD]: origin } as { aiclientInternal: InternalMessageOrigin };
}

/**
 * Copy a message with the mark applied.
 *
 * `Object.assign` onto a fresh object rather than a spread literal: the message
 * types come from pi and have no room for an extra field, and this keeps the
 * caller's type intact instead of asking every call site to cast.
 */
export function markInternalMessage<T extends object>(
  message: T,
  origin: InternalMessageOrigin
): T {
  return Object.assign({}, message, internalMessageMark(origin)) as T;
}

/**
 * The origin of a message the runtime produced, or undefined for a real one.
 *
 * Takes `unknown` because its callers read messages off a stream, out of a
 * session file and out of a projection — three places with three different
 * static types and one question.
 */
export function internalMessageOrigin(value: unknown): InternalMessageOrigin | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const origin = (value as Record<string, unknown>)[FIELD];
  return origin === 'subagent-report' ? origin : undefined;
}

/** True when this message is one the runtime wrote for itself. */
export function isInternalMessage(value: unknown): boolean {
  return internalMessageOrigin(value) !== undefined;
}
