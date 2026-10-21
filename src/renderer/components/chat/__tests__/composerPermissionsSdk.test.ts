// @vitest-environment happy-dom
import { translate } from '@shared/i18n';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLegacyMigrationStore } from '@/stores/legacyMigration';
import { ComposerPermissionTrigger } from '../ComposerPermissionTrigger';
import { SDK_MODE_DESCRIPTIONS } from '../sdkModeCopy';
import {
  clearStartScreenPermissions,
  peekStartScreenPermissions,
  readDefaultPermissions,
  readSessionPermissions,
  writeSessionPermissions,
} from '../sessionPreferenceStore';

/**
 * Route B, S-2 (topic s2-permission-modes.md §3.1 item 11): the permission menu
 * of a chat on the Claude Agent SDK engine. The real zh translator, as in
 * `composerPermissions.test.ts`, so the assertions read what a user reads.
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
  clearStartScreenPermissions();
  setPermissions.mockReset();
  toasts.length = 0;
  useLegacyMigrationStore.setState({ migrating: {}, postureRevisions: {} });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render(sessionId: string | null, extra: { turnActive?: boolean } = {}) {
  await act(() =>
    root.render(
      createElement(ComposerPermissionTrigger, {
        sessionId,
        hostState: 'ready',
        mode: 'session',
        engine: 'claude-sdk',
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
const chip = () => container.querySelector('button');
const open = () => click(chip());
const items = () => [...document.querySelectorAll('[role="menuitemradio"]')];
const choice = (text: string) => items().find((item) => item.textContent?.startsWith(text)) ?? null;
const confirmButton = () =>
  [...document.querySelectorAll('button')].find((button) => button.textContent === '应用') ?? null;
/** The DSH wording an SDK chat must not show (ruling 13: no deny list on this engine). */
const DENY_RULES = '拒绝规则';

describe('the five modes of an SDK chat (rulings 6, 13, 14)', () => {
  it('lists Claude modes in the ruling order, with their Chinese names', async () => {
    await render('s1');
    expect(chip()?.textContent).toBe('手动审批');
    await open();
    expect(items().map((item) => item.querySelector('span > span')?.textContent)).toEqual([
      '手动审批',
      '自动编辑',
      '计划模式',
      '自动模式',
      '跳过权限确认',
    ]);
  });

  it('describes each mode as the engine behaves, and never promises a deny list', async () => {
    await render('s1');
    await open();
    // The description line of each item, not the item (whose text starts with its label).
    const description = (label: string) =>
      // Design system v2: the description is on the small tier.
      choice(label)?.querySelector('span > span.text-small')?.textContent;
    expect(description('手动审批')).toBe(zh(SDK_MODE_DESCRIPTIONS.ask));
    expect(description('自动编辑')).toBe(zh(SDK_MODE_DESCRIPTIONS['accept-edits']));
    expect(description('计划模式')).toBe(zh(SDK_MODE_DESCRIPTIONS.plan));
    expect(description('自动模式')).toBe(zh(SDK_MODE_DESCRIPTIONS.auto));
    expect(description('跳过权限确认')).toBe(zh(SDK_MODE_DESCRIPTIONS.bypass));
    // Measured: a check that is down refuses, it does not ask.
    expect(description('自动模式')).toContain('检查不可用的不执行');
    for (const key of Object.values(SDK_MODE_DESCRIPTIONS)) expect(zh(key)).not.toBe(key);
    expect(document.body.textContent).not.toContain(DENY_RULES);
  });

  it('remembers a default picked on the start screen with this engine (review S2-SEC-3)', async () => {
    await render(null);
    await open();
    await click(choice('自动编辑'));
    expect(readDefaultPermissions('claude-sdk')).toEqual({ mode: 'agent', gear: 'accept-edits' });
    expect(readDefaultPermissions('dsh')).toEqual({ mode: 'agent', gear: 'ask' });
  });

  it('switches mode while a turn runs, plan mode included (A-4)', async () => {
    setPermissions.mockResolvedValue({ requestId: 'r1' });
    await render('s1', { turnActive: true });
    await open();
    for (const item of items()) expect(item.getAttribute('aria-disabled')).not.toBe('true');
    expect(document.body.textContent).not.toContain(
      zh('Plan mode cannot be turned on or off while this turn runs.')
    );
    await click(choice('计划模式'));
    expect(setPermissions).toHaveBeenCalledWith({
      sessionId: 's1',
      permissions: { mode: 'plan', gear: 'auto' },
    });
  });

  it('confirms Auto and Bypass permissions once more, in the engine words (A-10)', async () => {
    setPermissions.mockResolvedValue({ requestId: 'r1' });
    await render('s1');
    await open();
    await click(choice('自动模式'));
    expect(document.body.textContent).toContain('打开自动模式？');
    expect(document.body.textContent).not.toContain(DENY_RULES);
    expect(setPermissions).not.toHaveBeenCalled();
    await click(confirmButton());
    expect(setPermissions).toHaveBeenCalledWith({
      sessionId: 's1',
      permissions: { mode: 'agent', gear: 'auto' },
    });
    await open();
    await click(choice('跳过权限确认'));
    expect(document.body.textContent).toContain('打开跳过权限确认？');
    expect(document.body.textContent).not.toContain(DENY_RULES);
  });

  it('says why the engine refused a mode, in our words, and keeps the mode it had (A-5)', async () => {
    writeSessionPermissions('s1', { mode: 'agent', gear: 'ask' });
    setPermissions.mockRejectedValue(
      new Error(
        "Error invoking remote method 'chat:setPermissions': WorkerSlotError: WORKER_PERMISSION_MODE_REFUSED: auto_mode_model"
      )
    );
    await render('s1');
    await open();
    await click(choice('自动模式'));
    await click(confirmButton());
    expect(toasts.at(-1)?.description).toBe('这个模型不能用自动模式。');
    expect(readSessionPermissions('s1')).toEqual({ mode: 'agent', gear: 'ask' });
    expect(chip()?.textContent).toBe('手动审批');
  });

  it('turns Bypass permissions on before the first message, for that chat only (ruling 2026-10-16)', async () => {
    await render(null);
    await open();
    expect(choice('跳过权限确认')?.getAttribute('aria-disabled')).not.toBe('true');
    await click(choice('跳过权限确认'));
    expect(document.body.textContent).toContain('打开跳过权限确认？');
    expect(document.body.textContent).toContain('只作用于下一句话新建的对话');
    await click(confirmButton());
    expect(setPermissions).not.toHaveBeenCalled();
    expect(peekStartScreenPermissions()).toEqual({ mode: 'agent', gear: 'bypass' });
    expect(readDefaultPermissions('claude-sdk')).toBeNull();
    expect(chip()?.textContent).toBe('跳过权限确认');
  });
});
