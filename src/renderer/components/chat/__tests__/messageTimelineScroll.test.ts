import { describe, expect, it } from 'vitest';
import { nextFollowState, shouldStickToBottom } from '../messageTimelineScroll';

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
