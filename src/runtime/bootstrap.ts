import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from 'cordis';
import type { PortableExtensionUiBridgeOptions } from '../agent-host/extensionUiBridge.ts';
import {
  type AgentLoopService,
  EVENTS_SERVICE,
  type ModelAdapterService,
  PROMPT_SERVICE,
  RUNTIME_SERVICES,
  RuntimeConfigError,
  type RuntimeEventsService,
  type RuntimeExecService,
  type RuntimeHostConfig,
  type RuntimeHostIoService,
  type RuntimePromptService,
  type RuntimeRunRequest,
  type RuntimeRunResult,
  type RuntimeSessionService,
  SESSION_SERVICE,
  type TraceService,
} from './contracts.ts';
import { EventsPlugin } from './events/index.ts';
import { type RuntimeFlags, readRuntimeFlags } from './flags.ts';
import { standaloneHost, validateHost } from './host/config.ts';
import { RuntimeHostError } from './host/errors.ts';
import { commandEnvironment, ExecPlugin } from './host/exec.ts';
import { HostIoPlugin } from './host/io.ts';
import {
  type AgentLoopConfig,
  AgentLoopPlugin,
  DEFAULT_AGENT_LOOP_CONFIG,
} from './plugins/agent-loop/index.ts';
import {
  CONTEXT_SERVICE,
  type ContextConfig,
  ContextPlugin,
  type RuntimeContextService,
} from './plugins/context/index.ts';
import { readPiCatalog } from './plugins/model-adapter/catalog.ts';
import { type ModelAdapterConfig, ModelAdapterPlugin } from './plugins/model-adapter/index.ts';
import {
  createRuntimeApprovalBridge,
  type RuntimeApprovalBridge,
} from './plugins/permissions/bridge.ts';
import {
  PERMISSIONS_SERVICE,
  type PermissionConfig,
  PermissionsPlugin,
  type RuntimePermissionsService,
} from './plugins/permissions/index.ts';
import { loadPermissionPolicy } from './plugins/permissions/policy.ts';
import { type PromptConfig, PromptPlugin } from './plugins/prompt/index.ts';
import { SessionPlugin } from './plugins/session/index.ts';
import { prepareSessionConfig } from './plugins/session/legacy.ts';
import { JsonlSessionStore, type SessionConfig } from './plugins/session/store.ts';
import { TOOLS_SERVICE, type ToolsConfig, ToolsPlugin } from './plugins/tools/index.ts';
import { canonicalPath } from './plugins/tools/paths.ts';
import { buildVersionStamp, TracePlugin } from './trace.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const RUNTIME_CONFIG_VERSION = 'runtime_p3_complete_v1';

export interface RuntimeBootstrapOptions {
  env?: NodeJS.ProcessEnv;
  host?: RuntimeHostConfig;
  tools?: ToolsConfig;
  permissions?: Omit<PermissionConfig, 'cwd' | 'policy'>;
  context?: ContextConfig;
  prompt?: PromptConfig;
  session?: SessionConfig;
  approvalUi?: PortableExtensionUiBridgeOptions;
  agentDir?: string;
  traceDir?: string | null;
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
  hostIo: RuntimeHostIoService;
  exec: RuntimeExecService;
  permissions?: RuntimePermissionsService;
  context?: RuntimeContextService;
  prompt: RuntimePromptService;
  session?: RuntimeSessionService;
  events: RuntimeEventsService;
  approval?: RuntimeApprovalBridge;
  run(request: RuntimeRunRequest): Promise<RuntimeRunResult>;
  dispose(): Promise<void>;
}

