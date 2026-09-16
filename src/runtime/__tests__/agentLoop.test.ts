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

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '@earendil-works/pi-agent-core';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { describe, expect, it } from 'vitest';
import { createRuntime } from '../bootstrap.ts';
import { traceSafeToolArgs } from '../plugins/agent-loop/index.ts';

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
    const failed = fauxAssistantMessage('', {
      stopReason: 'error',
      errorMessage: 'upstream returned HTTP 500',
    });
    await withRuntime(failed, async (runtime) => {
      const result = await runtime.run({ prompt: 'say ready', systemPrompt: 'probe' });
      expect(result.success).toBe(false);
      expect(result.error).toEqual({
        code: 'stop_error',
        message: 'upstream returned HTTP 500',
      });
      expect(result.trace.success).toBe(false);
      expect(result.trace.error?.code).toBe('stop_error');
    });
  });

  it('redacts a bearer token out of a provider error before it reaches the trace or the run result (core-host-03)', async () => {
    // pi-ai folds the raw HTTP response body into `errorMessage`; a gateway
    // that echoes request headers back in its error body would otherwise
    // write the credential straight into runs.jsonl (0600, but plaintext).
    const secret = 'sk-live-verysecret-1234567890';
    const failed = fauxAssistantMessage('', {
      stopReason: 'error',
      errorMessage: `502 upstream body: {"detail":"Authorization: Bearer ${secret}"}`,
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
      errorMessage: `502: ${'x'.repeat(5000)}`,
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

  it('appends every run to the trace sink in order', async () => {
    await withRuntime(fauxAssistantMessage('first'), async (runtime, faux) => {
      faux.appendResponses([fauxAssistantMessage('second')]);
      await runtime.run({ prompt: 'one', systemPrompt: 'probe', runId: 'run_a' });
      await runtime.run({ prompt: 'two', systemPrompt: 'probe', runId: 'run_b' });
      expect(runtime.trace.runs.map((run) => run.run_id)).toEqual(['run_a', 'run_b']);
      expect(runtime.trace.runs.map((run) => run.final_output)).toEqual(['first', 'second']);
      // One `note` for the run header and one `llm` per completed turn - the
      // §2 trace shape every later phase appends to rather than replaces.
      expect(runtime.trace.runs[0].steps.map((step) => step.type)).toEqual(['note', 'llm']);
    });
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
