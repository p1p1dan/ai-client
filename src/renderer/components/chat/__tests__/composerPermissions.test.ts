// @vitest-environment happy-dom
import { translate } from '@shared/i18n';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLegacyMigrationStore } from '@/stores/legacyMigration';
import { type ComposerGoalEntry, ComposerPermissionTrigger } from '../ComposerPermissionTrigger';
import { applyGoalStartLive, GOAL_ENTRY_HINT_LIVE, planGoalStart } from '../goalStart';
import {
  readDefaultPermissions,
  readSessionPermissions,
  writeSessionPermissions,
} from '../sessionPreferenceStore';

/**
 * The REAL zh translator, not `(key) => key`.
 *
 * The preset labels live in the dictionary (they used to be Chinese literals
 * in `@shared/types/runtimePermission`, which meant an English UI still showed
 * Chinese). An identity stub would make these assertions check the keys
 * instead of what a user reads — the same trap batch 4 found in
 * `questionCardInteraction`. Asserting in Chinese here therefore also proves
 * the entries exist.
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
async function render(
  sessionId: string | null,
  extra: { turnActive?: boolean; goalEntry?: ComposerGoalEntry } = {}
) {
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
async function open() {
  await click(container.querySelector('button'));
}
function choice(text: string) {
  return (
    [...document.querySelectorAll('[role="menuitemradio"]')].find((item) =>
      item.textContent?.startsWith(text)
    ) ?? null
  );
}
const chip = () => container.querySelector('button');
const confirmButton = () =>
  [...document.querySelectorAll('button')].find((button) => button.textContent === '应用') ?? null;

/**
 * Decision 166 (GitHub issue #5, user ruling 2026-10-09): one column of five
 * presets instead of D14's two axes. Storage is still the `{mode, gear}` pair.
 */
describe('the five presets', () => {
  it('lists them in one column, in order, and the chip names the current one', async () => {
    await render('s1');
    expect(chip()?.textContent).toBe('改动前确认');
    await open();
    const items = [...document.querySelectorAll('[role="menuitemradio"]')];
    expect(items).toHaveLength(5);
    expect(items.map((item) => item.querySelector('span > span')?.textContent)).toEqual([
      '计划模式',
      '改动前确认',
      '自动编辑',
      '全自动',
      '完全放行',
    ]);
    expect(choice('改动前确认')?.getAttribute('aria-checked')).toBe('true');
  });

  it('describes each preset without promising an approval step', async () => {
    await render('s1');
    await open();
    const text = document.body.textContent ?? '';
    expect(choice('计划模式')?.textContent).toContain('只读');
    expect(choice('自动编辑')?.textContent).toContain('工作区外的路径、联网和其他工具仍会询问');
    expect(text).not.toContain('批准');
  });

  it('saves a new-chat preference on the start screen', async () => {
    await render(null);
    await open();
    await click(choice('自动编辑'));
    expect(readDefaultPermissions()).toEqual({ mode: 'agent', gear: 'accept-edits' });
    expect(setPermissions).not.toHaveBeenCalled();
    expect(chip()?.textContent).toBe('自动编辑');
  });

  it('writes plan mode as plan on full auto, with no confirmation', async () => {
    let acknowledge!: () => void;
    setPermissions.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          acknowledge = resolve;
        })
    );
    await render('s1');
    await open();
    await click(choice('计划模式'));
    expect(setPermissions).toHaveBeenCalledWith({
      sessionId: 's1',
      permissions: { mode: 'plan', gear: 'auto' },
    });
    // No confirmation panel: the press closed the menu.
    expect(document.body.textContent).not.toContain('启用全自动');
    // Persisted only after the worker acknowledged it.
    expect(readSessionPermissions('s1')).toBeNull();
    await act(async () => acknowledge());
    expect(readSessionPermissions('s1')).toEqual({ mode: 'plan', gear: 'auto' });
    expect(chip()?.textContent).toBe('计划模式');
  });

  it('leaves plan mode for the execute preset picked', async () => {
    setPermissions.mockResolvedValue(undefined);
    writeSessionPermissions('s1', { mode: 'plan', gear: 'auto' });
    await render('s1');
    await open();
    await click(choice('改动前确认'));
    expect(setPermissions).toHaveBeenCalledWith({
      sessionId: 's1',
      permissions: { mode: 'agent', gear: 'ask' },
    });
    expect(chip()?.textContent).toBe('改动前确认');
  });

  it('shows a rejected update and retains the previous preset', async () => {
    setPermissions.mockRejectedValue(new Error('worker busy'));
    await render('s1');
    await open();
    await click(choice('自动编辑'));
    // U30 rev.3: the press closes the popup, so the failure has to reach the
    // user through the toast surface rather than an alert nobody can see.
    expect(toasts.at(-1)).toMatchObject({ type: 'error', description: 'worker busy' });
    expect(readSessionPermissions('s1')).toBeNull();
    expect(chip()?.textContent).toBe('改动前确认');
  });

  it('closes on the press, whatever the worker does with it afterwards', async () => {
    // U30 rev.2 fixed "menu will not close" once; D14's rework reintroduced it
    // by making the close wait on the acknowledgement. A preset picked while
    // the worker is slow (or never answers) must not leave the popup stuck
    // open with its own trigger disabled underneath.
    setPermissions.mockImplementation(() => new Promise<void>(() => {}));
    await render('s1');
    await open();
    expect(document.querySelectorAll('[role="menu"]').length).toBeGreaterThan(0);
    await click(choice('自动编辑'));
    expect(document.querySelectorAll('[role="menu"]')).toHaveLength(0);
  });
});

