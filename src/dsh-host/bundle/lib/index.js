/**
 * aiclient-probe — P0-1 stand-in for the future aiclient-bridge row.
 *
 * Serves a tiny request/response protocol over the Node IPC channel the parent
 * opened (stdio 'ipc'), so a supervisor can create and close sessions and read
 * memory stats without any model call:
 *   { type: 'create-session', requestId, cwd? } -> { type: 'session-created', requestId, sessionId, ms }
 *   { type: 'close-session', requestId, sessionId } -> { type: 'session-closed', requestId, ms }
 *   { type: 'stats', requestId } -> { type: 'stats', requestId, memory, liveAgents }
 * Any failure answers { type: 'probe-error', requestId, message }.
 * @module @aiclient/dsh-app
 */

import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

/** Stable Cordis plugin name. */
export const name = 'aiclient-probe';

/** The agent registry (dsh-agent) and the default route (dsh-agent-default-model). */
export const inject = ['agents', 'agentDefaultModel'];

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  if (typeof process.send !== 'function') {
    ctx.logger('aiclient-probe').warn('no IPC channel; probe is inert');
    return;
  }
  /** @type {Map<string, { dispose(): Promise<void> }>} */
  const handles = new Map();

  const reply = (message) => {
    if (process.connected) process.send(message);
  };

  const createSession = async (message) => {
    const started = performance.now();
    const sessionId = `aiclient-probe-${randomUUID()}`;
    const { provider, model } = ctx.agentDefaultModel.currentSelection();
    const handle = await ctx.agents.create({
      sessionId,
      meta: { cwd: typeof message.cwd === 'string' ? message.cwd : process.cwd() },
      agentOptions: { provider, model },
    });
    handles.set(sessionId, handle);
    reply({
      type: 'session-created',
      requestId: message.requestId,
      sessionId,
      provider,
      model,
      ms: performance.now() - started,
    });
  };

  const closeSession = async (message) => {
    const started = performance.now();
    const handle = handles.get(message.sessionId);
    if (handle === undefined) throw new Error(`unknown probe session ${message.sessionId}`);
    handles.delete(message.sessionId);
    await handle.dispose();
    reply({
      type: 'session-closed',
      requestId: message.requestId,
      ms: performance.now() - started,
    });
  };

  const onMessage = (message) => {
    if (message === null || typeof message !== 'object') return;
    const run = async () => {
      switch (message.type) {
        case 'create-session':
          return createSession(message);
        case 'close-session':
          return closeSession(message);
        case 'stats':
          return reply({
            type: 'stats',
            requestId: message.requestId,
            memory: process.memoryUsage(),
            liveAgents: ctx.agents.list().length,
          });
        default:
          return undefined;
      }
    };
    run().catch((error) => {
      reply({
        type: 'probe-error',
        requestId: message.requestId,
        message: error instanceof Error ? (error.stack ?? error.message) : String(error),
      });
    });
  };

  ctx.effect(() => {
    process.on('message', onMessage);
    return async () => {
      process.off('message', onMessage);
      for (const handle of handles.values()) await handle.dispose();
      handles.clear();
    };
  }, 'aiclient-probe.ipc');
}
