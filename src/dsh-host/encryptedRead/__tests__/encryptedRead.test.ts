import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TSD_HEADER } from '../constants.ts';
import type { FsErrorView, FsReadService, FsTarget } from '../dshTypes.ts';
import { installEncryptedRead } from '../encryptedRead.ts';
import { createGate, parseFramedStdout } from '../powershellReader.ts';

/**
 * The `aiclient-encrypted-read` row's pure wiring (dsh-rebase P1-13c;
 * decision 091), tested against a fake fs service and an injected fake
 * fallback reader: every platform runs these, because nothing here spawns
 * anything. The real PowerShell reader has its own win32-only tests.
 */

class FakeFsError extends Error implements FsErrorView {
  readonly code: string;
  constructor(message: string, code: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}

/** A target the tests can build by hand, like dsh-fs's resolved targets. */
const targetOf = (path: string): FsTarget => ({ targetKey: path, displayPath: path });

/** The original service: sentinel results, every call recorded. */
interface RecordingService extends FsReadService {
  readonly calls: Array<{ method: string; args: unknown[] }>;
}

function makeService(): RecordingService {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      if (method === 'readText') return Promise.resolve('ORIGINAL-TEXT');
      if (method === 'streamText')
        return Promise.resolve(
          (async function* originalStream() {
            yield 'ORIGINAL-';
            yield 'STREAM';
          })()
        );
      if (method === 'readBytes') return Promise.resolve(new Uint8Array([1, 2, 3]));
      if (method === 'readByteRange') return Promise.resolve(new Uint8Array([9, 9]));
      if (method === 'stat') return Promise.resolve({ version: 'v1', type: 'file', size: 3 });
      if (method === 'writeText')
        return Promise.resolve({ operation: 'update', version: 'v2', before: null, after: '' });
      return Promise.resolve({ original: true });
    };
  const service = {
    calls,
    readText: record('readText'),
    streamText: record('streamText'),
    readBytes: record('readBytes'),
    readByteRange: record('readByteRange'),
    editText: record('editText'),
    stat: record('stat'),
    writeText: record('writeText'),
  } as unknown as RecordingService;
  return service;
}

/** A reader the tests control: counts calls, returns the queued outcome. */
function makeReader(outcome: () => Uint8Array | Promise<Uint8Array>) {
  const reader = vi.fn(async (_path: string) => outcome());
  return reader;
}

const PLAINTEXT = new TextEncoder().encode('decrypted content\nwith lines\n');
const CIPHERTEXT = new Uint8Array([...TSD_HEADER, 1, 2, 3, 4, 5]);

