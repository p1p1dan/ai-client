import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RETIRED_BUNDLED_PLUGIN_PACKAGES } from '../../src/agent-host/bundledPlugins.mjs';
import { serializeDefaultPermissionPolicy } from '../../src/agent-host/permissionPolicy.mjs';
import {
  containsObsoleteExecutionPackage,
  ESBUILD_EXTERNAL,
  ensureDevPermissionPolicy,
  preflightHostDeps,
  REQUIRED_WORKER_PACKAGES,
  shouldCopy,
  verifyArtifact,
  verifyBundledPermissionPolicy,
  WORKER_BUNDLE_BANNER,
  writeBundledPermissionPolicy,
} from '../agent-host-build-lib.mjs';

let tmp;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-worker-artifact-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeFile(file, content = 'x') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function writeJson(file, value) {
  writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

const INSTALLED_VERSIONS = {
  '@earendil-works/pi-coding-agent': '0.84.3',
  '@gotgenes/pi-permission-system': '27.0.1',
};

function buildInstall(root) {
  const host = path.join(root, 'src', 'agent-host');
  writeJson(path.join(host, 'package.json'), { dependencies: { ...INSTALLED_VERSIONS } });
  for (const [name, version] of Object.entries(INSTALLED_VERSIONS)) {
    writeJson(path.join(host, 'node_modules', ...name.split('/'), 'package.json'), { version });
  }
  return host;
}

function buildArtifact(outDir) {
  writeFile(path.join(outDir, 'worker.js'), '// worker\n');
  writeFile(path.join(outDir, 'runtime-helpers', 'exec-runner.mjs'));
  writeFile(path.join(outDir, 'runtime-helpers', 'tsd-read.mjs'));
  writeJson(path.join(outDir, 'package.json'), { type: 'module' });
  writeJson(
    path.join(outDir, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json'),
    {
      version: '0.84.3',
    }
  );
  writeFile(
    path.join(outDir, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'index.js')
  );
  writeJson(
    path.join(outDir, 'node_modules', '@gotgenes', 'pi-permission-system', 'package.json'),
    {
      version: '27.0.1',
    }
  );
  writeFile(
    path.join(outDir, 'node_modules', '@gotgenes', 'pi-permission-system', 'src', 'index.ts')
  );
  writeFile(path.join(outDir, 'node_modules', 'tree-sitter-bash', 'tree-sitter-bash.wasm'));
  for (const [name, license] of [
    ['@gotgenes/pi-permission-system', 'LICENSE'],
    ['tree-sitter-bash', 'LICENSE'],
    ['web-tree-sitter', 'LICENSE'],
    ['zod', 'LICENSE'],
  ]) {
    writeFile(path.join(outDir, 'node_modules', ...name.split('/'), license), 'MIT\n');
  }
  writeFile(
    path.join(outDir, 'node_modules', '@gotgenes', 'pi-permission-system', 'config.json'),
    serializeDefaultPermissionPolicy()
  );
}

const copyOptions = { platform: 'linux', arch: 'x64' };

describe('worker-only dependency preflight', () => {
  it('externalizes only the Pi SDK', () => {
    expect(ESBUILD_EXTERNAL).toEqual(['@earendil-works/pi-coding-agent']);
  });

  it('accepts an install of exactly the Pi SDK and the permission package', () => {
    buildInstall(tmp);
    expect(preflightHostDeps({ root: tmp }).installed).toEqual(INSTALLED_VERSIONS);
  });

  it('no longer requires the two retired pi feature extensions', () => {
    // T025. They are payload with no loader since P6-5, so a build machine
    // without them must succeed — and the preflight must not quietly re-add
    // them through some other list.
    buildInstall(tmp);
    for (const name of RETIRED_BUNDLED_PLUGIN_PACKAGES) {
      expect(REQUIRED_WORKER_PACKAGES).not.toContain(name);
    }
    expect(() => preflightHostDeps({ root: tmp })).not.toThrow();
  });

  it('still refuses to build without the permission package', () => {
    // Not a loaded extension any more, but the build writes the shipped policy
    // into its `config.json` and Main reads that path as the bundled scope.
    const host = buildInstall(tmp);
    fs.rmSync(path.join(host, 'node_modules', '@gotgenes', 'pi-permission-system'), {
      recursive: true,
      force: true,
    });
    expect(() => preflightHostDeps({ root: tmp })).toThrow(
      '@gotgenes/pi-permission-system is not installed'
    );
  });

  it('rejects a ranged worker runtime pin', () => {
    const host = buildInstall(tmp);
    const manifestPath = path.join(host, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.dependencies['@earendil-works/pi-coding-agent'] = '^0.84.3';
    writeJson(manifestPath, manifest);
    expect(() => preflightHostDeps({ root: tmp })).toThrow(/exact worker runtime pin/);
  });

  it('rejects a missing required worker package', () => {
    const host = buildInstall(tmp);
    fs.rmSync(path.join(host, 'node_modules', '@gotgenes'), { recursive: true, force: true });
    expect(() => preflightHostDeps({ root: tmp })).toThrow(/pi-permission-system is not installed/);
  });
});

describe('worker-only copy filter', () => {
  it('removes every obsolete execution payload, including nested package paths', () => {
    const obsolete = [
      '@anthropic-ai/claude-agent-sdk/sdk.mjs',
      '@anthropic-ai/claude-agent-sdk-linux-x64/vendor/claude',
      '@cometix/claude-code/cli.js',
      '@openai/codex/bin/codex.js',
      'node-pty/build/Release/pty.node',
      '@earendil-works/pi-coding-agent/node_modules/@openai/codex/bin/codex.js',
    ];
    for (const rel of obsolete) {
      expect(containsObsoleteExecutionPackage(rel), rel).toBe(true);
      expect(shouldCopy(rel, copyOptions), rel).toBe(false);
    }
  });

  it('keeps provider SDKs used by Pi while removing only the legacy executors', () => {
    expect(shouldCopy('@anthropic-ai/sdk/index.mjs', copyOptions)).toBe(true);
    expect(shouldCopy('@openai/openai/index.mjs', copyOptions)).toBe(true);
    expect(shouldCopy('@earendil-works/pi-coding-agent/dist/index.js', copyOptions)).toBe(true);
  });

  it('keeps the permission extension TypeScript, policy inputs, wasm, and licences', () => {
    expect(shouldCopy('@gotgenes/pi-permission-system/src/index.ts', copyOptions)).toBe(true);
    expect(shouldCopy('tree-sitter-bash/tree-sitter-bash.wasm', copyOptions)).toBe(true);
    expect(shouldCopy('web-tree-sitter/LICENSE', copyOptions)).toBe(true);
    expect(shouldCopy('some-package/index.d.ts', copyOptions)).toBe(false);
    expect(shouldCopy('some-package/README.md', copyOptions)).toBe(false);
  });

  it('keeps only sharp variants usable by the target platform', () => {
    expect(shouldCopy('@img/sharp-linux-x64/lib/sharp.node', copyOptions)).toBe(true);
    expect(shouldCopy('@img/sharp-libvips-linuxmusl-x64/lib/libvips.so', copyOptions)).toBe(true);
    expect(shouldCopy('@img/sharp-darwin-arm64/lib/sharp.node', copyOptions)).toBe(false);
  });

  it('refuses the retired pi feature extensions at every level of their tree', () => {
    // T025. Paths here are node_modules-RELATIVE, matching the walker root:
    // handing shouldCopy the verifier's `node_modules/...` form makes topPackage
    // read "node_modules", every package branch stops matching, and the
    // assertion would pass against any filter at all.
    //
    // The whole tree is asserted, not just the entry file, because the walker
    // asks about DIRECTORIES on the way down. A rule that only rejected the
    // entry would still copy everything beside it.
    for (const name of RETIRED_BUNDLED_PLUGIN_PACKAGES) {
      expect(shouldCopy(name, copyOptions)).toBe(false);
      expect(shouldCopy(`${name}/package.json`, copyOptions)).toBe(false);
      expect(shouldCopy(`${name}/src/index.ts`, copyOptions)).toBe(false);
      expect(shouldCopy(`${name}/LICENSE`, copyOptions)).toBe(false);
      expect(shouldCopy(name.split('/')[0], copyOptions)).toBe(true);
    }
  });
});

describe('worker-only artifact verification', () => {
  it('runs bundled CommonJS dependencies inside the ESM worker', async () => {
    const entry = path.join(tmp, 'dependency.cjs');
    const output = path.join(tmp, 'worker.mjs');
    writeFile(entry, "console.log(require('node:os').platform())");
    await build({
      entryPoints: [entry],
      outfile: output,
      bundle: true,
      platform: 'node',
      format: 'esm',
      banner: { js: WORKER_BUNDLE_BANNER },
    });
    expect(execFileSync(process.execPath, [output], { encoding: 'utf8' }).trim()).toBe(
      process.platform
    );
  });

  it('accepts a worker-only Pi artifact', () => {
    const out = path.join(tmp, 'out');
    buildArtifact(out);
    expect(verifyArtifact({ outDir: out }).totalBytes).toBeGreaterThan(0);
  });

  it.each(['exec-runner.mjs', 'tsd-read.mjs'])('rejects a missing native helper %s', (name) => {
    const out = path.join(tmp, 'out');
    buildArtifact(out);
    fs.rmSync(path.join(out, 'runtime-helpers', name));
    expect(() => verifyArtifact({ outDir: out })).toThrow(`runtime-helpers/${name}`);
  });

  it('rejects an artifact that carries a retired pi feature extension', () => {
    // T025. `shouldCopy` is the filter and this is the receipt: if the filter
    // ever answers yes again, ~1.7 MB of dead payload returns and nothing else
    // in the build would say so.
    const out = path.join(tmp, 'out');
    buildArtifact(out);
    const name = RETIRED_BUNDLED_PLUGIN_PACKAGES[0];
    writeFile(path.join(out, 'node_modules', ...name.split('/'), 'index.ts'));
    expect(() => verifyArtifact({ outDir: out })).toThrow('retired pi extension');
  });

  it('requires worker.js and rejects both transition entries', () => {
    const out = path.join(tmp, 'out');
    buildArtifact(out);
    fs.rmSync(path.join(out, 'worker.js'));
    writeFile(path.join(out, 'index.js'));
    writeFile(path.join(out, 'piHost.js'));
    expect(() => verifyArtifact({ outDir: out })).toThrow(/missing worker\.js/);
    expect(() => verifyArtifact({ outDir: out })).toThrow(/must not ship index\.js/);
  });

  it('rejects legacy execution packages even when nested', () => {
    const out = path.join(tmp, 'out');
    buildArtifact(out);
    writeFile(
      path.join(
        out,
        'node_modules',
        '@earendil-works',
        'pi-coding-agent',
        'node_modules',
        '@openai',
        'codex',
        'bin',
        'codex.js'
      )
    );
    expect(() => verifyArtifact({ outDir: out })).toThrow(/obsolete execution payload/);
  });

  it('rejects a missing permission entry, grammar, or licence', () => {
    for (const rel of [
      'node_modules/@gotgenes/pi-permission-system/src/index.ts',
      'node_modules/tree-sitter-bash/tree-sitter-bash.wasm',
      'node_modules/zod/LICENSE',
    ]) {
      const out = path.join(tmp, rel.replaceAll('/', '-'));
      buildArtifact(out);
      fs.rmSync(path.join(out, ...rel.split('/')));
      expect(() => verifyArtifact({ outDir: out })).toThrow();
    }
  });
});

describe('permission policy parity', () => {
  it('writes and verifies the fail-closed policy', () => {
    const out = path.join(tmp, 'out');
    buildArtifact(out);
    const target = writeBundledPermissionPolicy(out);
    expect(fs.readFileSync(target, 'utf8')).toBe(serializeDefaultPermissionPolicy());
    expect(verifyBundledPermissionPolicy(out)).toEqual([]);
  });

  it('rejects a permissive policy', () => {
    const out = path.join(tmp, 'out');
    buildArtifact(out);
    const target = path.join(
      out,
      'node_modules',
      '@gotgenes',
      'pi-permission-system',
      'config.json'
    );
    const policy = JSON.parse(fs.readFileSync(target, 'utf8'));
    policy.yoloMode = true;
    fs.writeFileSync(target, JSON.stringify(policy));
    expect(verifyBundledPermissionPolicy(out)).toContain('shipped policy: yoloMode must be false');
  });

  it('writes the same policy into the dev package and reports a missing install', () => {
    const root = path.join(tmp, 'checkout');
    const pluginDir = path.join(
      root,
      'src',
      'agent-host',
      'node_modules',
      '@gotgenes',
      'pi-permission-system'
    );
    fs.mkdirSync(pluginDir, { recursive: true });
    expect(ensureDevPermissionPolicy(root).written).toBe(true);
    fs.rmSync(pluginDir, { recursive: true, force: true });
    expect(ensureDevPermissionPolicy(root)).toMatchObject({ written: false });
  });
});
