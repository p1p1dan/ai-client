/**
 * aiclient-steer-experiment — the dsh-rebase P1-4c1 pre-work experiment
 * (rescope §8 item 1, decisions 093 and 094), driven by tools/steer-experiments.ts.
 *
 * Never part of the repo's probe bundle: the driver copies tools/probe-bundle
 * to a scratch directory, adds this file and one row for it, and installs that
 * copy into its own scratch DSH_HOME. The sessions it acts on are the product
 * bridge's own (opened through worker.bootstrap on a channel); this row only
 * reaches their agents through `ctx.agents.get`, the way a DSH plugin would.
 * It talks over the Node IPC channel:
 *
 *   parent -> host  { rx41: op, requestId, ... }
 *   host -> parent  { rx41Reply: op, requestId, ... }   (or `error`)
 *   host -> parent  { rx41Event: 'turn-stopping', sessionId, turn }
 *
 *   steer { sessionId, text }       agent.steer(createUserMessage(text, user)); answers the
 *                                   message id and the inbox right after
 *   arm-step-end { sessionId, text, mode: 'sync' | 'immediate' }
 *                                   steers on the session's next `step/end`: inside the
 *                                   listener (`sync`), or one macrotask later (`immediate`)
 *   hold-turn-stopping { sessionId, maxMs }
 *                                   the session's next `agent/turn-stopping` announces
 *                                   itself and waits for `release-turn-stopping` (or maxMs)
 *   release-turn-stopping { sessionId }
 *   cancel { sessionId, keepInbox, thenSteer? }
 *                                   agent.cancel({kind:'user'}, {keepInbox}); `thenSteer`
 *                                   steers synchronously right after it
 *   inbox { sessionId }             the agent's status and pending ids
 *   turns { sessionId, ends, timeoutMs }
 *                                   waits until the session logged `ends` turn/end events
 *                                   and the agent is idle; answers the counts
 *   observe { sessionId }           sessionQuery.observeSession: the events
 * @module @aiclient/dsh-probe/steer-experiment
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm';

export const name = 'aiclient-steer-experiment';
export const inject = ['agents', 'sessionQuery'];

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  if (typeof process.send !== 'function') return;
  const send = (message) => {
    if (process.connected) process.send(message);
  };
  /** sessionId -> { starts, ends } counted from session/event. */
  const counts = new Map();
  /** sessionId -> { text, mode } armed for the next step/end. */
  const armed = new Map();
  /** sessionId -> { maxMs, release? } armed for the next turn-stopping. */
  const holds = new Map();
  /** sessionId -> the hold armed last, for release. */
  const activeHolds = new Map();
  /** sessionId -> ids steered by the armed step/end hook, with where it ran. */
  const stepEndSteers = new Map();

  const agentOf = (sessionId) => {
    const agent = ctx.agents.get(sessionId);
    if (!agent) throw new Error(`no live agent for ${sessionId}`);
    return agent;
  };
  const inboxOf = (agent) => {
    const pending = agent.inbox;
    return {
      status: agent.status,
      nextTurn: pending.nextTurn.map((message) => message.id),
      nextStep: pending.nextStep.map((message) => message.id),
    };
  };
  const steer = (agent, text) => {
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    });
    const statusBefore = agent.status;
    agent.steer(message);
    return { id: message.id, statusBefore, inboxAfter: inboxOf(agent) };
  };

  ctx.on('session/event', (session, event) => {
    const sessionId = session?.id;
    if (!sessionId) return;
    const count = counts.get(sessionId) ?? { starts: 0, ends: 0 };
    if (event?.type === 'turn/start') count.starts += 1;
    if (event?.type === 'turn/end') count.ends += 1;
    counts.set(sessionId, count);
    if (event?.type !== 'step/end') return;
    const arm = armed.get(sessionId);
    if (!arm) return;
    armed.delete(sessionId);
    const run = (where) => {
      try {
        stepEndSteers.set(sessionId, {
          ...steer(agentOf(sessionId), arm.text),
          where,
          afterSeq: event.seq,
        });
      } catch (error) {
        stepEndSteers.set(sessionId, { error: String(error?.message ?? error), where });
      }
    };
    if (arm.mode === 'sync') run('inside the step/end listener');
    else if (arm.mode === 'microtask') queueMicrotask(() => run('one microtask after step/end'));
    else setImmediate(() => run('one macrotask after step/end'));
  });

  ctx.on('agent/turn-stopping', async ({ agent, turn }) => {
    const sessionId = agent?.session?.id ?? agent?.id;
    const hold = holds.get(sessionId);
    if (!hold) return;
    holds.delete(sessionId);
    const released = new Promise((done) => {
      hold.release = done;
    });
    send({ rx41Event: 'turn-stopping', sessionId, turn });
    const outcome = await Promise.race([
      released.then(() => 'released'),
      sleep(hold.maxMs).then(() => 'timed-out'),
    ]);
    send({ rx41Event: 'turn-stopping-left', sessionId, turn, outcome });
  });
  const ops = {
    async steer(message) {
      return steer(agentOf(message.sessionId), message.text);
    },
    async 'arm-step-end'(message) {
      armed.set(message.sessionId, { text: message.text, mode: message.mode });
      return { armed: true };
    },
    async 'step-end-steer'(message) {
      return { steer: stepEndSteers.get(message.sessionId) ?? null };
    },
    async 'hold-turn-stopping'(message) {
      const hold = { maxMs: message.maxMs ?? 10_000 };
      holds.set(message.sessionId, hold);
      activeHolds.set(message.sessionId, hold);
      return { armed: true };
    },
    async 'release-turn-stopping'(message) {
      const hold = activeHolds.get(message.sessionId);
      activeHolds.delete(message.sessionId);
      hold?.release?.();
      return { released: Boolean(hold?.release) };
    },
    async cancel(message) {
      const agent = agentOf(message.sessionId);
      const before = inboxOf(agent);
      agent.cancel({ kind: 'user' }, message.keepInbox ? { keepInbox: true } : {});
      const afterCancel = inboxOf(agent);
      const steered = message.thenSteer ? steer(agent, message.thenSteer) : undefined;
      return { before, afterCancel, ...(steered ? { steered } : {}) };
    },
    async inbox(message) {
      return inboxOf(agentOf(message.sessionId));
    },
    async turns(message) {
      const deadline = Date.now() + (message.timeoutMs ?? 60_000);
      for (;;) {
        const count = counts.get(message.sessionId) ?? { starts: 0, ends: 0 };
        const agent = ctx.agents.get(message.sessionId);
        if (count.ends >= message.ends && agent?.status === 'idle') {
          return { ...count, status: agent.status, timedOut: false };
        }
        if (Date.now() > deadline) return { ...count, status: agent?.status, timedOut: true };
        await sleep(50);
      }
    },
    async observe(message) {
      const observation = await ctx.sessionQuery.observeSession(message.sessionId, {
        projectionMode: 'none',
      });
      try {
        return { cursor: observation.cursor, events: [...observation.events] };
      } finally {
        observation[Symbol.dispose]?.();
      }
    },
  };

  const onMessage = (message) => {
    if (message === null || typeof message !== 'object' || typeof message.rx41 !== 'string') return;
    const op = ops[message.rx41];
    if (!op) {
      send({ rx41Reply: message.rx41, requestId: message.requestId, error: 'unknown op' });
      return;
    }
    Promise.resolve()
      .then(() => op(message))
      .then(
        (answer) => send({ rx41Reply: message.rx41, requestId: message.requestId, ...answer }),
        (error) =>
          send({
            rx41Reply: message.rx41,
            requestId: message.requestId,
            error: error instanceof Error ? (error.stack ?? error.message) : String(error),
          })
      );
  };
  ctx.effect(() => {
    process.on('message', onMessage);
    return () => {
      process.off('message', onMessage);
      for (const hold of activeHolds.values()) hold.release?.();
    };
  }, 'aiclient-steer-experiment.ipc');
}
