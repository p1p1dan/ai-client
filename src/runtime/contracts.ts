/**
 * P0-3 — the service contracts every runtime plugin is written against.
 *
 * This file is the seam the ARD's §5.2 parallel plan depends on: P1 (tools /
 * permissions), P2 (context / prompt) and P3 (session / events) are meant to be
 * built by three teams at the same time, and they can only do that if the shapes
 * they hand each other are agreed BEFORE any of them starts. So the contracts
 * for all of P0..P3 live here from P0 onward, even though P0 implements only
 * three of them.
 *
 * ## Why the unimplemented ones are declared but not registered
 *
 * `docs/agent-project-engineering.md` A3 forbids a same-name empty shell: a
 * module that contributes nothing must SAY why rather than exist as a silent
 * no-op that later reads as "already done". A registered stub service would be
 * exactly that — `ctx.get('runtimeTools')` would answer with something, and a
 * plugin that injects it would activate against a lie. So the deferred services
 * appear here as types plus a machine-checked entry in {@link DEFERRED_SERVICES},
 * and are absent from the Cordis context until their phase lands. A plugin that
 * injects one stays PENDING, which is the honest state.
 *
 * ## Why service names are flat and prefixed
 *
 * Cordis service names are properties on a process-global `Context` interface.
 * `runtime*` prefixes keep them from colliding with anything a future Cordis
 * plugin (loader, logger) may want, and flat names avoid depending on nested
 * service resolution, which is not something this rc guarantees.
 */

