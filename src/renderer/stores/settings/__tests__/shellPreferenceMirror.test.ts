import { describe, expect, it } from 'vitest';
import { DEFAULT_USE_OPENCHAMBER_SHELL, parseShellPreference } from '../shellPreferenceMirror';

/**
 * T-16. The mirror exists to answer one question one frame earlier than
 * `electronStorage` can, so the only thing worth pinning is that it answers it
 * the same way the store would — and that a corrupt/absent entry falls back to
 * the default instead of, say, coercing every truthy string to the new shell.
 */
describe('parseShellPreference', () => {
  it('round-trips both explicit choices', () => {
    expect(parseShellPreference('true')).toBe(true);
    expect(parseShellPreference('false')).toBe(false);
  });

  it('falls back to the default when nothing was mirrored yet', () => {
    expect(parseShellPreference(null)).toBe(DEFAULT_USE_OPENCHAMBER_SHELL);
  });

  it('treats anything unrecognised as "not mirrored"', () => {
    // A JSON-quoted value is the likely shape of a hand-edit or an older
    // serialiser; '0'/'1' the likely shape of a hand-written toggle. None may
    // be guessed at — a wrong guess picks a shell the user did not choose.
    for (const raw of ['"false"', 'False', '0', '1', '', 'undefined']) {
      expect(parseShellPreference(raw), raw).toBe(DEFAULT_USE_OPENCHAMBER_SHELL);
    }
  });
});
