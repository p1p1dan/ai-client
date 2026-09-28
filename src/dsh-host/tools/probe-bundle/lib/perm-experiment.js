/**
 * aiclient-perm-experiment — dsh-rebase P1-6b pre-work experiments, test-only
 * (row of `@aiclient/dsh-probe`, off unless AICLIENT_PERM_EXPERIMENT=1).
 *
 * Raw listeners on the seams the permission plugin will use, each observation
 * appended as one JSONL line to AICLIENT_PERM_EXPERIMENT_LOG:
 *
 *   1  a global prepend `tools/pre-execute` listener: does it see subagent,
 *      workflow-child and PTC sub-calls, and what does `exec.agent` carry?
 *   2  a second prepend listener registered later (so it runs first) that
 *      returns allow without `next()` for `P1-PERM-SHORTCIRCUIT`; the guard
 *      denies every call the first listener never marked.
 *   3  a `tools/post-execute` listener that drops `.env` / `server.key` from
 *      glob / grep values; logs the listener order. AICLIENT_PERM_EXPERIMENT_POST
 *      picks the variant: `downstream` (non-prepend, calls `next()` first — the
 *      plan's assumption) or `short-circuit` (prepend, and returns the filtered
 *      value without `next()` whenever something was filtered).
 *   5  `P1-PERM-HOLD`: the pre-execute listener parks like a pending card,
 *      cancels the calling agent after 1.5 s and returns `cancel`.
 *
 * AICLIENT_PERM_EXPERIMENT_MODE=plugin replaces all of the above with a check
 * of the real `aiclient-permissions` row (switched on by the driver): every
 * root session gets a `PermissionGate` (loaded from AICLIENT_PERM_GATE_MODULE)
 * attached through `ctx.aiclientPermissions`, whose cards are answered
 * allow-once and logged, as the bridge will do in P1-6b part 2.
 *
 * Driven by src/dsh-host/tools/perm-experiments.ts.
 * @module @aiclient/dsh-probe/perm-experiment
 */

import { appendFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

/** Stable Cordis plugin name. */
export const name = 'aiclient-perm-experiment';

export const inject = ['tools'];

const SECRET = /(^|\/)(\.env|server\.key)$/;

function hookOwners(ctx, eventName) {
  try {
    const hooks = ctx.root.events._hooks[eventName] ?? [];
    return hooks.map((hook) => {
      const fiber = hook.ctx?.fiber;
      let label = '?';
      try {
        label = fiber?.name ?? '?';
      } catch {
        // Fiber names are best effort.
      }
      return { label, prepend: hook.prepend === true };
    });
  } catch (error) {
    return [{ label: `unavailable: ${String(error)}`, prepend: false }];
  }
}

function headerOf(agent) {
  try {
    const header = agent?.session?.header;
    if (!header) return undefined;
    return {
      id: header.id,
      parentSession: header.parentSession,
      origin: header.origin,
      delegationDepth: header.delegationDepth,
      cwd: header.cwd,
    };
  } catch (error) {
    return { error: String(error) };
  }
}

/** @param {import('@deepseek-ai/cordis').Context} ctx */
export function apply(ctx) {
  const logFile = process.env.AICLIENT_PERM_EXPERIMENT_LOG;
  const record = (line) => {
    if (!logFile) return;
    try {
      appendFileSync(
        logFile,
        `${JSON.stringify({ tMs: Math.round(performance.now()), ...line })}\n`
      );
    } catch {
      // Experiments must never break the host.
    }
  };
  logResults(ctx, record);
  if (process.env.AICLIENT_PERM_EXPERIMENT_MODE === 'plugin') return applyPluginMode(ctx, record);
  const marked = new WeakSet();
  let orderLogged = false;

  ctx.on('session/created', (session) => {
    record({ kind: 'session-created', header: headerOf({ session }) });
  });

  // Experiment 1 (and the verdict experiment 2 relies on).
  ctx.on(
    'tools/pre-execute',
    async (exec, next) => {
      const command = typeof exec.arguments?.command === 'string' ? exec.arguments.command : '';
      record({
        kind: 'pre',
        name: exec.name,
        callId: exec.callId,
        rootCallId: exec.rootCallId,
        nested: exec.parent !== undefined,
        agentId: exec.agent?.id,
        header: headerOf(exec.agent),
        command: command.slice(0, 120),
      });
      if (exec.name === 'bash' && command.includes('P1-PERM-HOLD')) {
        // Experiment 5: a card is up; Stop arrives while it is.
        const started = performance.now();
        const timer = setTimeout(() => {
          try {
            exec.agent?.cancel({ kind: 'user' });
            record({ kind: 'hold-cancel-sent', callId: exec.callId });
          } catch (error) {
            record({ kind: 'hold-cancel-failed', error: String(error) });
          }
        }, 1500);
        await new Promise((resolve) => {
          if (exec.signal.aborted) resolve();
          else exec.signal.addEventListener('abort', resolve, { once: true });
        });
        clearTimeout(timer);
        record({
          kind: 'hold-aborted',
          callId: exec.callId,
          waitedMs: Math.round(performance.now() - started),
          reason: String(exec.signal.reason?.message ?? exec.signal.reason),
        });
        return { kind: 'cancel' };
      }
      marked.add(exec);
      return next();
    },
    { prepend: true }
  );

  // Experiment 2: a listener in front of ours that allows without next().
  ctx.on(
    'tools/pre-execute',
    async (exec, next) => {
      const command = typeof exec.arguments?.command === 'string' ? exec.arguments.command : '';
      if (exec.name === 'bash' && command.includes('P1-PERM-SHORTCIRCUIT')) {
        record({ kind: 'short-circuit', callId: exec.callId });
        return { kind: 'allow' };
      }
      return next();
    },
    { prepend: true }
  );

  ctx.tools.guard((exec) => {
    const ok = marked.has(exec);
    record({ kind: 'guard', name: exec.name, callId: exec.callId, marked: ok });
    return ok ? undefined : 'permission gate did not run';
  });

  // Experiment 3: downstream of fs-search, or not?
  const shortCircuit = process.env.AICLIENT_PERM_EXPERIMENT_POST === 'short-circuit';
  ctx.on(
    'tools/post-execute',
    async (exec, result, next) => {
      if (!orderLogged) {
        orderLogged = true;
        record({ kind: 'post-order', hooks: hookOwners(ctx, 'tools/post-execute') });
        record({ kind: 'pre-order', hooks: hookOwners(ctx, 'tools/pre-execute') });
      }
      const direct = exec.parent === undefined && !result.isError;
      if (!direct || (exec.name !== 'glob' && exec.name !== 'grep') || !result.value) {
        return next();
      }
      const decision = shortCircuit ? { kind: 'accept' } : await next();
      const value = result.value;
      const upstreamReplaced =
        decision.kind !== 'accept' ||
        decision.content !== undefined ||
        Object.hasOwn(decision, 'value');
      let filtered;
      let removed = 0;
      if (exec.name === 'glob') {
        const paths = value.paths.filter((path) => !SECRET.test(path));
        removed = value.paths.length - paths.length;
        filtered = { ...value, paths };
      } else {
        const matches = value.matches.filter((match) => !SECRET.test(match.path));
        removed = value.matches.length - matches.length;
        filtered = { matches };
      }
      record({
        kind: 'post-search',
        variant: shortCircuit ? 'short-circuit' : 'downstream',
        name: exec.name,
        callId: exec.callId,
        total: exec.name === 'glob' ? value.paths.length : value.matches.length,
        removed,
        downstreamDecisionReplaced: upstreamReplaced,
      });
      if (removed > 0) {
        return {
          kind: 'accept',
          value: filtered,
          ...(decision.additionalContexts
            ? { additionalContexts: decision.additionalContexts }
            : {}),
        };
      }
      return shortCircuit ? next() : decision;
    },
    { prepend: shortCircuit }
  );
}

function logResults(ctx, record) {
  ctx.on('tools/result', (exec, result) => {
    const text = (result.content ?? [])
      .map((block) => (block.type === 'text' ? block.text : `[${block.type}]`))
      .join('\n');
    record({
      kind: 'result',
      name: exec.name,
      callId: exec.callId,
      nested: exec.parent !== undefined,
      agentId: exec.agent?.id,
      isError: result.isError,
      error: result.error,
      text: text.slice(0, 600),
      mentionsSecret: /\.env\b|server\.key/.test(text),
      metaMentionsSecret: /\.env\b|server\.key/.test(JSON.stringify(result.meta ?? null)),
    });
  });
}

/** The real row, driven the way the bridge will drive it: one gate per root session. */
async function applyPluginMode(ctx, record) {
  const { PermissionGate } = await import(process.env.AICLIENT_PERM_GATE_MODULE ?? '');
  const gear = process.env.AICLIENT_PERM_EXPERIMENT_GEAR ?? 'ask';
  ctx.on('session/created', (session) => {
    const header = session?.header;
    if (!header || header.parentSession) return;
    const service = ctx.get('aiclientPermissions');
    if (!service) {
      record({ kind: 'no-service', id: header.id });
      return;
    }
    const gate = new PermissionGate({
      cwd: header.cwd,
      gear,
      approve: async (request) => {
        record({
          kind: 'card',
          tool: request.tool,
          callId: request.toolCallId,
          path: request.path,
          command: request.command,
          paths: request.paths,
          delegation: request.delegation,
        });
        return 'allow-once';
      },
    });
    gate.onActivity((entry) =>
      record({
        kind: 'activity',
        phase: entry.phase,
        tool: entry.request.tool,
        callId: entry.request.toolCallId,
        decision: entry.decision,
        source: entry.source,
      })
    );
    service.attachGate(`exp-${header.id}`, { dshSessionId: header.id, gate });
    record({ kind: 'attached', id: header.id });
  });
}
