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
  it('restates the required rows off, then the permission gate on, after the home layer and the plan rows', () => {
    expect(host).toMatch(
      /overlays: \[\s*\.\.\.modelPlanOverlays\(modelPlan\),\s*\.\.\.requiredDisabledOverlays\(\),\s*\.\.\.requiredEnabledOverlays\(\),\s*\],/
    );
  });

  it('refuses a composition without the loop guard, the credentials row, the permission gate or the encrypted-read fallback on (P1-8, P1-5b, P1-6b, P1-13c)', () => {
    expect(host).toContain('const notEnabled = REQUIRED_ENABLED.filter(');
    expect(host).toMatch(/if \(notEnabled\.length > 0\) fail\(/);
    expect(read('lib', 'hostProfile.ts')).toMatch(
      /export const REQUIRED_ENABLED: readonly string\[\] = \[\s*'aiclient-loop-guard',\s*'aiclient-credentials',\s*'aiclient-permissions',\s*'aiclient-encrypted-read',\s*\];/
    );
  });
});

describe('host.ts model plan and keys (P1-5, decisions 033 and 034)', () => {
  it("composes nothing before Main's configure, and waits for it with IPC only", () => {
    const waited = host.indexOf(
      'const modelPlan = ipc ? await awaitConfigure() : emptyHostModelPlan();'
    );
    expect(waited).toBeGreaterThan(0);
    expect(waited).toBeLessThan(host.indexOf('appBoot.readProfilePatches('));
    expect(host).toContain('CONFIGURE_TIMEOUT_MS');
  });

  it('takes configure and credential answers off the IPC link before the bridge sees them', () => {
    const listener = host.slice(
      host.indexOf("process.on('message'"),
      host.indexOf('bridgeInbox.queue.push')
    );
    expect(listener).toContain('isConfigureMessage(message)');
    expect(listener).toContain('credentialRelay?.receive(message)');
  });

  it('provides the plan without its nonce, and the relay, to the rows', () => {
    expect(host).toContain("hostCtx.provide('aiclientModelPlan', publicModelPlan(modelPlan));");
    expect(host).toContain("hostCtx.provide('aiclientCredentialRelay', credentialRelay)");
  });

  it('reports the revision and the route diagnostics in ready', () => {
    expect(host).toContain('revision: modelPlan.revision,');
    expect(host).toContain('routeDiagnostics: diagnostics,');
  });

  it('never reads a key from its environment or writes one to it', () => {
    expect(host).not.toContain('AICLIENT_DSH_GATEWAY_');
    expect(host).not.toMatch(/AICLIENT_KEY_/);
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

describe('one approval answerer in the product (P1-6b part 2, decision 042 rule 4)', () => {
  const rows = ['bridge/plugin.ts', 'bridge/dshSessionRuntime.ts', 'permissions/plugin.ts'];
  const answerers = (file: string) =>
    (read(...file.split('/')).match(/'approval\/request'/g) ?? []).length;

  it('the bridge no longer answers approval/request; the permission row does, once', () => {
    expect(rows.map((file) => [file, answerers(file)])).toEqual([
      ['bridge/plugin.ts', 0],
      ['bridge/dshSessionRuntime.ts', 0],
      ['permissions/plugin.ts', 1],
    ]);
  });

  it('the bridge row injects the permission row and attaches a gate before it opens an agent', () => {
    expect(read('bridge', 'plugin.ts')).toMatch(/'aiclientPermissions',\n\];/);
    const runtime = read('bridge', 'dshSessionRuntime.ts');
    expect(runtime.indexOf('this.attachGate(this.dshSessionId);')).toBeLessThan(
      runtime.indexOf('this.handle = await this.ctx.agents.create({')
    );
    expect(runtime.indexOf('this.attachGate(stub.dshSessionId);')).toBeLessThan(
      runtime.indexOf('await this.openDshSession(stub.dshSessionId, selection);')
    );
  });
});

describe('the product bundle: one bridge row always on, the permission row, the loop guard row', () => {
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
      '- id: aiclient-credentials',
      '- id: aiclient-bridge',
      '- id: aiclient-permissions',
      '- id: aiclient-loop-guard',
      '- id: aiclient-encrypted-read',
    ]);
  });

  it("composes aiclient-credentials on and dsh-base's plain-text credentials row off (P1-5b)", () => {
    expect(rowOf('aiclient-credentials')).toMatch(
      /^- id: aiclient-credentials\n\s+name: '@aiclient\/dsh-app\/credentials'\n?$/
    );
    expect(patch).toMatch(/^- id: credentials\n {2}disabled: true$/m);
  });

  it('carries no route, no default model and no key: they come from Main (P1-5a)', () => {
    const rows = patch.replace(/#[^\n]*/g, '');
    expect(rows).not.toMatch(/^- id: (llm-pi-ai|agent-default-model)$/m);
    expect(rows).not.toContain('AICLIENT_DSH_GATEWAY_');
    expect(rows).not.toContain('apiKeyEnv');
    expect(rows).not.toContain('baseURL');
  });

  it('composes aiclient-permissions on, with no disabled switch (P1-6b part 2)', () => {
    expect(rowOf('aiclient-permissions')).toMatch(
      /^- id: aiclient-permissions\n\s+name: '@aiclient\/dsh-app\/permissions'\n?$/
    );
  });

  it("turns DSH's sandbox and approval into literals, and its presets off (decisions 044, 045, 047)", () => {
    const rows = patch.replace(/#[^\n]*/g, '');
    expect(rows).toMatch(
      /^- id: sandbox-policy\n {2}config:\n {4}mode: danger-full-access\n {4}workspaceRoot: !!js process\.cwd\(\)$/m
    );
    expect(rows).toMatch(/^- id: approval\n {2}config:\n {4}policy: ask$/m);
    expect(rows).toMatch(/^- id: permission\n {2}disabled: true$/m);
    expect(rows).not.toContain('DSH_PERMISSION_MODE');
  });

  it('composes aiclient-loop-guard on, with the 500-step ceiling (P1-8)', () => {
    expect(rowOf('aiclient-loop-guard')).toMatch(
      /^- id: aiclient-loop-guard\n\s+name: '@aiclient\/dsh-app\/loop-guard'\n\s+config:\n\s+stepCeiling: 500\n?$/
    );
  });

  it('composes aiclient-encrypted-read on, with no config and no disabled switch (P1-13c)', () => {
    expect(rowOf('aiclient-encrypted-read')).toMatch(
      /^- id: aiclient-encrypted-read\n\s+name: '@aiclient\/dsh-app\/encrypted-read'\n?$/
    );
  });

  it('exports only its rows besides its patch', () => {
    expect(Object.keys(manifest.exports).sort()).toEqual([
      '.',
      './bridge',
      './cordis.patch.yml',
      './credentials',
      './encrypted-read',
      './loop-guard',
      './package.json',
      './permissions',
    ]);
  });
});
