import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { TSD_HEADER } from '../constants.ts';
import type { FsErrorView, FsReadService, FsTarget } from '../dshTypes.ts';
import { installEncryptedRead } from '../encryptedRead.ts';
import { createPowerShellReader } from '../powershellReader.ts';

/**
 * The encrypted-read fallback against the real Windows PowerShell 5.1
 * (dsh-rebase P1-13c; decision 091). These run only on win32 — the reader
 * under test is the product's, exactly as the row ships it.
 *
 * The fixtures are synthetic: a `%TSD-Header-###%` prefix over arbitrary
 * bytes. PowerShell reads such a file back verbatim, so a clean
 * "fallback returned ciphertext too" refusal is also the proof that the file
 * path — spaces, CJK, quotes-like punctuation, `$`, backticks, `&`, `;` —
 * reached the script intact through the environment variable and was never
 * interpreted as script text. A real `"` cannot appear in a Windows file
 * name at all (reserved character), which the filesystem itself enforces.
 */

class FakeFsError extends Error implements FsErrorView {
  readonly code: string;
  constructor(message: string, code: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}

const targetOf = (path: string): FsTarget => ({ targetKey: path, displayPath: path });

function makeService(): FsReadService {
  return {
    readText: async () => 'ORIGINAL-TEXT',
    streamText: async () =>
      (async function* () {
        yield 'ORIGINAL-STREAM';
      })(),
    readBytes: async () => new Uint8Array([1, 2, 3]),
    readByteRange: async () => new Uint8Array([9, 9]),
    editText: async () => ({ original: true }),
    // Read-only tests: neither is ever called, so a fixed shape is enough to
    // satisfy `FsReadService`.
    stat: async () => ({ version: 1, type: 'file', size: 0 }),
    writeText: async () => ({ operation: 'update', version: 1, before: null, after: '' }),
  };
}

/** A fake TSD file: the 16-byte marker plus arbitrary body bytes. */
function fakeCipherFile(
  dir: string,
  name: string,
  body: Uint8Array = new Uint8Array([7, 8, 9])
): string {
  const path = join(dir, name);
  writeFileSync(path, new Uint8Array([...TSD_HEADER, ...body]));
  return path;
}

describe.skipIf(process.platform !== 'win32')(
  'the real PowerShell 5.1 fallback (P1-13c, decision 091)',
  () => {
    let dir: string;
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'encrypted-read-win32-'));
    });
    afterAll(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('refuses a synthetic TSD file with the clear FS_ENCRYPTED error', async () => {
      const service = makeService();
      installEncryptedRead({
        service,
        reader: createPowerShellReader(),
        platform: 'win32',
        createError: FakeFsError,
      });
      const cipher = targetOf(fakeCipherFile(dir, 'fake-tsd.yml'));
      await expect(service.readText(cipher)).rejects.toMatchObject({
        code: 'FS_ENCRYPTED',
        message: expect.stringContaining('disk-encryption policy'),
      });
    });

    it('passes a path with spaces, CJK, quotes-like punctuation and shell metacharacters intact', async () => {
      const service = makeService();
      installEncryptedRead({
        service,
        reader: createPowerShellReader(),
        platform: 'win32',
        createError: FakeFsError,
      });
      // The name carries a space, an apostrophe, `$`, a backtick, `&`, `;`
      // and CJK characters. `"` is reserved in Windows file names and cannot
      // be created; everything else that could break quoting is here.
      const name = "a b'c$d`e&f;g\u4e2d\u6587.yml";
      const cipher = targetOf(fakeCipherFile(dir, name));
      // "returned ciphertext too" proves PowerShell read this exact file back;
      // a broken path would surface as a fallback-failure refusal instead.
      await expect(service.readText(cipher)).rejects.toMatchObject({
        code: 'FS_ENCRYPTED',
        message: expect.stringContaining('returned ciphertext too'),
      });
    });

    it('kills the child and fails on timeout, never touching process.kill', async () => {
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
      const service = makeService();
      installEncryptedRead({
        service,
        // A real spawn takes longer than this budget, so the timer trips.
        reader: createPowerShellReader({ timeoutMs: 50 }),
        platform: 'win32',
        createError: FakeFsError,
      });
      const cipher = targetOf(fakeCipherFile(dir, 'timeout.yml'));
      await expect(service.readText(cipher)).rejects.toMatchObject({
        code: 'FS_ENCRYPTED',
        message: expect.stringContaining('timed out'),
      });
      expect(killSpy).not.toHaveBeenCalled();
    });

    it('kills the child and fails as FS_ABORTED on abort, never touching process.kill', async () => {
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
      const service = makeService();
      installEncryptedRead({
        service,
        reader: createPowerShellReader(),
        platform: 'win32',
        createError: FakeFsError,
      });
      const cipher = targetOf(fakeCipherFile(dir, 'abort.yml'));
      const controller = new AbortController();
      const pending = service.readText(cipher, controller.signal);
      // Abort while the child is certainly still running (spawns take ~0.5 s).
      setTimeout(() => controller.abort(), 100);
      await expect(pending).rejects.toMatchObject({ code: 'FS_ABORTED' });
      expect(killSpy).not.toHaveBeenCalled();
    });

    it('reads plaintext through the real reader when one is decryptable — the framing round-trip', async () => {
      // A PowerShell-readable "decryption": not producible synthetically, so
      // this pins the reader's happy path against a plain file the installer
      // would not touch — by calling the reader directly with the file whose
      // bytes must come back byte-for-byte through the framing.
      const reader = createPowerShellReader();
      const body = Buffer.from('round trip \u4e2d\u6587 \u00e9\n'.repeat(50));
      const path = join(dir, 'roundtrip.bin');
      writeFileSync(path, body);
      expect(Buffer.from(await reader(path))).toEqual(body);
    });
  }
);
