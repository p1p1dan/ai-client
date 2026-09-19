// @vitest-environment happy-dom
import type { MigrationPlan } from '@shared/agentMigration';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * "Nothing to bring over" renders nothing at all.
 *
 * Two different shapes mean that, and the guard checks both: no `~/.pi/agent`
 * on the machine (`sourceExists: false`, the common case for a new user) and a
 * directory that exists but holds nothing this app would copy (`items: []`).
 * Either one rendering a section would put an empty box with a dead Copy button
 * in front of a user who has no idea what it is talking about — and with T099
 * pre-ticking nothing, an empty box is exactly what it would be.
 *
 * Deliberately NOT gated on `LOCAL_SETUP_ENTRY_DISABLED`: the A-round switch
 * greys the section out, this hides it, and the two are independent. Nothing is
 * mocked here but `t`.
 */

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key, locale: 'en' }) }));

import { AgentMigrationSettings } from '../AgentMigrationSettings';

const api = {
  inspect: vi.fn<() => Promise<MigrationPlan>>(),
  apply: vi.fn(),
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
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

async function renderWith(plan: MigrationPlan): Promise<void> {
  api.inspect.mockResolvedValue(plan);
  await act(() => root.render(createElement(AgentMigrationSettings)));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('AgentMigrationSettings with nothing to migrate', () => {
  it('renders nothing when the user has no Pi directory at all', async () => {
    await renderWith({
      sourceDir: '/home/u/.pi/agent',
      targetDir: '/home/u/.app/pi-agent',
      sourceExists: false,
      items: [],
      nothingToDo: true,
    });

    expect(api.inspect).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe('');
    expect(container.querySelector('[role="checkbox"]')).toBeNull();
    expect(container.querySelector('[role="switch"]')).toBeNull();
  });

  it('renders nothing when the directory exists but holds nothing to copy', async () => {
    await renderWith({
      sourceDir: '/home/u/.pi/agent',
      targetDir: '/home/u/.app/pi-agent',
      sourceExists: true,
      items: [],
      nothingToDo: true,
    });

    expect(container.textContent).toBe('');
    // In particular: no heading, so the pane above it does not grow a divider
    // for a section with no content.
    expect(container.querySelector('h3')).toBeNull();
  });
});
