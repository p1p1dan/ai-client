import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeRuntime, normalizeEffort } from '../claudeRuntime.ts';
import { SessionRegistry } from '../sessionRegistry.ts';

/**
 * #8 behavior lock: the exact `thinking` / `effort` options ClaudeRuntime hands
 * to the Agent SDK query().
 *
 * Why assert options rather than output: `pnpm typecheck` excludes
 * src/agent-host/, and the two defects behind #8 were both silent — a wrong
 * `thinking` shape is a runtime 400, and a missing `display` yields thinking
 * blocks with empty text and no error at all. Neither surfaces in a type check
 * or in a smoke that only asserts "a turn completed", so the option payload is
 * pinned here deterministically (standard #4, assert the process first).
 *
 * Shapes verified live by spikes/c16-thinking-shape-probe.ts against the CCH
 * gateway on claude-opus-4-8[1m] (SDK 0.3.218): {type:'adaptive'} alone yields
 * thinkingTextLen 0, while adding display:'summarized' yields 408.
 */

type CapturedOptions = Record<string, unknown>;

/** Minimal fake query() that records options and closes the turn immediately. */
function makeCapturingQueryFn(captured: CapturedOptions[]) {
  return (params: { prompt: string | AsyncIterable<unknown>; options?: CapturedOptions }) => {
    captured.push(params.options ?? {});
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', session_id: 'rt-opts' };
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } };
        yield { type: 'result', subtype: 'success', result: 'ok' };
      },
      close() {
        /* nothing to tear down */
      },
    };
  };
}

function makeRuntime(captured: CapturedOptions[]): ClaudeRuntime {
  return new ClaudeRuntime({
    driver: 'agent-sdk',
    cliPath: 'unused-in-fake',
    env: {},
    emit: () => undefined,
    log: () => undefined,
    registry: new SessionRegistry(),
    queryFn: makeCapturingQueryFn(captured),
  });
}

describe('claudeRuntime query options — thinking shape (#8)', () => {
  it('sends adaptive thinking with summarized display', async () => {
    const captured: CapturedOptions[] = [];
    const rt = makeRuntime(captured);
    rt.createSession({ sessionId: 's1', workspacePath: process.cwd() });
    await rt.send({ sessionId: 's1', text: 'hi' });

    expect(captured).toHaveLength(1);
    // display is the load-bearing half: without it thinking text is empty.
    expect(captured[0].thinking).toEqual({ type: 'adaptive', display: 'summarized' });
  });

  it('never sends the removed fixed-budget thinking shape', async () => {
    const captured: CapturedOptions[] = [];
    const rt = makeRuntime(captured);
    rt.createSession({ sessionId: 's2', workspacePath: process.cwd() });
    await rt.send({ sessionId: 's2', text: 'hi' });

    const thinking = captured[0].thinking as Record<string, unknown>;
    // `{type:'enabled', budgetTokens}` is deprecated on Opus 4.6/Sonnet 4.6 and
    // removed on Opus 4.8/4.7, Sonnet 5, Fable 5 — a latent 400.
    expect(thinking.type).not.toBe('enabled');
    expect(thinking).not.toHaveProperty('budgetTokens');
  });

  it('omits effort entirely when none is configured', async () => {
    const captured: CapturedOptions[] = [];
    const rt = makeRuntime(captured);
    rt.createSession({ sessionId: 's3', workspacePath: process.cwd() });
    await rt.send({ sessionId: 's3', text: 'hi' });

    // Absent (not undefined) so the model default applies.
    expect(captured[0]).not.toHaveProperty('effort');
  });
});

describe('claudeRuntime query options — effort threading (T-20 base)', () => {
  it('applies the session default effort from session.create', async () => {
    const captured: CapturedOptions[] = [];
    const rt = makeRuntime(captured);
    rt.createSession({ sessionId: 's4', workspacePath: process.cwd(), effort: 'high' });
    await rt.send({ sessionId: 's4', text: 'hi' });

    // Top-level option — NOT output_config.effort (SDK 0.3.218 Options.effort).
    expect(captured[0].effort).toBe('high');
    expect(captured[0]).not.toHaveProperty('output_config');
  });

  it('lets a per-send effort override the session default', async () => {
    const captured: CapturedOptions[] = [];
    const rt = makeRuntime(captured);
    rt.createSession({ sessionId: 's5', workspacePath: process.cwd(), effort: 'low' });
    await rt.send({ sessionId: 's5', text: 'hi', effort: 'xhigh' });

    expect(captured[0].effort).toBe('xhigh');
  });

  it('falls back to the session default when a send omits effort', async () => {
    const captured: CapturedOptions[] = [];
    const rt = makeRuntime(captured);
    rt.createSession({ sessionId: 's6', workspacePath: process.cwd(), effort: 'medium' });
    await rt.send({ sessionId: 's6', text: 'hi' });

    expect(captured[0].effort).toBe('medium');
  });

  it('drops an unknown effort value instead of forwarding it to the API', async () => {
    const captured: CapturedOptions[] = [];
    const rt = makeRuntime(captured);
    // Raw NDJSON from Main is untrusted; a bogus level must not reach query().
    rt.createSession({ sessionId: 's7', workspacePath: process.cwd(), effort: 'ludicrous' });
    await rt.send({ sessionId: 's7', text: 'hi', effort: 42 });

    expect(captured[0]).not.toHaveProperty('effort');
  });

  it('keeps the session default when a send carries an invalid override', async () => {
    const captured: CapturedOptions[] = [];
    const rt = makeRuntime(captured);
    rt.createSession({ sessionId: 's8', workspacePath: process.cwd(), effort: 'high' });
    await rt.send({ sessionId: 's8', text: 'hi', effort: 'turbo' });

    expect(captured[0].effort).toBe('high');
  });
});

