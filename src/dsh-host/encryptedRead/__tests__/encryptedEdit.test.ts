import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TSD_HEADER } from '../constants.ts';
import type { FsErrorView, FsReadService, FsStatView, FsTarget } from '../dshTypes.ts';
import { installEncryptedRead } from '../encryptedRead.ts';
import {
  applyLiteralEdit,
  detectLineEndings,
  normalizeLineEndings,
  restoreLineEndings,
} from '../replaceSemantics.ts';

/**
 * Editing an encrypted file (dsh-rebase P1-13d; decision 135), against a fake
 * fs service and an injected fake reader: every platform runs these, because
 * nothing here spawns anything. The real PowerShell 5.1 half is in
 * `encryptedEdit.win32.test.ts`.
 *
 * The fake service models the two backend behaviours the edit path depends
 * on: `stat` reports a version from a mutable field, and `writeText` enforces
 * `replaceIfVersion` against that same field — so a version the test bumps
 * between the read and the write is exactly the external writer the guard is
 * meant to catch.
 */

class FakeFsError extends Error implements FsErrorView {
  readonly code: string;
  constructor(message: string, code: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}

const targetOf = (path: string): FsTarget => ({ targetKey: path, displayPath: path });

interface FakeServiceOptions {
  /** The version `stat` reports; the test bumps it to simulate an outside writer. */
  version?: string;
  /** `stat` answers "missing" when set (the file vanished). */
  missing?: boolean;
  /** `stat` answers a directory when set. */
  directory?: boolean;
}

interface EditService extends FsReadService {
  readonly calls: Array<{ method: string; args: unknown[] }>;
  readonly writes: Array<{ content: string; expected: unknown; sandboxPolicy: unknown }>;
  version: string;
  missing: boolean;
  directory: boolean;
}

function makeService(options: FakeServiceOptions = {}): EditService {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const writes: Array<{ content: string; expected: unknown; sandboxPolicy: unknown }> = [];
  const service = {
    calls,
    writes,
    version: options.version ?? 'v1',
    missing: options.missing ?? false,
    directory: options.directory ?? false,
    async stat(_target: FsTarget): Promise<FsStatView | undefined> {
      calls.push({ method: 'stat', args: [_target] });
      if (service.missing) return undefined;
      return {
        version: service.version,
        type: service.directory ? 'directory' : 'file',
        size: 11,
      };
    },
    async writeText(
      _target: FsTarget,
      content: string,
      expected: unknown,
      _signal: AbortSignal | undefined,
      sandboxPolicy: unknown
    ) {
      calls.push({
        method: 'writeText',
        args: [_target, content, expected, _signal, sandboxPolicy],
      });
      const guard = expected as { kind?: string; version?: unknown } | undefined;
      if (guard?.kind === 'replaceIfVersion') {
        if (service.missing) {
          throw new FakeFsError(
            `cannot write "${_target.displayPath}": file no longer exists`,
            'FS_STALE_VERSION'
          );
        }
        if (guard.version !== service.version) {
          throw new FakeFsError(
            `cannot write "${_target.displayPath}": file changed since it was read`,
            'FS_STALE_VERSION'
          );
        }
      }
      writes.push({ content, expected, sandboxPolicy });
      service.version = `${service.version}+`;
      return {
        operation: 'update',
        version: service.version,
        before: normalizeLineEndings(content),
        after: normalizeLineEndings(content),
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
  } as unknown as EditService;
  return service;
}

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

/** A reader that hands back fixed plaintext (or throws). */
function makeReader(body: string | Uint8Array | Error) {
  return vi.fn(async (_path: string) => {
    if (body instanceof Error) throw body;
    return typeof body === 'string' ? encode(body) : body;
  });
}

describe('editing an encrypted file (P1-13d, decision 135)', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'encrypted-edit-test-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  let counter = 0;
  /** A file whose node-visible bytes start with the marker, plus a fresh name. */
  const cipherTarget = (): FsTarget => {
    counter += 1;
    const path = join(dir, `cipher-${counter}.yml`);
    writeFileSync(path, new Uint8Array([...TSD_HEADER, 7, 8, 9]));
    return targetOf(path);
  };

  const install = (service: EditService, reader: ReturnType<typeof makeReader>) =>
    installEncryptedRead({ service, reader, platform: 'win32', createError: FakeFsError });

  it('edits the fallback plaintext and writes it back replacing the version it read', async () => {
    const service = makeService({ version: 'v7' });
    const reader = makeReader('alpha\nbeta\ngamma\n');
    install(service, reader);
    const target = cipherTarget();

    const outcome = (await service.editText(
      target,
      { oldString: 'beta', newString: 'BETA' },
      undefined,
      undefined,
      { mode: 'danger-full-access' }
    )) as { before: string; after: string; version: string };

    expect(reader).toHaveBeenCalledTimes(1);
    // The write is the service's own, with the read version as the guard and
    // the caller's policy forwarded — never a private write.
    expect(service.writes).toEqual([
      {
        content: 'alpha\nBETA\ngamma\n',
        expected: { kind: 'replaceIfVersion', version: 'v7' },
        sandboxPolicy: { mode: 'danger-full-access' },
      },
    ]);
    expect(service.calls.map((call) => call.method)).toEqual(['stat', 'writeText']);
    // dsh-fs-local's editText result shape: LF-normalized before/after.
    expect(outcome.before).toBe('alpha\nbeta\ngamma\n');
    expect(outcome.after).toBe('alpha\nBETA\ngamma\n');
    expect(outcome.version).toBe('v7+');
  });

  it('preserves CRLF line endings on write-back and matches LF-normalized text', async () => {
    const service = makeService();
    // The fallback returns the file as it is on disk: CRLF here.
    const reader = makeReader('alpha\r\nbeta\r\ngamma\r\n');
    install(service, reader);

    await service.editText(cipherTarget(), { oldString: 'beta', newString: 'BETA' });

    expect(service.writes[0]?.content).toBe('alpha\r\nBETA\r\ngamma\r\n');
  });

  it('matches an old_string that arrived with CRLF against the LF-normalized plaintext', async () => {
    const service = makeService();
    const reader = makeReader('alpha\nbeta\n');
    install(service, reader);

    await service.editText(cipherTarget(), { oldString: 'alpha\r\nbeta', newString: 'one' });

    expect(service.writes[0]?.content).toBe('one\n');
  });

  it('replaces every match when the caller sets replace_all', async () => {
    const service = makeService();
    install(service, makeReader('x\ny\nx\n'));
    await service.editText(
      cipherTarget(),
      { oldString: 'x', newString: 'z', replaceAll: true },
      undefined,
      undefined,
      { mode: 'read-only' }
    );
    expect(service.writes[0]?.content).toBe('z\ny\nz\n');
  });

  it("refuses FS_EDIT_NOT_FOUND for an empty or absent old_string, in dsh-fs-local's words", async () => {
    for (const edit of [
      { oldString: '', newString: 'x' },
      { oldString: 'nowhere', newString: 'x' },
    ]) {
      const service = makeService();
      install(service, makeReader('alpha\nbeta\n'));
      const target = cipherTarget();
      const pending = service.editText(target, edit);
      if (edit.oldString === '') {
        await expect(pending).rejects.toMatchObject({
          code: 'FS_EDIT_NOT_FOUND',
          message: 'old_string must be a non-empty string',
        });
      } else {
        await expect(pending).rejects.toMatchObject({
          code: 'FS_EDIT_NOT_FOUND',
          message: `old_string was not found in "${target.displayPath}"`,
        });
      }
      // Nothing was written: the refusal happens before the write.
      expect(service.writes).toHaveLength(0);
    }
  });

  it("refuses FS_AMBIGUOUS_EDIT when several matches need replace_all, in dsh-fs-local's words", async () => {
    const service = makeService();
    install(service, makeReader('x\nx\n'));
    const target = cipherTarget();
    await expect(
      service.editText(target, { oldString: 'x', newString: 'z' })
    ).rejects.toMatchObject({
      code: 'FS_AMBIGUOUS_EDIT',
      message: `old_string matched 2 times in "${target.displayPath}"; provide a more specific old_string or set replace_all to true`,
    });
    expect(service.writes).toHaveLength(0);
  });

  it("refuses FS_NOT_TEXT for binary plaintext, with readForEdit's whole-buffer scan", async () => {
    const service = makeService();
    // The NUL sits past the 8192-byte read sample: `readForEdit` scans the
    // whole buffer, so the edit must refuse it too.
    const body = `${'a'.repeat(9000)}\u0000tail`;
    install(service, makeReader(body));
    const target = cipherTarget();
    await expect(
      service.editText(target, { oldString: 'a', newString: 'b' })
    ).rejects.toMatchObject({
      code: 'FS_NOT_TEXT',
      message: `cannot edit "${target.displayPath}": binary file`,
    });
    expect(service.writes).toHaveLength(0);
  });

  it('refuses FS_NOT_TEXT for invalid UTF-8 plaintext', async () => {
    const service = makeService();
    install(service, makeReader(new Uint8Array([0xff, 0xfe, 0xfd])));
    const target = cipherTarget();
    await expect(
      service.editText(target, { oldString: 'a', newString: 'b' })
    ).rejects.toMatchObject({
      code: 'FS_NOT_TEXT',
      message: `cannot edit "${target.displayPath}": invalid UTF-8 text`,
    });
  });

  it('accepts a BOM as content, decoding it away exactly as dsh-fs-local does', async () => {
    const service = makeService();
    // A leading UTF-8 BOM is stripped by `TextDecoder` itself — the same
    // decoder dsh-fs-local's `readForEdit` uses — so the edit matches and
    // writes back the text without it. The fallback returns bytes, so the
    // fixture encodes the BOM explicitly.
    const withBom = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...new TextEncoder().encode('alpha\nbeta\n'),
    ]);
    install(service, makeReader(withBom));
    await service.editText(cipherTarget(), { oldString: 'beta', newString: 'BETA' });
    expect(service.writes[0]?.content).toBe('alpha\nBETA\n');
  });

  it('refuses FS_STALE_VERSION when the caller-supplied expected version does not match', async () => {
    const service = makeService({ version: 'v2' });
    install(service, makeReader('alpha\n'));
    const target = cipherTarget();
    await expect(
      service.editText(
        target,
        { oldString: 'a', newString: 'b' },
        {
          kind: 'replaceIfVersion',
          version: 'v1',
        }
      )
    ).rejects.toMatchObject({
      code: 'FS_STALE_VERSION',
      message: `cannot edit "${target.displayPath}": file changed since it was read`,
    });
    // No read and no write once the guard refuses.
    expect(service.calls.map((call) => call.method)).toEqual(['stat']);
  });

  it('refuses FS_STALE_VERSION when the file changed between the read and the write-back', async () => {
    const service = makeService({ version: 'v1' });
    const reader = vi.fn(async () => {
      // An outside writer lands while the fallback read is in flight.
      service.version = 'v1-changed';
      return encode('ALPHA\n');
    });
    install(service, reader as unknown as ReturnType<typeof makeReader>);
    const target = cipherTarget();
    // The read still succeeds; the guarded write is what refuses.
    await expect(
      service.editText(target, { oldString: 'ALPHA', newString: 'BETA' })
    ).rejects.toMatchObject({
      code: 'FS_STALE_VERSION',
      message: `cannot write "${target.displayPath}": file changed since it was read`,
    });
    expect(service.writes).toHaveLength(0);
    expect(service.calls.map((call) => call.method)).toEqual(['stat', 'writeText']);
  });

  it('refuses FS_STALE_VERSION when the file is gone before the edit runs', async () => {
    const service = makeService({ missing: true });
    install(service, makeReader('alpha\n'));
    const target = cipherTarget();
    await expect(
      service.editText(target, { oldString: 'a', newString: 'b' })
    ).rejects.toMatchObject({
      code: 'FS_STALE_VERSION',
      message: `cannot edit "${target.displayPath}": file changed since it was read`,
    });
  });

  it('refuses FS_NOT_REGULAR_FILE for a directory target', async () => {
    const service = makeService({ directory: true });
    install(service, makeReader('alpha\n'));
    const target = cipherTarget();
    await expect(
      service.editText(target, { oldString: 'a', newString: 'b' })
    ).rejects.toMatchObject({
      code: 'FS_NOT_REGULAR_FILE',
      message: `cannot edit "${target.displayPath}": not a regular file`,
    });
  });

  it('refuses FS_ENCRYPTED when the fallback still returns ciphertext', async () => {
    const service = makeService();
    install(service, makeReader(new Uint8Array([...TSD_HEADER, 1, 2, 3])));
    const target = cipherTarget();
    await expect(
      service.editText(target, { oldString: 'a', newString: 'b' })
    ).rejects.toMatchObject({
      code: 'FS_ENCRYPTED',
      message: expect.stringContaining('returned ciphertext too'),
    });
    expect(service.writes).toHaveLength(0);
  });

  it('refuses FS_ENCRYPTED when the fallback reader fails, and FS_ABORTED when it aborts', async () => {
    const failing = makeService();
    install(failing, makeReader(new Error('spawn exploded')));
    await expect(
      failing.editText(cipherTarget(), { oldString: 'a', newString: 'b' })
    ).rejects.toMatchObject({
      code: 'FS_ENCRYPTED',
      message: expect.stringContaining('the decryption fallback failed'),
    });

    const aborted = makeService();
    const abortError = new Error('aborted');
    abortError.name = 'AbortError';
    install(aborted, makeReader(abortError));
    await expect(
      aborted.editText(cipherTarget(), { oldString: 'a', newString: 'b' })
    ).rejects.toMatchObject({ code: 'FS_ABORTED' });
  });

  it('leaves the plaintext path untouched: no stat, no fallback, the original edit answers', async () => {
    const service = makeService();
    const reader = makeReader('unused');
    install(service, reader);
    const plainPath = join(dir, 'plain.ts');
    writeFileSync(plainPath, 'export const x = 1;\n');
    const plain = targetOf(plainPath);
    const edit = { oldString: 'x', newString: 'y' };
    const expected = { kind: 'replaceIfVersion', version: 'v9' };
    const policy = { mode: 'read-only' };

    expect(await service.editText(plain, edit, expected, undefined, policy)).toEqual({
      original: true,
    });
    expect(reader).not.toHaveBeenCalled();
    expect(service.calls).toHaveLength(0);
    // The five-argument call reaches the original method unchanged.
    expect(service.writes).toHaveLength(0);
  });

  it('wraps nothing outside win32, so an encrypted edit keeps the original semantics', async () => {
    const service = makeService();
    const reader = makeReader('alpha\n');
    installEncryptedRead({
      service,
      reader,
      platform: 'linux',
      createError: FakeFsError,
    });
    expect(await service.editText(cipherTarget(), { oldString: 'a', newString: 'b' })).toEqual({
      original: true,
    });
    expect(reader).not.toHaveBeenCalled();
    expect(service.calls).toHaveLength(0);
  });
});

