/**
 * aiclient-probe — P0 stand-in for the future aiclient-bridge row.
 *
 * Serves a request/response protocol over the Node IPC channel the parent
 * opened (stdio 'ipc'). Every request carries a `requestId`; every answer
 * echoes it, and a failure answers { type: 'probe-error', requestId, message }.
 *
 *   create-session { sessionId?, cwd? }      -> session-created { sessionId, ms }
 *   close-session  { sessionId }             -> session-closed { ms }
 *   resume-session { sessionId }             -> session-resumed { ms }         (persisted session)
 *   prompt         { sessionId, text }       -> prompted { messageId }        (human followup)
 *   command        { sessionId, line }       -> command-result { result }     (slash command)
 *   goal           { sessionId }             -> goal { goal }                 (ctx.goals view)
 *   wait-idle      { sessionId, timeoutMs }  -> idle { idle, status }
 *   tools          {}                        -> tools { names }
 *   install-bundle { spec, registry? }       -> installed { result }          (plugin-manager)
 *   dispatch-counts {}                       -> dispatch-counts { counts }
 *   stats          {}                        -> stats { memory, liveAgents }
 *   natives        {}                        -> natives { sharedObjects }     (loaded native libraries)
 *   terminal       { argv, cwd, timeoutMs }  -> terminal { output, outcome } (ctx.subprocess PTY)
 *
 * It also answers every `approval/request` with 'allowed-once' (logged), and,
 * when AICLIENT_PROBE_EVENT_LOG names a file, appends one JSONL line per
 * durable session event plus selected live Cordis events there. Counts of
 * every dispatched Cordis event are kept in memory (`dispatch-counts`).
 * @module @aiclient/dsh-app
 */

import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

/** Stable Cordis plugin name. */
export const name = 'aiclient-probe';

/** Agent registry, default route, commands, goals, tools and plugin manager. */
export const inject = [
  'agents',
  'agentDefaultModel',
  'commands',
  'goals',
  'tools',
  'pluginManager',
];

// Live Cordis events worth a timeline line (besides the per-name counts).
const TIMELINE_EVENTS = new Set([
  'agent/status',
  'agent/created',
  'agent/disposed',
  'agent/error',
  'goal/changed',
  'goal/activation-changed',
  'approval/request',
]);

/** Depth-limited, cycle-free summary of an event argument. */
function brief(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.length > 400 ? `${value.slice(0, 400)}…` : value;
  if (typeof value !== 'object') return typeof value === 'function' ? '[fn]' : value;
  if (depth >= 2) return Array.isArray(value) ? `[array ${value.length}]` : '[object]';
  if (Array.isArray(value)) return value.slice(0, 8).map((item) => brief(item, depth + 1));
  const out = {};
  for (const key of Object.keys(value).slice(0, 16)) {
    try {
      out[key] = brief(value[key], depth + 1);
    } catch {
      out[key] = '[unreadable]';
    }
  }
  return out;
}

