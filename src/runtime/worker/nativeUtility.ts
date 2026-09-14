/**
 * P6-2 — one-shot completions on the self-owned runtime.
 *
 * The "AI features" path (titles, summaries, small rewrites) is tool-free and
 * session-free: one user message in, streamed text out. It was the last thing a
 * NATIVE install still ran through pi-coding-agent, which made "the app no
 * longer runs on the old package" untrue in a way no session test could catch.
 *
 * The model comes out of the same catalog a session uses — `createRuntime`
 * without `tools` or `session` builds just the model adapter, so this shares
 * one definition of "which providers exist and what key each presents" with
 * every other native path.
 *
 * Deliberately NOT the agent loop: the loop is turns, tools, permissions and a
 * transcript. Calling it here would make a title request capable of touching
 * the workspace. `streamSimple` with `toolChoice: 'none'` is the same call the
 * loop makes underneath, minus everything that only a conversation needs.
 */

import { join } from 'node:path';
import type {
  WorkerUtilityCancelPayload,
  WorkerUtilityCancelResult,
  WorkerUtilityDeltaPayload,
  WorkerUtilityStartPayload,
  WorkerUtilityStartResult,
  WorkerUtilityTerminalPayload,
} from '../../shared/types/workerRpc.ts';
import { createRuntime, type RuntimeBootstrapOptions, type RuntimeHandle } from '../bootstrap.ts';
import type { RuntimeHostConfig } from '../contracts.ts';
import { NativeWorkerRuntimeError } from './nativeWorkerRuntime.ts';

/** Same wording the pi runner used, so the two backends ask for the same thing. */
const SYSTEM_PROMPT =
  'You are a tool-free completion service. Answer only from the prompt content. Do not request or invoke tools.';

/**
 * The six levels a one-shot request can carry.
 *
 * `off` is not one of them: pi-ai's per-request `reasoning` has no "off" — that
 * word lives in model configuration, not in a request. Omitting the field means
 * "provider default", which is not the same as off, but putting some other
 * level on the wire would be claiming a choice the user never made.
 */
const REQUEST_EFFORTS = ['minimal', 'low', 'medium', 'high', 'max', 'xhigh'] as const;
type RequestEffort = (typeof REQUEST_EFFORTS)[number];

function requestEffort(value: string | undefined): RequestEffort | undefined {
  return REQUEST_EFFORTS.includes(value as RequestEffort) ? (value as RequestEffort) : undefined;
}

export interface NativeUtilityRuntimeOptions {
  host: RuntimeHostConfig;
  emitDelta: (payload: WorkerUtilityDeltaPayload) => void;
  emitTerminal: (payload: WorkerUtilityTerminalPayload) => void;
  agentDir?: string;
  /** P5-5 — the host-assembled catalog, when Main supplied one. */
  modelCatalog?: RuntimeBootstrapOptions['modelCatalog'];
  env?: NodeJS.ProcessEnv;
  log?: (...args: unknown[]) => void;
  /** Injectable for tests; defaults to the real Cordis bootstrap. */
  create?: typeof createRuntime;
}

interface ActiveOperation {
  input: WorkerUtilityStartPayload;
  controller: AbortController;
  text: string;
  terminal: boolean;
  model: string;
}

export class NativeUtilityRuntime {
  private readonly options: NativeUtilityRuntimeOptions;
  private active: ActiveOperation | null = null;
  private handle: RuntimeHandle | null = null;
  private disposed = false;

  constructor(options: NativeUtilityRuntimeOptions) {
    this.options = options;
  }

  async start(input: WorkerUtilityStartPayload): Promise<WorkerUtilityStartResult> {
    if (this.disposed)
      throw new NativeWorkerRuntimeError('WORKER_SESSION_DISPOSED', 'utility runtime is disposed');
    if (this.active && !this.active.terminal)
      throw new NativeWorkerRuntimeError(
        'WORKER_SESSION_BUSY',
        'utility runtime already has an active operation',
        true
      );

    const runtime = await this.runtime();
    const ref = this.resolveRef(runtime, input.model);
    const resolved = runtime.model.resolve(ref);
    const active: ActiveOperation = {
      input,
      controller: new AbortController(),
      text: '',
      terminal: false,
      model: `${ref.provider}/${ref.id}`,
    };
    this.active = active;
    // `off` is a choice, not a gap. pi-ai has no per-request "off", so the
    // field is omitted either way — but omitting it must not send the request
    // on to the level pinned in the agent directory, which is how a user who
    // switched reasoning off ended up paying for `high`. Only an ABSENT effort
    // falls back to configuration.
    const effort =
      input.effort === 'off'
        ? undefined
        : (requestEffort(input.effort) ??
          (await this.configuredEffort(runtime, ref.provider, ref.id)));
    void this.run(active, resolved, effort);
    return { accepted: true, operationId: input.operationId };
  }

  async cancel(input: WorkerUtilityCancelPayload): Promise<WorkerUtilityCancelResult> {
    const active = this.active;
    if (!active || active.terminal || active.input.operationId !== input.operationId)
      return { cancelled: false };
    active.controller.abort();
    // Settled here rather than by waiting for the stream to notice: a provider
    // that ignores the signal would otherwise leave Main with an operation that
    // never ends. `finish` is idempotent, so a well-behaved stream reporting
    // `aborted` a moment later changes nothing, and the loop drops any delta
    // that arrives after the terminal event.
    this.finish(active, 'cancelled');
    return { cancelled: true };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const active = this.active;
    if (active && !active.terminal) {
      active.controller.abort();
      this.finish(active, 'cancelled');
    }
    const handle = this.handle;
    this.handle = null;
    if (handle) await handle.dispose().catch(() => {});
  }

