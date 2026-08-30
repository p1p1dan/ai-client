import { describe, expect, it } from 'vitest';
import {
  JUMP_TO_BOTTOM_THRESHOLD_PX,
  nextFollowState,
  STICK_TO_BOTTOM_THRESHOLD_PX,
  shouldShowJumpToBottom,
  shouldStickToBottom,
} from '../messageTimelineScroll';

describe('shouldStickToBottom', () => {
  it('follows when the viewport is exactly at the bottom', () => {
    expect(shouldStickToBottom(500, 1000, 500)).toBe(true);
  });

  it('follows when within the default threshold of the bottom', () => {
    expect(shouldStickToBottom(470, 1000, 500)).toBe(true); // 30px from bottom
  });

  it('stops following once scrolled further than the default threshold from the bottom', () => {
    expect(shouldStickToBottom(100, 1000, 500)).toBe(false); // 400px from bottom
  });

  it('treats content that fits without overflow as always at the bottom', () => {
    expect(shouldStickToBottom(0, 300, 500)).toBe(true);
  });

  it('honors a custom threshold', () => {
    expect(shouldStickToBottom(900, 1000, 50, 10)).toBe(false); // distance 50 > 10
    expect(shouldStickToBottom(945, 1000, 50, 10)).toBe(true); // distance 5 <= 10
  });
});

describe('nextFollowState (F10-b — the follower step function)', () => {
  // The regression the original truth table could not represent: content
  // ABOVE the viewport bottom shrinks (a clamping bubble, a collapsing row),
  // the browser clamps scrollTop to the new maximum — landing exactly at the
  // bottom — and fires `scroll`. That event must NOT arm a follower the user
  // had disarmed.
  it('a shrink-clamp landing at the bottom cannot re-arm a disarmed follower', () => {
    expect(
      nextFollowState({
        scrollTop: 500, // clamped to the new max: 1000 - 500
        scrollHeight: 1000, // was 1400 last tick — shrank by 400
        clientHeight: 500,
        prevScrollHeight: 1400,
        following: false,
      })
    ).toBe(false);
  });

  it('a growth frame keeps the follower armed for the streaming case', () => {
    expect(
      nextFollowState({
        scrollTop: 700,
        scrollHeight: 1240, // grew from 1200 as tokens streamed in
        clientHeight: 500,
        prevScrollHeight: 1200,
        following: true,
      })
    ).toBe(true);
  });

  it('arriving at the bottom with stable height is user intent: arm', () => {
    expect(
      nextFollowState({
        scrollTop: 500,
        scrollHeight: 1000,
        clientHeight: 500,
        prevScrollHeight: 1000,
        following: false,
      })
    ).toBe(true);
  });

  it('away from the bottom always disarms, height change or not', () => {
    for (const prevScrollHeight of [1000, 1400]) {
      expect(
        nextFollowState({
          scrollTop: 100,
          scrollHeight: 1000,
          clientHeight: 500,
          prevScrollHeight,
          following: true,
        })
      ).toBe(false);
    }
  });

  // Idempotence: feeding a result back in with the same geometry returns the
  // same result, so no alternating (oscillating) sequence is representable.
  it('is idempotent over its own output for any input', () => {
    const geometries = [
      { scrollTop: 500, scrollHeight: 1000, clientHeight: 500, prevScrollHeight: 1000 },
      { scrollTop: 500, scrollHeight: 1000, clientHeight: 500, prevScrollHeight: 1400 },
      { scrollTop: 100, scrollHeight: 1000, clientHeight: 500, prevScrollHeight: 1000 },
      { scrollTop: 0, scrollHeight: 300, clientHeight: 500, prevScrollHeight: 700 },
    ];
    for (const geometry of geometries) {
      for (const following of [true, false]) {
        const once = nextFollowState({ ...geometry, following });
        const twice = nextFollowState({ ...geometry, following: once });
        expect(twice).toBe(once);
      }
    }
  });
});

describe('shouldShowJumpToBottom (T12-d — the bottom anchor)', () => {
  it('offers nothing while the viewport is at the bottom', () => {
    expect(shouldShowJumpToBottom(500, 1000, 500)).toBe(false);
  });

  it('offers nothing for content that fits without overflow', () => {
    // Distance is negative here; a button would be pure noise on a short
    // transcript that has no "below" at all.
    expect(shouldShowJumpToBottom(0, 300, 500)).toBe(false);
  });

  it('appears once the user is far enough up to have lost the live end', () => {
    expect(shouldShowJumpToBottom(0, 1000, 500)).toBe(true); // 500px up
  });

  /**
   * The band between the two thresholds is real and deliberate: the follower
   * disarms at 40px so a nudge is respected immediately, while the button
   * waits for 140px so it does not blink into existence on that same nudge.
   * Asserting the band keeps a future "simplification" from collapsing the two
   * constants into one and quietly changing whichever behaviour it did not
   * mean to.
   */
  it('stays silent inside the dead band above the follow threshold', () => {
    const insideBand = 1000 - 500 - 100; // scrollTop leaving 100px below
    expect(shouldStickToBottom(insideBand, 1000, 500)).toBe(false); // no longer following
    expect(shouldShowJumpToBottom(insideBand, 1000, 500)).toBe(false); // but not yet worth a button
    expect(JUMP_TO_BOTTOM_THRESHOLD_PX).toBeGreaterThan(STICK_TO_BOTTOM_THRESHOLD_PX);
  });

  it('is a strict threshold — exactly at the limit is still not worth a button', () => {
    expect(shouldShowJumpToBottom(1000 - 500 - 140, 1000, 500)).toBe(false);
    expect(shouldShowJumpToBottom(1000 - 500 - 141, 1000, 500)).toBe(true);
  });

  it('honors a custom threshold', () => {
    expect(shouldShowJumpToBottom(0, 1000, 500, 600)).toBe(false); // distance 500 <= 600
    expect(shouldShowJumpToBottom(0, 1000, 500, 400)).toBe(true); // distance 500 > 400
  });
});
