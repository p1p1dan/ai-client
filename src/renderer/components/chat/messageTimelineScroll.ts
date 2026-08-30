/**
 * Stick-to-bottom scroll following for the message timeline. Kept as a pure
 * decision function (mirrors `middleColumnLayout.ts`'s role for the
 * composer) so the "should we auto-follow" threshold judgement is
 * unit-testable without mounting `MessageTimeline` or faking a real
 * scrollable DOM node.
 */

/** Distance (px) from the bottom within which new content should keep following. */
export const STICK_TO_BOTTOM_THRESHOLD_PX = 40;

/**
 * Whether the timeline should auto-scroll to follow new content, given the
 * scroll viewport's current geometry. `scrollHeight - clientHeight -
 * scrollTop` is the distance from the bottom edge; content that already fits
 * without overflow (`scrollHeight <= clientHeight`) yields a non-positive
 * distance, which always counts as "at the bottom".
 */
export function shouldStickToBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  threshold: number = STICK_TO_BOTTOM_THRESHOLD_PX
): boolean {
  const distanceFromBottom = scrollHeight - clientHeight - scrollTop;
  return distanceFromBottom <= threshold;
}

/**
 * Distance (px) below which the jump-to-bottom button has nothing to offer.
 *
 * Deliberately WIDER than `STICK_TO_BOTTOM_THRESHOLD_PX`, and the two answer
 * different questions. 40px asks "is the user still following?", and it has to
 * be tight or a deliberate nudge upward keeps getting overridden by
 * auto-scroll. This one asks "is there enough hidden below to be worth a
 * button?", and a tight answer to THAT paints a button for a 41px scroll —
 * an affordance that blinks in and out while reading is worse than none.
 * 140px is the reference implementation's measured choice
 * (`TIMELINE_NEAR_BOTTOM_PX`) for the same judgement.
 *
 * The gap between the two is a real dead band: between 40 and 140px from the
 * bottom the timeline no longer follows and no button is offered. It closes
 * itself — content growing below is what widens the distance — and it is the
 * price of not making either threshold lie about what it measures.
 */
export const JUMP_TO_BOTTOM_THRESHOLD_PX = 140;

/**
 * Whether to offer the jump-to-bottom button, from viewport geometry alone.
 *
 * Geometry, NOT the follow flag: `nextFollowState` can report "not following"
 * while the viewport sits at the very bottom (rule 2 — a height-change frame
 * carries no evidence of intent, so the previous flag is kept). Binding the
 * button to that flag would draw "jump to bottom" while the user is already
 * looking at the bottom.
 */
export function shouldShowJumpToBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  threshold: number = JUMP_TO_BOTTOM_THRESHOLD_PX
): boolean {
  return scrollHeight - clientHeight - scrollTop > threshold;
}

export interface FollowStateInput {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  /** The scrollHeight recorded on the previous scroll/resize tick. */
  prevScrollHeight: number;
  /** The current follow flag. */
  following: boolean;
}

/**
 * One step of the follow state machine (F10-b, 2026-08-18 inspection).
 *
 * A browser-initiated scroll event is indistinguishable from a user's inside
 * the handler, and one flavor of it is hostile: when content ABOVE the
 * viewport bottom shrinks (a collapsing row, a clamped bubble), the browser
 * clamps `scrollTop` to the new maximum — landing exactly at the bottom —
 * and fires `scroll`. Arming the follower from that event welds the viewport
 * to the bottom of a document the user never chose to follow, which is the
 * amplifier half of the F10 oscillation.
 *
 * Rules, in order:
 *  1. Away from the bottom → never following (disarm is always safe: a
 *     clamp-induced event lands AT the bottom, so it can never disarm).
 *  2. At the bottom but `scrollHeight` changed this tick → keep the previous
 *     flag; a height-change frame carries no evidence of user intent.
 *  3. At the bottom with stable height → a genuine user arrival: arm.
 *
 * Idempotent by construction: feeding a result back in with the same
 * geometry returns the same result, so no alternating sequence is
 * representable — the property `messageTimelineScroll.test.ts` pins.
 */
export function nextFollowState(
  input: FollowStateInput,
  threshold: number = STICK_TO_BOTTOM_THRESHOLD_PX
): boolean {
  const atBottom = shouldStickToBottom(
    input.scrollTop,
    input.scrollHeight,
    input.clientHeight,
    threshold
  );
  if (!atBottom) return false;
  if (input.scrollHeight !== input.prevScrollHeight) return input.following;
  return true;
}
