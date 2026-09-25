/**
 * P5-2-2 — the delegation lifecycle: `Task`, `TaskWait`, `TaskList`, `TaskStop`.
 *
 * Provenance: the four tools, their descriptions, the concurrency gate and the
 * auto-resume loop are PI-Desktop's, from `packages/agent-runtime/src/runtime.ts`
 * (2744–3330 and 3063) at `948ee676`.
 *
 * The one structural idea worth restating, because everything else follows from
 * it: **`Task` returns immediately.** It starts a delegate in the background and
 * hands back a delegation id. The parent keeps working. When the parent runs
 * out of its own work, the runtime — not the model — waits for the delegates,
 * feeds their reports back, and lets the parent continue toward the user's
 * original goal. A `Task` result that says "started" is not a result that says
 * "finished", and the UI, the registry and the model all have to agree on that.
 *
 * Adaptations, each recorded in `topics/p5-2-0-baseline.md`:
 *
 * - The catalog is ours (`<agentDir>/subagents`), pins resolve against our
 *   model adapter in-process, and delegate tools come from our registry under
 *   their lowercase names.
 * - `Task*` is registered with `write` access so the tools plugin's existing
 *   plan-mode filter removes all four in plan mode. The contract's rule "no
 *   delegation from a plan-mode parent" then holds by construction rather than by a second rule that
 *   could drift from the first.
 * - Only `Task` is `executionMode: 'parallel'`; the other three are sequential.
 *   The P5-2-0 probe measured that 0.84.4 serializes any batch containing one
 *   sequential tool, so this is exactly what makes an all-`Task` message fan
 *   out and every mixed message run one call at a time.
 */

