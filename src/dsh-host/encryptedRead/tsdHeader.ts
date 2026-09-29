/**
 * The ciphertext marker check and the file-prefix read that feeds it
 * (dsh-rebase P1-13c; decision 091). Node built-ins only, so the unit tests
 * run on every platform against real files.
 */

import { open } from 'node:fs/promises';
import { HEADER_PREFIX_BYTES, TSD_HEADER } from './constants.ts';

/**
 * Whether a byte prefix starts with the policy's 16-byte ciphertext marker.
 * Only the leading bytes are compared — a marker-looking string elsewhere in
 * a file is content, not proof of encryption (P1-13b).
 */
export function isTsdHeader(prefix: Uint8Array): boolean {
  if (prefix.length < TSD_HEADER.length) return false;
  for (let index = 0; index < TSD_HEADER.length; index += 1) {
    if (prefix[index] !== TSD_HEADER[index]) return false;
  }
  return true;
}

/**
 * Read the file's first {@link HEADER_PREFIX_BYTES} bytes. Any failure — a
 * missing or unreadable file, a directory, an abort — returns `null` so the
 * caller delegates to the original method, which raises the canonical error;
 * the wrapper never invents errors of its own on this path. Short files
 * return fewer bytes, which `isTsdHeader` rejects.
 */
export async function readFilePrefix(
  path: string,
  signal?: AbortSignal
): Promise<Uint8Array | null> {
  if (signal?.aborted) return null;
  try {
    const handle = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(HEADER_PREFIX_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, HEADER_PREFIX_BYTES, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}
