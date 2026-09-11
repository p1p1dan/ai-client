// @vitest-environment happy-dom
import type { MigrationItem, MigrationItemKind, MigrationPlan } from '@shared/agentMigration';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * H/21 P1 — the one-time migration dialog, rendered for real against a stubbed
 * bridge.
 *
 * The rules are truth-tabled in `migrationPromptModel.test.ts` and the wiring
 * is scanned in `agentMigrationPromptWiring.test.ts`; neither can answer the
 * question that actually matters here — does this thing open for the right
 * person, stay shut for everyone else, and remember the answer. That needs a
 * mount, so this file uses the happy-dom setup the AI services pane already
 * established in this directory.
 */

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key, locale: 'en' }) }));

import { STORAGE_KEYS } from '../../../App/storage';
import { AgentMigrationPrompt } from '../AgentMigrationPrompt';

const api = {
  inspect: vi.fn<() => Promise<MigrationPlan>>(),
  apply: vi.fn(),
};

function item(kind: MigrationItemKind, overrides: Partial<MigrationItem> = {}): MigrationItem {
  return {
    kind,
    sourcePath: `/home/u/.pi/agent/${kind}`,
    targetPath: `/home/u/.app/pi-agent/${kind}`,
    entries: [],
    total: 3,
    conflicts: 0,
    blocked: 0,
    ...overrides,
  };
}

function plan(items: MigrationItem[], overrides: Partial<MigrationPlan> = {}): MigrationPlan {
  return {
    sourceDir: '/home/u/.pi/agent',
    targetDir: '/home/u/.app/pi-agent',
    sourceExists: true,
    items,
    nothingToDo: items.length === 0,
    ...overrides,
  };
}

const FULL_PLAN = plan([
  item('skills'),
  item('promptTemplates'),
  item('agentsFile', { total: 1 }),
  item('providers', { total: 2 }),
  item('sessions', { total: 417 }),
]);

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  api.inspect.mockResolvedValue(FULL_PLAN);
  api.apply.mockResolvedValue({ plan: FULL_PLAN, outcomes: [] });
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    agentMigration: api,
    env: { platform: 'linux' },
  };
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  localStorage.clear();
  vi.unstubAllGlobals();
});

function text(): string {
  return document.body.textContent ?? '';
}

function checkbox(label: string): HTMLInputElement | null {
  return document.body.querySelector(`[aria-label="${label}"]`);
}

function button(label: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll('button')].find((node) =>
    node.textContent?.includes(label)
  );
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount(): Promise<void> {
  await act(() => root.render(createElement(AgentMigrationPrompt)));
  await settle();
}

/** True once the user is done with the offer for good. */
function settled(): boolean {
  return localStorage.getItem(STORAGE_KEYS.AGENT_MIGRATION_PROMPTED) !== null;
}

describe('AgentMigrationPrompt — who sees it (H/21 P1)', () => {
  it('[MPI-01] opens for a user with a Pi setup worth copying', async () => {
    await mount();
    expect(text()).toContain('Bring over your personal Pi setup');
    expect(text()).toContain('/home/u/.pi/agent');
  });

  it('[MPI-02] stays shut, and does not even scan, once the user has opted out', async () => {
    localStorage.setItem(STORAGE_KEYS.AGENT_MIGRATION_PROMPTED, 'true');
    await mount();
    expect(api.inspect).not.toHaveBeenCalled();
    expect(text()).toBe('');
  });

  it('[MPI-03] says nothing to a user who has never run pi', async () => {
    api.inspect.mockResolvedValue(plan([], { sourceExists: false }));
    await mount();
    expect(text()).toBe('');
    // And leaves the flag alone: nothing was asked, so nothing was answered.
    expect(settled()).toBe(false);
  });

  it('[MPI-04] says nothing when every item would only collide', async () => {
    api.inspect.mockResolvedValue(plan([item('skills', { total: 3, conflicts: 3 })]));
    await mount();
    expect(text()).toBe('');
  });

  it('[MPI-05] a failed inspection costs nothing — no dialog, and the offer stands', async () => {
    api.inspect.mockRejectedValue(new Error('EACCES'));
    await mount();
    expect(text()).toBe('');
    expect(settled()).toBe(false);
  });
});

