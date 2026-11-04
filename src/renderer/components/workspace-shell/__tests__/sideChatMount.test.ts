// @vitest-environment happy-dom
/**
 * Layout 5f (ui-cohesion §6, ruling L6): the side chat on screen — its
 * title-bar button (right of the rail's divider, before the terminal), its
 * own window's content (decision 209 §3) and the docked column, asking from
 * its box, closing it. Rendered with the real Chinese catalog.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { translate } from '@shared/i18n';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stripComments } from '@/components/chat/__tests__/stripComments';
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

const SHELL_DIR = join(process.cwd(), 'src/renderer/components/workspace-shell');
const code = (file: string) =>
  stripComments(readFileSync(join(SHELL_DIR, file), 'utf8'), join(SHELL_DIR, file));

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
  it('fills its own window with the note, asks from its box, and shows the answer', async () => {
    useSideChatStore.getState().openFor('s1');
    const container = await mount(createElement(SideChat, { placement: 'window' }));
    const section = container.querySelector<HTMLElement>('[data-side-chat]');
    expect(section?.getAttribute('data-side-chat')).toBe('window');
    expect(section?.className).toContain('h-full');
    // Frameless: the header drags the window; its buttons name themselves natively.
    expect(section?.querySelector('header')?.className).toContain('drag-region');
    const dock = container.querySelector<HTMLButtonElement>('[data-side-chat-form="dock"]');
    expect(dock?.title).toBe('停靠到主窗口右侧');
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

  it('docks and pops out again from its header; ✕ and Esc close and discard it', async () => {
    useSideChatStore.getState().ask('s1', 'q?');
    const container = await mount(createElement(SideChat, { placement: 'window' }));
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-side-chat-form="dock"]')?.click()
    );
    expect(useSideChatStore.getState().form).toBe('dock');
    await act(async () => root?.render(createElement(SideChat, { placement: 'dock' })));
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-side-chat-form="window"]')?.click()
    );
    expect(useSideChatStore.getState().form).toBe('window');
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-side-chat-close]')?.click()
    );
    expect(useSideChatStore.getState()).toMatchObject({ open: false, entries: [] });

    // Still mounted (drawing nothing): reopening re-renders it.
    await act(async () => useSideChatStore.getState().openFor('s1'));
    await act(async () => root?.render(createElement(SideChat, { placement: 'window' })));
    await act(async () => {
      container
        .querySelector('[data-side-chat-input]')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(useSideChatStore.getState().open).toBe(false);
  });
});

describe('the conversation it reads (decision 209 ruling 4)', () => {
  it('names it in the title, and says so while the main window shows another', async () => {
    useChatSessionsStore.setState({
      activeSessionId: 's1',
      sessions: [
        {
          id: 's1',
          projectId: 'p',
          workspaceId: 'w',
          title: '登录改版',
          status: 'idle',
          updatedAt: 0,
        },
        { id: 's2', projectId: 'p', workspaceId: 'w', title: '别的', status: 'idle', updatedAt: 0 },
      ],
    } as never);
    useSideChatStore.getState().openFor('s1');
    const container = await mount(createElement(SideChat, { placement: 'dock' }));
    expect(container.querySelector('[data-side-chat-title]')?.textContent).toBe('旁问 · 登录改版');
    expect(container.querySelector('[data-side-chat-elsewhere]')).toBeNull();
    await act(async () => useChatSessionsStore.setState({ activeSessionId: 's2' }));
    expect(useSideChatStore.getState()).toMatchObject({ open: true, sessionId: 's1' });
    expect(container.querySelector('[data-side-chat-elsewhere]')?.textContent).toBe(
      '它读的是「登录改版」，不是主窗口正开着的对话。'
    );
  });

  it('lies over the chat while docked with no room beside it', async () => {
    useSideChatStore.getState().openFor('s1');
    const container = await mount(createElement(SideChat, { placement: 'dock-over' }));
    const section = container.querySelector<HTMLElement>('[data-side-chat]');
    expect(section?.className).toContain('absolute');
    expect(section?.style.width).toBe('380px');
    // The panes beside it keep their resize handle above it (PaneArea's `z-20`, later).
    expect(section?.className.split(' ')).toContain('z-20');
  });

  it('stays on top while the panes cover the chat as a drawer too', async () => {
    // Real-app check, decision 209: at 1000 wide with the editor open, the
    // drawer (same layer, later in the row) hid the docked side chat entirely.
    expect(code('PaneArea.tsx')).toContain("overlay && 'absolute inset-y-0 right-0 z-20 elev-lg'");
    expect(code('WorkspaceShell.tsx')).toContain(
      'overDrawer={allocation.editorOverlay && !paneView.expanded}'
    );
    useSideChatStore.getState().openFor('s1');
    const container = await mount(
      createElement(SideChat, { placement: 'dock-over', overDrawer: true })
    );
    const classes = container.querySelector<HTMLElement>('[data-side-chat]')?.className.split(' ');
    expect(classes).toContain('z-30');
    expect(classes).not.toContain('z-20');
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

  it('yields whether the side chat sits beside the conversation or lies over it', () => {
    // Real-app check, decision 209: at 1100 wide with no panes the rail came
    // back, and the side chat lay over a conversation squeezed beside it.
    const shell = code('WorkspaceShell.tsx');
    expect(shell).toContain(
      "sideChatDocked: sideChatPlacement === 'dock' || sideChatPlacement === 'dock-over'"
    );
    expect(shell).toContain('const railFits = fit.railFits;');
  });
});
