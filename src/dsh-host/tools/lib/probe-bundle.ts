/**
 * Layers the test-only bundle `@aiclient/dsh-probe` (tools/probe-bundle) into a
 * probe DSH_HOME, so the product bundle never carries the auto-approving
 * `aiclient-probe` row (dsh-rebase decision 015).
 *
 * DSH resolves a profile bundle from the installation first and the profile
 * directory second (dsh-app-boot `resolveBundleDir`), and routes a package the
 * profile manifest lists in `dependencies` to the profile's own node_modules
 * (`localPackageNames`). So the bundle is copied to
 * `<profile>/node_modules/@aiclient/dsh-probe`, listed in the manifest's
 * dependencies, and layered right after `@aiclient/dsh-app`. The manifest is
 * written before the host's first boot because `initProfile` never touches an
 * existing one. The `file:` spec points at a second copy outside node_modules
 * so the manifest's own dependency entry resolves without a registry; the
 * plugin manager's install path (decision 082: permanently disabled) never
 * runs here.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROBE_BUNDLE = '@aiclient/dsh-probe';
export const PROBE_PROFILE = 'aiclient';
const PRODUCT_BUNDLES = ['@deepseek-ai/dsh-base', '@aiclient/dsh-app'];
const VENDORED_DIR = 'aiclient-probe-bundle';

export const probeBundleSource = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'probe-bundle'
);

interface ProfileManifest {
  name?: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  dsh?: { profile?: { bundles?: string[] } & Record<string, unknown> } & Record<string, unknown>;
  [key: string]: unknown;
}

/** `bundles` with the probe bundle right after the product bundle (appended if absent). */
function withProbe(bundles: string[]): string[] {
  const rest = bundles.filter((name) => name !== PROBE_BUNDLE);
  const at = rest.indexOf('@aiclient/dsh-app');
  return at < 0
    ? [...rest, PROBE_BUNDLE]
    : [...rest.slice(0, at + 1), PROBE_BUNDLE, ...rest.slice(at + 1)];
}

/** Idempotent: safe before every host start on the same DSH_HOME. */
export function installProbeBundle(
  dshHome: string,
  source = probeBundleSource
): { profileDir: string; bundles: string[] } {
  if (!existsSync(join(source, 'package.json'))) {
    throw new Error(`probe bundle not found at ${source}`);
  }
  const profileDir = join(dshHome, 'profiles', PROBE_PROFILE);
  mkdirSync(join(profileDir, 'node_modules', '@aiclient'), { recursive: true, mode: 0o700 });
  for (const target of [
    join(profileDir, VENDORED_DIR),
    join(profileDir, 'node_modules', '@aiclient', 'dsh-probe'),
  ]) {
    rmSync(target, { recursive: true, force: true });
    cpSync(source, target, { recursive: true });
  }
  const manifestPath = join(profileDir, 'package.json');
  const manifest: ProfileManifest = existsSync(manifestPath)
    ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as ProfileManifest)
    : { name: `dsh-profile-${PROBE_PROFILE}`, private: true };
  const bundles = withProbe(manifest.dsh?.profile?.bundles ?? PRODUCT_BUNDLES);
  manifest.dependencies = { ...manifest.dependencies, [PROBE_BUNDLE]: `file:./${VENDORED_DIR}` };
  manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { profileDir, bundles };
}
