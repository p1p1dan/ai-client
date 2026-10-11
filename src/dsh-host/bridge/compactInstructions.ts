/**
 * The summary hook of DSH's compaction service, wrapped once per instance:
 * `/compact <instructions>` (dsh-rebase decision 179) and the reasoning effort
 * of every summary request (decision 181).
 *
 * DSH's `/compact` takes no arguments (`dsh-command-compact`), and the
 * summary request is built inside `dsh-compaction-basic`: the service's
 * `summarize(input, agent, signal)` — documented there as the one hook to
 * override, and called through the instance for every compaction
 * (`regionDependencies`) — hands the replayed conversation to
 * `summarizeWithLlm`, which puts DSH's fixed checkpoint template
 * (`COMPACTION_INSTRUCTION`) after it as one last user message and streams
 * the call through `this.ctx.llm.stream`. The conversation before the
 * template is a prefix of the session's last request, so the provider's
 * prompt cache is reused.
 *
 * So the command is left as it is, and that hook is wrapped on the service
 * instance, once per instance. Two things change on the way to the model:
 *
 *  - Decision 179: while a `worker.compact` with instructions runs for a
 *    session (`armCompactInstructions` -> lease -> `release`), that session's
 *    summary request goes out with the instructions appended to the
 *    template's text, in the same last message. Nothing before it changes.
 *    Every other summary — automatic, another session's, `/compact` alone —
 *    carries none.
 *  - Decision 181: every summary request — `/compact`, the automatic one at a
 *    step boundary and the overflow recovery alike — names a reasoning
 *    effort. DSH names none, and pi-ai then sends the model's `off` (`'none'`
 *    on an OpenAI Responses route, which a model that thinks always refuses
 *    with a 400); a thinking setting other than the conversation's also makes
 *    Anthropic's cache miss on every message. So the request takes the effort
 *    of the conversation's latest request on the same route and model
 *    (`requestHeader().config`, none included), and without one the lowest
 *    level the plan offers besides `off` (`summaryReasoningEffort`).
 *
 * Fail-safe, never silent:
 *  - before the hook is wrapped, a dry run of it (a stand-in model service
 *    that records the call and sends nothing) must end in one summary
 *    request (`purpose: 'compaction'`); otherwise the hook is left as DSH
 *    ships it — DSH's own effort, and instructions are refused before
 *    anything runs (`unsupported`), as with no compaction service or no
 *    `summarize`. A request of another message shape is wrapped for the
 *    effort, and still refuses instructions;
 *  - a real summary request of another shape is not sent with instructions:
 *    the lease is `refused` (the compaction fails, nothing is compacted) and
 *    instructions are marked unsupported, so the next request is refused up
 *    front;
 *  - a compaction that wrote its summary while its lease was never `applied`
 *    is reported by the bridge (`markUnused` marks instructions unsupported).
 *
 * No value imports from DSH: the bridge reads the service it is handed. The
 * DSH internals relied on, and what to check on a DSH upgrade, are listed in
 * decision 179 §4 and decision 181.
 */

import { isDeepStrictEqual } from 'node:util';

/** Where the installation is kept on the service instance (one per instance). */
const INSTALLATION = Symbol.for('aiclient.dsh.compactInstructions');
/** Cordis's traceable proxy hands its target out under this key. */
const CORDIS_ORIGINAL = Symbol.for('cordis.original');
/** How long the dry run may take before the hook counts as unusable. */
const PROBE_TIMEOUT_MS = 2_000;
/** The stand-in session id and model of the dry run. */
const PROBE_ID = 'aiclient-compact-instructions-probe';

/**
 * What follows DSH's template in the summary request: the user's words in a
 * fence of their own, and a rule that keeps the template's structure. English,
 * like the template it extends.
 */
export function compactInstructionsPrompt(instructions: string): string {
  return [
    'Additional instructions from the user for this checkpoint:',
    '<user-instructions>',
    instructions,
    '</user-instructions>',
    'Follow these instructions while keeping the exact structure above: every section, in order. Put what they ask you to keep or stress into the matching sections (for example Pending Jobs, or Errors and Fixes), or into Critical Context when no section fits.',
  ].join('\n');
}

