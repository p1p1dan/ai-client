/**
 * aiclient-probe-stuck — a tool call that ignores its abort (dsh-rebase
 * P1-3e), test-only: a row of `@aiclient/dsh-probe`, off unless the host was
 * started with AICLIENT_DSH_PROBE_STUCK_TOOL set to a non-empty text.
 *
 * Every call whose JSON arguments contain that text is held at DSH's
 * `tools/execute` waterfall: the listener never calls `next()` and its promise
 * never settles, whatever happens to the call's signal. DSH never abandons a
 * started tool body (dsh-tools `dispatchToolBody`), so the agent loop waits on
 * it for good: Stop's `cancel` cannot end the turn, and the agent's dispose
 * (`cancel` + `whenIdle`) cannot finish either. That is the stuck agent Stop
 * ladder B exists for (decision 021), on a real host instead of a message lost
 * at the IPC edge.
 *
 * An approval handler that ignores the abort would not do: dsh-user-approval
 * races every `approval/request` answer against the call's signal.
 *
 * Registered at boot, it runs before the bridge's own per-session wrapper and
 * the tool body, so nothing is spawned for a held call. Nothing ever releases
 * it, not even this row's disposal: only the host process ending does.
 *
 * Every hold and every ignored abort is written as a warning, which the host
 * prints on stderr (`[dsh-host] warn aiclient-probe-stuck: ...`):
 *
 *   holding <tool> call <callId>; its abort will be ignored
 *   abort ignored: <tool> call <callId>
 *
 * Driven by the Stop ladder B case of
 * src/main/services/agent-host/__tests__/dshSharedHost.integration.test.ts.
 * @module @aiclient/dsh-probe/stuck
 */

/** Stable Cordis plugin name. */
export const name = 'aiclient-probe-stuck';

/** The text a call's arguments must contain to be held. */
export const STUCK_TOOL_ENV = 'AICLIENT_DSH_PROBE_STUCK_TOOL';

/** The call's arguments as JSON text, or '' when they cannot be serialized. */
function argumentsText(exec) {
  try {
    return JSON.stringify(exec?.arguments) ?? '';
  } catch {
    return '';
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  const needle = process.env[STUCK_TOOL_ENV];
  // The patch row is off without it; a row composed by other means stays inert.
  if (typeof needle !== 'string' || needle.length === 0) return;
  const logger = ctx.logger(name);
  logger.warn(`armed: a tool call whose arguments contain ${JSON.stringify(needle)} is held`);

  ctx.on('tools/execute', (exec, next) => {
    if (!argumentsText(exec).includes(needle)) return next();
    const call = `${String(exec.name)} call ${String(exec.callId)}`;
    logger.warn(`holding ${call}; its abort will be ignored`);
    const signal = exec.signal;
    const ignore = () => logger.warn(`abort ignored: ${call}`);
    if (signal?.aborted) ignore();
    else signal?.addEventListener?.('abort', ignore, { once: true });
    return new Promise(() => {});
  });
}