function goalView(view) {
  if (view === undefined) return null;
  return {
    id: view.id,
    revision: view.revision,
    objective: view.objective,
    phase: view.phase,
    blockedReason: view.blockedReason,
    roundsStarted: view.roundsStarted,
    maxGoalRounds: view.maxGoalRounds,
    activation: brief(view.activation),
  };
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  if (typeof process.send !== 'function') {
    ctx.logger('aiclient-probe').warn('no IPC channel; probe is inert');
    return;
  }
  const eventLog = process.env.AICLIENT_PROBE_EVENT_LOG;
  const record = (line) => {
    if (!eventLog) return;
    try {
      appendFileSync(
        eventLog,
        `${JSON.stringify({ tMs: Math.round(performance.now()), ...line })}\n`
      );
    } catch {
      // Event capture must never break the host.
    }
  };

  /** @type {Map<string, { dispose(): Promise<void>, agent: any }>} */
  const handles = new Map();
  const dispatchCounts = new Map();

  const reply = (message) => {
    if (process.connected) process.send(message);
  };
  const agentOf = (sessionId) => {
    const handle = handles.get(sessionId);
    if (handle === undefined) throw new Error(`unknown probe session ${sessionId}`);
    return handle.agent;
  };

  const operations = {
    async 'create-session'(message) {
      const started = performance.now();
      const sessionId = message.sessionId ?? `aiclient-probe-${randomUUID()}`;
      const { provider, model } = ctx.agentDefaultModel.currentSelection();
      const handle = await ctx.agents.create({
        sessionId,
        meta: { cwd: typeof message.cwd === 'string' ? message.cwd : process.cwd() },
        agentOptions: { provider, model },
      });
      handles.set(sessionId, handle);
      return {
        type: 'session-created',
        sessionId,
        provider,
        model,
        ms: performance.now() - started,
      };
    },
    async 'close-session'(message) {
      const started = performance.now();
      const handle = handles.get(message.sessionId);
      if (handle === undefined) throw new Error(`unknown probe session ${message.sessionId}`);
      handles.delete(message.sessionId);
      await handle.dispose();
      return { type: 'session-closed', ms: performance.now() - started };
    },
    async 'resume-session'(message) {
      const started = performance.now();
      const { provider, model } = ctx.agentDefaultModel.currentSelection();
      const handle = await ctx.agents.resume({
        resumeSessionId: message.sessionId,
        agentOptions: { provider, model },
      });
      handles.set(message.sessionId, handle);
      return {
        type: 'session-resumed',
        sessionId: message.sessionId,
        ms: performance.now() - started,
      };
    },
    async prompt(message) {
      const userMessage = createUserMessage({
        content: [{ type: 'text', text: message.text }],
        source: { kind: 'user' },
      });
      agentOf(message.sessionId).followup(userMessage);
      return { type: 'prompted', messageId: userMessage.id };
    },
    async command(message) {
      const execution = await ctx.commands.execute(
        agentOf(message.sessionId),
        message.line,
        [],
        new AbortController().signal
      );
      return { type: 'command-result', result: brief(execution?.result ?? null) };
    },
    async goal(message) {
      return { type: 'goal', goal: goalView(ctx.goals.get(agentOf(message.sessionId))) };
    },
    async 'wait-idle'(message) {
      const agent = agentOf(message.sessionId);
      const idle = await Promise.race([
        agent.whenIdle().then(() => true),
        new Promise((done) => setTimeout(() => done(false), message.timeoutMs ?? 60_000)),
      ]);
      return { type: 'idle', idle, status: brief(agent.status) };
    },
    async tools() {
      return {
        type: 'tools',
        names: ctx.tools
          .schemas()
          .map((schema) => schema.name)
          .sort(),
      };
    },
    async 'install-bundle'(message) {
      const result = await ctx.pluginManager.installBundle(message.spec, {
        ...(message.registry ? { registry: message.registry } : {}),
      });
      return { type: 'installed', result: brief(result) };
    },
    async 'dispatch-counts'() {
      return { type: 'dispatch-counts', counts: Object.fromEntries(dispatchCounts) };
    },
    async stats() {
      return {
        type: 'stats',
        memory: process.memoryUsage(),
        liveAgents: ctx.agents.list().length,
      };
    },
    async natives() {
      const shared = process.report.getReport().sharedObjects ?? [];
      return {
        type: 'natives',
        sharedObjects: shared.filter((file) => /\.node$|koffi|conpty|pty/i.test(file)),
      };
    },
    async terminal(message) {
      const subprocess = ctx.get('subprocess');
      if (typeof subprocess?.spawnTerminal !== 'function') {
        throw new Error('ctx.subprocess.spawnTerminal is not available');
      }
      const handle = await subprocess.spawnTerminal({
        argv: message.argv,
        cwd: message.cwd,
        env: {},
        rows: 30,
        cols: 200,
        terminalType: 'xterm-256color',
        graceMs: 2000,
      });
      const chunks = [];
      handle.output.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      let timer;
      const outcome = await Promise.race([
        handle.done.then(
          (done) => ({ settled: true, ...done }),
          (error) => ({ settled: true, error: String(error) })
        ),
        new Promise((done) => {
          timer = setTimeout(() => done({ settled: false }), message.timeoutMs ?? 20_000);
        }),
      ]);
      clearTimeout(timer);
      if (!outcome.settled) await handle.terminate().catch(() => {});
      return {
        type: 'terminal',
        pid: handle.pid,
        outcome,
        output: Buffer.concat(chunks).toString('utf8').slice(-8000),
      };
    },
  };

  const onMessage = (message) => {
    if (message === null || typeof message !== 'object') return;
    const operation = operations[message.type];
    if (operation === undefined) return;
    operation(message)
      .then((answer) => reply({ requestId: message.requestId, ...answer }))
      .catch((error) => {
        reply({
          type: 'probe-error',
          requestId: message.requestId,
          message: error instanceof Error ? (error.stack ?? error.message) : String(error),
        });
      });
  };

  // Every non-internal Cordis dispatch, counted by name and mode.
  ctx.on('internal/dispatch', (mode, eventName, args) => {
    const counts = dispatchCounts.get(eventName) ?? {};
    counts[mode] = (counts[mode] ?? 0) + 1;
    dispatchCounts.set(eventName, counts);
    if (TIMELINE_EVENTS.has(eventName)) {
      record({ kind: 'cordis', name: eventName, mode, args: brief(args) });
    }
  });

  // Every durable session event, exactly as appended.
  ctx.on('session/event', (session, event) => {
    let data;
    try {
      const text = JSON.stringify(event.data);
      data = text.length > 4000 ? `${text.slice(0, 4000)}…` : JSON.parse(text);
    } catch {
      data = brief(event.data);
    }
    record({
      kind: 'session',
      sessionId: session?.id,
      seq: event.seq,
      type: event.type,
      surfaceOp: event.surfaceOp,
      ignorable: event.ignorable,
      data,
    });
  });

  // Stand-in answerer: allow once, and log what was asked.
  ctx.on('approval/request', async (request) => {
    record({
      kind: 'approval',
      toolName: request.toolName,
      callId: request.callId,
      reason: request.reason,
      outcome: 'allowed-once',
    });
    return 'allowed-once';
  });

  ctx.effect(() => {
    process.on('message', onMessage);
    return async () => {
      process.off('message', onMessage);
      for (const handle of handles.values()) await handle.dispose();
      handles.clear();
    };
  }, 'aiclient-probe.ipc');
}
