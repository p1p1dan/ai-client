/**
 * aiclient-bridge — the chat engine's worker RPC row (P0-3, P1-1).
 *
 * Serves ai-client's worker RPC on the Node IPC channel Main's WorkerSlot
 * opened, with the unmodified `PiWorkerRpcServer` from `src/agent-host` and a
 * `DshSessionRuntime` in place of `NativeWorkerRuntime`. The host launcher
 * buffers IPC from its first line; this row claims that buffer once the
 * services it needs exist. Enabled only with AICLIENT_DSH_BRIDGE=1 (see
 * `bundle/cordis.patch.yml`), which Main's DshHostProcess sets for every chat
 * session.
 *
 * Two ways in (dsh-rebase decision 011): a source checkout loads this file
 * through `bundle/lib/bridge.js`, a one-line re-export; the packaged host loads
 * the esbuild bundle of it that `scripts/build-dsh-host.mjs` writes over that
 * re-export, with every npm package left external.
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { PiWorkerRpcServer } from '../../agent-host/piWorkerRpcServer.ts';
import { type DshBridgeContext, DshSessionRuntime } from './dshSessionRuntime.ts';

/** Stable Cordis plugin name. */
export const name = 'aiclient-bridge';

/**
 * The services DshSessionRuntime reads. `sessions` is the durability barrier a
 * new session is flushed through before its identity stub is written
 * (dsh-rebase decision 007). `agentLoop` registers the factory `agents.create`
 * needs; without it the first worker.bootstrap can reach the registry before
 * the loop row starts and fail with "no agent factory registered" (P1-2: the
 * dynamic imports this row used to await had been hiding that race).
 */
export const inject = ['agents', 'agentDefaultModel', 'sessions', 'agentLoop'];

/** Shared with host.ts through a global symbol; filled from the host's first line. */
interface BridgeInbox {
  queue: unknown[];
  deliver?: (message: unknown) => void;
  stop?: (reason: string) => Promise<void>;
}

/** The slice of the row's Cordis context used here, besides what the runtime reads. */
interface BridgeRowContext extends DshBridgeContext {
  logger(name: string): { warn(...args: unknown[]): void };
  effect(body: () => () => void, label?: string): void;
}

function unsupported(what: string): Error {
  return Object.assign(
    new Error(`${what} is not bridged to the DSH engine (P0-3 minimal bridge)`),
    { code: 'WORKER_DSH_UNSUPPORTED' }
  );
}

export async function apply(ctx: BridgeRowContext): Promise<void> {
  const inbox = (globalThis as Record<symbol, unknown>)[Symbol.for('aiclient.dsh.bridge')] as
    | BridgeInbox
    | undefined;
  const generation = Number(process.env.AICLIENT_PI_WORKER_GENERATION);
  const send = process.send?.bind(process);
  if (!inbox || send === undefined || !Number.isSafeInteger(generation)) {
    ctx
      .logger('aiclient-bridge')
      .warn('no bridge inbox, IPC channel or generation; bridge is inert');
    return;
  }
  const server = new PiWorkerRpcServer({
    port: {
      postMessage(message) {
        if (process.connected) send(message);
      },
    },
    generation,
    // Same constant the native worker entry passes (decision 009).
    projectTrusted: true,
    createRuntime: (options) => new DshSessionRuntime(ctx, options, { createUserMessage }),
    createImportWriter: () => {
      throw unsupported('Conversation import');
    },
    createUtilityRuntime: () => {
      throw unsupported('One-shot completion');
    },
    log: (...args) => console.error('[aiclient-bridge]', ...args),
    onDisposed: () => {
      void inbox.stop?.('worker.dispose');
    },
  });
  ctx.effect(() => {
    inbox.deliver = (message) => server.receive(message);
    for (const message of inbox.queue.splice(0)) server.receive(message);
    return () => {
      inbox.deliver = undefined;
    };
  }, 'aiclient-bridge.ipc');
}