describe('claudeRuntime query options — resume must re-pin model/effort (2026-07-29 cache probe)', () => {
  // cli.js is re-spawned per turn; a resume without an explicit model falls back
  // to the CLI default model — a silent model switch AND a guaranteed full
  // prompt-cache rewrite (captured live: fresh turn carried the context-1m beta
  // + "(1M context)" inside the Bash tool description, resumed turn did not).
  it('threads model, effort, and resume identity into query() after resumeSession', async () => {
    const captured: CapturedOptions[] = [];
    const rt = makeRuntime(captured);
    rt.resumeSession({
      sessionId: 's9',
      workspacePath: process.cwd(),
      runtimeIdentity: 'rt-uuid-9',
      model: 'sonnet',
      effort: 'high',
    });
    await rt.send({ sessionId: 's9', text: 'hi' });

    expect(captured[0].model).toBe('sonnet');
    expect(captured[0].effort).toBe('high');
    expect(captured[0].resume).toBe('rt-uuid-9');
  });

  it('merges model/effort onto an existing registry entry on resume', async () => {
    const captured: CapturedOptions[] = [];
    const rt = makeRuntime(captured);
    rt.createSession({ sessionId: 's10', workspacePath: process.cwd() });
    rt.resumeSession({
      sessionId: 's10',
      workspacePath: process.cwd(),
      runtimeIdentity: 'rt-uuid-10',
      model: 'opus',
      effort: 'medium',
    });
    await rt.send({ sessionId: 's10', text: 'hi' });

    expect(captured[0].model).toBe('opus');
    expect(captured[0].effort).toBe('medium');
  });

  it('drops an invalid effort on resume instead of forwarding it', async () => {
    const captured: CapturedOptions[] = [];
    const rt = makeRuntime(captured);
    rt.resumeSession({
      sessionId: 's11',
      workspacePath: process.cwd(),
      runtimeIdentity: 'rt-uuid-11',
      model: 'sonnet',
      effort: 'turbo',
    });
    await rt.send({ sessionId: 's11', text: 'hi' });

    expect(captured[0].model).toBe('sonnet');
    expect(captured[0]).not.toHaveProperty('effort');
  });
});

describe('claudeRuntime query options — per-send model override (round-2 P0 model pass-through)', () => {
  it('lets a per-send model override the session default set at create time', async () => {
    const captured: CapturedOptions[] = [];
    const rt = makeRuntime(captured);
    rt.createSession({ sessionId: 's12', workspacePath: process.cwd(), model: 'sonnet' });
    await rt.send({ sessionId: 's12', text: 'hi', model: 'opus' });

    expect(captured[0].model).toBe('opus');
  });

  it('applies a per-send model when the session was created/resumed with none', async () => {
    const captured: CapturedOptions[] = [];
    const rt = makeRuntime(captured);
    rt.createSession({ sessionId: 's13', workspacePath: process.cwd() });
    await rt.send({ sessionId: 's13', text: 'hi', model: 'haiku' });

    expect(captured[0].model).toBe('haiku');
  });

  it('keeps the session default when a send omits model', async () => {
    const captured: CapturedOptions[] = [];
    const rt = makeRuntime(captured);
    rt.createSession({ sessionId: 's14', workspacePath: process.cwd(), model: 'opus' });
    await rt.send({ sessionId: 's14', text: 'hi' });

    expect(captured[0].model).toBe('opus');
  });

  it('re-pins an explicit per-send model so a LATER send that omits it keeps the choice', async () => {
    const captured: CapturedOptions[] = [];
    const rt = makeRuntime(captured);
    rt.createSession({ sessionId: 's15', workspacePath: process.cwd(), model: 'sonnet' });
    await rt.send({ sessionId: 's15', text: 'first', model: 'opus' });
    await rt.send({ sessionId: 's15', text: 'second' });

    expect(captured[0].model).toBe('opus');
    expect(captured[1].model).toBe('opus');
  });

  it('ignores a non-string model override and falls back to the session default', async () => {
    const captured: CapturedOptions[] = [];
    const rt = makeRuntime(captured);
    rt.createSession({ sessionId: 's16', workspacePath: process.cwd(), model: 'sonnet' });
    await rt.send({ sessionId: 's16', text: 'hi', model: 42 });

    expect(captured[0].model).toBe('sonnet');
  });

  it('omits model entirely when neither the session nor the send configured one', async () => {
    const captured: CapturedOptions[] = [];
    const rt = makeRuntime(captured);
    rt.createSession({ sessionId: 's17', workspacePath: process.cwd() });
    await rt.send({ sessionId: 's17', text: 'hi' });

    expect(captured[0]).not.toHaveProperty('model');
  });
});

