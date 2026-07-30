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
