import { describe, expect, it, vi } from 'vitest';
import { PiAgentRuntime } from '../piRuntime';
import { SessionRegistry } from '../sessionRegistry';

function makeHarness() {
  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const prompts: string[] = [];
  const setModels: Array<{ provider: string; id: string }> = [];
  const models = new Map([
    ['glm/glm-5', { provider: 'glm', id: 'glm-5', name: 'GLM 5' }],
    ['dan/deepseek-v4', { provider: 'dan', id: 'deepseek-v4', name: 'DeepSeek V4' }],
  ]);
  const session = {
    sessionId: 'pi-session',
    model: undefined as { provider: string; id: string; name?: string } | undefined,
    sessionFile: '/tmp/pi-session.jsonl',
    prompt: vi.fn(async (text: string) => {
      prompts.push(text);
    }),
    subscribe: vi.fn(() => () => {}),
    abort: vi.fn(async () => {}),
    setModel: vi.fn(async (model: { provider: string; id: string; name?: string }) => {
      session.model = model;
      setModels.push(model);
    }),
  };
  const services = {
    cwd: '/repo',
    agentDir: '/tmp/pi-agent',
    diagnostics: [],
    modelRuntime: {
      getModel: (provider: string, id: string) => models.get(`${provider}/${id}`),
    },
  };
  const sdk = {
    getAgentDir: () => '/tmp/pi-agent',
    SessionManager: {
      create: () => ({}),
      open: () => ({}),
      continueRecent: () => ({}),
      inMemory: () => ({}),
    },
    SettingsManager: { create: () => ({}) },
    createAgentSessionServices: async () => services,
    createAgentSessionFromServices: async () => ({ session }),
    createAgentSessionRuntime: async (
      factory: (input: Record<string, unknown>) => Promise<Record<string, unknown>>,
      options: Record<string, unknown>
    ) => factory({ cwd: options.cwd, sessionManager: options.sessionManager }),
  };
  const registry = new SessionRegistry();
  const runtime = new PiAgentRuntime({
    registry,
    emit: (event) => events.push(event as { type: string; payload?: Record<string, unknown> }),
    loadSdk: async () => sdk,
  });
  return { events, prompts, registry, runtime, setModels };
}

describe('PiAgentRuntime model selection', () => {
  it('applies the create-time provider/model choice before the first prompt', async () => {
    const h = makeHarness();
    h.runtime.createSession({ sessionId: 's1', workspacePath: '/repo', model: 'glm/glm-5' });
    await h.runtime.send({ sessionId: 's1', text: 'hello' });

    expect(h.setModels).toEqual([{ provider: 'glm', id: 'glm-5', name: 'GLM 5' }]);
    expect(h.prompts).toEqual(['hello']);
    expect(h.registry.get('s1')?.model).toBe('glm/glm-5');
  });

  it('lets a send-time override win and persist as the session selection', async () => {
    const h = makeHarness();
    h.runtime.createSession({ sessionId: 's1', workspacePath: '/repo', model: 'glm/glm-5' });
    await h.runtime.send({ sessionId: 's1', text: 'hello', model: 'dan/deepseek-v4' });

    expect(h.setModels.at(-1)).toEqual({
      provider: 'dan',
      id: 'deepseek-v4',
      name: 'DeepSeek V4',
    });
    expect(h.registry.get('s1')?.model).toBe('dan/deepseek-v4');
  });

  it('fails visibly and never prompts for malformed or unknown model ids', async () => {
    for (const model of ['glm-only', 'glm/missing']) {
      const h = makeHarness();
      h.runtime.createSession({ sessionId: 's1', workspacePath: '/repo', model });
      await h.runtime.send({ sessionId: 's1', text: 'hello' });

      expect(h.prompts).toEqual([]);
      expect(h.events.some((event) => event.type === 'session.failed')).toBe(true);
    }
  });
});
