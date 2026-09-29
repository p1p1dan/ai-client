/**
 * aiclient-seed-experiment — the dsh-rebase P1-9c pre-work experiments E1 and
 * E2 (plan P1-9 shard 05 §1, decisions 053 and 054), driven by
 * tools/seed-experiments.ts.
 *
 * Never part of the repo's probe bundle: the driver copies tools/probe-bundle
 * to a scratch directory, adds this file and one row for it, and installs that
 * copy into its own scratch DSH_HOME. It talks over the Node IPC channel:
 *
 *   parent -> host  { rx9c: op, requestId, ... }
 *   host -> parent  { rx9cReply: op, requestId, ... }   (or `error`)
 *
 *   admit { images: [{key, mediaType, data, name?}] }
 *                                 ctx.attachments.admitPromptContent, one image per call:
 *                                 the reference per key, or the refusal's code
 *   create { sessionId, cwd, seed, parentSession?, isSeeded?, inheritedEventCount? }
 *                                 agents.create + sessions.flush; answers the stat after,
 *                                 or the error's name chain
 *   observe { sessionId }         sessionQuery.observeSession: source and events
 *   dispose { sessionId }         the handle's dispose, timed
 *   resume { sessionId, cwd }     agents.resume, timed; a refusal answers its error name
 *   prompt { sessionId, text }    followup, then whenIdle
 *   dsh-fork-seed { modulePath, events, boundary }
 *                                 DSH's own buildForkSeed, imported from `modulePath`
 * @module @aiclient/dsh-probe/seed-experiment
 */

import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

export const name = 'aiclient-seed-experiment';
export const inject = ['agents', 'agentDefaultModel', 'sessions', 'sessionQuery', 'attachments'];

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function errorName(error) {
  const names = [];
  let current = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    names.push(current.name ?? 'Error');
    current = current.cause;
  }
  return names.join(' <- ');
}

