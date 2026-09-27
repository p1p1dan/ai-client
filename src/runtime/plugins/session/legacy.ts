/**
 * Legacy session support for the runtime: a thin wrapper (dsh-rebase P1-9a).
 *
 * The decoding half — the v1/v2/v3 and PI-Desktop converter, the permission
 * records, the first-row guard — lives in `src/shared/legacyPiSession/legacy.ts`
 * so the migration can still read those files after this runtime is gone. What
 * stays here is the part that writes: `prepareSessionConfig`, which puts the
 * `.native-v4.jsonl` copy on disk under its writer lock, plus the
 * `RuntimeHostError` type the runtime's callers test for. P1-12 deletes it.
 */

import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import * as shared from '../../../shared/legacyPiSession/legacy.ts';
import type { RuntimeHostIoService } from '../../contracts.ts';
import { errorCode, RuntimeHostError } from '../../host/errors.ts';
import { decodeSession, SESSION_MAX_BYTES, withHostErrors } from './codec.ts';
import type { SessionConfig } from './store.ts';
import { acquireWriterLock, releaseWriterLock } from './writerLock.ts';

export {
  INTERNAL_CUSTOM_ENTRIES,
  migratedPermissions,
  PERMISSION_GRANTS_ENTRY,
  PERMISSIONS_ENTRY,
  sessionPermissions,
} from '../../../shared/legacyPiSession/legacy.ts';

export function convertLegacySession(
  content: string,
  cwd: string,
  sourceFile: string,
  allowRelocate = false
): string {
  return withHostErrors(() => shared.convertLegacySession(content, cwd, sourceFile, allowRelocate));
}

/** See `firstRow` in the shared module (session-09). */
function firstRow(content: string, file: string): Record<string, unknown> {
  return withHostErrors(() => shared.firstRow(content, file));
}

export async function prepareSessionConfig(
  io: RuntimeHostIoService,
  config: SessionConfig
): Promise<SessionConfig> {
  if (config.mode === 'create') return config;
  const sourceFile = await io.realpath(resolve(config.sourceFile ?? config.file));
  const read = await io.readFile(sourceFile, {
    maxBytes: config.maxBytes ?? SESSION_MAX_BYTES,
    overflow: 'error',
  });
  const content = new TextDecoder('utf-8', { fatal: true }).decode(read.bytes, {
    stream: read.bytes.at(-1) !== 10,
  });
  const first = firstRow(content, sourceFile);
  if (config.mode === 'resume' && first?.kind === 'header' && first.version === 4) return config;
  const requested =
    config.mode === 'import' ? resolve(config.file) : `${sourceFile}.native-v4.jsonl`;
  await io.mkdir(dirname(requested), { recursive: true, mode: 0o700 });
  let file = join(await io.realpath(dirname(requested)), basename(requested));
  try {
    file = await io.realpath(file);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
  if (file === sourceFile)
    throw new RuntimeHostError(
      'session_import_same_file',
      'import destination must differ from source'
    );
  const converted = convertLegacySession(
    content,
    await io.realpath(config.cwd),
    sourceFile,
    config.allowWorkspaceRelocation
  );
  if (Buffer.byteLength(converted) > (config.maxBytes ?? SESSION_MAX_BYTES))
    throw new RuntimeHostError('session_size_limit', 'converted session exceeds size budget');
  // concurrency-02: the converted copy has a writer lock of its own, and a
  // previous crash can strand it exactly the way it strands the v4 file's. A
  // forced open that stopped at this branch would refuse a legacy session with
  // the one remedy the UI offers already spent.
  const lock = await acquireWriterLock(io, file, { force: config.forceTakeover === true });
  try {
    let exists = true;
    try {
      await io.stat(file);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      exists = false;
    }
    if (!exists) {
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await io.writeFile(temporary, Buffer.from(converted), { createOnly: true, mode: 0o600 });
        await io.rename(temporary, file);
      } finally {
        await io.unlink(temporary).catch((error) => {
          if (errorCode(error) !== 'ENOENT') throw error;
        });
      }
      return { ...config, file, mode: 'resume' };
    }
    if (config.mode === 'import')
      throw new RuntimeHostError('EEXIST', 'import destination already exists');
    const previous = decodeSession(
      new TextDecoder().decode(
        (
          await io.readFile(file, {
            maxBytes: config.maxBytes ?? SESSION_MAX_BYTES,
            overflow: 'error',
          })
        ).bytes
      )
    );
    if (
      previous.header.metadata?.importedFrom !== sourceFile ||
      previous.header.metadata?.sourceSha256 !== createHash('sha256').update(content).digest('hex')
    )
      throw new RuntimeHostError(
        'session_import_source_changed',
        'legacy source changed since the native copy was created'
      );
  } finally {
    await releaseWriterLock(io, lock);
  }
  return { ...config, file, mode: 'resume' };
}