describe('claudeRuntime query options — stderr forwarding (a2)', () => {
  it('passes a stderr callback to query() — SDK only forwards CLI stderr when this is set', async () => {
    const captured: CapturedOptions[] = [];
    const rt = makeRuntime(captured);
    rt.createSession({ sessionId: 's18', workspacePath: process.cwd() });
    await rt.send({ sessionId: 's18', text: 'hi' });

    expect(typeof captured[0].stderr).toBe('function');
  });

  it('forwards a stderr line to the runtime log with the [cli-stderr] prefix', async () => {
    const captured: CapturedOptions[] = [];
    const logs: unknown[][] = [];
    const rt = new ClaudeRuntime({
      driver: 'agent-sdk',
      cliPath: 'unused-in-fake',
      env: {},
      emit: () => undefined,
      log: (...args) => logs.push(args),
      registry: new SessionRegistry(),
      queryFn: makeCapturingQueryFn(captured),
    });
    rt.createSession({ sessionId: 's19', workspacePath: process.cwd() });
    await rt.send({ sessionId: 's19', text: 'hi' });

    const stderrFn = captured[0].stderr as (line: string) => void;
    stderrFn('No conversation found with session ID: abc');

    expect(
      logs.some(
        (args) => args[0] === '[cli-stderr]' && String(args[1]).includes('No conversation found')
      )
    ).toBe(true);
  });
});

/** Fake queryFn that never yields anything until the abort signal fires, then throws (mirrors the real SDK's aborted-query behavior). */
function makeHangingQueryFn() {
  return (params: {
    prompt: string | AsyncIterable<unknown>;
    options?: Record<string, unknown>;
  }) => {
    const abort = params.options?.abortController as AbortController;
    const iterable = (async function* () {
      await new Promise<void>((resolve) => {
        if (abort.signal.aborted) {
          resolve();
          return;
        }
        abort.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      throw new Error('AbortError: aborted');
    })();
    return Object.assign(iterable, { close: () => undefined });
  };
}

/** Fake queryFn: one productive event immediately, then a result after `delayMs`. */
function makeDelayedResultQueryFn(delayMs: number) {
  return (_params: {
    prompt: string | AsyncIterable<unknown>;
    options?: Record<string, unknown>;
  }) => {
    const iterable = (async function* () {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } };
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      yield { type: 'result', result: 'done' };
    })();
    return Object.assign(iterable, { close: () => undefined });
  };
}

/** Fake queryFn: reacts to the abort signal, but only unwinds
 * `unwindDelayAfterAbortMs` AFTER it fires — models a child process that
 * is slow to actually exit once asked to (the abort() call itself does
 * not instantly resolve the stream). Module-level (S6, round-2 iteration-3
 * review) so both the TTFT describe block below and the dedicated stall
 * watchdog describe block further down can share it. */
