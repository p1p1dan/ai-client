// @vitest-environment happy-dom

import type { UsageStatsResult } from '@shared/types';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F10 — the account card's weekly-allowance tile, rendered for real.
 *
 * A `.tsx`-only assertion has no coverage under the repo's node-env vitest, and
 * the two facts worth pinning here are both about what reaches the SCREEN: that
 * the retired call count is gone, and that a missing allowance says 暂不可用
 * instead of `NaN` or a fabricated `$0.00 / $0.00`.
 */

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key, locale: 'en' }) }));

let usageData: UsageStatsResult | undefined;

vi.mock('@/hooks/useUsageStats', () => ({
  useUsageStats: () => ({ data: usageData, isLoading: false, isFetching: false, refetch: vi.fn() }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

let UserProfileCard: typeof import('../UserProfileCard')['UserProfileCard'];
let root: Root;
let container: HTMLDivElement;

beforeAll(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  ({ UserProfileCard } = await import('../UserProfileCard'));
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(data: UsageStatsResult) {
  usageData = data;
  act(() => {
    root.render(
      createElement(UserProfileCard, {
        presentation: { tone: 'signed-in', email: 'user@example.com' },
      })
    );
  });
  return container.textContent ?? '';
}

const base = { todayCount: 3, todayCostUsd: 0.07, monthCount: 9, monthCostUsd: 0.13 };

describe('F10 weekly limit tile', () => {
  it('replaces the monthly call count with the allowance', () => {
    const text = render({ ...base, weeklyQuota: { usedUsd: 12.4, limitUsd: 50 } });
    expect(text).toContain('Weekly limit');
    expect(text).toContain('$12.40 / $50.00');
    expect(text).toContain('Remaining $37.60');
    // The retired tile, and the figure behind it, are both gone.
    expect(text).not.toContain('This month calls');
  });

  it('says 暂不可用 rather than NaN when no allowance is configured', () => {
    const text = render({ ...base, weeklyQuota: null });
    expect(text).toContain('Not available');
    expect(text).not.toMatch(/NaN|%/);
    expect(container.querySelector('[style*="width"]')).toBeNull();
  });

  it('marks an exceeded allowance and states the overage', () => {
    const text = render({ ...base, weeklyQuota: { usedUsd: 62.5, limitUsd: 50 } });
    expect(text).toContain('Over limit $12.50');
    expect(container.querySelector('.bg-destructive')).not.toBeNull();
  });

  it('keeps the account details and the logout button when usage fails entirely', () => {
    // The field report is explicit: a network failure may not disturb these.
    const text = render({ error: 'Usage API request failed (503)' });
    expect(text).toContain('user@example.com');
    expect(text).toContain('Logout');
    expect(text).toContain('Not available');
    expect(text).not.toMatch(/NaN/);
  });
});
