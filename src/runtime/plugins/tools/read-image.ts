import { extname } from 'node:path';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import { readImageDimensions } from '../../../shared/utils/imageDimensions.ts';
import type { RuntimeHostIoService } from '../../contracts.ts';
import { RuntimeHostError } from '../../host/errors.ts';
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_TURN_STORED_BYTES } from '../agent-loop/attachments.ts';

/**
 * `read` for image files: what the user can paste, the agent can read.
 *
 * The ceilings are the pasted-attachment ones: `ATTACHMENT_MAX_BYTES` raw bytes
 * per image and `ATTACHMENT_TURN_STORED_BYTES` of base64 per run (imported, not
 * re-picked), because every image a run reads is written into the session file
 * as base64 exactly like an attachment; plus the paste guard's pixel edge.
 *
 * Magic bytes decide, never the name: a `.png` holding text reads as text, and
 * an extensionless PNG reads as an image. The extension only picks which side
 * is tried first, so a text read never pays for a header sniff (and on an
 * encrypted box, for another TSD helper process).
 */

/** Extensions that try the image branch first. */
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
/** Header window a sniff reads: enough for the APNG check to reach IDAT. */
const IMAGE_SNIFF_BYTES = 4096;
/**
 * The provider's per-side pixel ceiling, the renderer's `MAX_IMAGE_EDGE_PX`
 * (`attachmentLimits.ts`) for pasted images. A tool result over it is a 400 on
 * every later request of the session, not just the next one.
 */
const IMAGE_MAX_EDGE_PX = 8000;

export type ImageMimeType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

/** Image bytes (base64) the current run has already put into its tool results. */
export interface ImageReadBudget {
  used: number;
}

export interface ImageReadDetails {
  path: string;
  bytes: number;
  mimeType: ImageMimeType;
  image: true;
}

export function hasImageExtension(path: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(path).toLowerCase());
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * The provider-supported format these bytes start with, or undefined.
 *
 * Mirrors pi-coding-agent's `utils/mime.js` minus BMP, which no provider takes:
 * JPEG-LS (`ff d8 ff f7`) and animated PNG are refused like pi refuses them.
 */
