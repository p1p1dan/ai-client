// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ChatSession, useChatSessionsStore } from '@/stores/chatSessions';
import { UNGROUPED_GROUP_ID, useSidebarArchiveStore } from '@/stores/sidebarArchive';
import { SIDEBAR_SESSION_DRAG_TYPE } from '../sidebarNavModel';

/**
 * Issue #26 item 7, rendered for real: a chat row dragged onto a group header
 * moves there (the same `assignSession` as the 「移到分组」 menu), and arrow
 * keys walk the list with one roving Tab stop. Stubbed like the other LeftNav
 * mount tests (`sidebarActiveAndFolders.test.ts`).
 */

vi.hoisted(() => {
  // Must be hoisted: stores rehydrate from `electronAPI` at import time.
  window.electronAPI = {
    env: { platform: 'linux' },
    settings: { read: async () => null, write: async () => undefined },
    app: { setLanguage: () => undefined },
  } as unknown as typeof window.electronAPI;
});

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) =>
      params ? key.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(params[name])) : key,
    locale: 'en',
  }),
}));
vi.mock('@/components/chat/sessionIndex/useSessionIndex', () => ({
  useSessionIndex: () => ({ refresh: async () => {}, loading: false, error: null }),
  useSessionIndexMutations: () => ({
    rename: async () => true,
    archive: async () => true,
    archiveMany: async () => 0,
    close: async () => true,
  }),
}));
vi.mock('@/components/workspace-shell/useActivateSession', () => ({
  useActivateSession: () => (sessionId: string) => {
    useChatSessionsStore.getState().selectSession(sessionId);
  },
}));
vi.mock('@/components/workspace-shell/useFolderDiffStats', () => ({
  useFolderDiffStatsPolling: () => {},
}));

const { LeftNav } = await import('../LeftNav');

const ALPHA = 'project:/repo/alpha';
const REPOS = [{ id: ALPHA, path: '/repo/alpha', name: 'alpha', addedAt: 1_800_000_000_000 }];
const NOW = Date.now();

function chat(id: string, extra: Partial<ChatSession> = {}): ChatSession {
  return {
    id,
    projectId: ALPHA,
    workspaceId: 'ws-alpha',
    title: `Chat ${id}`,
    status: 'idle',
    updatedAt: NOW,
    ...extra,
  };
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useChatSessionsStore.setState({
    projects: [{ id: ALPHA, name: 'alpha' }],
    workspaces: [
      { id: 'ws-alpha', projectId: ALPHA, name: 'Main', kind: 'main', path: '/repo/alpha' },
    ],
    sessions: [chat('a'), chat('b', { updatedAt: NOW - 1000 })],
    messages: {},
    activeSessionId: null,
    hostBoundSessionIds: [],
    unreadSessionIds: [],
    pendingPermissions: [],
  });
  useSidebarArchiveStore.setState({
    archiveMode: 'workspace',
    groups: [{ id: 'g-work', name: 'Work', createdAt: 1 }],
    assignments: {},
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(): Promise<void> {
  await act(async () => root.render(createElement(LeftNav, { repositories: REPOS as never })));
}

function row(title: string): HTMLElement {
  const node = [...container.querySelectorAll<HTMLElement>('[data-sidebar-nav="row"]')].find(
    (candidate) => candidate.textContent?.includes(title)
  );
  if (!node) throw new Error(`row ${title} not rendered`);
  return node;
}

/** A 「按分组」 header's drop zone (the div around its toggle), by group name. */
function groupHeaderZone(name: string): HTMLElement {
  const slot = [...container.querySelectorAll('[data-slot="sidebar-group-name"]')].find(
    (node) => node.textContent === name
  );
  const zone = slot?.closest('button')?.parentElement;
  if (!zone) throw new Error(`group header ${name} not rendered`);
  return zone;
}

function navItems(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[data-sidebar-nav-key]')];
}

/** A drag event carrying a stand-in DataTransfer (React copies `dataTransfer` off the native event). */
function dragEvent(type: string, sessionId?: string): Event {
  const store = new Map<string, string>(sessionId ? [[SIDEBAR_SESSION_DRAG_TYPE, sessionId]] : []);
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', {
    value: {
      types: [SIDEBAR_SESSION_DRAG_TYPE],
      setData: (format: string, value: string) => store.set(format, value),
      getData: (format: string) => store.get(format) ?? '',
      effectAllowed: 'all',
      dropEffect: 'none',
    },
  });
  return event;
}

async function key(target: HTMLElement, name: string): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
  });
}

