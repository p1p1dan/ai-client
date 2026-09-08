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
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('electronAPI', { chat: { setPermissions } });
  localStorage.clear();
  setPermissions.mockReset();
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
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('worker busy');
    expect(readSessionPermissions('s1')).toBeNull();
    expect(container.textContent).toContain('执行 · 每次询问');
  });
});