export function detectImageMimeType(bytes: Uint8Array): ImageMimeType | undefined {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return bytes[3] === 0xf7 ? undefined : 'image/jpeg';
  if (startsWith(bytes, PNG_SIGNATURE))
    return bytes.length >= 16 &&
      u32be(bytes, 8) === 13 &&
      ascii(bytes, 12, 'IHDR') &&
      !animatedPng(bytes)
      ? 'image/png'
      : undefined;
  if (ascii(bytes, 0, 'GIF87a') || ascii(bytes, 0, 'GIF89a')) return 'image/gif';
  if (ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP')) return 'image/webp';
  return undefined;
}

/**
 * Read `path` as an image, or return undefined when its bytes are not one.
 *
 * Both ceilings are checked against `size` (from `stat`) BEFORE the body is
 * read: an image that cannot be accepted costs a header read at most, never
 * 5 MiB of IO or a helper decrypting it. `header` is a sniff the caller already
 * has, so the refusal path does not read it twice.
 */
export async function readImage(
  io: RuntimeHostIoService,
  path: string,
  size: number,
  budget: ImageReadBudget,
  signal?: AbortSignal,
  header?: Uint8Array
): Promise<AgentToolResult<ImageReadDetails> | undefined> {
  const overCap = size > ATTACHMENT_MAX_BYTES;
  if (overCap || budget.used + base64Length(size) > ATTACHMENT_TURN_STORED_BYTES) {
    // Only whether this IS an image is still open, and the header answers it.
    const mimeType = detectImageMimeType(header ?? (await readHeader(io, path, signal)));
    if (!mimeType) return undefined;
    if (overCap)
      throw new RuntimeHostError(
        'io_limit',
        `${path} is a ${mimeType} image of ${formatBytes(size)} (${size} bytes); read accepts images up to ${formatBytes(ATTACHMENT_MAX_BYTES)} (${ATTACHMENT_MAX_BYTES} bytes), the same limit as a pasted attachment`
      );
    throw budgetSpent(path, base64Length(size), budget);
  }
  const body = await io.readFile(path, {
    maxBytes: ATTACHMENT_MAX_BYTES,
    overflow: 'error',
    signal,
  });
  const mimeType = detectImageMimeType(body.bytes);
  if (!mimeType) return undefined;
  const dimensions = readImageDimensions(body.bytes);
  if (dimensions && Math.max(dimensions.width, dimensions.height) > IMAGE_MAX_EDGE_PX)
    throw new RuntimeHostError(
      'io_limit',
      `${path} is a ${dimensions.width}x${dimensions.height} ${mimeType} image; read accepts images up to ${IMAGE_MAX_EDGE_PX} pixels on a side, the same limit as a pasted image`
    );
  const data = Buffer.from(
    body.bytes.buffer,
    body.bytes.byteOffset,
    body.bytes.byteLength
  ).toString('base64');
  // Charged on what was read, and checked again here: the file may have grown
  // since `stat`, and a parallel call may have spent the budget meanwhile.
  // Nothing awaits between this check and the charge.
  if (budget.used + data.length > ATTACHMENT_TURN_STORED_BYTES)
    throw budgetSpent(path, data.length, budget);
  budget.used += data.length;
  return {
    content: [
      {
        type: 'text',
        text: `Read image file [${mimeType}] ${formatBytes(body.bytes.length)}${
          dimensions ? ` ${dimensions.width}x${dimensions.height}` : ''
        }`,
      },
      { type: 'image', data, mimeType },
    ],
    details: { path, bytes: body.bytes.length, mimeType, image: true },
  };
}

/**
 * The text read hit bytes that are not UTF-8: a bounded header read decides
 * whether the file is an image after all. Throws the unsupported-file error
 * when it is not.
 */
export async function readBinaryAsImage(
  io: RuntimeHostIoService,
  path: string,
  size: number,
  budget: ImageReadBudget,
  signal?: AbortSignal
): Promise<AgentToolResult<ImageReadDetails>> {
  const header = await readHeader(io, path, signal);
  const image = detectImageMimeType(header)
    ? await readImage(io, path, size, budget, signal, header)
    : undefined;
  if (!image) throw unsupportedFile(path);
  return image;
}

/**
 * Same code as the plain text failure (tools-12), so callers keying on it keep
 * working; the message now names what read does accept.
 */
export function unsupportedFile(path: string): RuntimeHostError {
  return new RuntimeHostError(
    'io_not_utf8',
    `${path} is neither UTF-8 text nor a PNG, JPEG, GIF or WebP image, which are the only files read supports; it is probably a binary file or text in another encoding`
  );
}

async function readHeader(
  io: RuntimeHostIoService,
  path: string,
  signal?: AbortSignal
): Promise<Uint8Array> {
  return (await io.readFile(path, { maxBytes: IMAGE_SNIFF_BYTES, overflow: 'truncate', signal }))
    .bytes;
}

function budgetSpent(path: string, adding: number, budget: ImageReadBudget): RuntimeHostError {
  return new RuntimeHostError(
    'io_limit',
    `${path} not read: images already read in this run take ${formatBytes(budget.used)} of the ${formatBytes(ATTACHMENT_TURN_STORED_BYTES)} per-run image budget (the same budget as one message's attachments), and this one would add ${formatBytes(adding)}; no more images can be read until the next user message`
  );
}

/** Stored size of `size` raw bytes once base64-encoded. */
function base64Length(size: number): number {
  return 4 * Math.ceil(size / 3);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return bytes.length >= prefix.length && prefix.every((byte, index) => bytes[index] === byte);
}

function ascii(bytes: Uint8Array, offset: number, text: string): boolean {
  if (bytes.length < offset + text.length) return false;
  for (let index = 0; index < text.length; index++)
    if (bytes[offset + index] !== text.charCodeAt(index)) return false;
  return true;
}

function u32be(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] * 0x1000000 +
    ((bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3])
  );
}

/** An `acTL` chunk before the first `IDAT` marks an APNG. */
function animatedPng(bytes: Uint8Array): boolean {
  let offset = PNG_SIGNATURE.length;
  while (offset + 8 <= bytes.length) {
    if (ascii(bytes, offset + 4, 'acTL')) return true;
    if (ascii(bytes, offset + 4, 'IDAT')) return false;
    const next = offset + 12 + u32be(bytes, offset);
    if (next <= offset || next > bytes.length) return false;
    offset = next;
  }
  return false;
}
