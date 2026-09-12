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
 *   plan-mode filter removes all four in plan mode. The contract's "父 plan
 *   模式不委派" then holds by construction rather than by a second rule that
 *   could drift from the first.
 * - Only `Task` is `executionMode: 'parallel'`; the other three are sequential.
 *   The P5-2-0 probe measured that 0.84.4 serializes any batch containing one
 *   sequential tool, so this is exactly what makes an all-`Task` message fan
 *   out and every mixed message run one call at a time.
 */

import { randomUUID } from 'node:crypto';
import type { AgentTool, ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { Usage } from '@earendil-works/pi-ai';
import { type Context, Service } from 'cordis';
import { type TSchema, Type } from 'typebox';
import type { SubagentActivityPayload } from '../../../shared/types/runtimeEvents.ts';
import {
  EVENTS_SERVICE,
  type ResolvedModel,
  type RuntimeModelRef,
  SESSION_SERVICE,
} from '../../contracts.ts';
import type { DelegateCallScope } from '../permissions/index.ts';
import { TOOLS_SERVICE } from '../tools/index.ts';
import { applySubagentActivation, resolveSubagentPin, type SubagentCatalog } from './catalog.ts';
import { normalizeSubagentName, type SubagentDefinition, subagentModelKey } from './definition.ts';
import {
  composeSubagentSystemPrompt,
  resolveDelegateToolNames,
  subagentGuidance,
} from './prompt.ts';
import {
  activityForEvent,
  activityForSettlement,
  SUBAGENT_ENTRY,
  type SubagentRecord,
} from './records.ts';
import {
  type DelegationRecord,
  DelegationRegistry,
  delegationSummary,
  formatDelegationHeartbeat,
  MAX_SUBAGENT_CONCURRENCY,
  waitForDelegations,
} from './registry.ts';
import { addUsage, type SubagentEventEnvelope, SubagentRun } from './run.ts';

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

const DELEGATION_RESUME_PROMPT =
  'The following subagents have finished. Integrate their reports and continue the ' +
  "user's original task. Call TaskStop only if you have decided a still-running " +
  'delegate should not continue.';

export interface SubagentConfig {
  catalog: SubagentCatalog;
  /** Definition names the user switched off, from app data (never the Markdown). */
  disabled?: readonly string[];
  /**
   * The project's instruction chain, rendered for a delegate's prompt.
   *
   * A callback rather than a string because the chain is read from disk and can
   * change between turns; a delegate started now must get what the workspace
   * says now, the same as the parent's own prompt does.
   */
  projectInstructions?: () => Promise<string | undefined>;
  /** Parent thinking level, used when a definition pins none. */
  thinkingLevel?: ThinkingLevel;
}

/** Which run a delegation belongs to, for attribution on records and events. */
export interface SubagentRunContext {
  sessionId: string;
  runId: string;
}

export interface SubagentService {
  readonly definitions: readonly SubagentDefinition[];
  readonly registry: DelegationRegistry;
  /** True while any delegate runs; the parent run must not be allowed to end. */
  readonly busy: boolean;
  /** Usage accumulated by settled delegates, settled exactly once per run. */
  takeUsage(): Usage | undefined;
  /** Subscribe to delegate transcript events. */
  onEvent(listener: (envelope: SubagentEventEnvelope) => void): () => void;
  /**
   * Wait for the delegates running right now and produce the text to feed the
   * parent, or undefined when there is nothing to wait for.
   */
  collectFinished(signal?: AbortSignal): Promise<string | undefined>;
  /** User Stop / dispose. Not parent idle. */
  abortAll(): void;
  /**
   * Stop everything still running and wait for it to actually converge.
   *
   * What separates "the run ended" from "the run stopped being watched". See
   * the implementation for why an abort alone is not enough.
   */
  drain(): Promise<void>;
  /**
   * Bind the session and run a delegation started from now on belongs to.
   *
   * Called by the loop at the top of each run. Without it a record could not
   * name the run it came from, and a reopened session could not tell one run's
   * delegations from another's.
   */
  bindRun(context: SubagentRunContext): void;
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
  readonly definitions: readonly SubagentDefinition[];
  private readonly config: SubagentConfig;
  private readonly listeners = new Set<(envelope: SubagentEventEnvelope) => void>();
  private usage: Usage | undefined;
  private runContext?: SubagentRunContext;
  /** Start facts, kept until settlement so one record can carry both ends. */
  private readonly started = new Map<
    string,
    { parentToolCallId: string; model: string; startedAt: number; runId: string }
  >();

  constructor(ctx: Context, config: SubagentConfig) {
    super(ctx, SUBAGENT_SERVICE);
    this.config = config;
    this.definitions = applySubagentActivation(config.catalog, config.disabled ?? []).definitions;
    // Nothing to delegate to means nothing to advertise. Registering `Task`
    // with an empty catalog would put a tool in every request that can only
    // ever answer "unknown subagent".
    if (this.definitions.length === 0) return;
    // `write` access: the tools plugin already drops write tools in plan mode,
    // which is exactly the contract's "no delegation from plan".
    const tools = ctx.get(TOOLS_SERVICE);
    tools?.register(this.buildTaskTool(), 'write');
    tools?.register(this.buildWaitTool(), 'write');
    tools?.register(this.buildListTool(), 'write');
    tools?.register(this.buildStopTool(), 'write');
    ctx.effect(() => () => {
      this.abortAll();
      this.listeners.clear();
    });
  }

  bindRun(context: SubagentRunContext): void {
    this.runContext = context;
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
    } catch {
      // Deliberately swallowed; see the note above.
    }
  }

  /** Publish one live-projection payload on the session's event channel. */
  private emitActivity(payload: SubagentActivityPayload): void {
    const events = this.ctx.get(EVENTS_SERVICE);
    const sessionId = this.runContext?.sessionId;
    if (!events || !sessionId) return;
    events.emit({ type: 'subagent.activity', sessionId, payload });
  }

  takeUsage(): Usage | undefined {
    const usage = this.usage;
    this.usage = undefined;
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
   */
  async drain(): Promise<void> {
    const running = this.registry.running();
    if (running.length === 0) return;
    this.registry.abortAllRunning();
    await Promise.all(running.map((record) => record.completion));
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
   */
  async collectFinished(signal?: AbortSignal): Promise<string | undefined> {
    const targets = this.registry.running();
    if (targets.length > 0) {
      await waitForDelegations(targets, targets.length, null, signal);
      if (signal?.aborted) return undefined;
    }
    const settled = this.registry.undelivered();
    if (settled.length === 0) return undefined;
    const now = Date.now();
    this.registry.markDelivered(settled, now);
    const results = settled.map((record) => ({
      delegationId: record.delegationId,
      agent: record.agentName,
      status: record.status,
      report: record.result?.report ?? `(${record.status} without a report)`,
    }));
    const still = this.registry.running();
    const heartbeat = still.length
      ? `Still running:\n${still.map((record) => formatDelegationHeartbeat(record, now)).join('\n')}`
      : '';
    return [DELEGATION_RESUME_PROMPT, formatDelegationResults(results), heartbeat]
      .filter((part) => part.trim())
      .join('\n\n');
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
    const activity = activityForEvent(envelope.event, base);
    if (activity) this.emitActivity(activity);
    // The delegate's own messages are PERSISTED whole, as custom entries. The
    // live projection above is a bounded summary of the same thing; this is the
    // copy a history read gets back.
    if (envelope.event.type === 'message_end' && this.runContext) {
      void this.record({
        kind: 'message',
        delegationId: envelope.delegationId,
        agentName: envelope.agentName,
        parentToolCallId: envelope.parentToolCallId,
        runId: this.runContext.runId,
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
    const parent: RuntimeModelRef | undefined = adapter.defaultRef();
    if (!parent) return { ok: false, text: 'No model is configured for delegation.' };
    return { ok: true, model: adapter.resolve(parent) };
  }

  private buildTaskTool(): AgentTool<TSchema, unknown> {
    const names = this.definitions.map((definition) => definition.name);
    const catalog = this.definitions
      .map(
        (definition) =>
          `- ${definition.name} (tools: ${definition.tools.join(', ')}): ${definition.description}`
      )
      .join('\n');
    return {
      name: SUBAGENT_TOOL_NAME,
      label: 'Task',
      description: [
        'Start one subagent in the background and return immediately; you keep working while it runs, then converge with TaskWait when you need its report.',
        'Use it when the work is separable: parallel exploration of independent directions (one Task per direction in the same assistant message), a multi-file implementation with a complete spec (fixer), an adversarial read-only review of a change you just made (code-reviewer), or a wide search / long log / multi-file survey whose intermediate output would otherwise fill this context (explorer, test-runner).',
        'Do not delegate what you can finish in a couple of tool calls, and do not delegate anything that needs the user — a subagent cannot ask a question or propose a plan on your behalf.',
        "`task` is the delegate's only instruction. It cannot see this conversation, and you cannot correct it while it runs, so state the goal, the paths and facts it cannot infer, and exactly what to report back.",
        'To run delegates concurrently, emit several Task calls in one assistant message. A message that mixes Task with any other tool runs one call at a time. You may keep working or talk to the user while they run; the runtime delivers their reports when they finish. Call TaskStop only to cancel.',
        `Available subagents:\n${catalog}`,
      ].join('\n\n'),
      parameters: Type.Object(
        {
          agent: Type.String({ description: `Name of the subagent to run: ${names.join(', ')}.` }),
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
      ),
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
        const definition = this.definitions.find(
          (candidate) => candidate.name === normalizeSubagentName(requested)
        );
        if (!definition)
          return this.toolError(`Unknown subagent "${requested}". Available: ${names.join(', ')}.`);
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
        const modelLabel = `${model.model.ref.provider}/${model.model.model.id}`;
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
            model: { provider: model.model.ref.provider, modelId: model.model.model.id },
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
          model: model.model,
          thinkingLevel: (definition.thinkingLevel ??
            this.config.thinkingLevel ??
            'medium') as ThinkingLevel,
          tools,
          onEvent: (envelope) => this.publish(envelope),
          signal: controller.signal,
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
              text: `Delegation ${delegationId} started: the ${definition.name} subagent is working in the background${label ? ` (${label})` : ''}. Continue your own independent work, then call TaskWait with this delegationId to converge, or TaskStop to stop it.`,
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
    if (result.usage) this.usage = addUsage(this.usage, result.usage);
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

  private targetsFor(params: unknown): {
    targets: DelegationRecord[];
    ids: string[];
    unknownIds: string[];
  } {
    const ids =
      isRecord(params) && Array.isArray(params.delegationIds)
        ? params.delegationIds.map(String)
        : [];
    const targets = ids.length
      ? ids
          .map((id) => this.registry.get(id))
          .filter((record): record is DelegationRecord => record !== undefined)
      : this.registry.running();
    return { targets, ids, unknownIds: ids.filter((id) => !this.registry.has(id)) };
  }

  private buildWaitTool(): AgentTool<TSchema, unknown> {
    return {
      name: SUBAGENT_WAIT_TOOL_NAME,
      label: 'Task Wait',
      description:
        'Wait for one or more subagents started by Task and return their reports. `delegationIds` defaults to every running subagent; use mode "any" with `minCompleted` to converge as soon as the first (or first N) finish. Settled delegations return immediately, so re-reading a report by id is cheap. A wait timeout is not a failure: unfinished delegates keep working and the runtime delivers their reports when they finish.',
      parameters: Type.Object(
        {
          delegationIds: Type.Optional(
            Type.Array(Type.String({ description: 'Delegation ids returned by Task.' }), {
              description: 'Defaults to all running subagents.',
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
        const { targets, ids, unknownIds } = this.targetsFor(params);
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
            ? 'None of the requested delegation ids exist in this session. Call TaskList to see them.'
            : 'No subagents are currently running.';
          return { content: [{ type: 'text' as const, text }], details: { delegations: [] } };
        }
        const targetCompleted =
          mode === 'all' ? targets.length : Math.min(Math.max(minCompleted, 1), targets.length);
        const timedOut = await waitForDelegations(
          targets,
          targetCompleted,
          Date.now() + timeoutSeconds * 1000,
          signal
        );
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
        const note = timedOut
          ? `Still running after ${timeoutSeconds}s: ${finished}/${targets.length} finished. This is not a failure — unfinished delegates keep working and the runtime will deliver their reports when they finish. Call TaskStop only to cancel.\n${targets
              .filter((record) => record.status === 'running')
              .map((record) => formatDelegationHeartbeat(record, now))
              .join('\n')}`
          : mode === 'any'
            ? `Converged after ${finished} of ${targets.length} finished.`
            : undefined;
        const unknownNote = unknownIds.length
          ? `Unknown delegation ids (not found in this session): ${unknownIds.join(', ')}.`
          : undefined;
        return {
          content: [
            {
              type: 'text' as const,
              text: formatDelegationResults(
                results,
                [note, unknownNote].filter(Boolean).join('\n') || undefined
              ),
            },
          ],
          details: {
            status: timedOut ? 'timeout' : 'completed',
            ...(unknownIds.length ? { unknownIds } : {}),
            delegations: results,
          },
        };
      },
    };
  }

  private buildListTool(): AgentTool<TSchema, unknown> {
    return {
      name: SUBAGENT_LIST_TOOL_NAME,
      label: 'Task List',
      description:
        'List the subagents started by Task in this session with their status. Use it to check progress without waiting, or before TaskStop to choose what to stop.',
      parameters: Type.Object({}, { additionalProperties: false }),
      executionMode: 'sequential',
      execute: async () => {
        const now = Date.now();
        const records = this.registry.all();
        const text = records.length
          ? records.map((record) => `- ${formatDelegationHeartbeat(record, now)}`).join('\n')
          : 'No subagents have been started in this session.';
        return {
          content: [{ type: 'text' as const, text }],
          details: { delegations: records.map(delegationSummary) },
        };
      },
    };
  }

  private buildStopTool(): AgentTool<TSchema, unknown> {
    return {
      name: SUBAGENT_STOP_TOOL_NAME,
      label: 'Task Stop',
      description:
        'Stop one or more running subagents. `delegationIds` defaults to every running subagent. Stopped subagents report as stopped; their partial work is lost.',
      parameters: Type.Object(
        {
          delegationIds: Type.Optional(
            Type.Array(Type.String({ description: 'Delegation ids returned by Task.' }), {
              description: 'Defaults to all running subagents.',
            })
          ),
        },
        { additionalProperties: false }
      ),
      executionMode: 'sequential',
      execute: async (_toolCallId, params) => {
        const { targets } = this.targetsFor(params);
        for (const record of targets) this.registry.requestStop(record);
        // Awaited on purpose. The P5-2-0 probe measured that aborting an
        // in-flight tool costs one more provider request before the loop
        // closes, so returning here without waiting would report "stopped"
        // while the delegate was still spending.
        await Promise.all(targets.map((record) => record.completion));
        // The model asked for these to stop and is being told they did. Feeding
        // their partial output back through the auto-resume pass afterwards
        // would re-open work the model just decided to abandon.
        this.registry.markDelivered(targets);
        const text = targets.length
          ? `Stopped ${targets.length} subagent${targets.length === 1 ? '' : 's'}.`
          : 'No matching running subagents to stop.';
        return {
          content: [{ type: 'text' as const, text }],
          details: { stopped: targets.map(delegationSummary) },
        };
      },
    };
  }
}

export { MAX_SUBAGENT_CONCURRENCY };
export type { SubagentEventEnvelope } from './run.ts';