describe('full auto keeps its confirmation', () => {
  it('requires the confirmation before saving, and keeps the popup up for it', async () => {
    await render(null);
    await open();
    await click(choice('全自动'));
    expect(readDefaultPermissions()).toBeNull();
    expect(document.querySelectorAll('[role="menu"]').length).toBeGreaterThan(0);
    expect(document.body.textContent).toContain('启用全自动');
    await click(confirmButton());
    expect(readDefaultPermissions()).toEqual({ mode: 'agent', gear: 'auto' });
  });

  it('leaves plan mode once confirmed', async () => {
    setPermissions.mockResolvedValue(undefined);
    writeSessionPermissions('s1', { mode: 'plan', gear: 'auto' });
    await render('s1');
    await open();
    await click(choice('全自动'));
    expect(setPermissions).not.toHaveBeenCalled();
    await click(confirmButton());
    expect(setPermissions).toHaveBeenCalledWith({
      sessionId: 's1',
      permissions: { mode: 'agent', gear: 'auto' },
    });
    expect(chip()?.textContent).toBe('全自动');
  });
});

/**
 * While a turn is running.
 *
 * The whole control used to go grey the moment a message was sent, which put
 * the setting that stops approval cards out of reach at the exact moment one
 * was on screen. The gear is live during a turn (the runtime re-judges the
 * requests still waiting when it widens); the mode is not, because it decides
 * which tools the running turn was handed. With presets: 「计划模式」 is off
 * mid-turn, and so is everything else while the chat is IN plan mode, since
 * each of the others leaves it.
 *
 * `turnActive` stands for the caller's `busy || sending` union, not merely "a
 * send request is in flight" — see `composerFormStatic.test.ts`'s "U12:
 * permission bar slot is wired" for the pin on the caller's expression.
 */
describe('a turn in flight locks plan mode and leaves the gear presets open', () => {
  it('keeps the trigger reachable and the four gear presets pickable', async () => {
    setPermissions.mockResolvedValue(undefined);
    await render('s1', { turnActive: true });
    expect(chip()?.hasAttribute('disabled')).toBe(false);
    await open();
    for (const name of ['改动前确认', '自动编辑', '全自动', '完全放行'])
      expect(choice(name)?.getAttribute('data-disabled'), name).toBeNull();
    await click(choice('自动编辑'));
    expect(setPermissions).toHaveBeenCalledWith({
      sessionId: 's1',
      permissions: { mode: 'agent', gear: 'accept-edits' },
    });
  });

  it('refuses plan mode and says why', async () => {
    await render('s1', { turnActive: true });
    await open();
    const plan = choice('计划模式');
    expect(plan?.getAttribute('data-disabled')).not.toBeNull();
    expect(plan?.textContent).toContain('本轮对话结束后可修改');
    await click(plan);
    expect(setPermissions).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('本轮对话进行中不能进入或退出计划模式');
  });

  it('in plan mode, refuses every preset until the turn ends', async () => {
    writeSessionPermissions('s1', { mode: 'plan', gear: 'auto' });
    await render('s1', { turnActive: true });
    await open();
    for (const name of ['计划模式', '改动前确认', '自动编辑', '全自动', '完全放行']) {
      const item = choice(name);
      expect(item?.getAttribute('data-disabled'), name).not.toBeNull();
      await click(item);
    }
    expect(setPermissions).not.toHaveBeenCalled();
  });
});

