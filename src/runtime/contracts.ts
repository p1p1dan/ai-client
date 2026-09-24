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
 * plugin that injects it would activate against a lie. So a service whose phase
 * has not landed appears here as types plus a machine-checked entry in
 * {@link DEFERRED_SERVICES}, and is absent from the Cordis context until then. A
 * plugin that injects one stays PENDING, which is the honest state.
 *
 * As of T028 that table is empty — P1 through P5 all landed, so every declared
 * service is registered. It stays in the file because the rule outlives the
 * list, and because the gate that guards it also catches the opposite drift: a
 * table entry for a name that is already live, or for a name nothing declares.
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
import type { SessionAttachment } from '../shared/types/agentHost.ts';
import type { EventsPlugin } from './events/index.ts';
import type { ProjectInstruction } from './plugins/prompt/projectInstructions.ts';
import type { ComposedPrompt } from './plugins/prompt/segments.ts';
import type { JsonlSessionStore } from './plugins/session/store.ts';

/** Cordis service name of the pi-ai binding (P0-4). */
export const MODEL_SERVICE = 'runtimeModel' as const;
/** Cordis service name of the structured-trace sink (engineering standard §2). */
export const TRACE_SERVICE = 'runtimeTrace' as const;
/** Cordis service name of the agent loop (P0-5). */
export const LOOP_SERVICE = 'runtimeLoop' as const;
export const PROMPT_SERVICE = 'runtimePrompt' as const;
export const SESSION_SERVICE = 'runtimeSession' as const;
export const EVENTS_SERVICE = 'runtimeEvents' as const;
export type RuntimeEventsService = Pick<EventsPlugin, 'subscribe' | 'emit' | 'startRun'>;
export type RuntimeSessionService = Pick<
  JsonlSessionStore,
  | 'file'
  | 'snapshot'
  | 'appendMessage'
  | 'appendCompaction'
  | 'appendEntry'
  | 'flush'
  | 'metadata'
  | 'tree'
  | 'history'
  | 'navigate'
  | 'rewind'
  | 'fork'
  | 'rename'
  | 'label'
  | 'discardFork'
  | 'acceptFork'
  // session-02: whether this file had to be healed at open, for the trace and
  // the status rider. A fact about the open, not part of the conversation.
  | 'recovery'
>;

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
 * **Empty since T028 (2026-09-15), and that is the honest state**: every service
 * this file declares is now registered. `runtimeContext` left when P2-3's
 * decision layer got a consumer; the last entry, the subagent seam, left because
 * P5-2 opened it — the registered name is `runtimeSubagents`
 * (`plugins/subagent/index.ts`), and the table had gone on promising a
 * misspelled singular that no phase would ever land (audit core-host-01).
 *
 * Adding an entry back is allowed; it has to survive `__tests__/contracts.test.ts`,
 * which rejects a name that some plugin already registers and a name that no
 * `declare module 'cordis'` block in `src/runtime` declares. The second rule is
 * what a typo trips.
 */
