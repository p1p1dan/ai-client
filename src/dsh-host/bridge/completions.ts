/**
 * One-shot completions on the shared DSH host (dsh-rebase P1-15; decisions
 * 039 and 125).
 *
 * A commit message, a branch name or a code review is one tool-free model
 * call: Main builds the whole prompt (the git diff included, as it always
 * did) and sends `{host:'complete'}`; this module resolves the model through
 * the host's plan as a completion (`resolveRoute`, mode `completion`: no
 * effort or `off` sends none) and streams it with `ctx.llm.stream` — the same
 * adapter, routes and per-request keys a chat turn uses, but no agent, no
 * session, no tool and nothing written. DSH's LLM service makes one attempt
 * (no retry), as the native utility path did.
 *
 *   completion-delta   each text delta, in order, when the request asked
 *   completed          once: the text and our model id, or an error code
 *
 * `complete-cancel` and the request's own `timeoutMs` abort the call and
 * answer at once; a provider that ignores the abort cannot hold the answer
 * back, and whatever it streams afterwards is dropped. Nothing here ever
 * throws out to the IPC handler: an unhandled rejection would take the whole
 * host down (installFailLoud).
 *
 * Loaded by Node type stripping in a source checkout: erasable syntax only.
 */

import { mapDshFailureCode } from '../../shared/dshFailureCodes.ts';
import {
  DSH_COMPLETION_CANCELLED,
  DSH_COMPLETION_FAILED,
  DSH_COMPLETION_TIMEOUT,
  DSH_COMPLETION_UNAVAILABLE,
  type DshHostCompleted,
  type DshHostCompleteRequest,
  type DshHostToMainMessage,
} from '../../shared/types/dshHostProtocol.ts';
import type { DshRoutedModel } from './modelRoute.ts';

/**
 * The system prompt of every one-shot completion: the native utility
 * runtime's wording (src/runtime/worker/nativeUtility.ts), verbatim, so the
 * model is asked the same thing on both engines.
 */
export const COMPLETION_SYSTEM_PROMPT =
  'You are a tool-free completion service. Answer only from the prompt content. Do not request or invoke tools.';

/** The request `ctx.llm.stream` takes, as far as a one-shot completion fills it. */
export interface CompletionStreamOptions {
  provider: string;
  model: string;
  reasoningEffort?: string;
  system: string;
  messages: Array<{ role: 'user'; content: Array<{ type: 'text'; text: string }> }>;
  signal: AbortSignal;
}

/** One chunk of DSH's stream protocol, read loosely: only text and the finish matter here. */
export interface CompletionChunk {
  type: string;
  text?: unknown;
  reason?: { kind?: unknown; failure?: { code?: unknown; message?: unknown } };
}

/** The slice of DSH's LLM service (`ctx.llm`) a completion uses. */
export interface CompletionLlm {
  stream(options: CompletionStreamOptions): AsyncIterable<CompletionChunk>;
}

export interface DshCompletionsOptions {
  /** The host's LLM service; undefined answers every request `completion_unavailable`. */
  llm(): CompletionLlm | undefined;
  /**
   * Our model and effort as a completion (`DshModelRouter.completion`); throws
   * with a `code` (`MODEL_NOT_CONFIGURED`) when the plan cannot serve it.
   */
  route(model: string | undefined, effort: string | undefined): DshRoutedModel;
  send(message: DshHostToMainMessage): void;
  log(...args: unknown[]): void;
  /** Monotonic milliseconds, for `ms`. */
  now?(): number;
}

interface ActiveCompletion {
  readonly request: DshHostCompleteRequest;
  readonly controller: AbortController;
  readonly startedAt: number;
  text: string;
  modelId?: string;
  timer?: ReturnType<typeof setTimeout>;
  done: boolean;
}

type Failure = NonNullable<DshHostCompleted['error']>;