import { randomUUID } from 'node:crypto';
import type { AgentTool, ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { CacheRetention, Usage } from '@earendil-works/pi-ai';
import { type Context, Service } from 'cordis';
import { type TSchema, Type } from 'typebox';
import {
  MAX_SUBAGENT_PROVIDERS,
  normalizeSubagentName,
  type SubagentDefinition,
  subagentModelKey,
  subagentPinnedProviders,
} from '../../../shared/subagentDefinition.ts';
import { DEFAULT_PROVIDER_IDLE_TIMEOUT_MS } from '../../../shared/types/providerTimeout.ts';
import type {
  SessionRetryInfo,
  SubagentActivityPayload,
} from '../../../shared/types/runtimeEvents.ts';
import {
  EVENTS_SERVICE,
  type ResolvedModel,
  type RuntimeModelRef,
  type RuntimeSessionService,
  SESSION_SERVICE,
} from '../../contracts.ts';
import {
  PROVIDER_RATE_LIMIT_MAX_RETRIES,
  PROVIDER_TRANSIENT_MAX_RETRIES,
} from '../agent-loop/providerRetry.ts';
import type { DelegateCallScope } from '../permissions/index.ts';
import { TOOLS_SERVICE } from '../tools/index.ts';
import { stoppedToolOutcome } from '../tools/outcome.ts';
import { applySubagentActivation, resolveSubagentPin, type SubagentCatalog } from './catalog.ts';
import {
  composeSubagentSystemPrompt,
  resolveDelegateToolNames,
  subagentGuidance,
} from './prompt.ts';
import {
  activityForEvent,
  activityForSettlement,
  clampRecordedMessage,
  clampSubagentText,
  DELEGATION_INTERRUPTED,
  readSubagentHistory,
  restorableDelegations,
  SUBAGENT_ENTRY,
  type SubagentRecord,
  subagentHistoryUsage,
} from './records.ts';
import {
  type DelegationRecord,
  DelegationRegistry,
  delegationSummary,
  formatDelegationHeartbeat,
  MAX_SUBAGENT_CONCURRENCY,
  waitForDelegations,
} from './registry.ts';
import {
  addUsage,
  DEFAULT_SUBAGENT_CACHE_RETENTION,
  type SubagentEventEnvelope,
  SubagentRun,
} from './run.ts';

export const SUBAGENT_SERVICE = 'runtimeSubagents';

export const SUBAGENT_TOOL_NAME = 'Task';
export const SUBAGENT_WAIT_TOOL_NAME = 'TaskWait';
export const SUBAGENT_LIST_TOOL_NAME = 'TaskList';
export const SUBAGENT_STOP_TOOL_NAME = 'TaskStop';
export const SUBAGENT_TOOL_NAMES: readonly string[] = [
  SUBAGENT_TOOL_NAME,
  SUBAGENT_WAIT_TOOL_NAME,
  SUBAGENT_LIST_TOOL_NAME,
  SUBAGENT_STOP_TOOL_NAME,
];

/**
 * `TaskWait` blocks the parent turn and the model picks the timeout, so the
 * ceiling is what bounds how long a session can look hung with no way in.
 * Expiry is not a failure and stops nothing: the wait returns a heartbeat plus
 * whatever finished, and the runtime delivers the rest when they finish.
 */
const TASKWAIT_DEFAULT_TIMEOUT_SECONDS = 600;
const TASKWAIT_MAX_TIMEOUT_SECONDS = 900;
/** A `TaskWait` result IS the parent's context; bound it like a report. */
const MAX_TASKWAIT_RESULT_CHARS = 50_000;
/**
 * The persisted half of a `TaskWait` result, which is a separate budget.
 *
 * subagent-core-12 — the contract asks for "separate limits for UI, details and persistence", and the
 * third one was missing: `details.delegations` carried every target's FULL
 * report (12k each) and pi writes `details` into the session JSONL verbatim, so
 * a ten-way wait wrote ~120 KB of text the model never sees and a fifty-id
 * re-read wrote ~600 KB. The full report is on the `settled` record either way;
 * `details` only has to be enough to tell which delegation a row is.
 */
const MAX_TASKWAIT_DETAIL_REPORT_CHARS = 4_000;
/**
 * How many delegation ids one `TaskWait`/`TaskStop` call may name.
 *
 * Also declared on the schema so the model is told, rather than silently
 * truncated. Ten is the concurrency ceiling, so a wait that names more than
 * this is re-reading history — legitimate, but not in one unbounded call.
 */
const MAX_DELEGATION_IDS = 50;

/**
 * Live-channel events one delegation may publish before the carrier goes quiet.
 *
 * subagent-core-06 / subagent-data-04 — the wire protocol has carried
 * `kind: 'capped'` and the renderer has had a branch for it since T-34, but
 * nothing ever produced one: a delegate in a grep→read→grep loop pushed two
 * events per tool call through worker → Main → renderer with no ceiling at all.
 * 200 is the legacy carrier's own figure (`SUBAGENT_EVENTS_MAX_PER_DELEGATION`),
 * kept so the two paths bound the same thing the same way.
 *
 * Terminal status, the report and usage are NOT counted and never suppressed —
 * the contract's "never block the terminal status, usage or full report" is the whole reason the cap
 * is applied here rather than inside the events plugin.
 */
export const MAX_ACTIVITY_EVENTS_PER_DELEGATION = 200;

/**
 * Bytes of delegate transcript one runtime may add to the session file.
 *
 * subagent-data-05 — delegate messages are persisted whole into the PARENT's
 * JSONL, which has a 32 MiB hard budget shared with the parent's own messages;
 * crossing it makes `appendMessage` throw `session_size_limit` and leaves the
 * conversation read-only. Per-string clamping (`clampRecordedMessage`) bounds
 * one message; this bounds the pile. Past it the transcript degrades to
 * start/settle records only — the terminal facts and the full report — which is
 * the part a reopened session actually needs.
 */
export const MAX_DELEGATION_TRANSCRIPT_BYTES = 2 * 1024 * 1024;

/**
 * How long `drain()` waits for an aborted delegate before settling it itself.
 *
 * Generous on purpose: the measured cost of aborting a delegate mid-tool is one
 * more provider request, and cutting a delegate off before that lands would
 * throw away a report it was about to write. This is the backstop for a
 * delegate that never converges at all, not a scheduling knob.
 */
const DRAIN_TIMEOUT_MS = 30_000;

/**
 * How long `TaskStop` waits for the delegates it asked to stop.
 *
 * The same bound as {@link DRAIN_TIMEOUT_MS} and for the same reason: the wait
 * is there so "stopped" is true when it is said, and a delegate wedged on a
 * host call must not turn one tool call into a turn that never ends. Past it
 * the stragglers are settled as `timed_out`, exactly as `drain()` does.
 */
const STOP_TIMEOUT_MS = DRAIN_TIMEOUT_MS;

/**
 * How long one auto-resume pass waits on running delegates before it hands
 * the parent a progress note instead of a report.
 *
 * The longest wait a model may ask `TaskWait` for, so the runtime is never more
 * patient on the model's behalf than the model is allowed to be itself. It
 * does not stop anything: the note says the delegates are still working, and
 * the next pass waits again. What it removes is a run that sits silently
 * forever behind a delegate that will never settle.
 */
const COLLECT_TIMEOUT_MS = TASKWAIT_MAX_TIMEOUT_SECONDS * 1000;

/** Delegation ids a terminal note names before it summarizes the rest. */
const MAX_TERMINAL_NOTE_IDS = 10;

/**
 * `Task`'s description, minus the catalog block appended per run.
 *
 * Split out from the tool builder because {@link SubagentPlugin.taskDescription}
 * rebuilds the whole string whenever the catalog is re-read (subagent-data-02),
 * and the fixed half should not be rebuilt with it.
 */
const TASK_DESCRIPTION_PREAMBLE: readonly string[] = [
  'Start one subagent in the background and return immediately; you keep working while it runs, and its report is delivered to you when it finishes (TaskWait returns it sooner if you cannot continue without it).',
  'Use it when the work is separable: parallel exploration of independent directions (one Task per direction in the same assistant message), a multi-file implementation with a complete spec (fixer), an adversarial read-only review of a change you just made (code-reviewer), or a wide search / long log / multi-file survey whose intermediate output would otherwise fill this context (explorer, test-runner).',
  'Do not delegate what you can finish in a couple of tool calls, and do not delegate anything that needs the user — a subagent cannot ask a question or propose a plan on your behalf.',
  "`task` is the delegate's only instruction. It cannot see this conversation, and you cannot correct it while it runs, so state the goal, the paths and facts it cannot infer, and exactly what to report back.",
  'To run delegates concurrently, emit several Task calls in one assistant message. A message that mixes Task with any other tool runs one call at a time. You may keep working or talk to the user while they run; the runtime delivers every report to you when its delegate finishes, whether or not you wait for it.',
];

/**
 * Opens an auto-resume message. It states what happened and what to do with
 * it, and deliberately names no delegation tool: a model that was told "call
 * X only if…" in every resume message learned to call X.
 */
const DELEGATION_RESUME_PROMPT =
  'The following subagents have finished; their reports are below and are now delivered to you. ' +
  "Integrate them and continue the user's original task.";

export interface SubagentConfig {
  catalog: SubagentCatalog;
  /** Definition names the user switched off, from app data (never the Markdown). */
  disabled?: readonly string[];
  /**
   * Re-read the catalog from disk, for the top of a new top-level run.
   *
   * subagent-data-02 — the contract's "re-read the active definitions on every top-level user run" was
   * never implemented: the catalog was loaded once per worker and frozen into
   * this plugin, so a definition edited (or created) from the settings page did
   * not reach a session already open. Absent leaves the bootstrap snapshot in
   * place, which is what an embedding with no directory to re-read wants.
   */
  reloadCatalog?: () => Promise<SubagentCatalog>;
  /**
   * Worker log sink for catalog diagnostics.
   *
   * subagent-data-10 — `loadSubagentCatalog` has always reported unreadable,
   * unparseable and oversized documents, and nothing read the list: a delegate
   * that silently vanished from the menu left no trace anywhere a person looks.
   */
  log?: (message: string, ...args: unknown[]) => void;
  /**
   * Transcript byte budget override, defaulting to
   * {@link MAX_DELEGATION_TRANSCRIPT_BYTES}.
   *
   * Exists for the same reason `drain(timeoutMs)` takes one: the degraded path
   * is the part worth pinning, and a test that had to write two megabytes of
   * delegate transcript to reach it would spend the budget to prove it exists.
   */
  transcriptBudgetBytes?: number;
  /**
   * `TaskStop`'s wait bound override, defaulting to {@link STOP_TIMEOUT_MS}.
   *
   * Same reason `drain(timeoutMs)` takes one: the deadline path is the part
   * worth pinning, and a test should not spend thirty seconds reaching it.
   */
  stopTimeoutMs?: number;
  /**
   * The project's instruction chain, rendered for a delegate's prompt.
   *
   * A callback rather than a string because the chain is read from disk and can
   * change between turns; a delegate started now must get what the workspace
   * says now, the same as the parent's own prompt does.
   */
  projectInstructions?: () => Promise<string | undefined>;
  /**
   * Static fallback thinking level, used only when a run never bound one.
   *
   * `bindRun()`'s `thinkingLevel` is the live source — it carries the actual
   * parent run's effort, which can change between runs of the same session.
   * This field exists for a caller that never calls `bindRun()` at all (an
   * embedding with no agent loop in front of it).
   */
  thinkingLevel?: ThinkingLevel;
  /**
   * How long the provider keeps a DELEGATE's prompt cache prefix.
   *
   * `short` (the plain five-minute `cache_control`), deliberately not the
   * parent's `long`. A delegate is a burst: it builds its own prefix, spends a
   * handful of turns on it and is gone, and nothing ever re-reads that prefix
   * again. Buying an hour of retention for it is a pure write premium — and a
   * fan-out of delegates would buy one per delegate.
   */
  cacheRetention?: CacheRetention;
  /**
   * Per-request wall clock for a delegate's provider calls, in milliseconds.
   *
   * The parent loop's number, handed down rather than defaulted here: a
   * delegate that was more patient than the conversation it serves would hold
   * the parent run open past the point the user was told to expect.
   * {@link DEFAULT_PROVIDER_IDLE_TIMEOUT_MS} when the host says nothing.
   */
  providerTimeoutMs?: number;
  /**
   * `AICLIENT_RUNTIME_LOOP_GUARD` (engineering standard §6), read once at
   * bootstrap into `flags.loopGuardEnabled` and handed down here rather than
   * read from `process.env` in this file. Defaults to `true` when absent —
   * every caller that does not go through `createRuntime` (a direct plugin
   * test, say) gets the protection on.
   *
   * Off drops only `idleVerdict`'s REFUSAL (form A's second-idle-call-on
   * "Refused: …"): `idle: true` labelling, the terminal note it appends, and
   * every other tool answer stay exactly as they are — those are fixes, not
   * protection. See `delegationLoopGuard.ts`'s module doc for both guarded
   * shapes and `AgentLoopConfig.loopGuardEnabled` for form A's other half (the
   * forced wrap-up) and form B (the mid-stream cut), both in the agent loop.
   */
  loopGuardEnabled?: boolean;
}

/** Which run a delegation belongs to, for attribution on records and events. */
export interface SubagentRunContext {
  sessionId: string;
  runId: string;
  /**
   * The parent run's resolved model, cross-01's fix: `resolveModel`'s third
   * tier reads this instead of `adapter.defaultRef()` (catalog order, unrelated
   * to what the parent is actually running).
   */
  model?: RuntimeModelRef;
  /**
   * The parent run's actual thinking level, cross-02's fix: `Task.execute`'s
   * third tier reads this instead of the dead `SubagentConfig.thinkingLevel`.
   */
  thinkingLevel?: ThinkingLevel;
  /**
   * Aborted when the user interjects (Ctrl+Enter). Ends a `TaskWait` in
   * progress early — the delegates keep running — so the parent's turn can
   * reach the boundary the interjection stops at instead of sitting out the
   * wait's own timeout (up to fifteen minutes).
   */
  interrupt?: AbortSignal;
}

export interface SubagentService {
  readonly definitions: readonly SubagentDefinition[];
  readonly registry: DelegationRegistry;
  /**
   * Re-read the catalog and re-advertise `Task`, for a new top-level run.
   *
   * Delegates already running keep the definition object they started with —
   * they hold their own reference, and changing a prompt under a delegate
   * mid-flight would be a different bug from the one this fixes.
   */
  refresh(): Promise<void>;
  /**
   * What THIS session's earlier runs' delegates cost, off its own records.
   *
   * Read once at the top of a run so a reopened conversation's totals still
   * include delegated spend; the live figure comes from {@link takeUsage}.
   */
  historyUsage(): { usage: Usage | undefined; delegations: number };
  /** True while any delegate runs; the parent run must not be allowed to end. */
  readonly busy: boolean;
  /** Usage accumulated by settled delegates, settled exactly once per run. */
  takeUsage(): Usage | undefined;
  /** Subscribe to delegate transcript events. */
  onEvent(listener: (envelope: SubagentEventEnvelope) => void): () => void;
  /**
   * Wait for the delegates running right now and produce the text to feed the
   * parent, or undefined when there is nothing to wait for.
   *
   * Bounded by `timeoutMs` (default: the longest `TaskWait`). A pass that
   * reaches it with delegates still running and nothing new to report returns
   * a progress note with `timedOut` set, so the caller can decide what a
   * silent delegate means for it rather than wait on it forever.
   */
  collectFinished(
    signal?: AbortSignal,
    timeoutMs?: number
  ): Promise<DelegationCollection | undefined>;
  /** User Stop / dispose. Not parent idle. */
  abortAll(): void;
  /**
   * Stop everything still running and wait for it to actually converge.
   *
   * What separates "the run ended" from "the run stopped being watched". See
   * the implementation for why an abort alone is not enough, and why the wait
   * is nonetheless bounded. `timeoutMs` exists so a test can drive the deadline
   * without spending it.
   */
  drain(timeoutMs?: number): Promise<void>;
  /**
   * Bind the session and run a delegation started from now on belongs to.
   *
   * Called by the loop at the top of each run. Without it a record could not
   * name the run it came from, and a reopened session could not tell one run's
   * delegations from another's.
   */
  bindRun(context: SubagentRunContext): void;
  /**
   * The run bound by {@link bindRun} has returned.
   *
   * Only observable when a run leaves delegates running, which only an
   * interjected run does: they keep working and keep reporting, but nothing
   * they do may claim the session is running any more — the worker has no turn
   * and the renderer has already been told `idle`. The binding itself stays,
   * so their records and activity still name the right session.
   */
  endRun(): void;
}

/** One auto-resume pass's result; see {@link SubagentService.collectFinished}. */
export interface DelegationCollection {
  /** The message to hand the parent model. */
  text: string;
  /**
   * True when the pass hit its deadline with delegates still running and no
   * report to deliver: `text` is a progress note, not a delivery.
   */
  timedOut: boolean;
}

declare module 'cordis' {
  interface Context {
    runtimeSubagents: SubagentService;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Join delegation results into one bounded block for the model. */
function formatDelegationResults(
  results: readonly { delegationId: string; agent: string; status: string; report: string }[],
  note?: string
): string {
  const parts: string[] = [];
  let total = 0;
  let omitted = 0;
  for (const result of results) {
    const block = `## ${result.agent} (${result.delegationId}) — ${result.status}\n${result.report}`;
    if (total + block.length > MAX_TASKWAIT_RESULT_CHARS) {
      omitted += 1;
      continue;
    }
    parts.push(block);
    total += block.length + 2;
  }
  if (omitted > 0) {
    parts.push(
      `[${omitted} more result${omitted === 1 ? '' : 's'} omitted to protect this context; call TaskWait with their delegationIds to re-read one.]`
    );
  }
  return [note, ...parts].filter((part) => part?.trim()).join('\n\n');
}

export class SubagentPlugin extends Service implements SubagentService {
  static inject = [TOOLS_SERVICE, 'runtimeModel'];

  readonly registry = new DelegationRegistry();
  private readonly config: SubagentConfig;
  private readonly listeners = new Set<(envelope: SubagentEventEnvelope) => void>();
  private usage: Usage | undefined;
  /**
   * Delegations whose spend is in {@link usage} and not yet taken.
   *
   * Their `settled` records may already be on disk, and {@link historyUsage}
   * reads those records — so a delegate that settled BETWEEN runs (left
   * running by an interjection) would otherwise be counted twice by the next
   * run: once from the file, once from `takeUsage()`.
   */
  private readonly untakenUsage = new Set<string>();
  private runContext?: SubagentRunContext;
  /** True between `bindRun()` and `endRun()`; see {@link SubagentService.endRun}. */
  private runLive = false;
  /**
   * The active definition list. Not `readonly` any more: {@link refresh}
   * replaces it wholesale between top-level runs (subagent-data-02).
   */
  private activeDefinitions: readonly SubagentDefinition[];
  /** Diagnostics from the catalog this list came from, for failure text. */
  private diagnostics: readonly { code: string; message: string; path: string }[];
  /** False until `Task*` reached the registry; an empty catalog registers none. */
  private toolsRegistered = false;
  /** The `Task` schema object, shared with the registry's copy so it can be
   * rewritten in place when the catalog changes. */
  private taskParameters: TSchema | undefined;
  /** Live-channel events published per delegation, for the cap. */
  private readonly activityCounts = new Map<string, number>();
  /** Bytes of delegate transcript already written to this session. */
  private transcriptBytes = 0;
  /** True once the transcript budget was reported; reported once, not per write. */
  private transcriptBudgetReported = false;
  /** Start facts, kept until settlement so one record can carry both ends. */
  private readonly started = new Map<
    string,
    { parentToolCallId: string; model: string; startedAt: number; runId: string }
  >();
  /**
   * Control calls this run answered while nothing was running and nothing was
   * waiting to be delivered. The first gets a full answer; every later one is
   * refused with the same instruction (see {@link idleVerdict}). Per run.
   */
  private idleCalls = 0;
  /** Id sets `TaskWait` has re-read this run; a first re-read is real work. */
  private readonly rereads = new Set<string>();

  constructor(ctx: Context, config: SubagentConfig) {
    super(ctx, SUBAGENT_SERVICE);
    this.config = config;
    this.activeDefinitions = applySubagentActivation(
      config.catalog,
      config.disabled ?? []
    ).definitions;
    this.diagnostics = config.catalog.diagnostics;
    this.reportDiagnostics();
    this.restoreFromSession();
    ctx.effect(() => () => {
      this.abortAll();
      this.listeners.clear();
    });
    // Nothing to delegate to means nothing to advertise. Registering `Task`
    // with an empty catalog would put a tool in every request that can only
    // ever answer "unknown subagent". `refresh()` registers them later if a
    // definition appears while the worker is alive.
    if (this.activeDefinitions.length === 0) return;
    this.registerTools();
  }

  get definitions(): readonly SubagentDefinition[] {
    return this.activeDefinitions;
  }

  /** `write` access: the tools plugin already drops write tools in plan mode,
   * which is exactly the contract's "no delegation from plan". */
  private registerTools(): void {
    const tools = this.ctx.get(TOOLS_SERVICE);
    if (!tools) return;
    tools.register(this.buildTaskTool(), 'write');
    tools.register(this.buildWaitTool(), 'write');
    tools.register(this.buildListTool(), 'write');
    tools.register(this.buildStopTool(), 'write');
    this.toolsRegistered = true;
  }

  /**
   * subagent-data-02 — re-read the catalog for a new top-level run.
   *
   * A reload failure is not a turn failure: the previous list is still a
   * working list, and refusing to run because a directory blinked would be a
   * worse answer than delegating to what we already know about. It is logged,
   * because "my new subagent is not there" needs somewhere to look.
   */
  async refresh(): Promise<void> {
    const reload = this.config.reloadCatalog;
    if (!reload) return;
    let catalog: SubagentCatalog;
    try {
      catalog = await reload();
    } catch (error) {
      this.config.log?.('[subagent] catalog reload failed', error);
      return;
    }
    this.activeDefinitions = applySubagentActivation(
      catalog,
      this.config.disabled ?? []
    ).definitions;
    this.diagnostics = catalog.diagnostics;
    this.reportDiagnostics();
    this.refreshTaskTool();
  }

  /**
   * Re-advertise the catalog on the already-registered `Task` tool.
   *
   * `ToolsPlugin.register` throws on a duplicate name and takes a shallow copy
   * of the tool object, so re-registering is not an option and rewriting our
   * own copy would not reach the model. The description is written onto the
   * registry's copy; `parameters` is the same object on both sides, so the
   * `agent` enumeration is written through it.
   */
  private refreshTaskTool(): void {
    const tools = this.ctx.get(TOOLS_SERVICE);
    if (!tools) return;
    if (!this.toolsRegistered) {
      if (this.activeDefinitions.length === 0) return;
      this.registerTools();
      return;
    }
    const registered = tools.list().find((tool) => tool.name === SUBAGENT_TOOL_NAME);
    // Absent in plan mode, where `Task` is filtered out and no delegation can
    // happen anyway; the next non-plan run picks the new text up.
    if (registered) (registered as { description: string }).description = this.taskDescription();
    const agent = (
      this.taskParameters as { properties?: { agent?: { description?: string } } } | undefined
    )?.properties?.agent;
    if (agent) agent.description = this.taskAgentDescription();
  }

  /** subagent-data-10 — the one place a bad definition document is reported. */
  private reportDiagnostics(): void {
    for (const diagnostic of this.diagnostics) {
      this.config.log?.(
        `[subagent] ${diagnostic.code}: ${diagnostic.path} — ${diagnostic.message}`
      );
    }
  }

  /**
   * The diagnostics as one sentence for a `Task` failure, or nothing.
   *
   * Appended to "unknown subagent" because that is when the user is looking at
   * the consequence: a definition that failed to load is missing from the menu,
   * and the menu is the only thing the model can report.
   */
  private diagnosticNote(): string {
    if (this.diagnostics.length === 0) return '';
    const shown = this.diagnostics
      .slice(0, 3)
      .map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`)
      .join('; ');
    const more = this.diagnostics.length > 3 ? ` (+${this.diagnostics.length - 3} more)` : '';
    return ` ${this.diagnostics.length} subagent document(s) failed to load and are not in this list — ${shown}${more}.`;
  }

  historyUsage(): { usage: Usage | undefined; delegations: number } {
    const entries = this.ctx.get(SESSION_SERVICE)?.snapshot().entries;
    if (!entries) return { usage: undefined, delegations: 0 };
    return subagentHistoryUsage(
      readSubagentHistory(entries).filter((entry) => !this.untakenUsage.has(entry.delegationId))
    );
  }

  bindRun(context: SubagentRunContext): void {
    this.runContext = context;
    this.runLive = true;
    // A new user message is a new question: the model may legitimately ask
    // once more what its delegates did.
    this.idleCalls = 0;
    this.rereads.clear();
  }

  /**
   * Rebuild the registry from this session's own records, once, at open.
   *
   * Without it the registry only knew what this worker had started, so a
   * reopened conversation full of delegations got "No subagents have been
   * started in this session" from `TaskList`, a `TaskWait` by id answered
   * "unknown", and a report that settled between runs was lost. Only facts
   * come back — every restored record is settled; see `restorableDelegations`.
   * A session that cannot be read is not a reason to refuse to start.
   */
  private restoreFromSession(): void {
    let entries: ReturnType<RuntimeSessionService['snapshot']>['entries'] | undefined;
    try {
      entries = this.ctx.get(SESSION_SERVICE)?.snapshot().entries;
    } catch (error) {
      this.config.log?.('[subagent] could not read the session to restore delegations', error);
      return;
    }
    if (!entries) return;
    for (const record of restorableDelegations(entries)) this.registry.restore(record);
  }

  endRun(): void {
    this.runLive = false;
  }

  get busy(): boolean {
    return this.registry.busy;
  }

  /**
   * Write one attributed record, and never let that failure cost the turn.
   *
   * A session that cannot be appended to is a real problem, but it is the
   * session's problem: a delegate that already did the work must still report
   * it, and failing the delegation because the log write failed would turn a
   * storage fault into lost work.
   */
  private async record(data: SubagentRecord): Promise<void> {
    const session = this.ctx.get(SESSION_SERVICE);
    if (!session) return;
    try {
      await session.appendEntry({ type: 'custom', customType: SUBAGENT_ENTRY, data });
    } catch (error) {
      // Still swallowed — see the note above — but no longer silent.
      // subagent-data-05: a delegate's records failing to land is the first
      // symptom of a session running out of its byte budget, and it left no
      // trace anywhere, so the eventual `session_size_limit` on the parent's
      // own message arrived with no history to explain it.
      this.config.log?.(`[subagent] could not record ${data.kind} for ${data.delegationId}`, error);
    }
  }

  /**
   * Write one delegate message, inside the transcript budget.
   *
   * subagent-data-05 — two bounds, because they fail differently. Each message
   * is clamped per string so one 50 KiB tool result cannot be one 50 KiB entry;
   * the session-wide total is capped so a long enough conversation cannot spend
   * the parent's 32 MiB budget on delegate transcripts and leave the user with
   * a conversation they can no longer send to. Past the cap the start and
   * settle records still go — those carry the terminal status and the full
   * report, which is what a reopened session needs to be truthful.
   */
  private async recordMessage(data: SubagentRecord & { kind: 'message' }): Promise<void> {
    const budget = this.config.transcriptBudgetBytes ?? MAX_DELEGATION_TRANSCRIPT_BYTES;
    if (this.transcriptBytes >= budget) {
      if (!this.transcriptBudgetReported) {
        this.transcriptBudgetReported = true;
        this.config.log?.(
          `[subagent] delegate transcript budget spent (${budget} bytes); recording terminal facts only for the rest of this session`
        );
      }
      return;
    }
    const clamped = { ...data, message: clampRecordedMessage(data.message) };
    // Measured on what is actually written, not on what arrived: the clamp is
    // the point of the measurement.
    this.transcriptBytes += Buffer.byteLength(JSON.stringify(clamped.message ?? ''), 'utf8');
    await this.record(clamped);
  }

  /**
   * Publish one live-projection payload on the session's event channel.
   *
   * subagent-core-06 / subagent-data-04 — bounded per delegation. The first
   * {@link MAX_ACTIVITY_EVENTS_PER_DELEGATION} progress payloads go out, then
   * exactly one `kind: 'capped'`, then the carrier is quiet for that delegation.
   * Terminal payloads (`status`, `report`) are never counted and never dropped:
   * the contract forbids a cap from costing a terminal status, a usage figure
   * or a report, and those are also what the renderer needs to stop a lane
   * spinning forever.
   */
  private emitActivity(payload: SubagentActivityPayload): void {
    const events = this.ctx.get(EVENTS_SERVICE);
    const sessionId = this.runContext?.sessionId;
    if (!events || !sessionId) return;
    const terminal = payload.kind === 'status' || payload.kind === 'report';
    const agentId = payload.agentId;
    if (!terminal && agentId) {
      const seen = (this.activityCounts.get(agentId) ?? 0) + 1;
      this.activityCounts.set(agentId, seen);
      if (seen > MAX_ACTIVITY_EVENTS_PER_DELEGATION + 1) return;
      if (seen === MAX_ACTIVITY_EVENTS_PER_DELEGATION + 1) {
        events.emit({
          type: 'subagent.activity',
          sessionId,
          payload: {
            parentToolCallId: payload.parentToolCallId,
            agentId,
            kind: 'capped',
            limit: MAX_ACTIVITY_EVENTS_PER_DELEGATION,
          },
        });
        return;
      }
    }
    events.emit({ type: 'subagent.activity', sessionId, payload });
  }

  /**
   * Put a delegate's provider backoff on the session's retry banner.
   *
   * The same `session.status` rider the parent loop's own retries use, and
   * deliberately not a `subagent.activity` row: the banner is one surface, and a
   * user watching a turn that has stopped producing output needs the SAME
   * explanation whether the stalled request is the conversation's or a
   * delegate's. `delegationId` is what lets the renderer attribute it; an
   * `undefined` info is the "the wait is over" message, which is how every other
   * producer of this status takes the banner down.
   *
   * Not counted against the per-delegation activity cap: a cap that could cost a
   * user the explanation for a stalled turn would be the wrong trade, and the
   * number of these is bounded by the retry budget anyway.
   */
  private publishRetry(delegationId: string, info: SessionRetryInfo | undefined): void {
    const events = this.ctx.get(EVENTS_SERVICE);
    const sessionId = this.runContext?.sessionId;
    // Between runs this status would flip an idle session back to `running`
    // with no run left to ever send `idle` again.
    if (!events || !sessionId || !this.runLive) return;
    events.emit({
      type: 'session.status',
      sessionId,
      payload: { status: 'running', ...(info ? { retry: { ...info, delegationId } } : {}) },
    });
  }

  takeUsage(): Usage | undefined {
    const usage = this.usage;
    this.usage = undefined;
    this.untakenUsage.clear();
    return usage;
  }

  onEvent(listener: (envelope: SubagentEventEnvelope) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  abortAll(): void {
    this.registry.abortAllRunning();
  }

  /**
   * Stop everything and wait for it to settle.
   *
   * `abortAll()` only ASKS. The P5-2-0 probe measured that aborting a delegate
   * mid-tool costs one more provider request before its loop closes, so a run
   * that resolved right after asking would tell the user "stopped" while
   * delegates were still spending tokens and still had records to write — and
   * the session writer would already be closing. Bounded by the same thing
   * that bounds `TaskStop`: the delegate's own abort path, which the probe
   * showed does converge.
   *
   * Bounded anyway. "Does converge" is a measurement, not a guarantee: a
   * delegate wedged on a host call that never answers would make this wait
   * forever, and this wait sits in the run's `finally` and in `dispose()`. An
   * unbounded one turns "I cannot stop this" into "I cannot close this either",
   * which is the difference between a bad turn and a process the user has to
   * kill. Past the deadline the stragglers are settled here, as `timed_out`, so
   * everyone waiting on their `completion` is released and the registry says
   * plainly what happened instead of showing them running forever.
   */
  async drain(timeoutMs: number = DRAIN_TIMEOUT_MS): Promise<void> {
    const running = this.registry.running();
    if (running.length === 0) return;
    this.registry.abortAllRunning();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const converged = await Promise.race([
      Promise.all(running.map((record) => record.completion)).then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
    if (converged) return;
    this.settleStragglers(this.registry.running(), timeoutMs);
  }

  /**
   * Settle delegates that were asked to stop and did not converge in time.
   *
   * Shared by `drain()` and `TaskStop`, so both bounded waits end the same way:
   * the record says `timed_out`, everyone waiting on its completion is
   * released, and its report says plainly why there is no more to it.
   */
  private settleStragglers(records: readonly DelegationRecord[], timeoutMs: number): void {
    const seconds = Math.max(1, Math.round(timeoutMs / 1000));
    for (const record of records) {
      if (record.status !== 'running') continue;
      this.registry.requestStop(record, 'timed_out');
      this.settle(record, {
        agentName: record.agentName,
        status: 'timed_out',
        report: `The ${record.agentName} subagent did not converge within ${seconds}s of being asked to stop; the session stopped waiting for it.`,
        turns: record.turns,
        toolCalls: record.toolCalls,
        error: {
          code: 'delegation_drain_timeout',
          message: `delegate did not settle within ${seconds}s of abort`,
        },
      });
    }
  }

  /**
   * One pass of the auto-resume loop: wait for whatever is running right now,
   * then render every outcome the parent has not been shown.
   *
   * Two details carry the whole SA07 race:
   *
   * - The running set is snapshotted BEFORE waiting. A delegate started by the
   *   parent's next turn belongs to the next pass; folding it in would let a
   *   parent that keeps delegating hold this wait open forever.
   * - What gets reported is the UNDELIVERED set, not the set we just waited on.
   *   A delegate that finished while the parent was still working is no longer
   *   running by the time we get here, and reporting only the ones we waited
   *   for would silently drop its report.
   *
   * The wait itself is bounded (see {@link COLLECT_TIMEOUT_MS}): a delegate
   * that never settles used to hold the run open forever with nothing on
   * screen but a spinner.
   */
  async collectFinished(
    signal?: AbortSignal,
    timeoutMs: number = COLLECT_TIMEOUT_MS
  ): Promise<DelegationCollection | undefined> {
    const targets = this.registry.running();
    let timedOut = false;
    if (targets.length > 0) {
      const endedEarly = await waitForDelegations(
        targets,
        targets.length,
        Date.now() + timeoutMs,
        signal
      );
      if (signal?.aborted) return undefined;
      timedOut = endedEarly;
    }
    const settled = this.registry.undelivered();
    const now = Date.now();
    const still = this.registry.running();
    const heartbeat = still.length
      ? `Still running (each report is delivered when it finishes):\n${still.map((record) => formatDelegationHeartbeat(record, now)).join('\n')}`
      : '';
    if (settled.length === 0) {
      if (!timedOut || still.length === 0) return undefined;
      const minutes = Math.max(1, Math.round(timeoutMs / 60_000));
      return {
        timedOut: true,
        text: [
          `No subagent has finished in the last ${minutes} minute${minutes === 1 ? '' : 's'}, and nothing has failed. Continue the user's task with what you have; if a delegate's work is no longer needed you may stop it.`,
          heartbeat,
        ].join('\n\n'),
      };
    }
    this.registry.markDelivered(settled, now);
    const results = settled.map((record) => ({
      delegationId: record.delegationId,
      agent: record.agentName,
      status: record.status,
      report: record.result?.report ?? `(${record.status} without a report)`,
    }));
    return {
      timedOut: false,
      text: [DELEGATION_RESUME_PROMPT, formatDelegationResults(results), heartbeat]
        .filter((part) => part.trim())
        .join('\n\n'),
    };
  }

  private publish(envelope: SubagentEventEnvelope): void {
    this.registry.noteActivity(envelope.delegationId, {
      type: envelope.event.type,
      ...(envelope.event.type === 'tool_execution_start'
        ? { toolName: envelope.event.toolName }
        : {}),
    });
    const base = {
      parentToolCallId: envelope.parentToolCallId,
      agentId: envelope.delegationId,
    };
    for (const activity of activityForEvent(envelope.event, base)) this.emitActivity(activity);
    // The delegate's own messages are PERSISTED as custom entries. The live
    // projection above is a bounded summary of the same thing; this is the copy
    // a history read gets back — per-string clamped and inside a session-wide
    // byte budget since subagent-data-05, because "whole" and "shares the
    // parent's 32 MiB file" cannot both be true.
    if (envelope.event.type === 'message_end' && this.runContext) {
      void this.recordMessage({
        kind: 'message',
        delegationId: envelope.delegationId,
        agentName: envelope.agentName,
        parentToolCallId: envelope.parentToolCallId,
        // The run that STARTED the delegation: one left running by an
        // interjection keeps talking while a later run is bound.
        runId: this.started.get(envelope.delegationId)?.runId ?? this.runContext.runId,
        message: envelope.event.message,
        at: Date.now(),
      });
    }
    for (const listener of this.listeners) listener(envelope);
  }

  /**
   * A `Task` call that never reached a delegate.
   *
   * Returned as a normal result rather than thrown, so the explanation stays in
   * the text the model reads. pi ignores an `isError` field on a plain result,
   * so this is deliberately a readable failure and not a marked one — the model
   * has to decide what to do next, and "unknown subagent, here are the real
   * ones" is more useful than an error with no menu.
   */
  private toolError(text: string) {
    return { content: [{ type: 'text' as const, text }], details: { error: text } };
  }

  /** Model this delegate runs on: `Task.model` > definition pin > parent. */
  private resolveModel(
    definition: SubagentDefinition,
    override: string
  ): { ok: true; model: ResolvedModel } | { ok: false; text: string } {
    const adapter = this.ctx.runtimeModel;
    const available = adapter.list();
    if (override) {
      const slash = override.indexOf('/');
      const pin =
        slash > 0
          ? { provider: override.slice(0, slash), modelId: override.slice(slash + 1) }
          : undefined;
      const ref = pin ? resolveSubagentPin(pin, available) : undefined;
      if (!ref) {
        const menu = available.map((entry) => `${entry.provider}/${entry.id}`).join(', ');
        return {
          ok: false,
          text: `Model "${override}" is not available for delegation.${
            menu ? ` Available: ${menu}.` : ' No models are configured for delegation.'
          }`,
        };
      }
      return { ok: true, model: adapter.resolve(ref) };
    }
    if (definition.model) {
      // subagent-core-13 — the provider cap is enforced HERE, on the path that
      // actually starts a delegate, and not only counted in `catalog.ts`'s
      // diagnostics (which nothing read). Its own JSDoc said "`Task` is where
      // the model is told, because that is where the choice is made", and until
      // now the ninth provider's pin ran anyway. Same shape as an unresolvable
      // pin: a readable refusal with what to do instead, never a silent
      // fallback onto the session model.
      const allowed = subagentPinnedProviders(this.activeDefinitions);
      if (!allowed.includes(definition.model.provider)) {
        return {
          ok: false,
          text: `The ${definition.name} subagent pins ${subagentModelKey(definition.model)}, but this catalog already names ${MAX_SUBAGENT_PROVIDERS} model providers and that is the limit. Repoint it at ${allowed.join(', ')}, or do this work yourself.`,
        };
      }
      const ref = resolveSubagentPin(definition.model, available);
      if (!ref) {
        // No fallback to the session model, ever: a definition that asked for a
        // cheap model must not silently start spending the expensive one.
        return {
          ok: false,
          text: `The ${definition.name} subagent pins ${subagentModelKey(definition.model)}, which is not configured here. Do this work yourself or delegate to another subagent.`,
        };
      }
      return { ok: true, model: adapter.resolve(ref) };
    }
    const parentRef = this.runContext?.model;
    if (parentRef) {
      // The parent's ref has to still be in THIS catalog before it is trusted,
      // the same rule an override or a definition pin already follows: SA12
      // promises "unavailable fails with a menu", never a silent fallback to
      // some other model. A mismatch here would mean the catalog changed under
      // a resumed session between the parent's turn and this delegation.
      const stillAvailable = available.some(
        (entry) => entry.provider === parentRef.provider && entry.id === parentRef.id
      );
      if (!stillAvailable) {
        const menu = available.map((entry) => `${entry.provider}/${entry.id}`).join(', ');
        return {
          ok: false,
          text: `The parent session's model "${parentRef.provider}/${parentRef.id}" is not available for delegation.${
            menu ? ` Available: ${menu}.` : ' No models are configured for delegation.'
          }`,
        };
      }
      return { ok: true, model: adapter.resolve(parentRef) };
    }
    // No run context bound at all (a caller that never reached `bindRun()`,
    // e.g. a probe run directly against the plugin): fall back to the
    // catalog's first entry rather than refusing every delegation outright.
    const fallback = adapter.defaultRef();
    if (!fallback) return { ok: false, text: 'No model is configured for delegation.' };
    return { ok: true, model: adapter.resolve(fallback) };
  }

  /**
   * The catalog block at the end of `Task`'s description.
   *
   * A method rather than a closure variable because {@link refreshTaskTool}
   * rewrites it between runs; a captured string would freeze the menu the model
   * sees at whatever the worker booted with.
   */
  private taskDescription(): string {
    const catalog = this.activeDefinitions
      .map(
        (definition) =>
          `- ${definition.name} (tools: ${definition.tools.join(', ')}): ${definition.description}`
      )
      .join('\n');
    return [
      ...TASK_DESCRIPTION_PREAMBLE,
      catalog
        ? `Available subagents:\n${catalog}`
        : 'No subagents are configured right now, so every call will fail; do the work yourself.',
    ].join('\n\n');
  }

  private taskAgentDescription(): string {
    const names = this.activeDefinitions.map((definition) => definition.name);
    return `Name of the subagent to run: ${names.join(', ')}.`;
  }

  private buildTaskTool(): AgentTool<TSchema, unknown> {
    const parameters = Type.Object(
      {
        agent: Type.String({ description: this.taskAgentDescription() }),
        task: Type.String({
          description:
            'The complete brief: goal, context the delegate cannot infer, and the exact report you want back.',
        }),
        description: Type.Optional(
          Type.String({
            description: 'Short label for this delegation (3-6 words), shown to the user.',
          })
        ),
        model: Type.Optional(
          Type.String({
            description:
              "Override the delegate's model for this run, as `provider/model`. Omit to use the subagent's default.",
          })
        ),
      },
      { additionalProperties: false }
    );
    // Held so `refreshTaskTool` can rewrite the `agent` enumeration: the tools
    // registry keeps a shallow copy of the tool, so this object is shared.
    this.taskParameters = parameters;
    return {
      name: SUBAGENT_TOOL_NAME,
      label: 'Task',
      description: this.taskDescription(),
      parameters,
      executionMode: 'parallel',
      execute: async (toolCallId, params) => {
        // Read like `task` and `model` below rather than as a `?? ''` fallback:
        // `agentWireStatic.test.ts` scans for a literal default off any `.agent`
        // read, because on the SESSION axis that is a second answer to "what
        // does a missing binding mean". This `agent` is a delegate's name, a
        // different axis entirely — but the scan cannot tell them apart, and a
        // guard that has to carry an exception per unrelated field stops being
        // a guard.
        const requested = isRecord(params) && typeof params.agent === 'string' ? params.agent : '';
        const definition = this.activeDefinitions.find(
          (candidate) => candidate.name === normalizeSubagentName(requested)
        );
        if (!definition) {
          // subagent-data-10 — the diagnostics ride the failure that a bad
          // document actually causes. "Unknown subagent fixer" with no further
          // word is indistinguishable from a typo; "…and fixer.md failed to
          // parse" is the answer.
          const names = this.activeDefinitions.map((candidate) => candidate.name);
          return this.toolError(
            `Unknown subagent "${requested}". Available: ${names.join(', ')}.${this.diagnosticNote()}`
          );
        }
        const task = isRecord(params) && typeof params.task === 'string' ? params.task.trim() : '';
        if (!task)
          return this.toolError(
            `Delegating to ${definition.name} needs a non-empty \`task\` brief.`
          );

        const override =
          isRecord(params) && typeof params.model === 'string' ? params.model.trim() : '';
        const model = this.resolveModel(definition, override);
        if (!model.ok) return this.toolError(model.text);

        const registered = (this.ctx.get(TOOLS_SERVICE)?.list() ?? []).map((tool) => tool.name);
        const { available, unavailable } = resolveDelegateToolNames(definition, registered);
        if (available.length === 0) {
          return this.toolError(
            `The ${definition.name} subagent declares no tool available in this session (missing: ${unavailable.join(', ')}).`
          );
        }

        const delegationId = randomUUID();
        const tools = this.scopeDelegateTools(
          (this.ctx.get(TOOLS_SERVICE)?.list() ?? []).filter((tool) =>
            available.includes(tool.name)
          ),
          definition,
          delegationId
        );
        const controller = new AbortController();
        const label =
          isRecord(params) && typeof params.description === 'string'
            ? params.description.trim()
            : '';
        const admitted = this.registry.admit({
          delegationId,
          agentName: definition.name,
          ...(label ? { label } : {}),
          abort: () => controller.abort(),
        });
        if (!admitted.ok) return this.toolError(admitted.reason);
        const record = admitted.record;
        // Everything from here to the handover is inside the guard below.
        //
        // `admit()` has already registered a RUNNING delegation and handed the
        // registry the only resolve handle for its `completion` promise. Until
        // `SubagentRun.run()` is attached, nothing else can ever settle it — so
        // a throw anywhere in this window (the instruction chain read, the
        // activity listeners, the `new Agent(...)` inside the run) leaves a
        // record that is running forever. Three separate things then wait on it
        // with no timeout: the auto-resume pass, `drain()` after a Stop, and
        // `dispose()`. The session becomes unstoppable and uncloseable, and the
        // only exit is killing the process.
        try {
          return await this.startDelegation({
            record,
            definition,
            toolCallId,
            task,
            label,
            model: model.model,
            available,
            unavailable,
            tools,
            signal: controller.signal,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.settle(record, {
            agentName: definition.name,
            status: 'failed',
            report: `The ${definition.name} subagent could not be started: ${message}`,
            turns: 0,
            toolCalls: 0,
            error: { code: 'delegation_start_failed', message },
          });
          // Delivered because the model is reading the failure right now, as
          // this call's result. Leaving it undelivered would make the
          // auto-resume pass tell it the same thing a second time.
          this.registry.markDelivered([record]);
          return this.toolError(
            `Delegating to ${definition.name} failed before the subagent started: ${message}`
          );
        }
      },
    };
  }

  /**
   * Everything between admission and the delegate's own run taking over.
   *
   * Split out so the guard around it in `Task.execute` covers ALL of it,
   * including the `new SubagentRun(...)` constructor, rather than just the one
   * `await` that happens to be visible.
   */
  private async startDelegation(start: {
    record: DelegationRecord;
    definition: SubagentDefinition;
    toolCallId: string;
    task: string;
    label: string;
    model: ResolvedModel;
    available: readonly string[];
    unavailable: readonly string[];
    tools: AgentTool<TSchema, unknown>[];
    signal: AbortSignal;
  }) {
    const {
      record,
      definition,
      toolCallId,
      task,
      label,
      model,
      available,
      unavailable,
      tools,
      signal,
    } = start;
    const delegationId = record.delegationId;
    const modelLabel = `${model.ref.provider}/${model.model.id}`;
    this.started.set(delegationId, {
      parentToolCallId: toolCallId,
      model: modelLabel,
      startedAt: record.startedAt,
      runId: this.runContext?.runId ?? '',
    });
    if (this.runContext) {
      void this.record({
        kind: 'started',
        delegationId,
        agentName: definition.name,
        parentToolCallId: toolCallId,
        runId: this.runContext.runId,
        task,
        ...(label ? { label } : {}),
        model: { provider: model.ref.provider, modelId: model.model.id },
        startedAt: record.startedAt,
      });
    }
    this.emitActivity({
      parentToolCallId: toolCallId,
      agentId: delegationId,
      kind: 'started',
      agentType: definition.name,
      ...(label ? { description: label } : {}),
    });
    const projectInstructions = await this.config.projectInstructions?.();

    // Started, then deliberately NOT awaited. Tying the background run to
    // this tool call's signal would kill the delegate the moment the parent
    // loop went idle, which is the whole failure D328 withdrew.
    void new SubagentRun({
      definition,
      delegationId,
      parentToolCallId: toolCallId,
      task,
      systemPrompt: composeSubagentSystemPrompt({
        definition,
        toolNames: available,
        guidance: subagentGuidance({
          toolNames: available,
          ...(projectInstructions ? { projectInstructions } : {}),
        }),
      }),
      model,
      thinkingLevel: (definition.thinkingLevel ??
        this.runContext?.thinkingLevel ??
        this.config.thinkingLevel ??
        'medium') as ThinkingLevel,
      cacheRetention: this.config.cacheRetention ?? DEFAULT_SUBAGENT_CACHE_RETENTION,
      providerTimeoutMs: this.config.providerTimeoutMs ?? DEFAULT_PROVIDER_IDLE_TIMEOUT_MS,
      tools,
      // T130 — the same outcome rule as the parent loop's `afterToolCall`: a
      // command cut short by TaskStop or Stop is not recorded as a success.
      resolveToolOutcome: stoppedToolOutcome,
      onEvent: (envelope) => this.publish(envelope),
      // decision 029 clause 8 — a delegate's backoff reaches the same banner
      // the parent's does, tagged so the renderer can say WHICH delegate is
      // waiting. Before this the delegate budget carried no callbacks at all.
      onRetry: ({ error, attempt, delayMs, status, attemptStartedAt, retryAt }) =>
        this.publishRetry(delegationId, {
          attempt,
          maxRetries:
            error.code === 'PROVIDER_RATE_LIMITED'
              ? PROVIDER_RATE_LIMIT_MAX_RETRIES
              : PROVIDER_TRANSIENT_MAX_RETRIES,
          delayMs,
          errorStatus: status === undefined ? null : String(status),
          error: error.code,
          retryAt,
          attemptStartedAt,
        }),
      onRetrySettled: () => this.publishRetry(delegationId, undefined),
      signal,
      // Read at settlement, not now: `requestStop` writes the reason onto the
      // record while the delegate's loop is still closing.
      cancelReason: () => record.cancelReason,
    })
      .run()
      .then(
        (result) => this.settle(record, result),
        // `run()` settles its own failures into results; this guard only
        // keeps an unexpected rejection from leaving a delegation stuck in
        // "running" forever, which would hold the parent run open.
        (error: unknown) =>
          this.settle(record, {
            agentName: definition.name,
            status: 'failed',
            report: `The ${definition.name} subagent failed before it could report.`,
            turns: 0,
            toolCalls: 0,
            error: {
              code: 'unexpected_delegation_rejection',
              message: error instanceof Error ? error.message : String(error),
            },
          })
      );

    return {
      content: [
        {
          type: 'text' as const,
          text: `Delegation ${delegationId} started: the ${definition.name} subagent is working in the background${label ? ` (${label})` : ''}. Its report will be delivered to you when it finishes; TaskWait with this delegationId returns it sooner if you cannot continue without it.`,
        },
      ],
      details: {
        delegationId,
        agent: definition.name,
        status: 'running',
        startedAt: record.startedAt,
        ...(unavailable.length ? { unavailableTools: unavailable } : {}),
      },
    };
  }

  /**
   * Wrap a delegate's tools so every call it makes carries its definition's
   * permission scope and its own identity to the gate.
   *
   * Keyed by tool call id and torn down in a `finally`, so two delegates with
   * different gears running at the same time never cross over, and a delegate
   * that throws does not leave its gear behind for the parent's next call.
   *
   * Note what this does NOT do: it never calls `configure()`. Switching the
   * session gear for the duration of a delegate's call is the obvious
   * implementation and the wrong one — delegates are concurrent, so the second
   * one would run under the first one's gear.
   */
  private scopeDelegateTools(
    tools: readonly AgentTool<TSchema, unknown>[],
    definition: SubagentDefinition,
    delegationId: string
  ): AgentTool<TSchema, unknown>[] {
    const permissions = this.ctx.get('runtimePermissions');
    const declared = definition.permission;
    const scope: DelegateCallScope = {
      // `inherit` (the default) contributes no gear: the call resolves under
      // whatever the session is set to, which is the point of inheriting.
      ...(declared && declared !== 'inherit' ? { gear: declared } : {}),
      delegation: { delegationId, agentName: definition.name },
    };
    if (!permissions) return [...tools];
    return tools.map((tool) => ({
      ...tool,
      execute: async (toolCallId, args, signal, onUpdate) => {
        const release = permissions.scopeToolCall(toolCallId, scope);
        try {
          return await tool.execute(toolCallId, args, signal, onUpdate);
        } finally {
          release();
        }
      },
    }));
  }

  private settle(record: DelegationRecord, result: Parameters<DelegationRegistry['settle']>[1]) {
    const settled = this.registry.settle(record.delegationId, result);
    // Cost is accumulated at settlement and only for the run that actually
    // settled, so a repeated terminal event, a TaskWait re-read or a UI refresh
    // cannot bill the same delegate twice. The same guard is what makes the
    // records and the terminal events below fire exactly once.
    if (!settled) return;
    if (result.usage) {
      this.usage = addUsage(this.usage, result.usage);
      this.untakenUsage.add(record.delegationId);
    }
    const start = this.started.get(record.delegationId);
    this.started.delete(record.delegationId);
    const completedAt = record.completedAt ?? Date.now();
    if (start && this.runContext) {
      void this.record({
        kind: 'settled',
        delegationId: record.delegationId,
        agentName: record.agentName,
        parentToolCallId: start.parentToolCallId,
        runId: start.runId,
        status: record.status === 'running' ? result.status : record.status,
        turns: result.turns,
        toolCalls: result.toolCalls,
        // The FULL report, not the live projection's clamped copy: the event
        // channel is capped, and a cap must never be why a report is lost.
        report: result.report,
        ...(result.usage ? { usage: result.usage } : {}),
        ...(result.error ? { error: result.error } : {}),
        completedAt,
      });
    }
    // The cap's counter has done its job once the delegation is terminal, and
    // leaving it would grow one entry per delegation for the session's life.
    this.activityCounts.delete(record.delegationId);
    if (start) {
      for (const payload of activityForSettlement(
        { ...result, status: record.status === 'running' ? result.status : record.status },
        { parentToolCallId: start.parentToolCallId, agentId: record.delegationId },
        { completedAt, durationMs: completedAt - start.startedAt },
        start.model
      )) {
        this.emitActivity(payload);
      }
    }
  }

  /**
   * What a `TaskWait` or `TaskStop` call is about.
   *
   * Named ids are read as given (deduplicated, capped). Without ids the two
   * tools differ on purpose: `TaskStop` can only act on what is running, while
   * `TaskWait` also covers every delegation whose report the model has not
   * received yet. A delegate that finished while the parent was busy used to
   * fall between the two — no longer running, so an id-less wait said "nothing
   * is running", and not yet delivered, so the auto-resume pass still owed it —
   * and a model that kept asking got the same non-answer forever.
   */
  private targetsFor(
    params: unknown,
    tool: 'wait' | 'stop'
  ): {
    targets: DelegationRecord[];
    ids: string[];
    unknownIds: string[];
  } {
    // subagent-core-12 — deduplicated. `delegationIds: [a, a, a]` used to build
    // three identical entries, each carrying a full report, and the persisted
    // `details` grew by a multiple of what the model actually asked about. Also
    // trimmed to `MAX_DELEGATION_IDS`, which the schema declares, so a model
    // that ignores the declared maximum is bounded rather than obeyed.
    const ids =
      isRecord(params) && Array.isArray(params.delegationIds)
        ? [...new Set(params.delegationIds.map(String))].slice(0, MAX_DELEGATION_IDS)
        : [];
    const targets = ids.length
      ? ids
          .map((id) => this.registry.get(id))
          .filter((record): record is DelegationRecord => record !== undefined)
      : tool === 'wait'
        ? this.registry
            .all()
            .filter((record) => record.status === 'running' || record.deliveredAt === undefined)
        : this.registry.running();
    return { targets, ids, unknownIds: ids.filter((id) => !this.registry.has(id)) };
  }

  /**
   * Whether a control call has anything to act on, and whether it is refused.
   *
   * Idle means nothing is running and nothing is waiting to be delivered: the
   * call cannot produce anything the model has not already been given. The
   * first idle call of a run gets its full answer plus {@link terminalNote};
   * every later one is refused with that same note, because the answer has not
   * changed and a model that asks again is looping (the agent loop ends the run
   * if whole replies keep doing it). A `TaskWait` that names ids is a re-read,
   * which is legitimate the first time for a given set — after a compaction the
   * model may genuinely need a report back.
   */
  private idleVerdict(rereadKey?: string): { idle: boolean; refuse: boolean } {
    if (this.registry.running().length > 0 || this.registry.undelivered().length > 0)
      return { idle: false, refuse: false };
    if (rereadKey !== undefined && !this.rereads.has(rereadKey)) {
      this.rereads.add(rereadKey);
      return { idle: false, refuse: false };
    }
    this.idleCalls += 1;
    // AICLIENT_RUNTIME_LOOP_GUARD off (`this.config.loopGuardEnabled ??
    // true`): still classified `idle` — the labelling in `TaskList`/`TaskWait`
    // and the terminal note are fixes, not protection — but never refused.
    const loopGuardEnabled = this.config.loopGuardEnabled ?? true;
    return { idle: true, refuse: loopGuardEnabled && this.idleCalls > 1 };
  }

  /** How a settled delegation ended, for a model-facing line. */
  private endedAs(record: DelegationRecord): string {
    return record.result?.error?.code === DELEGATION_INTERRUPTED
      ? 'interrupted, no report'
      : record.status;
  }

  /**
   * The terminal instruction: nothing is left, and what to do instead.
   *
   * Written as a statement of fact with the ids in it, and without the word
   * "matching" or any suggestion to retry with other arguments — the old
   * one-liners ("No matching running subagents to stop.") read as "try a
   * different call", and a model did, thousands of times.
   */
  private terminalNote(): string {
    const records = this.registry.all();
    if (records.length === 0) {
      return "No subagents have been started in this session, so there is nothing to wait for, stop or list. Do not call TaskWait, TaskStop or TaskList again for this; continue the user's task or answer the user.";
    }
    const shown = records
      .slice(-MAX_TERMINAL_NOTE_IDS)
      .map((record) => `${record.delegationId} (${record.agentName}, ${this.endedAs(record)})`);
    const earlier = records.length - shown.length;
    const state =
      records.length === 1
        ? 'the one delegation in this session has ended and its report has been delivered to you'
        : `all ${records.length} delegations in this session have ended and every report has been delivered to you`;
    return `Nothing is left to wait for: ${state} — ${shown.join('; ')}${earlier > 0 ? `; and ${earlier} earlier` : ''}. Do not call TaskWait, TaskStop or TaskList for them again; continue the user's task or answer the user.`;
  }

  /** A second idle call's answer; see {@link idleVerdict}. */
  private refuseIdle(tool: string, details: Record<string, unknown>) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Refused: ${tool} has nothing left to act on, and this run has already said so. ${this.terminalNote()}`,
        },
      ],
      details: { ...details, idle: true, refused: true },
    };
  }

  /** The session's delegations by id, for a call that named ids nobody knows. */
  private knownIdsNote(): string {
    const records = this.registry.all();
    if (records.length === 0) return ' No subagents have been started in this session.';
    const shown = records
      .slice(-MAX_TERMINAL_NOTE_IDS)
      .map((record) => `${record.delegationId} (${record.agentName}, ${this.endedAs(record)})`);
    return ` Delegations in this session: ${shown.join('; ')}.`;
  }

  private buildWaitTool(): AgentTool<TSchema, unknown> {
    return {
      name: SUBAGENT_WAIT_TOOL_NAME,
      label: 'Task Wait',
      description:
        'Wait for subagents started by Task and return their reports. Without `delegationIds` it covers every subagent that is still running or whose report you have not received yet; when there is neither it returns at once and says so. Use mode "any" with `minCompleted` to return as soon as the first (or first N) finish. Settled delegations return immediately, so re-reading a report by id is cheap. A wait timeout is not a failure: unfinished delegates keep working and the runtime delivers their reports when they finish.',
      parameters: Type.Object(
        {
          delegationIds: Type.Optional(
            Type.Array(Type.String({ description: 'Delegation ids returned by Task.' }), {
              description: `Defaults to every subagent still running or not yet reported to you. At most ${MAX_DELEGATION_IDS}.`,
              maxItems: MAX_DELEGATION_IDS,
            })
          ),
          mode: Type.Optional(
            Type.Union([Type.Literal('all'), Type.Literal('any')], {
              description: 'Wait for every target (all) or the first to finish (any).',
            })
          ),
          minCompleted: Type.Optional(
            Type.Number({
              minimum: 1,
              description: 'With mode "any": wait until at least this many finished.',
            })
          ),
          timeoutSeconds: Type.Optional(
            Type.Number({
              minimum: 1,
              maximum: TASKWAIT_MAX_TIMEOUT_SECONDS,
              description: `Max seconds to wait; defaults to ${TASKWAIT_DEFAULT_TIMEOUT_SECONDS}.`,
            })
          ),
        },
        { additionalProperties: false }
      ),
      executionMode: 'sequential',
      execute: async (_toolCallId, params, signal) => {
        const { targets, ids, unknownIds } = this.targetsFor(params, 'wait');
        const verdict = this.idleVerdict(
          ids.length > 0 && unknownIds.length === 0
            ? `wait:${[...ids].sort().join(',')}`
            : undefined
        );
        if (verdict.refuse)
          return this.refuseIdle(SUBAGENT_WAIT_TOOL_NAME, { status: 'refused', delegations: [] });
        const idle = verdict.idle ? { idle: true } : {};
        const mode = isRecord(params) && params.mode === 'any' ? 'any' : 'all';
        const minCompleted =
          isRecord(params) && typeof params.minCompleted === 'number'
            ? Math.max(1, Math.floor(params.minCompleted))
            : 1;
        const timeoutSeconds =
          isRecord(params) && typeof params.timeoutSeconds === 'number'
            ? Math.min(Math.max(1, Math.floor(params.timeoutSeconds)), TASKWAIT_MAX_TIMEOUT_SECONDS)
            : TASKWAIT_DEFAULT_TIMEOUT_SECONDS;

        if (targets.length === 0) {
          const text = ids.length
            ? `None of the requested delegation ids exist in this session.${this.knownIdsNote()}`
            : 'No subagent is running and no report is waiting to be delivered.';
          return {
            content: [
              {
                type: 'text' as const,
                text: verdict.idle ? `${text} ${this.terminalNote()}` : text,
              },
            ],
            details: { delegations: [], ...idle },
          };
        }
        const targetCompleted =
          mode === 'all' ? targets.length : Math.min(Math.max(minCompleted, 1), targets.length);
        const interrupt = this.runContext?.interrupt;
        const timedOut = await waitForDelegations(
          targets,
          targetCompleted,
          Date.now() + timeoutSeconds * 1000,
          interrupt ? (signal ? AbortSignal.any([signal, interrupt]) : interrupt) : signal
        );
        // Ended by the user's new message rather than by a Stop or the clock.
        const interrupted = interrupt?.aborted === true && signal?.aborted !== true;
        const now = Date.now();
        // Whatever settled is being put in front of the model right here, so
        // the auto-resume pass must not hand it over a second time. The ones
        // still running are returned as a heartbeat, which is not a report.
        this.registry.markDelivered(
          targets.filter((record) => record.status !== 'running'),
          now
        );
        const results = targets.map((record) => ({
          delegationId: record.delegationId,
          agent: record.agentName,
          status: record.status,
          startedAt: record.startedAt,
          ...(record.completedAt ? { completedAt: record.completedAt } : {}),
          ...(record.result?.error ? { error: record.result.error } : {}),
          report:
            record.status === 'running'
              ? formatDelegationHeartbeat(record, now)
              : (record.result?.report ?? `(${record.status} without a report)`),
        }));
        const finished = results.filter((entry) => entry.status !== 'running').length;
        const stillRunning = targets
          .filter((record) => record.status === 'running')
          .map((record) => formatDelegationHeartbeat(record, now))
          .join('\n');
        const note = interrupted
          ? `Stopped waiting early because the user sent a new message: ${finished}/${targets.length} finished. Unfinished delegates keep working and the runtime will deliver their reports when they finish.${stillRunning ? `\n${stillRunning}` : ''}`
          : timedOut
            ? `Still running after ${timeoutSeconds}s: ${finished}/${targets.length} finished. This is not a failure: unfinished delegates keep working, and the runtime delivers each report to you when it finishes, whether or not you wait again.\n${stillRunning}`
            : mode === 'any'
              ? `Converged after ${finished} of ${targets.length} finished.`
              : undefined;
        const unknownNote = unknownIds.length
          ? `Unknown delegation ids (not found in this session): ${unknownIds.join(', ')}.`
          : undefined;
        const body = formatDelegationResults(
          results,
          [note, unknownNote].filter(Boolean).join('\n') || undefined
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: verdict.idle ? `${body}\n\n${this.terminalNote()}` : body,
            },
          ],
          details: {
            status: timedOut ? 'timeout' : 'completed',
            ...(unknownIds.length ? { unknownIds } : {}),
            ...idle,
            // subagent-core-12 — `details` is written into the session JSONL
            // verbatim by pi and is NOT model context, so it gets its own,
            // tighter budget than the text above. The full report lives on the
            // `settled` record; repeating it here at 12k a piece was how a
            // ten-way wait put ~120 KB in one entry.
            delegations: results.map((entry) => ({
              ...entry,
              report: clampSubagentText(entry.report, MAX_TASKWAIT_DETAIL_REPORT_CHARS),
            })),
          },
        };
      },
    };
  }

  /** One `TaskList` line's second half: where this delegation's report stands. */
  private reportState(record: DelegationRecord): string {
    if (record.status === 'running')
      return 'still running; its report is delivered when it finishes';
    if (record.result?.error?.code === DELEGATION_INTERRUPTED)
      return 'interrupted before it finished; no report exists';
    if (record.deliveredAt !== undefined) return 'report already delivered to you';
    return 'report NOT yet delivered: call TaskWait with this id to read it';
  }

  private buildListTool(): AgentTool<TSchema, unknown> {
    return {
      name: SUBAGENT_LIST_TOOL_NAME,
      label: 'Task List',
      description:
        "List the subagents started by Task in this session, with each one's status and whether its report has been delivered to you. It never waits and never delivers a report.",
      parameters: Type.Object({}, { additionalProperties: false }),
      executionMode: 'sequential',
      execute: async () => {
        const verdict = this.idleVerdict();
        const summaries = () =>
          this.registry.all().map((record) => ({
            ...delegationSummary(record),
            reportDelivered: record.deliveredAt !== undefined,
          }));
        if (verdict.refuse)
          return this.refuseIdle(SUBAGENT_LIST_TOOL_NAME, { delegations: summaries() });
        const now = Date.now();
        const records = this.registry.all();
        const running = this.registry.running();
        const pending = this.registry.undelivered();
        const lines = records.map(
          (record) => `- ${formatDelegationHeartbeat(record, now)} — ${this.reportState(record)}`
        );
        const footer =
          running.length > 0
            ? `${running.length} still running; each report is delivered to you when it finishes.`
            : pending.length > 0
              ? `Nothing is running. ${pending.length} finished report${pending.length === 1 ? ' has' : 's have'} not been delivered to you yet; call TaskWait with ${pending.length === 1 ? 'that id' : 'those ids'} (${pending.map((record) => record.delegationId).join(', ')}) to read ${pending.length === 1 ? 'it' : 'them'}.`
              : this.terminalNote();
        const text = records.length ? [...lines, '', footer].join('\n') : footer;
        return {
          content: [{ type: 'text' as const, text }],
          details: { delegations: summaries(), ...(verdict.idle ? { idle: true } : {}) },
        };
      },
    };
  }

  private buildStopTool(): AgentTool<TSchema, unknown> {
    return {
      name: SUBAGENT_STOP_TOOL_NAME,
      label: 'Task Stop',
      description:
        "Stop running subagents whose work you no longer need. Without `delegationIds` it stops every running one. Each stopped subagent's partial output comes back in the result, together with any finished report you have not received yet.",
      parameters: Type.Object(
        {
          delegationIds: Type.Optional(
            Type.Array(Type.String({ description: 'Delegation ids returned by Task.' }), {
              description: `Defaults to every running subagent. At most ${MAX_DELEGATION_IDS}.`,
              maxItems: MAX_DELEGATION_IDS,
            })
          ),
        },
        { additionalProperties: false }
      ),
      executionMode: 'sequential',
      execute: async (_toolCallId, params, signal) => {
        const { targets, ids, unknownIds } = this.targetsFor(params, 'stop');
        const verdict = this.idleVerdict();
        if (verdict.refuse)
          return this.refuseIdle(SUBAGENT_STOP_TOOL_NAME, { stopped: [], delivered: [] });
        // Only what is still running can be stopped. A named id that had
        // already settled is not a stop at all, and the distinction is the
        // whole point of the split below.
        const running = targets.filter((record) => record.status === 'running');
        for (const record of running) this.registry.requestStop(record);
        // Awaited on purpose — the P5-2-0 probe measured that aborting an
        // in-flight tool costs one more provider request before the loop
        // closes, so returning at once would report "stopped" while the
        // delegate was still spending — but BOUNDED, and cut by this call's own
        // cancellation (Stop, or the user's Ctrl+Enter). Unbounded, one wedged
        // delegate made the parent's turn unable to end at all.
        const interrupt = this.runContext?.interrupt;
        const cancel = interrupt
          ? signal
            ? AbortSignal.any([signal, interrupt])
            : interrupt
          : signal;
        const timeoutMs = this.config.stopTimeoutMs ?? STOP_TIMEOUT_MS;
        const endedEarly = running.length
          ? await waitForDelegations(running, running.length, Date.now() + timeoutMs, cancel)
          : false;
        if (endedEarly && cancel?.aborted !== true) this.settleStragglers(running, timeoutMs);
        const stopped = running.filter(
          (record) =>
            record.status === 'stopped' ||
            record.status === 'aborted' ||
            record.status === 'timed_out'
        );
        // Cancelled mid-wait: asked to stop, not yet closed. Their output is
        // delivered later, by whatever path sees them settle.
        const closing = running.filter((record) => record.status === 'running');
        // Everything else settled on its own — while this call was waiting, or
        // before it (a named id). Its report is real work the parent has not
        // read, and the reason for stopping does not apply to it.
        const finishedMeanwhile = running.filter(
          (record) => record.status !== 'running' && !stopped.includes(record)
        );
        const finishedBefore = targets.filter((record) => !running.includes(record));
        const finished = [...finishedMeanwhile, ...finishedBefore];
        // An id-less stop also hands over every other report still owed: the
        // model is ending its delegations, and a report left behind would
        // otherwise only surface after it had moved on.
        const pending = ids.length
          ? []
          : this.registry
              .undelivered()
              .filter((record) => !stopped.includes(record) && !finished.includes(record));
        const shown = [...stopped, ...finished, ...pending];
        const results = shown.map((record) => ({
          delegationId: record.delegationId,
          agent: record.agentName,
          status: record.status,
          report: record.result?.report ?? `(${record.status} without a report)`,
        }));
        // Delivered because every one of them is in front of the model right
        // now, report and all — a stopped delegate's partial output included,
        // which used to be counted as delivered without ever being shown.
        this.registry.markDelivered(shown);
        const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);
        const head = [
          running.length === 0
            ? ids.length
              ? 'None of the delegations you named was still running, so nothing was stopped.'
              : 'No subagent was running, so nothing was stopped.'
            : `Stopped ${stopped.length} subagent${plural(stopped.length, '', 's')}.`,
          finishedMeanwhile.length
            ? `${finishedMeanwhile.length} finished on ${plural(finishedMeanwhile.length, 'its', 'their')} own before the stop landed.`
            : '',
          finishedBefore.length
            ? `${finishedBefore.length} of the delegation${plural(finishedBefore.length, '', 's')} you named had already finished.`
            : '',
          pending.length
            ? `${pending.length} finished report${plural(pending.length, ' was', 's were')} still waiting to be delivered to you.`
            : '',
          closing.length
            ? `${closing.length} more ${plural(closing.length, 'was', 'were')} asked to stop and ${plural(closing.length, 'is', 'are')} still closing; ${plural(closing.length, 'its', 'their')} output will be delivered when ${plural(closing.length, 'it settles', 'they settle')}:\n${closing.map((record) => formatDelegationHeartbeat(record, Date.now())).join('\n')}`
            : '',
          unknownIds.length
            ? `Unknown delegation ids (not found in this session): ${unknownIds.join(', ')}.`
            : '',
        ]
          .filter(Boolean)
          .join(' ');
        const body = results.length
          ? [
              head,
              formatDelegationResults(
                results,
                `${plural(results.length, 'Its report follows', 'Their reports follow')}; nothing else will deliver ${plural(results.length, 'it', 'them')}.`
              ),
            ].join('\n\n')
          : head;
        return {
          content: [
            {
              type: 'text' as const,
              text: verdict.idle ? `${body}\n\n${this.terminalNote()}` : body,
            },
          ],
          details: {
            stopped: stopped.map(delegationSummary),
            ...(finished.length ? { alreadyFinished: finished.map(delegationSummary) } : {}),
            ...(closing.length ? { stillClosing: closing.map(delegationSummary) } : {}),
            // What this result put in front of the model, by id: the fact a
            // reopened session reads its delivery state back from.
            delivered: shown.map((record) => record.delegationId),
            ...(verdict.idle ? { idle: true } : {}),
          },
        };
      },
    };
  }
}

export { MAX_SUBAGENT_CONCURRENCY };
export type { SubagentEventEnvelope } from './run.ts';