  /**
   * Built once and kept: a worker slot runs one utility operation at a time but
   * may run several in a row, and re-reading the catalog for each would make a
   * second title request fail on a keyring that locked in between.
   */
  private async runtime(): Promise<RuntimeHandle> {
    if (this.handle) return this.handle;
    const create = this.options.create ?? createRuntime;
    this.handle = await create({
      host: this.options.host,
      traceDir: null,
      ...(this.options.env ? { env: this.options.env } : {}),
      ...(this.options.agentDir ? { agentDir: this.options.agentDir } : {}),
      ...(this.options.modelCatalog ? { modelCatalog: this.options.modelCatalog } : {}),
    });
    return this.handle;
  }

  private resolveRef(runtime: RuntimeHandle, requested: string | undefined) {
    if (!requested) {
      const fallback = runtime.model.defaultRef();
      if (!fallback)
        throw new NativeWorkerRuntimeError(
          'WORKER_MODEL_NOT_FOUND',
          'no model with configured authentication is available'
        );
      return fallback;
    }
    const separator = requested.indexOf('/');
    if (separator <= 0 || separator === requested.length - 1)
      throw new NativeWorkerRuntimeError(
        'WORKER_INVALID_MODEL',
        `Invalid model: ${requested}. Expected provider/model`
      );
    const ref = {
      provider: requested.slice(0, separator),
      id: requested.slice(separator + 1),
    };
    // `resolve` throws `model_not_in_catalog`; restate it in the worker's
    // vocabulary so Main's error mapping does not have to know both.
    if (!runtime.model.list().some((item) => item.provider === ref.provider && item.id === ref.id))
      throw new NativeWorkerRuntimeError(
        'WORKER_MODEL_NOT_FOUND',
        `model is unavailable or has no configured authentication: ${requested}`
      );
    return ref;
  }

  /**
   * The thinking level the user pinned in the agent directory's settings.
   *
   * Read directly rather than through pi's SettingsManager, which is the whole
   * point of this class. Project-level settings are deliberately not merged: a
   * one-shot completion has no workspace to speak of, and reading a file from
   * an untrusted project to decide a request parameter is the kind of thing
   * `projectTrusted` exists to prevent.
   */
  private async configuredEffort(
    runtime: RuntimeHandle,
    provider: string,
    modelId: string
  ): Promise<RequestEffort | undefined> {
    const agentDir = this.options.agentDir;
    if (!agentDir) return undefined;
    try {
      const read = await runtime.hostIo.readFile(join(agentDir, 'settings.json'), {
        maxBytes: 1024 * 1024,
        overflow: 'error',
      });
      const settings = JSON.parse(new TextDecoder().decode(read.bytes)) as {
        defaultThinkingLevel?: unknown;
        modelThinkingLevels?: Record<string, unknown>;
      };
      const perModel = settings.modelThinkingLevels?.[`${provider}/${modelId}`];
      return (
        requestEffort(typeof perModel === 'string' ? perModel : undefined) ??
        requestEffort(
          typeof settings.defaultThinkingLevel === 'string'
            ? settings.defaultThinkingLevel
            : undefined
        )
      );
    } catch {
      // No settings file, unreadable, or not JSON: the provider default is the
      // honest answer, and a utility completion must not fail over a preference.
      return undefined;
    }
  }

  private async run(
    active: ActiveOperation,
    resolved: ReturnType<RuntimeHandle['model']['resolve']>,
    effort: RequestEffort | undefined
  ): Promise<void> {
    try {
      const stream = resolved.models.streamSimple(
        resolved.model,
        {
          systemPrompt: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: active.input.prompt, timestamp: Date.now() }],
          tools: [],
        },
        {
          signal: active.controller.signal,
          timeoutMs: active.input.timeoutMs,
          toolChoice: 'none',
          apiKey: resolved.requestKey || undefined,
          ...(effort ? { reasoning: effort } : {}),
        }
      );
      for await (const event of stream) {
        if (this.active !== active || active.terminal) return;
        if (event.type === 'text_delta') {
          active.text += event.delta;
          this.options.emitDelta({ operationId: active.input.operationId, delta: event.delta });
        } else if (event.type === 'error') {
          if (event.reason === 'aborted') this.finish(active, 'cancelled');
          else this.finish(active, 'failed', event.error.errorMessage);
          return;
        } else if (event.type === 'done') {
          this.finish(active, 'completed');
          return;
        }
      }
      this.finish(
        active,
        active.controller.signal.aborted ? 'cancelled' : 'failed',
        'the model stream ended without a terminal event'
      );
    } catch (error) {
      this.finish(
        active,
        active.controller.signal.aborted ? 'cancelled' : 'failed',
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  private finish(
    active: ActiveOperation,
    state: WorkerUtilityTerminalPayload['state'],
    error?: string
  ): void {
    if (active.terminal) return;
    active.terminal = true;
    if (this.active === active) this.active = null;
    this.options.emitTerminal({
      operationId: active.input.operationId,
      state,
      text: active.text,
      model: active.model,
      ...(error ? { error } : {}),
    });
  }
}
