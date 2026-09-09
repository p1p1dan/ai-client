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

import type { AgentEvent } from '@earendil-works/pi-agent-core';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { describe, expect, it } from 'vitest';
import { createRuntime } from '../bootstrap.ts';

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
        delay_ms: 1_000,
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
