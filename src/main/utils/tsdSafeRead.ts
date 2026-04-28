import { execFile } from 'node:child_process';
import { open, readFile, stat } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// TEC Solutions OCular Agent (TSD) encrypts files written by Node.js processes.
// The packaged Electron exe is not in TEC's whitelist, so it reads raw encrypted bytes.
// Detect the TSD header and fall back to spawning system node.exe (which IS whitelisted)
// to obtain decrypted bytes.
const TSD_MAGIC = Buffer.from('%TSD-Header-###%');

export function isTsdEncrypted(head: Buffer): boolean {
  if (head.length < TSD_MAGIC.length) return false;
  return head.compare(TSD_MAGIC, 0, TSD_MAGIC.length, 0, TSD_MAGIC.length) === 0;
}

async function peekHeader(filePath: string): Promise<Buffer> {
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(TSD_MAGIC.length);
    const { bytesRead } = await handle.read(buffer, 0, TSD_MAGIC.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function readViaNodeExe(filePath: string): Promise<Buffer> {
  const script = "process.stdout.write(require('fs').readFileSync(process.argv[1]))";
  const { stdout } = await execFileAsync('node', ['-e', script, '--', filePath], {
    encoding: 'buffer',
    maxBuffer: 200 * 1024 * 1024,
  });
  return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout as unknown as Uint8Array);
}

/**
 * Read a file, transparently decrypting TSD-encrypted content on Windows
 * machines running TEC OCular Agent.
 */
export async function readFileTsdSafe(filePath: string): Promise<Buffer> {
  const head = await peekHeader(filePath);
  if (isTsdEncrypted(head)) {
    return readViaNodeExe(filePath);
  }
  return readFile(filePath);
}

/**
 * Returns true if the given file appears to be TSD-encrypted.
 * Used by streaming readers that want to switch to a buffered fallback.
 */
export async function isFileTsdEncrypted(filePath: string): Promise<boolean> {
  try {
    const head = await peekHeader(filePath);
    return isTsdEncrypted(head);
  } catch {
    return false;
  }
}

// Buffered TSD reads load the whole file into memory via a spawned node.exe;
// guard against pathologically large session JSONL files OOMing the main
// process. 32 MB holds thousands of messages — beyond that we degrade.
export const TSD_BUFFERED_READ_LIMIT = 32 * 1024 * 1024;

export class TsdFileTooLargeError extends Error {
  constructor(
    public readonly filePath: string,
    public readonly size: number,
    public readonly limit: number
  ) {
    super(
      `TSD-encrypted file exceeds buffered-read limit: ${filePath} ` +
        `(${size} bytes > ${limit} bytes)`
    );
    this.name = 'TsdFileTooLargeError';
  }
}

/**
 * Like {@link readFileTsdSafe} but rejects with {@link TsdFileTooLargeError}
 * when the file exceeds `maxBytes`. Use this for unbounded inputs (e.g.
 * user-generated session logs) where loading the whole file is unsafe.
 */
export async function readFileTsdSafeBounded(
  filePath: string,
  maxBytes: number = TSD_BUFFERED_READ_LIMIT
): Promise<Buffer> {
  const info = await stat(filePath);
  if (info.size > maxBytes) {
    throw new TsdFileTooLargeError(filePath, info.size, maxBytes);
  }
  return readFileTsdSafe(filePath);
}
