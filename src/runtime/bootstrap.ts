import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from 'cordis';
import {
  DEFAULT_PROVIDER_IDLE_TIMEOUT_MS,
  providerRequestTimeoutMs,
} from '../shared/types/providerTimeout.ts';
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
import { configureProviderHttpDispatcher } from './host/httpDispatcher.ts';
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
import {
  connectMcpServers,
  MCP_SERVICE,
  type McpCatalog,
  type McpConfig,
  McpPlugin,
  type RuntimeMcpService,
} from './plugins/mcp/index.ts';
import { parsePiCatalog, readPiCatalog } from './plugins/model-adapter/catalog.ts';
import { type ModelAdapterConfig, ModelAdapterPlugin } from './plugins/model-adapter/index.ts';
import { restoredGrants } from './plugins/permissions/grants.ts';
import {
  PERMISSIONS_SERVICE,
  type PermissionConfig,
  PermissionsPlugin,
  type RuntimePermissionsService,
} from './plugins/permissions/index.ts';
import { loadPermissionPolicy } from './plugins/permissions/policy.ts';
import { type PromptConfig, PromptPlugin } from './plugins/prompt/index.ts';
import { instructionSource } from './plugins/prompt/instructionSource.ts';
import { projectInstructionsText } from './plugins/prompt/projectInstructions.ts';
import { SessionPlugin } from './plugins/session/index.ts';
import { prepareSessionConfig } from './plugins/session/legacy.ts';
import { JsonlSessionStore, type SessionConfig } from './plugins/session/store.ts';
import {
  loadSkillCatalog,
  type RuntimeSkillsService,
  SKILLS_SERVICE,
  type SkillCatalog,
  type SkillsConfig,
  SkillsPlugin,
  skillSource,
} from './plugins/skills/index.ts';
import {
  loadSubagentCatalog,
  type SubagentCatalog,
  type SubagentCatalogConfig,
} from './plugins/subagent/catalog.ts';
import {
  SUBAGENT_SERVICE,
  type SubagentConfig,
  SubagentPlugin,
  type SubagentService,
} from './plugins/subagent/index.ts';
import { TOOLS_SERVICE, type ToolsConfig, ToolsPlugin } from './plugins/tools/index.ts';
import { canonicalPath } from './plugins/tools/paths.ts';
import type { SettingSource } from './settingSources.ts';
import { buildVersionStamp, TracePlugin } from './trace.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** Definition documents are capped at 32 KiB by the parser; read a little more
 * so an oversized one is DIAGNOSED rather than silently truncated into shape. */
const SUBAGENT_SCAN_BYTES = 64 * 1024;
/**
 * The generation of THIS runtime's behaviour, stamped into every trace.
 *
 * It exists so two archived runs can be told apart by what the model saw and
 * what the run was allowed to do, not by their timestamps. Freezing it makes
 * every comparison since the freeze a guess, which is what happened between P3
 * and T028 (audit core-host-02): five batches of prompt, tool, compaction and
 * permission changes all stamped `runtime_p3_complete_v1`.
 *
 * ## When it must be raised
 *
 * Any change that makes a new trace non-comparable to an old one:
 *
 *  - the system prompt — segments, templates, project-instruction loading;
 *  - the tool set — a tool added, removed, renamed, or its schema changed;
 *  - compaction — thresholds, retention, what is carried across the boundary;
 *  - permission semantics — gears, tiers, what is auto-allowed or denied;
 *  - model binding and catalog resolution, including effort/thinking defaults;
 *  - the subagent contract — delegate budget, tool whitelist, report shape.
 *
 * Not: refactors with no behaviour change, renderer-only work, test-only work,
 * or a dependency bump (the stamp already carries `dep:*` pins separately).
 *
 * ## Who raises it
 *
 * Whoever lands such a change, in the same commit, and they append the old
 * value below. Naming is `runtime_<phase>_<theme>_v<n>`.
 *
 * ## Values so far
 *
 *  - `runtime_p0_v1` — first Cordis graph (P0).
 *  - `runtime_p1_policy_v3` — tools plus the permission policy (P1).
 *  - `runtime_p2_prompt_v1` — prompt assembly and compaction (P2).
 *  - `runtime_p3_complete_v1` — sessions and events (P3). Stayed frozen through
 *    P5-1..P5-5 and P6, which it should not have.
 *  - `runtime_p6_hardening_v1` — native-only engine (P6) plus hardening batches
 *    A and B: skills and prompt templates, subagents and the `Task*` tools, MCP
 *    tools, the model catalog rebind, bash static analysis, permission surface
 *    mapping, compaction's internal-message exclusion, layered instructions.
 */
