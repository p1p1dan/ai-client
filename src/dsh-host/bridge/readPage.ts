/**
 * Decision 030: one page of a DSH session's history for Main's preview, read
 * without opening the session (dsh-rebase P1-4a; plan P1-4 §4.8).
 *
 * A preview must not cost what a resume costs: no channel, no agent, no write
 * lock, and above all no write — a resume appends `session/end-seed`, so
 * "looking" at a session through it changed the log (P0-6). This read takes
 * the stub as a resume does, checks it names the logical session Main asked
 * about, and folds `ctx.sessionQuery.observeSession`: the live snapshot when
 * this host has the session open, otherwise a cold read that holds only a
 * short read handle and closes an interrupted last turn in memory, never on
 * disk. The projection and the paging are the bridge cache's own
 * (`historyCache.ts`), so a preview shows what a resume would.
 */

import { PiWorkerSessionError } from '../../agent-host/piWorkerErrors.ts';
import { paginateHistory } from '../../shared/dshHistory/page.ts';
import { DshHistoryFold } from '../../shared/dshHistory/projection.ts';
import type { SessionHistoryPage } from '../../shared/types/sessionHistory.ts';
import { mapOpenError } from './dshSessionRuntime.ts';
import type { DshSessionObservation, DshSessionQuery } from './historyCache.ts';
import { readStub, SESSION_INVALID } from './stub.ts';

export interface ReadPageRequest {
  stubFile: string;
  logicalSessionId: string;
  offset?: number;
  limit?: number;
}

export async function readSessionPage(
  query: DshSessionQuery,
  request: ReadPageRequest
): Promise<SessionHistoryPage> {
  const stub = readStub(request.stubFile);
  if (stub.logicalSessionId !== request.logicalSessionId) {
    throw new PiWorkerSessionError(
      SESSION_INVALID,
      `DSH session identity ${request.stubFile} belongs to ${stub.logicalSessionId}, not ${request.logicalSessionId}`
    );
  }
  let observation: DshSessionObservation;
  try {
    observation = await query.observeSession(stub.dshSessionId, { projectionMode: 'none' });
  } catch (error) {
    throw mapOpenError(error, stub.dshSessionId);
  }
  try {
    const fold = new DshHistoryFold();
    for (const event of observation.events) fold.push(event);
    return paginateHistory(fold.messages(), request.offset, request.limit);
  } finally {
    observation[Symbol.dispose]?.();
  }
}
