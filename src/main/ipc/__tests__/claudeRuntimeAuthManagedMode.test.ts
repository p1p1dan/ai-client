import { describe, expect, it, vi } from 'vitest';

/**
 * D47 S2a §1-S2b-⑤ / D47 S5 §1.2 — `AUTH_MANAGED_MODE` migrated from
 * `claudeRuntime.ts` to `auth.ts` (S5 §1.2: "顺迁 S2b 寄生在 claudeRuntime 的
 * AUTH_MANAGED_MODE"). This file now only asserts the DEAD-CODE side: the
 * channel is no longer registered by `registerClaudeRuntimeHandlers`. The
 * live handler behavior moved to `auth.test.ts`.
 */

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/fake/userData') },
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
}));

describe('claudeRuntime.ts no longer registers AUTH_MANAGED_MODE (D47 S5 §1.2 migration)', () => {
  it('registerClaudeRuntimeHandlers does not register auth:managedMode', async () => {
    vi.resetModules();
    handlers.clear();
    const { registerClaudeRuntimeHandlers } = await import('../claudeRuntime');
    registerClaudeRuntimeHandlers();

    expect(handlers.has('auth:managedMode')).toBe(false);
  });

  it('CLAUDE_RUNTIME_REGISTER_ENV is gone (dead code removal)', async () => {
    vi.resetModules();
    handlers.clear();
    const { registerClaudeRuntimeHandlers } = await import('../claudeRuntime');
    registerClaudeRuntimeHandlers();

    expect(handlers.has('claude:runtime:registerEnv')).toBe(false);
  });
});