describe('installEncryptedRead (P1-13c, decision 091)', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'encrypted-read-test-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const writeTemp = (name: string, bytes: Uint8Array): string => {
    const path = join(dir, name);
    writeFileSync(path, bytes);
    return path;
  };

  it('wraps nothing outside win32', () => {
    const service = makeService();
    const reader = makeReader(() => PLAINTEXT);
    const result = installEncryptedRead({
      service,
      reader,
      platform: 'linux',
      createError: FakeFsError,
    });
    expect(result).toEqual({ wrapped: false, entries: [] });
    const cipher = targetOf(writeTemp('linux-inert.yml', CIPHERTEXT));
    // The untouched service answers with its own sentinel, reader never runs.
    expect(service.readText(cipher)).resolves.toBe('ORIGINAL-TEXT');
    expect(reader).not.toHaveBeenCalled();
  });

  it('reads only the 16-byte prefix for a normal file: no reader call, original answers', async () => {
    const service = makeService();
    const reader = makeReader(() => PLAINTEXT);
    installEncryptedRead({ service, reader, platform: 'win32', createError: FakeFsError });
    const plain = targetOf(
      writeTemp('plain.ts', new TextEncoder().encode('export const x = 1;\n'))
    );

    expect(await service.readText(plain)).toBe('ORIGINAL-TEXT');
    const streamChunks: string[] = [];
    for await (const chunk of await service.streamText(plain)) streamChunks.push(chunk);
    expect(streamChunks).toEqual(['ORIGINAL-', 'STREAM']);
    expect(await service.readBytes(plain, undefined, 100)).toEqual(new Uint8Array([1, 2, 3]));
    expect(await service.readByteRange(plain, { offset: 1, length: 2 })).toEqual(
      new Uint8Array([9, 9])
    );
    expect(await service.editText(plain, { oldString: 'a' }, undefined, undefined)).toEqual({
      original: true,
    });
    // Exactly one prefix read per call: five calls, five originals, zero fallbacks.
    expect(reader).not.toHaveBeenCalled();
    expect(service.calls.map((call) => call.method)).toEqual([
      'readText',
      'streamText',
      'readBytes',
      'readByteRange',
      'editText',
    ]);
  });

  it('delegates when the prefix read itself fails, so the original raises the canonical error', async () => {
    const service = makeService();
    const reader = makeReader(() => PLAINTEXT);
    installEncryptedRead({ service, reader, platform: 'win32', createError: FakeFsError });
    const missing = targetOf(join(dir, 'no-such-file.md'));

    expect(await service.readText(missing)).toBe('ORIGINAL-TEXT');
    expect(reader).not.toHaveBeenCalled();
  });

  it('readText returns fallback plaintext as strict UTF-8 text', async () => {
    const service = makeService();
    installEncryptedRead({
      service,
      reader: makeReader(() => PLAINTEXT),
      platform: 'win32',
      createError: FakeFsError,
    });
    const cipher = targetOf(writeTemp('text.yml', CIPHERTEXT));
    expect(await service.readText(cipher)).toBe(new TextDecoder().decode(PLAINTEXT));
  });

  it('readText rejects fallback plaintext that is binary or invalid UTF-8, with dsh-fs-local’s wording', async () => {
    const service = makeService();
    installEncryptedRead({
      service,
      reader: makeReader(() => new Uint8Array([65, 0, 66])),
      platform: 'win32',
      createError: FakeFsError,
    });
    const binary = targetOf(writeTemp('binary.yml', CIPHERTEXT));
    await expect(service.readText(binary)).rejects.toMatchObject({
      code: 'FS_NOT_TEXT',
      message: expect.stringContaining('binary file'),
    });

    const service2 = makeService();
    installEncryptedRead({
      service: service2,
      reader: makeReader(() => new Uint8Array([0xff, 0xfe, 0xfd])),
      platform: 'win32',
      createError: FakeFsError,
    });
    const invalid = targetOf(writeTemp('invalid.yml', CIPHERTEXT));
    await expect(service2.readText(invalid)).rejects.toMatchObject({
      code: 'FS_NOT_TEXT',
      message: expect.stringContaining('invalid UTF-8'),
    });
  });

  it('streamText yields the fallback text as one chunk', async () => {
    const service = makeService();
    installEncryptedRead({
      service,
      reader: makeReader(() => PLAINTEXT),
      platform: 'win32',
      createError: FakeFsError,
    });
    const cipher = targetOf(writeTemp('stream.yml', CIPHERTEXT));
    const chunks: string[] = [];
    for await (const chunk of await service.streamText(cipher)) chunks.push(chunk);
    expect(chunks).toEqual([new TextDecoder().decode(PLAINTEXT)]);
  });

  it('readBytes enforces maxBytes against the plaintext length', async () => {
    const service = makeService();
    installEncryptedRead({
      service,
      reader: makeReader(() => PLAINTEXT),
      platform: 'win32',
      createError: FakeFsError,
    });
    const cipher = targetOf(writeTemp('bytes.yml', CIPHERTEXT));
    const length = PLAINTEXT.length;

    expect(new Uint8Array(await service.readBytes(cipher, undefined, length))).toEqual(PLAINTEXT);
    await expect(service.readBytes(cipher, undefined, length - 1)).rejects.toMatchObject({
      code: 'FS_TOO_LARGE',
      message: expect.stringContaining(`${length} bytes exceeds the ${length - 1}-byte limit`),
    });
    // No cap, no rejection: the original treats a missing cap as unbounded.
    expect(new Uint8Array(await service.readBytes(cipher, undefined, undefined))).toEqual(
      PLAINTEXT
    );
  });

  it('readByteRange takes its window from the plaintext', async () => {
    const service = makeService();
    installEncryptedRead({
      service,
      reader: makeReader(() => PLAINTEXT),
      platform: 'win32',
      createError: FakeFsError,
    });
    const cipher = targetOf(writeTemp('range.yml', CIPHERTEXT));

    expect(
      new Uint8Array(await service.readByteRange(cipher, { offset: 0, length: PLAINTEXT.length }))
    ).toEqual(PLAINTEXT);
    expect(new Uint8Array(await service.readByteRange(cipher, { offset: 10, length: 4 }))).toEqual(
      PLAINTEXT.subarray(10, 14)
    );
    expect(await service.readByteRange(cipher, { offset: 0, length: 0 })).toEqual(
      new Uint8Array(0)
    );
    // A window at or past the end is empty, as in the original.
    expect(
      new Uint8Array(
        await service.readByteRange(cipher, { offset: PLAINTEXT.length + 5, length: 8 })
      )
    ).toEqual(new Uint8Array(0));
  });

  it('refuses FS_ENCRYPTED when the fallback still returns ciphertext', async () => {
    const service = makeService();
    installEncryptedRead({
      service,
      reader: makeReader(() => CIPHERTEXT),
      platform: 'win32',
      createError: FakeFsError,
    });
    const cipher = targetOf(writeTemp('still-cipher.yml', CIPHERTEXT));
    for (const run of [
      () => service.readText(cipher),
      () => service.streamText(cipher),
      () => service.readBytes(cipher, undefined, 100),
      () => service.readByteRange(cipher, { offset: 0, length: 10 }),
    ]) {
      await expect(run()).rejects.toMatchObject({
        code: 'FS_ENCRYPTED',
        message: expect.stringContaining('returned ciphertext too'),
      });
    }
  });

  it('refuses FS_ENCRYPTED when the fallback reader fails', async () => {
    const service = makeService();
    installEncryptedRead({
      service,
      reader: vi.fn(async () => {
        throw new Error('spawn exploded');
      }),
      platform: 'win32',
      createError: FakeFsError,
    });
    const cipher = targetOf(writeTemp('reader-fails.yml', CIPHERTEXT));
    await expect(service.readText(cipher)).rejects.toMatchObject({
      code: 'FS_ENCRYPTED',
      message: expect.stringContaining('the decryption fallback failed'),
    });
  });

  it('maps a fallback abort to FS_ABORTED', async () => {
    const service = makeService();
    installEncryptedRead({
      service,
      reader: vi.fn(async () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      }),
      platform: 'win32',
      createError: FakeFsError,
    });
    const cipher = targetOf(writeTemp('aborted.yml', CIPHERTEXT));
    await expect(service.readText(cipher)).rejects.toMatchObject({ code: 'FS_ABORTED' });
  });

  it('editText edits an encrypted file through the fallback and delegates every other file', async () => {
    const service = makeService();
    installEncryptedRead({
      service,
      reader: makeReader(() => new TextEncoder().encode('ALPHA\n')),
      platform: 'win32',
      createError: FakeFsError,
    });
    const cipher = targetOf(writeTemp('edit.yml', CIPHERTEXT));
    // P1-13d (decision 135): the encrypted file is edited on the fallback's
    // plaintext; the write is the service's own, version-guarded.
    expect(
      await service.editText(
        cipher,
        { oldString: 'ALPHA', newString: 'BETA' },
        undefined,
        undefined,
        { mode: 'danger-full-access' }
      )
    ).toEqual({ version: 'v2', before: 'ALPHA\n', after: 'BETA\n' });
    expect(service.calls.map((call) => call.method)).toEqual(['stat', 'writeText']);
    expect(service.calls[1]?.args[2]).toEqual({ kind: 'replaceIfVersion', version: 'v1' });

    const plain = targetOf(writeTemp('edit-plain.md', new TextEncoder().encode('hello')));
    const edit = { oldString: 'hello', newString: 'hi' };
    const expected = { expected: 'sentinel' };
    const policy = { mode: 'read-only' };
    expect(await service.editText(plain, edit, expected, undefined, policy)).toEqual({
      original: true,
    });
    // The plaintext edit reaches the original method unchanged, adding the
    // one recorded call the encrypted path never made.
    expect(service.calls.map((call) => call.method)).toEqual(['stat', 'writeText', 'editText']);
    expect(service.calls.at(-1)).toEqual({
      method: 'editText',
      args: [plain, edit, expected, undefined, policy],
    });
  });

  it('refuses plaintext above the fallback size cap before any semantics run', async () => {
    const service = makeService();
    installEncryptedRead({
      service,
      reader: makeReader(() => new Uint8Array(32 * 1024 * 1024 + 1)),
      platform: 'win32',
      createError: FakeFsError,
    });
    const cipher = targetOf(writeTemp('huge.yml', CIPHERTEXT));
    await expect(service.readByteRange(cipher, { offset: 0, length: 4 })).rejects.toMatchObject({
      code: 'FS_ENCRYPTED',
      message: expect.stringContaining('fallback limit'),
    });
  });

  it('ignores a pre-aborted signal by delegating, and wraps only once', async () => {
    const service = makeService();
    const reader = makeReader(() => PLAINTEXT);
    installEncryptedRead({ service, reader, platform: 'win32', createError: FakeFsError });
    const cipher = targetOf(writeTemp('aborted-prefix.yml', CIPHERTEXT));
    const controller = new AbortController();
    controller.abort();
    expect(await service.readText(cipher, controller.signal)).toBe('ORIGINAL-TEXT');
    expect(reader).not.toHaveBeenCalled();

    const again = installEncryptedRead({
      service,
      reader: makeReader(() => PLAINTEXT),
      platform: 'win32',
      createError: FakeFsError,
    });
    expect(again.wrapped).toBe(false);
    // The first wrap still works after the refused second install.
    expect(service.readText(cipher)).resolves.toBe(new TextDecoder().decode(PLAINTEXT));
  });
});

