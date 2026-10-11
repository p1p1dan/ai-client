/**
 * `/compact <instructions>` on the DSH engine (dsh-rebase decision 179).
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
 * instance, once per instance: while a `worker.compact` with instructions
 * runs for a session (`armCompactInstructions` -> lease -> `release`), that
 * session's summary request goes out with the instructions appended to the
 * template's text, in the same last message. Nothing before it changes.
 * Every other summary — automatic, another session's, `/compact` alone —
 * goes through untouched.
 *
 * Fail-safe, never silent:
 *  - before the first lease, a dry run of the hook (a stand-in model service
 *    that records the call and sends nothing) must end in one model call of
 *    that shape; otherwise, as with no compaction service or no `summarize`,
 *    the instructions are refused before anything runs (`unsupported`);
 *  - a real summary request of another shape is not sent: the lease is
 *    `refused` (the compaction fails, nothing is compacted) and the hook is
 *    marked unsupported, so the next request is refused up front;
 *  - a compaction that wrote its summary while its lease was never `applied`
 *    is reported by the bridge (`markUnused` marks the hook unsupported).
 *
 * No value imports from DSH: the bridge reads the service it is handed. The
 * DSH internals relied on, and what to check on a DSH upgrade, are listed in
 * decision 179 §4.
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

interface Installation {
  /** Set once the hook is known unusable; never cleared. */
  unsupported: string | undefined;
  /** The dry run and, when it passes, the wrapping. */
  readonly ready: Promise<void>;
  readonly leases: Map<string, Lease>;
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

/**
 * Why `options` is not the summary request this module extends — the
 * conversation it was given, unchanged, then one user message of text — or
 * undefined when it is.
 */
export function summaryRequestProblem(options: unknown, input: unknown): string | undefined {
  if (!isRecord(options)) return 'the model call has no options';
  if (options.purpose !== 'compaction') {
    return `the model call is not the summary request (purpose ${String(options.purpose)})`;
  }
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

/**
 * The hook run on a stand-in: a model service that records the call and
 * throws, an agent routed to a stand-in model. Nothing is sent, nothing of the
 * instance is changed. Undefined when the hook made one summary request of the
 * expected shape.
 */
async function dryRun(summarize: Summarize, instance: object): Promise<string | undefined> {
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
    if (outcome === 'timeout') return 'the summary hook did not answer its dry run';
    if (outcome === 'returned') return 'the summary hook finished without asking the model';
    if (outcome !== 'asked')
      return `the summary hook failed before asking the model: ${messageOf(outcome)}`;
  } finally {
    clearTimeout(timer);
  }
  if (calls !== 1) return `the summary hook asked the model ${calls} times`;
  return summaryRequestProblem(request, input);
}

/**
 * The hook for one installation: a session with a lease out has its summary
 * request extended; any other call is the original's, as it was.
 */
function wrapped(original: Summarize, installation: Installation): Summarize {
  return function summarize(this: unknown, input, agent, signal) {
    const lease = installation.leases.get(sessionIdOf(agent));
    if (!lease) return original.call(this, input, agent, signal);
    const refuse = (problem: string): never => {
      lease.refused = problem;
      installation.unsupported ??= problem;
      throw new Error(`instructions for /compact cannot be added: ${problem}`);
    };
    const self = this as { ctx?: unknown };
    const ctx = self.ctx;
    const llm = isObjectLike(ctx) ? (ctx as { llm?: unknown }).llm : undefined;
    if (!isObjectLike(llm) || typeof (llm as { stream?: unknown }).stream !== 'function') {
      return refuse('the compaction service reaches no model service');
    }
    const stream = (options: unknown): unknown => {
      const problem = summaryRequestProblem(options, input);
      if (problem) return refuse(problem);
      lease.applied = true;
      return (llm as { stream(options: unknown): unknown }).stream(
        withCompactInstructions(options as Record<string, unknown>, lease.text)
      );
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

function installationOf(service: unknown): Installation | string {
  if (!isObjectLike(service)) return 'this host has no compaction service';
  const instance = ((service as Record<symbol, unknown>)[CORDIS_ORIGINAL] ?? service) as Record<
    PropertyKey,
    unknown
  >;
  const existing = instance[INSTALLATION] as Installation | undefined;
  if (existing) return existing;
  const original = instance.summarize;
  if (typeof original !== 'function') return 'the compaction service has no summary hook';
  const leases = new Map<string, Lease>();
  const installation: Installation = {
    unsupported: undefined,
    leases,
    ready: dryRun(original as Summarize, instance).then(
      (problem) => {
        if (problem) {
          installation.unsupported = problem;
          return;
        }
        Object.defineProperty(instance, 'summarize', {
          value: wrapped(original as Summarize, installation),
          configurable: true,
          writable: true,
          enumerable: false,
        });
      },
      (error: unknown) => {
        installation.unsupported = `the summary hook could not be checked: ${messageOf(error)}`;
      }
    ),
  };
  Object.defineProperty(instance, INSTALLATION, { value: installation, configurable: true });
  return installation;
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
