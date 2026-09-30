// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { ChatBlock } from '@/stores/chatSessions';
import { PermissionActivityRows } from '../PermissionActivityRows';

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

const AUDIT_BLOCKS: ChatBlock[] = [
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

async function render(node: React.ReactElement, assert: (root: HTMLElement) => void) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(node));
    assert(container);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
}

/**
 * 2026-09-18: `PermissionActivityDetails` is gone (「输出过程中不要再显示『授权详情』
 * 这个项目了，不需要」), so this file asserts the half that STAYED — and the
 * reason it stayed. A denial must never become silent: it is the only thing on
 * screen explaining a turn that did less than it was asked to.
 */
it('renders every non-quiet audit record unconditionally — a denial is never behind a disclosure', async () => {
  const before = JSON.stringify(AUDIT_BLOCKS);
  await render(createElement(PermissionActivityRows, { blocks: AUDIT_BLOCKS }), (container) => {
    // pending + denied + gate error. The two quiet allows stay off screen.
    expect(container.querySelectorAll(':scope > ul > li')).toHaveLength(3);
    expect(container.textContent).toContain('Permission check failed');
    // The removed component was the only `<details>` on this surface; nothing
    // may reintroduce one around a refusal.
    expect(container.querySelector('details')).toBeNull();
    expect(JSON.stringify(AUDIT_BLOCKS)).toBe(before);
  });
});

it('keeps `includeAllowed` as the documented way back to the quiet records', async () => {
  // The quiet `policy_allow` gates are still IN the blocks and still reachable
  // — this parameter is what a future surface would use. Asserting it keeps the
  // removal reversible rather than a data loss.
  await render(
    createElement(PermissionActivityRows, { blocks: AUDIT_BLOCKS, includeAllowed: true }),
    (container) => {
      expect(container.querySelectorAll(':scope > ul > li')).toHaveLength(5);
    }
  );
});

/**
 * P1-7e e5 (problem 30, decision 143): a call a session grant let through has
 * no card, so its `session_grant` record is drawn without `includeAllowed`,
 * next to the denials; the other allows stay off screen.
 */
it('draws a session grant by default, and still no other allow', async () => {
  const blocks: ChatBlock[] = [
    ...AUDIT_BLOCKS,
    {
      id: 'granted',
      type: 'permission_activity',
      permissionActivity: {
        requestId: 'granted',
        phase: 'decision',
        surface: 'bash',
        value: 'echo two',
        result: 'allow',
        resolution: 'session_grant',
      },
    },
  ];
  await render(createElement(PermissionActivityRows, { blocks }), (container) => {
    const rows = [...container.querySelectorAll(':scope > ul > li')];
    expect(rows).toHaveLength(4);
    const granted = rows.at(-1);
    expect(granted?.getAttribute('data-tone')).toBe('auto');
    expect(granted?.textContent).toContain('Allowed {{surface}}');
    expect(granted?.textContent).toContain('echo two');
    expect(granted?.textContent).toContain('session grant');
  });
});
