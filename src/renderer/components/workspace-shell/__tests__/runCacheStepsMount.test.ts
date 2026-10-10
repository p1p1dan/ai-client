// @vitest-environment happy-dom
/**
 * Issue #9 (decision 173 §4.5): the Run panel's 「逐步缓存」 group and cache
 * alert, mounted for real (`RunCacheSteps.tsx`). Covers what only a mount can:
 * the group's default and remembered open state, the 20-row fold, a badge's
 * hover, and the copy button's 1.5-second 「已复制」.
 *
 * The `electronAPI` stub is hoisted because persisted stores rehydrate at
 * import.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { englishTranslate } from '@shared/i18n';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  window.electronAPI = {
    env: { platform: 'linux', appVersion: '1.1.0-dsh.9' },
    settings: { read: async () => null, write: async () => undefined },
    app: { setLanguage: () => undefined, setProxy: () => undefined },
  } as unknown as typeof window.electronAPI;
});
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: englishTranslate, locale: 'en' }) }));

const { RunCacheAlert, RunCacheStepsGroup } = await import('../surfaces/RunCacheSteps');
const { deriveRunCacheView } = await import('../surfaces/runPanelModel');
const { useRunPanelPreferencesStore } = await import('@/stores/runPanelPreferences');
const { issue9Steps, stepsFrom, TURN_START } = await import('./cacheStepsFixture');

const unexplained = deriveRunCacheView({
  steps: issue9Steps(),
  hasUnlistedHistory: false,
  alertDismissed: false,
});
const healthy = deriveRunCacheView({
  steps: stepsFrom([
    {
      turn: 1,
      step: 1,
      read: 0,
      write: 40_000,
      at: TURN_START,
      cache: { kind: 'cold', explained: false },
    },
    { turn: 1, step: 2, read: 40_000, write: 2_000, at: TURN_START + 60_000 },
  ]),
  hasUnlistedHistory: false,
  alertDismissed: false,
});

let root: Root | undefined;
let container: HTMLDivElement;
let restoreClipboard: (() => void) | undefined;

async function render(element: ReactElement): Promise<void> {
  await act(async () => {
    root?.render(element);
  });
}

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
const rows = () => container.querySelectorAll('[data-cache-step]');
const trigger = () =>
  container.querySelector<HTMLButtonElement>('[data-slot="collapsible-trigger"]');

/** Swap `navigator.clipboard` for the test; returns the undo. */
function stubClipboard(writeText: (text: string) => Promise<void>): () => void {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  return () => {
    delete (navigator as unknown as { clipboard?: unknown }).clipboard;
  };
}

async function press(element: Element | null): Promise<void> {
  if (!element) throw new Error('nothing to press');
  await act(async () => {
    element.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    element.dispatchEvent(new window.PointerEvent('pointerup', { bubbles: true, button: 0 }));
    (element as HTMLElement).click();
  });
  await settle();
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  useRunPanelPreferencesStore.setState({ cacheStepsGroup: 'auto', dismissedCacheAlerts: {} });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container.remove();
  restoreClipboard?.();
  restoreClipboard = undefined;
  vi.unstubAllGlobals();
});

describe('「逐步缓存」 group (issue #9)', () => {
  it('stays closed while every step is accounted for, and opens itself when one is not', async () => {
    await render(createElement(RunCacheStepsGroup, { group: healthy.group! }));
    expect(trigger()?.getAttribute('aria-expanded')).toBe('false');
    expect(rows()).toHaveLength(0);
    expect(trigger()?.textContent).toBe('Cache by step2 steps this turn');

    await render(createElement(RunCacheStepsGroup, { group: unexplained.group! }));
    expect(trigger()?.getAttribute('aria-expanded')).toBe('true');
    expect(trigger()?.textContent).toBe('Cache by step3 anomalies22 steps this turn');
    // The newest 20; the two before them wait behind a button.
    expect([...rows()].map((row) => row.getAttribute('data-cache-step'))).toEqual(
      Array.from({ length: 20 }, (_, index) => String(index + 3))
    );
    const earlier = container.querySelector('[data-cache-earlier]');
    expect(earlier?.textContent).toBe('Show 2 earlier steps');
    await press(earlier);
    expect(rows()).toHaveLength(22);
    expect(container.querySelector('[data-cache-earlier]')).toBeNull();
  });

  it('marks the unexplained rows orange, write figure included, and notes where they are', async () => {
    await render(createElement(RunCacheStepsGroup, { group: unexplained.group! }));
    const step15 = container.querySelector('[data-cache-step="15"]');
    expect(step15?.querySelector('[data-cache-badge="warning"]')?.textContent).toBe(
      'Unexplained · about 133k rewritten'
    );
    // The write figure (the badge carries the same colour of its own).
    expect(step15?.querySelector('[title] .text-warning')?.textContent).toBe('138.0k');
    expect(step15?.querySelector('[title]')?.getAttribute('title')).toBe(
      'Step 15: prompt 174,880 · read 36,848 · written 138,030'
    );
    const step16 = container.querySelector('[data-cache-step="16"]');
    expect(step16?.querySelector('[data-cache-badge]')).toBeNull();
    expect(step16?.querySelector('[title] .text-warning')).toBeNull();
    expect(container.textContent).toContain(
      'No local cause found at step 15, 17, 20; see the notice at the top of the panel.'
    );
  });

  it('remembers the user’s choice over the automatic one, for every chat and across restarts', async () => {
    await render(createElement(RunCacheStepsGroup, { group: unexplained.group! }));
    await press(trigger());
    expect(useRunPanelPreferencesStore.getState().cacheStepsGroup).toBe('closed');
    expect(trigger()?.getAttribute('aria-expanded')).toBe('false');
    expect(JSON.parse(localStorage.getItem('aiclient-run-panel') ?? '{}')).toMatchObject({
      state: { cacheStepsGroup: 'closed' },
    });
    // Still closed for a turn that would open on its own.
    await render(createElement(RunCacheStepsGroup, { key: 'other', group: unexplained.group! }));
    expect(trigger()?.getAttribute('aria-expanded')).toBe('false');

    await press(trigger());
    expect(useRunPanelPreferencesStore.getState().cacheStepsGroup).toBe('open');
    // And open for one that would stay closed on its own.
    await render(createElement(RunCacheStepsGroup, { key: 'healthy', group: healthy.group! }));
    expect(trigger()?.getAttribute('aria-expanded')).toBe('true');
    expect(rows()).toHaveLength(2);
    expect(container.textContent).toContain(
      'After the first write, every step reused the cache of the step before.'
    );
  });

  it('explains a badge in its tooltip', async () => {
    await render(createElement(RunCacheStepsGroup, { group: unexplained.group! }));
    const badge = container.querySelector<HTMLElement>(
      '[data-cache-step="20"] [data-cache-badge="warning"]'
    );
    expect(badge?.getAttribute('tabindex')).toBe('0');
    await act(async () => {
      badge?.focus();
    });
    await settle();
    expect(document.querySelector('[data-cache-tip]')?.textContent).toBe(
      'This step’s prompt is 73,035 shorter than the step before’s. The client only appends (verified), so the upstream dropped part of the history and what follows is written to the cache again.'
    );
  });

  it('says the steps before a reopen are not itemized', async () => {
    const reopened = deriveRunCacheView({
      steps: [],
      hasUnlistedHistory: true,
      alertDismissed: false,
    });
    useRunPanelPreferencesStore.setState({ cacheStepsGroup: 'open' });
    await render(createElement(RunCacheStepsGroup, { group: reopened.group! }));
    expect(trigger()?.textContent).toBe('Cache by stepNo details yet');
    expect(rows()).toHaveLength(0);
    expect(container.textContent).toContain(
      'Steps from before the reopen are not itemized. Once the next message is sent, its steps are listed here.'
    );
  });
});

