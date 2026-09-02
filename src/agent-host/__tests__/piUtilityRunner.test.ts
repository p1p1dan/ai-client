import { describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  createSettings: vi.fn(),
  createModelRuntime: vi.fn(),
}));

vi.mock('@earendil-works/pi-coding-agent', () => ({
  getAgentDir: () => '/managed/pi-agent',
  SettingsManager: { create: sdk.createSettings },
  ModelRuntime: { create: sdk.createModelRuntime },
}));

import { PiUtilityRunner } from '../piUtilityRunner.ts';

function settings() {
  return {
    getDefaultProvider: () => 'configured',
    getDefaultModel: () => 'default-model',
    getModelThinkingLevel: () => undefined,
    getDefaultThinkingLevel: () => undefined,
  };
}

describe('PiUtilityRunner', () => {
  it('uses an authenticated fallback and emits one terminal completion', async () => {
    sdk.createSettings.mockReturnValue(settings());
    const configured = { provider: 'configured', id: 'default-model' };
    const fallback = { provider: 'authenticated', id: 'fallback-model' };
    sdk.createModelRuntime.mockResolvedValue({
      getModel: vi.fn(() => configured),
      getAvailable: vi.fn(async () => [configured, fallback]),
      hasConfiguredAuth: vi.fn((provider: string) => provider === 'authenticated'),
      streamSimple: vi.fn(async function* () {
        yield { type: 'text_delta', delta: 'hello' };
        yield { type: 'done' };
      }),
    });
    const emitDelta = vi.fn();
    const emitTerminal = vi.fn();
    const runner = new PiUtilityRunner({
      projectTrusted: true,
      emitDelta,
      emitTerminal,
    });

    await expect(
      runner.start({
        operationId: 'utility-1',
        cwd: '/repo',
        prompt: 'summarize',
        timeoutMs: 60_000,
      })
    ).resolves.toEqual({ accepted: true, operationId: 'utility-1' });
    await vi.waitFor(() => expect(emitTerminal).toHaveBeenCalledTimes(1));
    expect(emitDelta).toHaveBeenCalledWith({ operationId: 'utility-1', delta: 'hello' });
    expect(emitTerminal).toHaveBeenCalledWith({
      operationId: 'utility-1',
      state: 'completed',
      text: 'hello',
      model: 'authenticated/fallback-model',
    });
  });

  it('aborts an active stream and emits cancellation exactly once', async () => {
    sdk.createSettings.mockReturnValue(settings());
    const model = { provider: 'configured', id: 'default-model' };
    sdk.createModelRuntime.mockResolvedValue({
      getModel: vi.fn(() => model),
      getAvailable: vi.fn(async () => [model]),
      hasConfiguredAuth: vi.fn(() => true),
      streamSimple: vi.fn((_model, _context, options: { signal: AbortSignal }) =>
        (async function* () {
          await new Promise<void>((resolve) =>
            options.signal.addEventListener('abort', () => resolve(), { once: true })
          );
          yield { type: 'error', reason: 'aborted', error: { errorMessage: 'aborted' } };
        })()
      ),
    });
    const emitTerminal = vi.fn();
    const runner = new PiUtilityRunner({
      projectTrusted: false,
      emitDelta: vi.fn(),
      emitTerminal,
    });
    await runner.start({
      operationId: 'utility-2',
      cwd: '/repo',
      prompt: 'review',
      timeoutMs: 60_000,
    });
    await expect(runner.cancel({ operationId: 'utility-2', reason: 'user' })).resolves.toEqual({
      cancelled: true,
    });
    await vi.waitFor(() => expect(emitTerminal).toHaveBeenCalledTimes(1));
    expect(emitTerminal).toHaveBeenCalledWith({
      operationId: 'utility-2',
      state: 'cancelled',
      text: '',
      model: 'configured/default-model',
    });
  });
});
