/**
 * The encrypted-read fallback reader: one Windows PowerShell 5.1 process per
 * file, reading the bytes the disk-encryption policy only decrypts for that
 * reader (dsh-rebase P1-13c; decision 091).
 *
 * Hard rules, all enforced here:
 *   - the absolute `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`,
 *     never a PATH lookup, never pwsh 7;
 *   - `-NoProfile -NonInteractive`, the script passed only as an
 *     `-EncodedCommand` (UTF-16LE base64);
 *   - the file path travels in the `AICLIENT_FS_PATH` environment variable —
 *     never interpolated into the script, never through a shell;
 *   - `windowsHide: true`;
 *   - a timeout, the caller's abort signal and an output cap, any of which
 *     kills the child via `child.kill()` and fails the read — never a pid,
 *     never a process name;
 *   - at most `FALLBACK_MAX_CONCURRENCY` processes at once; further calls
 *     queue, and a call aborted while queued fails without ever spawning;
 *   - stdout is accepted only as the probed framing (`FRAME_BEGIN`, one
 *     base64 line, `FRAME_END`), so anything PowerShell mixes in fails the
 *     read instead of corrupting it;
 *   - plaintext lives in the pipe and in memory only — nothing is written to
 *     disk and nothing is cached.
 */

import { spawn } from 'node:child_process';
import {
  FALLBACK_MAX_CONCURRENCY,
  FALLBACK_MAX_STDOUT_BYTES,
  FALLBACK_PATH_ENV,
  FALLBACK_TIMEOUT_MS,
  FRAME_BEGIN,
  FRAME_END,
  POWERSHELL_ARGS,
  powershellExePath,
} from './constants.ts';
import type { FallbackReader } from './dshTypes.ts';

/** The probe-verified script: read all bytes, base64 them, frame them on stdout. */
const FALLBACK_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'try {',
  '  $p = $env:AICLIENT_FS_PATH',
  `  if ([string]::IsNullOrEmpty($p)) { throw '${FALLBACK_PATH_ENV} is not set' }`,
  '  $bytes = [System.IO.File]::ReadAllBytes($p)',
  '  $b64 = [Convert]::ToBase64String($bytes)',
  `  [Console]::Out.Write("${FRAME_BEGIN}\`n")`,
  '  [Console]::Out.Write($b64)',
  `  [Console]::Out.Write("\`n${FRAME_END}\`n")`,
  '  exit 0',
  '} catch {',
  '  [Console]::Error.Write($_.Exception.Message)',
  '  exit 1',
  '}',
].join('\r\n');

/** `-EncodedCommand` payload: UTF-16LE base64, as PowerShell 5.1 requires. */
const ENCODED_COMMAND = Buffer.from(FALLBACK_SCRIPT, 'utf16le').toString('base64');

/** Base64 alphabet plus padding; the payload must be exactly one such line. */
const BASE64_LINE = /^[A-Za-z0-9+/]*={0,2}$/;

/** stderr is diagnostics only; a tail is enough and keeps memory bounded. */
const MAX_STDERR_BYTES = 8192;

function abortError(): Error {
  const error = new Error('the fallback read was aborted');
  error.name = 'AbortError';
  return error;
}

/** FIFO counting gate: at most `max` holders at once, the rest queue. */
export function createGate(max: number) {
  let active = 0;
  const waiters: Array<() => void> = [];
  return {
    acquire(): Promise<void> {
      if (active < max) {
        active += 1;
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        waiters.push(() => {
          active += 1;
          resolve();
        });
      });
    },
    release(): void {
      active -= 1;
      const next = waiters.shift();
      next?.();
    },
  };
}

export interface PowerShellReaderOptions {
  /** Overrides the resolved powershell.exe path (tests only). */
  readonly exePath?: string;
  /** Environment to resolve `%SystemRoot%` from and to spawn with. */
  readonly env?: Record<string, string | undefined>;
  readonly timeoutMs?: number;
  readonly maxStdoutBytes?: number;
  readonly concurrency?: number;
}

/**
 * Parse framed stdout into plaintext bytes. Anything but the exact probed
 * shape — missing markers, a multi-line payload, non-base64 characters — is
 * an error, never best-effort decoding.
 */
export function parseFramedStdout(stdout: Buffer): Uint8Array {
  const text = stdout.toString('latin1');
  const head = `${FRAME_BEGIN}\n`;
  const tail = `\n${FRAME_END}\n`;
  if (!text.startsWith(head) || !text.endsWith(tail)) {
    throw new Error('the fallback output was not the expected framed base64');
  }
  const payload = text.slice(head.length, text.length - tail.length);
  if (payload.includes('\n') || payload.includes('\r') || !BASE64_LINE.test(payload)) {
    throw new Error('the fallback payload was not a single base64 line');
  }
  return Buffer.from(payload, 'base64');
}

/** Build the reader; the options exist for tests, the product takes the defaults. */
export function createPowerShellReader(options: PowerShellReaderOptions = {}): FallbackReader {
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? FALLBACK_TIMEOUT_MS;
  const maxStdoutBytes = options.maxStdoutBytes ?? FALLBACK_MAX_STDOUT_BYTES;
  const gate = createGate(options.concurrency ?? FALLBACK_MAX_CONCURRENCY);

  async function runOne(path: string, signal?: AbortSignal): Promise<Uint8Array> {
    const exe = options.exePath ?? powershellExePath(env);
    if (exe === null) throw new Error('SystemRoot is not set; cannot locate powershell.exe');
    if (signal?.aborted) throw abortError();

    return new Promise<Uint8Array>((resolve, reject) => {
      const child = spawn(exe, [...POWERSHELL_ARGS, '-EncodedCommand', ENCODED_COMMAND], {
        env: { ...env, [FALLBACK_PATH_ENV]: path },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const stdout: Buffer[] = [];
      let stdoutBytes = 0;
      const stderr: Buffer[] = [];
      let stderrBytes = 0;
      let settled = false;

      const settle = (error: Error | undefined, value?: Uint8Array): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (error !== undefined) {
          child.kill();
          reject(error);
        } else {
          resolve(value);
        }
      };

      const timer = setTimeout(() => {
        settle(new Error(`the fallback read timed out after ${timeoutMs} ms`));
      }, timeoutMs);

      const onAbort = (): void => {
        settle(abortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      child.on('error', (error) => {
        settle(new Error(`the fallback reader failed to start: ${error.message}`));
      });
      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > maxStdoutBytes) {
          settle(new Error(`the fallback output exceeded the ${maxStdoutBytes}-byte cap`));
          return;
        }
        stdout.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes <= MAX_STDERR_BYTES) stderr.push(chunk);
      });
      child.on('close', (code) => {
        if (code !== 0) {
          const detail = Buffer.concat(stderr).toString('utf8').trim();
          settle(
            new Error(
              `the fallback reader exited with code ${String(code)}${detail === '' ? '' : `: ${detail.slice(0, 200)}`}`
            )
          );
          return;
        }
        try {
          settle(undefined, parseFramedStdout(Buffer.concat(stdout, stdoutBytes)));
        } catch (error) {
          settle(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
  }

  return async (path, signal) => {
    if (signal?.aborted) throw abortError();
    const acquired = gate.acquire();
    try {
      await acquired;
    } catch (error) {
      // The gate never rejects, but a dangling acquire must not leak a slot.
      acquired.then(
        () => gate.release(),
        () => {}
      );
      throw error;
    }
    if (signal?.aborted) {
      gate.release();
      throw abortError();
    }
    try {
      return await runOne(path, signal);
    } finally {
      gate.release();
    }
  };
}
