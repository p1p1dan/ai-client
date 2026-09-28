import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * dsh-rebase P1-3a static guards on the host launcher and the product bundle
 * (HS-01 and the wiring of HS-02 / HS-03 of the P1-3 plan). The launcher runs
 * DSH's boot at import, so it is pinned by its source instead of imported.
 */

const HOST_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts: string[]) => readFileSync(join(HOST_DIR, ...parts), 'utf8');
const host = read('host.ts');

describe('host.ts reads no .env file (HS-01, decision 023)', () => {
  it('never calls a DSH .env loader, not even by name', () => {
    for (const name of ['loadLayeredEnv', 'loadEnv', 'loadEnvFile']) {
      expect(host, name).not.toContain(name);
    }
  });

  it('hands DSH a launch environment made of the process layer alone', () => {
    expect(host).toContain(
      "createLaunchEnvironmentSnapshot([{ source: 'process', values: processLayer }])"
    );
    expect(host).not.toMatch(/source: '(project-env|user-env)'/);
    expect(host).not.toMatch(/process\.env\[[^\]]+\]\s*=(?!=)/);
  });
});

describe('host.ts composition (HS-02, HS-03, decisions 023 and 025)', () => {
  it('restates the required rows off after the home layer', () => {
    expect(host).toContain('overlays: requiredDisabledOverlays(),');
  });

  it('restates the product bundles at every start and fails only on a product bundle', () => {
    expect(host).toContain('reconcileProductBundles(listedBundles)');
    expect(host).toContain('appBoot.writeProfileBundles(profileDir, manifest, bundles)');
    expect(host).toContain('partitionSkippedBundles(profile.skippedBundles)');
    expect(host).toMatch(/if \(skipped\.product\.length > 0\) \{[^}]*fail\(/);
  });
});

describe('host.ts IPC (P1-3a, decision 019)', () => {
  it('buffers IPC for the bridge whenever there is a channel, with no mode switch', () => {
    expect(host).toContain("const ipc = typeof process.send === 'function';");
    expect(host).not.toMatch(/process\.env\.AICLIENT_[A-Z_]*BRIDGE/);
    expect(host).not.toContain('AICLIENT_PI_WORKER_GENERATION');
  });

  it('reports ready and stopped over IPC, and refuses a host whose bridge never took the channel', () => {
    expect(host).toContain('if (process.connected) process.send?.(ready);');
    expect(host).toContain("send({ type: 'stopped', ms, reason }");
    expect(host).toMatch(/if \(bridgeInbox && !bridgeInbox\.deliver\) \{\s*fail\(/);
  });
});

describe('the product bundle has one bridge row, always on, and the permission row', () => {
  const patch = read('bundle', 'cordis.patch.yml');
  const manifest = JSON.parse(read('bundle', 'package.json')) as {
    exports: Record<string, string>;
  };
  /** One inserted row: from its `- id:` line up to the next row or the end. */
  const rowOf = (id: string) => {
    const start = patch.indexOf(`- id: ${id}\n`);
    const end = patch.indexOf('\n    - id:', start + 1);
    return patch.slice(start, end < 0 ? undefined : end + 1).replace(/\n\s*(#[^\n]*\n\s*)*$/, '\n');
  };

  it('composes aiclient-bridge without a disabled switch', () => {
    expect(rowOf('aiclient-bridge')).toMatch(
      /^- id: aiclient-bridge\n\s+name: '@aiclient\/dsh-app\/bridge'\n?$/
    );
    expect(patch.match(/- id: aiclient-[a-z-]+/g)).toEqual([
      '- id: aiclient-bridge',
      '- id: aiclient-permissions',
    ]);
  });

  it('composes aiclient-permissions off until the bridge attaches gates (P1-6b)', () => {
    expect(rowOf('aiclient-permissions')).toMatch(
      /^- id: aiclient-permissions\n\s+name: '@aiclient\/dsh-app\/permissions'\n\s+disabled: true\n?$/
    );
  });

  it('exports only its rows besides its patch', () => {
    expect(Object.keys(manifest.exports).sort()).toEqual([
      '.',
      './bridge',
      './cordis.patch.yml',
      './package.json',
      './permissions',
    ]);
  });
});
