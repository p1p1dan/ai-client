// @vitest-environment happy-dom
import type { MigrationItem, MigrationItemKind, MigrationPlan } from '@shared/agentMigration';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A-round testing closes every surface that would pull a user's own Pi setup
 * into this app. `welcomeLocalEntry.test.ts` already pins the `WelcomeView`
 * button; this file pins the other two named in `@/lib/aRoundTesting`:
 * `AgentMigrationPrompt` (the startup dialog — suppressed outright, never
 * even inspects) and `AgentMigrationSettings` (the Settings-pane twin —
 * greyed out, stays visible).
 *
 * `LOCAL_SETUP_ENTRY_DISABLED` is imported for real, NOT mocked — every
 * assertion is phrased against its live value (`… ? 0 : 1`, `toBe(
 * LOCAL_SETUP_ENTRY_DISABLED)`) so flipping that one line back after A-round
 * leaves this suite green and still guarding the wiring, the same trick
 * `welcomeLocalEntry.test.ts` uses.
 */

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key, locale: 'en' }) }));

import { resetModalQueueForTests } from '@/stores/modalQueue';
import { LOCAL_SETUP_ENTRY_DISABLED } from '../../../lib/aRoundTesting';
import { AgentMigrationPrompt, migrationOfferWillOpen } from '../AgentMigrationPrompt';
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
  localStorage.clear();
  resetModalQueueForTests();
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
  localStorage.clear();
  vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('A-round: AgentMigrationPrompt (@/lib/aRoundTesting)', () => {
  it('inspects and opens only when the switch is off', async () => {
    await act(() => root.render(createElement(AgentMigrationPrompt)));
    await settle();

    expect(api.inspect).toHaveBeenCalledTimes(LOCAL_SETUP_ENTRY_DISABLED ? 0 : 1);
    expect(document.body.textContent?.includes('Bring over your personal Pi setup')).toBe(
      !LOCAL_SETUP_ENTRY_DISABLED
    );
  });

  it('migrationOfferWillOpen resolves false, without inspecting, only when the switch is on', async () => {
    const result = await migrationOfferWillOpen();
    expect(api.inspect).toHaveBeenCalledTimes(LOCAL_SETUP_ENTRY_DISABLED ? 0 : 1);
    expect(result).toBe(!LOCAL_SETUP_ENTRY_DISABLED);
  });
});

describe('A-round: AgentMigrationSettings (@/lib/aRoundTesting)', () => {
  function copyButton(): HTMLButtonElement | undefined {
    return [...document.body.querySelectorAll('button')].find((node) =>
      node.textContent?.includes('Copy selected')
    );
  }

  it('stays on screen but disables every control while the switch is on', async () => {
    await act(() => root.render(createElement(AgentMigrationSettings)));
    await settle();

    // Visible either way — this is the "greyed out, not hidden" surface.
    expect(document.body.textContent?.includes('Bring over your personal Pi setup')).toBe(true);

    const checkboxes = [...document.body.querySelectorAll('[role="checkbox"]')];
    expect(checkboxes.length).toBeGreaterThan(0);
    for (const box of checkboxes) {
      expect(box.getAttribute('data-disabled') === '').toBe(LOCAL_SETUP_ENTRY_DISABLED);
    }

    const overwriteSwitch = document.body.querySelector('[role="switch"]');
    expect(overwriteSwitch?.getAttribute('data-disabled') === '').toBe(LOCAL_SETUP_ENTRY_DISABLED);

    // With the switch OFF every item is pre-ticked, so an enabled button here
    // is the switch's own doing. With it ON, T099 also empties the selection,
    // so the button is disabled twice over — belt and braces, deliberately: the
    // copy must not become reachable by un-disabling one of the two.
    expect(copyButton()?.disabled).toBe(LOCAL_SETUP_ENTRY_DISABLED);
  });

  it('shows nothing as selected while the switch is on', async () => {
    await act(() => root.render(createElement(AgentMigrationSettings)));
    await settle();

    // T099: `data-disabled` alone was not the whole story. The items were still
    // pre-ticked underneath it, so the pane said "these three are queued" and
    // "you cannot untick them" in the same breath — about a copy that, during
    // A-round, would be the tester's own API keys. Frozen AND empty is the only
    // pair of statements that is true here.
    const checkboxes = [...document.body.querySelectorAll('[role="checkbox"]')];
    expect(checkboxes.length).toBeGreaterThan(0);
    for (const box of checkboxes) {
      expect(box.getAttribute('aria-checked')).toBe(LOCAL_SETUP_ENTRY_DISABLED ? 'false' : 'true');
      expect(box.getAttribute('data-disabled') === '').toBe(LOCAL_SETUP_ENTRY_DISABLED);
    }

    // And the section says why, rather than leaving dead controls unexplained.
    expect(document.body.textContent?.includes('Not available during the test round.')).toBe(
      LOCAL_SETUP_ENTRY_DISABLED
    );
  });
});
