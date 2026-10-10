// @vitest-environment happy-dom
import { DEFAULT_REQUEST_USER_AGENT_MODE } from '@shared/types/requestUserAgent';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore } from '@/stores/settings';
import { RequestUserAgentSection } from '../RequestUserAgentSection';

/**
 * dsh-rebase decision 171 (GitHub issue #7): the settings half of the request
 * User-Agent. The store starts on the plan's own default, the three choices
 * write the mode Main reads into the model plan, and only a custom value that
 * passes the shared check is ever committed — on Enter or when the field is
 * left, never per keystroke (each commit that changes the User-Agent restarts
 * the host once it is idle).
 *
 * The `electronAPI` stub lives in `vi.hoisted`: importing `useSettingsStore`
 * starts zustand persist's rehydrate at module-evaluation time (see
 * `providerIdleTimeoutSection.test.ts`).
 */
vi.hoisted(() => {
  window.electronAPI = {
    env: { platform: 'linux', appVersion: '1.1.0-dsh.8' },
    settings: { read: async () => null, write: async () => undefined },
    app: { setLanguage: () => undefined, setProxy: () => undefined },
  } as unknown as typeof window.electronAPI;
});
vi.mock('@/utils/logging', () => ({ updateRendererLogging: vi.fn() }));
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key, locale: 'en' }) }));

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useSettingsStore.setState({ requestUserAgentMode: 'default', requestUserAgentCustom: '' });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(createElement(RequestUserAgentSection));
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useSettingsStore.setState({ requestUserAgentMode: 'default', requestUserAgentCustom: '' });
  vi.unstubAllGlobals();
});

const text = () => container.textContent ?? '';
const choice = (label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === label
  );
const input = () => container.querySelector<HTMLInputElement>('input');

async function type(value: string): Promise<void> {
  const field = input();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    if (field) setter?.call(field, value);
    field?.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function leave(): Promise<void> {
  await act(async () => {
    input()?.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    input()?.dispatchEvent(new FocusEvent('blur'));
  });
}

async function enter(): Promise<void> {
  await act(async () => {
    input()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
}

describe('RequestUserAgentSection', () => {
  it('starts on the default and shows the value that is sent', () => {
    expect(DEFAULT_REQUEST_USER_AGENT_MODE).toBe('default');
    expect(text()).toContain('Request identity (User-Agent)');
    expect(text()).toContain('Sent as:');
    expect(text()).toContain('claude-cli-pilab/1.1.0-dsh.8');
    expect(text()).toContain('Takes effect from the next turn; no restart needed.');
    expect(choice('Default')?.getAttribute('aria-pressed')).toBe('true');
    expect(choice('Engine default')?.getAttribute('aria-pressed')).toBe('false');
    expect(choice('Custom')?.getAttribute('aria-pressed')).toBe('false');
    // No custom field until custom is chosen.
    expect(input()).toBeNull();
  });

  it("engine default: writes the mode and says the engine's own goes out", async () => {
    await act(async () => choice('Engine default')?.click());
    expect(useSettingsStore.getState().requestUserAgentMode).toBe('engine');
    expect(text()).toContain('The engine sends its own User-Agent (deepseek-harness/…)');
    expect(text()).not.toContain('claude-cli-pilab/1.1.0-dsh.8');
  });

  it('custom: the default is sent until a value is committed, then the trimmed value', async () => {
    await act(async () => choice('Custom')?.click());
    expect(useSettingsStore.getState().requestUserAgentMode).toBe('custom');
    expect(input()?.getAttribute('placeholder')).toBe('claude-cli-pilab/1.1.0-dsh.8');
    expect(text()).toContain('Until a value is entered, the default is sent:');

    // Typing alone commits nothing.
    await type('  pilab-gw/2 (custom)  ');
    expect(useSettingsStore.getState().requestUserAgentCustom).toBe('');
    await enter();
    expect(useSettingsStore.getState().requestUserAgentCustom).toBe('pilab-gw/2 (custom)');
    expect(text()).toContain('Sent as:');
    expect(text()).toContain('pilab-gw/2 (custom)');

    // Leaving the field commits too; an emptied field clears the value.
    await type('');
    await leave();
    expect(useSettingsStore.getState().requestUserAgentCustom).toBe('');
    expect(text()).toContain('Until a value is entered, the default is sent:');
  });

  it.each([
    [
      'a non-ASCII character',
      'pilab-gw/2 (测试)',
      'Use letters, digits, spaces and common symbols only (visible ASCII).',
    ],
    [
      'a tab',
      'pilab\tgw/2',
      'Use letters, digits, spaces and common symbols only (visible ASCII).',
    ],
    ['257 characters', 'a'.repeat(257), 'At most {{count}} characters.'],
  ])('custom: a value with %s is refused on the spot and never committed', async (_why, value, error) => {
    await act(async () => choice('Custom')?.click());
    await type('gw/1');
    await enter();
    await type(value);
    expect(text()).toContain(error);
    expect(input()?.getAttribute('aria-invalid')).toBe('true');
    await enter();
    await leave();
    // The last good value stays, and is still what is sent.
    expect(useSettingsStore.getState().requestUserAgentCustom).toBe('gw/1');
    expect(text()).toContain('Sent as:');
  });

  it('a custom value is kept while another mode is chosen', async () => {
    await act(async () => choice('Custom')?.click());
    await type('gw/3');
    await enter();
    await act(async () => choice('Default')?.click());
    expect(useSettingsStore.getState()).toMatchObject({
      requestUserAgentMode: 'default',
      requestUserAgentCustom: 'gw/3',
    });
    expect(text()).toContain('claude-cli-pilab/1.1.0-dsh.8');
    await act(async () => choice('Custom')?.click());
    expect(input()?.value).toBe('gw/3');
  });
});

describe('the store guards its door (decision 171)', () => {
  it('stores only a mode it knows and a custom value the check accepts', () => {
    const store = useSettingsStore.getState();
    store.setRequestUserAgentMode('bogus' as never);
    expect(useSettingsStore.getState().requestUserAgentMode).toBe('default');
    store.setRequestUserAgentCustom('  ok/1  ');
    expect(useSettingsStore.getState().requestUserAgentCustom).toBe('ok/1');
    store.setRequestUserAgentCustom('bad\r\nX-Injected: 1');
    expect(useSettingsStore.getState().requestUserAgentCustom).toBe('ok/1');
    store.setRequestUserAgentCustom('   ');
    expect(useSettingsStore.getState().requestUserAgentCustom).toBe('');
  });
});
