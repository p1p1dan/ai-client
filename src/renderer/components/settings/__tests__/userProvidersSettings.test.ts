// @vitest-environment happy-dom
import type { UserProviderState, UserProviderView } from '@shared/userProviders';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** H/17 L3/L5 — the AI services pane and its form, against a stubbed bridge. */

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key, locale: 'en' }) }));

import { ProviderSetupDialog } from '../ProviderSetupDialog';
import { UserProvidersSettings } from '../UserProvidersSettings';

const api = {
  get: vi.fn<() => Promise<UserProviderState>>(),
  upsert: vi.fn(),
  remove: vi.fn(),
  setEnabled: vi.fn(),
  fetchModels: vi.fn(),
};

function provider(overrides: Partial<UserProviderView> = {}): UserProviderView {
  return {
    id: 'svc-1',
    name: 'My DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    api: 'openai-completions',
    hasApiKey: true,
    models: ['deepseek-chat'],
    enabled: true,
    createdAt: '2026-09-10T00:00:00.000Z',
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  api.get.mockResolvedValue({ providers: [], encrypted: true });
  // `env.platform` is read by the traffic-lights guard the dialog mounts —
  // unrelated to this feature, but a real part of opening any dialog.
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    userProviders: api,
    env: { platform: 'linux' },
  };
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

/** The whole document, because dialogs and popups render through a portal. */
function text(): string {
  return document.body.textContent ?? '';
}

function byLabel(label: string): HTMLElement | null {
  return document.body.querySelector(`[aria-label="${label}"]`);
}

/** Flush the IPC promises the effects kicked off, inside act so React sees them. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mountPane(): Promise<void> {
  await act(() => root.render(createElement(UserProvidersSettings)));
  await settle();
}

async function mountDialog(editing?: UserProviderView): Promise<void> {
  await act(() =>
    root.render(
      createElement(ProviderSetupDialog, {
        open: true,
        onOpenChange: () => {},
        editing,
        onSaved: () => {},
      })
    )
  );
  await settle();
}

describe('UserProvidersSettings', () => {
  it('offers an add path when nothing is configured', async () => {
    await mountPane();
    expect(text()).toContain('No AI services yet');
    expect(byLabel('Remove')).toBeNull();
  });

  it('lists a configured service and never shows a key', async () => {
    api.get.mockResolvedValue({ providers: [provider()], encrypted: true });
    await mountPane();

    expect(text()).toContain('My DeepSeek');
    expect(text()).toContain('https://api.deepseek.com/v1');
    // The bridge never sends one, so nothing key-shaped can reach the DOM.
    expect(text()).not.toMatch(/sk-[A-Za-z0-9]/);
  });

  it('warns when the vault fell back to plaintext', async () => {
    api.get.mockResolvedValue({ providers: [provider()], encrypted: false });
    await mountPane();
    expect(text()).toContain(
      'The system keyring is unavailable, so keys are stored unencrypted on this machine.'
    );
  });

  it('explains a locked keyring instead of showing an empty list', async () => {
    api.get.mockResolvedValue({ providers: [], encrypted: true, unavailable: 'locked' });
    await mountPane();

    expect(text()).toContain('Unlock the system keyring to see and change your AI services.');
    // Adding into a list we could not read would delete what is stored, so the
    // entry point is closed rather than left to fail in the service.
    const add = [...document.body.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Add service')
    );
    expect(add?.hasAttribute('disabled')).toBe(true);
  });

  it('surfaces a failed removal rather than looking like it worked', async () => {
    api.get.mockResolvedValue({ providers: [provider()], encrypted: true });
    api.remove.mockRejectedValue(new Error('Could not save AI services: crypto_not_ready'));
    await mountPane();

    await act(async () => {
      byLabel('Remove')?.click();
    });
    await settle();
    expect(text()).toContain('Could not save AI services: crypto_not_ready');
  });
});

describe('ProviderSetupDialog', () => {
  it('starts an edit with an empty key field and says one is stored', async () => {
    await mountDialog(provider());

    expect(text()).toContain('A key is stored. Leave empty to keep it.');
    const field = document.body.querySelector('input[type="password"]') as HTMLInputElement;
    expect(field.value).toBe('');
  });

  it('saves an edit without a key so the stored one survives', async () => {
    api.upsert.mockResolvedValue(provider());
    await mountDialog(provider());

    const save = [...document.body.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Save'
    );
    await act(async () => save?.click());
    await settle();

    expect(api.upsert).toHaveBeenCalledOnce();
    expect(api.upsert.mock.calls[0][0]).not.toHaveProperty('apiKey');
    expect(api.upsert.mock.calls[0][0]).toMatchObject({ id: 'svc-1', name: 'My DeepSeek' });
  });

  it('rejects a URL with a query string before anything is sent', async () => {
    await mountDialog();

    const url = document.body.querySelector(
      'input[placeholder="https://api.example.com/v1"]'
    ) as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      setter?.call(url, 'https://api.example.com/v1?token=abc');
      url.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(text()).toContain(
      'This address cannot be used. Remove any query string, or credentials in it.'
    );
    expect(api.fetchModels).not.toHaveBeenCalled();
  });

  it("reports the service's own reason when the probe fails", async () => {
    api.fetchModels.mockResolvedValue({ ok: false, error: 'the service refused this API key' });
    await mountDialog(provider());

    const fetchButton = [...document.body.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Fetch models')
    );
    await act(async () => fetchButton?.click());
    await settle();

    expect(text()).toContain('Could not reach this service — the service refused this API key');
  });

  it('reuses the stored key on the probe instead of round-tripping a secret', async () => {
    api.fetchModels.mockResolvedValue({ ok: true, models: ['deepseek-chat'] });
    await mountDialog(provider());

    const fetchButton = [...document.body.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Fetch models')
    );
    await act(async () => fetchButton?.click());
    await settle();

    expect(api.fetchModels.mock.calls[0][0]).toMatchObject({ id: 'svc-1' });
    expect(api.fetchModels.mock.calls[0][0]).not.toHaveProperty('apiKey');
  });
});
