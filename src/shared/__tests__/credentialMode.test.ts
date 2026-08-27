import { describe, expect, it } from 'vitest';
import {
  CREDENTIAL_MODE_ENV,
  CREDENTIAL_MODE_SETTING_KEY,
  readCredentialModeSetting,
  resolveCredentialMode,
} from '../credentialMode';

/**
 * D64 / S3 — the rule that replaced a build-time environment flag with a
 * recorded user choice.
 */
describe('credential mode', () => {
  const packaged = (settings: unknown) =>
    resolveCredentialMode({ settings: () => settings, isPackaged: true });

  describe('the recorded choice', () => {
    it('is used when present', () => {
      expect(packaged({ [CREDENTIAL_MODE_SETTING_KEY]: 'local' })).toBe('local');
      expect(packaged({ [CREDENTIAL_MODE_SETTING_KEY]: 'managed' })).toBe('managed');
    });

    it('reads back as null when absent, so "unset" and "local" stay distinguishable', () => {
      expect(readCredentialModeSetting({})).toBeNull();
      expect(readCredentialModeSetting({ [CREDENTIAL_MODE_SETTING_KEY]: 'local' })).toBe('local');
    });

    it('ignores a value that is not one of the two modes', () => {
      for (const junk of ['LOCAL', 'Managed', '', true, 1, null, {}, ['local']]) {
        expect(readCredentialModeSetting({ [CREDENTIAL_MODE_SETTING_KEY]: junk })).toBeNull();
      }
    });

    it('survives a settings object that is not an object at all', () => {
      for (const junk of [null, undefined, 'x', 42, []]) {
        expect(readCredentialModeSetting(junk)).toBeNull();
      }
    });
  });

  /**
   * User ruling 2026-08-27 「首次必须登录」: nothing recorded means first run,
   * and a first run signs in. Stated as its own test because the consequence is
   * real — someone who upgrades having never signed in meets the login page.
   */
  describe('no choice recorded', () => {
    it('resolves to managed, which is what makes a first run sign in', () => {
      expect(packaged({})).toBe('managed');
      expect(packaged(null)).toBe('managed');
      expect(packaged({ somethingElse: true })).toBe('managed');
    });

    it('resolves to managed even for a settings file S2 migrated from the old directory', () => {
      // Migrated files carry onboarding state but no `credentialMode` key.
      expect(packaged({ onboarding: { registered: true, email: 'a@b.c' } })).toBe('managed');
    });
  });

  describe('the dev-only override', () => {
    it("'1' forces managed and '0' forces local, unpackaged", () => {
      const settings = { [CREDENTIAL_MODE_SETTING_KEY]: 'local' };
      expect(
        resolveCredentialMode({
          settings: () => settings,
          isPackaged: false,
          env: { [CREDENTIAL_MODE_ENV]: '1' },
        })
      ).toBe('managed');
      expect(
        resolveCredentialMode({
          settings: () => ({ [CREDENTIAL_MODE_SETTING_KEY]: 'managed' }),
          isPackaged: false,
          env: { [CREDENTIAL_MODE_ENV]: '0' },
        })
      ).toBe('local');
    });

    /**
     * The whole reason the old flag had to go (D58's reasoning, D64's ruling):
     * a packaged user cannot set an environment variable, so one must never be
     * able to decide their behaviour.
     */
    it('is ignored in a packaged build, in both directions', () => {
      expect(
        resolveCredentialMode({
          settings: () => ({ [CREDENTIAL_MODE_SETTING_KEY]: 'local' }),
          isPackaged: true,
          env: { [CREDENTIAL_MODE_ENV]: '1' },
        })
      ).toBe('local');
      expect(
        resolveCredentialMode({
          settings: () => ({}),
          isPackaged: true,
          env: { [CREDENTIAL_MODE_ENV]: '0' },
        })
      ).toBe('managed');
    });

    it('falls through to the recorded choice for any other spelling', () => {
      for (const junk of ['true', 'yes', '', ' 1', '1 ', '2', undefined]) {
        expect(
          resolveCredentialMode({
            settings: () => ({ [CREDENTIAL_MODE_SETTING_KEY]: 'local' }),
            isPackaged: false,
            env: junk === undefined ? {} : { [CREDENTIAL_MODE_ENV]: junk },
          })
        ).toBe('local');
      }
    });
  });
});
