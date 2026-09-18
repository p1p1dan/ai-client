// @vitest-environment happy-dom
import { effectivePolicy, type PermissionPolicySnapshot } from '@shared/piPermissionPolicy';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The policy panel opens folded, and costs nothing until it is unfolded.
 *
 * It moved off the Pi page and onto Advanced, where it is one of three sections
 * rather than the largest thing on the page. Two properties make that move an
 * improvement rather than a relocation, and neither is visible in the source:
 *
 *  1. **The rules are hidden but the heading is not.** "Who decides whether a
 *     tool call runs, and where do I change it" has to stay answerable on the
 *     page — folding the answer away entirely would be hiding information, not
 *     tidying it.
 *  2. **Nothing is read until someone asks.** The snapshot is three policy
 *     files off disk through IPC; doing that on every visit to Advanced, for a
 *     section that stays shut, is work nobody asked for.
 */

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key, locale: 'en' }) }));

import { PermissionPolicySettings } from '../PermissionPolicySettings';

const SNAPSHOT: PermissionPolicySnapshot = {
  route: 'managed',
  agentDir: '/home/u/.app/pi-agent',
  editable: true,
  scopes: [],
  effective: effectivePolicy([]),
};

const piPermissions = {
  get: vi.fn<() => Promise<PermissionPolicySnapshot>>(),
  update: vi.fn(),
  reset: vi.fn(),
  reveal: vi.fn(),
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  piPermissions.get.mockResolvedValue(SNAPSHOT);
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    piPermissions,
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

function trigger(): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((node) =>
    node.textContent?.includes('Permission rules')
  );
}

describe('permission policy panel disclosure', () => {
  it('shows what it is for without reading any policy file', async () => {
    await act(() => root.render(createElement(PermissionPolicySettings, {})));
    await settle();

    expect(container.textContent).toContain('Permission policy');
    expect(container.textContent).toContain(
      'Review the policy applied before Pi tool calls and edit your own overrides.'
    );
    expect(trigger()).toBeDefined();
    expect(piPermissions.get).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('Default actions');
  });

  it('loads the snapshot once, on the first expand, and shows the rules', async () => {
    await act(() => root.render(createElement(PermissionPolicySettings, { repoPath: '/repo' })));
    await settle();

    await act(() => {
      trigger()?.click();
    });
    await settle();

    expect(piPermissions.get).toHaveBeenCalledExactlyOnceWith({ repoPath: '/repo' });
    expect(container.textContent).toContain('Default actions');
    expect(container.textContent).toContain('Configuration sources');
  });
});