export const DEFERRED_SERVICES: Readonly<Record<string, DeferredServiceDeclaration>> = {};

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
  | {
      kind: 'agent-dir';
      dir: string;
      providerCount: number;
      modelCount: number;
      /** P5-5: providers the catalog could not bind, `id:reason` each. Empty when all bound. */
      dropped: string[];
    }
  /**
   * P5-5 — the host handed the catalog over instead of leaving it on disk.
   * Distinct from `injected`, which means a caller supplied ready-made pi-ai
   * providers (the offline lane): here the documents are the real ones, just
   * not read through the filesystem.
   */
  | { kind: 'host'; providerCount: number; modelCount: number; dropped: string[] }
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
  /**
   * The behaviour generation this run belongs to — `RUNTIME_CONFIG_VERSION` in
   * `bootstrap.ts`, where the rule for raising it lives: anything that changes
   * what the model saw or what the run was allowed to do (prompt, tool set,
   * compaction, permission semantics, model binding, subagent contract) makes
   * new traces non-comparable to old ones and must raise it in the same commit.
   * Two archives with different values are not two measurements of one thing.
   */
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
  /**
   * Images and text documents the composer sent with this prompt.
   *
   * Carried on the request rather than folded into `prompt` by the caller,
   * because the model needs the images as content blocks and the renderer needs
   * their metadata on the user message it echoes back. Dropping them silently
   * is the failure to avoid: the user watches the attachment go up and the
   * model answers as though it never arrived.
   */
  attachments?: readonly SessionAttachment[];
  /**
   * The renderer's send attempt this turn answers.
   *
   * Round-tripped onto the user `message.started`, which is how the composer's
   * optimistic bubble is paired with the authoritative echo and retired. Without
   * it the prompt stays on screen twice, forever.
   */
  attemptId?: string;
  /** Explicit override for fixed probes; omitted uses runtimePrompt assembly. */
  systemPrompt?: string;
  model?: RuntimeModelRef;
  thinkingLevel?: ThinkingLevel;
  runId?: string;
  logicalSessionId?: string;
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
  /**
   * P5-2-2. What the run's delegates spent, settled exactly once each.
   *
   * Kept OUT of `usage` on purpose: `usage` is what the parent's provider
   * reported for the parent's own requests, and the parent's context occupancy
   * is derived from it. Folding a delegate's tokens in would make the session
   * look like it is carrying context it never loaded. Session and turn totals
   * are the sum of the two, which is the caller's to compute.
   */
  subagentUsage?: Usage;
  latencyMs: number;
  /** Assistant turns the loop completed. P0's single-turn flag pins this at 1 on success. */
  turns: number;
  error?: { code: string; message: string };
  /**
   * decision 040 — set when the run paused at the interactive turn ceiling
   * after its wrap-up turn. Carried onto `session.completed` by the projector.
   */
  stopCause?: 'turn_limit';
  trace: RunTrace;
}

/** P0-5. Registered as Cordis service {@link LOOP_SERVICE}. */
export interface AgentLoopService {
  run(request: RuntimeRunRequest): Promise<RuntimeRunResult>;
  /** Ask the loop to stop after the current turn completes. */
  interject(): void;
}