export interface CompactInstructionsLease {
  readonly sessionId: string;
  readonly text: string;
  /** A summary request of this session went out carrying the instructions. */
  readonly applied: boolean;
  /** Why a summary request could not carry them; it was not sent. */
  readonly refused: string | undefined;
  /** Lifts this lease (never a later one of the session); idempotent. */
  release(): void;
  /**
   * The compaction wrote its summary and the lease was never applied: the
   * hook was not on the path. Marks it unsupported for every later request.
   */
  markUnused(): void;
}

export type CompactInstructionsArm =
  | { kind: 'armed'; lease: CompactInstructionsLease }
  | { kind: 'unsupported'; reason: string }
  /** Another lease of the session is still out. */
  | { kind: 'busy' };

interface Lease {
  readonly sessionId: string;
  readonly text: string;
  applied: boolean;
  refused: string | undefined;
}

/**
 * Decision 181: the reasoning levels the plan offers on one DSH route and
 * model, in escalation order (`DshModelRouter.efforts`); undefined when the
 * plan does not serve it.
 */
export type SummaryEffortLookup = (
  provider: string,
  model: string
) => readonly string[] | undefined;

export interface SummaryHookOptions {
  efforts?: SummaryEffortLookup;
  log?: (...args: unknown[]) => void;
}

/** Whether the hook of a compaction service is wrapped (decision 181), and why not. */
export type SummaryHookState = { kind: 'wrapped' } | { kind: 'unsupported'; reason: string };

interface Installation {
  /** Set once instructions are known not to fit the hook; never cleared. */
  unsupported: string | undefined;
  /** Why the hook was left unwrapped (no effort of ours either); never cleared. */
  unwrapped: string | undefined;
  /** The dry run and, when it passes, the wrapping. */
  readonly ready: Promise<void>;
  readonly leases: Map<string, Lease>;
  /** The plan's levels (decision 181), from the latest runtime that installed it. */
  efforts: SummaryEffortLookup | undefined;
  log: ((...args: unknown[]) => void) | undefined;
}