describe('drag a chat onto a group (issue #26 item 7)', () => {
  it('moves the chat with the menu s own action, lighting only a header it can go to', async () => {
    useSidebarArchiveStore.setState({ archiveMode: 'group' });
    await render();
    const dragged = row('Chat a');
    expect(dragged.getAttribute('draggable')).toBe('true');

    await act(async () => {
      dragged.dispatchEvent(dragEvent('dragstart'));
    });
    // Its own group (「未分组」) does not take the drop.
    const own = dragEvent('dragover');
    await act(async () => {
      groupHeaderZone('Ungrouped').dispatchEvent(own);
    });
    expect(own.defaultPrevented).toBe(false);
    expect(groupHeaderZone('Ungrouped').hasAttribute('data-drop-target')).toBe(false);

    const over = dragEvent('dragover');
    await act(async () => {
      groupHeaderZone('Work').dispatchEvent(over);
    });
    expect(over.defaultPrevented).toBe(true);
    expect(groupHeaderZone('Work').hasAttribute('data-drop-target')).toBe(true);
    expect(groupHeaderZone('Work').className).toContain('ring-primary/60');

    await act(async () => {
      groupHeaderZone('Work').dispatchEvent(dragEvent('drop'));
    });
    expect(useSidebarArchiveStore.getState().assignments).toEqual({ a: 'g-work' });
    expect(groupHeaderZone('Work').hasAttribute('data-drop-target')).toBe(false);
    expect(
      container.querySelector('[data-sidebar-group="g-work"]')?.textContent?.includes('Chat a')
    ).toBe(true);

    // And back to the bucket the same way.
    await act(async () => {
      row('Chat a').dispatchEvent(dragEvent('dragstart'));
    });
    await act(async () => {
      groupHeaderZone('Ungrouped').dispatchEvent(dragEvent('dragover'));
    });
    await act(async () => {
      groupHeaderZone('Ungrouped').dispatchEvent(dragEvent('drop'));
    });
    expect(useSidebarArchiveStore.getState().assignments).toEqual({});
    expect(
      container.querySelector(`[data-sidebar-group="${UNGROUPED_GROUP_ID}"]`)?.textContent
    ).toContain('Chat a');
  });

  it('does not make rows draggable where there are no groups to move between', async () => {
    await render();
    expect(row('Chat a').hasAttribute('draggable')).toBe(false);
  });
});

describe('keyboard navigation (issue #26 item 7)', () => {
  it('has one Tab stop, on the open chat s row', async () => {
    useChatSessionsStore.setState({ activeSessionId: 'b' });
    await render();
    const tabbable = navItems().filter((item) => item.tabIndex === 0);
    expect(tabbable).toEqual([row('Chat b')]);
    expect(navItems().length).toBeGreaterThan(1);
  });

  it('arrows move focus between rows and headers; Left / Right fold and open a group', async () => {
    await render();
    const header = container
      .querySelector('[data-slot="sidebar-folder-name"]')
      ?.closest('button') as HTMLElement;
    const items = navItems();
    const headerAt = items.indexOf(header);
    expect(headerAt).toBeGreaterThan(-1);
    expect(items[headerAt + 1]).toBe(row('Chat a'));

    await act(async () => header.focus());
    await key(header, 'ArrowDown');
    expect(document.activeElement).toBe(row('Chat a'));
    // The roving stop follows focus.
    expect(row('Chat a').tabIndex).toBe(0);
    expect(header.tabIndex).toBe(-1);

    await key(row('Chat a'), 'ArrowDown');
    expect(document.activeElement).toBe(row('Chat b'));
    await key(row('Chat b'), 'ArrowLeft');
    expect(document.activeElement).toBe(header);

    await key(header, 'ArrowLeft');
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).not.toContain('Chat a');
    // The folded-away row's stop moved back to a listed item.
    expect(navItems().filter((item) => item.tabIndex === 0)).toHaveLength(1);

    await key(header, 'ArrowRight');
    expect(header.getAttribute('aria-expanded')).toBe('true');
    await key(header, 'ArrowRight');
    expect(document.activeElement).toBe(row('Chat a'));
  });

  it('Enter on a row still opens it', async () => {
    await render();
    await key(row('Chat b'), 'Enter');
    expect(useChatSessionsStore.getState().activeSessionId).toBe('b');
  });
});
