/**
 * The loop's behaviour on the three outcomes P0 can produce: a normal turn, a
 * provider-reported failure, and a caller abort.
 *
 * pi-agent-core encodes provider failures IN the stream rather than throwing
 * (`StreamFn`'s contract), so "the run failed" has to be read off the final
 * assistant message. A loop that only caught exceptions would report every
 * upstream 500 as a success with empty text, which is the failure mode these
 * cases exist to prevent.
 */

import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '@earendil-works/pi-agent-core';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import { describe, expect, it } from 'vitest';
import { createRuntime } from '../bootstrap.ts';
import { standaloneHost } from '../host/config.ts';
import { resolveWorkerShell } from '../host/shell.ts';
import { traceSafeToolArgs } from '../plugins/agent-loop/index.ts';
import { neverAsked } from './fixtures/approval.ts';

async function withRuntime<T>(
  reply: ReturnType<typeof fauxAssistantMessage>,
  body: (
    runtime: Awaited<ReturnType<typeof createRuntime>>,
    faux: ReturnType<typeof fauxProvider>
  ) => Promise<T>
): Promise<T> {
  const handle = fauxProvider({
    provider: 'faux',
    models: [{ id: 'faux-p0', name: 'Faux P0 probe' }],
  });
  handle.setResponses([reply]);
  const runtime = await createRuntime({ providers: [handle.provider], env: {} });
  try {
    return await body(runtime, handle);
  } finally {
    await runtime.dispose();
  }
}

