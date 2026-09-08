/**
 * P0-2 - Cordis bootstrap: build the plugin graph, prove it is live, hand back
 * a handle that can tear it down.
 *
 * ## The invariant this file exists for
 *
 * `ctx.plugin()` settles whether or not a plugin's `inject` dependencies are
 * satisfied - an unsatisfied plugin simply parks in `FiberState.PENDING` and
 * waits. That is the right behaviour for a hot-pluggable graph and the wrong
 * default for a bootstrap: awaiting every registration would otherwise "succeed"
 * on a half-wired runtime, and the failure would surface later as a missing
 * service at the first prompt. Verified directly against `cordis@4.0.0-rc.9` in
 * `spikes/p0-cordis-semantics.ts`; this module therefore ends by asserting that
 * every service in `P0_SERVICES` actually resolves, and names the missing ones
 * when it does not.
 *
 * The same spike also confirmed the disposal direction: disposing a fiber
 * retracts the services that injected it, so `dispose()` only has to drop the
 * root.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from 'cordis';
import {
  type AgentLoopService,
  type ModelAdapterService,
  P0_SERVICES,
  RuntimeConfigError,
  type RuntimeRunRequest,
  type RuntimeRunResult,
  type TraceService,
} from './contracts.ts';
import { type RuntimeFlags, readRuntimeFlags } from './flags.ts';
import {
  type AgentLoopConfig,
  AgentLoopPlugin,
  DEFAULT_AGENT_LOOP_CONFIG,
} from './plugins/agent-loop/index.ts';
import { type ModelAdapterConfig, ModelAdapterPlugin } from './plugins/model-adapter/index.ts';
import { buildVersionStamp, TracePlugin } from './trace.ts';

/** `<repo>/` - two levels up from `src/runtime/`. Used only for the version stamp. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Bumped whenever a change alters what reaches the provider (engineering standard §15). */
export const RUNTIME_CONFIG_VERSION = 'runtime_p0_v1';

export interface RuntimeBootstrapOptions {
  env?: NodeJS.ProcessEnv;
  /** Overrides the catalog directory the flags resolved. */
  agentDir?: string;
  /** Overrides the trace directory the flags resolved. `null` forces memory-only. */
  traceDir?: string | null;
  /** Replaces the on-disk catalog - see {@link ModelAdapterConfig.providers}. */
  providers?: ModelAdapterConfig['providers'];
  loop?: Partial<AgentLoopConfig>;
  now?: () => number;
  newRunId?: () => string;
}

export interface RuntimeHandle {
  ctx: Context;
  flags: RuntimeFlags;
  model: ModelAdapterService;
  trace: TraceService;
  loop: AgentLoopService;
  /** Convenience for the common one-call case; identical to `loop.run`. */
  run(request: RuntimeRunRequest): Promise<RuntimeRunResult>;
  dispose(): Promise<void>;
}

export async function createRuntime(options: RuntimeBootstrapOptions = {}): Promise<RuntimeHandle> {
  const env = options.env ?? process.env;
  const flags = readRuntimeFlags(env);
  const loopConfig: AgentLoopConfig = { ...DEFAULT_AGENT_LOOP_CONFIG, ...options.loop };
  const ctx = new Context();

  const traceDir = options.traceDir === undefined ? flags.traceDir : options.traceDir;
  await ctx.plugin(TracePlugin, {
    dir: traceDir,
    versionStamp: buildVersionStamp({
      repoRoot: REPO_ROOT,
      configVersion: RUNTIME_CONFIG_VERSION,
      extra: {
        // The backend flag is stamped from the first run onward even though
        // nothing reads it until P4-2. A trace whose stamp cannot say which
        // engine produced it is useless for the old/new comparison ARD D9
        // requires, and backfilling a stamp is not possible.
        backend: flags.backend,
        single_turn: String(loopConfig.singleTurn),
      },
    }),
    ...(options.now ? { now: options.now } : {}),
    ...(options.newRunId ? { newRunId: options.newRunId } : {}),
  });

  await ctx.plugin(ModelAdapterPlugin, {
    agentDir: options.agentDir ?? flags.agentDir,
    ...(options.providers ? { providers: options.providers } : {}),
    env,
  });

  const loopFiber = await ctx.plugin(AgentLoopPlugin, loopConfig);
  // The loop injects the two services above, so Cordis re-runs it once they
  // exist. Awaiting the fiber is what turns "registered" into "active".
  await loopFiber.await();

  assertServicesLive(ctx);

  return {
    ctx,
    flags,
    model: ctx.runtimeModel,
    trace: ctx.runtimeTrace,
    loop: ctx.runtimeLoop,
    run: (request) => ctx.runtimeLoop.run(request),
    dispose: async () => {
      await ctx.fiber.dispose();
    },
  };
}

function assertServicesLive(ctx: Context): void {
  const missing = P0_SERVICES.filter((name) => ctx.get(name) === undefined);
  if (missing.length === 0) return;
  throw new RuntimeConfigError(
    'plugin_graph_incomplete',
    `the plugin graph came up without ${missing.join(', ')} - a plugin is parked on an unmet inject`
  );
}