describe('the literal-replace semantics on their own (P1-13d)', () => {
  it('detects the dominant ending from the first 4096 characters, as dsh-fs-local does', () => {
    expect(detectLineEndings('a\r\nb\r\n')).toBe('CRLF');
    expect(detectLineEndings('a\nb\n')).toBe('LF');
    // A tie goes to LF (the sample's LF count wins), and lone CR is no ending.
    expect(detectLineEndings('a\r\nb\n')).toBe('LF');
    expect(detectLineEndings('a\rb')).toBe('LF');
    // Past the sample window the bytes do not vote.
    expect(detectLineEndings(`${'a\n'.repeat(3000)}\r\n`)).toBe('LF');
  });

  it('never doubles an already-CRLF sequence when restoring CRLF', () => {
    expect(restoreLineEndings('a\nb', 'LF')).toBe('a\nb');
    expect(restoreLineEndings('a\nb', 'CRLF')).toBe('a\r\nb');
    expect(restoreLineEndings('a\r\nb', 'CRLF')).toBe('a\r\nb');
  });

  it('applies a literal edit to LF-normalized content and counts replacements', () => {
    const outcome = applyLiteralEdit(
      'one\ntwo\none\n',
      { oldString: 'one', newString: 'X', replaceAll: true },
      'f',
      FakeFsError
    );
    expect(outcome).toEqual({ content: 'X\ntwo\nX\n', replacements: 2 });
    // Replacement is literal: `$&`-style patterns are text, not expansions.
    const literal = applyLiteralEdit(
      'a$&b',
      { oldString: '$&', newString: '$1' },
      'f',
      FakeFsError
    );
    expect(literal.content).toBe('a$1b');
  });

  it('counts non-overlapping occurrences, like dsh-fs-local', () => {
    const outcome = applyLiteralEdit(
      'aaaa',
      { oldString: 'aa', newString: 'b', replaceAll: true },
      'f',
      FakeFsError
    );
    expect(outcome).toEqual({ content: 'bb', replacements: 2 });
  });
});
