/**
 * The plugin graph's own guarantees.
 *
 * The one worth a test above all others is the PENDING trap documented in
 * `bootstrap.ts`: `ctx.plugin()` settles even when a plugin's injects are
 * unmet, so "the bootstrap awaited every registration" is not the same claim as
 * "the runtime is usable". These cases pin the difference.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it('stamps the engine as native whatever the environment says (P6-5)', async () => {
    const byDefault = await createRuntime({ providers: [faux().provider], env: {} });
    // The variable that used to select an engine was deleted with that engine.
    // Setting it must be inert, not a way to ask for something that is gone.
    const stale = await createRuntime({
      providers: [faux().provider],
      env: { AICLIENT_RUNTIME_BACKEND: 'legacy' },
    });
    try {
      expect(byDefault.flags.backend).toBe('native');
      expect(stale.flags.backend).toBe('native');
    } finally {
      await byDefault.dispose();
      await stale.dispose();
    }
  });

  it('fails with a fixable message when no catalog directory is configured', async () => {
    await expect(createRuntime({ env: {} })).rejects.toThrow(RuntimeConfigError);
    await expect(createRuntime({ env: {} })).rejects.toThrow(/AICLIENT_RUNTIME_AGENT_DIR/);
  });

  /**
   * P5-5. `models.json` + `auth.json` exist for the LEGACY backend — pi can
   * only be configured through files, so the app decrypts the user's keys and
   * writes them out. Leaving native on the same files made a coexistence-period
   * measure load-bearing for the backend meant to outlive it.
   */
  it('takes the catalog the host supplies instead of reading a directory', async () => {
    const runtime = await createRuntime({
      env: {},
      modelCatalog: {
        models: {
          providers: {
            gw: {
              api: 'anthropic-messages',
              baseUrl: 'https://gw.example',
              models: [{ id: 'claude-sonnet-5' }],
            },
          },
        },
        auth: { gw: { type: 'api_key', key: 'sk-in-memory' } },
      },
    });
    try {
      expect(runtime.model.list()).toEqual([{ provider: 'gw', id: 'claude-sonnet-5' }]);
      expect(runtime.model.source).toEqual({
        kind: 'host',
        providerCount: 1,
        modelCount: 1,
        dropped: [],
      });
    } finally {
      await runtime.dispose();
    }
  });

  it('prefers the supplied catalog over a directory that also exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'runtime-bootstrap-'));
    try {
      await writeFile(
        join(dir, 'models.json'),
        JSON.stringify({
          providers: {
            onDisk: { api: 'openai-completions', baseUrl: 'https://x', models: [{ id: 'stale' }] },
          },
        })
      );
      const runtime = await createRuntime({
        env: {},
        agentDir: dir,
        modelCatalog: {
          models: {
            providers: {
              fresh: { api: 'openai-completions', baseUrl: 'https://y', models: [{ id: 'live' }] },
            },
          },
        },
      });
      try {
        expect(runtime.model.list()).toEqual([{ provider: 'fresh', id: 'live' }]);
      } finally {
        await runtime.dispose();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
      expect(stamp.config_version).toBe('runtime_p3_complete_v1');
      expect(stamp.backend).toBe('native');
      expect(stamp.single_turn).toBe('true');
      expect(stamp['dep:cordis']).toBe('4.0.0-rc.9');
      expect(stamp['dep:@earendil-works/pi-ai']).toBe('0.84.4');
    } finally {
      await runtime.dispose();
    }
  });
});
