// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComposerPermissionTrigger } from '../ComposerPermissionTrigger';
import { readDefaultPermissions, readSessionPermissions } from '../sessionPreferenceStore';

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/stores/permissionGate', () => ({
  usePermissionGateStore: () => false,
  isTierControlDegraded: () => false,
}));
const setPermissions = vi.fn();
const toasts: Array<{ type?: string; title?: string; description?: string }> = [];
vi.mock('@/components/ui/toast', () => ({
  addToast: (toast: { type?: string; title?: string; description?: string }) => {
    toasts.push(toast);
  },
}));
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('electronAPI', { chat: { setPermissions } });
  localStorage.clear();
  setPermissions.mockReset();
  toasts.length = 0;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render(sessionId: string | null) {
  await act(() =>
    root.render(
      createElement(ComposerPermissionTrigger, { sessionId, hostState: 'ready', mode: 'session' })
    )
  );
}
async function click(element: Element | null) {
  expect(element).not.toBeNull();
  await act(async () => {
    element?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}
function choice(text: string) {
  return (
    [...document.querySelectorAll('[role="menuitemradio"]')].find((item) =>
      item.textContent?.includes(text)
    ) ?? null
  );
}

describe('D14 composer permission controls', () => {
  it('shows two modes and three gears and saves a new-chat preference', async () => {
    await render(null);
    await click(container.querySelector('button'));
    expect(document.querySelectorAll('[role="menuitemradio"]')).toHaveLength(5);
    await click(choice('自动接受编辑'));
    expect(readDefaultPermissions()).toEqual({ mode: 'agent', gear: 'accept-edits' });
    expect(setPermissions).not.toHaveBeenCalled();
    expect(container.textContent).toContain('执行 · 自动接受编辑');
  });
  it('persists a live setting only after worker acknowledgement', async () => {
    let acknowledge!: () => void;
    setPermissions.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          acknowledge = resolve;
        })
    );
    await render('s1');
    await click(container.querySelector('button'));
    await click(choice('规划'));
    expect(setPermissions).toHaveBeenCalledWith({
      sessionId: 's1',
      permissions: { mode: 'plan', gear: 'ask' },
    });
    expect(readSessionPermissions('s1')).toBeNull();
    await act(async () => acknowledge());
    expect(readSessionPermissions('s1')).toEqual({ mode: 'plan', gear: 'ask' });
    expect(container.textContent).toContain('规划 · 每次询问');
  });
  it('requires the existing confirmation before saving auto', async () => {
    await render(null);
    await click(container.querySelector('button'));
    await click(choice('全自动'));
    expect(readDefaultPermissions()).toBeNull();
    const confirm = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === 'Apply'
    );
    await click(confirm ?? null);
    expect(readDefaultPermissions()).toEqual({ mode: 'agent', gear: 'auto' });
  });
  it('shows a rejected update and retains the previous permission', async () => {
    setPermissions.mockRejectedValue(new Error('worker busy'));
    await render('s1');
    await click(container.querySelector('button'));
    await click(choice('自动接受编辑'));
    // U30 rev.3: the press closes the popup, so the failure has to reach the
    // user through the toast surface rather than an alert nobody can see.
    expect(toasts.at(-1)).toMatchObject({ type: 'error', description: 'worker busy' });
    expect(readSessionPermissions('s1')).toBeNull();
    expect(container.textContent).toContain('执行 · 每次询问');
  });

  it('closes on the press, whatever the worker does with it afterwards', async () => {
    // U30 rev.2 fixed "menu will not close" once; D14's rework reintroduced it
    // by making the close wait on the acknowledgement. A gear picked while the
    // worker is slow (or never answers) must not leave the popup stuck open
    // with its own trigger disabled underneath.
    setPermissions.mockImplementation(() => new Promise<void>(() => {}));
    await render('s1');
    await click(container.querySelector('button'));
    expect(document.querySelectorAll('[role="menu"]').length).toBeGreaterThan(0);
    await click(choice('自动接受编辑'));
    expect(document.querySelectorAll('[role="menu"]')).toHaveLength(0);
  });

  it('keeps the popup up for auto, whose next step is the confirmation', async () => {
    await render(null);
    await click(container.querySelector('button'));
    await click(choice('全自动'));
    expect(document.querySelectorAll('[role="menu"]').length).toBeGreaterThan(0);
    expect(document.body.textContent).toContain('启用全自动');
  });
});
