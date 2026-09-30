/**
 * aiclient-encrypted-read — re-reads files the company disk-encryption policy
 * hands node as ciphertext through Windows PowerShell 5.1 (dsh-rebase P1-13c;
 * decision 091). The behaviour lives in `encryptedRead.ts`; this file wires
 * it to the row's Cordis context and to dsh-fs's `FsError`.
 *
 * On in the product bundle on every platform, but it wraps anything only on
 * Windows: `apply` returns immediately elsewhere, so Linux and macOS keep
 * byte-for-byte the behaviour and cost they had without this row. On the same
 * footing, `AICLIENT_RUNTIME_ENCRYPTED_READ=0` (forwarded by Main) turns it
 * off entirely — no method is wrapped and the row is inert. The row injects
 * `fs` for load ordering, then takes the registered instance itself
 * (`ctx.get` hands over the stored value, not a per-access proxy) and wraps
 * the four read entrances and `editText` on it — every consumer calls those
 * through `ctx.fs` at call time, so the wrap is visible to all of them.
 *
 * Two ways in, like the other rows (decision 011): a source checkout loads
 * `bundle/lib/encrypted-read.js`, a one-line re-export of this file; the
 * packaged host loads the esbuild bundle scripts/build-dsh-host.mjs writes
 * over it. `@deepseek-ai/dsh-fs` stays external so the `FsError` this row
 * throws is the host's own class, not a bundled twin.
 */

import { FsError } from '@deepseek-ai/dsh-fs';
import { ENCRYPTED_READ_ENV, ENCRYPTED_READ_ROW } from './constants.ts';
import type { EncryptedReadRowContext, FsErrorCtor } from './dshTypes.ts';
import { installEncryptedRead } from './encryptedRead.ts';
import { createPowerShellReader } from './powershellReader.ts';

/** Stable Cordis plugin name. */
export const name = ENCRYPTED_READ_ROW;

/** The row starts once the fs service exists; it wraps that very instance. */
export const inject = ['fs'];

/**
 * Whether this row does anything in this process: the kill switch is off
 * (only the exact value `0`) and the platform is Windows.
 */
export function isEncryptedReadEnabled(
  platform: NodeJS.Platform | string,
  env: Record<string, string | undefined>
): boolean {
  return env[ENCRYPTED_READ_ENV] !== '0' && platform === 'win32';
}

export function apply(ctx: EncryptedReadRowContext): void {
  const log = (line: string) => console.error(`[${ENCRYPTED_READ_ROW}] ${line}`);
  if (!isEncryptedReadEnabled(process.platform, process.env)) {
    // Escape hatch (decision 135): nothing is wrapped, so the service keeps
    // answering exactly as it does on a machine without this row.
    log(
      process.env[ENCRYPTED_READ_ENV] === '0'
        ? `disabled by ${ENCRYPTED_READ_ENV}=0: encrypted files read as ciphertext`
        : 'not on win32: nothing to wrap'
    );
    return;
  }
  const service = ctx.get('fs');
  if (service === undefined) {
    // inject: ['fs'] makes this unreachable; refusing loudly beats wrapping nothing.
    throw new Error('no fs service to wrap, despite inject: ["fs"]');
  }
  const { wrapped } = installEncryptedRead({
    service,
    reader: createPowerShellReader(),
    platform: process.platform,
    // `FsError`'s real constructor narrows `code` to dsh-fs's own
    // `FsErrorCode` union, which does not include this row's own
    // `FS_ENCRYPTED` extension (constants.ts) — that is the only reason this
    // needs a cast; `FsError` does not validate `code` at runtime, so passing
    // a code outside that union is safe and behaves exactly as declared here.
    createError: FsError as unknown as FsErrorCtor,
    log,
  });
  if (!wrapped) log('the fs service was already wrapped by an earlier start');
}
