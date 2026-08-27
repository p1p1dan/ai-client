import { describe, expect, it } from 'vitest';
import { buildAppStateRoot, buildLegacyAppStateRoot } from '../appStateLayout';
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