type Summarize = (this: unknown, input: unknown, agent: unknown, signal?: AbortSignal) => unknown;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** What a Proxy can stand in front of. */
function isObjectLike(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sessionIdOf(agent: unknown): string {
  const session = isRecord(agent) ? agent.session : undefined;
  const id = isRecord(session) ? session.id : undefined;
  return typeof id === 'string' ? id : '';
}

/** Why a model call is not a summary request at all, or undefined when it is one. */
function summaryCallProblem(options: unknown): string | undefined {
  if (!isRecord(options)) return 'the model call has no options';
  if (options.purpose !== 'compaction') {
    return `the model call is not the summary request (purpose ${String(options.purpose)})`;
  }
  return undefined;
}

/**
 * Why `options` is not the summary request this module extends — the
 * conversation it was given, unchanged, then one user message of text — or
 * undefined when it is.
 */
export function summaryRequestProblem(options: unknown, input: unknown): string | undefined {
  const call = summaryCallProblem(options);
  if (call || !isRecord(options)) return call;
  const sent = options.messages;
  const given = isRecord(input) ? input.messages : undefined;
  if (!Array.isArray(sent) || !Array.isArray(given)) return 'the summary request has no messages';
  if (sent.length !== given.length + 1) {
    return `the summary request has ${sent.length} messages, not the conversation's ${given.length} and one instruction`;
  }
  for (let index = 0; index < given.length; index += 1) {
    if (sent[index] !== given[index] && !isDeepStrictEqual(sent[index], given[index])) {
      return `message ${index} of the summary request is not the conversation's`;
    }
  }
  const last = sent[sent.length - 1];
  if (!isRecord(last) || last.role !== 'user')
    return 'the summary instruction is not a user message';
  const content = last.content;
  if (
    !Array.isArray(content) ||
    content.length === 0 ||
    !content.every(
      (block) => isRecord(block) && block.type === 'text' && typeof block.text === 'string'
    )
  ) {
    return 'the summary instruction is not text';
  }
  return undefined;
}

/** `options` with the instructions after the template's text, in its last block. */
export function withCompactInstructions(
  options: Record<string, unknown>,
  instructions: string
): Record<string, unknown> {
  const messages = options.messages as Record<string, unknown>[];
  const last = messages[messages.length - 1] as Record<string, unknown>;
  const blocks = last.content as Record<string, unknown>[];
  const tail = blocks[blocks.length - 1] as Record<string, unknown>;
  const text = `${String(tail.text)}\n\n${compactInstructionsPrompt(instructions)}`;
  return {
    ...options,
    messages: [
      ...messages.slice(0, -1),
      { ...last, content: [...blocks.slice(0, -1), { ...tail, text }] },
    ],
  };
}

/** Where a summary request goes and what it names (`GenerateOptions`), as far as read here. */
interface SummaryTarget {
  provider?: unknown;
  model?: unknown;
  reasoningEffort?: unknown;
}

/**
 * Decision 181: where a summary request's reasoning effort comes from.
 * `request`: it named one already. `conversation`: the conversation's latest
 * request on the same route and model (none, when that one named none).
 * `lowest`: the lowest level the plan offers besides `off`. `none`: nothing
 * to name — the plan offers no level, or does not serve the model.
 */
export type SummaryEffortSource = 'request' | 'conversation' | 'lowest' | 'none';

export interface SummaryEffortChoice {
  effort: string | undefined;
  source: SummaryEffortSource;
}

/**
 * Decision 181: the effort a summary request goes out with. The latest
 * request's is taken as it stands — same route and model, the level the
 * conversation's cached prefix was written with — unless the plan no longer
 * offers it. Without one (a session that never sent a request on this
 * model, an imported one, a summary routed elsewhere) the lowest level the
 * plan offers besides `off`, never `off` itself: on some routes `off` is
 * refused, and decision 141 already keeps it off the rows that cannot take it.
 */
export function summaryReasoningEffort(input: {
  request: SummaryTarget;
  latest: SummaryTarget | undefined;
  offered: readonly string[] | undefined;
}): SummaryEffortChoice {
  const { request, latest, offered } = input;
  if (typeof request.reasoningEffort === 'string') {
    return { effort: request.reasoningEffort, source: 'request' };
  }
  if (latest && latest.provider === request.provider && latest.model === request.model) {
    const effort = typeof latest.reasoningEffort === 'string' ? latest.reasoningEffort : undefined;
    if (effort === undefined || offered === undefined || offered.includes(effort)) {
      return { effort, source: 'conversation' };
    }
  }
  const lowest = offered?.find((level) => level !== 'off');
  return lowest ? { effort: lowest, source: 'lowest' } : { effort: undefined, source: 'none' };
}

/** The config of the conversation's latest request (`requestHeader().config`), if any. */
function latestRequestConfig(agent: unknown): SummaryTarget | undefined {
  const session = isRecord(agent) ? agent.session : undefined;
  const read = isRecord(session) ? session.requestHeader : undefined;
  if (typeof read !== 'function') return undefined;
  try {
    const header: unknown = read.call(session);
    const config = isRecord(header) ? header.config : undefined;
    return isRecord(config) ? config : undefined;
  } catch {
    return undefined;
  }
}

/** Decision 181: `options` naming the effort `summaryReasoningEffort` chose; logged. */
function withSummaryEffort(options: unknown, agent: unknown, installation: Installation): unknown {
  if (summaryCallProblem(options) || !isRecord(options)) return options;
  const { provider, model } = options;
  if (typeof provider !== 'string' || typeof model !== 'string') return options;
  const choice = summaryReasoningEffort({
    request: options,
    latest: latestRequestConfig(agent),
    offered: installation.efforts?.(provider, model),
  });
  installation.log?.(
    `[dsh-bridge] summary request of ${sessionIdOf(agent) || 'a session'} on ${provider}/${model}: reasoning effort ${choice.effort ?? 'none'} (${choice.source})`
  );
  return choice.source === 'request' || choice.effort === undefined
    ? options
    : { ...options, reasoningEffort: choice.effort };
}

/** What the dry run found: why the hook cannot be wrapped, or why instructions do not fit it. */
interface DryRunVerdict {
  hook?: string;
  shape?: string;
}

/**
 * The hook run on a stand-in: a model service that records the call and
 * throws, an agent routed to a stand-in model. Nothing is sent, nothing of the
 * instance is changed. `hook`: it made no single summary request, so it is
 * left as it is. `shape`: the request is not of the shape instructions are
 * added to. Empty when the hook made one summary request of the expected shape.
 */
async function dryRun(summarize: Summarize, instance: object): Promise<DryRunVerdict> {
  const input = { messages: [{ role: 'user', content: [{ type: 'text', text: PROBE_ID }] }] };
  const stop = new Error(PROBE_ID);
  let calls = 0;
  let request: unknown;
  const self = Object.create(instance, {
    ctx: {
      value: {
        llm: {
          stream(options: unknown) {
            calls += 1;
            request = options;
            throw stop;
          },
        },
      },
    },
  }) as object;
  const agent = {
    id: PROBE_ID,
    options: {},
    session: {
      id: PROBE_ID,
      requestHeader: () => ({ config: { provider: PROBE_ID, model: PROBE_ID } }),
      toolHistory: () => [],
    },
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), PROBE_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    const outcome = await Promise.race([
      Promise.resolve()
        .then(() => summarize.call(self, input, agent, undefined))
        .then(
          () => 'returned' as const,
          (error: unknown) => (error === stop ? ('asked' as const) : error)
        ),
      timeout,
    ]);
    if (outcome === 'timeout') return { hook: 'the summary hook did not answer its dry run' };
    if (outcome === 'returned') {
      return { hook: 'the summary hook finished without asking the model' };
    }
    if (outcome !== 'asked') {
      return { hook: `the summary hook failed before asking the model: ${messageOf(outcome)}` };
    }
  } finally {
    clearTimeout(timer);
  }
  if (calls !== 1) return { hook: `the summary hook asked the model ${calls} times` };
  const call = summaryCallProblem(request);
  if (call) return { hook: call };
  const shape = summaryRequestProblem(request, input);
  return shape ? { shape } : {};
}

