import { describe, expect, it } from 'vitest';
import { MAX_IMAGE_EDGE_PX, planImageAttachment } from '../attachmentLimits';
import { readImageDimensions } from '../imageDimensions';

function ascii(text: string): number[] {
  return [...text].map((ch) => ch.charCodeAt(0));
}

function u32be(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function u16be(value: number): number[] {
  return [(value >>> 8) & 0xff, value & 0xff];
}

function u16le(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff];
}

function u24le(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff];
}

function png(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...u32be(13),
    ...ascii('IHDR'),
    ...u32be(width),
    ...u32be(height),
    8, // bit depth
    6, // colour type
    0,
    0,
    0,
  ]);
}

function gif(width: number, height: number): Uint8Array {
  return new Uint8Array([...ascii('GIF89a'), ...u16le(width), ...u16le(height), 0x00, 0x00]);
}

/** SOI, an APP0 segment, then SOF0 carrying height before width. */
function jpeg(width: number, height: number, marker = 0xc0): Uint8Array {
  return new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xe0,
    ...u16be(16),
    ...ascii('JFIF'),
    0x00,
    1,
    1,
    0,
    0,
    1,
    0,
    1,
    0,
    0,
    0xff,
    marker,
    ...u16be(17),
    8,
    ...u16be(height),
    ...u16be(width),
    3,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
  ]);
}

function webpVp8x(width: number, height: number): Uint8Array {
  return new Uint8Array([
    ...ascii('RIFF'),
    ...u32be(0),
    ...ascii('WEBP'),
    ...ascii('VP8X'),
    ...u24le(10),
    0,
    0x10, // flags
    0,
    0,
    0, // reserved
    ...u24le(width - 1),
    ...u24le(height - 1),
  ]);
}

function webpVp8l(width: number, height: number): Uint8Array {
  const packed = (width - 1) | ((height - 1) << 14);
  return new Uint8Array([
    ...ascii('RIFF'),
    ...u32be(0),
    ...ascii('WEBP'),
    ...ascii('VP8L'),
    ...u24le(16),
    0,
    0x2f,
    packed & 0xff,
    (packed >>> 8) & 0xff,
    (packed >>> 16) & 0xff,
    (packed >>> 24) & 0xff,
  ]);
}

function webpVp8(width: number, height: number): Uint8Array {
  return new Uint8Array([
    ...ascii('RIFF'),
    ...u32be(0),
    ...ascii('WEBP'),
    ...ascii('VP8 '),
    ...u24le(20),
    0,
    // 3-byte frame tag (contents irrelevant to the size), then the sync code.
    0x00,
    0x00,
    0x00,
    0x9d,
    0x01,
    0x2a,
    ...u16le(width),
    ...u16le(height),
  ]);
}

describe('readImageDimensions (T-18 pixel cap without a decode)', () => {
  it('reads PNG IHDR', () => {
    expect(readImageDimensions(png(1920, 1080))).toEqual({ width: 1920, height: 1080 });
  });

  it('reads a PNG far above the API pixel cap without allocating it', () => {
    // The whole point: a 12000x12000 flat-colour PNG compresses to well under
    // the byte budget, so decoding it to learn its size would allocate ~576 MB.
    expect(readImageDimensions(png(12_000, 12_000))).toEqual({ width: 12_000, height: 12_000 });
  });

  it('reads GIF logical screen descriptor (little endian)', () => {
    expect(readImageDimensions(gif(640, 480))).toEqual({ width: 640, height: 480 });
  });

  it('reads JPEG SOF0 with height before width', () => {
    expect(readImageDimensions(jpeg(800, 600))).toEqual({ width: 800, height: 600 });
  });

  it('reads progressive JPEG (SOF2) too', () => {
    expect(readImageDimensions(jpeg(1024, 768, 0xc2))).toEqual({ width: 1024, height: 768 });
  });

  it('reads all three WebP chunk flavours', () => {
    expect(readImageDimensions(webpVp8x(3840, 2160))).toEqual({ width: 3840, height: 2160 });
    expect(readImageDimensions(webpVp8l(1280, 720))).toEqual({ width: 1280, height: 720 });
    expect(readImageDimensions(webpVp8(1600, 900))).toEqual({ width: 1600, height: 900 });
  });

  it('returns null instead of throwing on truncated or foreign buffers', () => {
    expect(readImageDimensions(new Uint8Array(0))).toBeNull();
    expect(readImageDimensions(png(10, 10).subarray(0, 12))).toBeNull();
    expect(readImageDimensions(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]))).toBeNull();
    expect(readImageDimensions(new TextEncoder().encode('# just markdown'))).toBeNull();
  });

  it('returns null for a JPEG whose scan starts before any SOF', () => {
    const truncated = new Uint8Array([0xff, 0xd8, 0xff, 0xda, ...u16be(12), 0, 0, 0, 0, 0, 0]);
    expect(readImageDimensions(truncated)).toBeNull();
  });

  it('rejects zero-sized headers rather than reporting a 0px image', () => {
    expect(readImageDimensions(png(0, 100))).toBeNull();
  });
});

describe('readImageDimensions feeds the 8000px API cap', () => {
  it('accepts a normal screenshot', () => {
    const size = readImageDimensions(png(2560, 1440));
    expect(
      planImageAttachment({ name: 'shot.png', mediaType: 'image/png', ...(size ?? {}) })
    ).toEqual({ action: 'as-is' });
  });

  it('rejects past the longer-edge cap with the measured numbers in the message', () => {
    const size = readImageDimensions(png(MAX_IMAGE_EDGE_PX + 1, 100));
    const plan = planImageAttachment({
      name: 'huge.png',
      mediaType: 'image/png',
      ...(size ?? {}),
    });
    expect(plan).toMatchObject({ action: 'reject', reason: 'oversized-pixels' });
  });

  it('skips the pixel check when the header is unreadable, rather than guessing', () => {
    const size = readImageDimensions(new Uint8Array([1, 2, 3]));
    expect(size).toBeNull();
    expect(
      planImageAttachment({ name: 'weird.png', mediaType: 'image/png', ...(size ?? {}) })
    ).toEqual({ action: 'as-is' });
  });
});
