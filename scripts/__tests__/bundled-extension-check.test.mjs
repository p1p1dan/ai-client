import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

// Loaded through `createRequire` on purpose: this is the CommonJS module the
// packaged-worker probe requires under Electron, and going through Node's own
// CJS loader tests the file the way the probe will load it.
const require = createRequire(import.meta.url);
const { checkBundledExtensionsLoaded } = require('../bundled-extension-check.cjs');

const PACKAGES = ['@juicesharp/rpiv-ask-user-question', '@gotgenes/pi-subagents'];

const POSIX_MODULES = '/opt/AiClient/resources/agent-host/node_modules';
const WINDOWS_MODULES = 'C:\\Users\\runneradmin\\AiClient\\resources\\agent-host\\node_modules';

const posix = (pkg) => `${POSIX_MODULES}/${pkg}/index.ts`;
const windows = (pkg) => `${WINDOWS_MODULES}\\${pkg.replace('/', '\\')}\\index.ts`;

describe('bundled feature extensions in the list pi reports', () => {
  it('accepts the POSIX paths a Linux or macOS build reports', () => {
    const loaded = PACKAGES.map((pkg) => ({ path: posix(pkg), ok: true }));
    expect(checkBundledExtensionsLoaded(loaded, PACKAGES)).toEqual([]);
  });

  // The 0.4.0-test.7 Windows CI failure: the files were packaged correctly and
  // pi had loaded both, but the probe compared a `/`-spelled package name
  // against a `\`-separated path, so every bundled extension read as missing.
  it('accepts the backslash paths a Windows build reports', () => {
    const loaded = PACKAGES.map((pkg) => ({ path: windows(pkg), ok: true }));
    expect(checkBundledExtensionsLoaded(loaded, PACKAGES)).toEqual([]);
  });

  it('reports a package pi never loaded, on either separator', () => {
    for (const spell of [posix, windows]) {
      const loaded = [{ path: spell('@gotgenes/pi-subagents'), ok: true }];
      const problems = checkBundledExtensionsLoaded(loaded, PACKAGES);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('@juicesharp/rpiv-ask-user-question did not load');
    }
  });

  // `ok: false` is pi collecting an import error and carrying on — the package
  // is in the list, so presence alone would call this a pass.
  it('reports a package that is listed but failed to import', () => {
    const loaded = [
      { path: posix('@juicesharp/rpiv-ask-user-question'), ok: false, error: 'boom' },
      { path: posix('@gotgenes/pi-subagents'), ok: true },
    ];
    const problems = checkBundledExtensionsLoaded(loaded, PACKAGES);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('reported a load error');
  });

  it('survives an inventory with unusable entries instead of throwing', () => {
    const problems = checkBundledExtensionsLoaded([{}, { path: 42 }, null], PACKAGES);
    expect(problems).toHaveLength(PACKAGES.length);
  });

  it('treats a missing inventory as every extension missing', () => {
    expect(checkBundledExtensionsLoaded(undefined, PACKAGES)).toHaveLength(PACKAGES.length);
  });
});
