/**
 * The plugin graph's own guarantees.
 *
 * The one worth a test above all others is the PENDING trap documented in
 * `bootstrap.ts`: `ctx.plugin()` settles even when a plugin's injects are
 * unmet, so "the bootstrap awaited every registration" is not the same claim as
 * "the runtime is usable". These cases pin the difference.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { describe, expect, it } from 'vitest';
import {
  createRuntime,
  RUNTIME_CONFIG_VERSION,
  type RuntimeBootstrapOptions,
} from '../bootstrap.ts';
import {
  LOOP_SERVICE,
  MODEL_SERVICE,
  RuntimeConfigError,
  type RuntimeHostConfig,
  TRACE_SERVICE,
} from '../contracts.ts';
import { standaloneHost } from '../host/config.ts';
import { RuntimeHostError } from '../host/errors.ts';

function faux(reply = 'ready') {
  const handle = fauxProvider({
    provider: 'faux',
    models: [{ id: 'faux-p0', name: 'Faux P0 probe' }],
  });
  handle.setResponses([fauxAssistantMessage(reply)]);
  return handle;
}

describe('createRuntime', () => {
  /**
   * decision 012 — the Extension UI bridge was the fallback approver, so
   * `bootstrap` used to read `options.permissions?.approve ?? approval?.approve`
   * and a host that supplied neither still got a runtime. It only failed at the
   * first gate, mid-turn, as an opaque tool denial with no hint of the missing
   * wiring. Tools imply a gate, so the refusal moved to construction.
   */
  it('refuses to build a runtime with tools and no way to answer a permission gate', async () => {
    /**
     * Reported as a plain value rather than asserted on the rejection: without
     * the guard this call SUCCEEDS, and a `rejects` matcher would then try to
     * print a live `RuntimeHandle` — whose Cordis context throws on the probes
     * the pretty-printer makes, burying the real failure. This also disposes
     * the runtime that should never have existed.
     */
    const build = (options: Partial<RuntimeBootstrapOptions>) =>
      createRuntime({ providers: [faux().provider], env: {}, traceDir: null, ...options }).then(
        async (handle) => {
          await handle.dispose();
          return { built: true, code: undefined, isHostError: false };
        },
        (error: unknown) => ({
          built: false,
          code: (error as { code?: string }).code,
          isHostError: error instanceof RuntimeHostError,
        })
      );
    const refused = { built: false, code: 'runtime_approval_missing', isHostError: true };

    expect(await build({ tools: { cwd: process.cwd() }, permissions: {} })).toEqual(refused);
    // Omitting the whole section is the same mistake, not a different one.
    expect(await build({ tools: { cwd: process.cwd() } })).toEqual(refused);
    // A runtime with no tools has no gate to answer, so it still builds.
    expect(await build({})).toMatchObject({ built: true });
  });

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
          auth: { fresh: { type: 'api_key', key: 'sk-fresh' } },
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

  /**
   * P1-0 section 5: a cleanup failure has to stay visible. TracePlugin's
   * persistence error is sticky, so a single failed trace append used to make
   * every later `dispose` leave through `flush()` — before the exec outcomes
   * were read at all. A child that survived teardown went unreported for the
   * rest of the session.
   */
  it('reports the trace flush failure and the exec cleanup failure from one dispose', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'runtime-dispose-failure-'));
    // A directory where the trace file goes: every append fails from here on.
    await mkdir(join(dir, 'runs.jsonl'));
    const host: RuntimeHostConfig = {
      ...standaloneHost({}),
      exec: {
        mode: 'host-adapter',
        adapter: {
          id: 'stuck-child-v1',
          run: async () => {
            throw new Error('not used');
          },
          dispose: async () => {
            throw new RuntimeHostError('exec_cleanup_failed', 'a child outlived the grace period');
          },
        },
      },
    };
    const runtime = await createRuntime({
      providers: [faux().provider],
      traceDir: dir,
      env: {},
      host,
    });
    try {
      await runtime.run({ prompt: 'hi', systemPrompt: 'probe' });
      const failure = await runtime.dispose().then(
        () => undefined,
        (error: unknown) => error
      );
      expect(failure).toBeInstanceOf(AggregateError);
      const errors = (failure as AggregateError).errors as Error[];
      expect(errors.map((error) => (error as { code?: string }).code)).toEqual(
        expect.arrayContaining(['exec_cleanup_failed', 'EISDIR'])
      );
      expect((failure as AggregateError).message).toContain('exec_cleanup_failed');
      expect((failure as AggregateError).message).toContain('EISDIR');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('stamps every trace with the commit, the pins and the flags that produced it', async () => {
    const runtime = await createRuntime({ providers: [faux().provider], env: {} });
    try {
      await runtime.run({ prompt: 'hi', systemPrompt: 'probe' });
      const stamp = runtime.trace.runs[0].version_stamp;
      expect(stamp.config_version).toBe(RUNTIME_CONFIG_VERSION);
      // Pinned as a literal too: a generation nobody ever raises is the defect
      // this assertion is here for (audit core-host-02), and a test that only
      // compares the constant to itself cannot see it.
      expect(stamp.config_version).toBe('runtime_p6_hardening_v1');
      expect(stamp.backend).toBe('native');
      expect(stamp.single_turn).toBe('true');
      expect(stamp['dep:cordis']).toBe('4.0.0-rc.9');
      expect(stamp['dep:@earendil-works/pi-ai']).toBe('0.84.4');
    } finally {
      await runtime.dispose();
    }
  });
});
