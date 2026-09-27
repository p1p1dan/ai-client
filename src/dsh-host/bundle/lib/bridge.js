/**
 * aiclient-bridge — the chat engine's worker RPC row (P0-3, P1-1).
 *
 * Serves ai-client's worker RPC on the Node IPC channel Main's WorkerSlot
 * opened, with the unmodified `PiWorkerRpcServer` from `src/agent-host` and a
 * `DshSessionRuntime` (src/dsh-host/bridge) in place of `NativeWorkerRuntime`.
 * The host launcher buffers IPC from its first line; this row claims that
 * buffer once the services it needs exist. Enabled only with
 * AICLIENT_DSH_BRIDGE=1 (see cordis.patch.yml), which Main's DshHostProcess
 * sets for every chat session.
 *
 * Imports product TypeScript by path, which exists in a source checkout only;
 * P1-2 bundles it for the packaged host.
 * @module @aiclient/dsh-app/bridge
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm';

/** Stable Cordis plugin name. */
export const name = 'aiclient-bridge';

/**
 * The services DshSessionRuntime reads. `sessions` is the durability barrier a
 * new session is flushed through before its identity stub is written
 * (dsh-rebase decision 007).
 */
export const inject = ['agents', 'agentDefaultModel', 'sessions'];

function unsupported(what) {
  const error = new Error(`${what} is not bridged to the DSH engine (P0-3 minimal bridge)`);
  error.code = 'WORKER_DSH_UNSUPPORTED';
  return error;
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export async function apply(ctx) {
  const inbox = globalThis[Symbol.for('aiclient.dsh.bridge')];
  const generation = Number(process.env.AICLIENT_PI_WORKER_GENERATION);
  if (!inbox || typeof process.send !== 'function' || !Number.isSafeInteger(generation)) {
    ctx
      .logger('aiclient-bridge')
      .warn('no bridge inbox, IPC channel or generation; bridge is inert');
    return;
  }
  const [{ PiWorkerRpcServer }, { DshSessionRuntime }] = await Promise.all([
    import(new URL('../../../agent-host/piWorkerRpcServer.ts', import.meta.url).href),
    import(new URL('../../bridge/dshSessionRuntime.ts', import.meta.url).href),
  ]);
  const server = new PiWorkerRpcServer({
    port: {
      postMessage(message) {
        if (process.connected) process.send(message);
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
