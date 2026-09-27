/**
 * Decision 024, Main's half (dsh-rebase P1-3d): which DSH sessions the
 * session index still references. The host's `gc` pass never deletes these,
 * nor anything descending from them through `parentSession`, which only the
 * host can read (`src/dsh-host/bridge/sessionGc.ts`).
 *
 * Every index row counts, archived ones included. A row claims:
 *   - `aiclient-<its logical id>`, the id its stub would name (decision 006:
 *     a lost stub is found again from the logical id);
 *   - for a DSH identity (`<DSH_HOME>/aiclient-sessions/<id>.dsh.json`), the id
 *     in the file name, and what the stub itself names: `dshSessionId` and,
 *     once P1-4b writes one, its `lineage` (read with or without it).
 * A stub that cannot be read still claims the two ids its row implies.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { SessionIndexEntry } from '@shared/types/sessionIndex';

/** Decision 024: nothing created less than 24 h ago is ever collected. */
export const DSH_SESSION_GC_GRACE_MS = 24 * 60 * 60_000;

/** `dshSessionIdFor` in the bridge (decision 006). */
const DSH_SESSION_ID_PREFIX = 'aiclient-';
const DSH_STUB_SUFFIX = '.dsh.json';
/** A stub is a few hundred bytes; anything far larger is not one. */
const MAX_STUB_BYTES = 64 * 1024;

/** Production stub reader: the parsed JSON, `undefined` for a file too large to be a stub. */
export async function readDshSessionStub(file: string): Promise<unknown> {
  const text = await readFile(file, 'utf8');
  return text.length > MAX_STUB_BYTES ? undefined : JSON.parse(text);
}

/** The sessions a stub names: its own and, when present, its lineage (P1-4b, decision 027). */
function stubSessionIds(stub: unknown): string[] {
  if (typeof stub !== 'object' || stub === null) return [];
  const record = stub as { dshSessionId?: unknown; lineage?: unknown };
  const ids: unknown[] = [record.dshSessionId];
  if (Array.isArray(record.lineage)) {
    for (const item of record.lineage) {
      ids.push(
        typeof item === 'object' && item !== null
          ? (item as { dshSessionId?: unknown }).dshSessionId
          : item
      );
    }
  }
  return ids.filter((id): id is string => typeof id === 'string' && id.length > 0);
}

export async function claimedDshSessionIds(
  rows: readonly SessionIndexEntry[],
  readStub: (file: string) => Promise<unknown> = readDshSessionStub
): Promise<string[]> {
  const claimed = new Set<string>();
  for (const row of rows) {
    if (row.sessionId) claimed.add(`${DSH_SESSION_ID_PREFIX}${row.sessionId}`);
    const identity = row.runtimeIdentity?.trim();
    if (!identity?.endsWith(DSH_STUB_SUFFIX)) continue;
    const named = path.basename(identity).slice(0, -DSH_STUB_SUFFIX.length);
    if (named) claimed.add(named);
    let stub: unknown;
    try {
      stub = await readStub(identity);
    } catch {
      continue;
    }
    for (const id of stubSessionIds(stub)) claimed.add(id);
  }
  return [...claimed];
}