function makeSlowToUnwindQueryFn(unwindDelayAfterAbortMs: number) {
  return (params: {
    prompt: string | AsyncIterable<unknown>;
    options?: Record<string, unknown>;
  }) => {
    const abort = params.options?.abortController as AbortController;
    const iterable = (async function* () {
      await new Promise<void>((resolve) => {
        if (abort.signal.aborted) {
          resolve();
          return;
        }
        abort.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      await new Promise((resolve) => setTimeout(resolve, unwindDelayAfterAbortMs));
      throw new Error('AbortError: aborted');
    })();
    return Object.assign(iterable, { close: () => undefined });
  };
}

describe('claudeRuntime TTFT watchdog (a4)', () => {
  const savedTtft = process.env.AICLIENT_HOST_TTFT_TIMEOUT_MS;
  const savedStall = process.env.AICLIENT_HOST_STALL_TIMEOUT_MS;

  afterEach(() => {
    if (savedTtft === undefined) delete process.env.AICLIENT_HOST_TTFT_TIMEOUT_MS;
    else process.env.AICLIENT_HOST_TTFT_TIMEOUT_MS = savedTtft;
    if (savedStall === undefined) delete process.env.AICLIENT_HOST_STALL_TIMEOUT_MS;
    else process.env.AICLIENT_HOST_STALL_TIMEOUT_MS = savedStall;
  });

  it('fires with its own message well before the (much longer) stall watchdog when no productive event ever arrives', async () => {
    process.env.AICLIENT_HOST_TTFT_TIMEOUT_MS = '50';
    process.env.AICLIENT_HOST_STALL_TIMEOUT_MS = '5000';
    const events: Record<string, unknown>[] = [];
    const rt = new ClaudeRuntime({
      driver: 'agent-sdk',
      cliPath: 'unused-in-fake',
      env: {},
      emit: (e) => events.push(e),
      log: () => undefined,
      registry: new SessionRegistry(),
      queryFn: makeHangingQueryFn(),
    });
    rt.createSession({ sessionId: 'ttft-1', workspacePath: process.cwd() });

    await rt.send({ sessionId: 'ttft-1', text: 'hi' });

    const failed = events.find((e) => e.type === 'session.failed');
    expect(failed).toBeTruthy();
    const message = String((failed?.payload as { error?: string } | undefined)?.error ?? '');
    // F14 minor m7: the message itself (not a wall-clock race against the
    // 5000ms stall timeout, which is flaky under load) proves TTFT — not
    // stall — fired.
    expect(message).toContain('TTFT watchdog');
  });

  it('never fires once a productive event has arrived, even past the TTFT budget', async () => {
    process.env.AICLIENT_HOST_TTFT_TIMEOUT_MS = '50';
    process.env.AICLIENT_HOST_STALL_TIMEOUT_MS = '5000';
    const events: Record<string, unknown>[] = [];
    const rt = new ClaudeRuntime({
      driver: 'agent-sdk',
      cliPath: 'unused-in-fake',
      env: {},
      emit: (e) => events.push(e),
      log: () => undefined,
      registry: new SessionRegistry(),
      queryFn: makeDelayedResultQueryFn(200),
    });
    rt.createSession({ sessionId: 'ttft-2', workspacePath: process.cwd() });

    await rt.send({ sessionId: 'ttft-2', text: 'hi' });

    expect(events.some((e) => e.type === 'session.completed')).toBe(true);
    expect(events.some((e) => e.type === 'session.failed')).toBe(false);
  });

  /** Fake queryFn: `system/init` only, then a single productive assistant
   * event after `delayMs` — no incremental `stream_event`s in between. Models
   * the F1/B1 scenario: a healthy turn whose only "first productive event" is
   * one big adaptive-thinking response, arriving well past the TTFT budget. */
  function makeSlowHealthyQueryFn(delayMs: number) {
    return (_params: {
      prompt: string | AsyncIterable<unknown>;
      options?: Record<string, unknown>;
    }) => {
      const iterable = (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'rt-slow-healthy' };
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'finally' }] } };
        yield { type: 'result', result: 'done' };
      })();
      return Object.assign(iterable, { close: () => undefined });
    };
  }

  it('F1: never fires on a healthy turn that is merely slow to its first productive event (init arrived, no retry, past TTFT budget)', async () => {
    process.env.AICLIENT_HOST_TTFT_TIMEOUT_MS = '50';
    process.env.AICLIENT_HOST_STALL_TIMEOUT_MS = '5000';
    const events: Record<string, unknown>[] = [];
    const rt = new ClaudeRuntime({
      driver: 'agent-sdk',
      cliPath: 'unused-in-fake',
      env: {},
      emit: (e) => events.push(e),
      log: () => undefined,
      registry: new SessionRegistry(),
      queryFn: makeSlowHealthyQueryFn(220),
    });
    rt.createSession({ sessionId: 'ttft-3', workspacePath: process.cwd() });

    await rt.send({ sessionId: 'ttft-3', text: 'hi' });

    expect(events.some((e) => e.type === 'session.failed')).toBe(false);
    expect(events.some((e) => e.type === 'session.completed')).toBe(true);
  });

  /** Fake queryFn: init, one api_retry, then hangs until aborted — a genuine
   * transport retry loop with no productive event ever arriving. */
  function makeRetryLoopQueryFn() {
    return (params: {
      prompt: string | AsyncIterable<unknown>;
      options?: Record<string, unknown>;
    }) => {
      const abort = params.options?.abortController as AbortController;
      const iterable = (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'rt-retry-loop' };
        yield {
          type: 'system',
          subtype: 'api_retry',
          attempt: 1,
          max_retries: 10,
          error: 'upstream 529',
        };
        await new Promise<void>((resolve) => {
          if (abort.signal.aborted) {
            resolve();
            return;
          }
          abort.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        throw new Error('AbortError: aborted');
      })();
      return Object.assign(iterable, { close: () => undefined });
    };
  }

  it('F1: fires once sawApiRetry evidence lands, even though a prior (non-productive) event already arrived', async () => {
    process.env.AICLIENT_HOST_TTFT_TIMEOUT_MS = '50';
    process.env.AICLIENT_HOST_STALL_TIMEOUT_MS = '5000';
    const events: Record<string, unknown>[] = [];
    const rt = new ClaudeRuntime({
      driver: 'agent-sdk',
      cliPath: 'unused-in-fake',
      env: {},
      emit: (e) => events.push(e),
      log: () => undefined,
      registry: new SessionRegistry(),
      queryFn: makeRetryLoopQueryFn(),
    });
    rt.createSession({ sessionId: 'ttft-4', workspacePath: process.cwd() });

    await rt.send({ sessionId: 'ttft-4', text: 'hi' });

    const failed = events.find((e) => e.type === 'session.failed');
    expect(failed).toBeTruthy();
    const message = String((failed?.payload as { error?: string } | undefined)?.error ?? '');
    // F14 minor m7: message discriminator, not a flaky wall-clock race.
    expect(message).toContain('TTFT watchdog');
  });

  /** Fake queryFn: parks on canUseTool (Bash) before any productive event,
   * only proceeding once the permission is answered. */
  function makePermissionParkedQueryFn() {
    return (params: {
      prompt: string | AsyncIterable<unknown>;
      options?: Record<string, unknown>;
    }) => {
      const canUseTool = params.options?.canUseTool as (
        toolName: string,
        input: Record<string, unknown>,
        options: { signal: AbortSignal; toolUseID: string }
      ) => Promise<{ behavior?: string }>;
      const abort = params.options?.abortController as AbortController;
      const iterable = (async function* () {
        const result = await canUseTool(
          'Bash',
          {},
          { signal: abort.signal, toolUseID: 'perm-parked-1' }
        );
        if (result.behavior !== 'allow') {
          throw new Error('denied');
        }
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'after permission' }] },
        };
        yield { type: 'result', result: 'done' };
      })();
      return Object.assign(iterable, { close: () => undefined });
    };
  }

  it('F1: never fires while a permission is parked before the first productive event', async () => {
    process.env.AICLIENT_HOST_TTFT_TIMEOUT_MS = '50';
    process.env.AICLIENT_HOST_STALL_TIMEOUT_MS = '5000';
    const events: Record<string, unknown>[] = [];
    const rt = new ClaudeRuntime({
      driver: 'agent-sdk',
      cliPath: 'unused-in-fake',
      env: {},
      emit: (e) => events.push(e),
      log: () => undefined,
      registry: new SessionRegistry(),
      queryFn: makePermissionParkedQueryFn(),
    });
    rt.createSession({ sessionId: 'ttft-5', workspacePath: process.cwd() });

    const sendPromise = rt.send({ sessionId: 'ttft-5', text: 'hi' });
    // Give the TTFT timer several windows to fire (and re-arm) while the
    // permission sits unanswered — this is the regression this test pins.
    await new Promise((resolve) => setTimeout(resolve, 180));
    expect(events.some((e) => e.type === 'session.failed')).toBe(false);

    const requested = events.find((e) => e.type === 'permission.requested');
    expect(requested).toBeTruthy();
    const permissionId = (requested?.payload as { permissionId?: string } | undefined)
      ?.permissionId as string;
    rt.respondPermission({ sessionId: 'ttft-5', permissionId, allow: true });

    await sendPromise;
    expect(events.some((e) => e.type === 'session.failed')).toBe(false);
    expect(events.some((e) => e.type === 'session.completed')).toBe(true);
  });

  it('R7 + S6 (round-2 iteration-3 review): an early Stop before the TTFT deadline, with a stream slow enough to also outlive the stall deadline, still ends as an honest session.stopped — neither watchdog may relabel an already-aborted turn as a failure', async () => {
    process.env.AICLIENT_HOST_TTFT_TIMEOUT_MS = '20';
    process.env.AICLIENT_HOST_STALL_TIMEOUT_MS = '60';
    const events: Record<string, unknown>[] = [];
    const rt = new ClaudeRuntime({
      driver: 'agent-sdk',
      cliPath: 'unused-in-fake',
      env: {},
      emit: (e) => events.push(e),
      log: () => undefined,
      registry: new SessionRegistry(),
      // Abort fires at t≈5ms (below); the stream only actually unwinds
      // 60ms later — well after BOTH the 20ms TTFT deadline and the 60ms
      // stall deadline fire once each, on an already-aborted turn. Before
      // S6, the stall timer had no `abort.signal.aborted` guard, so it set
      // `stalled = true` and relabeled this Stop as a stall FAILURE.
      queryFn: makeSlowToUnwindQueryFn(60),
    });
    rt.createSession({ sessionId: 'ttft-6', workspacePath: process.cwd() });

    const sendPromise = rt.send({ sessionId: 'ttft-6', text: 'hi' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    // Explicit Stop, well before the 20ms TTFT deadline — when that timer
    // fires it must see `abort.signal.aborted` and reset `firedFlag` (R7)
    // instead of firing; the stall timer at 60ms must see the same signal
    // (S6) and return without setting `stalled`, instead of re-relabeling
    // this Stop as a watchdog failure.
    rt.stop({ sessionId: 'ttft-6' });

    await sendPromise;

    expect(events.some((e) => e.type === 'session.failed')).toBe(false);
    const stopped = events.find((e) => e.type === 'session.stopped');
    expect(stopped).toBeTruthy();
  });
});

