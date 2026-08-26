/**
 * Client-side ids that cannot collide.
 *
 * ## Why this exists
 *
 * `session-${Date.now()}` was the shape chat sessions used, and two chats
 * created inside the same millisecond got the SAME id — reachable by
 * double-clicking New, and reachable more often on a fast machine than the
 * phrasing suggests. Two sessions sharing an id do not fail loudly: they share
 * a row in every `Record<sessionId, …>` the app keeps (runtime facts, draft
 * postures, per-session model and effort), so one chat silently answers for the
 * other.
 *
 * Two other call sites had already reached for the same fix independently
 * (`clone-…` and `review-…`), spelled two different ways. A third spelling is
 * how a rule stops being a rule, so this is the one definition and all three go
 * through it.
 *
 * ## The shape, and why the timestamp stays
 *
 * `<prefix>-<millis>-<random>`. The random suffix is what makes it unique; the
 * timestamp is kept because these ids are read by humans in logs, in the
 * devtools store inspector and in bug reports, and a bare random string throws
 * away "when was this made" for nothing. Nothing PARSES the timestamp — no code
 * path in this repo splits an id or reads it back as a number, which is what
 * makes the format free to change at all.
 *
 * `crypto.randomUUID()` is deliberately not used: it needs a secure context,
 * and the fallback for when it is missing would be this function anyway. 7
 * base-36 characters is ~78 billion values per millisecond, against a
 * collision domain of "ids minted in the same millisecond by one renderer".
 */

/** Characters of randomness after the timestamp. */
const SUFFIX_LENGTH = 7;

export function uniqueId(prefix: string): string {
  const suffix = Math.random()
    .toString(36)
    .slice(2, 2 + SUFFIX_LENGTH)
    .padEnd(SUFFIX_LENGTH, '0');
  return `${prefix}-${Date.now()}-${suffix}`;
}
