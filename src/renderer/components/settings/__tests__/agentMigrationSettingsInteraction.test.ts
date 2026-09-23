// @vitest-environment happy-dom
import type { MigrationItem, MigrationItemKind, MigrationPlan } from '@shared/agentMigration';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The migration pane with the A-round gate OPEN — the state it will ship in
 * once `LOCAL_SETUP_ENTRY_DISABLED` flips back to `false`.
 *
 * `aRoundMigrationGate.test.ts` next door reads that switch for real and so can
 * only ever exercise whichever side of it is live. Every control in here is
 * disabled while the gate is on, which means nothing was testing that they
 * WORK. This file mocks the switch off and clicks them.
 *
 * The specific trap it is here for: the overwrite Switch is a base-ui component,
 * and base-ui renders its root as a `<button>` — put one inside a `<label>` and
 * the label's own click forwarding fires a second click on it, toggling the
 * control back the moment the user releases. A `.click()` here is the cheapest
 * way to notice.
 */

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key, locale: 'en' }) }));
vi.mock('@/lib/aRoundTesting', () => ({
  LOCAL_SETUP_ENTRY_DISABLED: false,
  PI_MIGRATION_DISABLED: false,
}));

import { AgentMigrationSettings } from '../AgentMigrationSettings';

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

const PLAN: MigrationPlan = {
  sourceDir: '/home/u/.pi/agent',
  targetDir: '/home/u/.app/pi-agent',
  sourceExists: true,
  items: [item('providers'), item('sessions', { total: 417 })],
  nothingToDo: false,
};

const api = {
  inspect: vi.fn<() => Promise<MigrationPlan>>(),
  apply: vi.fn(),
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  api.inspect.mockResolvedValue(PLAN);
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
  vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('AgentMigrationSettings with the A-round gate open', () => {
  it('toggles the overwrite switch on a click', async () => {
    await act(() => root.render(createElement(AgentMigrationSettings)));
    await settle();

    const overwrite = document.body.querySelector<HTMLElement>('[role="switch"]');
    expect(overwrite, 'the overwrite switch is rendered').toBeTruthy();
    expect(overwrite?.hasAttribute('data-checked')).toBe(false);

    await act(async () => overwrite?.click());
    expect(overwrite?.hasAttribute('data-checked')).toBe(true);

    await act(async () => overwrite?.click());
    expect(overwrite?.hasAttribute('data-checked')).toBe(false);
  });

  it('pre-ticks every item and copies the selection the user leaves behind', async () => {
    await act(() => root.render(createElement(AgentMigrationSettings)));
    await settle();

    const boxes = [...document.body.querySelectorAll<HTMLElement>('[role="checkbox"]')];
    expect(boxes.length).toBe(2);
    for (const box of boxes) expect(box.getAttribute('aria-checked')).toBe('true');

    // Take one out, then copy: the checkboxes exist to REMOVE things.
    await act(async () => boxes[0]?.click());
    expect(boxes[0]?.getAttribute('aria-checked')).toBe('false');

    api.apply.mockResolvedValue({ outcomes: [], plan: PLAN });
    const copy = [...document.body.querySelectorAll('button')].find((node) =>
      node.textContent?.includes('Copy selected')
    );
    await act(async () => copy?.click());
    await settle();

    expect(api.apply).toHaveBeenCalledWith({ kinds: ['sessions'], onConflict: 'skip' });
  });
});
