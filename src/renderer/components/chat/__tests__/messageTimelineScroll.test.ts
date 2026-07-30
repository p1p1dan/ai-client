import { describe, expect, it } from 'vitest';
import { shouldStickToBottom } from '../messageTimelineScroll';

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