export const RUNTIME_CONFIG_VERSION = 'runtime_p6_hardening_v1';

export interface RuntimeBootstrapOptions {
  env?: NodeJS.ProcessEnv;
  host?: RuntimeHostConfig;
  tools?: ToolsConfig;
  permissions?: Omit<PermissionConfig, 'cwd' | 'policy'>;
  context?: ContextConfig;
  prompt?: PromptConfig;
  /**
   * P5-1. Absent disables discovery entirely (`skills: false` is not a separate
   * flag — a graph with no tools has no `skill` tool to reach them with, and
   * the fixed probes want a prompt with no machine-specific content in it).
   */
  skills?: SkillsConfig;
  /**
   * P5-3. Absent starts no servers at all. Opt-in for the same two reasons as
   * `skills`, plus a third that matters more here: every entry is a program
   * this runtime would execute, so a probe or a fixed-suite run must not pick
   * one up from whatever happens to be on the machine.
   */
  mcp?: McpConfig;
  /**
   * P5-2. Absent registers no `Task*` tools at all, for the same reason as
   * `skills`: the discovered catalog is machine-specific content in a tool
   * description, and the P2-0 fixed suite needs a request that does not vary by
   * machine. Present with an empty catalog still registers nothing — a `Task`
   * tool with no delegates can only ever answer "unknown subagent".
   */
  subagents?: Omit<SubagentConfig, 'catalog'> & SubagentCatalogConfig;
  session?: SessionConfig;
  agentDir?: string;
  traceDir?: string | null;
  providers?: ModelAdapterConfig['providers'];
  /**
   * P5-5 — the catalog documents, supplied by the host instead of read from
   * `agentDir`.
   *
   * Takes precedence over the directory, which stays as the fallback for the
   * lanes that have no host to ask: the smoke runner and the fixed probe suite
   * both point at a fixture directory. `providers` still outranks both — that
   * one substitutes the pi-ai objects themselves and has to remain visible in
   * the trace as a run that never touched a real endpoint.
   */
  modelCatalog?: { models: Record<string, unknown>; auth?: Record<string, unknown> };
  loop?: Partial<AgentLoopConfig>;
  /**
   * T093 / decision 029 — how long a provider request may stay silent, in ms.
   *
   * One number, three landing points: undici's `headersTimeout` (no first byte)
   * and `bodyTimeout` (the stream went quiet), both set process-wide here, and
   * the SDK's own per-request `timeout`, passed down to the loop and to
   * delegates. `0` means "never cut it", which the dispatcher takes literally
   * and the SDK is given as max int32.
   *
   * ABSENT means "leave this process's HTTP stack alone", which is not the same
   * as 0: a probe lane, the fixed suite and the unit tests must not acquire a
   * global dispatcher as a side effect of building a graph. Only a host that
   * actually read the setting passes a value, and the worker always does.
   */
  providerIdleTimeoutMs?: number;
  /**
   * Worker log sink for graph-level diagnostics.
   *
   * Today it has exactly one writer: the HTTP dispatcher reporting that it
   * could not be installed, which is a DEGRADATION rather than a failure (the
   * turn still runs, it just runs without the idle timeout) and therefore has
   * to be written down somewhere or it is invisible. It used to borrow
   * `mcp.log`, which tied a transport diagnostic to whether the session happened
   * to have MCP servers configured.
   */
  log?: (message: string, ...args: unknown[]) => void;
  /**
   * decision 008 — which tiers of on-disk configuration this session may read,
   * across all four layered sources at once (project instructions, permission
   * policy, MCP servers, skills / prompts).
   *
   * Absent means all three, matching Claude Code's CLI and Agent SDK. An empty
   * array means none of them, which is what a fixed probe wants: the managed
   * `<agentDir>/AGENTS.md` and the bundled fail-closed permission policy still
   * load, because those ship with the app rather than being found on the
   * machine.
   */
  settingSources?: readonly SettingSource[];
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
  /** Present only when `options.skills` asked for discovery. */
  skills?: RuntimeSkillsService;
  /** Present only when `options.mcp` asked for a bridge. */
  mcp?: RuntimeMcpService;
  /** Present only when `options.subagents` asked for delegation. */
  subagents?: SubagentService;
  session?: RuntimeSessionService;
  events: RuntimeEventsService;
  run(request: RuntimeRunRequest): Promise<RuntimeRunResult>;
  dispose(): Promise<void>;
}

