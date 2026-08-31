import type { Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { open, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import {
  isTsdEncrypted,
  readFileTsdSafeBounded,
  TsdFileTooLargeError,
} from '../../utils/tsdSafeRead';

const { isBinaryFile } = createRequire(import.meta.url)('isbinaryfile') as {
  isBinaryFile: typeof import('isbinaryfile')['isBinaryFile'];
};

export const EDITOR_PREVIEW_MAX_BYTES = 8 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 512;

export type PreviewFileAdmission =
  | { kind: 'binary'; byteLength: number }
  | { kind: 'too-large'; byteLength: number; maxBytes: number }
  | { kind: 'text'; byteLength: number; buffer: Buffer };

export interface PreviewFileReadDependencies {
  statFile: (filePath: string) => Promise<Pick<Stats, 'size'>>;
  openFile: (filePath: string) => Promise<Pick<FileHandle, 'read' | 'close'>>;
  readBounded: (filePath: string, maxBytes: number) => Promise<Buffer>;
  detectBinary: (buffer: Buffer, size: number) => Promise<boolean>;
  detectTsd: (buffer: Buffer) => boolean;
}

const defaultDependencies: PreviewFileReadDependencies = {
  statFile: stat,
  openFile: (filePath) => open(filePath, 'r'),
  readBounded: readFileTsdSafeBounded,
  detectBinary: isBinaryFile,
  detectTsd: isTsdEncrypted,
};

async function readHead(
  filePath: string,
  dependencies: PreviewFileReadDependencies
): Promise<Buffer> {
  const handle = await dependencies.openFile(filePath);
  try {
    const buffer = Buffer.alloc(BINARY_SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Admit an editor preview without ever allocating an unbounded file buffer.
 * Binary media is classified from the first 512 bytes; text is capped before
 * the TSD-safe full read. A TSD header is handled before binary sniffing so an
 * encrypted source file is not mislabeled as unsupported binary content.
 */
export async function readPreviewFile(
  filePath: string,
  maxBytes = EDITOR_PREVIEW_MAX_BYTES,
  dependencies: PreviewFileReadDependencies = defaultDependencies
): Promise<PreviewFileAdmission> {
  const info = await dependencies.statFile(filePath);
  const head = await readHead(filePath, dependencies);

  if (!dependencies.detectTsd(head)) {
    const binary = await dependencies.detectBinary(head, info.size);
    if (binary) return { kind: 'binary', byteLength: info.size };
  }

  if (info.size > maxBytes) {
    return { kind: 'too-large', byteLength: info.size, maxBytes };
  }

  try {
    const buffer = await dependencies.readBounded(filePath, maxBytes);
    const binary = await dependencies.detectBinary(
      buffer.subarray(0, BINARY_SNIFF_BYTES),
      info.size
    );
    return binary
      ? { kind: 'binary', byteLength: info.size }
      : { kind: 'text', byteLength: info.size, buffer };
  } catch (error) {
    // Keep the concrete bounded-read error's metadata from being erased by a
    // generic read failure if a file grows between stat and read.
    if (error instanceof TsdFileTooLargeError) {
      return { kind: 'too-large', byteLength: error.size, maxBytes: error.limit };
    }
    throw error;
  }
}