describe('claudeRuntime stall watchdog (C-14) — abort guard (S6, round-2 iteration-3 review)', () => {
  const savedTtft = process.env.AICLIENT_HOST_TTFT_TIMEOUT_MS;
  const savedStall = process.env.AICLIENT_HOST_STALL_TIMEOUT_MS;

  afterEach(() => {
    if (savedTtft === undefined) delete process.env.AICLIENT_HOST_TTFT_TIMEOUT_MS;
    else process.env.AICLIENT_HOST_TTFT_TIMEOUT_MS = savedTtft;
    if (savedStall === undefined) delete process.env.AICLIENT_HOST_STALL_TIMEOUT_MS;
    else process.env.AICLIENT_HOST_STALL_TIMEOUT_MS = savedStall;
  });

  it('a Stop whose stream is slow to unwind past the stall deadline ends as session.stopped, not a stall failure — isolated from the TTFT watchdog (disabled here)', async () => {
    process.env.AICLIENT_HOST_TTFT_TIMEOUT_MS = '0'; // disabled — isolates this to the stall watchdog alone
    process.env.AICLIENT_HOST_STALL_TIMEOUT_MS = '20';
    const events: Record<string, unknown>[] = [];
    const rt = new ClaudeRuntime({
      driver: 'agent-sdk',
      cliPath: 'unused-in-fake',
      env: {},
      emit: (e) => events.push(e),
      log: () => undefined,
      registry: new SessionRegistry(),
      // Abort fires at t≈5ms; the stream only unwinds 40ms later — well
      // after the 20ms stall deadline fires once, on an already-aborted turn.
      queryFn: makeSlowToUnwindQueryFn(40),
    });
    rt.createSession({ sessionId: 'stall-abort-1', workspacePath: process.cwd() });

    const sendPromise = rt.send({ sessionId: 'stall-abort-1', text: 'hi' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    rt.stop({ sessionId: 'stall-abort-1' });

    await sendPromise;

    expect(events.some((e) => e.type === 'session.failed')).toBe(false);
    const stopped = events.find((e) => e.type === 'session.stopped');
    expect(stopped).toBeTruthy();
  });

  /** Fake queryFn: one productive event immediately, then total silence
   * forever — no Stop, no further events — until the caller's own abort
   * fires (the stall watchdog's), at which point it unwinds like the real
   * SDK does on an aborted query. */
  function makeStallThenHangQueryFn() {
    return (params: {
      prompt: string | AsyncIterable<unknown>;
      options?: Record<string, unknown>;
    }) => {
      const abort = params.options?.abortController as AbortController;
      const iterable = (async function* () {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } };
        await new Promise<void>((resolve) => {
          if (abort.signal.aborted) {
            resolve();
            return;
          }
          abort.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        throw new Error('AbortError: aborted');
      })();
      return Object.assign(iterable, { close: () => undefined });
    };
  }

  // Iteration-4 fix: the test above only pins the NEGATIVE case (an already-
  // aborted turn must not be relabeled a stall). Nothing previously asserted
  // the POSITIVE case — that a genuine, un-aborted stall still fires. If a
  // future edit widens the `onStall` abort guard (e.g. to
  // `if (abort.signal.aborted || !session.running) return;`), every stall
  // watchdog would silently stop firing and hung turns would hang forever
  // with no `session.failed` — and the suite would stay green, because the
  // only stall-watchdog assertions were "must NOT fail".
  it('a genuine mid-turn stall — no Stop, no abort from the caller — still ends as an honest stall session.failed', async () => {
    process.env.AICLIENT_HOST_TTFT_TIMEOUT_MS = '0'; // disabled — isolates this to the stall watchdog alone
    process.env.AICLIENT_HOST_STALL_TIMEOUT_MS = '40';
    const events: Record<string, unknown>[] = [];
    const rt = new ClaudeRuntime({
      driver: 'agent-sdk',
      cliPath: 'unused-in-fake',
      env: {},
      emit: (e) => events.push(e),
      log: () => undefined,
      registry: new SessionRegistry(),
      queryFn: makeStallThenHangQueryFn(),
    });
    rt.createSession({ sessionId: 'stall-abort-2', workspacePath: process.cwd() });

    await rt.send({ sessionId: 'stall-abort-2', text: 'hi' });

    const failed = events.find((e) => e.type === 'session.failed');
    expect(failed).toBeTruthy();
    const message = String((failed?.payload as { error?: string } | undefined)?.error ?? '');
    expect(message).toContain('Host stall watchdog');
    expect(events.some((e) => e.type === 'session.stopped')).toBe(false);
  });
});

describe('claudeRuntime result draining (round-2 F10: drain-with-deadline, not break-on-result)', () => {
  /** Fake queryFn: productive event, then result, then keeps the generator
   * alive for `postResultDelayMs` (simulating the CLI child still flushing
   * its own transcript) before finishing. */
  function makeDrainingQueryFn(postResultDelayMs: number) {
    return (_params: {
      prompt: string | AsyncIterable<unknown>;
      options?: Record<string, unknown>;
    }) => {
      const iterable = (async function* () {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } };
        yield { type: 'result', result: 'done' };
        await new Promise((resolve) => setTimeout(resolve, postResultDelayMs));
      })();
      return Object.assign(iterable, { close: () => undefined });
    };
  }

  it('clears the admission gate at the result event, letting a new send land while the stream is still draining', async () => {
    const events: Record<string, unknown>[] = [];
    const rt = new ClaudeRuntime({
      driver: 'agent-sdk',
      cliPath: 'unused-in-fake',
      env: {},
      emit: (e) => events.push(e),
      log: () => undefined,
      registry: new SessionRegistry(),
      queryFn: makeDrainingQueryFn(200),
    });
    rt.createSession({ sessionId: 's20', workspacePath: process.cwd() });

    const firstSend = rt.send({ sessionId: 's20', text: 'first' });
    // Let the loop ingest assistant + result (near-instant) while the fake
    // stream's generator is still "draining" (asleep for 200ms afterward).
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events.some((e) => e.type === 'session.completed')).toBe(true);

    // The admission gate is already clear well before the stream itself
    // finishes draining — a second send for the SAME session must not be
    // refused with session_busy.
    events.length = 0;
    await rt.send({ sessionId: 's20', text: 'second' });
    expect(
      events.some(
        (e) =>
          e.type === 'host.error' &&
          (e.payload as { code?: string } | undefined)?.code === 'session_busy'
      )
    ).toBe(false);
    expect(events.some((e) => e.type === 'session.completed')).toBe(true);

    await firstSend;
  });

  /** Fake queryFn: like `makeDrainingQueryFn`, but the post-result drain
   * itself reacts to the abort signal (as the real SDK's stream does) —
   * `makeDrainingQueryFn`'s fixed `setTimeout` ignores it entirely, which
   * would make a stop-during-drain test pass or fail on the WRONG mechanism
   * (this repo's own `DRAIN_AFTER_RESULT_MS` deadline, not the abort). */
  function makeAbortableDrainingQueryFn(postResultDelayMs: number) {
    return (params: {
      prompt: string | AsyncIterable<unknown>;
      options?: Record<string, unknown>;
    }) => {
      const abort = params.options?.abortController as AbortController;
      const iterable = (async function* () {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } };
        yield { type: 'result', result: 'done' };
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, postResultDelayMs);
          abort.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(new Error('AbortError: aborted'));
            },
            { once: true }
          );
        });
      })();
      return Object.assign(iterable, { close: () => undefined });
    };
  }

  it('R6: stop() during the post-result drain window aborts the drain and emits an honest idle terminal, never echoing the stale "running" status', async () => {
    const events: Record<string, unknown>[] = [];
    const rt = new ClaudeRuntime({
      driver: 'agent-sdk',
      cliPath: 'unused-in-fake',
      env: {},
      emit: (e) => events.push(e),
      log: () => undefined,
      registry: new SessionRegistry(),
      // Drains for 500ms after result unless aborted sooner — long enough
      // that a Stop landing just after `result` is clearly still inside the
      // drain window.
      queryFn: makeAbortableDrainingQueryFn(500),
    });
    rt.createSession({ sessionId: 's21', workspacePath: process.cwd() });

    const sendPromise = rt.send({ sessionId: 's21', text: 'hi' });
    // Let assistant + result land — `session.running` clears, but
    // `session.abort` stays alive for the rest of the 500ms drain.
    await new Promise((resolve) => setTimeout(resolve, 20));
    events.length = 0;

    rt.stop({ sessionId: 's21' });

    // The old `!session.running || !session.abort` early return would have
    // echoed back the registry's still-stale `session.status` — 'running',
    // since that field is only corrected AFTER the drain loop exits — and
    // aborted nothing.
    const statusRightAfterStop = events.filter((e) => e.type === 'session.status');
    expect(
      statusRightAfterStop.some((e) => (e.payload as { status?: string })?.status === 'running')
    ).toBe(false);

    const start = Date.now();
    await sendPromise;
    const elapsed = Date.now() - start;

    // The drain was actually aborted, not left to hang out the full 500ms.
    expect(elapsed).toBeLessThan(400);
    expect(events.some((e) => e.type === 'session.stopped')).toBe(true);
    const finalStatus = events.filter((e) => e.type === 'session.status').pop();
    expect((finalStatus?.payload as { status?: string } | undefined)?.status).toBe('idle');
  });

  it('R8: a stream that hangs past DRAIN_AFTER_RESULT_MS after result hits the deadline branch and still tears down cleanly', async () => {
    const savedDrain = process.env.AICLIENT_HOST_DRAIN_AFTER_RESULT_MS;
    process.env.AICLIENT_HOST_DRAIN_AFTER_RESULT_MS = '30';
    try {
      const events: Record<string, unknown>[] = [];
      const rt = new ClaudeRuntime({
        driver: 'agent-sdk',
        cliPath: 'unused-in-fake',
        env: {},
        emit: (e) => events.push(e),
        log: () => undefined,
        registry: new SessionRegistry(),
        // Hangs far longer (5s) than the 30ms cap — only the deadline
        // branch (`Promise.race` against `drainDeadline`) can end this.
        queryFn: makeDrainingQueryFn(5_000),
      });
      rt.createSession({ sessionId: 's22', workspacePath: process.cwd() });

      const start = Date.now();
      await rt.send({ sessionId: 's22', text: 'hi' });
      const elapsed = Date.now() - start;

      // Must return once the 30ms drain deadline elapses, not wait out the
      // full 5s hang.
      expect(elapsed).toBeLessThan(1_000);
      expect(events.some((e) => e.type === 'session.completed')).toBe(true);
      expect(events.some((e) => e.type === 'session.failed')).toBe(false);

      // Clean teardown: a later send on the same session is not refused
      // with session_busy (registry.running/status both correctly settled).
      events.length = 0;
      await rt.send({ sessionId: 's22', text: 'again' });
      expect(
        events.some(
          (e) =>
            e.type === 'host.error' &&
            (e.payload as { code?: string } | undefined)?.code === 'session_busy'
        )
      ).toBe(false);
    } finally {
      if (savedDrain === undefined) delete process.env.AICLIENT_HOST_DRAIN_AFTER_RESULT_MS;
      else process.env.AICLIENT_HOST_DRAIN_AFTER_RESULT_MS = savedDrain;
    }
  });
});

