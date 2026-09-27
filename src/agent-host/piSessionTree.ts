// Thin wrapper (dsh-rebase P1-9a): the tree projection lives in src/shared/legacyPiSession/tree.ts.

import { LegacyPiSessionError } from '../shared/legacyPiSession/errors.ts';
import * as shared from '../shared/legacyPiSession/tree.ts';
import type { SessionTreeSnapshot } from '../shared/types/sessionHistory.ts';
import { PiWorkerSessionError } from './piWorkerErrors.ts';

export { type PiTreeSessionManager, readPiLeafCheckpoint } from '../shared/legacyPiSession/tree.ts';

/** The shared projection, refusing with the worker's own error type as it always has. */
export function buildPiSessionTreeSnapshot(
  input: Parameters<typeof shared.buildPiSessionTreeSnapshot>[0]
): SessionTreeSnapshot {
  try {
    return shared.buildPiSessionTreeSnapshot(input);
  } catch (error) {
    if (error instanceof LegacyPiSessionError)
      throw new PiWorkerSessionError(error.code, error.message);
    throw error;
  }
}
