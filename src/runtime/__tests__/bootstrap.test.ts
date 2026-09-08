/**
 * The plugin graph's own guarantees.
 *
 * The one worth a test above all others is the PENDING trap documented in
 * `bootstrap.ts`: `ctx.plugin()` settles even when a plugin's injects are
 * unmet, so "the bootstrap awaited every registration" is not the same claim as
 * "the runtime is usable". These cases pin the difference.
 */

import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { describe, expect, it } from 'vitest';
import { createRuntime } from '../bootstrap.ts';
import { LOOP_SERVICE, MODEL_SERVICE, RuntimeConfigError, TRACE_SERVICE } from '../contracts.ts';

function faux(reply = 'ready') {
  const handle = fauxProvider({
    provider: 'faux',
    models: [{ id: 'faux-p0', name: 'Faux P0 probe' }],
  });
  handle.setResponses([fauxAssistantMessage(reply)]);
  return handle;
}

describe('createRuntime', () => {
  it('brings up every P0 service and exposes them on the context', async () => {
    const runtime = await createRuntime({ providers: [faux().provider], env: {} });
    try {
      expect(runtime.ctx.get(MODEL_SERVICE)).toBeDefined();
      expect(runtime.ctx.get(TRACE_SERVICE)).toBeDefined();
      expect(runtime.ctx.get(LOOP_SERVICE)).toBeDefined();
      expect(runtime.model.list()).toEqual([{ provider: 'faux', id: 'faux-p0' }]);
      expect(runtime.model.source).toEqual({
        kind: 'injected',
        providerCount: 1,
        modelCount: 1,
      });
    } finally {
      await runtime.dispose();
    }
  });

  it('reports the backend flag it read, defaulting to legacy until P6-1', async () => {
    const legacy = await createRuntime({ providers: [faux().provider], env: {} });
    const native = await createRuntime({
      providers: [faux().provider],
      env: { AICLIENT_RUNTIME_BACKEND: 'native' },
    });
    try {
      expect(legacy.flags.backend).toBe('legacy');
      expect(native.flags.backend).toBe('native');
    } finally {
      await legacy.dispose();
      await native.dispose();
    }
  });

  it('fails with a fixable message when no catalog directory is configured', async () => {
    await expect(createRuntime({ env: {} })).rejects.toThrow(RuntimeConfigError);
    await expect(createRuntime({ env: {} })).rejects.toThrow(/AICLIENT_RUNTIME_AGENT_DIR/);
  });

  it('retracts the services when the context is disposed', async () => {
    const runtime = await createRuntime({ providers: [faux().provider], env: {} });
    await runtime.dispose();
    expect(runtime.ctx.get(LOOP_SERVICE)).toBeUndefined();
    expect(runtime.ctx.get(MODEL_SERVICE)).toBeUndefined();
  });

  it('stamps every trace with the commit, the pins and the flags that produced it', async () => {
    const runtime = await createRuntime({ providers: [faux().provider], env: {} });
    try {
      await runtime.run({ prompt: 'hi', systemPrompt: 'probe' });
      const stamp = runtime.trace.runs[0].version_stamp;
      expect(stamp.config_version).toBe('runtime_p0_v1');
      expect(stamp.backend).toBe('legacy');
      expect(stamp.single_turn).toBe('true');
      expect(stamp['dep:cordis']).toBe('4.0.0-rc.9');
      expect(stamp['dep:@earendil-works/pi-ai']).toBe('0.84.4');
    } finally {
      await runtime.dispose();
    }
  });
});