/**
 * The fifth preset. `bypass` answers every approval prompt on the user's
 * behalf, including the shell calls `auto` still stops for, so the three
 * claims worth pinning here are: it cannot be reached in one press, it cannot
 * be reached at all before a chat exists, and it is visible for as long as it
 * is on (decision 023 of runtime-hardening, unchanged by decision 166).
 */
describe('bypass · the composer side', () => {
  it('cannot be picked on the start screen, where no thread would honour it', async () => {
    await render(null);
    await open();
    const item = choice('完全放行');
    expect(item).not.toBeNull();
    // Base UI marks a disabled radio item rather than removing it, so the
    // preset is still legible — with the reason attached.
    expect(item?.getAttribute('data-disabled')).not.toBeNull();
    expect(item?.textContent).toContain('需要先有对话才能开启');
    await click(item);
    expect(readDefaultPermissions()).toBeNull();
    expect(setPermissions).not.toHaveBeenCalled();
  });

  it('asks a second time before it applies, and says what it turns off', async () => {
    setPermissions.mockResolvedValue(undefined);
    await render('s1');
    await open();
    await click(choice('完全放行'));
    // One press must not be enough: nothing has been sent yet.
    expect(setPermissions).not.toHaveBeenCalled();
    expect(document.querySelectorAll('[role="menu"]').length).toBeGreaterThan(0);
    expect(document.body.textContent).toContain('关闭全部授权询问');
    expect(document.body.textContent).toContain('所有工具调用都不再询问');
    await click(confirmButton());
    expect(setPermissions).toHaveBeenCalledWith({
      sessionId: 's1',
      permissions: { mode: 'agent', gear: 'bypass' },
    });
    expect(readSessionPermissions('s1')).toEqual({ mode: 'agent', gear: 'bypass' });
  });

  it('cancelling the confirmation leaves the previous preset in force', async () => {
    await render('s1');
    await open();
    await click(choice('完全放行'));
    const cancel = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === '取消'
    );
    await click(cancel ?? null);
    expect(setPermissions).not.toHaveBeenCalled();
    expect(chip()?.textContent).toBe('改动前确认');
  });

  it('stays visible in the trigger for as long as it is on', async () => {
    setPermissions.mockResolvedValue(undefined);
    await render('s1');
    await open();
    await click(choice('完全放行'));
    await click(confirmButton());
    // No approval card will ever appear again to remind anyone, so the chip is
    // the whole reminder: it names the preset and carries the destructive tone.
    expect(chip()?.textContent).toBe('完全放行');
    expect(chip()?.className).toContain('text-destructive');
  });
});

/**
 * A plan-mode pair on another gear — what a 1.0.x `readonly` tier migrates to
 * (plan + ask) — shows as 「计划模式」 and is not rewritten; only the tooltip
 * names the gear it keeps.
 */
describe('legacy plan-mode pairs', () => {
  it('display as plan mode, untouched, with the gear in the tooltip', async () => {
    writeSessionPermissions('s1', { mode: 'plan', gear: 'ask' });
    await render('s1');
    expect(chip()?.textContent).toBe('计划模式');
    expect(chip()?.getAttribute('title')).toContain('只读工具沿用之前的确认方式：每次询问');
    await open();
    expect(choice('计划模式')?.getAttribute('aria-checked')).toBe('true');
    expect(setPermissions).not.toHaveBeenCalled();
    expect(readSessionPermissions('s1')).toEqual({ mode: 'plan', gear: 'ask' });
  });

  it('plan mode on full auto needs no such note', async () => {
    writeSessionPermissions('s1', { mode: 'plan', gear: 'auto' });
    await render('s1');
    expect(chip()?.getAttribute('title')).not.toContain('沿用之前');
  });
});