/**
 * The hook for one installation: every summary request names an effort
 * (decision 181), and a session with a lease out has its request extended
 * (decision 179); anything else the hook asks the model is its own, as it was.
 */
function wrapped(original: Summarize, installation: Installation): Summarize {
  return function summarize(this: unknown, input, agent, signal) {
    const lease = installation.leases.get(sessionIdOf(agent));
    const refuse = (problem: string): never => {
      if (lease) lease.refused = problem;
      installation.unsupported ??= problem;
      throw new Error(`instructions for /compact cannot be added: ${problem}`);
    };
    const self = this as { ctx?: unknown };
    const ctx = self.ctx;
    const llm = isObjectLike(ctx) ? (ctx as { llm?: unknown }).llm : undefined;
    if (!isObjectLike(llm) || typeof (llm as { stream?: unknown }).stream !== 'function') {
      if (lease) return refuse('the compaction service reaches no model service');
      return original.call(this, input, agent, signal);
    }
    const stream = (options: unknown): unknown => {
      let sent = options;
      if (lease) {
        const problem = summaryRequestProblem(options, input);
        if (problem) return refuse(problem);
        sent = withCompactInstructions(options as Record<string, unknown>, lease.text);
      }
      sent = withSummaryEffort(sent, agent, installation);
      if (lease) lease.applied = true;
      return (llm as { stream(options: unknown): unknown }).stream(sent);
    };
    const llmView = new Proxy(llm as object, {
      get: (target, key) => (key === 'stream' ? stream : Reflect.get(target, key)),
    });
    const ctxView = new Proxy(ctx as object, {
      get: (target, key) => (key === 'llm' ? llmView : Reflect.get(target, key)),
    });
    return original.call(Object.create(self, { ctx: { value: ctxView } }), input, agent, signal);
  };
}

