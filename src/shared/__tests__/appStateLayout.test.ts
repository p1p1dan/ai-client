import { describe, expect, it } from 'vitest';
import {
  buildAppStateRoot,
  buildLegacyAppStateRoot,
  PACKAGED_USER_DATA_DIR_NAME,
  PRIOR_USER_DATA_DIR_NAMES,
} from '../appStateLayout';
import { APP_STATE_DIR, LEGACY_APP_STATE_DIR } from '../defaultPaths';

/** Plan `unified-credentials` S2 — the layout, asserted where it is pure. */
describe('app state root layout', () => {
  it('puts the profile layer under the state dir, taken from <userData>', () => {
    expect(buildAppStateRoot('/home/pi', '/home/pi/.config/jyw-ai-client')).toBe(
      `/home/pi/${APP_STATE_DIR}/jyw-ai-client`
    );
  });

  /**
   * The whole reason the profile layer exists (open-q #1): before S2 the vault
   * lived under `<userData>`, and Electron's `-dev` suffix kept a dev build
   * from writing the release build's credentials. Moving the vault into `$HOME`
   * must not hand that isolation back.
   */
  it('keeps the dev build and the release build on different roots', () => {
    const release = buildAppStateRoot('/home/pi', '/home/pi/.config/jyw-ai-client');
    const dev = buildAppStateRoot('/home/pi', '/home/pi/.config/jyw-ai-client-dev');
    expect(dev).not.toBe(release);
    expect(dev.startsWith(`/home/pi/${APP_STATE_DIR}/`)).toBe(true);
  });

  /** `AICLIENT_PROFILE=foo` moves `<userData>`; the state root has to follow with no second rule. */
  it('follows an arbitrary profile without a second source of truth', () => {
    expect(buildAppStateRoot('/home/pi', '/home/pi/.config/jyw-ai-client-scratch')).toBe(
      `/home/pi/${APP_STATE_DIR}/jyw-ai-client-scratch`
    );
  });

  /** Windows `<userData>` arrives back-slashed; the profile segment is still the last one. */
  it('reads the profile segment out of a Windows-shaped userData path', () => {
    expect(buildAppStateRoot('C:/Users/pi', 'C:\\Users\\pi\\AppData\\Roaming\\jyw-ai-client')).toBe(
      `C:/Users/pi/${APP_STATE_DIR}/jyw-ai-client`
    );
  });

  /** A trailing separator must not turn the profile into an empty segment. */
  it('tolerates a trailing separator on userData', () => {
    expect(buildAppStateRoot('/home/pi', '/home/pi/.config/jyw-ai-client/')).toBe(
      `/home/pi/${APP_STATE_DIR}/jyw-ai-client`
    );
  });

  /** The pre-rename root never had a profile layer, and the migration depends on that. */
  it('leaves the legacy root flat', () => {
    expect(buildLegacyAppStateRoot('/home/pi')).toBe(`/home/pi/${LEGACY_APP_STATE_DIR}`);
  });

  it('never resolves the new root onto the legacy one', () => {
    expect(buildAppStateRoot('/home/pi', '/home/pi/.config/jyw-ai-client')).not.toBe(
      buildLegacyAppStateRoot('/home/pi')
    );
  });
});

/**
 * ⚠️ FIELD DEFECT, 2026-09-21 — the prior-name list was written from the wrong file.
 *
 * The 1.0.0-test.17 rename populated `PRIOR_USER_DATA_DIR_NAMES` with
 * `AiClient`, read off `electron-builder.yml`'s `productName`. Electron does not
 * name `<userData>` from that file: `app.getName()` reads the packaged
 * `package.json`, which had no `productName` key before the rename, so `name`
 * won and every pre-test.17 install wrote `jyw-ai-client`.
 *
 * A tester upgrading from 1.0.0-test.16 on Windows therefore had sessions and a
 * vault in `~/.pilab/jyw-ai-client` while the migration searched
 * `~/.pilab/AiClient`, a path that had never existed — and the new build came up
 * factory-fresh, asking them to log in again. That is the exact outcome
 * `appStateMigration.ts`'s header calls the one thing it may not produce.
 *
 * Every other case in THIS FILE already spells the release profile
 * `jyw-ai-client`; the list was the only place that disagreed.
 */
describe('prior packaged <userData> names the migration searches', () => {
  it('[PRIOR-1] includes the name pre-rename builds actually wrote', () => {
    expect(PRIOR_USER_DATA_DIR_NAMES).toContain('jyw-ai-client');
  });

  /** Kept even though no shipped build is known to have used it — see the constant's note. */
  it('[PRIOR-2] keeps the productName-derived candidate too', () => {
    expect(PRIOR_USER_DATA_DIR_NAMES).toContain('AiClient');
  });

  /**
   * The destination can never be a source: `migrateAppState` would read its own
   * root and report a copy it did not make (`appStateMigration.test.ts`'s
   * "never treats the destination itself as a prior install" covers the runtime
   * half; this covers the data half).
   */
  it('[PRIOR-3] never lists the current packaged name', () => {
    expect(PRIOR_USER_DATA_DIR_NAMES).not.toContain(PACKAGED_USER_DATA_DIR_NAME);
  });

  /** A dev build's `<userData>` carries a `-<profile>` suffix and is never a migration source. */
  it('[PRIOR-4] lists no dev-suffixed profile', () => {
    for (const name of PRIOR_USER_DATA_DIR_NAMES) {
      expect(name).not.toMatch(/-dev$/);
    }
  });
});