// Load the original module before augmenting its re-exported Context type.
import 'cordis';
import type { AgentEvent, ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { Api, Model, Models, Usage } from '@earendil-works/pi-ai';
import type { ComposedPrompt } from './plugins/prompt/segments.ts';

/** Cordis service name of the pi-ai binding (P0-4). */
export const MODEL_SERVICE = 'runtimeModel' as const;
/** Cordis service name of the structured-trace sink (engineering standard §2). */
export const TRACE_SERVICE = 'runtimeTrace' as const;
/** Cordis service name of the agent loop (P0-5). */
export const LOOP_SERVICE = 'runtimeLoop' as const;
export const PROMPT_SERVICE = 'runtimePrompt' as const;

/** Every service P0 actually registers. `bootstrap.ts` asserts all of them are live. */
export const P0_SERVICES = [MODEL_SERVICE, TRACE_SERVICE, LOOP_SERVICE] as const;

/**
 * The marker A3 requires an empty shell to start its explanation with.
 *
 * Exported so the check is mechanical rather than a habit: `__tests__/
 * contracts.test.ts` fails when a deferred service carries no reason, or a
 * reason that does not open with this marker.
 */
export const DEFERRED_REASON_MARKER = 'No implementation at P0:';

export interface DeferredServiceDeclaration {
  /** Plan-board node that lands it (`docs/plantree/plans/runtime-evolution/README.md`). */
  phase: 'P1' | 'P2' | 'P3' | 'P5';
  /** Must open with {@link DEFERRED_REASON_MARKER}. */
  reason: string;
}

/**
 * Services whose contract is agreed but whose implementation is a later phase.
 *
 * Deliberately not a list of names: A3's point is that "nothing here yet" has to
 * carry the reason WHY this particular module has none, so an agent reading the
 * graph six weeks from now can tell a deliberate gap from a dropped task.
 *
 * `runtimeContext` left this table when P2-3's decision layer got a consumer
 * (`plugins/context/index.ts`): compaction now runs at the turn boundary, so
 * the name is provided rather than promised. What is still missing there is the
 * durable compaction record (P2-4), which is a field of that service's output,
 * not an absent service.
 */
export const DEFERRED_SERVICES: Readonly<Record<string, DeferredServiceDeclaration>> = {
  runtimeSession: {
    phase: 'P3',
    reason: `${DEFERRED_REASON_MARKER} P0 writes a run trace, not a session. The two are different artifacts: the trace is this repo's evaluation record (engineering standard §2), the session is the JSONL pi/PI-Desktop format users resume from (ARD D6). Making the trace pose as a session would create a second, incompatible on-disk history.`,
  },
  runtimeEvents: {
    phase: 'P3',
    reason: `${DEFERRED_REASON_MARKER} the RuntimeEvent translation layer only has a consumer once the worker bootstrap exists (P4-1). P0 exposes raw \`AgentEvent\`s through \`RuntimeRunRequest.onEvent\` instead, so nothing yet depends on a translation whose target shape P3-4 may still adjust.`,
  },
  runtimeSubagent: {
    phase: 'P5',
    reason: `${DEFERRED_REASON_MARKER} a subagent is a second \`Agent\` with its own tool whitelist (ARD D10), so it cannot exist before tools do. The \`SubagentRunner\` service seam named in D10 is deliberately not opened yet — an empty seam invites a caller, and the caller would have nothing to delegate.`,
  },
};

/** How a caller names a model. Resolution against the catalog is the adapter's job. */
export interface RuntimeModelRef {
  provider: string;
  id: string;
}

/** One model the adapter can stream, together with the registry that owns it. */
export interface ResolvedModel {
  ref: RuntimeModelRef;
  model: Model<Api>;
  /**
   * pi-ai registry scoped to this model's provider.
   *
   * Handed back rather than kept private because `streamFn` has to call
   * `models.streamSimple`, and the loop — not the adapter — owns the retry and
   * telemetry wrapping around that call (PI-Desktop does the same split in
   * `subagent.ts`).
   */
  models: Models;
  /**
   * The key pi-ai signs the request with, or `''` for a provider configured
   * without one. Separate from `models` because `Agent.getApiKey` is a distinct
   * hook that fires per request, for tokens that rotate mid-run.
   */
  requestKey: string;
}

/** P0-4. Registered as Cordis service {@link MODEL_SERVICE}. */
export interface ModelAdapterService {
  /** Every model the adapter could resolve, in catalog order. */
  list(): readonly RuntimeModelRef[];
  /** Throws {@link RuntimeConfigError} when the ref names nothing in the catalog. */
  resolve(ref: RuntimeModelRef): ResolvedModel;
  /** First catalog entry, or `undefined` for an empty catalog. Used by the smoke runner's default. */
  defaultRef(): RuntimeModelRef | undefined;
  /** Where the catalog came from, for the trace's version stamp (engineering standard §15). */
  readonly source: ModelCatalogSource;
}

export type ModelCatalogSource =
  | { kind: 'agent-dir'; dir: string; providerCount: number; modelCount: number }
  | { kind: 'injected'; providerCount: number; modelCount: number };

/** One entry in a run trace's `steps` array (engineering standard §2). */
export interface TraceStep {
  step: number;
  type: 'llm' | 'tool' | 'note';
  at: string;
  detail: Record<string, unknown>;
}

/**
 * A single run's structured trace.
 *
 * Field names follow `docs/agent-project-engineering.md` §2 verbatim
 * (`run_id`, `latency_ms`, …) rather than this repo's camelCase, because §11
 * promises another agent can read these files without being told the schema.
 */
export interface RunTrace {
  run_id: string;
  timestamp: string;
  input: string;
  model: string;
  provider: string;
  config_version: string;
  steps: TraceStep[];
  final_output: string;
  usage: Usage | null;
  latency_ms: number;
  success: boolean;
  error?: { code: string; message: string };
  /** §15 — what was actually running: git commit, flags, pinned package versions. */
  version_stamp: Record<string, string>;
  persistence_error?: { code: string; message: string };
}

/** Open trace for one in-flight run. */
export interface TraceRun {
  readonly runId: string;
  note(type: TraceStep['type'], detail: Record<string, unknown>): void;
  finish(outcome: {
    final_output: string;
    usage: Usage | null;
    success: boolean;
    error?: { code: string; message: string };
  }): Promise<RunTrace>;
}

/** Engineering standard §2. Registered as Cordis service {@link TRACE_SERVICE}. */
export interface TraceService {
  flush(): Promise<void>;
  begin(input: { runId?: string; input: string; model: string; provider: string }): TraceRun;
  /** Absolute path traces are written to, or `null` when tracing is memory-only. */
  readonly dir: string | null;
  /** Every trace produced by this context, newest last. Kept for in-process assertions. */
  readonly runs: readonly RunTrace[];
}

export interface RuntimeRunRequest {
  prompt: string;
  /** Explicit override for fixed probes; omitted uses runtimePrompt assembly. */
  systemPrompt?: string;
  /** Workspace-relative file whose directory chain supplies project rules. */
  targetPath?: string;
  model?: RuntimeModelRef;
  thinkingLevel?: ThinkingLevel;
  runId?: string;
  signal?: AbortSignal;
  /**
   * Raw pi-agent-core events, unfiltered.
   *
   * P0 forwards the SDK's own event union rather than a translated
   * `RuntimeEvent`: the translation layer is P3-4, and inventing a private
   * intermediate shape here would give P3 a second format to migrate off.
   */
  onEvent?: (event: AgentEvent) => void;
}

export interface RuntimeRunResult {
  runId: string;
  success: boolean;
  /** Concatenated assistant text. Empty when the turn failed before producing any. */
  text: string;
  stopReason: string;
  usage: Usage | null;
  latencyMs: number;
  /** Assistant turns the loop completed. P0's single-turn flag pins this at 1 on success. */
  turns: number;
  error?: { code: string; message: string };
  trace: RunTrace;
}

/** P0-5. Registered as Cordis service {@link LOOP_SERVICE}. */
export interface AgentLoopService {
  run(request: RuntimeRunRequest): Promise<RuntimeRunResult>;
}

export interface RuntimePromptService {
  compose(request?: { targetPath?: string }): Promise<ComposedPrompt>;
}

/**
 * The three services P0 registers, published onto Cordis's global `Context`.
 *
 * Declared here rather than next to each plugin so there is exactly one list of
 * what the graph can offer, and so a plugin can inject a service without
 * importing the class that provides it - the decoupling the ARD's parallel
 * P1/P2/P3 plan depends on.
 */
declare module 'cordis' {
  interface Context {
    runtimeHostIo: RuntimeHostIoService;
    runtimeExec: RuntimeExecService;
    runtimeModel: ModelAdapterService;
    runtimeTrace: TraceService;
    runtimeLoop: AgentLoopService;
    runtimePrompt: RuntimePromptService;
  }
}

/**
 * Raised for a catalog/credential problem the operator can fix, as opposed to a
 * provider failure at request time.
 *
 * The distinction matters to the smoke runner's exit code: a missing
 * `models.json` is a setup error worth a distinct message, while an HTTP 500
 * from the provider is a run outcome that belongs in the trace.
 */
export class RuntimeConfigError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'RuntimeConfigError';
    this.code = code;
  }
}