export interface RuntimePromptService {
  compose(): Promise<ComposedPrompt>;
  /**
   * decision 007 — the on-demand instruction tier's two halves.
   *
   * Optional because they are only meaningful with a workspace: the tool-less
   * smoke lane registers a prompt service with no root to walk into, and a test
   * double that only needs `compose` must stay a legal implementation.
   * `noteFilesTouched` is what the tools plugin calls after a read / edit /
   * write / grep succeeds; `takePendingInstructions` is what the loop drains
   * before the next request.
   */
  noteFilesTouched?(paths: readonly string[]): Promise<void>;
  takePendingInstructions?(): readonly ProjectInstruction[];
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
    runtimeSession: RuntimeSessionService;
    runtimeEvents: RuntimeEventsService;
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
  /**
   * Hard-link `from` to `to`, failing with `EEXIST` when `to` is taken.
   *
   * The runtime's compare-and-swap: `rename` overwrites whatever is at the
   * destination, so it can only ever say "the name now holds my bytes", never
   * "the name held nothing a moment ago". A link is the create that carries the
   * file's content, which is what lets the writer lock replace a lock it judged
   * without a window in which two claimants both believe they replaced it.
   *
   * `from` and `to` must be on one filesystem — nothing here moves bytes — so
   * every caller links a staging file it wrote in the destination's own
   * directory. Rejects with the filesystem's own code otherwise.
   */
  link(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  /** Remove an empty directory. Rejects with `ENOTEMPTY` if entries remain. */
  rmdir(path: string): Promise<void>;
}

export interface RuntimeExecRequest {
  command: string;
  args: readonly string[];
  cwd: string;
  env?: Readonly<Record<string, string | undefined>>;
  stdin?: Uint8Array;
  timeoutMs: number;
  maxOutputBytes: number;
  /**
   * A budget for stderr on its own (core-host-05).
   *
   * Without it `maxOutputBytes` caps the two streams together, so whichever
   * arrives first takes the room: a child that greets stderr with startup
   * warnings pushes a byte-exact stdout protocol over the shared limit and
   * `terminate` kills a command that was working. With it, stdout keeps all of
   * `maxOutputBytes`, stderr beyond this budget is dropped instead of ending
   * the command or raising `truncated`, and `stderrBytes` still reports what
   * the child produced. An adapter must honour it when present.
   */
  maxStderrBytes?: number;
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
  /**
   * Set when the command finished but its process tree could not be confirmed
   * gone — a `taskkill` that would not start, exited nonzero, or outlived the
   * cleanup budget (windows-02).
   *
   * Diagnostic, never a verdict: the command's own exit code, output and
   * termination are complete and describe what ran. Reaping stragglers is a
   * separate concern, and while a failure to reap was reported as the run's
   * failure, an enterprise security stack that merely slowed `taskkill` down
   * turned every successful command on that machine into a tool error.
   */
  cleanupError?: string;
}

/**
 * A child process that outlives one request (P5-3).
 *
 * `run` is request/response: it spawns, collects bounded output, and resolves
 * when the command exits. An MCP server is the opposite shape — one process,
 * a handshake, then many requests over the same pipes — so it needs its own
 * entry rather than a flag on `RuntimeExecRequest`. ARD D11 point 4 names the
 * "MCP stdio bridge" as one of the surfaces that must converge on this service,
 * which is why this lives here and not in the MCP plugin: the carrier rules
 * (bundled `node.exe` on Windows, the runner helper, process-tree cleanup) are
 * the exec exit's job, once, for everyone.
 */
export interface RuntimeChildProcess {
  /** Feed the child's stdin. Rejects once the child is gone. */
  write(bytes: Uint8Array): Promise<void>;
  /** Resolves when the child has exited. Never rejects. */
  readonly exited: Promise<{ exitCode: number | null; signal: string | null }>;
  /** Terminate the process tree. Idempotent, and safe after a natural exit. */
  kill(): Promise<void>;
}

export interface RuntimeSpawnRequest {
  command: string;
  args: readonly string[];
  cwd: string;
  env?: Readonly<Record<string, string | undefined>>;
  /** Called with each stdout chunk, in arrival order. Framing is the caller's job. */
  onStdout: (chunk: Uint8Array) => void;
  /**
   * Called with each stderr chunk. Separate because D11 point 5 requires the
   * ordinary stdout of a child to be drained even when the protocol ignores it:
   * an unread pipe fills and the child blocks on its own log line.
   */
  onStderr: (chunk: Uint8Array) => void;
  signal?: AbortSignal;
}

export interface RuntimeExecService {
  readonly mode: 'pipe' | 'host-adapter';
  readonly adapterId: string;
  run(request: RuntimeExecRequest): Promise<RuntimeExecResult>;
  /**
   * Start a long-lived child. Rejects with `exec_spawn_unsupported` on a
   * carrier that cannot host one — stated rather than emulated, because a
   * bridge that silently degrades to one-shot calls would look connected and
   * lose every server-side session.
   */
  spawn(request: RuntimeSpawnRequest): Promise<RuntimeChildProcess>;
}

export interface RuntimeExecAdapter {
  readonly id: string;
  run(request: RuntimeExecRequest, cleanupTimeoutMs: number): Promise<RuntimeExecResult>;
  /** Optional: a carrier that cannot host a long-lived child simply omits it. */
  spawn?(request: RuntimeSpawnRequest, cleanupTimeoutMs: number): Promise<RuntimeChildProcess>;
  dispose(cleanupTimeoutMs: number): Promise<void>;
}

export const RUNTIME_SERVICES = [...P0_SERVICES, HOST_IO_SERVICE, EXEC_SERVICE] as const;
