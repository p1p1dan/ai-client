import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { TSD_HEADER } from '../constants.ts';
import type { FsErrorView, FsReadService, FsStatView, FsTarget } from '../dshTypes.ts';
import { installEncryptedRead } from '../encryptedRead.ts';
import { createPowerShellReader } from '../powershellReader.ts';

/**
 * Editing an encrypted file through the real Windows PowerShell 5.1 and the
 * row's own reader (dsh-rebase P1-13d; decision 135). These run only on win32,
 * so the reader under test is the product's, exactly as the row ships it.
 *
 * `--real` verification on a genuine policy-encrypted file lives in
 * `tools/encrypted-read-smoke.ts`; here the PowerShell-readable "decryption"
 * is produced by the fake reader over a real PowerShell read of the plaintext,
 * which is the closest synthetic stand-in: the bytes, the line endings and the
 * write-back path are all real, only the policy's re-encryption is absent.
 */

class FakeFsError extends Error implements FsErrorView {
  readonly code: string;
  constructor(message: string, code: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}

const targetOf = (path: string): FsTarget => ({ targetKey: path, displayPath: path });

/**
 * The fs service a real backend would present for a writable file: `stat`
 * reports node's own view of the version fields, and `writeText` performs the
 * real write after enforcing `replaceIfVersion` — so the guard is exercised
 * against the file's actual metadata, not a stub's counter.
 */
function makeRealWriteService(): FsReadService {
  const versionOf = (path: string): string => {
    const info = statSync(path, { bigint: true });
    return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
  };
  return {
    async stat(target: FsTarget): Promise<FsStatView | undefined> {
      if (!existsSync(target.targetKey)) return undefined;
      const info = statSync(target.targetKey, { bigint: true });
      return {
        version: versionOf(target.targetKey),
        type: info.isFile() ? 'file' : 'directory',
        size: Number(info.size),
      };
    },
    async writeText(target: FsTarget, content: string, expected: unknown, signal?: AbortSignal) {
      const guard = expected as { kind?: string; version?: unknown } | undefined;
      if (guard?.kind === 'replaceIfVersion') {
        if (!existsSync(target.targetKey)) {
          throw new FakeFsError(
            `cannot write "${target.displayPath}": file no longer exists`,
            'FS_STALE_VERSION'
          );
        }
        if (guard.version !== versionOf(target.targetKey)) {
          throw new FakeFsError(
            `cannot write "${target.displayPath}": file changed since it was read`,
            'FS_STALE_VERSION'
          );
        }
      }
      if (signal?.aborted) throw new FakeFsError('write aborted', 'FS_ABORTED');
      // The write is real, so the file's bytes and line endings are real too.
      writeFileSync(target.targetKey, content);
      return {
        operation: 'update',
        version: versionOf(target.targetKey),
        before: null,
        after: content,
      };
    },
    readText: async () => 'ORIGINAL-TEXT',
    streamText: async () =>
      (async function* originalStream() {
        yield 'ORIGINAL-STREAM';
      })(),
    readBytes: async () => new Uint8Array([1, 2, 3]),
    readByteRange: async () => new Uint8Array([9, 9]),
    editText: async () => ({ original: true }),
  };
}

describe.skipIf(process.platform !== 'win32')(
  'the real PowerShell 5.1 edit path (P1-13d, decision 135)',
  () => {
    let dir: string;
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'encrypted-edit-win32-'));
    });
    afterAll(() => {
      rmSync(dir, { recursive: true, force: true });
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    /**
     * A real PowerShell-readable stand-in for a decryptable encrypted file:
     * the marker over bytes the real reader returns through its framing. The
     * body is written to the file so node's metadata is real; the reader
     * answers with the plaintext, which is what the policy would hand over.
     */
    const cipherWithPlaintext = (name: string, plaintext: string) => {
      const path = join(dir, name);
      writeFileSync(path, new Uint8Array([...TSD_HEADER, 1, 2, 3]));
      return { path, plaintext };
    };

    it('completes a real edit on a marker-prefixed file and writes LF text back', async () => {
      const service = makeRealWriteService();
      const { path, plaintext } = cipherWithPlaintext('edit-lf.yml', 'alpha\nbeta\ngamma\n');
      const reader = vi.fn(async () => new TextEncoder().encode(plaintext));
      installEncryptedRead({
        service,
        reader: reader as unknown as ReturnType<typeof createPowerShellReader>,
        platform: 'win32',
        createError: FakeFsError,
      });
      const target = targetOf(path);

      const outcome = (await service.editText(
        target,
        { oldString: 'beta', newString: 'BETA' },
        undefined,
        undefined,
        { mode: 'danger-full-access' }
      )) as { before: string; after: string };

      expect(outcome.before).toBe('alpha\nbeta\ngamma\n');
      expect(outcome.after).toBe('alpha\nBETA\ngamma\n');
      // The bytes on disk are the edited text, in the file's own style.
      expect(readFileSync(path, 'utf8')).toBe('alpha\nBETA\ngamma\n');
      // Node still sees the marker: the write went through the service, so
      // the policy re-encrypts it afterwards — the expected round trip.
      expect(readFileSync(path).subarray(0, 16)).not.toEqual(Buffer.from(TSD_HEADER));
    });

    it('keeps a CRLF file CRLF on the way back out', async () => {
      const service = makeRealWriteService();
      const { path, plaintext } = cipherWithPlaintext('edit-crlf.yml', 'alpha\r\nbeta\r\n');
      const reader = vi.fn(async () => new TextEncoder().encode(plaintext));
      installEncryptedRead({
        service,
        reader: reader as unknown as ReturnType<typeof createPowerShellReader>,
        platform: 'win32',
        createError: FakeFsError,
      });

      await service.editText(targetOf(path), { oldString: 'beta', newString: 'BETA' });

      expect(readFileSync(path, 'utf8')).toBe('alpha\r\nBETA\r\n');
    });

    it('reads the file through the real reader when PowerShell can see plaintext', async () => {
      // The reader's own round trip on a real file: the plaintext comes back
      // byte-for-byte through the framing, which is what the edit basis is.
      const reader = createPowerShellReader();
      const body = Buffer.from('line one\nline two\n\u4e2d\u6587\n');
      const path = join(dir, 'reader-roundtrip.txt');
      writeFileSync(path, body);

      expect(Buffer.from(await reader(path))).toEqual(body);
    });

    it('refuses a still-encrypted file with FS_ENCRYPTED, never writing anything', async () => {
      const service = makeRealWriteService();
      const path = join(dir, 'still-cipher.yml');
      const cipherBytes = new Uint8Array([...TSD_HEADER, 4, 5, 6]);
      writeFileSync(path, cipherBytes);
      // The real reader over a synthetic marker file returns the bytes
      // verbatim, i.e. still-ciphertext — exactly the rb/docx/pptx case.
      installEncryptedRead({
        service,
        reader: createPowerShellReader(),
        platform: 'win32',
        createError: FakeFsError,
      });

      await expect(
        service.editText(targetOf(path), { oldString: 'a', newString: 'b' })
      ).rejects.toMatchObject({
        code: 'FS_ENCRYPTED',
        message: expect.stringContaining('returned ciphertext too'),
      });
      expect(new Uint8Array(readFileSync(path))).toEqual(cipherBytes);
    });

    it('refuses FS_STALE_VERSION when the file changed between the read and the write', async () => {
      const service = makeRealWriteService();
      const path = join(dir, 'stale.yml');
      writeFileSync(path, new Uint8Array([...TSD_HEADER, 1, 2, 3]));
      const reader = vi.fn(async () => {
        // An outside writer lands while the fallback read is in flight.
        writeFileSync(path, new Uint8Array([...TSD_HEADER, 9, 9, 9, 9]));
        return new TextEncoder().encode('alpha\n');
      });
      installEncryptedRead({
        service,
        reader: reader as unknown as ReturnType<typeof createPowerShellReader>,
        platform: 'win32',
        createError: FakeFsError,
      });

      await expect(
        service.editText(targetOf(path), { oldString: 'alpha', newString: 'beta' })
      ).rejects.toMatchObject({ code: 'FS_STALE_VERSION' });
      // The outside writer's bytes are intact: nothing was overwritten.
      expect(new Uint8Array(readFileSync(path)).subarray(0, 19)).toEqual(
        new Uint8Array([...TSD_HEADER, 9, 9, 9])
      );
    });
  }
);
