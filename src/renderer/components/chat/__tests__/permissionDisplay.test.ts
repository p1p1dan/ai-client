// @vitest-environment happy-dom
import { act, createElement, Fragment } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { ChatBlock } from '@/stores/chatSessions';
import { PermissionActivityDetails, PermissionActivityRows } from '../PermissionActivityRows';

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
it('keeps all audit records but folds allowed decisions while exposing pending, denied and gate errors', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const blocks: ChatBlock[] = [
    { requestId: 'auto', result: 'allow' as const, resolution: 'policy_allow' },
    { requestId: 'human', result: 'allow' as const, resolution: 'user_approved' },
    { requestId: 'pending' },
    { requestId: 'denied', result: 'deny' as const },
    { requestId: 'error', result: 'allow' as const, resolution: 'gate_error' },
  ].map((permissionActivity) => ({
    id: permissionActivity.requestId,
    type: 'permission_activity',
    permissionActivity,
  }));
  const before = JSON.stringify(blocks);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        createElement(
          Fragment,
          null,
          createElement(PermissionActivityRows, { blocks }),
          createElement(PermissionActivityDetails, { blocks })
        )
      )
    );
    expect(container.querySelectorAll(':scope > ul > li')).toHaveLength(3);
    const details = container.querySelector('details')!;
    expect(details.open).toBe(false);
    await act(async () => details.querySelector('summary')!.click());
    expect(details.open).toBe(true);
    expect(details.querySelectorAll('li')).toHaveLength(2);
    expect(JSON.stringify(blocks)).toBe(before);
    expect(container.textContent).toContain('Permission check failed');
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
