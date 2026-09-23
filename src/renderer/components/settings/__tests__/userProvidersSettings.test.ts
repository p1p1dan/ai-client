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

/**
 * P2 / c-2 — the per-model metadata editor is the only place a user's model
 * capabilities are typed in, and it was the one surface the main-process tests
 * could not reach: `readDraft` and `toPiUserProvider` were covered, the form
 * that feeds them was not.
 *
 * Everything below drives the REAL dialog and asserts what `userProviders.upsert`
 * is handed, so the four regressions these guard are the ones a user would hit
 * (a value that never arrives, a value pi will silently ignore, metadata for a
 * model that was deselected, and a section that will not reopen).
 */
describe('ProviderSetupDialog — per-model metadata', () => {
  /** React tracks its own value on the node, so the native setter has to be used. */
  async function type(node: Element | null, value: string, event = 'input'): Promise<void> {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      if (node instanceof HTMLInputElement) setter?.call(node, value);
      node?.dispatchEvent(new Event(event, { bubbles: true }));
    });
  }

  /**
   * The metadata block for the single selected model. `placeholder="tokens"` is
   * shared by both number fields, so they are read positionally (context window
   * then output limit) — the same order the row renders them in.
   */
  function metaBlock(): { contextWindow: HTMLInputElement; maxTokens: HTMLInputElement } {
    const fields = [
      ...document.body.querySelectorAll<HTMLInputElement>('input[placeholder="tokens"]'),
    ];
    if (fields.length < 2) throw new Error('per-model metadata fields are not on screen');
    return { contextWindow: fields[0], maxTokens: fields[1] };
  }

  function panelButton(text: string): HTMLButtonElement | undefined {
    return [...document.body.querySelectorAll('button')].find((button) =>
      button.textContent?.trim().includes(text)
    );
  }

  /**
   * The probe's model chips. They are `aria-pressed` buttons too, and so are
   * the Text/Image toggles in every metadata row — those two are never model
   * ids, so they are excluded by name.
   */
  function modelChips(): HTMLButtonElement[] {
    return [...document.body.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')].filter(
      (button) => !['Text', 'Image'].includes(button.textContent?.trim() ?? '')
    );
  }

  /** Inside the metadata section, the only `aria-label`d control is that row's X. */
  function rowRemoveButton(modelId: string): HTMLButtonElement | undefined {
    const row = [...document.body.querySelectorAll('p')].find(
      (node) => node.textContent?.trim() === modelId
    )?.parentElement;
    return row?.querySelector<HTMLButtonElement>('button[aria-label="Remove"]') ?? undefined;
  }

  async function fetchModels(): Promise<void> {
    await act(async () => panelButton('Fetch models')?.click());
    await settle();
  }

  async function save(): Promise<void> {
    const button = [...document.body.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === 'Save'
    );
    await act(async () => button?.click());
    await settle();
  }

  it('pre-fills the row from stored metadata, so reopening is not a blank form', async () => {
    api.upsert.mockResolvedValue(provider());
    await mountDialog(
      provider({
        modelMeta: {
          'deepseek-chat': {
            contextWindow: 65536,
            maxTokens: 4096,
            reasoning: true,
            input: ['text'],
          },
        },
      })
    );

    expect(text()).toContain('Per-model metadata');
    expect(text()).toContain('deepseek-chat');
    const { contextWindow, maxTokens } = metaBlock();
    expect(contextWindow.value).toBe('65536');
    expect(maxTokens.value).toBe('4096');
    const reasoning = document.body.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(reasoning.checked).toBe(true);

    // Round-tripping the form unchanged must not lose any of it.
    await save();
    expect(api.upsert.mock.calls[0][0].modelMeta).toEqual({
      'deepseek-chat': { contextWindow: 65536, maxTokens: 4096, reasoning: true, input: ['text'] },
    });
  });

  it.each([
    '0',
    '-1',
    '1.5',
    '1e999',
  ])('drops a context window of %s instead of writing a number pi ignores', async (raw) => {
    api.upsert.mockResolvedValue(provider());
    await mountDialog(provider());

    await type(metaBlock().contextWindow, raw);
    await save();

    // Not `null`, not `Infinity`, not `NaN`: the field is simply absent, which
    // is what `pi`'s `parseModel` treats as "use the default".
    expect(api.upsert.mock.calls[0][0].modelMeta).toBeUndefined();
  });

  it('carries a valid context window and output limit through as numbers', async () => {
    api.upsert.mockResolvedValue(provider());
    await mountDialog(provider());

    const { contextWindow, maxTokens } = metaBlock();
    await type(contextWindow, '200000');
    await type(maxTokens, '8192');
    await save();

    expect(api.upsert.mock.calls[0][0].modelMeta).toEqual({
      'deepseek-chat': { contextWindow: 200000, maxTokens: 8192 },
    });
  });

  it('sends the reasoning switch and the input modalities', async () => {
    api.upsert.mockResolvedValue(provider());
    await mountDialog(provider());

    await act(async () => {
      (document.body.querySelector('input[type="checkbox"]') as HTMLInputElement).click();
    });
    // One row per selected model, so the modality buttons repeat down the
    // list; the first pair belongs to the only model here.
    const modalities = [
      ...document.body.querySelectorAll<HTMLButtonElement>('button[aria-pressed]'),
    ].filter((button) => ['Text', 'Image'].includes(button.textContent?.trim() ?? ''));
    const image = modalities.find((button) => button.textContent?.trim() === 'Image');
    await act(async () => image?.click());
    await save();

    // `text` is left out on purpose: pi's `parseInputs` falls back to it, and
    // the form only stores what the user actually declared (U08-2's rule that
    // an undeclared level is a guess).
    expect(api.upsert.mock.calls[0][0].modelMeta).toEqual({
      'deepseek-chat': { reasoning: true, input: ['image'] },
    });
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

    // The chips only exist after a probe answers, and they carry `aria-pressed`
    // — that is the one control in this form that clears a selection.
    await fetchModels();
    const chip = modelChips().find((button) => button.textContent?.trim() === 'deepseek-reasoner');
    expect(chip?.getAttribute('aria-pressed')).toBe('true');
    await act(async () => chip?.click());
    await save();

    expect(api.upsert.mock.calls[0][0]).toMatchObject({
      models: ['deepseek-chat'],
      modelMeta: { 'deepseek-chat': { contextWindow: 65536 } },
    });
  });

  it('removes a selected model from the row itself, without a fetch first', async () => {
    // The scenario: an edit opened but never probed. The chips are not on
    // screen at all, so the row's X is the only way to deselect.
    api.upsert.mockResolvedValue(provider());
    await mountDialog(
      provider({
        models: ['deepseek-chat', 'deepseek-reasoner'],
        modelMeta: { 'deepseek-chat': { contextWindow: 65536 } },
      })
    );

    expect(modelChips()).toHaveLength(0);
    const remove = rowRemoveButton('deepseek-chat');
    expect(remove).toBeDefined();
    await act(async () => remove?.click());
    await save();

    // Gone from the selection, and its metadata with it — the same state the
    // chip path produces.
    expect(api.upsert.mock.calls[0][0]).toMatchObject({ models: ['deepseek-reasoner'] });
    expect(api.upsert.mock.calls[0][0]).not.toHaveProperty('modelMeta');
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

    // Still selected, still carrying its metadata, still on screen.
    expect(text()).toContain('my-gateway/llama-4-preview');
    await save();
    expect(api.upsert.mock.calls[0][0]).toMatchObject({
      models: ['my-gateway/llama-4-preview'],
      modelMeta: { 'my-gateway/llama-4-preview': { contextWindow: 131072 } },
    });
  });

  it('does not auto-select anything on a first fetch', async () => {
    // The intent the old filter also served, and the one it must not lose:
    // 200 returned models must not become 200 selected models.
    api.upsert.mockResolvedValue(provider());
    api.fetchModels.mockResolvedValue({ ok: true, models: ['a', 'b', 'c'] });
    await mountDialog(provider({ models: [] }));

    await fetchModels();

    expect(document.body.textContent).not.toContain('1 selected');
    expect(document.body.textContent).not.toContain('3 selected');
    const chips = modelChips();
    expect(chips).toHaveLength(3);
    expect(chips.every((chip) => chip.getAttribute('aria-pressed') === 'false')).toBe(true);
  });

  it('omits modelMeta entirely when every field is left blank', async () => {
    api.upsert.mockResolvedValue(provider());
    await mountDialog(provider());

    await save();

    // An empty entry is noise in `models.json`; the save filter drops it.
    expect(api.upsert.mock.calls[0][0]).not.toHaveProperty('modelMeta');
  });
});
