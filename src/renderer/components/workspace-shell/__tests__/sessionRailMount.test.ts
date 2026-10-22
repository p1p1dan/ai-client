// @vitest-environment happy-dom
/**
 * Layout 5e (ui-cohesion §6, ruling L5): the session rail's toggle, a card's
 * fold, and the title bar's ⋮ menu dropping the environment items while the
 * rail shows them. Rendered with the real Chinese catalog.
 */
import { translate } from '@shared/i18n';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { useSessionRailStore } from '@/stores/sessionRail';
import { SessionBar } from '../SessionBar';
import { RailCard } from '../sessionRail/RailCard';
import { SessionRailToggle } from '../sessionRail/SessionRailToggle';
import type { SessionRailVisibility } from '../sessionRail/sessionRailModel';

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

async function mount(element: ReturnType<typeof createElement>): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(element));
  return container;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  useSessionRailStore.setState({ shown: true, cardOpen: {} });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('SessionRailToggle', () => {
  const shown: SessionRailVisibility = { visible: true, hidden: null };

  it('pressed while the rail shows; a click toggles the choice', async () => {
    const onToggle = vi.fn();
    const container = await mount(
      createElement(SessionRailToggle, { visibility: shown, onToggle })
    );
    const button = container.querySelector<HTMLButtonElement>('[data-session-rail-toggle]');
    expect(button?.getAttribute('aria-pressed')).toBe('true');
    expect(button?.getAttribute('aria-label')).toBe('隐藏会话侧栏');
    await act(async () => button?.click());
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('not pressed, 「显示会话侧栏」, when the user hid it', async () => {
    const container = await mount(
      createElement(SessionRailToggle, {
        visibility: { visible: false, hidden: 'user' },
        onToggle: () => undefined,
      })
    );
    const button = container.querySelector<HTMLButtonElement>('[data-session-rail-toggle]');
    expect(button?.getAttribute('aria-pressed')).toBe('false');
    expect(button?.getAttribute('aria-label')).toBe('显示会话侧栏');
  });

  it('disabled, with the reason, while a pane holds the room', async () => {
    const onToggle = vi.fn();
    const container = await mount(
      createElement(SessionRailToggle, {
        visibility: { visible: false, hidden: 'panes' },
        onToggle,
      })
    );
    const button = container.querySelector<HTMLButtonElement>('[data-session-rail-toggle]');
    expect(button?.disabled).toBe(true);
    expect(button?.getAttribute('aria-label')).toBe(
      zh('The session rail makes room while a pane is open')
    );
    await act(async () => button?.click());
    expect(onToggle).not.toHaveBeenCalled();
  });
});

describe('RailCard', () => {
  it('folds from its header and remembers the fold', async () => {
    const container = await mount(
      createElement(RailCard, { id: 'todo', title: '待办', summary: '1 / 3' }, 'BODY')
    );
    const header = container.querySelector<HTMLButtonElement>('[aria-expanded]');
    expect(header?.getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('BODY');
    expect(container.textContent).toContain('1 / 3');
    await act(async () => header?.click());
    expect(header?.getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).not.toContain('BODY');
    expect(useSessionRailStore.getState().cardOpen.todo).toBe(false);
    expect(localStorage.getItem('aiclient-session-rail')).toContain('"todo":false');
  });

  it('the context card starts folded', async () => {
    const container = await mount(
      createElement(RailCard, { id: 'context', title: '上下文' }, 'BODY')
    );
    expect(container.textContent).not.toContain('BODY');
  });
});

describe('SessionBar ⋮ with the session rail (layout 5e)', () => {
  function seed() {
    useChatSessionsStore.setState({
      activeSessionId: 's1',
      sessions: [
        { id: 's1', projectId: 'p1', workspaceId: 'w1', title: 's1', status: 'idle', updatedAt: 0 },
      ],
      projects: [{ id: 'p1', name: 'proj' }],
      workspaces: [
        {
          id: 'w1',
          projectId: 'p1',
          name: 'repo',
          kind: 'main',
          path: '/repo/path',
          branch: 'main',
        },
      ],
    });
  }

  async function openMenu(rail: { visible: boolean; disabled: boolean }) {
    seed();
    const onToggle = vi.fn();
    const container = await mount(
      createElement(SessionBar, {
        sessionRailToggle: createElement('span', { 'data-slot-probe': '' }),
        sessionRail: { ...rail, label: zh('Hide session rail'), onToggle },
      })
    );
    const trigger = container.querySelector<HTMLElement>(`[aria-label="${zh('More actions')}"]`);
    await act(async () => trigger?.click());
    return { container, onToggle };
  }

  it('the toggle sits in the right-hand group, before the divider', async () => {
    const { container } = await openMenu({ visible: true, disabled: false });
    const probe = container.querySelector('[data-slot-probe]');
    expect(probe?.nextElementSibling?.className).toContain('w-px');
  });

  it('while the rail shows, the menu drops the repository / branch / folder', async () => {
    const { onToggle } = await openMenu({ visible: true, disabled: false });
    expect(document.body.textContent).not.toContain('/repo/path');
    const item = document.querySelector<HTMLElement>('[data-session-rail-item]');
    expect(item?.textContent).toContain('隐藏会话侧栏');
    await act(async () => item?.click());
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('while it does not, they stay in the menu', async () => {
    await openMenu({ visible: false, disabled: true });
    expect(document.body.textContent).toContain('/repo/path');
    expect(document.body.textContent).toContain('proj');
    const item = document.querySelector<HTMLElement>('[data-session-rail-item]');
    expect(
      item?.hasAttribute('data-disabled') || item?.getAttribute('aria-disabled') === 'true'
    ).toBe(true);
  });
});
