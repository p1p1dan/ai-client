// @vitest-environment happy-dom
/**
 * Decision 209 §5: title-bar buttons that do not fit move into ⋮, from the
 * right, as ticked entries; the rail's entry is already there and is not
 * repeated. Rendered with the real Chinese catalog. (No window buttons here:
 * the stub bridge has no window API, so the bar ends in `pr-2`.)
 */
import { translate } from '@shared/i18n';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { SessionBar } from '../SessionBar';
import type { PaneKind } from '../workPanelModel';

vi.hoisted(() => {
  window.electronAPI = {
    env: { platform: 'linux' },
    settings: { read: async () => null, write: async () => undefined },
    app: { setLanguage: () => undefined, setProxy: () => undefined },
  } as unknown as typeof window.electronAPI;
});
const zh = (key: string, params?: Record<string, string | number>) => translate('zh', key, params);
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: zh }) }));
// SessionBar mounts the tree dialog, whose start path pulls in the settings
// store; stubbed as `sessionBranchesEntry.test.ts` does.
vi.mock('@/components/chat/sessionStartDeps', () => ({
  sessionStartEffects: {
    start: async () => ({ kind: 'refused', reason: 'no-session' }),
    isRunning: () => true,
    forgetRunning: () => undefined,
  },
}));

let root: Root | null = null;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useChatSessionsStore.setState({
    activeSessionId: 's1',
    sessions: [
      { id: 's1', projectId: 'p1', workspaceId: 'w1', title: 's1', status: 'idle', updatedAt: 0 },
    ],
    projects: [{ id: 'p1', name: 'proj' }],
    workspaces: [
      { id: 'w1', projectId: 'p1', name: 'repo', kind: 'main', path: '/repo', branch: 'main' },
    ],
  });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

async function renderBar(barWidth: number | null, openPanes: PaneKind[] = ['files']) {
  const onTogglePane = vi.fn();
  const onToggleTerminal = vi.fn();
  const onToggleSideChat = vi.fn();
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      createElement(SessionBar, {
        barWidth,
        openPanes,
        onTogglePane,
        onOpenPane: () => undefined,
        review: { count: 2, added: 3, removed: 1 },
        terminalState: 'closed',
        onToggleTerminal,
        sessionRailToggle: createElement('span', { 'data-rail-probe': '' }),
        sideChatToggle: createElement('span', { 'data-side-probe': '' }),
        sessionRail: {
          visible: false,
          label: zh('Show session rail'),
          disabled: false,
          onToggle: () => undefined,
        },
        sideChat: { open: true, label: '旁问 (Ctrl+;)', onToggle: onToggleSideChat },
      })
    )
  );
  const trigger = container.querySelector<HTMLElement>(`[aria-label="${zh('More actions')}"]`);
  const openMenu = async () => act(async () => trigger?.click());
  return { container, openMenu, onTogglePane, onToggleTerminal, onToggleSideChat };
}

describe('SessionBar on a narrow bar (decision 209 §5)', () => {
  it('unmeasured: every button on the bar, nothing extra in ⋮', async () => {
    const { container, openMenu } = await renderBar(null);
    expect(container.querySelector('[data-rail-probe]')).not.toBeNull();
    expect(container.querySelector('[data-side-probe]')).not.toBeNull();
    expect(container.querySelector('[data-session-terminal]')).not.toBeNull();
    expect(container.querySelector('[data-panel-toggle="changes"]')).not.toBeNull();
    expect(container.querySelector('[data-panel-toggle="files"]')).not.toBeNull();
    await openMenu();
    expect(document.querySelector('[data-bar-overflow]')).toBeNull();
  });

  it('300 wide: changes and files move into ⋮, ticked as their panes are', async () => {
    const { container, openMenu, onTogglePane } = await renderBar(300);
    expect(container.querySelector('[data-session-terminal]')).not.toBeNull();
    expect(container.querySelector('[data-panel-toggle="changes"]')).toBeNull();
    expect(container.querySelector('[data-panel-toggle="files"]')).toBeNull();
    await openMenu();
    const items = [...document.querySelectorAll<HTMLElement>('[data-bar-overflow-item]')];
    expect(items.map((item) => item.dataset.barOverflowItem)).toEqual(['changes', 'files']);
    expect(items[0]?.textContent).toContain('+3 −1');
    expect(items[0]?.getAttribute('aria-checked')).toBe('false');
    expect(items[1]?.getAttribute('aria-checked')).toBe('true');
    await act(async () => items[1]?.click());
    expect(onTogglePane).toHaveBeenCalledWith('files');
  });

  it('too narrow for any button: all of them in ⋮, the rail entry not repeated', async () => {
    const { container, openMenu, onToggleSideChat } = await renderBar(200);
    expect(container.querySelector('[data-rail-probe]')).toBeNull();
    expect(container.querySelector('[data-side-probe]')).toBeNull();
    expect(container.querySelector('[data-session-terminal]')).toBeNull();
    // The divider leaves with the rail toggle.
    expect(container.querySelector('.w-px')).toBeNull();
    await openMenu();
    const items = [...document.querySelectorAll<HTMLElement>('[data-bar-overflow-item]')];
    expect(items.map((item) => item.dataset.barOverflowItem)).toEqual([
      'side-chat',
      'terminal',
      'changes',
      'files',
    ]);
    expect(document.querySelectorAll('[data-session-rail-item]')).toHaveLength(1);
    expect(items[0]?.getAttribute('aria-checked')).toBe('true');
    await act(async () => items[0]?.click());
    expect(onToggleSideChat).toHaveBeenCalledTimes(1);
  });

  it('the terminal entry toggles the terminal', async () => {
    const { openMenu, onToggleTerminal } = await renderBar(200);
    await openMenu();
    const item = document.querySelector<HTMLElement>('[data-bar-overflow-item="terminal"]');
    expect(item?.textContent).toContain(zh('Terminal'));
    await act(async () => item?.click());
    expect(onToggleTerminal).toHaveBeenCalledTimes(1);
  });
});
