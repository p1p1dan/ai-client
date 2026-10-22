// @vitest-environment happy-dom
/**
 * Layout 5f (ui-cohesion §6, ruling L6): the side chat on screen — its
 * title-bar button (right of the rail's divider, before the terminal), the
 * floating window and the docked column, asking from its box, closing it.
 * Rendered with the real Chinese catalog.
 */
import { translate } from '@shared/i18n';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatSessionsStore } from '@/stores/chatSessions';
import {
  type SideChatTransport,
  type SideQuestionRequest,
  setSideChatTransport,
  useSideChatStore,
} from '@/stores/sideChat';
import { SessionBar } from '../SessionBar';
import { SessionRailToggle } from '../sessionRail/SessionRailToggle';
import { SideChat } from '../sideChat/SideChat';
import { SideChatToggle } from '../sideChat/SideChatToggle';
import { INITIAL_SIDE_CHAT, type SideQuestionOutcome } from '../sideChat/sideChatModel';

const zh = (key: string, params?: Record<string, string | number>) => translate('zh', key, params);
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: zh }) }));
vi.mock('@/components/chat/sessionStartDeps', () => ({
  sessionStartEffects: {
    start: async () => ({ kind: 'refused', reason: 'no-session' }),
    isRunning: () => true,
    forgetRunning: () => undefined,
  },
}));
// The answer is drawn by the timeline's prose renderer; its text is what matters here.
vi.mock('@/components/chat/MessageTimeline', () => ({
  TurnTextItem: ({ text }: { text: string }) => createElement('div', { 'data-md': '' }, text),
}));

let root: Root | null = null;
let asked: Array<{ request: SideQuestionRequest; resolve: (o: SideQuestionOutcome) => void }> = [];

async function mount(element: ReturnType<typeof createElement>): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(element));
  return container;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  asked = [];
  const transport: SideChatTransport = {
    ask: (request) => new Promise((resolve) => asked.push({ request, resolve })),
    cancel: () => undefined,
  };
  setSideChatTransport(transport);
  useSideChatStore.setState({ ...INITIAL_SIDE_CHAT });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  setSideChatTransport(null);
  vi.unstubAllGlobals();
});

describe('the title bar’s side chat button', () => {
  it('sits right of the rail’s divider and before the terminal', async () => {
    useChatSessionsStore.setState({
      activeSessionId: 's1',
      sessions: [
        { id: 's1', projectId: 'p1', workspaceId: 'w1', title: 's1', status: 'idle', updatedAt: 0 },
      ],
    });
    const container = await mount(
      createElement(SessionBar, {
        sessionRailToggle: createElement('span', { 'data-rail-probe': '' }),
        sideChatToggle: createElement('span', { 'data-side-probe': '' }),
        terminalState: 'closed',
        onToggleTerminal: () => undefined,
      })
    );
    const divider = container.querySelector('[data-rail-probe]')?.nextElementSibling;
    expect(divider?.className).toContain('w-px');
    expect(divider?.nextElementSibling?.hasAttribute('data-side-probe')).toBe(true);
    const side = container.querySelector('[data-side-probe]');
    const terminal = container.querySelector('[data-session-terminal]');
    expect(
      side && terminal && side.compareDocumentPosition(terminal) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('is pressed while the side chat is open and names its chord', async () => {
    const onToggle = vi.fn();
    const container = await mount(
      createElement(SideChatToggle, { open: true, onToggle, isMac: false })
    );
    const button = container.querySelector<HTMLButtonElement>('[data-side-chat-toggle]');
    expect(button?.getAttribute('aria-pressed')).toBe('true');
    expect(button?.getAttribute('aria-label')).toBe('旁问 (Ctrl+;)');
    await act(async () => button?.click());
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});

describe('the side chat window', () => {
  it('floats with the note, asks from its box, and shows the answer', async () => {
    useSideChatStore.getState().openFor('s1');
    const container = await mount(createElement(SideChat, { placement: 'float' }));
    const section = container.querySelector<HTMLElement>('[data-side-chat]');
    expect(section?.getAttribute('data-side-chat')).toBe('float');
    expect(section?.className).toContain('absolute');
    expect(container.textContent).toContain('关掉即丢弃');
    const input = container.querySelector<HTMLTextAreaElement>('[data-side-chat-input]');
    expect(document.activeElement).toBe(input);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(input, '改了哪些文件？');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(asked[0]?.request).toMatchObject({ sessionId: 's1', question: '改了哪些文件？' });
    expect(container.querySelector('[data-side-chat-entry="pending"]')).not.toBeNull();
    await act(async () => asked[0]?.resolve({ kind: 'answer', text: '两个文件' }));
    expect(container.querySelector('[data-side-chat-entry="answered"]')?.textContent).toContain(
      '两个文件'
    );
  });

  it('docks and floats back from its header; ✕ and Esc close and discard it', async () => {
    useSideChatStore.getState().ask('s1', 'q?');
    const container = await mount(createElement(SideChat, { placement: 'float' }));
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-side-chat-form="dock"]')?.click()
    );
    expect(useSideChatStore.getState().form).toBe('dock');
    await act(async () => root?.render(createElement(SideChat, { placement: 'dock' })));
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-side-chat-form="float"]')?.click()
    );
    expect(useSideChatStore.getState().form).toBe('float');
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-side-chat-close]')?.click()
    );
    expect(useSideChatStore.getState()).toMatchObject({ open: false, entries: [] });

    useSideChatStore.getState().openFor('s1');
    await act(async () => root?.render(createElement(SideChat, { placement: 'float' })));
    await act(async () => {
      container
        .querySelector('[data-side-chat-input]')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(useSideChatStore.getState().open).toBe(false);
  });
});

describe('the session rail toggle while the side chat is docked', () => {
  it('is disabled and says why', async () => {
    const container = await mount(
      createElement(SessionRailToggle, {
        visibility: { visible: false, hidden: 'side-chat' },
        onToggle: () => undefined,
      })
    );
    const button = container.querySelector<HTMLButtonElement>('[data-session-rail-toggle]');
    expect(button?.disabled).toBe(true);
    expect(button?.getAttribute('aria-label')).toBe('旁问停靠在右侧时，会话侧栏让位');
  });
});