describe('AgentMigrationPrompt — what it offers (H/21 P1)', () => {
  it('[MPI-06] pre-ticks all five items, so the obvious answer is one click', async () => {
    await mount();
    for (const label of [
      'Skills',
      'Prompt templates',
      'AGENTS.md',
      'AI services',
      'Conversation history',
    ]) {
      expect(checkbox(label)?.getAttribute('aria-checked')).toBe('true');
    }
  });

  it('[MPI-07] shows the history count, so a huge one can be recognised and dropped', async () => {
    await mount();
    expect(text()).toContain('417');
  });

  it('[MPI-08] states the API-key consequence while AI services is ticked', async () => {
    await mount();
    expect(text()).toContain(
      'Your AI services include API keys. Copying them stores a copy in this app’s own credential vault. Uncheck that row to leave them out.'
    );
  });

  it('[MPI-09] unticking AI services removes both the copy and the warning', async () => {
    await mount();
    await act(async () => {
      checkbox('AI services')?.click();
    });

    expect(text()).not.toContain('Your AI services include API keys.');

    await act(async () => {
      button('Copy selected')?.click();
    });
    await settle();

    expect(api.apply).toHaveBeenCalledTimes(1);
    const request = api.apply.mock.calls[0]?.[0] as { kinds: MigrationItemKind[] };
    expect(request.kinds).not.toContain('providers');
    expect(request.kinds).toContain('skills');
  });
});

describe('AgentMigrationPrompt — answering it (H/21 P1)', () => {
  it('[MPI-10] "Not now" means later — it closes without copying and without opting out', async () => {
    // The label promises a later. Writing the permanent flag here is the bug
    // this test exists to prevent (user feedback, 2026-09-10).
    await mount();
    await act(async () => {
      button('Not now')?.click();
    });

    expect(api.apply).not.toHaveBeenCalled();
    expect(settled()).toBe(false);
    expect(text()).not.toContain('Copy selected');
  });

  it('[MPI-10b] the offer really does come back after "Not now"', async () => {
    await mount();
    await act(async () => {
      button('Not now')?.click();
    });
    // A second launch: same component, same storage, nothing copied in between.
    await act(() => root.unmount());
    root = createRoot(container);
    await mount();

    expect(text()).toContain('Bring over your personal Pi setup');
  });

  it('[MPI-10c] "Don’t ask again" is the one exit that is permanent', async () => {
    await mount();
    await act(async () => {
      button('Don’t ask again')?.click();
    });

    expect(api.apply).not.toHaveBeenCalled();
    expect(settled()).toBe(true);
  });

  it('[MPI-10d] closing by Escape is "Not now", never "never"', async () => {
    // Someone who dismisses a dialog by reflex has not opted out of anything.
    await mount();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await settle();

    expect(settled()).toBe(false);
  });

  it('[MPI-11] copying never overwrites — the user has seen counts, not names', async () => {
    await mount();
    await act(async () => {
      button('Copy selected')?.click();
    });
    await settle();

    const request = api.apply.mock.calls[0]?.[0] as { onConflict: string };
    expect(request.onConflict).toBe('skip');
  });

  it('[MPI-12] a successful copy also counts as answered', async () => {
    api.apply.mockResolvedValue({
      plan: FULL_PLAN,
      outcomes: [{ kind: 'skills', copied: 3, overwritten: 0, skipped: 0, failed: [] }],
    });
    await mount();
    await act(async () => {
      button('Copy selected')?.click();
    });
    await settle();

    expect(settled()).toBe(true);
    expect(text()).toContain('Copy finished');
  });

  it('[MPI-13] a failed copy leaves the offer standing', async () => {
    // Otherwise a transient failure silently costs the user the migration: the
    // dialog never returns, and nothing was copied.
    api.apply.mockRejectedValue(new Error('Could not save AI services: crypto_not_ready'));
    await mount();
    await act(async () => {
      button('Copy selected')?.click();
    });
    await settle();

    expect(settled()).toBe(false);
    expect(text()).toContain('crypto_not_ready');
  });

  it('[MPI-14] reports what each item did, including what failed', async () => {
    api.apply.mockResolvedValue({
      plan: FULL_PLAN,
      outcomes: [
        { kind: 'skills', copied: 3, overwritten: 0, skipped: 0, failed: [] },
        {
          kind: 'providers',
          copied: 0,
          overwritten: 0,
          skipped: 0,
          failed: [{ name: 'AI services', error: 'unlock the system keyring and try again' }],
        },
      ],
    });
    await mount();
    await act(async () => {
      button('Copy selected')?.click();
    });
    await settle();

    // A shorter result than promised has to say why, or it reads as success.
    expect(text()).toContain('unlock the system keyring and try again');
  });
});
