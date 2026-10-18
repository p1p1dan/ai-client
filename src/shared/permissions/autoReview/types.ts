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
