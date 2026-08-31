export const MAX_IMAGE_PIXELS = 40_000_000;
export const MAX_PDF_CANVAS_PIXELS = 16_000_000;

export function imageDimensionsAllowed(
  width: number,
  height: number,
  maxPixels = MAX_IMAGE_PIXELS
): boolean {
  return (
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width > 0 &&
    height > 0 &&
    width * height <= maxPixels
  );
}

/** Lower scale only when the requested PDF backing canvas exceeds its budget. */
export function clampPdfScale(
  widthAtScaleOne: number,
  heightAtScaleOne: number,
  requestedScale: number,
  maxPixels = MAX_PDF_CANVAS_PIXELS
): number {
  if (
    !Number.isFinite(widthAtScaleOne) ||
    !Number.isFinite(heightAtScaleOne) ||
    !Number.isFinite(requestedScale) ||
    widthAtScaleOne <= 0 ||
    heightAtScaleOne <= 0 ||
    requestedScale <= 0
  ) {
    return 0.1;
  }
  const pixels = widthAtScaleOne * heightAtScaleOne * requestedScale * requestedScale;
  if (pixels <= maxPixels) return requestedScale;
  return Math.max(0.1, Math.sqrt(maxPixels / (widthAtScaleOne * heightAtScaleOne)));
}
