import { crc32, inflateRawSync } from 'node:zlib';

/**
 * Just enough zip to unpack a `.pilabplug` (PI-Desktop ADR 0007): stored and
 * deflated entries, no encryption, no zip64, no multi-disk. Every entry name is
 * checked before anything is written (no absolute paths, no `..`, no drive
 * letters), and sizes are capped so a small file cannot unpack into a huge one.
 */

export interface ZipLimits {
  maxEntries: number;
  maxTotalBytes: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 5000,
  maxTotalBytes: 200 * 1024 * 1024,
};

export interface ZipFileEntry {
  /** Relative, forward slashes, checked. */
  path: string;
  data: Buffer;
}

export class ZipError extends Error {
  constructor(message: string) {
    super(`plugin_package_invalid: ${message}`);
    this.name = 'ZipError';
  }
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN = 22;
const ZIP64_MARKER = 0xffffffff;

/** A safe relative path, or `undefined` for a name that must not be written. */
export function safeEntryPath(name: string): string | undefined {
  if (!name || name.includes('\\') || name.includes('\0')) return undefined;
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return undefined;
  const segments = name.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.length === 0 || segments.includes('..')) return undefined;
  return segments.join('/');
}

function findEndOfCentralDirectory(zip: Buffer): number {
  const lowest = Math.max(0, zip.length - EOCD_MIN - 0xffff);
  for (let offset = zip.length - EOCD_MIN; offset >= lowest; offset -= 1) {
    if (zip.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw new ZipError('not a zip archive');
}

/** Every file in `zip` (directories are implied by paths and skipped). */
export function readZip(zip: Buffer, limits: ZipLimits = DEFAULT_ZIP_LIMITS): ZipFileEntry[] {
  if (zip.length < EOCD_MIN) throw new ZipError('not a zip archive');
  const eocd = findEndOfCentralDirectory(zip);
  const count = zip.readUInt16LE(eocd + 10);
  const centralSize = zip.readUInt32LE(eocd + 12);
  const centralOffset = zip.readUInt32LE(eocd + 16);
  if (centralOffset === ZIP64_MARKER || count === 0xffff)
    throw new ZipError('zip64 is not supported');
  if (count > limits.maxEntries) throw new ZipError(`more than ${limits.maxEntries} entries`);
  if (centralOffset + centralSize > eocd) throw new ZipError('central directory out of range');

  const files: ZipFileEntry[] = [];
  const seen = new Set<string>();
  let total = 0;
  let cursor = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > zip.length || zip.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new ZipError('corrupt central directory');
    }
    const flags = zip.readUInt16LE(cursor + 8);
    const method = zip.readUInt16LE(cursor + 10);
    const crc = zip.readUInt32LE(cursor + 16);
    const compressedSize = zip.readUInt32LE(cursor + 20);
    const size = zip.readUInt32LE(cursor + 24);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    const localOffset = zip.readUInt32LE(cursor + 42);
    const name = zip.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    cursor += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith('/')) continue;
    const path = safeEntryPath(name);
    if (!path) throw new ZipError(`unsafe entry name: ${name}`);
    if (seen.has(path)) throw new ZipError(`duplicate entry: ${path}`);
    seen.add(path);
    if (flags & 0x1) throw new ZipError(`encrypted entry: ${path}`);
    if (compressedSize === ZIP64_MARKER || size === ZIP64_MARKER || localOffset === ZIP64_MARKER) {
      throw new ZipError('zip64 is not supported');
    }
    total += size;
    if (total > limits.maxTotalBytes) {
      throw new ZipError(`unpacks to more than ${limits.maxTotalBytes} bytes`);
    }

    if (localOffset + 30 > zip.length || zip.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      throw new ZipError(`corrupt local header: ${path}`);
    }
    const dataStart =
      localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
    const raw = zip.subarray(dataStart, dataStart + compressedSize);
    if (raw.length !== compressedSize) throw new ZipError(`truncated entry: ${path}`);

    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) {
      try {
        data = inflateRawSync(raw, { maxOutputLength: Math.max(size, 1) });
      } catch {
        throw new ZipError(`entry does not inflate to its declared size: ${path}`);
      }
    } else throw new ZipError(`unsupported compression ${method}: ${path}`);
    if (data.length !== size) throw new ZipError(`size mismatch: ${path}`);
    if (crc32(data) !== crc) throw new ZipError(`checksum mismatch: ${path}`);
    files.push({ path, data });
  }
  return files;
}
