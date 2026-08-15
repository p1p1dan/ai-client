import { describe, expect, it } from 'vitest';
import { DEFAULT_MANAGED_MODE } from '../useManagedMode';

/**
 * D47 S2b §1 ④ (m6 first-frame race): `ProviderList`/`SessionBar`/
 * `ActionPanel` all render the managed-locked UI by default until
 * `auth.managedMode()` resolves. This codebase has no `renderHook`
 * infrastructure (no `@testing-library/react` devDependency — hooks here
 * are tested at the pure-data-shape level), so this pins the literal default
 * `useManagedMode` falls back to before the query resolves: it MUST read as
 * managed, never as unmanaged, or a flag-on user would see a one-frame flash
 * of the raw local Provider UI.
 */
describe('useManagedMode default (pre-resolve) value', () => {
  it('defaults to managed:true with no claudeHomeDir', () => {
    expect(DEFAULT_MANAGED_MODE).toEqual({ managed: true, claudeHomeDir: null });
  });

  it('never defaults to unmanaged — that would leak the raw local Provider UI before resolve', () => {
    expect(DEFAULT_MANAGED_MODE.managed).toBe(true);
  });
});