describe('cache alert (issue #9)', () => {
  it('copies the diagnostics, then reads 「已复制」 for 1.5 s', async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    restoreClipboard = stubClipboard(writeText);
    const diagnostics = vi.fn(() => 'diagnostics text');
    await render(
      createElement(RunCacheAlert, {
        alert: unexplained.alert!,
        diagnostics,
        onDismiss: () => undefined,
      })
    );
    const alert = container.querySelector('[data-cache-alert]');
    expect(alert?.querySelector('[data-slot="alert-title"]')?.textContent).toBe(
      'This chat’s cache was rebuilt several times'
    );
    const copy = () => container.querySelector('[data-cache-copy]');
    expect(copy()?.textContent).toBe('Copy diagnostics');

    await press(copy());
    expect(diagnostics).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('diagnostics text');
    expect(copy()?.textContent).toBe('Copied');

    await act(async () => new Promise((resolve) => setTimeout(resolve, 1_600)));
    expect(copy()?.textContent).toBe('Copy diagnostics');
  });

  it('does not claim a copy the clipboard refused', async () => {
    restoreClipboard = stubClipboard(async () => Promise.reject(new Error('denied')));
    await render(
      createElement(RunCacheAlert, {
        alert: unexplained.alert!,
        diagnostics: () => 'x',
        onDismiss: () => undefined,
      })
    );
    await press(container.querySelector('[data-cache-copy]'));
    expect(container.querySelector('[data-cache-copy]')?.textContent).toBe('Copy diagnostics');
  });

  it('closes for this chat only, in memory', async () => {
    const onDismiss = vi.fn();
    await render(
      createElement(RunCacheAlert, { alert: unexplained.alert!, diagnostics: () => '', onDismiss })
    );
    const close = container.querySelector('[data-cache-alert-dismiss]');
    expect(close?.getAttribute('aria-label')).toBe('Hide for this chat');
    await press(close);
    expect(onDismiss).toHaveBeenCalledTimes(1);

    const { dismissCacheAlert } = useRunPanelPreferencesStore.getState();
    dismissCacheAlert('s1');
    dismissCacheAlert('s1');
    expect(useRunPanelPreferencesStore.getState().dismissedCacheAlerts).toEqual({ s1: true });
    // Not persisted: a restart raises it again.
    expect(localStorage.getItem('aiclient-run-panel') ?? '').not.toContain('s1');
  });
});

describe('Run panel wiring (issue #9)', () => {
  const source = readFileSync(join(import.meta.dirname, '../surfaces/RunSurfaceView.tsx'), 'utf8');

  it('puts the alert first in the scroll root and the group between the step and session groups', () => {
    const scrollRoot = source.indexOf(
      '<div className="select-text flex h-full flex-col overflow-y-auto">'
    );
    const alert = source.indexOf('<RunCacheAlert');
    const header = source.indexOf('<div className="relative shrink-0 border-b p-2">');
    const usage = source.indexOf("t('Input (last step)')");
    const group = source.indexOf('<RunCacheStepsGroup');
    const session = source.indexOf("t('Steps (session)')");
    expect(scrollRoot).toBeGreaterThan(0);
    expect([scrollRoot, alert, header, usage, group, session]).toEqual(
      [scrollRoot, alert, header, usage, group, session].sort((a, b) => a - b)
    );
    expect(source).toContain("t('Cache write (session)')");
  });
});
