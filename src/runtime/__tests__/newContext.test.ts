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
    const request = vi.fn();
    runtime = await createRuntime({
      providers: [provider.provider],
      tools: { cwd: process.cwd() },
      permissions: { gear: 'auto', allowedTools: ['read'] },
    });
    runtime.ctx.runtimeTools.register(newContextTool({ family: 'summary', request }), 'read');
    const tool = runtime.ctx.runtimeTools.list().find((tool) => tool.name === 'new_context');
    await expect(tool?.execute('denied', {})).rejects.toMatchObject({ code: 'tool_denied' });
    expect(request).not.toHaveBeenCalled();
  });
  it('is absent until P2 contributes it, then runs in plan + ask without an approval', async () => {
    const provider = fauxProvider({ provider: 'test', models: [{ id: 'test', name: 'Test' }] });
    provider.setResponses([fauxAssistantMessage('ready')]);
    const request = vi.fn();
    runtime = await createRuntime({
      providers: [provider.provider],
      tools: { cwd: process.cwd() },
      permissions: { mode: 'plan', gear: 'ask' },
    });
    expect(runtime.ctx.runtimeTools.list().some((tool) => tool.name === 'new_context')).toBe(false);
    runtime.ctx.runtimeTools.register(newContextTool({ family: 'summary', request }), 'read');
    const tool = runtime.ctx.runtimeTools.list().find((tool) => tool.name === 'new_context');
    await expect(
      tool?.execute('bad', { summary: 'cannot steer compaction' })
    ).rejects.toMatchObject({ code: 'invalid_tool_arguments' });
    expect(request).not.toHaveBeenCalled();
    await tool?.execute('valid', {});
    expect(request).toHaveBeenCalledOnce();
  });
});
