import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * D47 S2a §1-S2b-⑤ — the `AUTH_MANAGED_MODE` handler registered by
 * `registerClaudeRuntimeHandlers`. Drives the REAL production handler
 * (captured via a mocked `ipcMain.handle`), asserting the exact
 * `{managed, claudeHomeDir}` shape S2b's Provider/UI layer consumes.
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

describe('AUTH_MANAGED_MODE handler (D47 S2a §1-S2b-⑤)', () => {
  const originalFlag = process.env.AICLIENT_MANAGED_CREDENTIALS;

  beforeEach(async () => {
    vi.resetModules();
    handlers.clear();
    const { registerClaudeRuntimeHandlers } = await import('../claudeRuntime');
    registerClaudeRuntimeHandlers();
  });

  afterEach(() => {
    if (originalFlag === undefined) delete process.env.AICLIENT_MANAGED_CREDENTIALS;
    else process.env.AICLIENT_MANAGED_CREDENTIALS = originalFlag;
  });

  it('flag on: {managed: true, claudeHomeDir: <userData>/claude-home}', () => {
    process.env.AICLIENT_MANAGED_CREDENTIALS = '1';
    const handler = handlers.get('auth:managedMode');
    expect(handler?.()).toEqual({ managed: true, claudeHomeDir: '/fake/userData/claude-home' });
  });

  it('flag off: {managed: false, claudeHomeDir: null}', () => {
    process.env.AICLIENT_MANAGED_CREDENTIALS = '0';
    const handler = handlers.get('auth:managedMode');
    expect(handler?.()).toEqual({ managed: false, claudeHomeDir: null });
  });

  it('CLAUDE_RUNTIME_REGISTER_ENV is gone (dead code removal)', () => {
    expect(handlers.has('claude:runtime:registerEnv')).toBe(false);
  });
});