function installationOf(service: unknown, options: SummaryHookOptions = {}): Installation | string {
  if (!isObjectLike(service)) return 'this host has no compaction service';
  const instance = ((service as Record<symbol, unknown>)[CORDIS_ORIGINAL] ?? service) as Record<
    PropertyKey,
    unknown
  >;
  const existing = instance[INSTALLATION] as Installation | undefined;
  if (existing) {
    existing.efforts = options.efforts ?? existing.efforts;
    existing.log = options.log ?? existing.log;
    return existing;
  }
  const original = instance.summarize;
  if (typeof original !== 'function') return 'the compaction service has no summary hook';
  const leases = new Map<string, Lease>();
  const unwrap = (problem: string) => {
    installation.unwrapped = problem;
    installation.unsupported = problem;
    installation.log?.(
      '[dsh-bridge] summary hook left as DSH ships it (no reasoning effort of ours, no /compact instructions):',
      problem
    );
  };
  const installation: Installation = {
    unsupported: undefined,
    unwrapped: undefined,
    leases,
    efforts: options.efforts,
    log: options.log,
    ready: dryRun(original as Summarize, instance).then(
      (verdict) => {
        if (verdict.hook) {
          unwrap(verdict.hook);
          return;
        }
        if (verdict.shape) {
          installation.unsupported = verdict.shape;
          installation.log?.(
            '[dsh-bridge] /compact instructions do not fit the summary hook:',
            verdict.shape
          );
        }
        Object.defineProperty(instance, 'summarize', {
          value: wrapped(original as Summarize, installation),
          configurable: true,
          writable: true,
          enumerable: false,
        });
      },
      (error: unknown) => unwrap(`the summary hook could not be checked: ${messageOf(error)}`)
    ),
  };
  Object.defineProperty(instance, INSTALLATION, { value: installation, configurable: true });
  return installation;
}

/**
 * Decision 181: wraps the summary hook of `service` (the host's `compaction`)
 * if it is not wrapped yet, so every summary request names the reasoning
 * effort `summaryReasoningEffort` chooses — `efforts` reads the plan's levels.
 * Idempotent per instance; resolves once the dry run decided.
 */
export async function installSummaryHook(
  service: unknown,
  options: SummaryHookOptions = {}
): Promise<SummaryHookState> {
  const installation = installationOf(service, options);
  if (typeof installation === 'string') return { kind: 'unsupported', reason: installation };
  await installation.ready;
  return installation.unwrapped
    ? { kind: 'unsupported', reason: installation.unwrapped }
    : { kind: 'wrapped' };
}

/**
 * Arms `text` for the next summary request of `sessionId` on `service` (the
 * host's `compaction`): until the lease is released, that session's summary
 * goes out with the instructions after DSH's template.
 */
export async function armCompactInstructions(
  service: unknown,
  sessionId: string,
  text: string
): Promise<CompactInstructionsArm> {
  const installation = installationOf(service);
  if (typeof installation === 'string') return { kind: 'unsupported', reason: installation };
  await installation.ready;
  if (installation.unsupported) return { kind: 'unsupported', reason: installation.unsupported };
  if (installation.leases.has(sessionId)) return { kind: 'busy' };
  const lease: Lease = { sessionId, text, applied: false, refused: undefined };
  installation.leases.set(sessionId, lease);
  return {
    kind: 'armed',
    lease: {
      sessionId,
      text,
      get applied() {
        return lease.applied;
      },
      get refused() {
        return lease.refused;
      },
      release: () => {
        if (installation.leases.get(sessionId) === lease) installation.leases.delete(sessionId);
      },
      markUnused: () => {
        installation.unsupported ??=
          'a summary was written without the instructions: the summary hook was not on its path';
      },
    },
  };
}
