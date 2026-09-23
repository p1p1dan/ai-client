// @vitest-environment happy-dom
import type { MigrationItem, MigrationItemKind, MigrationPlan } from '@shared/agentMigration';
import type { LegacyImportProject } from '@shared/types';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Two switches in `@/lib/aRoundTesting` now govern the migration surfaces:
 *
 *  - `LOCAL_SETUP_ENTRY_DISABLED` — the A-round gate. `false` post-release, so
 *    the startup dialog is free to open and the settings pane is reachable.
 *  - `PI_MIGRATION_DISABLED` — suppresses the Pi-directory copy specifically.
 *    While `true`, the dialog never inspects `~/.pi/agent`, the Pi rows never
 *    appear, and the settings pane greys its controls out. The Claude Code /
 *    Codex history guide is the only actionable thing in the dialog then.
 *
 * Both are imported for real, NOT mocked — every assertion is phrased against
 * their live values, so flipping either line back leaves this suite green and
 * still guarding the wiring.
 */

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key, locale: 'en' }) }));

import { resetModalQueueForTests } from '@/stores/modalQueue';
import { LOCAL_SETUP_ENTRY_DISABLED, PI_MIGRATION_DISABLED } from '../../../lib/aRoundTesting';
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

const LEGACY_PROJECTS: LegacyImportProject[] = [
  { id: 'home-u', path: '/home/u', sessionCount: 11, lastActivityAt: 0 },
];

const agentApi = {
  inspect: vi.fn<() => Promise<MigrationPlan>>(),
  apply: vi.fn(),
};

const legacyApi = {
  listProjects: vi.fn<() => Promise<LegacyImportProject[]>>(),
  listSessions: vi.fn(),
  importBatch: vi.fn(),
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  resetModalQueueForTests();
  agentApi.inspect.mockResolvedValue(PLAN);
  legacyApi.listProjects.mockResolvedValue(LEGACY_PROJECTS);
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    agentMigration: agentApi,
    legacyImport: legacyApi,
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

describe('AgentMigrationPrompt: Pi copy suppression + Claude Code / Codex guide', () => {
  it('never inspects ~/.pi/agent while the Pi copy is suppressed', async () => {
    await act(() => root.render(createElement(AgentMigrationPrompt)));
    await settle();

    // PI_MIGRATION_DISABLED gates the inspect call: while on, no Pi scan runs.
    expect(agentApi.inspect).toHaveBeenCalledTimes(PI_MIGRATION_DISABLED ? 0 : 1);
    // The Claude Code / Codex scan always runs (unless the A-round gate closed
    // the whole dialog before any IPC).
    expect(legacyApi.listProjects).toHaveBeenCalledTimes(LOCAL_SETUP_ENTRY_DISABLED ? 0 : 1);
  });

  it('opens for the Claude Code / Codex guide when the Pi copy is suppressed', async () => {
    await act(() => root.render(createElement(AgentMigrationPrompt)));
    await settle();

    if (LOCAL_SETUP_ENTRY_DISABLED) {
      // The A-round gate suppresses the whole dialog before any IPC.
      expect(document.body.textContent ?? '').not.toContain('Import conversations');
      return;
    }
    // The guide renders, and no Pi "Copy selected" button does.
    expect(document.body.textContent?.includes('Import conversations')).toBe(PI_MIGRATION_DISABLED);
    expect(document.body.textContent?.includes('Copy selected')).toBe(!PI_MIGRATION_DISABLED);
  });

  it('migrationOfferWillOpen opens when there are Claude Code / Codex conversations, even with the Pi copy suppressed', async () => {
    const result = await migrationOfferWillOpen();
    if (LOCAL_SETUP_ENTRY_DISABLED) {
      expect(result).toBe(false);
      return;
    }
    // With the Pi copy suppressed there is no Pi inspect, but the legacy scan
    // can still open the dialog.
    expect(agentApi.inspect).toHaveBeenCalledTimes(PI_MIGRATION_DISABLED ? 0 : 1);
    expect(result).toBe(true);
  });

  it('migrationOfferWillOpen resolves false when there is nothing to offer', async () => {
    legacyApi.listProjects.mockResolvedValue([]);
    const result = await migrationOfferWillOpen();
    if (LOCAL_SETUP_ENTRY_DISABLED) {
      expect(result).toBe(false);
      return;
    }
    expect(result).toBe(!PI_MIGRATION_DISABLED);
  });
});

describe('AgentMigrationSettings: Pi copy suppression', () => {
  function copyButton(): HTMLButtonElement | undefined {
    return [...document.body.querySelectorAll('button')].find((node) =>
      node.textContent?.includes('Copy selected')
    );
  }

  it('stays on screen but disables every control while the Pi copy is suppressed', async () => {
    await act(() => root.render(createElement(AgentMigrationSettings)));
    await settle();

    // Visible either way — this is the "greyed out, not hidden" surface.
    expect(document.body.textContent?.includes('Bring over your personal Pi setup')).toBe(true);

    const checkboxes = [...document.body.querySelectorAll('[role="checkbox"]')];
    expect(checkboxes.length).toBeGreaterThan(0);
    for (const box of checkboxes) {
      expect(box.getAttribute('data-disabled') === '').toBe(PI_MIGRATION_DISABLED);
    }

    const overwriteSwitch = document.body.querySelector('[role="switch"]');
    expect(overwriteSwitch?.getAttribute('data-disabled') === '').toBe(PI_MIGRATION_DISABLED);

    // With the Pi copy available every item is pre-ticked, so an enabled button
    // here is the flag's own doing. With it suppressed, the selection is also
    // emptied, so the button is disabled twice over — belt and braces.
    expect(copyButton()?.disabled).toBe(PI_MIGRATION_DISABLED);
  });

  it('shows nothing as selected while the Pi copy is suppressed', async () => {
    await act(() => root.render(createElement(AgentMigrationSettings)));
    await settle();

    const checkboxes = [...document.body.querySelectorAll('[role="checkbox"]')];
    expect(checkboxes.length).toBeGreaterThan(0);
    for (const box of checkboxes) {
      expect(box.getAttribute('aria-checked')).toBe(PI_MIGRATION_DISABLED ? 'false' : 'true');
      expect(box.getAttribute('data-disabled') === '').toBe(PI_MIGRATION_DISABLED);
    }

    // And the section says why, rather than leaving dead controls unexplained.
    expect(document.body.textContent?.includes('Not available during the test round.')).toBe(
      PI_MIGRATION_DISABLED
    );
  });
});
