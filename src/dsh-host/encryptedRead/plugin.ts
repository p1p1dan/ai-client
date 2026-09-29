/**
 * aiclient-encrypted-read — re-reads files the company disk-encryption policy
 * hands node as ciphertext through Windows PowerShell 5.1 (dsh-rebase P1-13c;
 * decision 091). The behaviour lives in `encryptedRead.ts`; this file wires
 * it to the row's Cordis context and to dsh-fs's `FsError`.
 *
 * On in the product bundle on every platform, but it wraps anything only on
 * Windows: `apply` returns immediately elsewhere, so Linux and macOS keep
 * byte-for-byte the behaviour and cost they had without this row. The row
 * injects `fs` for load ordering, then takes the registered instance itself
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
import { ENCRYPTED_READ_ROW } from './constants.ts';
import type { EncryptedReadRowContext } from './dshTypes.ts';
import { installEncryptedRead } from './encryptedRead.ts';
import { createPowerShellReader } from './powershellReader.ts';

/** Stable Cordis plugin name. */
export const name = ENCRYPTED_READ_ROW;

/** The row starts once the fs service exists; it wraps that very instance. */
export const inject = ['fs'];

export function apply(ctx: EncryptedReadRowContext): void {
  if (process.platform !== 'win32') return;
  const log = (line: string) => console.error(`[${ENCRYPTED_READ_ROW}] ${line}`);
  const service = ctx.get('fs');
  if (service === undefined) {
    // inject: ['fs'] makes this unreachable; refusing loudly beats wrapping nothing.
    throw new Error('no fs service to wrap, despite inject: ["fs"]');
  }
  const { wrapped } = installEncryptedRead({
    service,
    reader: createPowerShellReader(),
    platform: process.platform,
    createError: FsError,
    log,
  });
  if (!wrapped) log('the fs service was already wrapped by an earlier start');
}
