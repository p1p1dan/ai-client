/**
 * T-18 image pixel bounds read from the file header — pure, no bitmap decode.
 *
 * The 8000x8000 API cap has to be enforced BEFORE a bitmap exists. A 12000px
 * flat-colour PNG compresses to far under the byte budget, so learning its size
 * via createImageBitmap() would allocate ~576 MB of RGBA in the renderer just to
 * reject it — the guard would crash on exactly the input it exists to block.
 * Parsing the header costs a few dozen bytes of the ArrayBuffer we already read,
 * and being pure it is also the only version of this check that vitest (node
 * environment, no createImageBitmap) can cover.
 *
 * Only the four API-supported formats are parsed; anything else returns null and
 * the caller then skips the pixel check (detectAttachmentKind has already
 * rejected every other image type, so that path is unreachable in practice).
 *
 * §12 verification first: __tests__/imageDimensions.test.ts.
 */

export interface ImageDimensions {
  width: number;
  height: number;
}

function u16be(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function u32be(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] * 0x1000000 +
    ((bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3])
  );
}

function u16le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function u24le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function u32le(bytes: Uint8Array, offset: number): number {
  return u24le(bytes, offset) + bytes[offset + 3] * 0x1000000;
}

function matchesAscii(bytes: Uint8Array, offset: number, ascii: string): boolean {
  if (offset + ascii.length > bytes.length) return false;
  for (let i = 0; i < ascii.length; i += 1) {
    if (bytes[offset + i] !== ascii.charCodeAt(i)) return false;
  }
  return true;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** PNG: 8-byte signature, then the IHDR chunk carries width/height as BE u32. */
function readPng(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 24) return null;
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return null;
  }
  if (!matchesAscii(bytes, 12, 'IHDR')) return null;
  return { width: u32be(bytes, 16), height: u32be(bytes, 20) };
}

/** GIF: the logical screen descriptor sits right behind the 6-byte header. */
function readGif(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 10) return null;
  if (!matchesAscii(bytes, 0, 'GIF87a') && !matchesAscii(bytes, 0, 'GIF89a')) return null;
  return { width: u16le(bytes, 6), height: u16le(bytes, 8) };
}

/** WebP: RIFF container with three possible payload chunks. */
function readWebp(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 16) return null;
  if (!matchesAscii(bytes, 0, 'RIFF') || !matchesAscii(bytes, 8, 'WEBP')) return null;

  // Extended format: the canvas size lives in the VP8X chunk as (value - 1).
  if (matchesAscii(bytes, 12, 'VP8X') && bytes.length >= 30) {
    return { width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1 };
  }
  // Lossless: signature byte 0x2f, then 14 bits of (width-1) and (height-1).
  if (matchesAscii(bytes, 12, 'VP8L') && bytes.length >= 25 && bytes[20] === 0x2f) {
    const packed = u32le(bytes, 21);
    return { width: (packed & 0x3fff) + 1, height: ((packed >>> 14) & 0x3fff) + 1 };
  }
  // Lossy key frame: 3-byte frame tag, the 0x9d 0x01 0x2a sync code, then the
  // 14-bit dimensions (the top two bits are the upscaling hint, not size).
  if (matchesAscii(bytes, 12, 'VP8 ') && bytes.length >= 30) {
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    return { width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff };
  }
  return null;
}

/** Start-of-frame markers; 0xc4 / 0xc8 / 0xcc are tables, not frames. */
const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

/**
 * JPEG: walk the marker segments to the first SOFn, which holds height then
 * width. The walk is bounded — a byte that is not 0xff where a marker must be
 * means the stream is malformed, so we give up rather than rescan.
 */
function readJpeg(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    // Fill byte before the real marker.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    // Standalone markers carry no length field.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    // Start of scan / end of image: no SOF ahead of us any more.
    if (marker === 0xda || marker === 0xd9) return null;
    const length = u16be(bytes, offset + 2);
    if (length < 2) return null;
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (offset + 9 > bytes.length) return null;
      return { height: u16be(bytes, offset + 5), width: u16be(bytes, offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

/**
 * Pixel bounds of a PNG / JPEG / GIF / WebP buffer, or null when the header is
 * unrecognised or truncated. Never throws: a malformed paste must degrade to
 * "size unknown", not take the paste handler down.
 */
export function readImageDimensions(bytes: Uint8Array): ImageDimensions | null {
  const size = readPng(bytes) ?? readGif(bytes) ?? readWebp(bytes) ?? readJpeg(bytes);
  if (!size) return null;
  if (!Number.isFinite(size.width) || !Number.isFinite(size.height)) return null;
  if (size.width <= 0 || size.height <= 0) return null;
  return size;
}