/** The messages along the cause chain, each cut short. */
function messages(error) {
  const out = [];
  let current = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    out.push(String(current.message ?? current).slice(0, 400));
    current = current.cause;
  }
  return out.join(' <- ');
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  if (typeof process.send !== 'function') return;
  const send = (message) => {
    if (process.connected) process.send(message);
  };
  /** @type {Map<string, { dispose(): Promise<void>, agent: any }>} */
  const handles = new Map();

  const selection = () => {
    const { provider, model } = ctx.agentDefaultModel.currentSelection();
    return { provider, model };
  };
  const handleOf = (sessionId) => {
    const handle = handles.get(sessionId);
    if (!handle) throw new Error(`no handle for ${sessionId}`);
    return handle;
  };
  const stat = async (sessionId) => {
    const persistence = ctx.get('sessionPersistence');
    const snapshot = await persistence?.stat(sessionId);
    return snapshot ? { sizeBytes: snapshot.sizeBytes ?? null, revision: snapshot.revision } : null;
  };

  // These sessions are not the bridge's, so nothing attaches a gate to them;
  // an allow-all stand-in keeps the permission row from refusing a tool call
  // (the experiments measure the engine, not the gate).
  const standInGate = {
    authorize: async () => {},
    canTraverse: () => true,
    onActivity: () => () => {},
  };
  const attachStandIn = (sessionId, cwd) => {
    try {
      ctx.get('aiclientPermissions')?.attachGate(`seed-experiment:${sessionId}`, {
        dshSessionId: sessionId,
        gate: standInGate,
        cwd,
      });
    } catch {
      // Already routed; its gate stands.
    }
  };

  const ops = {
    async admit(message) {
      const refs = {};
      const refused = {};
      for (const image of message.images ?? []) {
        try {
          const [part] = await ctx.attachments.admitPromptContent([
            {
              type: 'image',
              mediaType: image.mediaType,
              data: image.data,
              ...(image.name ? { name: image.name } : {}),
            },
          ]);
          refs[image.key] = part?.type === 'image' ? part.attachment : null;
        } catch (error) {
          refused[image.key] = {
            code: error?.code,
            isAttachmentError: ctx.attachments.isAttachmentError(error),
            message: String(error?.message ?? error).slice(0, 200),
          };
        }
      }
      return { refs, refused };
    },
    async create(message) {
      attachStandIn(message.sessionId, message.cwd);
      const started = performance.now();
      const meta = {
        cwd: message.cwd,
        ...(message.parentSession ? { parentSession: message.parentSession } : {}),
        ...(message.isSeeded ? { isSeeded: true } : {}),
      };
      let handle;
      try {
        handle = await ctx.agents.create({
          sessionId: message.sessionId,
          meta,
          ...(message.seed ? { seed: message.seed } : {}),
          ...(message.inheritedEventCount !== undefined
            ? { inheritedEventCount: message.inheritedEventCount }
            : {}),
          agentOptions: selection(),
        });
      } catch (error) {
        return {
          ok: false,
          ms: Math.round(performance.now() - started),
          errorName: errorName(error),
          message: messages(error),
        };
      }
      handles.set(message.sessionId, handle);
      const createdMs = performance.now() - started;
      const flushed = await ctx.sessions.flush(handle.agent.session);
      return {
        ok: true,
        createdMs: Math.round(createdMs),
        flushMs: Math.round(performance.now() - started - createdMs),
        flushed,
        status: handle.agent.status,
        statAfterFlush: await stat(message.sessionId),
      };
    },
    async observe(message) {
      try {
        const observation = await ctx.sessionQuery.observeSession(message.sessionId, {
          projectionMode: 'none',
        });
        try {
          return {
            ok: true,
            source: observation.source,
            header: observation.header,
            inheritedEventCount: observation.inheritedEventCount,
            events: [...observation.events],
          };
        } finally {
          observation[Symbol.dispose]?.();
        }
      } catch (error) {
        return { ok: false, errorName: errorName(error), message: messages(error) };
      }
    },
    async dispose(message) {
      const handle = handleOf(message.sessionId);
      const started = performance.now();
      handles.delete(message.sessionId);
      await handle.dispose();
      return { ms: Math.round(performance.now() - started) };
    },
    async resume(message) {
      attachStandIn(message.sessionId, message.cwd);
      const started = performance.now();
      try {
        const handle = await ctx.agents.resume({
          resumeSessionId: message.sessionId,
          agentOptions: selection(),
        });
        handles.set(message.sessionId, handle);
        return {
          ok: true,
          ms: Math.round(performance.now() - started),
          status: handle.agent.status,
        };
      } catch (error) {
        return {
          ok: false,
          ms: Math.round(performance.now() - started),
          errorName: errorName(error),
          message: messages(error),
        };
      }
    },
    async prompt(message) {
      const { agent } = handleOf(message.sessionId);
      agent.followup(
        createUserMessage({
          content: [{ type: 'text', text: message.text }],
          source: { kind: 'user' },
        })
      );
      // The followup starts the turn on a later tick; whenIdle before that is already settled.
      await sleep(50);
      const idle = await Promise.race([
        agent.whenIdle().then(() => true),
        sleep(message.timeoutMs ?? 60_000).then(() => false),
      ]);
      return { idle, status: agent.status };
    },
    async 'dsh-fork-seed'(message) {
      const module = await import(pathToFileURL(message.modulePath).href);
      return { seed: module.buildForkSeed(message.events, message.boundary) };
    },
  };

  const onMessage = (message) => {
    if (message === null || typeof message !== 'object' || typeof message.rx9c !== 'string') return;
    const op = ops[message.rx9c];
    if (!op) {
      send({ rx9cReply: message.rx9c, requestId: message.requestId, error: 'unknown op' });
      return;
    }
    Promise.resolve()
      .then(() => op(message))
      .then(
        (answer) => send({ rx9cReply: message.rx9c, requestId: message.requestId, ...answer }),
        (error) =>
          send({
            rx9cReply: message.rx9c,
            requestId: message.requestId,
            error: error instanceof Error ? (error.stack ?? error.message) : String(error),
            errorName: errorName(error),
          })
      );
  };

  ctx.effect(() => {
    process.on('message', onMessage);
    return async () => {
      process.off('message', onMessage);
      for (const handle of handles.values()) await handle.dispose().catch(() => {});
      handles.clear();
    };
  }, 'aiclient-seed-experiment.ipc');
}