describe('the fallback reader’s pure pieces (P1-13c)', () => {
  it('parseFramedStdout accepts only the exact frame, as one base64 line', () => {
    const encode = (bytes: Uint8Array) =>
      Buffer.concat([
        Buffer.from('AICLIENT-FS-B64-BEGIN\n'),
        Buffer.from(Buffer.from(bytes).toString('base64')),
        Buffer.from('\nAICLIENT-FS-B64-END\n'),
      ]);
    expect(new Uint8Array(parseFramedStdout(encode(new Uint8Array([1, 2, 3]))))).toEqual(
      new Uint8Array([1, 2, 3])
    );
    expect(new Uint8Array(parseFramedStdout(encode(new Uint8Array(0))))).toEqual(new Uint8Array(0));
    // Missing markers, extra prose, a second line: all refused.
    expect(() => parseFramedStdout(Buffer.from('hello'))).toThrow(/framed/);
    expect(() =>
      parseFramedStdout(Buffer.from('AICLIENT-FS-B64-BEGIN\nAAAA\nBBBB\nAICLIENT-FS-B64-END\n'))
    ).toThrow(/single base64 line/);
    expect(() =>
      parseFramedStdout(Buffer.from('noise\nAICLIENT-FS-B64-BEGIN\nAAAA\nAICLIENT-FS-B64-END\n'))
    ).toThrow(/framed/);
  });

  it('createGate queues beyond its maximum and releases in FIFO order', async () => {
    const gate = createGate(2);
    const order: number[] = [];
    const hold = async (id: number, ms: number) => {
      await gate.acquire();
      order.push(id);
      await new Promise((resolve) => setTimeout(resolve, ms));
      gate.release();
    };
    await Promise.all([hold(1, 30), hold(2, 10), hold(3, 5), hold(4, 1)]);
    // 1 and 2 run at once; 3 and 4 start only after a slot frees, in order.
    expect(order.indexOf(3)).toBeGreaterThan(order.indexOf(2));
    expect(order.indexOf(3)).toBeLessThan(order.indexOf(4));
  });
});
