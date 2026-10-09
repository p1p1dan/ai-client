// @vitest-environment happy-dom
import type { UserProviderState, UserProviderView } from '@shared/userProviders';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** H/17 L3/L5 — the AI services pane and its form, against a stubbed bridge. */

// Substitutes `{{token}}` the same way `translate()` does, so P1-5d's
// assertions can check the actual interpolated text (e.g. which protocol a
// warning names) rather than the raw template.
vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) =>
      params
        ? key.replace(/\{\{(\w+)\}\}/g, (match, token: string) =>
            token in params ? String(params[token]) : match
          )
        : key,
    locale: 'en',
  }),
}));

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

/**
 * Open a Base UI select by its trigger's `aria-label` and return its
 * `[role="option"]` nodes. Same open sequence `providerIdleTimeoutSection.test.ts`
 * and `terminalInteraction.test.ts` use: the keydown arms the popup, the click
 * commits, and the timeout lets the positioner settle.
 */
async function openSelectOptions(triggerLabel: string): Promise<HTMLElement[]> {
  const trigger = byLabel(triggerLabel);
  if (!trigger) throw new Error(`no select trigger labelled ${triggerLabel}`);
  const listsBefore = new Set(document.querySelectorAll<HTMLElement>('[role="listbox"]'));
  // Focused when the dialog opened: its list is the one already mounted.
  const focusedAtOpen = document.activeElement === trigger && listsBefore.size === 1;
  await act(async () => {
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  });
  await act(async () => {
    trigger.click();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
  // Decision 156: the options of THIS select's list — the one these steps
  // mounted. The dialog now opens with focus on its first field, the Service
  // select, and a Base UI select mounts its (closed) items as soon as its
  // trigger is focused, so a document-wide query also read the Service list.
  const lists = focusedAtOpen
    ? [...listsBefore]
    : [...document.querySelectorAll<HTMLElement>('[role="listbox"]')].filter(
        (list) => !listsBefore.has(list)
      );
  if (lists.length !== 1) {
    throw new Error(`expected the ${triggerLabel} select to mount one list, got ${lists.length}`);
  }
  return [...(lists[0] as HTMLElement).querySelectorAll<HTMLElement>('[role="option"]')];
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

  it('flags a service whose protocol the current chat engine cannot use (P1-5d)', async () => {
    api.get.mockResolvedValue({
      providers: [provider({ api: 'google-generative-ai' })],
      encrypted: true,
    });
    await mountPane();

    expect(text()).toContain('Not supported by the current engine');
  });

  it('does not flag a service whose protocol the engine supports', async () => {
    api.get.mockResolvedValue({ providers: [provider()], encrypted: true });
    await mountPane();

    expect(text()).not.toContain('Not supported by the current engine');
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

/**
 * P1-5d (decision 036 rule 2, decision 148) — the chat route only speaks
 * `openai-completions`, `openai-responses` and `anthropic-messages`. The form
 * narrows what a NEW service can pick to those three, and for an EXISTING
 * service already stored with a different one, shows it rather than silently
 * rewriting or dropping it on save.
 */
describe('ProviderSetupDialog — protocol narrowing (P1-5d)', () => {
  it('offers only the three DSH-supported API styles when adding a service', async () => {
    await mountDialog();

    const options = await openSelectOptions('API style');
    expect(options.map((option) => option.textContent?.trim())).toEqual([
      'OpenAI Chat Completions',
      'OpenAI Responses',
      'Anthropic Messages',
    ]);
  });

  it('offers exactly the same three when editing a service that already uses one', async () => {
    await mountDialog(provider({ api: 'anthropic-messages' }));

    const options = await openSelectOptions('API style');
    expect(options).toHaveLength(3);
  });

  it('pins an unsupported protocol into the list, labelled as unsupported, when editing', async () => {
    await mountDialog(provider({ api: 'google-generative-ai' }));

    const options = await openSelectOptions('API style');
    expect(options.map((option) => option.textContent?.trim())).toEqual([
      'OpenAI Chat Completions',
      'OpenAI Responses',
      'Anthropic Messages',
      'Google Generative AI (not supported by the current engine)',
    ]);
  });

  it('warns, naming the protocol, when editing a service with an unsupported one', async () => {
    await mountDialog(provider({ api: 'mistral-conversations' }));

    expect(text()).toContain(
      'This service uses Mistral Conversations, which the current chat engine cannot use. Pick one of the styles above, or remove the service.'
    );
  });

  it('does not warn when editing a service whose protocol is supported', async () => {
    await mountDialog(provider({ api: 'openai-responses' }));

    expect(text()).not.toContain('which the current chat engine cannot use');
    expect(text()).toContain('Only these three API styles work with the current chat engine.');
  });

  it('keeps an unsupported protocol on save when the API style field is left untouched', async () => {
    api.upsert.mockResolvedValue(provider({ api: 'google-generative-ai' }));
    await mountDialog(provider({ api: 'google-generative-ai' }));

    const save = [...document.body.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Save'
    );
    await act(async () => save?.click());
    await settle();

    // Not silently switched to a supported style, and not left out of the
    // draft either — exactly the value that was already stored.
    expect(api.upsert.mock.calls[0][0]).toMatchObject({ api: 'google-generative-ai' });
  });

  it('does not offer the Google or Mistral presets, whose protocols the engine cannot use', async () => {
    await mountDialog();

    const options = await openSelectOptions('Service');
    const labels = options.map((option) => option.textContent?.trim());
    expect(labels).not.toContain('Google Gemini');
    expect(labels).not.toContain('Mistral');
    // The presets that DO use a supported protocol, plus "Custom", are
    // unaffected — this is a narrowing, not an empty list.
    expect(labels).toContain('OpenAI');
    expect(labels).toContain('Custom');
  });
});

/**
 * P2 / c-2, rebuilt by decision 168 — the 「模型设置」 block is the only place a
 * user's model capabilities are typed in: a column of the selected models
 * (a vertical tab list) beside one shared settings panel.
 *
 * Everything below drives the REAL dialog and asserts what `userProviders.upsert`
 * is handed: the rules themselves are tested on the shared helpers
 * (`src/shared/__tests__/userProviders.test.ts`), these check the form is wired
 * to them and that the panel shows the model the column says it shows.
 */
describe('ProviderSetupDialog — model settings (decision 168)', () => {
  const CLAUDE = {
    api: 'anthropic-messages' as const,
    name: 'Claude Proxy',
    baseUrl: 'https://proxy.example',
  };

  /** React tracks its own value on the node, so the native setter has to be used. */
  async function type(node: Element | null, value: string, event = 'input'): Promise<void> {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      if (node instanceof HTMLInputElement) setter?.call(node, value);
      node?.dispatchEvent(new Event(event, { bubbles: true }));
    });
  }

  async function click(node: Element | null | undefined): Promise<void> {
    await act(async () => (node as HTMLElement | null | undefined)?.click());
  }

  function button(label: string): HTMLButtonElement | undefined {
    return [...document.body.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === label
    );
  }

  function saveButton(): HTMLButtonElement | undefined {
    return button('Save');
  }

  async function save(): Promise<void> {
    await click(saveButton());
    await settle();
  }

  async function fetchModels(): Promise<void> {
    const fetch = [...document.body.querySelectorAll('button')].find((candidate) =>
      candidate.textContent?.includes('Fetch models')
    );
    await click(fetch);
    await settle();
  }

  /** The probe's model chips, inside their own group. */
  function chips(): HTMLButtonElement[] {
    const group = byLabel('Available models');
    return group ? [...group.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')] : [];
  }

  function chip(modelId: string): HTMLButtonElement | undefined {
    return chips().find((candidate) => candidate.textContent?.trim() === modelId);
  }

  /** The column of selected models. */
  function tabs(): HTMLElement[] {
    const list = byLabel('Selected models');
    return list ? [...list.querySelectorAll<HTMLElement>('[role="tab"]')] : [];
  }

  function tab(modelId: string): HTMLElement | undefined {
    return tabs().find((candidate) => candidate.textContent?.includes(modelId));
  }

  function panel(): HTMLElement | null {
    return document.body.querySelector('[role="tabpanel"]');
  }

  /** The model id the panel's header names. */
  function panelModel(): string | undefined {
    return panel()?.querySelector('[data-slot="model-settings-id"]')?.textContent ?? undefined;
  }

  function switchFor(label: string): HTMLElement | null {
    return panel()?.querySelector<HTMLElement>(`[role="switch"][aria-label="${label}"]`) ?? null;
  }

  function isOn(control: HTMLElement | null): boolean {
    return control?.getAttribute('aria-checked') === 'true';
  }

  function contextWindow(): HTMLInputElement | null {
    return panel()?.querySelector<HTMLInputElement>('input[placeholder="Default 128000"]') ?? null;
  }

  function maxTokens(): HTMLInputElement | null {
    return panel()?.querySelector<HTMLInputElement>('input[placeholder="Default 8192"]') ?? null;
  }

  function displayName(): HTMLInputElement | null {
    return panel()?.querySelector<HTMLInputElement>('input[maxlength="200"]') ?? null;
  }

  function effortButtons(): HTMLButtonElement[] {
    const group = byLabel('Available reasoning efforts');
    return group ? [...group.querySelectorAll<HTMLButtonElement>('button')] : [];
  }

  function effort(label: string): HTMLButtonElement | undefined {
    return effortButtons().find((candidate) => candidate.textContent?.trim() === label);
  }

  function pressedEfforts(): string[] {
    return effortButtons()
      .filter((candidate) => candidate.getAttribute('aria-pressed') === 'true')
      .map((candidate) => candidate.textContent?.trim() ?? '');
  }

  function disabledEfforts(): string[] {
    return effortButtons()
      .filter(
        (candidate) =>
          candidate.hasAttribute('disabled') || candidate.getAttribute('aria-disabled') === 'true'
      )
      .map((candidate) => candidate.textContent?.trim() ?? '');
  }

  /** Same open-then-pick sequence the other Base UI select tests use. */
  async function pick(
    triggerLabel: string,
    optionText: string,
    seen?: (labels: string[]) => void
  ): Promise<void> {
    const options = await openSelectOptions(triggerLabel);
    seen?.(options.map((candidate) => candidate.textContent?.trim() ?? ''));
    const option = options.find((candidate) => candidate.textContent?.trim() === optionText);
    if (!option) throw new Error(`no option ${optionText} under ${triggerLabel}`);
    await act(async () => {
      option.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    await act(async () => option.click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
  }

  function sentMeta(): unknown {
    return api.upsert.mock.calls[0][0].modelMeta;
  }

  describe('layout and selection', () => {
    it('opens an edit on the stored models and metadata, first model shown, without a fetch', async () => {
      api.upsert.mockResolvedValue(provider());
      await mountDialog(
        provider({
          models: ['deepseek-chat', 'deepseek-reasoner'],
          modelMeta: {
            'deepseek-chat': {
              name: 'Chat',
              contextWindow: 65536,
              maxTokens: 4096,
              reasoning: true,
              input: ['text'],
            },
          },
        })
      );

      expect(text()).toContain('Model settings');
      expect(chips()).toHaveLength(0);
      expect(tabs()).toHaveLength(2);
      expect(tab('deepseek-chat')?.getAttribute('aria-selected')).toBe('true');
      // The display name leads, the id follows, and the entry is marked customized.
      expect(tab('deepseek-chat')?.textContent).toContain('Chat');
      expect(tab('deepseek-chat')?.textContent).toContain('Customized');
      expect(tab('deepseek-reasoner')?.textContent).not.toContain('Customized');
      expect(panelModel()).toBe('deepseek-chat');
      expect(displayName()?.value).toBe('Chat');
      expect(contextWindow()?.value).toBe('65536');
      expect(maxTokens()?.value).toBe('4096');
      expect(isOn(switchFor('Reasoning'))).toBe(true);

      // Round-tripping the form unchanged must not lose any of it.
      await save();
      expect(sentMeta()).toEqual({
        'deepseek-chat': {
          name: 'Chat',
          contextWindow: 65536,
          maxTokens: 4096,
          reasoning: true,
          input: ['text'],
        },
      });
    });

    it('shows the model picked in the column', async () => {
      await mountDialog(
        provider({
          models: ['deepseek-chat', 'deepseek-reasoner'],
          modelMeta: { 'deepseek-reasoner': { contextWindow: 163840 } },
        })
      );

      await click(tab('deepseek-reasoner'));
      expect(tab('deepseek-reasoner')?.getAttribute('aria-selected')).toBe('true');
      expect(panelModel()).toBe('deepseek-reasoner');
      expect(contextWindow()?.value).toBe('163840');
    });

    it('a ticked chip becomes the shown model; unticking it falls back to the first', async () => {
      api.fetchModels.mockResolvedValue({ ok: true, models: ['a', 'b', 'c'] });
      await mountDialog(provider({ models: [] }));
      await fetchModels();
      // Nothing ticked yet: the hint, no block.
      expect(text()).toContain('Select models above to configure them here.');
      expect(panel()).toBeNull();

      await click(chip('a'));
      chip('b')?.focus();
      await click(chip('b'));
      expect(panelModel()).toBe('b');
      expect(tab('b')?.getAttribute('aria-selected')).toBe('true');
      // Focus stays on the chip that was clicked.
      expect(document.activeElement).toBe(chip('b'));
      expect(text()).not.toContain('Select models above to configure them here.');
      await click(chip('b'));
      expect(panelModel()).toBe('a');
      await click(chip('a'));
      expect(panel()).toBeNull();
    });

    it('removing the shown model from the panel drops it and its metadata, and sends {}', async () => {
      // The scenario: an edit opened but never probed. The chips are not on
      // screen at all, so the panel's X is the only way to deselect.
      api.upsert.mockResolvedValue(provider());
      await mountDialog(
        provider({
          models: ['deepseek-chat', 'deepseek-reasoner'],
          modelMeta: { 'deepseek-chat': { contextWindow: 65536 } },
        })
      );

      await click(byLabel('Remove this model'));
      expect(tabs()).toHaveLength(1);
      expect(panelModel()).toBe('deepseek-reasoner');
      await save();

      // Sent as an explicit empty map, because leaving it out would tell the
      // service to keep the stored entry (decision 165).
      expect(api.upsert.mock.calls[0][0]).toMatchObject({ models: ['deepseek-reasoner'] });
      expect(sentMeta()).toEqual({});
    });

    it('drops metadata for a model the user deselected', async () => {
      api.upsert.mockResolvedValue(provider());
      api.fetchModels.mockResolvedValue({
        ok: true,
        models: ['deepseek-chat', 'deepseek-reasoner'],
      });
      await mountDialog(
        provider({
          models: ['deepseek-chat', 'deepseek-reasoner'],
          modelMeta: {
            'deepseek-chat': { contextWindow: 65536 },
            'deepseek-reasoner': { contextWindow: 163840 },
          },
        })
      );

      await fetchModels();
      expect(chip('deepseek-reasoner')?.getAttribute('aria-pressed')).toBe('true');
      await click(chip('deepseek-reasoner'));
      await save();

      expect(api.upsert.mock.calls[0][0]).toMatchObject({
        models: ['deepseek-chat'],
        modelMeta: { 'deepseek-chat': { contextWindow: 65536 } },
      });
    });

    it('keeps a hand-typed model across a fetch the service does not list it in', async () => {
      // The regression: `runProbe` used to filter `selected` down to the
      // service's answer, silently deleting a model the user had typed — and
      // with it the metadata they had just filled in.
      api.upsert.mockResolvedValue(provider());
      api.fetchModels.mockResolvedValue({ ok: true, models: ['deepseek-chat'] });
      await mountDialog(
        provider({
          models: ['my-gateway/llama-4-preview'],
          modelMeta: { 'my-gateway/llama-4-preview': { contextWindow: 131072 } },
        })
      );

      await fetchModels();

      expect(tab('my-gateway/llama-4-preview')).toBeDefined();
      await save();
      expect(api.upsert.mock.calls[0][0]).toMatchObject({
        models: ['my-gateway/llama-4-preview'],
        modelMeta: { 'my-gateway/llama-4-preview': { contextWindow: 131072 } },
      });
    });

    it('does not auto-select anything on a first fetch', async () => {
      // 200 returned models must not become 200 selected models.
      api.fetchModels.mockResolvedValue({ ok: true, models: ['a', 'b', 'c'] });
      await mountDialog(provider({ models: [] }));

      await fetchModels();

      expect(text()).not.toContain('1 selected');
      expect(text()).not.toContain('3 selected');
      expect(chips()).toHaveLength(3);
      expect(chips().every((candidate) => candidate.getAttribute('aria-pressed') === 'false')).toBe(
        true
      );
    });

    it('omits modelMeta entirely when every field is left blank', async () => {
      api.upsert.mockResolvedValue(provider());
      await mountDialog(provider());

      await save();

      expect(api.upsert.mock.calls[0][0]).not.toHaveProperty('modelMeta');
    });
  });

  describe('fields', () => {
    it('carries a display name (trimmed), numbers and the image switch through', async () => {
      api.upsert.mockResolvedValue(provider());
      await mountDialog(provider());

      await type(displayName(), '  DeepSeek Chat  ');
      await type(contextWindow(), '200000');
      await type(maxTokens(), '8,192');
      await click(switchFor('Image input'));
      expect(isOn(switchFor('Image input'))).toBe(true);
      await save();

      // Text is always implied, so the switch writes both.
      expect(sentMeta()).toEqual({
        'deepseek-chat': {
          name: 'DeepSeek Chat',
          contextWindow: 200000,
          maxTokens: 8192,
          input: ['text', 'image'],
        },
      });
    });

    it.each([
      '0',
      '-1',
      '1.5',
      '1e999',
      '32k',
    ])('marks a context window of %s invalid, in the field and the column, and blocks the save', async (raw) => {
      await mountDialog(provider());

      await type(contextWindow(), raw);

      expect(contextWindow()?.value).toBe(raw);
      expect(contextWindow()?.getAttribute('aria-invalid')).toBe('true');
      expect(panel()?.textContent).toContain('Enter a whole number greater than 0.');
      expect(tab('deepseek-chat')?.textContent).toContain('Has invalid values');
      expect(saveButton()?.disabled).toBe(true);
      expect(text()).toContain(
        'Some model settings are not valid. Fix the models marked in the list, then save.'
      );

      await type(contextWindow(), '');
      expect(saveButton()?.disabled).toBe(false);
    });

    it("keeps each model's typed text to itself", async () => {
      await mountDialog(provider({ models: ['a', 'b'] }));

      await type(contextWindow(), 'abc');
      await click(tab('b'));
      expect(panelModel()).toBe('b');
      expect(contextWindow()?.value).toBe('');
      expect(panel()?.textContent).not.toContain('Enter a whole number greater than 0.');
      // Still blocked: the invalid text is on a model that is not shown.
      expect(saveButton()?.disabled).toBe(true);
      expect(tab('a')?.textContent).toContain('Has invalid values');
      expect(tab('b')?.textContent).not.toContain('Has invalid values');

      await click(tab('a'));
      expect(contextWindow()?.value).toBe('abc');
    });

    it('warns, without blocking, when the output limit is over half the context window', async () => {
      await mountDialog(provider());

      await type(maxTokens(), '100000');
      expect(panel()?.textContent).toContain(
        'Over half of the default context window (128000): fill in the context window as well'
      );
      // Declared: 100000 is over half of 150000, planned as a quarter of it.
      await type(contextWindow(), '150000');
      expect(panel()?.textContent).toContain(
        'the reply reservation is planned as 37500 tokens (a quarter of the window)'
      );
      await type(contextWindow(), '200000');
      expect(panel()?.textContent).not.toContain('Over half of');
      expect(saveButton()?.disabled).toBe(false);
    });

    it('resets a model to its defaults: the prefill for an adaptive Claude, nothing otherwise', async () => {
      api.upsert.mockResolvedValue(provider());
      await mountDialog(
        provider({
          ...CLAUDE,
          models: ['claude-opus-5-5', 'gpt-x'],
          modelMeta: {
            'claude-opus-5-5': { maxTokens: 32000 },
            'gpt-x': { contextWindow: 65536 },
          },
        })
      );

      const reset = () => byLabel('Reset to defaults') as HTMLButtonElement | null;
      expect(reset()?.disabled).toBe(false);
      await click(reset());
      expect(maxTokens()?.value).toBe('');
      expect(isOn(switchFor('Adaptive thinking'))).toBe(true);
      // Already the default now.
      expect(reset()?.disabled).toBe(true);
      expect(tab('claude-opus-5-5')?.textContent).not.toContain('Customized');

      await click(tab('gpt-x'));
      await click(reset());
      expect(contextWindow()?.value).toBe('');
      await save();
      expect(sentMeta()).toEqual({
        'claude-opus-5-5': {
          reasoning: true,
          adaptiveThinking: true,
          efforts: ['low', 'medium', 'high', 'max'],
        },
      });
    });
  });

  describe('thinking', () => {
    it('offers adaptive thinking only for Anthropic Messages', async () => {
      await mountDialog(provider());
      expect(switchFor('Reasoning')).not.toBeNull();
      expect(switchFor('Adaptive thinking')).toBeNull();
      await act(() => root.unmount());
      root = createRoot(container);

      await mountDialog(provider({ ...CLAUDE, models: ['claude-opus-5-5'] }));
      expect(switchFor('Adaptive thinking')).not.toBeNull();
    });

    it('ticking adaptive thinking turns Reasoning on; turning Reasoning off turns it off', async () => {
      await mountDialog(provider({ ...CLAUDE, models: ['claude-opus-5-5'] }));
      await click(switchFor('Adaptive thinking'));
      expect([isOn(switchFor('Reasoning')), isOn(switchFor('Adaptive thinking'))]).toEqual([
        true,
        true,
      ]);
      await click(switchFor('Reasoning'));
      expect([isOn(switchFor('Reasoning')), isOn(switchFor('Adaptive thinking'))]).toEqual([
        false,
        false,
      ]);
      // No levels without reasoning.
      expect(byLabel('Available reasoning efforts')).toBeNull();
    });

    it('turning both off on an edit sends an empty map, so the stored switch is cleared', async () => {
      api.upsert.mockResolvedValue(provider());
      await mountDialog(
        provider({
          ...CLAUDE,
          models: ['claude-opus-5-5'],
          modelMeta: { 'claude-opus-5-5': { reasoning: true, adaptiveThinking: true } },
        })
      );
      await click(switchFor('Adaptive thinking'));
      await click(switchFor('Reasoning'));
      await save();
      expect(sentMeta()).toEqual({});
    });

    it('prefills a ticked adaptive Claude, levels up to Max, and shows it', async () => {
      api.upsert.mockResolvedValue(provider());
      api.fetchModels.mockResolvedValue({
        ok: true,
        models: ['claude-opus-5-5', 'claude-haiku-4-5'],
      });
      await mountDialog(provider({ ...CLAUDE, models: [] }));
      await fetchModels();

      await click(chip('claude-haiku-4-5'));
      expect(panelModel()).toBe('claude-haiku-4-5');
      expect(isOn(switchFor('Adaptive thinking'))).toBe(false);
      await click(chip('claude-opus-5-5'));
      expect(panelModel()).toBe('claude-opus-5-5');
      expect(isOn(switchFor('Adaptive thinking'))).toBe(true);
      expect(pressedEfforts()).toEqual(['Low', 'Medium', 'High', 'Max']);
      // The prefill is the default, not a customization.
      expect(tab('claude-opus-5-5')?.textContent).not.toContain('Customized');
      await save();
      expect(sentMeta()).toEqual({
        'claude-opus-5-5': {
          reasoning: true,
          adaptiveThinking: true,
          efforts: ['low', 'medium', 'high', 'max'],
        },
      });
    });

    it('does not prefill under another API style', async () => {
      api.upsert.mockResolvedValue(provider());
      api.fetchModels.mockResolvedValue({ ok: true, models: ['claude-opus-5-5'] });
      await mountDialog(provider({ models: [] }));
      await fetchModels();

      await click(chips()[0]);
      expect(isOn(switchFor('Reasoning'))).toBe(false);
      await save();
      expect(api.upsert.mock.calls[0][0]).not.toHaveProperty('modelMeta');
    });

    it('disables the levels the style cannot use, unpressed (matrix)', async () => {
      await mountDialog(
        provider({
          ...CLAUDE,
          models: ['claude-opus-5-5', 'claude-haiku-4-5'],
          modelMeta: {
            'claude-opus-5-5': { reasoning: true, adaptiveThinking: true },
            'claude-haiku-4-5': { reasoning: true, efforts: ['minimal', 'low', 'max'] },
          },
        })
      );
      // Six levels, never Off.
      expect(effortButtons().map((candidate) => candidate.textContent?.trim())).toEqual([
        'Minimal',
        'Low',
        'Medium',
        'High',
        'X-High',
        'Max',
      ]);
      // Adaptive: no Minimal.
      expect(disabledEfforts()).toEqual(['Minimal']);
      expect(pressedEfforts()).toEqual(['Low', 'Medium', 'High']);

      // Budget thinking: X-High and Max are High; a stored Max shows unpressed.
      await click(tab('claude-haiku-4-5'));
      expect(disabledEfforts()).toEqual(['X-High', 'Max']);
      expect(pressedEfforts()).toEqual(['Minimal', 'Low']);
    });

    it('offers all six on OpenAI styles and keeps at least one pressed', async () => {
      api.upsert.mockResolvedValue(provider());
      await mountDialog(provider({ modelMeta: { 'deepseek-chat': { reasoning: true } } }));
      expect(disabledEfforts()).toEqual([]);
      expect(pressedEfforts()).toEqual(['Low', 'Medium', 'High']);

      await click(effort('Minimal'));
      await click(effort('Max'));
      await click(effort('Low'));
      await click(effort('Medium'));
      await click(effort('High'));
      await click(effort('Minimal'));
      // Only Max left: it cannot be the one to go.
      expect(pressedEfforts()).toEqual(['Max']);
      expect(disabledEfforts()).toEqual(['Max']);
      await click(effort('Max'));
      expect(pressedEfforts()).toEqual(['Max']);

      await save();
      expect(sentMeta()).toEqual({ 'deepseek-chat': { reasoning: true, efforts: ['max'] } });
    });

    it('normalizes the levels when adaptive thinking is turned off', async () => {
      api.upsert.mockResolvedValue(provider());
      await mountDialog(
        provider({
          ...CLAUDE,
          models: ['claude-opus-5-5'],
          modelMeta: {
            'claude-opus-5-5': { reasoning: true, adaptiveThinking: true, efforts: ['max'] },
          },
        })
      );
      expect(pressedEfforts()).toEqual(['Max']);

      await click(switchFor('Adaptive thinking'));
      // Budget thinking has no Max: back to the implied three.
      expect(pressedEfforts()).toEqual(['Low', 'Medium', 'High']);
      await save();
      expect(sentMeta()).toEqual({ 'claude-opus-5-5': { reasoning: true } });
    });

    it('normalizes the levels for a new API style, keeping the hidden fields out of the save', async () => {
      api.upsert.mockResolvedValue(provider());
      await mountDialog(
        provider({
          modelMeta: {
            'deepseek-chat': {
              reasoning: true,
              efforts: ['minimal', 'xhigh'],
              compatPreset: 'deepseek',
            },
          },
        })
      );
      expect(pressedEfforts()).toEqual(['Minimal', 'X-High']);

      await pick('API style', 'Anthropic Messages');
      expect(byLabel('Vendor protocol')).toBeNull();
      expect(pressedEfforts()).toEqual(['Minimal']);
      await save();
      expect(sentMeta()).toEqual({ 'deepseek-chat': { reasoning: true, efforts: ['minimal'] } });
    });

    it('offers the vendor protocol only for Chat Completions with reasoning on', async () => {
      api.upsert.mockResolvedValue(provider());
      await mountDialog(provider());
      expect(byLabel('Vendor protocol')).toBeNull();

      await click(switchFor('Reasoning'));
      expect(byLabel('Vendor protocol')?.textContent).toContain(
        'Automatic (by service name and address)'
      );
      let labels: string[] = [];
      await pick('Vendor protocol', 'DeepSeek', (seen) => {
        labels = seen;
      });
      expect(labels).toEqual([
        'Automatic (by service name and address)',
        'OpenAI',
        'DeepSeek',
        'Qwen',
        'Qwen (chat template)',
        'Zhipu GLM',
        'OpenRouter',
      ]);
      expect(byLabel('Vendor protocol')?.textContent).toContain('DeepSeek');
      await save();
      expect(sentMeta()).toEqual({
        'deepseek-chat': { reasoning: true, compatPreset: 'deepseek' },
      });
    });

    it('replaces the levels with a note for the chat-template dialect', async () => {
      api.upsert.mockResolvedValue(provider());
      await mountDialog(
        provider({
          modelMeta: { 'deepseek-chat': { reasoning: true, efforts: ['max'] } },
        })
      );
      expect(effortButtons()).toHaveLength(6);

      await pick('Vendor protocol', 'Qwen (chat template)');
      expect(byLabel('Available reasoning efforts')).toBeNull();
      expect(panel()?.textContent).toContain(
        'This format only turns thinking on or off and sends no level'
      );
      await save();
      expect(sentMeta()).toEqual({
        'deepseek-chat': { reasoning: true, compatPreset: 'qwen-chat-template' },
      });
    });
  });
});
