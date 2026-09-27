/**
 * The runtime's view of the session codec: a thin wrapper (dsh-rebase P1-9a).
 *
 * The decoder itself — v4 rows, CLI rows, torn tails, dropped middle rows, the
 * seq and lane invariants — lives in `src/shared/legacyPiSession/codec.ts`, so
 * the migration can read a 1.0.x session after this runtime is gone. What stays
 * here is only what is the runtime's own: pi-agent-core's types, which the store
 * and the loop are written against, and `RuntimeHostError`, which every caller
 * of a refused session tests for. P1-12 deletes this file with the runtime.
 */

import type { AgentMessage, Entry, JsonlV4Header } from '@earendil-works/pi-agent-core';
import * as shared from '../../../shared/legacyPiSession/codec.ts';
import { LegacyPiSessionError } from '../../../shared/legacyPiSession/errors.ts';
import { RuntimeHostError } from '../../host/errors.ts';

export {
  CLI_BOOKKEEPING_TYPE,
  cliBookkeeping,
  interopHeader,
  isInteropHeader,
  SESSION_MAX_BYTES,
  type SessionFileHeader,
  type SessionSkippedRow,
} from '../../../shared/legacyPiSession/codec.ts';

/** The shared document, typed the way the store reads and extends it. */
export interface SessionDocument extends Omit<shared.SessionDocument, 'header' | 'entries'> {
  header: JsonlV4Header;
  entries: Entry[];
}

/**
 * Run a shared-library call, rethrowing its refusals as `RuntimeHostError`.
 *
 * The runtime branches on `instanceof RuntimeHostError` (the worker's run
 * refusals, the loop's error codes), so the error type is part of this
 * wrapper's contract; code, message and cause pass through unchanged.
 */
export function withHostErrors<T>(call: () => T): T {
  try {
    return call();
  } catch (error) {
    if (error instanceof LegacyPiSessionError)
      throw new RuntimeHostError(
        error.code,
        error.message,
        error.cause === undefined ? undefined : { cause: error.cause }
      );
    throw error;
  }
}

export function decodeSession(content: string): SessionDocument {
  // The shared structural types are wider than pi's (a string where pi has a
  // union), so the decoded document is handed back under pi's names.
  return withHostErrors(() => shared.decodeSession(content)) as unknown as SessionDocument;
}

export function branchEntries(document: SessionDocument, leafId = document.leafId): Entry[] {
  return withHostErrors(() => shared.branchEntries(document, leafId)) as unknown as Entry[];
}

export function isSuccessfulMessage(m: AgentMessage): boolean {
  return shared.isSuccessfulMessage(m);
}