export async function createRuntime(options: RuntimeBootstrapOptions = {}): Promise<RuntimeHandle> {
  const env = options.env ?? process.env;
  const flags = readRuntimeFlags(env);
  // Only the standalone entry may infer its carrier. Electron must supply one.
  const suppliedHost = options.host ?? standaloneHost({});
  const host = {
    ...suppliedHost,
    childEnv: { ...suppliedHost.childEnv },
    node: suppliedHost.node ? { ...suppliedHost.node } : undefined,
  };
  await validateHost(host);
  const ctx = new Context();
  const active = new Set<Promise<RuntimeRunResult>>();
  const controller = new AbortController();
  let disposal: Promise<void> | undefined;
  let exec: ExecPlugin | undefined;
  let io: HostIoPlugin | undefined;
  let approval: RuntimeApprovalBridge | undefined;
  let session: JsonlSessionStore | undefined;
  try {
    await ctx.plugin(ExecPlugin, host);
    exec = ctx.runtimeExec as ExecPlugin;
    const ioFiber = await ctx.plugin(HostIoPlugin, host);
    await ioFiber.await();
    io = ctx.runtimeHostIo as HostIoPlugin;
    if (options.session) {
      if (
        options.tools &&
        (await io.realpath(options.tools.cwd)) !== (await io.realpath(options.session.cwd))
      ) {
        throw new RuntimeConfigError(
          'session_cwd_mismatch',
          'tools and session must share a workspace'
        );
      }
      session = await JsonlSessionStore.open(io, await prepareSessionConfig(io, options.session));
      const sessionFiber = await ctx.plugin(SessionPlugin, session);
      await sessionFiber.await();
    }
    const loopConfig = {
      ...DEFAULT_AGENT_LOOP_CONFIG,
      singleTurn: !options.tools,
      ...options.loop,
    };
    const agentDir = options.agentDir ?? flags.agentDir;
    if (options.tools) {
      const cwd = await io.realpath(options.tools.cwd);
      if (options.approvalUi) approval = createRuntimeApprovalBridge(options.approvalUi);
      const scopes = await Promise.all(
        (options.permissions?.scopes ?? []).map(async (scope) => ({
          ...scope,
          root: await canonicalPath(ctx.runtimeHostIo, cwd, scope.root),
          tools: [...scope.tools],
        }))
      );
      const permissionsFiber = await ctx.plugin(PermissionsPlugin, {
        ...session?.snapshot().permissions,
        ...options.permissions,
        cwd,
        scopes,
        policy: await loadPermissionPolicy(io, {
          cwd,
          agentDir,
          projectTrusted: options.permissions?.projectTrusted,
        }),
        approve: options.permissions?.approve ?? approval?.approve,
      });
      await permissionsFiber.await();
      const toolsFiber = await ctx.plugin(ToolsPlugin, {
        ...options.tools,
        cwd,
        shellEnv: commandEnvironment(host, undefined),
      });
      await toolsFiber.await();
    }
    // After the tools plugin, because this is what registers `new_context`:
    // the compaction consumer and the tool that requests it land together
    // (plan board P1-9 / P2-8) or not at all.
    const eventsFiber = await ctx.plugin(EventsPlugin);
    await eventsFiber.await();
    const contextFiber = await ctx.plugin(ContextPlugin, options.context ?? {});
    await contextFiber.await();
    const promptFiber = await ctx.plugin(PromptPlugin, {
      ...options.prompt,
      root: options.prompt?.root ?? options.tools?.cwd,
      globals: [
        ...(agentDir ? [{ path: join(agentDir, 'AGENTS.md'), label: 'Managed AGENTS.md' }] : []),
        ...(options.prompt?.globals ?? []),
      ],
    });
    await promptFiber.await();
    const traceDir = options.traceDir === undefined ? flags.traceDir : options.traceDir;
    if (traceDir) await io.mkdir(traceDir, { recursive: true, mode: 0o700 });
    const stamp = await buildVersionStamp({
      io,
      repoRoot: REPO_ROOT,
      configVersion: RUNTIME_CONFIG_VERSION,
      extra: {
        backend: flags.backend,
        single_turn: String(loopConfig.singleTurn),
        tools: String(Boolean(options.tools)),
        mode: options.tools ? ctx.runtimePermissions.mode : 'agent',
        permission_gear: options.tools ? ctx.runtimePermissions.gear : 'ask',
        ...(options.tools
          ? {
              permission_policy_sha256: createHash('sha256')
                .update(JSON.stringify(ctx.runtimePermissions.policy?.config ?? {}))
                .digest('hex'),
              permission_policy_sources: JSON.stringify(
                ctx.runtimePermissions.policy?.sources ?? []
              ),
              permission_policy_notes: JSON.stringify(ctx.runtimePermissions.policy?.notes ?? []),
            }
          : {}),
        compaction: String(ctx.runtimeContext.enabled),
        compaction_family: ctx.runtimeContext.family,
        carrier: host.carrier,
        exec_stdio: exec.mode,
        exec_adapter: exec.adapterId,
        tsd_read_fallback: host.tsdReadFallback,
        cleanup_timeout_ms: String(host.cleanupTimeoutMs),
        ...(host.node ? { node_source: host.node.source, node_exec_path: host.node.path } : {}),
      },
    });
    await ctx.plugin(TracePlugin, {
      io,
      dir: traceDir,
      versionStamp: stamp,
      now: options.now,
      newRunId: options.newRunId,
    });
    if (!options.providers && !agentDir) {
      throw new RuntimeConfigError(
        'agent_dir_unset',
        'set AICLIENT_RUNTIME_AGENT_DIR or supply providers explicitly'
      );
    }
    const catalog =
      !options.providers && agentDir ? await readPiCatalog(agentDir, env, io) : undefined;
    await ctx.plugin(ModelAdapterPlugin, { providers: options.providers, catalog });
    const loopFiber = await ctx.plugin(AgentLoopPlugin, loopConfig);
    await loopFiber.await();
    const required = [
      ...RUNTIME_SERVICES,
      CONTEXT_SERVICE,
      EVENTS_SERVICE,
      ...(session ? [SESSION_SERVICE] : []),
      PROMPT_SERVICE,
      ...(options.tools ? [TOOLS_SERVICE, PERMISSIONS_SERVICE] : []),
    ];
    const missing = required.filter((name) => ctx.get(name) === undefined);
    if (missing.length)
      throw new RuntimeConfigError(
        'plugin_graph_incomplete',
        `missing services: ${missing.join(', ')}`
      );

    const runtimeExec = exec;
    const runtimeIo = io;
    return {
      ctx,
      flags,
      model: ctx.runtimeModel,
      trace: ctx.runtimeTrace,
      loop: ctx.runtimeLoop,
      hostIo: io,
      exec,
      permissions: options.tools ? ctx.runtimePermissions : undefined,
      context: ctx.runtimeContext,
      prompt: ctx.runtimePrompt,
      events: ctx.runtimeEvents,
      session: session ? ctx.runtimeSession : undefined,
      approval,
      run: (request) => {
        if (disposal)
          return Promise.reject(new RuntimeHostError('runtime_disposed', 'runtime is disposed'));
        if (active.size > 0 || session?.busy)
          return Promise.reject(
            new RuntimeHostError('runtime_busy', 'a run is already active in this runtime')
          );
        const signal = request.signal
          ? AbortSignal.any([controller.signal, request.signal])
          : controller.signal;
        session?.setRunning(true);
        const work = ctx.runtimeLoop.run({ ...request, signal });
        active.add(work);
        return work.finally(() => {
          active.delete(work);
          session?.setRunning(false);
        });
      },
      dispose: () => {
        disposal ??= (async () => {
          controller.abort();
          approval?.bridge.dispose();
          const outcomes = await Promise.allSettled([runtimeExec.shutdown(), ...active]);
          try {
            await ctx.runtimeTrace.flush();
          } finally {
            try {
              await session?.close();
            } finally {
              try {
                await runtimeIo.shutdown();
              } finally {
                await ctx.fiber.dispose();
              }
            }
          }
          const failed = outcomes.find((outcome) => outcome.status === 'rejected');
          if (failed?.status === 'rejected') throw failed.reason;
        })();
        return disposal;
      },
    };
  } catch (error) {
    approval?.bridge.dispose();
    try {
      await exec?.shutdown();
    } finally {
      try {
        await session?.close();
      } finally {
        try {
          await io?.shutdown();
        } finally {
          await ctx.fiber.dispose();
        }
      }
    }
    throw error;
  }
}
