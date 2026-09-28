// @vitest-environment happy-dom
/**
 * dsh-rebase P1-7a (decisions 068/109, 111, 118): the todo card and the goal
 * bar, mounted for real above a session — what they say in each state the
 * prototype draws, that their buttons run DSH's `/goal …` out of band, and that
 * a goal no live worker holds shows without buttons.
 *
 * The `electronAPI` stub is hoisted: zustand's persisted stores rehydrate at
 * import and read `settings`, and a stub installed later hangs the suite.
 */

import { englishTranslate } from '@shared/i18n';
import type { DshGoalProjection } from '@shared/types/runtimeEvents';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { useSessionPanelsStore } from '@/stores/sessionPanels';
import { SessionPanelStrips } from '../SessionPanelStrips';

const api = vi.hoisted(() => {
  const chat = {
    onRuntimeEvent: () => () => undefined,
    getSessionPanels: async () => ({ projections: [] }),
    runSessionCommand: async (_payload: unknown) => ({ ok: true as const }),
  };
  window.electronAPI = {
    env: { platform: 'linux' },
    settings: { read: async () => null, write: async () => undefined },
    app: { setLanguage: () => undefined, setProxy: () => undefined },
    chat,
  } as unknown as typeof window.electronAPI;
  return { chat };
});
vi.mock('@/utils/logging', () => ({ updateRendererLogging: vi.fn() }));
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: englishTranslate, locale: 'en' }) }));

function goal(
  phase: DshGoalProjection['goal']['phase'],
  extra: Partial<DshGoalProjection['goal']> = {}
): DshGoalProjection {
  return {
    goal: {
      id: 'goal-1',
      revision: 2,
      objective: 'Get CI green and commit the fix',
      phase,
      maxGoalRounds: 256,
      ...extra,
    },
    roundsStarted: 3,
    createdAt: 1_790_000_000_000,
    updatedAt: 1_790_000_300_000,
  };
}

function setPanels(panels: Record<string, unknown>, live = true) {
  useSessionPanelsStore.setState({
    bySession: { s1: { live, seq: { todos: 1 }, ...panels } },
    open: {},
    dismissed: {},
    commandPending: {},
  });
}

let root: Root | undefined;
let container: HTMLDivElement;

async function render() {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(createElement(SessionPanelStrips, { sessionId: 's1' })));
}

function buttonNamed(text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === text
  ) as HTMLButtonElement | undefined;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useChatSessionsStore.setState({
    sessions: [
      {
        id: 's1',
        projectId: 'p1',
        workspaceId: 'w1',
        title: 's1',
        status: 'running',
        updatedAt: 0,
      },
    ],
  });
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the todo card and the goal bar (P1-7a)', () => {
  it('[P7A-MOUNT-B] scene B: todo 3/5 doing one, goal running with Pause; Pause runs /goal pause', async () => {
    const run = vi.spyOn(api.chat, 'runSessionCommand');
    setPanels({
      todos: [
        { content: 'read the log', status: 'completed' },
        { content: 'fix the branch', status: 'completed' },
        { content: 'add tests', status: 'completed' },
        { content: 'run the full suite', status: 'in_progress' },
        { content: 'commit', status: 'pending' },
      ],
      goal: goal('active'),
      goalActivation: { goalId: 'goal-1', revision: 2, activation: 'armed' },
    });
    await render();

    const todo = container.querySelector('[data-testid="todo-card"]');
    expect(todo?.textContent).toContain('Todo 3/5 · Doing: run the full suite');
    const bar = container.querySelector('[data-testid="goal-bar"]');
    expect(bar?.getAttribute('data-state')).toBe('running');
    expect(bar?.textContent).toContain('Goal · Round 3/256 · In progress · Get CI green');
    // Todo above goal, as the prototype stacks them.
    expect(
      todo && bar ? todo.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING : 0
    ).toBeTruthy();

    await act(async () => buttonNamed('Pause')?.click());
    expect(run).toHaveBeenCalledWith({ sessionId: 's1', line: '/goal pause' });
  });

  it('[P7A-MOUNT-OPEN] each strip opens in place: the list, and the whole objective with its times', async () => {
    setPanels({
      todos: [
        { content: 'done thing', status: 'completed' },
        { content: 'next thing', status: 'pending' },
      ],
      goal: goal('paused'),
    });
    await render();
    expect(container.querySelectorAll('li')).toHaveLength(0);

    const [todoToggle, goalToggle] = [...container.querySelectorAll('button[aria-expanded]')];
    await act(async () => (todoToggle as HTMLButtonElement).click());
    const items = [...container.querySelectorAll('li')];
    expect(items.map((item) => item.getAttribute('data-status'))).toEqual(['completed', 'pending']);
    expect(items[0]?.querySelector('.line-through')?.textContent).toBe('done thing');

    await act(async () => (goalToggle as HTMLButtonElement).click());
    const bar = container.querySelector('[data-testid="goal-bar"]');
    expect(bar?.getAttribute('data-state')).toBe('paused');
    expect(bar?.textContent).toContain('Goal paused · Round 3/256');
    expect(bar?.textContent).toContain('Set at');
    expect(buttonNamed('Resume')).toBeDefined();
  });

  it('[P7A-MOUNT-SUSPENDED] disarmed: suspended with Resume; round limit: Resume disabled', async () => {
    const run = vi.spyOn(api.chat, 'runSessionCommand');
    setPanels({
      goal: goal('active'),
      goalActivation: { goalId: 'goal-1', revision: 2, activation: 'disarmed' },
    });
    await render();
    const bar = () => container.querySelector('[data-testid="goal-bar"]');
    expect(bar()?.getAttribute('data-state')).toBe('suspended');
    expect(bar()?.textContent).toContain('Goal suspended');
    await act(async () => buttonNamed('Resume')?.click());
    expect(run).toHaveBeenCalledWith({ sessionId: 's1', line: '/goal resume' });

    await act(async () =>
      setPanels({
        goal: {
          ...goal('blocked', {
            blockedReason: { code: 'round-limit', message: 'spent' },
            maxGoalRounds: 3,
          }),
        },
      })
    );
    expect(bar()?.getAttribute('data-state')).toBe('roundLimit');
    expect(bar()?.textContent).toContain('Goal used all 3 rounds');
    expect(buttonNamed('Resume')?.disabled).toBe(true);
  });

  it('[P7A-MOUNT-READONLY] a goal no live worker holds shows without its buttons; nothing to show, no strips', async () => {
    setPanels({ goal: goal('paused') }, false);
    await render();
    expect(container.querySelector('[data-testid="goal-bar"]')).not.toBeNull();
    expect(buttonNamed('Resume')).toBeUndefined();
    expect(buttonNamed('Pause')).toBeUndefined();

    await act(async () => setPanels({ todos: null, goal: null }));
    expect(container.querySelector('[data-testid="session-panel-strips"]')).toBeNull();
  });

  it('[P7A-MOUNT-COMPLETE] complete: put away until the goal changes', async () => {
    setPanels({ goal: goal('complete') });
    await render();
    expect(container.querySelector('[data-testid="goal-bar"]')?.textContent).toContain(
      'Goal complete · 3 rounds in all'
    );
    await act(async () => buttonNamed('Put away')?.click());
    expect(container.querySelector('[data-testid="goal-bar"]')).toBeNull();
  });
});
