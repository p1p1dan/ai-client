import path from 'node:path';
import { getAgentDir, ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import { parsePiModelRef } from '../shared/piModelConfig.ts';
import type { SessionEffortLevel } from '../shared/types/agentHost.ts';
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

function resolveEffort(
  requested: SessionEffortLevel | undefined,
  settings: SettingsManager,
  provider: string,
  modelId: string
): SessionEffortLevel | undefined {
  const value =
    requested ??
    settings.getModelThinkingLevel(provider, modelId) ??
    settings.getDefaultThinkingLevel();
  return value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max'
    ? value
    : undefined;
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
    effort: SessionEffortLevel | undefined
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
