/**
 * aiclient-rewind-experiment — the dsh-rebase P1-4b pre-work experiments
 * (plan P1-4 §8, decision 027), driven by tools/rewind-experiments.ts.
 *
 * Never part of the repo's probe bundle: the driver copies tools/probe-bundle
 * to a scratch directory, adds this file and one row for it, and installs that
 * copy into its own scratch DSH_HOME. It talks over the Node IPC channel:
 *
 *   parent -> host  { rx4b: op, requestId, ... }
 *   host -> parent  { rx4bReply: op, requestId, ... }   (or `error`)
 *
 *   create { sessionId, cwd, seed?, inheritedEventCount?, parentSession?, isSeeded? }
 *                                 agents.create + sessions.flush; answers the stat after
 *   prompt { sessionId, text }    followup, then whenIdle
 *   observe { sessionId }         sessionQuery.observeSession: the events
 *   stat { sessionId }            sessionPersistence.stat (sizeBytes once on disk)
 *   dispose { sessionId }         the handle's dispose, timed
 *   resume { sessionId }          agents.resume, timed; a refusal answers its error name
 *   dsh-fork-seed { modulePath, events, boundary }
 *                                 DSH's own buildForkSeed, imported from `modulePath`
 *   maintenance-wake { sessionId, text, cancelDisposed, settleMs }
 *                                 runMaintenance: a followup arrives inside the task;
 *                                 optionally cancel({kind:'disposed'},{keepInbox:true})
 *                                 at its end. Answers the turns the agent started
 *                                 within `settleMs` after the task, and its inbox.
 * @module @aiclient/dsh-probe/rewind-experiment
 */

import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

export const name = 'aiclient-rewind-experiment';
export const inject = ['agents', 'agentDefaultModel', 'sessions', 'sessionQuery'];

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
  /** sessionId -> turn/start seqs, as appended. */
  const turnStarts = new Map();
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'turn/start') return;
    const list = turnStarts.get(session?.id) ?? [];
    list.push({ seq: event.seq, at: performance.now() });
    turnStarts.set(session?.id, list);
  });

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

  const ops = {
    async create(message) {
      const started = performance.now();
      const meta = {
        cwd: message.cwd,
        ...(message.parentSession ? { parentSession: message.parentSession } : {}),
        ...(message.isSeeded ? { isSeeded: true } : {}),
      };
      const handle = await ctx.agents.create({
        sessionId: message.sessionId,
        meta,
        ...(message.seed ? { seed: message.seed } : {}),
        ...(message.inheritedEventCount !== undefined
          ? { inheritedEventCount: message.inheritedEventCount }
          : {}),
        agentOptions: selection(),
      });
      handles.set(message.sessionId, handle);
      const createdMs = performance.now() - started;
      const flushed = await ctx.sessions.flush(handle.agent.session);
      return {
        createdMs: Math.round(createdMs),
        flushMs: Math.round(performance.now() - started - createdMs),
        flushed,
        statAfterFlush: await stat(message.sessionId),
      };
    },
    async prompt(message) {
      const { agent } = handleOf(message.sessionId);
      agent.followup(
        createUserMessage({
          content: [{ type: 'text', text: message.text }],
          source: { kind: 'user' },
        })
      );
      const idle = await Promise.race([
        agent.whenIdle().then(() => true),
        sleep(message.timeoutMs ?? 60_000).then(() => false),
      ]);
      return { idle, status: agent.status };
    },
    async observe(message) {
      const observation = await ctx.sessionQuery.observeSession(message.sessionId, {
        projectionMode: 'none',
      });
      try {
        return {
          source: observation.source,
          header: observation.header,
          inheritedEventCount: observation.inheritedEventCount,
          cursor: observation.cursor,
          events: [...observation.events],
        };
      } finally {
        observation[Symbol.dispose]?.();
      }
    },
    async stat(message) {
      return { stat: await stat(message.sessionId) };
    },
    async dispose(message) {
      const handle = handleOf(message.sessionId);
      const started = performance.now();
      handles.delete(message.sessionId);
      await handle.dispose();
      return { ms: Math.round(performance.now() - started) };
    },
    async resume(message) {
      const started = performance.now();
      try {
        const handle = await ctx.agents.resume({
          resumeSessionId: message.sessionId,
          agentOptions: selection(),
        });
        handles.set(message.sessionId, handle);
        return { ok: true, ms: Math.round(performance.now() - started) };
      } catch (error) {
        return {
          ok: false,
          ms: Math.round(performance.now() - started),
          errorName: errorName(error),
          message: String(error?.message ?? error).slice(0, 300),
        };
      }
    },
    async 'dsh-fork-seed'(message) {
      const module = await import(pathToFileURL(message.modulePath).href);
      return { seed: module.buildForkSeed(message.events, message.boundary) };
    },
    async 'maintenance-wake'(message) {
      const { agent } = handleOf(message.sessionId);
      const before = (turnStarts.get(message.sessionId) ?? []).length;
      let insideStatus;
      const released = await agent
        .runMaintenance(async (signal) => {
          agent.followup(
            createUserMessage({
              content: [{ type: 'text', text: message.text }],
              source: { kind: 'user' },
            })
          );
          await sleep(200);
          insideStatus = agent.status;
          if (message.cancelDisposed) agent.cancel({ kind: 'disposed' }, { keepInbox: true });
          return { aborted: signal.aborted };
        })
        .then(
          (value) => ({ ok: true, ...value }),
          (error) => ({ ok: false, errorName: errorName(error) })
        );
      await sleep(message.settleMs ?? 1500);
      const turnsAfter = (turnStarts.get(message.sessionId) ?? []).length - before;
      const inbox = ctx.get('sessionProjections')?.stateOf?.(agent.session, 'inbox');
      if (turnsAfter > 0) {
        await Promise.race([agent.whenIdle(), sleep(30_000)]);
      }
      return {
        released,
        insideStatus,
        turnsStartedAfter: turnsAfter,
        statusAfter: agent.status,
        inboxPending: inbox
          ? { nextTurn: inbox['next-turn']?.length ?? 0, nextStep: inbox['next-step']?.length ?? 0 }
          : null,
      };
    },
  };

  const onMessage = (message) => {
    if (message === null || typeof message !== 'object' || typeof message.rx4b !== 'string') return;
    const op = ops[message.rx4b];
    if (!op) {
      send({ rx4bReply: message.rx4b, requestId: message.requestId, error: 'unknown op' });
      return;
    }
    Promise.resolve()
      .then(() => op(message))
      .then(
        (answer) => send({ rx4bReply: message.rx4b, requestId: message.requestId, ...answer }),
        (error) =>
          send({
            rx4bReply: message.rx4b,
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
  }, 'aiclient-rewind-experiment.ipc');
}
