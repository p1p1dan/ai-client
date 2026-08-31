import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { serializeDefaultPermissionPolicy } from '../../src/agent-host/permissionPolicy.mjs';
import {
  containsObsoleteExecutionPackage,
  ESBUILD_EXTERNAL,
  ensureDevPermissionPolicy,
  preflightHostDeps,
  shouldCopy,
  verifyArtifact,
  verifyBundledPermissionPolicy,
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

function buildInstall(root) {
  const host = path.join(root, 'src', 'agent-host');
  writeJson(path.join(host, 'package.json'), {
    dependencies: {
      '@earendil-works/pi-coding-agent': '0.84.3',
      '@gotgenes/pi-permission-system': '27.0.1',
    },
  });
  writeJson(path.join(host, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json'), {
    version: '0.84.3',
  });
  writeJson(path.join(host, 'node_modules', '@gotgenes', 'pi-permission-system', 'package.json'), {
    version: '27.0.1',
  });
  return host;
}

function buildArtifact(outDir) {
  writeFile(path.join(outDir, 'worker.js'), '// worker\n');
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

  it('accepts installed Pi and permission packages', () => {
    buildInstall(tmp);
    expect(preflightHostDeps({ root: tmp }).installed).toEqual({
      '@earendil-works/pi-coding-agent': '0.84.3',
      '@gotgenes/pi-permission-system': '27.0.1',
    });
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
});

describe('worker-only artifact verification', () => {
  it('accepts a worker-only Pi artifact', () => {
    const out = path.join(tmp, 'out');
    buildArtifact(out);
    expect(verifyArtifact({ outDir: out }).totalBytes).toBeGreaterThan(0);
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
