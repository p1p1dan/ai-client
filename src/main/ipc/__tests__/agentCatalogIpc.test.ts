import { tmpdir } from 'node:os';
import type { AgentModelCatalog } from '@shared/types/agentCatalog';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * D48 S2 §4.5 — `chat:listAgentModels` wiring.
 *
 * The handler is deliberately thin, so the only things worth asserting are the
 * two it owns: that an `agent` slug arriving over IPC is validated BEFORE it
 * indexes a `Record<AgentWireName, …>` (an unknown one would otherwise reach
 * `undefined.baseUrlOf` inside the service), and that `force` is relayed as a
 * strict boolean rather than as whatever truthy value the renderer sent.
 */

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const listCalls: Array<{ agent: string; force?: boolean }> = [];

const CATALOG: AgentModelCatalog = {
  agent: 'codex',
  models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' }],
  source: 'proxy',
  stale: false,
  fetchedAt: 1,
};

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: vi.fn(() => tmpdir()) },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  net: { fetch: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
}));

vi.mock('../../services/agentCatalog', () => ({
  getAgentCatalogService: () => ({
    list: async (input: { agent: string; force?: boolean }) => {
      listCalls.push(input);
      return CATALOG;
    },
  }),
}));

beforeEach(async () => {
  vi.resetModules();
  handlers.clear();
  listCalls.length = 0;
  const { registerAgentCatalogHandlers } = await import('../agentCatalog');
  registerAgentCatalogHandlers();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function invoke(payload: unknown): Promise<unknown> {
  const handler = handlers.get('chat:listAgentModels');
  if (!handler) throw new Error('chat:listAgentModels was never registered');
  return Promise.resolve(handler({}, payload));
}

describe('chat:listAgentModels', () => {
  it('relays a known agent and answers with the service payload', async () => {
    await expect(invoke({ agent: 'codex' })).resolves.toEqual(CATALOG);
    expect(listCalls).toEqual([{ agent: 'codex', force: false }]);
  });

  it('accepts the Pi wire name', async () => {
    await invoke({ agent: 'pi' });
    expect(listCalls).toEqual([{ agent: 'pi', force: false }]);
  });

  it('passes force through only when it is exactly true', async () => {
    await invoke({ agent: 'claude-code', force: true });
    await invoke({ agent: 'claude-code', force: 'yes' });
    expect(listCalls.map((call) => call.force)).toEqual([true, false]);
  });

  it('refuses an unknown agent slug without reaching the service', async () => {
    await expect(invoke({ agent: 'claude' })).rejects.toThrow(/unknown agent/);
    await expect(invoke({})).rejects.toThrow(/unknown agent/);
    expect(listCalls).toEqual([]);
  });
});