export async function createRuntime(options: RuntimeBootstrapOptions = {}): Promise<RuntimeHandle> {
  // decision 012 — `permissions.approve` is the ONLY approval surface now. The
  // Extension UI bridge used to stand in for a host that had none, and
  // `?? approval?.approve` hid a missing one until the first gate fired, which
  // surfaced mid-turn as an opaque tool denial. Tools imply a permission gate,
  // so refuse to build a runtime that has no way to answer one.
  if (options.tools && !options.permissions?.approve) {
    throw new RuntimeHostError(
      'runtime_approval_missing',
      'permissions.approve is required whenever tools are enabled: nothing else can answer a permission gate'
    );
  }
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
  let session: JsonlSessionStore | undefined;
  let skillCatalog: SkillCatalog | undefined;
  let mcpCatalog: McpCatalog | undefined;
  let subagentCatalog: SubagentCatalog | undefined;
  let readSubagentCatalog: (() => Promise<SubagentCatalog>) | undefined;
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
    // Before the first plugin that can issue a provider request. Installed on
    // the process, not on a request, because the two timeouts it sets are
    // transport facts no SDK option can express — see `host/httpDispatcher.ts`.
    // A host that named no timeout leaves the HTTP stack untouched.
    if (options.providerIdleTimeoutMs !== undefined) {
      await configureProviderHttpDispatcher(options.providerIdleTimeoutMs, {
        ...(options.log ? { log: options.log } : {}),
      });
    }
    const providerTimeoutMs = providerRequestTimeoutMs(
      options.providerIdleTimeoutMs ?? DEFAULT_PROVIDER_IDLE_TIMEOUT_MS
    );
    const loopConfig = {
      ...DEFAULT_AGENT_LOOP_CONFIG,
      singleTurn: !options.tools,
      providerTimeoutMs,
      // See `LOOP_GUARD_ENV` in `flags.ts`; a caller-supplied `options.loop`
      // still wins, same rule as `providerTimeoutMs` above.
      loopGuardEnabled: flags.loopGuardEnabled,
      ...options.loop,
    };
    const agentDir = options.agentDir ?? flags.agentDir;
    /**
     * The workspace as the tools report it, kept for the prompt config below.
     *
     * decision 007: the on-demand tier compares a path a tool just touched
     * against the workspace root, and every path a tool reports has been
     * through `canonicalPath`. On a machine where the workspace is reached
     * through a symlink — macOS's `/var` → `/private/var` is the everyday case —
     * the raw `tools.cwd` and the canonical one differ, and the comparison would
     * decide that every file in the workspace is outside it.
     */
    let workspace: string | undefined;
    if (options.tools) {
      const cwd = await io.realpath(options.tools.cwd);
      workspace = cwd;
      const scopes = await Promise.all(
        (options.permissions?.scopes ?? []).map(async (scope) => ({
          ...scope,
          root: await canonicalPath(ctx.runtimeHostIo, cwd, scope.root),
          tools: [...scope.tools],
        }))
      );
      // One snapshot for both reads: it rebuilds the whole entry list, and the
      // grants come out of the same entries the permission settings do.
      const restored = session?.snapshot();
      const permissionsFiber = await ctx.plugin(PermissionsPlugin, {
        ...restored?.permissions,
        ...options.permissions,
        cwd,
        // Approvals the user already gave in THIS conversation. A fresh session
        // has no such entries and therefore starts with none, which is what
        // makes "for session" mean the session rather than the install.
        grants: restoredGrants(restored?.entries ?? []),
        scopes,
        policy: await loadPermissionPolicy(io, {
          cwd,
          agentDir,
          projectTrusted: options.permissions?.projectTrusted,
          ...(options.settingSources ? { settingSources: options.settingSources } : {}),
        }),
        approve: options.permissions?.approve,
      });
      await permissionsFiber.await();
      const toolsFiber = await ctx.plugin(ToolsPlugin, {
        ...options.tools,
        cwd,
        shellEnv: commandEnvironment(host, undefined),
      });
      await toolsFiber.await();
      // P5-1, after the tools plugin because this registers the `skill` tool
      // into its registry. Opt-in rather than automatic: what it finds is
      // machine-specific content in the system prompt, and the P2-0 fixed
      // suite's whole premise is a prompt that does not vary by machine.
      if (options.skills) {
        skillCatalog = await loadSkillCatalog(io, {
          ...(agentDir ? { agentDir } : {}),
          cwd,
          projectTrusted: options.permissions?.projectTrusted,
          ...(options.settingSources ? { settingSources: options.settingSources } : {}),
          ...options.skills,
        });
        const skillsFiber = await ctx.plugin(SkillsPlugin, skillCatalog);
        await skillsFiber.await();
      }
      // P5-2-1. Loaded HERE rather than beside the plugin below, for two
      // reasons. The version stamp is built a few lines down and the catalog
      // used to be read long after it, so `subagents` / `subagent_diagnostics`
      // were always absent from the trace — the keys existed and could never be
      // written (subagent-data-10). And `reloadCatalog` needs a reader the
      // plugin can call again per run (subagent-data-02), which is this one.
      if (options.subagents && options.tools) {
        readSubagentCatalog = () =>
          // `ctx.runtimeHostIo` rather than the local, the way the project
          // instruction callback below already reads it: this closure outlives
          // the block, so the local's narrowing does not.
          loadSubagentCatalog(skillSource(ctx.runtimeHostIo, SUBAGENT_SCAN_BYTES), {
            ...(agentDir ? { agentDir } : {}),
            ...(options.subagents?.home ? { home: options.subagents.home } : {}),
          });
        subagentCatalog = await readSubagentCatalog();
      }
      // P5-3, last of the tool contributors: an MCP server is an external
      // process, and starting one before the local tools are registered would
      // let a slow handshake delay the tools that need no handshake at all.
      if (options.mcp) {
        mcpCatalog = await connectMcpServers(io, ctx.runtimeExec, {
          ...(agentDir ? { agentDir } : {}),
          cwd,
          projectTrusted: options.permissions?.projectTrusted,
          ...(options.settingSources ? { settingSources: options.settingSources } : {}),
          ...options.mcp,
        });
        const mcpFiber = await ctx.plugin(McpPlugin, { catalog: mcpCatalog, cwd });
        await mcpFiber.await();
      }
    }
    // After the tools plugin, because this is what registers `new_context`:
    // the compaction consumer and the tool that requests it land together
    // (plan board P1-9 / P2-8) or not at all.
    const eventsFiber = await ctx.plugin(EventsPlugin, {
      streamToolRows: flags.streamToolRows,
    });
    await eventsFiber.await();
    const contextFiber = await ctx.plugin(ContextPlugin, options.context ?? {});
    await contextFiber.await();
    // decision 008 — one prompt config, used both by the parent's own prompt and
    // by the per-delegation chain below. It used to be spelled out twice, and
    // the two copies now carry three switches each; a third copy would be a
    // third chance for them to disagree about what a delegate is allowed to
    // read.
    const promptConfig: PromptConfig = {
      ...options.prompt,
      root: options.prompt?.root ?? workspace ?? options.tools?.cwd,
      // T059 — resolved HERE rather than in the prompt plugin because this
      // config also feeds the per-delegation chain below, and a delegate must
      // see the same user tier and the same walk as the parent.
      home: options.prompt?.home ?? homedir(),
      // A-round testing only (temporary): resolved from the environment here,
      // same edge as `home` above, so `projectInstructions.ts` stays a pure
      // function of its options. See `SKIP_USER_INSTRUCTIONS_ENV` in
      // `flags.ts` for what this does and how to revert it.
      skipUserTier: options.prompt?.skipUserTier ?? flags.skipUserInstructions,
      projectTrusted: options.permissions?.projectTrusted,
      ...(options.settingSources ? { settingSources: options.settingSources } : {}),
      globals: [
        // `scope: 'managed'` — this one ships with the app, so the `user`
        // setting source does not switch it off (decision 008 clause 3).
        // Everything the host supplied after it is the user tier by default.
        ...(agentDir
          ? [
              {
                path: join(agentDir, 'AGENTS.md'),
                label: 'Managed AGENTS.md',
                scope: 'managed' as const,
              },
            ]
          : []),
        ...(options.prompt?.globals ?? []),
      ],
    };
    const promptFiber = await ctx.plugin(PromptPlugin, promptConfig);
    await promptFiber.await();
    const traceDir = options.traceDir === undefined ? flags.traceDir : options.traceDir;
    if (traceDir) await io.mkdir(traceDir, { recursive: true, mode: 0o700 });
    const stamp = await buildVersionStamp({
      io,
      repoRoot: REPO_ROOT,
      configVersion: RUNTIME_CONFIG_VERSION,
      extra: {
        backend: flags.backend,
        // §15 — a flag that changes what a run EMITS belongs in the stamp, so
        // an archived trace says which projection produced it (T101).
        stream_tool_rows: String(flags.streamToolRows),
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
        // §15: what the prompt actually advertised. A catalog that quietly came
        // up empty and one that was never asked for read the same in a trace
        // otherwise, and they are different bugs.
        ...(skillCatalog
          ? {
              skills: String(skillCatalog.skills.length),
              prompt_templates: String(skillCatalog.templates.length),
              skill_diagnostics: String(skillCatalog.diagnostics.length),
            }
          : {}),
        ...(subagentCatalog
          ? {
              subagents: String(subagentCatalog.definitions.length),
              subagent_diagnostics: String(subagentCatalog.diagnostics.length),
            }
          : {}),
        ...(mcpCatalog
          ? {
              mcp_servers: String(mcpCatalog.connections.length),
              mcp_failed: String(mcpCatalog.connections.filter((item) => item.error).length),
              mcp_tools: String(
                mcpCatalog.connections.reduce((total, item) => total + item.tools.length, 0)
              ),
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
    if (!options.providers && !options.modelCatalog && !agentDir) {
      throw new RuntimeConfigError(
        'agent_dir_unset',
        'set AICLIENT_RUNTIME_AGENT_DIR, supply a model catalog, or supply providers explicitly'
      );
    }
    const catalog = options.providers
      ? undefined
      : options.modelCatalog
        ? parsePiCatalog(options.modelCatalog, env, { dir: null, label: 'the supplied catalog' })
        : agentDir
          ? await readPiCatalog(agentDir, env, io)
          : undefined;
    await ctx.plugin(ModelAdapterPlugin, { providers: options.providers, catalog });
    // P5-2-2, after the model adapter because a delegate's pinned model is
    // resolved against the live catalog, and after the tools plugin because it
    // registers `Task*` into that registry. Both are already up by here.
    if (options.subagents && options.tools && subagentCatalog && readSubagentCatalog) {
      const subagentFiber = await ctx.plugin(SubagentPlugin, {
        // The parent's number first, so a caller that pins one still wins.
        providerTimeoutMs,
        // See `LOOP_GUARD_ENV` in `flags.ts`; a caller-supplied
        // `options.subagents.loopGuardEnabled` still wins, same rule as
        // `providerTimeoutMs` above.
        loopGuardEnabled: flags.loopGuardEnabled,
        ...options.subagents,
        catalog: subagentCatalog,
        // subagent-data-02 — the same reader the bootstrap used, handed to the
        // plugin so the top of every top-level run can ask the directory again.
        // A caller that supplied its own wins, same rule as
        // `projectInstructions` below.
        reloadCatalog: options.subagents.reloadCatalog ?? readSubagentCatalog,
        // The same chain the parent's own prompt loads, through the same
        // loader, read per delegation so a workspace edit between turns reaches
        // the next delegate. A caller that supplies its own wins: the field is
        // part of `SubagentConfig`, and overwriting it unconditionally made it a
        // declared option nothing could ever set.
        projectInstructions:
          options.subagents.projectInstructions ??
          (() =>
            projectInstructionsText(
              instructionSource(ctx.runtimeHostIo, options.prompt?.maxBytes),
              promptConfig
            )),
      });
      await subagentFiber.await();
    }
    const loopFiber = await ctx.plugin(AgentLoopPlugin, loopConfig);
    await loopFiber.await();
    const required = [
      ...RUNTIME_SERVICES,
      CONTEXT_SERVICE,
      EVENTS_SERVICE,
      ...(session ? [SESSION_SERVICE] : []),
      PROMPT_SERVICE,
      ...(options.tools ? [TOOLS_SERVICE, PERMISSIONS_SERVICE] : []),
      ...(options.skills && options.tools ? [SKILLS_SERVICE] : []),
      ...(options.mcp && options.tools ? [MCP_SERVICE] : []),
      ...(options.subagents && options.tools && subagentCatalog?.definitions.length
        ? [SUBAGENT_SERVICE]
        : []),
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
      skills: ctx.get(SKILLS_SERVICE),
      mcp: ctx.get(MCP_SERVICE),
      subagents: ctx.get(SUBAGENT_SERVICE),
      events: ctx.runtimeEvents,
      session: session ? ctx.runtimeSession : undefined,
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
          // Every step runs, and every failure is collected rather than
          // replaced. A trace flush that throws used to leave the function
          // before the exec outcomes were read, and TracePlugin's persistence
          // error is sticky — so one failed trace append hid every hung child
          // for the rest of the session. P1-0 section 5: a cleanup failure has
          // to stay visible.
          const failures: unknown[] = [];
          const step = async (work: () => Promise<unknown> | undefined) => {
            try {
              await work();
            } catch (error) {
              failures.push(error);
            }
          };
          const outcomes = await Promise.allSettled([runtimeExec.shutdown(), ...active]);
          for (const outcome of outcomes)
            if (outcome.status === 'rejected') failures.push(outcome.reason);
          // A run ended by Ctrl+Enter leaves its delegates running into the
          // idle gap, so "no run is active" no longer means "no delegate is".
          // Stopped and awaited (bounded) while the session can still take
          // their settlement records, the same thing a run's own exit does.
          await step(() => ctx.get(SUBAGENT_SERVICE)?.drain());
          await step(() => ctx.runtimeTrace.flush());
          await step(() => session?.close());
          await step(() => runtimeIo.shutdown());
          await step(() => ctx.fiber.dispose());
          if (failures.length === 1) throw failures[0];
          if (failures.length > 1) {
            throw new AggregateError(
              failures,
              `runtime dispose failed: ${failures.map(disposeFailureLabel).join(', ')}`
            );
          }
        })();
        return disposal;
      },
    };
  } catch (error) {
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

/** Codes, not stack traces: the aggregate message is what a log line shows. */
function disposeFailureLabel(error: unknown): string {
  if (error instanceof Error)
    return 'code' in error && typeof error.code === 'string' ? error.code : error.message;
  return String(error);
}