/**
 * dsh-rebase P1-9e (decisions 121, 122 rule 13): a chat from the previous
 * version whose resume named no posture comes up on the one its 1.0.x file
 * recorded; the migration writes it to this chat's storage and bumps the
 * revision the chip listens to, so the chip shows it without a session switch.
 */
describe('P1-9e — the posture a migration brought the chat up on', () => {
  it('re-reads the chat’s posture when a migration wrote it, and only for that chat', async () => {
    await render('s1');
    expect(chip()?.textContent).toBe('改动前确认');

    writeSessionPermissions('s1', { mode: 'agent', gear: 'accept-edits' });
    await act(async () => useLegacyMigrationStore.getState().notePostureSynced('s2'));
    expect(chip()?.textContent).toBe('改动前确认');

    await act(async () => useLegacyMigrationStore.getState().notePostureSynced('s1'));
    expect(chip()?.textContent).toBe('自动编辑');
    expect(setPermissions).not.toHaveBeenCalled();
  });

  it('shows a migrated read-only chat (plan + accept-edits) as plan mode', async () => {
    await render('s1');
    writeSessionPermissions('s1', { mode: 'plan', gear: 'accept-edits' });
    await act(async () => useLegacyMigrationStore.getState().notePostureSynced('s1'));
    expect(chip()?.textContent).toBe('计划模式');
    expect(chip()?.getAttribute('title')).toContain('自动接受编辑');
  });
});

/** Decision 166: 「设定目标…」 under the presets. */
describe('the goal entry', () => {
  const entry = (overrides: Partial<ComposerGoalEntry> = {}): ComposerGoalEntry => ({
    disabled: false,
    hint: null,
    onSelect: vi.fn(),
    ...overrides,
  });
  const goalItem = () =>
    [...document.querySelectorAll('[role="menuitem"]')].find((item) =>
      item.textContent?.startsWith('设定目标…')
    ) ?? null;

  it('sits below the presets and hands the pick to the composer, closing the menu', async () => {
    const goalEntry = entry();
    await render('s1', { goalEntry });
    await open();
    const item = goalItem();
    expect(item?.textContent).toContain('必要时切换到「全自动」');
    await click(item);
    expect(goalEntry.onSelect).toHaveBeenCalledTimes(1);
    expect(setPermissions).not.toHaveBeenCalled();
    expect(document.querySelectorAll('[role="menu"]')).toHaveLength(0);
  });

  it('is off with the composer’s reason', async () => {
    const goalEntry = entry({ disabled: true, hint: GOAL_ENTRY_HINT_LIVE });
    await render('s1', { goalEntry });
    await open();
    const item = goalItem();
    expect(item?.getAttribute('data-disabled')).not.toBeNull();
    expect(item?.textContent).toContain('当前对话有未完成的目标');
    await click(item);
    expect(goalEntry.onSelect).not.toHaveBeenCalled();
  });

  it('is offered on the start screen too', async () => {
    const goalEntry = entry();
    await render(null, { goalEntry });
    await open();
    expect(goalItem()?.getAttribute('data-disabled')).toBeNull();
  });
});

/**
 * Decision 166: a goal-creating `/goal` switches the chat to full auto as it
 * is dispatched (`ChatComposer.runSend` → `goalStart.ts`). The chip holds its
 * posture in React state, so the switch has to reach it through the revision
 * it listens to.
 */
describe('the chip follows a goal start', () => {
  it('shows full auto once a live switch took', async () => {
    setPermissions.mockResolvedValue(undefined);
    writeSessionPermissions('s1', { mode: 'plan', gear: 'auto' });
    await render('s1');
    expect(chip()?.textContent).toBe('计划模式');
    const start = planGoalStart(
      '/goal ship it',
      readSessionPermissions('s1') ?? { mode: 'agent', gear: 'ask' },
      null
    );
    expect(start).not.toBeNull();
    if (!start) return;
    await act(async () => {
      await applyGoalStartLive('s1', start, {
        t: zh,
        writeSessionPermissions,
        setPermissions: (sessionId, permissions) =>
          window.electronAPI.chat.setPermissions({ sessionId, permissions }),
        notePostureSynced: (sessionId) =>
          useLegacyMigrationStore.getState().notePostureSynced(sessionId),
        toast: () => undefined,
      });
    });
    expect(chip()?.textContent).toBe('全自动');
  });
});