function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.length > 0 ? code : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class DshCompletions {
  private readonly options: DshCompletionsOptions;
  private readonly active = new Map<number, ActiveCompletion>();
  private disposed = false;

  constructor(options: DshCompletionsOptions) {
    this.options = options;
  }

  /** Completions still running. */
  get size(): number {
    return this.active.size;
  }

  /** Starts one completion; its answer goes out through `send`, never as a throw. */
  start(request: DshHostCompleteRequest): void {
    const startedAt = this.now();
    if (this.active.has(request.id)) {
      // Answering would settle the call already running under this id.
      this.options.log(`completion ${request.id} is already running; the duplicate was dropped`);
      return;
    }
    const active: ActiveCompletion = {
      request,
      controller: new AbortController(),
      startedAt,
      text: '',
      done: false,
    };
    if (this.disposed) {
      this.answer(active, {
        code: DSH_COMPLETION_UNAVAILABLE,
        message: 'the bridge is shutting down',
      });
      return;
    }
    const llm = this.options.llm();
    if (!llm) {
      this.answer(active, {
        code: DSH_COMPLETION_UNAVAILABLE,
        message: 'this host has no LLM service for completions',
      });
      return;
    }
    let routed: DshRoutedModel;
    try {
      routed = this.options.route(request.model, request.effort);
    } catch (error) {
      this.answer(active, {
        code: codeOf(error) ?? DSH_COMPLETION_FAILED,
        message: messageOf(error),
      });
      return;
    }
    active.modelId = routed.modelId;
    this.active.set(request.id, active);
    active.timer = setTimeout(() => {
      this.abort(active, {
        code: DSH_COMPLETION_TIMEOUT,
        message: `no answer within ${request.timeoutMs} ms`,
      });
    }, request.timeoutMs);
    active.timer.unref?.();
    void this.run(llm, active, routed);
  }

  /** Aborts one completion and answers it `completion_cancelled`; unknown ids are ignored. */
  cancel(id: number): void {
    const active = this.active.get(id);
    if (!active) return;
    this.abort(active, { code: DSH_COMPLETION_CANCELLED, message: 'cancelled by Main' });
  }

  /** The bridge row is going away: every running completion is aborted and answered. */
  dispose(): void {
    this.disposed = true;
    for (const active of [...this.active.values()]) {
      this.abort(active, {
        code: DSH_COMPLETION_UNAVAILABLE,
        message: 'the bridge is shutting down',
      });
    }
  }

  private async run(
    llm: CompletionLlm,
    active: ActiveCompletion,
    routed: DshRoutedModel
  ): Promise<void> {
    const { request, controller } = active;
    try {
      const stream = llm.stream({
        provider: routed.selection.provider,
        model: routed.selection.model,
        ...(routed.selection.reasoningEffort
          ? { reasoningEffort: routed.selection.reasoningEffort }
          : {}),
        system: COMPLETION_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: [{ type: 'text', text: request.prompt }] }],
        signal: controller.signal,
      });
      for await (const chunk of stream) {
        if (active.done) return;
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
          if (chunk.text.length === 0) continue;
          active.text += chunk.text;
          if (request.stream) {
            this.options.send({ host: 'completion-delta', id: request.id, text: chunk.text });
          }
          continue;
        }
        if (chunk.type !== 'finish') continue;
        const kind = chunk.reason?.kind;
        if (kind === 'error' || kind === 'aborted') {
          const dshCode = codeOf(chunk.reason?.failure);
          const message = chunk.reason?.failure?.message;
          this.settle(active, {
            code:
              kind === 'aborted'
                ? DSH_COMPLETION_CANCELLED
                : (mapDshFailureCode(dshCode) ?? DSH_COMPLETION_FAILED),
            message: typeof message === 'string' ? message : `the model call ended: ${kind}`,
            ...(dshCode ? { dshCode } : {}),
          });
          return;
        }
        // stop, max-tokens, and any finish DSH adds later without a failure.
        this.settle(active);
        return;
      }
      this.settle(active, {
        code: controller.signal.aborted ? DSH_COMPLETION_CANCELLED : DSH_COMPLETION_FAILED,
        message: 'the model stream ended without a finish',
      });
    } catch (error) {
      this.settle(active, {
        code: controller.signal.aborted ? DSH_COMPLETION_CANCELLED : DSH_COMPLETION_FAILED,
        message: messageOf(error),
      });
    }
  }

  /** Answers first, then aborts: the answer must not wait on a provider that ignores the signal. */
  private abort(active: ActiveCompletion, failure: Failure): void {
    if (active.done) return;
    this.settle(active, failure);
    active.controller.abort();
  }

  private settle(active: ActiveCompletion, failure?: Failure): void {
    if (active.done) return;
    active.done = true;
    if (active.timer) clearTimeout(active.timer);
    if (this.active.get(active.request.id) === active) this.active.delete(active.request.id);
    this.answer(active, failure);
  }

  private answer(active: ActiveCompletion, failure?: Failure): void {
    active.done = true;
    const ms = Math.round((this.now() - active.startedAt) * 10) / 10;
    const answer: DshHostCompleted = failure
      ? { host: 'completed', id: active.request.id, ok: false, error: failure, ms }
      : {
          host: 'completed',
          id: active.request.id,
          ok: true,
          text: active.text,
          ...(active.modelId ? { model: active.modelId } : {}),
          ms,
        };
    try {
      this.options.send(answer);
    } catch (error) {
      this.options.log(`completion ${active.request.id} could not be answered`, error);
    }
  }

  private now(): number {
    return this.options.now?.() ?? performance.now();
  }
}
