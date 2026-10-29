// @vitest-environment happy-dom
import type {
  ClaudeCliResult,
  ClaudeMcpState,
  ClaudePluginsState,
  ClaudePluginView,
} from '@shared/claudePlugins';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * claude-plugins plan §3.3, §6 — Settings → Extensions → Claude plugins and Claude
 * MCP servers, mounted: the empty state offers the official marketplace, a row says
 * what its plugin brings with hooks and MCP servers flagged, a repository's plugin is
 * read-only, a switch goes to the CLI and the "new chats" notice follows, and an MCP
 * server shows the names of what it sets but never their values.
 */

vi.hoisted(() => {
  window.electronAPI = {
    env: { platform: 'linux' },
    settings: { read: async () => null, write: async () => undefined },
    app: { setLanguage: () => undefined, setProxy: () => undefined },
  } as unknown as typeof window.electronAPI;
});
vi.mock('@/utils/logging', () => ({ updateRendererLogging: vi.fn() }));
const i18n = {
  t: (key: string, params?: Record<string, string | number>) =>
    params ? key.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(params[name])) : key,
  locale: 'en',
};
vi.mock('@/i18n', () => ({ useI18n: () => i18n }));

import { ClaudeMcpSettings, parsePairs } from '../ClaudeMcpSettings';
import { ClaudePluginsSettings } from '../ClaudePluginsSettings';

function plugin(extra: Partial<ClaudePluginView> = {}): ClaudePluginView {
  return {
    id: 'hookify@claude-plugins-official',
    name: 'hookify',
    marketplace: 'claude-plugins-official',
    version: '0.1.1',
    description: 'Create hooks from conversation patterns',
    enabled: true,
    scope: 'user',
    components: { skills: 1, commands: 4, agents: 1, hooks: 4, mcpServers: 0 },
    ...extra,
  };
}

