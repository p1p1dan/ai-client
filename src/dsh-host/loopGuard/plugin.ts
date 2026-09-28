/**
 * aiclient-loop-guard — ai-client's run guards as a DSH host row (dsh-rebase
 * P1-8; decisions 065, 066): a reply that keeps repeating delegation calls is
 * cut while it streams, and an agent stops after 500 steps with a tool-less
 * wrap-up. The behaviour lives in `loopGuard.ts`; this file wires it to the
 * row's Cordis context and dsh-llm.
 *
 * On in the product bundle, and host.ts refuses a composition that turns the
 * row off. `AICLIENT_RUNTIME_LOOP_GUARD=0` (forwarded by Main) is the
 * emergency switch; the row's `stepCeiling` config replaces 500.
 *
 * Two ways in, like the bridge row (decision 011): a source checkout loads
 * `bundle/lib/loop-guard.js`, a one-line re-export of this file; the packaged
 * host loads the esbuild bundle scripts/build-dsh-host.mjs writes over it.
 */

import { createUserMessage, isAgentLoopRequest } from '@deepseek-ai/dsh-llm';
import { LOOP_GUARD_ROW } from './constants.ts';
import {
  installLoopGuard,
  type LoopGuardRowContext,
  resolveLoopGuardSettings,
} from './loopGuard.ts';
import type { CreateUserMessage } from './stepCeiling.ts';

export type { DshLoopGuard } from './loopGuard.ts';

/** Stable Cordis plugin name. */
export const name = LOOP_GUARD_ROW;

/**
 * Nothing here reads `tools`; waiting for it makes this row start alongside
 * aiclient-permissions and, being listed after it, register its prepended
 * `tools/pre-execute` listener later, i.e. in front of the permission gate.
 */
export const inject = ['tools'];

export function apply(ctx: LoopGuardRowContext, config?: unknown): void {
  const log = (line: string) => console.error(`[${LOOP_GUARD_ROW}] ${line}`);
  installLoopGuard(ctx, resolveLoopGuardSettings(config, process.env, log), {
    isAgentLoopRequest,
    createUserMessage: createUserMessage as unknown as CreateUserMessage,
    log,
  });
}
