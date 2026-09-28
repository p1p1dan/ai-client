// @vitest-environment happy-dom
import type { LegacyAssetNoticeState, LegacyAssetReport } from '@shared/legacyAssets';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * dsh-rebase P1-16e (decision 104) — the legacy-asset notice, mounted.
 *
 * The detection rules are pinned in Main's own tests; what a mount adds is
 * the part only a render can answer: does the startup dialog open for the
 * right person, stay shut for everyone else, and remember that it was seen —
 * and does the Settings entry show the same list whether or not it was.
 */

// Anything that imports `useSettingsStore` triggers zustand persist's
// rehydrate at module-evaluation time, through `window.electronAPI.settings`.
// Without that stub from the very start the hydrate promise never settles and
// the suite hangs, so it lives in `vi.hoisted`, not `beforeEach`.
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

import { resetModalQueueForTests } from '@/stores/modalQueue';
import { LegacyAssetNoticePrompt } from '../LegacyAssetNotice';
import { LegacyAssetsSettings } from '../LegacyAssetsSettings';

const EMPTY: LegacyAssetReport = {
  agentDir: '/home/u/.pilab/p/pi-agent',
  instructionTarget: '/home/u/.pilab/p/pi-agent/AGENTS.md',
  skillsTarget: '/home/u/.pilab/p/pi-agent/skills',
  workspace: null,
  subagents: [],
  promptTemplates: [],
  instructionFile: null,
  mcpConfigs: [],
  skills: [],
  delegationSwitchOff: false,
};

const FOUND: LegacyAssetReport = {
  ...EMPTY,
  workspace: '/work/repo',
  subagents: [{ name: 'helper', path: '/home/u/.pilab/p/pi-agent/subagents/helper.md' }],
  promptTemplates: [
    { name: 'review', path: '/home/u/.pilab/p/pi-agent/prompts/review.md', scope: 'user' },
  ],
  instructionFile: '/home/u/.claude/CLAUDE.md',
  mcpConfigs: [
    {
      path: '/home/u/.pilab/p/pi-agent/mcp.json',
      scope: 'user',
      servers: ['github', 'fs'],
      unreadable: false,
    },
  ],
  skills: [
    {
      name: 'Some_Thing',
      path: '/work/repo/.pi/skills/Some_Thing/SKILL.md',
      issues: ['unscanned-root', 'missing-name'],
    },
  ],
  delegationSwitchOff: true,
};

const api = {
  inspect: vi.fn<(request?: { cwd?: string }) => Promise<LegacyAssetNoticeState>>(),
  markSeen: vi.fn(async () => undefined),
  openAgentDir: vi.fn(async () => undefined),
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  resetModalQueueForTests();
  api.inspect.mockResolvedValue({ report: FOUND, seen: false });
  window.electronAPI = {
    ...window.electronAPI,
    legacyAssets: api,
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

function text(): string {
  return document.body.textContent ?? '';
}

function button(label: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll('button')].find((node) =>
    node.textContent?.includes(label)
  );
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function render(element: ReturnType<typeof createElement>): Promise<void> {
  await act(() => root.render(element));
  await settle();
}

const TITLE = 'Some things from the previous version no longer apply';

describe('LegacyAssetNoticePrompt — the startup dialog', () => {
  it('[LAN-01] opens once for an unseen notice with something to list', async () => {
    await render(createElement(LegacyAssetNoticePrompt, { repoPath: '/work/repo' }));
    expect(text()).toContain(TITLE);
    expect(text()).toContain('helper');
    expect(text()).toContain('/review');
    expect(text()).toContain('/home/u/.claude/CLAUDE.md');
    expect(text()).toContain('/home/u/.pilab/p/pi-agent/AGENTS.md');
    expect(text()).toContain('github, fs');
    expect(text()).toContain('In a folder this version does not scan · No name in its frontmatter');
    expect(text()).toContain('In this version sub-agents are always available.');
    expect(api.markSeen).not.toHaveBeenCalled();
  });

  it('[LAN-02] records "seen" when the user closes it', async () => {
    await render(createElement(LegacyAssetNoticePrompt, { repoPath: '/work/repo' }));
    const gotIt = button('Got it');
    expect(gotIt).toBeDefined();
    await act(async () => gotIt?.click());
    await settle();
    expect(api.markSeen).toHaveBeenCalledTimes(1);
  });

  it('[LAN-03] stays shut once seen', async () => {
    api.inspect.mockResolvedValue({ report: FOUND, seen: true });
    await render(createElement(LegacyAssetNoticePrompt, { repoPath: '/work/repo' }));
    expect(text()).not.toContain(TITLE);
    expect(api.markSeen).not.toHaveBeenCalled();
  });

  it('[LAN-04] stays shut, and records nothing, when nothing was found', async () => {
    api.inspect.mockResolvedValue({ report: EMPTY, seen: false });
    await render(createElement(LegacyAssetNoticePrompt, {}));
    expect(text()).not.toContain(TITLE);
    expect(api.markSeen).not.toHaveBeenCalled();
  });

  it('[LAN-05] checks the open workspace, and only the user level without one', async () => {
    await render(createElement(LegacyAssetNoticePrompt, { repoPath: '/work/repo' }));
    expect(api.inspect).toHaveBeenLastCalledWith({ cwd: '/work/repo' });
    await act(() => root.unmount());
    root = createRoot(container);
    resetModalQueueForTests();
    await render(createElement(LegacyAssetNoticePrompt, {}));
    expect(api.inspect).toHaveBeenLastCalledWith({});
  });

  it('[LAN-06] does not ask again for another workspace once it has been shown', async () => {
    await render(createElement(LegacyAssetNoticePrompt, { repoPath: '/work/repo' }));
    await render(createElement(LegacyAssetNoticePrompt, { repoPath: '/work/other' }));
    expect(api.inspect).toHaveBeenCalledTimes(1);
  });

  it('[LAN-07] opens the agent folder from the dialog', async () => {
    await render(createElement(LegacyAssetNoticePrompt, { repoPath: '/work/repo' }));
    await act(async () => button('Open agent folder')?.click());
    await settle();
    expect(api.openAgentDir).toHaveBeenCalledTimes(1);
    expect(api.markSeen).not.toHaveBeenCalled();
  });
});

describe('LegacyAssetsSettings — the permanent entry', () => {
  it('[LAS-01] lists the same items even after the notice was seen', async () => {
    api.inspect.mockResolvedValue({ report: FOUND, seen: true });
    await render(createElement(LegacyAssetsSettings, { repoPath: '/work/repo' }));
    expect(api.inspect).toHaveBeenCalledWith({ cwd: '/work/repo' });
    expect(text()).toContain('Items from the previous version');
    expect(text()).toContain('helper');
    expect(text()).toContain('Project files were checked in /work/repo.');
    expect(api.markSeen).not.toHaveBeenCalled();
  });

  it('[LAS-02] says so when nothing was found, and how to include a project', async () => {
    api.inspect.mockResolvedValue({ report: EMPTY, seen: false });
    await render(createElement(LegacyAssetsSettings, {}));
    expect(api.inspect).toHaveBeenCalledWith({});
    expect(text()).toContain('Nothing from the previous version was found.');
    expect(text()).toContain('Open a workspace to also check its project files.');
    expect(button('Open agent folder')).toBeUndefined();
  });

  it('[LAS-03] shows a failed check instead of an empty list', async () => {
    api.inspect.mockRejectedValue(new Error('disk on fire'));
    await render(createElement(LegacyAssetsSettings, {}));
    expect(text()).toContain('disk on fire');
    expect(text()).not.toContain('Nothing from the previous version was found.');
  });
});
