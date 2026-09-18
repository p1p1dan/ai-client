// @vitest-environment happy-dom
import { translate } from '@shared/i18n';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComposerPermissionTrigger } from '../ComposerPermissionTrigger';
import { readDefaultPermissions, readSessionPermissions } from '../sessionPreferenceStore';

/**
 * The REAL zh translator, not `(key) => key`.
 *
 * The gear and mode labels moved into the dictionary on 2026-09-11 (they used
 * to be Chinese literals in `@shared/types/runtimePermission`, which meant an
 * English UI still showed Chinese). An identity stub would make these
 * assertions check the keys instead of what a user reads — the same trap batch
 * 4 found in `questionCardInteraction`. Asserting in Chinese here therefore
 * also proves the entries exist.
 */
const zh = (key: string, params?: Record<string, string | number>) => translate('zh', key, params);
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: zh }) }));
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
async function render(sessionId: string | null, extra: { sending?: boolean } = {}) {
  await act(() =>
    root.render(
      createElement(ComposerPermissionTrigger, {
        sessionId,
        hostState: 'ready',
        mode: 'session',
        ...extra,
      })
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
  it('shows two modes and four gears and saves a new-chat preference', async () => {
    await render(null);
    await click(container.querySelector('button'));
    expect(document.querySelectorAll('[role="menuitemradio"]')).toHaveLength(6);
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
      (button) => button.textContent === '应用'
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

/**
 * While a turn is running.
 *
 * The whole control used to go grey the moment a message was sent, which put
 * the setting that stops approval cards out of reach at the exact moment one
 * was on screen — the user's only way to stop being asked was to answer
 * everything first. The gear is live during a turn now (the runtime re-judges
 * the requests still waiting when it widens); the mode is not, because it
 * decides which tools the running turn was handed.
 */
describe('a turn in flight locks the mode and leaves the gear open', () => {
  it('keeps the trigger reachable and the gears pickable', async () => {
    setPermissions.mockResolvedValue(undefined);
    await render('s1', { sending: true });
    const trigger = container.querySelector('button');
    expect(trigger?.hasAttribute('disabled')).toBe(false);
    await click(trigger);
    const gear = choice('自动接受编辑');
    expect(gear?.getAttribute('data-disabled')).toBeNull();
    await click(gear);
    expect(setPermissions).toHaveBeenCalledWith({
      sessionId: 's1',
      permissions: { mode: 'agent', gear: 'accept-edits' },
    });
  });

  it('refuses the mode and says why', async () => {
    await render('s1', { sending: true });
    await click(container.querySelector('button'));
    const plan = choice('规划');
    expect(plan?.getAttribute('data-disabled')).not.toBeNull();
    await click(plan);
    expect(setPermissions).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('本轮对话进行中只能修改权限档位');
  });
});

/**
 * The fourth gear. `bypass` answers every approval prompt on the user's behalf,
 * including the bash calls `auto` still stops for, so the three claims worth
 * pinning here are: it cannot be reached in one press, it cannot be reached at
 * all before a chat exists, and it is visible for as long as it is on.
 */
describe('bypass gear · the composer side', () => {
  it('cannot be picked on the start screen, where no thread would honour it', async () => {
    await render(null);
    await click(container.querySelector('button'));
    const item = choice('完全放行');
    expect(item).not.toBeNull();
    // Base UI marks a disabled radio item rather than removing it, so the gear
    // is still legible — with the reason attached.
    expect(item?.getAttribute('data-disabled')).not.toBeNull();
    expect(item?.textContent).toContain('需要先有对话才能开启');
    await click(item);
    expect(readDefaultPermissions()).toBeNull();
    expect(setPermissions).not.toHaveBeenCalled();
  });

  it('asks a second time before it applies, and says what it turns off', async () => {
    setPermissions.mockResolvedValue(undefined);
    await render('s1');
    await click(container.querySelector('button'));
    await click(choice('完全放行'));
    // One press must not be enough: nothing has been sent yet.
    expect(setPermissions).not.toHaveBeenCalled();
    expect(document.querySelectorAll('[role="menu"]').length).toBeGreaterThan(0);
    expect(document.body.textContent).toContain('关闭全部授权询问');
    expect(document.body.textContent).toContain('所有工具调用都不再询问');
    const confirm = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === '应用'
    );
    await click(confirm ?? null);
    expect(setPermissions).toHaveBeenCalledWith({
      sessionId: 's1',
      permissions: { mode: 'agent', gear: 'bypass' },
    });
    expect(readSessionPermissions('s1')).toEqual({ mode: 'agent', gear: 'bypass' });
  });

  it('cancelling the confirmation leaves the previous gear in force', async () => {
    await render('s1');
    await click(container.querySelector('button'));
    await click(choice('完全放行'));
    const cancel = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === '取消'
    );
    await click(cancel ?? null);
    expect(setPermissions).not.toHaveBeenCalled();
    expect(container.textContent).toContain('执行 · 每次询问');
  });

  it('stays visible in the trigger for as long as it is on', async () => {
    setPermissions.mockResolvedValue(undefined);
    await render('s1');
    await click(container.querySelector('button'));
    await click(choice('完全放行'));
    await click(
      [...document.querySelectorAll('button')].find((button) => button.textContent === '应用') ??
        null
    );
    // No approval card will ever appear again to remind anyone, so the chip is
    // the whole reminder: it names the gear and carries the destructive tone.
    const trigger = container.querySelector('button');
    expect(trigger?.textContent).toContain('完全放行');
    expect(trigger?.className).toContain('text-destructive');
  });
});
