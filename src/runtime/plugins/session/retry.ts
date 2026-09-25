/**
 * T135 / decision 045 — where the failure card's 「继续」 re-runs a turn from.
 *
 * A retry appends no user message. It re-asks the model from the context the
 * failed request was sent with, which is the same rewind the in-run stream
 * recovery performs (`agent-loop/streamRecovery.ts`, rule 2): only the failed
 * reply is dropped, and every tool round the turn already completed stays —
 * those tools ran and changed the workspace, and running them again from the
 * user's message would repeat their side effects.
 *
 * "Dropped" means left on an abandoned branch, never deleted: the leaf moves
 * back over the failed reply, and the retry's own reply grows as its sibling.
 * The tree keeps both, so the failed attempt is still there to inspect.
 */

import type { AgentMessage, Entry } from '@earendil-works/pi-agent-core';
import {
  LOOP_GUARD_CUSTOM_TYPE,
  RUN_STOP_CUSTOM_TYPE,
} from '../../../shared/types/sessionHistory.ts';
import { isSuccessfulMessage } from './codec.ts';
import { interruptedToolResults } from './recovery.ts';

/**
 * Records a run writes after its last reply. Stepping over them is safe: they
 * are evidence about the attempt being abandoned, never model context.
 */
const TRAILING_RUN_RECORDS: readonly string[] = [RUN_STOP_CUSTOM_TYPE, LOOP_GUARD_CUSTOM_TYPE];

export interface SessionRetryPoint {
  /** Where the leaf sits for the re-run; the failed replies hang off it. */
  leafId: string | null;
  /** Failed replies stepped over onto the abandoned branch (0 = leaf unchanged). */
  abandoned: number;
}

/**
 * The entry a retry resumes from, as an index into `branch` (root first).
 *
 * Walks back over trailing failed replies (and the run records after them).
 * Stops at anything else — a compaction, a permission record, a delegation
 * record — rather than abandoning state the user or the runtime deliberately
 * added after the failure; the context there is still the pre-failure one,
 * because failed replies never enter the model context (`snapshot`).
 */
export function retryCut(branch: readonly Entry[]): { index: number; abandoned: number } {
  let index = branch.length - 1;
  let abandoned = 0;
  while (index >= 0) {
    const entry = branch[index];
    if (
      entry.type === 'message' &&
      entry.message.role === 'assistant' &&
      !isSuccessfulMessage(entry.message)
    ) {
      abandoned += 1;
      index -= 1;
      continue;
    }
    if (entry.type === 'custom' && TRAILING_RUN_RECORDS.includes(entry.customType)) {
      index -= 1;
      continue;
    }
    break;
  }
  // Nothing failed at the tail: stay where the leaf already is.
  return abandoned > 0 ? { index, abandoned } : { index: branch.length - 1, abandoned: 0 };
}

/**
 * Whether a model request can start from `context` without a new user message.
 *
 * The context must end where a turn was cut short: on a user message (the
 * failed reply was the turn's first) or a tool result (it failed after a tool
 * round). A successful reply there means the last turn COMPLETED, and a bare
 * compaction summary means the turn was folded into it, so neither has a
 * request to repeat. An assistant whose tool calls never got results (a crash
 * mid-tool) is retryable: the run closes them with synthetic results before
 * the request (`interruptedToolResults`).
 */
export function isRetryableContext(context: readonly AgentMessage[]): boolean {
  const last = context.at(-1);
  if (!last) return false;
  if (last.role === 'user' || last.role === 'toolResult') return true;
  return last.role === 'assistant' && interruptedToolResults(context).length > 0;
}
