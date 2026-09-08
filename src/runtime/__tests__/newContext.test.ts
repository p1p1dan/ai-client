import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRuntime, type RuntimeHandle } from '../bootstrap.ts';
import { newContextTool } from '../plugins/tools/new-context.ts';

let runtime: RuntimeHandle | undefined;
afterEach(async () => {
  await runtime?.dispose();
  runtime = undefined;
});
describe('P1-9 new_context contribution', () => {
  it.each(['fresh_window', 'summary'] as const)('queues only an intent for %s', async (family) => {
    const request = vi.fn();
    const tool = newContextTool({ family, request });
    expect(tool.parameters).toMatchObject({ properties: {}, additionalProperties: false });
    expect(await tool.execute()).toMatchObject({
      details: { queued: true },
      content: [
        {
          type: 'text',
          text:
            family === 'summary'
              ? 'A new context window will start with a summary of the conversation history.'
              : 'A new context window will start without summarizing conversation history.',
        },
      ],
    });
    expect(request).toHaveBeenCalledOnce();
  });
  it('still respects an explicit tool whitelist', async () => {
    const provider = fauxProvider({ provider: 'test', models: [{ id: 'test', name: 'Test' }] });
    runtime = await createRuntime({
      providers: [provider.provider],
      tools: { cwd: process.cwd() },
      permissions: { gear: 'auto', allowedTools: ['read'] },
    });
    const tool = runtime.ctx.runtimeTools.list().find((tool) => tool.name === 'new_context');
    // Registered, but a host that names its allowed tools still decides: a
    // whitelist that silently gained a tool would not be one.
    await expect(tool?.execute('denied', {})).rejects.toMatchObject({ code: 'tool_denied' });
    expect(runtime.context?.pendingNewWindow).toBe(false);
  });

  it('runs in plan + ask without an approval, and rejects arguments it does not take', async () => {
    const provider = fauxProvider({ provider: 'test', models: [{ id: 'test', name: 'Test' }] });
    provider.setResponses([fauxAssistantMessage('ready')]);
    runtime = await createRuntime({
      providers: [provider.provider],
      tools: { cwd: process.cwd() },
      permissions: { mode: 'plan', gear: 'ask' },
    });
    const tool = runtime.ctx.runtimeTools.list().find((tool) => tool.name === 'new_context');
    expect(tool).toBeDefined();
    await expect(
      tool?.execute('bad', { summary: 'cannot steer compaction' })
    ).rejects.toMatchObject({ code: 'invalid_tool_arguments' });
    expect(runtime.context?.pendingNewWindow).toBe(false);
    // No approval bridge is configured, so an approval would hang the call:
    // reaching the intent is the assertion.
    await tool?.execute('valid', {});
    expect(runtime.context?.pendingNewWindow).toBe(true);
  });

  it('is absent when compaction is disabled, so no wording can promise it', async () => {
    const provider = fauxProvider({ provider: 'test', models: [{ id: 'test', name: 'Test' }] });
    runtime = await createRuntime({
      providers: [provider.provider],
      tools: { cwd: process.cwd() },
      context: { enabled: false },
    });
    expect(runtime.ctx.runtimeTools.list().some((tool) => tool.name === 'new_context')).toBe(false);
    expect(runtime.context?.compactionTool).toBeUndefined();
  });
});
