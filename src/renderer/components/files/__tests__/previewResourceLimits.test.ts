import { describe, expect, it } from 'vitest';
import {
  clampPdfScale,
  imageDimensionsAllowed,
  MAX_IMAGE_PIXELS,
  MAX_PDF_CANVAS_PIXELS,
} from '../previewResourceLimits';

describe('preview resource limits', () => {
  it('accepts ordinary images and rejects invalid or oversized dimensions', () => {
    expect(imageDimensionsAllowed(1920, 1080)).toBe(true);
    expect(imageDimensionsAllowed(0, 1080)).toBe(false);
    expect(imageDimensionsAllowed(Number.NaN, 1080)).toBe(false);
    expect(imageDimensionsAllowed(MAX_IMAGE_PIXELS + 1, 1)).toBe(false);
  });

  it('keeps a PDF scale within the backing-canvas pixel budget', () => {
    expect(clampPdfScale(1000, 1000, 2)).toBe(2);
    const clamped = clampPdfScale(10_000, 10_000, 2);
    expect(10_000 * 10_000 * clamped * clamped).toBeLessThanOrEqual(MAX_PDF_CANVAS_PIXELS + 1);
    expect(clamped).toBeGreaterThanOrEqual(0.1);
  });

  it('falls back safely for invalid PDF dimensions or scale', () => {
    expect(clampPdfScale(0, 100, 1)).toBe(0.1);
    expect(clampPdfScale(100, 100, Number.NaN)).toBe(0.1);
  });
});