const ok = { ok: true } as ClaudeCliResult;
const plugins = {
  state: vi.fn<(repo?: string) => Promise<ClaudePluginsState>>(),
  available: vi.fn(async () => []),
  install: vi.fn(async () => ok),
  setEnabled: vi.fn(async (_id: string, _enabled: boolean) => ok),
  uninstall: vi.fn(async () => ok),
  update: vi.fn(async () => ok),
  addMarketplace: vi.fn(async (_source: string): Promise<ClaudeCliResult> => ok),
  removeMarketplace: vi.fn(async () => ok),
  updateMarketplace: vi.fn(async () => ok),
};
const mcp = {
  state: vi.fn<(repo?: string) => Promise<ClaudeMcpState>>(),
  add: vi.fn(async () => ok),
  remove: vi.fn(async (_name: string) => ok),
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  plugins.state.mockResolvedValue({ plugins: [], marketplaces: [] });
  mcp.state.mockResolvedValue({ servers: [] });
  window.electronAPI = {
    ...window.electronAPI,
    claudePlugins: plugins,
    claudeMcp: mcp,
  } as unknown as typeof window.electronAPI;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const text = () => container.textContent ?? '';

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function render(element: Parameters<typeof root.render>[0]): Promise<void> {
  await act(async () => root.render(element));
  await settle();
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(
    (node) => node.textContent?.trim() === label || node.getAttribute('aria-label') === label
  );
  if (!found) throw new Error(`no button ${label}: ${text()}`);
  return found;
}

describe('ClaudePluginsSettings', () => {
  it('[CPL-01] with no marketplace, offers the official one and adds it through the CLI', async () => {
    await render(createElement(ClaudePluginsSettings, { repoPath: '/repo' }));
    expect(plugins.state).toHaveBeenCalledWith('/repo');
    expect(text()).toContain('No Claude plugins yet');
    expect(text()).toContain('anthropics/claude-plugins-official');
    await act(async () => button('Add the official marketplace').click());
    await settle();
    expect(plugins.addMarketplace).toHaveBeenCalledWith('anthropics/claude-plugins-official');
  });

  it('[CPL-02] a row says what the plugin brings; hooks and MCP servers are flagged', async () => {
    plugins.state.mockResolvedValue({
      plugins: [
        plugin(),
        plugin({
          id: 'github@claude-plugins-official',
          name: 'github',
          components: { skills: 0, commands: 0, agents: 0, hooks: 0, mcpServers: 1 },
        }),
      ],
      marketplaces: [
        { name: 'claude-plugins-official', sourceKind: 'github', source: 'anthropics/x' },
      ],
    });
    await render(createElement(ClaudePluginsSettings));
    expect(text()).toContain('hookify');
    expect(text()).toContain('Commands 4');
    const warnings = [...container.querySelectorAll('[data-slot="badge"]')]
      .filter((node) => node.className.includes('text-warning'))
      .map((node) => node.textContent);
    expect(warnings).toEqual(['Hooks 4 · run commands', 'MCP servers 1 · start programs']);
  });

  it('[CPL-03] a switch goes to the CLI and the new-chats notice follows', async () => {
    plugins.state.mockResolvedValue({
      plugins: [plugin()],
      marketplaces: [{ name: 'claude-plugins-official', sourceKind: 'github', source: 'x' }],
    });
    await render(createElement(ClaudePluginsSettings));
    const toggle = container.querySelector<HTMLElement>('[role="switch"]');
    await act(async () => toggle?.click());
    await settle();
    expect(plugins.setEnabled).toHaveBeenCalledWith('hookify@claude-plugins-official', false);
    expect(text()).toContain('New Claude chats use the change');
  });

  it('[CPL-04] a repository’s plugin is listed apart, read-only', async () => {
    plugins.state.mockResolvedValue({
      plugins: [plugin({ id: 'chip@team', name: 'chip', marketplace: 'team', scope: 'project' })],
      marketplaces: [],
    });
    await render(createElement(ClaudePluginsSettings, { repoPath: '/repo' }));
    expect(text()).toContain('Declared by the open repository');
    expect(text()).toContain('Change it in the repository’s .claude/settings.json');
    const toggles = [...container.querySelectorAll<HTMLElement>('[role="switch"]')];
    expect(toggles).toHaveLength(1);
    expect(toggles[0]?.hasAttribute('data-disabled')).toBe(true);
    expect(container.querySelector('[aria-label="Uninstall"]')).toBeNull();
  });

  it('[CPL-05] a failed change shows the CLI words', async () => {
    plugins.addMarketplace.mockResolvedValueOnce({
      ok: false,
      error: 'Failed to clone: Could not resolve host: github.com',
    });
    await render(createElement(ClaudePluginsSettings));
    await act(async () => button('Add the official marketplace').click());
    await settle();
    expect(text()).toContain('Could not resolve host: github.com');
  });
});

describe('ClaudeMcpSettings', () => {
  it('[CMC-01] lists servers by where they come from, with names but no values', async () => {
    mcp.state.mockResolvedValue({
      servers: [
        {
          name: 'tracker',
          origin: 'user',
          transport: 'stdio',
          target: 'npx tracker-mcp',
          envNames: ['TRACKER_TOKEN'],
          headerNames: [],
        },
        {
          name: 'github',
          origin: 'plugin',
          plugin: 'github@claude-plugins-official',
          transport: 'http',
          target: 'https://api.githubcopilot.com/mcp/',
          envNames: [],
          headerNames: ['Authorization'],
        },
      ],
    });
    await render(createElement(ClaudeMcpSettings, { repoPath: '/repo' }));
    expect(mcp.state).toHaveBeenCalledWith('/repo');
    expect(text()).toContain('npx tracker-mcp');
    expect(text()).toContain('Sets TRACKER_TOKEN');
    expect(text()).toContain('From plugin github');
    expect(text()).toContain('From the open repository and plugins');
    // Only the user layer's server can be removed here.
    expect(container.querySelectorAll('[aria-label^="Remove "]')).toHaveLength(1);
    await act(async () => button('Remove tracker').click());
    await settle();
    expect(mcp.remove).toHaveBeenCalledWith('tracker');
  });

  it('[CMC-02] reads KEY=value and Name: value lines; a line without a name is refused', () => {
    expect(parsePairs('A=1\n\n B = two=2 \n', '=')).toEqual({ A: '1', B: 'two=2' });
    expect(parsePairs('Authorization: Bearer x:y', ':')).toEqual({ Authorization: 'Bearer x:y' });
    expect(parsePairs('=1', '=')).toBeNull();
    expect(parsePairs('novalue', ':')).toBeNull();
    expect(parsePairs('', '=')).toEqual({});
  });
});
