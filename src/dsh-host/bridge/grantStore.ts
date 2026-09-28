/**
 * The session-grant sidecar (dsh-rebase decision 043; P1-6c): what "allow for
 * this session" remembered, kept beside the session's identity stub so it
 * outlives the host process.
 *
 * `<stub id>.dsh.grants.json` (`grantsSidecarFor`), in the 1.0.x v2 encoding
 * (`encodeGrants` / `decodeGrants`), the whole set rewritten on every change.
 * Written the way the stub is written (temp file, fsync, rename), so a reader
 * sees the old set or the new one, never half of one. Nothing here throws:
 *
 *   read   no file is no grants. A file that cannot be read, is not JSON, is
 *          too large, or holds a version this build does not know is no
 *          grants either, and says so in the log: a session never fails to
 *          open over its grants, and never opens on grants it could not read
 *          (fail closed: the worst case is a card asked again).
 *   write  a failure is logged. The answer the user gave stands; it only does
 *          not survive the next restart (the gate's `persistGrants` contract).
 *   copy   a fork's grants, byte for byte; a failure is logged and the fork
 *          starts with none.
 *
 * Kept in `bridge/` rather than `permissions/`: the bridge row's bundle may
 * only take in `src/dsh-host/bridge/` of this package (`BRIDGE_ENTRIES`).
 */

import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import {
  decodeGrants,
  type PermissionGrant,
  type PersistedGrants,
} from '../../shared/permissions/grants.ts';

type Log = (...args: unknown[]) => void;

/** A grant set is a few hundred bytes; anything this large is not one, and is not read. */
export const MAX_GRANTS_SIDECAR_BYTES = 1024 * 1024;

function errnoOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

/** The file's bytes, `null` when there is none; throws for anything else. */
function readBounded(file: string): Buffer | null {
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch (error) {
    if (errnoOf(error) === 'ENOENT') return null;
    throw error;
  }
  try {
    const { size } = fstatSync(fd);
    if (size > MAX_GRANTS_SIDECAR_BYTES) {
      throw new Error(`larger than ${MAX_GRANTS_SIDECAR_BYTES} bytes (${size})`);
    }
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** The grants a session starts with; `[]` for none, and for anything unreadable (logged). */
export function readGrantSidecar(file: string, log?: Log): PermissionGrant[] {
  let bytes: Buffer | null;
  try {
    bytes = readBounded(file);
  } catch (error) {
    log?.('[dsh-bridge] grants ignored: cannot read', file, error);
    return [];
  }
  if (bytes === null) return [];
  let data: unknown;
  try {
    data = JSON.parse(bytes.toString('utf8'));
  } catch {
    log?.('[dsh-bridge] grants ignored: not JSON', file);
    return [];
  }
  const grants = decodeGrants(data);
  if (!grants) {
    log?.('[dsh-bridge] grants ignored: not a grant set this build reads', file);
    return [];
  }
  return grants;
}

/** Temp file + fsync + rename, owner-only; on failure the temp file goes and the error is thrown. */
function writeAtomically(file: string, data: Buffer): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temp, 'wx', 0o600);
    try {
      for (let offset = 0; offset < data.length; ) {
        offset += writeSync(fd, data, offset, data.length - offset);
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, file);
  } catch (error) {
    try {
      rmSync(temp, { force: true });
    } catch {
      // The write failed already; a stray temp file is not a second failure.
    }
    throw error;
  }
}

/** The whole grant set, replacing the file; false when it could not be written (logged). */
export function writeGrantSidecar(file: string, record: PersistedGrants, log?: Log): boolean {
  try {
    writeAtomically(file, Buffer.from(`${JSON.stringify(record)}\n`, 'utf8'));
    return true;
  } catch (error) {
    log?.('[dsh-bridge] grants not written', file, error);
    return false;
  }
}

/** A fork's grants (decision 043): `from`, byte for byte, at `to`. False when nothing was copied. */
export function copyGrantSidecar(from: string, to: string, log?: Log): boolean {
  try {
    const bytes = readBounded(from);
    if (bytes === null) return false;
    writeAtomically(to, bytes);
    return true;
  } catch (error) {
    log?.('[dsh-bridge] grants not copied', from, to, error);
    return false;
  }
}
