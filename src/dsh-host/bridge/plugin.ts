/**
 * aiclient-bridge — the chat engine's worker RPC row (P0-3, P1-1, P1-3a).
 *
 * The one bridge of the shared DSH host (dsh-rebase decision 019): every chat
 * session is a channel on the Node IPC link Main's DshHostSupervisor opened,
 * served by `channelMux.ts` with an unmodified `PiWorkerRpcServer` and a
 * `DshSessionRuntime` per channel. The host launcher buffers IPC from its first
 * line; this row claims that buffer as soon as the services it needs exist,
 * and the launcher refuses to report ready over IPC until it has.
 *
 * Two ways in (dsh-rebase decision 011): a source checkout loads this file
 * through `bundle/lib/bridge.js`, a one-line re-export; the packaged host loads
 * the esbuild bundle of it that `scripts/build-dsh-host.mjs` writes over that
 * re-export, with every npm package left external.
 */

import { monitorEventLoopDelay } from 'node:perf_hooks';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { DshHostToMainMessage } from '../../shared/types/dshHostProtocol.ts';
import { DshChannelMux } from './channelMux.ts';
import {
  type DshBridgeContext,
  type DshBridgeDeps,
  type DshJobsView,
  DshSessionRuntime,
} from './dshSessionRuntime.ts';
import type { DshBridgeModelPlan } from './modelRoute.ts';
import { readSessionPage } from './readPage.ts';
import { collectOrphanSessions, type GcPersistence } from './sessionGc.ts';

/** Stable Cordis plugin name. */
export const name = 'aiclient-bridge';

/**
 * The services DshSessionRuntime reads. `sessions` is the durability barrier a
 * new session is flushed through before its identity stub is written
 * (dsh-rebase decision 007). `agentLoop` registers the factory `agents.create`
 * needs; without it the first worker.bootstrap can reach the registry before
 * the loop row starts and fail with "no agent factory registered" (P1-2: the
 * dynamic imports this row used to await had been hiding that race).
 * `sessionQuery` is the lock-free read the history cache folds, and Main's
 * preview reads through `readPage` (P1-4a, decision 030).
 */
export const inject = ['agents', 'agentDefaultModel', 'sessions', 'agentLoop', 'sessionQuery'];

/** Shared with host.ts through a global symbol; filled from the host's first line. */
interface BridgeInbox {
  queue: unknown[];
  deliver?: (message: unknown) => void;
}

/**
 * Sampling period of the event-loop delay monitor. A pong reports the worst
 * stall beyond it; Main only warns from 200 ms, so a coarse period will do and
 * keeps an idle host from waking often.
 */
const ELD_RESOLUTION_MS = 50;

/** The slice of the row's Cordis context used here, besides what the runtime reads. */
interface BridgeRowContext extends DshBridgeContext {
  logger(name: string): { warn(...args: unknown[]): void };
  effect(body: () => () => void, label?: string): void;
  /** Services the row reads without injecting them: absent ones are `undefined`. */
  get(name: 'jobs'): DshJobsView | undefined;
  get(name: 'sessionPersistence'): GcPersistence | undefined;
  /** Decision 033: provided by host.ts from Main's `configure`. */
  get(name: 'aiclientModelPlan'): DshBridgeModelPlan | undefined;
}

function tenths(value: number): number {
  return Math.round(value * 10) / 10;
}

export async function apply(ctx: BridgeRowContext): Promise<void> {
  const inbox = (globalThis as Record<symbol, unknown>)[Symbol.for('aiclient.dsh.bridge')] as
    | BridgeInbox
    | undefined;
  if (!inbox || typeof process.send !== 'function') {
    ctx.logger('aiclient-bridge').warn('no bridge inbox or IPC channel; bridge is inert');
    return;
  }
  const eld = monitorEventLoopDelay({ resolution: ELD_RESOLUTION_MS });
  const send = (message: DshHostToMainMessage): void => {
    if (!process.connected) return;
    // With a callback a send that loses the race with a disconnect is reported
    // here instead of as an 'error' event, which would take the host down.
    process.send?.(message, undefined, undefined, (error) => {
      if (error) console.error('[aiclient-bridge] IPC send failed:', error.message);
    });
  };
  const deps: DshBridgeDeps = {
    createUserMessage,
    // Decision 033: read per turn, so every turn routes by the plan the host runs.
    modelPlan: () => ctx.get('aiclientModelPlan'),
    installModelSelection: installModelSelection as unknown as NonNullable<
      DshBridgeDeps['installModelSelection']
    >,
  };
  const mux = new DshChannelMux({
    send,
    createRuntime: (options) => new DshSessionRuntime(ctx, options, deps),
    sample: () => {
      const worstMs = eld.max / 1e6;
      eld.reset();
      return {
        eldMaxMs: tenths(Math.max(0, worstMs - ELD_RESOLUTION_MS)),
        rssMb: tenths(process.memoryUsage.rss() / 1048576),
      };
    },
    // Decision 024. Looked up per pass, not injected: the row's start does not
    // wait on it, and a host without it answers the pass `ok: false`.
    collectSessions: (request) => {
      const persistence = ctx.get('sessionPersistence');
      const home = process.env.DSH_HOME;
      if (!persistence || !home) {
        return Promise.reject(new Error('no session persistence or DSH_HOME in this host'));
      }
      return collectOrphanSessions(
        { persistence, home, log: (...args) => console.error('[aiclient-bridge]', ...args) },
        request
      );
    },
    // Decision 030: Main's preview, read without a channel.
    readPage: (request) => readSessionPage(ctx.sessionQuery, request),
    log: (...args) => console.error('[aiclient-bridge]', ...args),
  });
  ctx.effect(() => {
    eld.enable();
    inbox.deliver = (message) => {
      mux.receive(message);
    };
    for (const message of inbox.queue.splice(0)) mux.receive(message);
    return () => {
      inbox.deliver = undefined;
      eld.disable();
    };
  }, 'aiclient-bridge.ipc');
}