describe('claudeRuntime post-result drain ownership (R5, round-2 iteration-2 review)', () => {
  /** Fake queryFn: first call yields assistant+result, drains for a bit,
   * then THROWS (simulating `ProcessTransport.getProcessExitError` rethrowing
   * after the terminal `result` message). Every subsequent call behaves
   * like an ordinary healthy turn. */
  function makeThrowDuringDrainThenNormalQueryFn(postResultDelayMs: number) {
    let callCount = 0;
    return (_params: {
      prompt: string | AsyncIterable<unknown>;
      options?: Record<string, unknown>;
    }) => {
      callCount += 1;
      const isFirstCall = callCount === 1;
      const iterable = (async function* () {
        if (isFirstCall) {
          yield { type: 'assistant', message: { content: [{ type: 'text', text: 'first' }] } };
          yield { type: 'result', result: 'done-1' };
          await new Promise((resolve) => setTimeout(resolve, postResultDelayMs));
          throw new Error('Claude Code process exited with code 1');
        }
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'second' }] } };
        yield { type: 'result', result: 'done-2' };
      })();
      return Object.assign(iterable, { close: () => undefined });
    };
  }

  it('logs (does not report) a drain-phase throw from an OLD turn once a NEWER turn has taken over the session', async () => {
    const events: Record<string, unknown>[] = [];
    const logs: unknown[][] = [];
    const rt = new ClaudeRuntime({
      driver: 'agent-sdk',
      cliPath: 'unused-in-fake',
      env: {},
      emit: (e) => events.push(e),
      log: (...args) => logs.push(args),
      registry: new SessionRegistry(),
      queryFn: makeThrowDuringDrainThenNormalQueryFn(50),
    });
    rt.createSession({ sessionId: 's23', workspacePath: process.cwd() });

    const firstSend = rt.send({ sessionId: 's23', text: 'first' });
    // Let the first turn's assistant + result land — the admission gate
    // clears well before its 50ms drain-phase throw.
    await new Promise((resolve) => setTimeout(resolve, 10));
    events.length = 0;

    // A second turn is admitted (and fully completes) WHILE the first is
    // still nominally "draining" — its own throw has not fired yet.
    await rt.send({ sessionId: 's23', text: 'second' });

    // The first turn's drain-phase throw fires only now (t≈50ms), well
    // after the second turn already owns `session.abort`.
    await firstSend;

    expect(events.some((e) => e.type === 'session.failed')).toBe(false);
    expect(events.filter((e) => e.type === 'session.completed')).toHaveLength(1);
    expect(logs.some((args) => String(args.join(' ')).includes('no longer owns session'))).toBe(
      true
    );
  });
});

describe('normalizeEffort', () => {
  it('accepts every level the SDK declares', () => {
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
      expect(normalizeEffort(level)).toBe(level);
    }
  });

  it('rejects unknown, empty, and non-string values', () => {
    for (const bad of ['', 'HIGH', 'ultra', 0, 1, null, undefined, {}, ['high'], true]) {
      expect(normalizeEffort(bad)).toBeUndefined();
    }
  });
});