export const HOST_IO_SERVICE = 'runtimeHostIo';
export const EXEC_SERVICE = 'runtimeExec';

export type WorkerCarrier = 'bundled-node' | 'electron-utility';
export type RuntimeCarrier = WorkerCarrier | 'standalone-node';

export interface RuntimeNodeExecutable {
  path: string;
  source: 'bundled' | 'explicit' | 'current-process';
}

export type RuntimeExecPolicy =
  | { mode: 'pipe' }
  | { mode: 'host-adapter'; adapter: RuntimeExecAdapter };

export interface RuntimeHostConfig {
  carrier: RuntimeCarrier;
  node?: RuntimeNodeExecutable;
  tsdReadFallback: 'disabled' | 'configured-node';
  exec: RuntimeExecPolicy;
  childEnv: Readonly<Record<string, string>>;
  cleanupTimeoutMs: number;
}

export type RuntimeFileKind = 'file' | 'directory' | 'symlink' | 'other';

export interface RuntimeFileInfo {
  kind: RuntimeFileKind;
  size: number;
  mtimeMs: number;
}

export interface RuntimeReadOptions {
  maxBytes: number;
  overflow: 'error' | 'truncate';
  offset?: number;
  signal?: AbortSignal;
}

export interface RuntimeReadResult {
  bytes: Uint8Array;
  truncated: boolean;
  source: 'direct' | 'node-fallback';
}

export interface RuntimeWriteOptions {
  mode?: number;
  createOnly?: boolean;
}

export interface RuntimeHostIoService {
  readFile(path: string, options: RuntimeReadOptions): Promise<RuntimeReadResult>;
  writeFile(path: string, bytes: Uint8Array, options?: RuntimeWriteOptions): Promise<void>;
  appendFile(path: string, bytes: Uint8Array, options?: { mode?: number }): Promise<void>;
  stat(path: string, options?: { followSymlinks?: boolean }): Promise<RuntimeFileInfo>;
  realpath(path: string): Promise<string>;
  readDirectory(path: string): AsyncIterable<{ name: string; kind: RuntimeFileKind }>;
  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

export interface RuntimeExecRequest {
  command: string;
  args: readonly string[];
  cwd: string;
  env?: Readonly<Record<string, string | undefined>>;
  stdin?: Uint8Array;
  timeoutMs: number;
  maxOutputBytes: number;
  overflow: 'truncate' | 'terminate';
  signal?: AbortSignal;
}

export interface RuntimeExecResult {
  exitCode: number | null;
  signal: string | null;
  termination: 'exit' | 'timeout' | 'aborted' | 'output-limit' | 'disposed';
  stdout: Uint8Array;
  stderr: Uint8Array;
  stdoutBytes: number;
  stderrBytes: number;
  truncated: boolean;
}

export interface RuntimeExecService {
  readonly mode: 'pipe' | 'host-adapter';
  readonly adapterId: string;
  run(request: RuntimeExecRequest): Promise<RuntimeExecResult>;
}

export interface RuntimeExecAdapter {
  readonly id: string;
  run(request: RuntimeExecRequest, cleanupTimeoutMs: number): Promise<RuntimeExecResult>;
  dispose(cleanupTimeoutMs: number): Promise<void>;
}

export const RUNTIME_SERVICES = [...P0_SERVICES, HOST_IO_SERVICE, EXEC_SERVICE] as const;
