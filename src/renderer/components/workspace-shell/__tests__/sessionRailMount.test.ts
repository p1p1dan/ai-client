// @vitest-environment happy-dom
/**
 * Layout 5e (ui-cohesion §6, ruling L5): the session rail's toggle, a card's
 * fold, and the title bar's ⋮ menu dropping the environment items while the
 * rail shows them. Rendered with the real Chinese catalog.
 */
import { translate } from '@shared/i18n';
import { act, type ComponentProps, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { useSessionRailStore } from '@/stores/sessionRail';
import { stopBackgroundTask } from '../panes/BackgroundTasksPane';
import { SessionBar } from '../SessionBar';
import { RailCard } from '../sessionRail/RailCard';
import { SessionRailToggle } from '../sessionRail/SessionRailToggle';
import { SubagentsCard } from '../sessionRail/SubagentsCard';
import type { SessionRailVisibility } from '../sessionRail/sessionRailModel';
import type { SubagentCardRow, SubagentsCardView } from '../sessionRail/subagentsCardModel';

/** A RailCard with a fixed body, built without a `children` prop (lint) and typed. */
function railCard(props: Omit<ComponentProps<typeof RailCard>, 'children'>) {
  return createElement(RailCard, { ...props, children: 'BODY' } as ComponentProps<typeof RailCard>);
}

// The subagents card's dialog and the tasks pane's stop pull in stores that
// read the preload at import (decision 207 §14 E): a minimal bridge.
const api = vi.hoisted(() => {
  const chat = { interruptSubagent: async (_payload: unknown) => ({ interrupted: true }) };
  window.electronAPI = {
    env: { platform: 'linux' },
    settings: { read: async () => null, write: async () => undefined },
    app: { setLanguage: () => undefined, setProxy: () => undefined },
    chat,
  } as unknown as typeof window.electronAPI;
  return { chat };
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

  // Decision 209 §4: an open pane no longer hides the rail; a window too
  // narrow for it (even with the panes squeezed) does.
  it('disabled, with the reason, while the window is too narrow for it', async () => {
    const onToggle = vi.fn();
    const container = await mount(
      createElement(SessionRailToggle, {
        visibility: { visible: false, hidden: 'narrow' },
        onToggle,
      })
    );
    const button = container.querySelector<HTMLButtonElement>('[data-session-rail-toggle]');
    expect(button?.disabled).toBe(true);
    expect(button?.getAttribute('aria-label')).toBe(
      zh('The window is too narrow for the session rail')
    );
    await act(async () => button?.click());
    expect(onToggle).not.toHaveBeenCalled();
  });
});

describe('RailCard', () => {
  it('folds from its header and remembers the fold', async () => {
    const container = await mount(railCard({ id: 'todo', title: '待办', summary: '1 / 3' }));
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
    const container = await mount(railCard({ id: 'context', title: '上下文' }));
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

describe('SubagentsCard (decision 207 §8, §14 E)', () => {
  function row(extra: Partial<SubagentCardRow> & { key: string; name: string }): SubagentCardRow {
    return {
      childId: extra.key.replace('lane:', 'kid-'),
      status: 'running',
      kind: '子代理 · fake-1',
      detail: '读取 src/auth/session.ts',
      duration: '1:12',
      interrupt: null,
      stop: null,
      conversation: true,
      ...extra,
    };
  }

  const login = row({
    key: 'lane:a',
    name: '调研登录',
    interrupt: { type: 'interrupt', childId: 'kid-a' },
  });
  const pay = row({
    key: 'lane:b',
    name: '调研支付',
    status: 'completed',
    detail: '用时 1:40 · 24k tokens · 12 次工具调用',
    duration: null,
  });

  function card(view: SubagentsCardView, onInterrupt = vi.fn()) {
    return createElement(SubagentsCard, { sessionId: 's1', view, onInterrupt });
  }

  function buttonsNamed(container: HTMLElement, text: string): HTMLButtonElement[] {
    return [...container.querySelectorAll<HTMLButtonElement>('button')].filter(
      (button) => button.textContent?.trim() === text
    );
  }

  it('the header reads 「子代理」 and the running count; a row has name and status', async () => {
    const container = await mount(card({ live: [login], ended: [], running: 1, waiting: 0 }));
    const section = container.querySelector('[data-rail-card="subagents"]');
    expect(section?.getAttribute('aria-label')).toBe('子代理');
    expect(section?.textContent).toContain('1 运行中');
    const rowEl = container.querySelector('[data-subagent-row]');
    expect(rowEl?.textContent).toContain('调研登录');
    expect(rowEl?.textContent).toContain('运行中');
    expect(rowEl?.textContent).toContain('子代理 · fake-1');
    expect(rowEl?.textContent).toContain('1:12');
  });

  it('a waiting child puts 「N 等你确认」 in the header', async () => {
    const waiting = row({ key: 'lane:w', name: '调研发票', status: 'waiting' });
    const container = await mount(
      card({ live: [waiting, login], ended: [], running: 1, waiting: 1 })
    );
    const header = container.querySelector('[data-rail-card="subagents"] > div');
    expect(header?.textContent).toContain('1 等你确认');
    expect(header?.textContent).not.toContain('运行中');
    expect(container.querySelector('[data-subagent-row="waiting"]')?.textContent).toContain(
      '等你确认'
    );
  });

  it('a click opens 「查看对话」「打断」, another click folds them; 打断 hands over the target', async () => {
    const onInterrupt = vi.fn();
    const container = await mount(
      card({ live: [login], ended: [], running: 1, waiting: 0 }, onInterrupt)
    );
    expect(buttonsNamed(container, '查看对话')).toHaveLength(0);
    const toggle = container.querySelector<HTMLButtonElement>('[data-subagent-row] > button');
    await act(async () => toggle?.click());
    expect(buttonsNamed(container, '查看对话')).toHaveLength(1);
    const interrupt = buttonsNamed(container, '打断');
    expect(interrupt).toHaveLength(1);
    await act(async () => interrupt[0]?.click());
    expect(onInterrupt).toHaveBeenCalledWith({ type: 'interrupt', childId: 'kid-a' });
    await act(async () => toggle?.click());
    expect(buttonsNamed(container, '查看对话')).toHaveLength(0);
  });

  it('ended children fold under 「已结束 N」; opened, an ended row offers only 「查看对话」', async () => {
    const container = await mount(card({ live: [login], ended: [pay], running: 1, waiting: 0 }));
    const ended = container.querySelector<HTMLButtonElement>('[data-rail-subagents-ended]');
    expect(ended?.textContent).toContain('已结束 1');
    expect(container.textContent).not.toContain('调研支付');
    await act(async () => ended?.click());
    const payRow = container.querySelector<HTMLElement>('[data-subagent-row="completed"]');
    expect(payRow?.textContent).toContain('调研支付');
    expect(payRow?.textContent).toContain('已完成');
    await act(async () => payRow?.querySelector<HTMLButtonElement>('button')?.click());
    expect(buttonsNamed(payRow as HTMLElement, '查看对话')).toHaveLength(1);
    expect(buttonsNamed(payRow as HTMLElement, '打断')).toHaveLength(0);
  });

  it('decision 207 §15: a Claude-engine child offers 「停止」, handing over its job', async () => {
    const onInterrupt = vi.fn();
    const research = row({
      key: 'lane:c',
      name: '调研发票',
      stop: { type: 'stop', jobId: 'task-c' },
    });
    const container = await mount(
      card({ live: [research], ended: [], running: 1, waiting: 0 }, onInterrupt)
    );
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-subagent-row] > button')?.click()
    );
    expect(buttonsNamed(container, '查看对话')).toHaveLength(1);
    expect(buttonsNamed(container, '打断')).toHaveLength(0);
    const stop = buttonsNamed(container, '停止');
    expect(stop).toHaveLength(1);
    await act(async () => stop[0]?.click());
    expect(onInterrupt).toHaveBeenCalledWith({ type: 'stop', jobId: 'task-c' });
  });

  it('the rail interrupts through the subagent interrupt call, by session and child', async () => {
    const interruptSubagent = vi.spyOn(api.chat, 'interruptSubagent');
    await stopBackgroundTask('s1', { type: 'interrupt', childId: 'kid-a' }, zh);
    expect(interruptSubagent).toHaveBeenCalledWith({ sessionId: 's1', childId: 'kid-a' });
  });
});
