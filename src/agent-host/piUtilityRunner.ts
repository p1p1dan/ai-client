import path from 'node:path';
import { getAgentDir, ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import { parsePiModelRef } from '../shared/piModelConfig.ts';
import { isSessionEffortLevel, type SessionEffortLevel } from '../shared/types/agentHost.ts';
import type {
  WorkerUtilityCancelPayload,
  WorkerUtilityCancelResult,
  WorkerUtilityDeltaPayload,
  WorkerUtilityStartPayload,
  WorkerUtilityStartResult,
  WorkerUtilityTerminalPayload,
} from '../shared/types/workerRpc.ts';
import { PiWorkerSessionError } from './piWorkerErrors.ts';

interface ActiveOperation {
  input: WorkerUtilityStartPayload;
  controller: AbortController;
  text: string;
  terminal: boolean;
  model: string;
}

export interface PiUtilityRunnerOptions {
  projectTrusted: boolean;
  emitDelta: (payload: WorkerUtilityDeltaPayload) => void;
  emitTerminal: (payload: WorkerUtilityTerminalPayload) => void;
  log?: (...args: unknown[]) => void;
}

/**
 * The one-shot streaming path takes SIX thinking levels, not seven.
 *
 * Pi ships two `ThinkingLevel` unions and they disagree: `pi-agent-core`'s (the
 * durable AgentSession, used by chat) includes `off`, while `pi-ai`'s
 * `SimpleStreamOptions.reasoning` (this path) does not — `off` lives there as a
 * separate `ModelThinkingLevel` used for model config, not for a request. So
 * `off` cannot be expressed on a utility completion at all.
 *
 * Omitting the field is the honest answer: it means "provider default", which
 * is not what `off` asked for, but inventing `minimal` in its place would put a
 * level on the wire that the user never chose. This matches what this path
 * already did before U08-2, so it is not a regression — `minimal` is.
 */
type UtilityStreamEffort = Exclude<SessionEffortLevel, 'off'>;

/**
 * U08-2: the fallback rungs read Pi's own settings, which have always spoken
 * the full seven-level vocabulary. The narrowing here used to list five words,
 * so a user whose Pi config pinned `minimal` silently got the provider default
 * for every AI-feature completion instead.
 */
function resolveEffort(
  requested: SessionEffortLevel | undefined,
  settings: SettingsManager,
  provider: string,
  modelId: string
): UtilityStreamEffort | undefined {
  const value =
    requested ??
    settings.getModelThinkingLevel(provider, modelId) ??
    settings.getDefaultThinkingLevel();
  return isSessionEffortLevel(value) && value !== 'off' ? value : undefined;
}

/**
 * One public-Pi-API, tool-free completion. No AgentSession, SessionManager, or
 * session JSONL is created: the worker streams one plain user message directly
 * through ModelRuntime and exits after Main observes a terminal event.
 */
export class PiUtilityRunner {
  private readonly options: PiUtilityRunnerOptions;
  private active: ActiveOperation | null = null;
  private disposed = false;

  constructor(options: PiUtilityRunnerOptions) {
    this.options = options;
  }

  async start(input: WorkerUtilityStartPayload): Promise<WorkerUtilityStartResult> {
    if (this.disposed) {
      throw new PiWorkerSessionError('WORKER_SESSION_DISPOSED', 'Pi utility worker is disposed');
    }
    if (this.active && !this.active.terminal) {
      throw new PiWorkerSessionError(
        'WORKER_SESSION_BUSY',
        'Pi utility worker already has an active operation',
        true
      );
    }

    const agentDir = getAgentDir();
    const settings = SettingsManager.create(input.cwd, agentDir, {
      projectTrusted: this.options.projectTrusted,
    });
    const modelRuntime = await ModelRuntime.create({
      authPath: path.join(agentDir, 'auth.json'),
      modelsPath: path.join(agentDir, 'models.json'),
    });
    const requested = input.model ? parsePiModelRef(input.model) : null;
    if (input.model && !requested) {
      throw new PiWorkerSessionError(
        'WORKER_INVALID_MODEL',
        `Invalid Pi model: ${input.model}. Expected provider/model`
      );
    }

    let model: Awaited<ReturnType<ModelRuntime['getAvailable']>>[number] | undefined;
    if (requested) {
      model = modelRuntime.getModel(requested.provider, requested.modelId);
      if (!model || !modelRuntime.hasConfiguredAuth(model.provider)) {
        throw new PiWorkerSessionError(
          'WORKER_MODEL_NOT_FOUND',
          `Pi model is unavailable or has no configured authentication: ${input.model}`
        );
      }
    } else {
      const configuredProvider = settings.getDefaultProvider();
      const configuredModel = settings.getDefaultModel();
      const configured =
        configuredProvider && configuredModel
          ? modelRuntime.getModel(configuredProvider, configuredModel)
          : undefined;
      model =
        configured && modelRuntime.hasConfiguredAuth(configured.provider)
          ? configured
          : (await modelRuntime.getAvailable()).find((candidate) =>
              modelRuntime.hasConfiguredAuth(candidate.provider)
            );
      if (!model) {
        throw new PiWorkerSessionError(
          'WORKER_MODEL_NOT_FOUND',
          'No Pi model with configured authentication is available'
        );
      }
    }

    const active: ActiveOperation = {
      input,
      controller: new AbortController(),
      text: '',
      terminal: false,
      model: `${model.provider}/${model.id}`,
    };
    this.active = active;
    const effort = resolveEffort(input.effort, settings, model.provider, model.id);
    void this.run(active, modelRuntime, model, effort);
    return { accepted: true, operationId: input.operationId };
  }

  async cancel(input: WorkerUtilityCancelPayload): Promise<WorkerUtilityCancelResult> {
    const active = this.active;
    if (!active || active.terminal || active.input.operationId !== input.operationId) {
      return { cancelled: false };
    }
    active.controller.abort();
    return { cancelled: true };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const active = this.active;
    if (active && !active.terminal) {
      active.controller.abort();
      this.finish(active, 'cancelled');
    }
  }

  private async run(
    active: ActiveOperation,
    modelRuntime: ModelRuntime,
    model: ReturnType<ModelRuntime['getModel']> extends infer T ? Exclude<T, undefined> : never,
    effort: UtilityStreamEffort | undefined
  ): Promise<void> {
    try {
      const stream = modelRuntime.streamSimple(
        model,
        {
          systemPrompt:
            'You are a tool-free completion service. Answer only from the prompt content. Do not request or invoke tools.',
          messages: [{ role: 'user', content: active.input.prompt, timestamp: Date.now() }],
          tools: [],
        },
        {
          signal: active.controller.signal,
          timeoutMs: active.input.timeoutMs,
          toolChoice: 'none',
          ...(effort ? { reasoning: effort } : {}),
        }
      );
      for await (const event of stream) {
        if (this.active !== active || active.terminal) return;
        if (event.type === 'text_delta') {
          active.text += event.delta;
          this.options.emitDelta({ operationId: active.input.operationId, delta: event.delta });
        } else if (event.type === 'error') {
          if (event.reason === 'aborted') {
            this.finish(active, 'cancelled');
          } else {
            this.finish(active, 'failed', event.error.errorMessage);
          }
          return;
        } else if (event.type === 'done') {
          this.finish(active, 'completed');
          return;
        }
      }
      this.finish(
        active,
        active.controller.signal.aborted ? 'cancelled' : 'failed',
        'Pi stream ended without a terminal event'
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
