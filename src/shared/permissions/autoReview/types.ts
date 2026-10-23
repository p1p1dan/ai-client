/**
 * Decision 192: the auto gear's review step. A call the gate would ask about
 * goes to a review model first; this is the vocabulary between the gate and
 * whatever performs the review (the DSH host's reviewer).
 */

export type AutoReviewFailure =
  /** No answer before the review's own deadline. */
  | 'timeout'
  /** The gateway or the model call failed. */
  | 'error'
  /**
   * The review model's service would not answer this request (a policy or
   * safety stop, e.g. Anthropic's `refusal`); the same request gets the same
   * answer, so the call goes to the user's card.
   */
  | 'refused'
  /** The answer named neither verdict, or both. */
  | 'unparseable'
  /** The conversation does not fit the review model's context window. */
  | 'too_long'
  /** No rules or no review model could be loaded. */
  | 'unavailable';

export type AutoReviewVerdict =
  | { kind: 'allow' }
  | { kind: 'block'; reason: string }
  | { kind: 'failed'; failure: AutoReviewFailure; detail?: string };

/** Claude Code's auto-mode limits: past either, a blocked call goes to the user instead. */
export const AUTO_REVIEW_MAX_CONSECUTIVE_DENIALS = 3;
export const AUTO_REVIEW_MAX_TOTAL_DENIALS = 20;

/**
 * A failed review call whose text is the service refusing the request rather
 * than failing to answer it. pi-ai keeps no code for these, only the text:
 * Anthropic's `refusal` stop (its explanation, or pi-ai's own sentence when it
 * has none), a `sensitive` stop, and OpenAI's `content_filter`.
 */
export function isReviewRefusal(message: string): boolean {
  return /refused to complete the request|\bviolates?\b.*\b(terms|polic(y|ies))\b|\bterms of service\b|stopped with: sensitive|\bcontent_filter\b/i.test(
    message
  );
}