describe('agent loop', () => {
  it('carries one prompt to a complete streamed reply', async () => {
    await withRuntime(fauxAssistantMessage('ready'), async (runtime) => {
      const events: AgentEvent['type'][] = [];
      const result = await runtime.run({
        prompt: 'say ready',
        systemPrompt: 'probe',
        onEvent: (event) => events.push(event.type),
      });
      expect(result.success).toBe(true);
      expect(result.text).toBe('ready');
      expect(result.stopReason).toBe('stop');
      expect(result.turns).toBe(1);
      // The streamed path, not a single terminal message: `message_update` is
      // what proves the reply arrived incrementally.
      expect(events).toContain('message_update');
      expect(events).toContain('agent_end');
      expect(events).not.toContain('tool_execution_start');
    });
  });

  it('stops a single-turn run after its first assistant turn even when the model asks for a tool', async () => {
    // P0 probe (`singleTurn`, the default with no tools): a model that
    // requests a tool anyway must not start a second request. The queued
    // second reply is the tripwire — it stays unconsumed.
    await withRuntime(
      fauxAssistantMessage([fauxToolCall('read', { path: 'x' })], { stopReason: 'toolUse' }),
      async (runtime, faux) => {
        faux.appendResponses([fauxAssistantMessage('should never be requested')]);
        const result = await runtime.run({ prompt: 'probe', systemPrompt: 'probe' });
        expect(result.turns).toBe(1);
        expect(result.stopReason).toBe('toolUse');
        expect(faux.state.callCount).toBe(1);
        expect(faux.getPendingResponseCount()).toBe(1);
        expect(result.error?.code).not.toBe('turn_limit');
      }
    );
  });

  it('records the provider usage the D9 cache-rate gate will read', async () => {
    await withRuntime(fauxAssistantMessage('ready'), async (runtime) => {
      const result = await runtime.run({ prompt: 'say ready', systemPrompt: 'probe' });
      expect(result.usage).not.toBeNull();
      expect(result.usage).toMatchObject({
        input: expect.any(Number),
        output: expect.any(Number),
        cacheRead: expect.any(Number),
        cacheWrite: expect.any(Number),
      });
      expect(result.trace.usage).toEqual(result.usage);
    });
  });

  it('reports a provider failure as a failed run, not an empty success', async () => {
    // T093 note: the failure has to be a TERMINAL one to say only this. A
    // retriable message (any 5xx, or one with no status at all) is now re-asked
    // from the shared budget even after the stream started — see the
    // mid-stream case below — so using one here would be measuring the retry
    // ladder rather than the reporting.
    const failed = fauxAssistantMessage('', {
      stopReason: 'error',
      errorMessage: '400: upstream rejected the request',
    });
    await withRuntime(failed, async (runtime) => {
      const result = await runtime.run({ prompt: 'say ready', systemPrompt: 'probe' });
      expect(result.success).toBe(false);
      expect(result.error).toEqual({
        code: 'stop_error',
        message: '400: upstream rejected the request',
      });
      expect(result.trace.success).toBe(false);
      expect(result.trace.error?.code).toBe('stop_error');
    });
  });

  it('retries a stream that dies mid-way, from the same budget as a request-phase failure', async () => {
    // decision 029 clause 4, overturning the earlier "the parent loop only
    // takes pre-stream failures" trade-off. The delegate loop could already do
    // this; the conversation the user is actually watching could not, so a
    // gateway that dropped an answer halfway ended the turn outright — and with
    // the new body timeout that is precisely how a stalled stream now ends.
    const handle = fauxProvider({
      provider: 'faux',
      models: [{ id: 'faux-p0', name: 'Faux P0 probe' }],
    });
    handle.setResponses([
      // `start` IS emitted for this one — faux streams the text block before it
      // reports the error — which is what makes it the stream phase.
      fauxAssistantMessage('half an ans', {
        stopReason: 'error',
        errorMessage: '503: gateway dropped the stream',
      }),
      fauxAssistantMessage('the whole answer'),
    ]);
    const runtime = await createRuntime({ providers: [handle.provider], env: {} });
    try {
      const retries: unknown[] = [];
      runtime.events.subscribe((event) => {
        if (event.type === 'session.status' && event.payload.retry)
          retries.push(event.payload.retry);
      });
      const result = await runtime.run({ prompt: 'say something', systemPrompt: 'probe' });
      expect(result.success).toBe(true);
      expect(result.text).toContain('the whole answer');
      // The banner went up once — the user is told, which is the other half of
      // the complaint this fixes.
      expect(retries).toHaveLength(1);
      expect(retries[0]).toMatchObject({
        attempt: 1,
        maxRetries: 3,
        error: 'PROVIDER_ERROR',
        retryAt: expect.any(Number),
        attemptStartedAt: expect.any(Number),
      });
      // The rewind dropped the failed message rather than restarting the turn:
      // the recovered text stands alone instead of being appended to "half an
      // ans".
      expect(result.text).toBe('the whole answer');
    } finally {
      await runtime.dispose();
    }
  }, 30_000);

  it('redacts a bearer token out of a provider error before it reaches the trace or the run result (core-host-03)', async () => {
    // pi-ai folds the raw HTTP response body into `errorMessage`; a gateway
    // that echoes request headers back in its error body would otherwise
    // write the credential straight into runs.jsonl (0600, but plaintext).
    const secret = 'sk-live-verysecret-1234567890';
    const failed = fauxAssistantMessage('', {
      stopReason: 'error',
      // 403 rather than 502, so the run ends on this message: since T093 a
      // retriable mid-stream failure is re-asked, and this case is about what
      // the error TEXT looks like when it lands, not about the ladder.
      errorMessage: `403 upstream body: {"detail":"Authorization: Bearer ${secret}"}`,
    });
    await withRuntime(failed, async (runtime) => {
      const result = await runtime.run({ prompt: 'say ready', systemPrompt: 'probe' });
      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('[REDACTED]');
      expect(result.error?.message).not.toContain(secret);
      const llmStep = result.trace.steps.find((step) => step.type === 'llm');
      const traceMessage = (llmStep?.detail as { error_message?: string } | undefined)
        ?.error_message;
      expect(traceMessage).toContain('[REDACTED]');
      expect(traceMessage).not.toContain(secret);
    });
  });

  it('caps an oversized provider error at 600 characters before it reaches the trace', async () => {
    const failed = fauxAssistantMessage('', {
      stopReason: 'error',
      // 400 rather than 502, for the reason the case above states.
      errorMessage: `400: ${'x'.repeat(5000)}`,
    });
    await withRuntime(failed, async (runtime) => {
      const result = await runtime.run({ prompt: 'say ready', systemPrompt: 'probe' });
      const message = result.error?.message ?? '';
      expect(message.length).toBeLessThanOrEqual(601);
      expect(message.endsWith('…')).toBe(true);
      const llmStep = result.trace.steps.find((step) => step.type === 'llm');
      const traceMessage =
        (llmStep?.detail as { error_message?: string } | undefined)?.error_message ?? '';
      expect(traceMessage.length).toBeLessThanOrEqual(601);
    });
  });

  it('redacts the provider error body on its way into the session file, not only the trace (ah-lib-01)', async () => {
    // T011 sanitized the copy the collector builds, and the collector feeds the
    // trace and `RuntimeRunResult`. The session file is written one line
    // EARLIER, straight from `event.message`, so `runs.jsonl` came out clean
    // and the JSONL that outlives it — interoperable with `pi --session`,
    // read by import/export, the file a user attaches to a bug report — kept
    // the plaintext key.
    const dir = await mkdtemp(join(tmpdir(), 'runtime-provider-redaction-'));
    const secret = `sk-ant-api03-${'x'.repeat(40)}`;
    const sessionFile = join(dir, 'session.jsonl');
    const handle = fauxProvider({
      provider: 'faux',
      models: [{ id: 'faux-p0', name: 'Faux P0 probe' }],
    });
    handle.setResponses([
      fauxAssistantMessage('', {
        stopReason: 'error',
        // A self-hosted gateway echoing the request headers back in its 401
        // body — the shape ah-lib-01's scenario names.
        errorMessage: `401 upstream body: {"received":{"authorization":"Bearer ${secret}"}}`,
      }),
    ]);
    const runtime = await createRuntime({
      providers: [handle.provider],
      env: {},
      traceDir: null,
      session: { file: sessionFile, cwd: dir, mode: 'create' },
    });
    try {
      const result = await runtime.run({ prompt: 'say ready', systemPrompt: 'probe' });
      expect(result.success).toBe(false);
      const written = await readFile(sessionFile, 'utf8');
      expect(written).toContain('[REDACTED]');
      expect(written).not.toContain(secret);
      expect(written).not.toContain('sk-ant-api03');
    } finally {
      await runtime.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('asks for medium reasoning when the caller names no level', async () => {
    // EFFORT-1 follow-up (user decision, 2026-09-10): legacy never sends a level
    // unless the user picked one, so pi applies its own default of medium. This
    // loop has to name a value, and naming `off` made an untouched effort chip
    // mean different things on the two backends.
    await withRuntime(fauxAssistantMessage('ready'), async (runtime) => {
      await runtime.run({ prompt: 'say ready', systemPrompt: 'probe' });
      const header = runtime.trace.runs.at(-1)?.steps.find((step) => step.type === 'note');
      expect((header?.detail as { thinking_level?: string } | undefined)?.thinking_level).toBe(
        'medium'
      );
    });
  });

  it('still honours an explicit off', async () => {
    await withRuntime(fauxAssistantMessage('ready'), async (runtime) => {
      await runtime.run({ prompt: 'say ready', systemPrompt: 'probe', thinkingLevel: 'off' });
      const header = runtime.trace.runs.at(-1)?.steps.find((step) => step.type === 'note');
      expect((header?.detail as { thinking_level?: string } | undefined)?.thinking_level).toBe(
        'off'
      );
    });
  });

  it('retries a provider failure that arrives before the stream starts', async () => {
    // F4: pi-ai reports a setup failure as an error EVENT, so without the
    // retry layer in `streamFn` a gateway 503 ended the run on the first try.
    // The first scripted step throws before any `start` event, exactly as a
    // failed request does; the retry must reach the second one.
    await withRuntime(fauxAssistantMessage('recovered'), async (runtime, faux) => {
      faux.setResponses([
        () => {
          throw new Error('503: service unavailable');
        },
        fauxAssistantMessage('recovered'),
      ]);
      const result = await runtime.run({ prompt: 'say ready', systemPrompt: 'probe' });
      expect(result.success).toBe(true);
      expect(result.text).toBe('recovered');
      const retryNote = runtime.trace.runs
        .at(-1)
        ?.steps.find(
          (step) =>
            step.type === 'note' &&
            (step.detail as { event?: string } | undefined)?.event === 'provider_retry'
        );
      expect(retryNote?.detail).toMatchObject({
        code: 'PROVIDER_ERROR',
        attempt: 1,
        // The first rung of the 3s / 10s / 30s ladder (user ruling 2026-09-11).
        delay_ms: 3_000,
      });
    });
  });

  it('treats a pre-aborted signal as an aborted run', async () => {
    await withRuntime(fauxAssistantMessage('ready'), async (runtime) => {
      const result = await runtime.run({
        prompt: 'say ready',
        systemPrompt: 'probe',
        signal: AbortSignal.abort(),
      });
      expect(result.success).toBe(false);
      expect(result.stopReason).toBe('aborted');
      expect(result.error?.code).toBe('aborted');
    });
  });

  it('names an unknown model instead of silently falling back to the default', async () => {
    await withRuntime(fauxAssistantMessage('ready'), async (runtime) => {
      await expect(
        runtime.run({
          prompt: 'say ready',
          systemPrompt: 'probe',
          model: { provider: 'faux', id: 'not-in-catalog' },
        })
      ).rejects.toThrow(/not-in-catalog/);
    });
  });

  /**
   * cross-06. The drop reasons had exactly one reader — the `run_start` trace
   * note — and an empty catalog throws before the trace begins, so the one run
   * that needs them was the one run that could not write them. The user was
   * told the catalog was empty and nothing about why.
   */
  it('names the dropped providers when the catalog is empty', async () => {
    const runtime = await createRuntime({
      modelCatalog: {
        models: {
          providers: {
            'my-thing': { api: 'opencode_go', baseUrl: 'https://x.example', models: [{ id: 'a' }] },
            gw: { api: 'openai-completions', baseUrl: 'https://x.example', models: [{ id: 'b' }] },
          },
        },
        auth: {},
      },
      env: {},
    });
    try {
      await expect(runtime.run({ prompt: 'hi', systemPrompt: 'probe' })).rejects.toThrow(
        /my-thing:unknown_api.*gw:no_api_key/
      );
    } finally {
      await runtime.dispose();
    }
  });

  /**
   * T062 / D19. `session.failed` is one string, and the renderer decides which
   * recovery card to show from it. Before this, a send into a chat whose model
   * is gone arrived as a bare English sentence, so the "model is not available
   * here" card could not fire and the user got `Error: no model "…"`.
   */
  it('puts the failure code in front of the text a thrown run reaches the renderer as', async () => {
    const runtime = await createRuntime({
      modelCatalog: {
        models: {
          providers: {
            gw: { api: 'openai-completions', baseUrl: 'https://x.example', models: [{ id: 'a' }] },
          },
        },
        auth: { gw: { type: 'api_key', key: 'probe-key' } },
      },
      env: {},
    });
    const failures: string[] = [];
    runtime.events.subscribe((event) => {
      if (event.type === 'session.failed') failures.push(event.payload?.error ?? '');
    });
    try {
      await expect(
        runtime.run({
          prompt: 'hi',
          systemPrompt: 'probe',
          model: { provider: 'gw', id: 'gone' },
        })
      ).rejects.toThrow('no model "gw/gone"');
      // The code, then the runtime's own sentence — the sentence still names
      // the model, which is the only part a user can act on.
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatch(/^model_not_in_catalog: no model "gw\/gone" in the catalog \(/);
    } finally {
      await runtime.dispose();
    }
  });

  it('appends every run to the trace sink in order', async () => {
    await withRuntime(fauxAssistantMessage('first'), async (runtime, faux) => {
      faux.appendResponses([fauxAssistantMessage('second')]);
      await runtime.run({ prompt: 'one', systemPrompt: 'probe', runId: 'run_a' });
      await runtime.run({ prompt: 'two', systemPrompt: 'probe', runId: 'run_b' });
      expect(runtime.trace.runs.map((run) => run.run_id)).toEqual(['run_a', 'run_b']);
      expect(runtime.trace.runs.map((run) => run.final_output)).toEqual(['first', 'second']);
      // One `note` for the run header, one pair of `note`s per provider request
      // (T093: `provider_attempt_start` / `provider_attempt_end`, so "the turn
      // was slow" resolves into "which attempt, and how long did it take"), and
      // one `llm` per completed turn — the §2 trace shape every later phase
      // appends to rather than replaces.
      expect(runtime.trace.runs[0].steps.map((step) => step.type)).toEqual([
        'note',
        'note',
        'note',
        'llm',
      ]);
      expect(
        runtime.trace.runs[0].steps.map((step) => (step.detail as { event?: string })?.event)
      ).toEqual(['run_start', 'provider_attempt_start', 'provider_attempt_end', undefined]);
    });
  });
});

/**
 * T130 — Stop during a running bash used to settle the call `isError: false`:
 * the exec resolves `aborted` rather than throwing, and pi calls every
 * non-throwing result a success. The live event and the session file are the
 * two places the timeline reads the outcome from, so both are asserted.
 *
 * Reverse check: without the loop's `afterToolCall` hook this case fails.
 */
describe('T130 · a bash command Stop cut short', () => {
  it('[BASH-STOP-3] settles as an error, in the live event and in the session file', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'agent-loop-bash-stop-'));
    const sessionFile = join(workspace, 'session.jsonl');
    const faux = fauxProvider({
      provider: 'faux',
      models: [{ id: 'faux-bash-stop', name: 'Bash stop probe' }],
    });
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall('bash', { command: 'printf a; : > started; sleep 5' }, { id: 'b1' })],
        { stopReason: 'toolUse' }
      ),
      fauxAssistantMessage('spare reply'),
    ]);
    const runtime = await createRuntime({
      providers: [faux.provider],
      env: {},
      host: standaloneHost({ PATH: process.env.PATH }),
      tools: {
        cwd: workspace,
        shellPath: resolveWorkerShell(process.env as Record<string, string>),
      },
      permissions: { approve: neverAsked, gear: 'auto' },
      session: { cwd: workspace, mode: 'create', file: sessionFile },
      loop: { singleTurn: false },
    });
    try {
      const controller = new AbortController();
      const ends: Extract<AgentEvent, { type: 'tool_execution_end' }>[] = [];
      const run = runtime.run({
        prompt: 'run it',
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === 'tool_execution_end') ends.push(event);
        },
      });
      // Stop once the command's output is out (real child, appendix B1).
      const deadline = Date.now() + 10_000;
      for (;;) {
        try {
          await access(join(workspace, 'started'));
          break;
        } catch {
          if (Date.now() > deadline) throw new Error('the command never started');
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      controller.abort();
      const result = await run;
      expect(result.success).toBe(false);

      expect(ends).toHaveLength(1);
      expect(ends[0]).toMatchObject({ toolCallId: 'b1', isError: true });
      // The flag survives: flipping `isError` in the hook, not throwing, is
      // what keeps `details` intact for the projector.
      expect(ends[0]?.result.details).toMatchObject({ termination: 'aborted', stopped: true });

      await runtime.session?.flush();
      const rows = (await readFile(sessionFile, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { type?: string; message?: Record<string, unknown> });
      const toolResult = rows.find(
        (row) =>
          row.type === 'message' &&
          row.message?.role === 'toolResult' &&
          row.message.toolCallId === 'b1'
      )?.message as
        | { isError?: boolean; details?: unknown; content?: { type: string; text?: string }[] }
        | undefined;
      expect(toolResult).toMatchObject({ isError: true, details: { stopped: true } });
      // The partial output the model will see on the next turn is still there.
      expect(toolResult?.content?.[0]?.text?.startsWith('a')).toBe(true);
    } finally {
      await runtime.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

/**
 * capacity-02 — the tool step was the one trace field with no bound at all.
 *
 * `write` declares an 8 MiB `content` argument, and the whole of it used to be
 * held in the run's step array until `finish()` — past every budget T024 added,
 * and three orders of magnitude past the 4000-character approval preview
 * recorded beside it.
 */
describe('trace tool arguments', () => {
  it('truncates an oversized string argument to the preview cap', () => {
    const content = 'x'.repeat(50_000);
    const safe = traceSafeToolArgs({ path: '/tmp/a.txt', content }) as Record<string, string>;
    expect(safe.path).toBe('/tmp/a.txt');
    expect(safe.content.length).toBeLessThan(5000);
    expect(safe.content.endsWith('…')).toBe(true);
  });

  it('keeps the shape of the call, including nested and non-string values', () => {
    const safe = traceSafeToolArgs({
      command: 'ls',
      timeout: 5,
      nested: { deep: ['a'.repeat(50_000), 7, null] },
    }) as { command: string; timeout: number; nested: { deep: [string, number, null] } };
    expect(safe.command).toBe('ls');
    expect(safe.timeout).toBe(5);
    expect(safe.nested.deep[0].length).toBeLessThan(5000);
    expect(safe.nested.deep[1]).toBe(7);
    expect(safe.nested.deep[2]).toBeNull();
  });

  it('stops descending before a pathological nesting depth', () => {
    let value: unknown = 'leaf';
    for (let index = 0; index < 20; index++) value = { next: value };
    expect(JSON.stringify(traceSafeToolArgs(value))).toContain('elided');
  });
});
