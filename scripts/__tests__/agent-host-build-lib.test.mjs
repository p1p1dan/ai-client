import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { serializeDefaultPermissionPolicy } from '../../src/agent-host/permissionPolicy.mjs';
import {
  CODEX_BINARY_FLOOR,
  CODEX_MEASURED_PLATFORMS,
  ESBUILD_EXTERNAL,
  ensureDevPermissionPolicy,
  foreignCodexPlatformRels,
  preflightHostDeps,
  pruneResidualPlatformPackages,
  q1ObserveApplies,
  resolveCodexPlatformPkgRel,
  shouldCopy,
  verifyArtifact,
  verifyBundledPermissionPolicy,
  writeBundledPermissionPolicy,
} from '../agent-host-build-lib.mjs';
import { codexBinaryName, codexTargetTriple } from '../codex-platform.mjs';

/**
 * Packaging spec §7.1 A3 / A4 / A5 / A6 / A8 / A9 — the T2 construction layer.
 *
 * This file imports the library ONLY, never the CLI shell: the shell has a
 * top-level `await main()` whose third line rm -rf's out-agent-host/, so a bare
 * import would delete the developer's artifact and process.exit the vitest
 * worker (spec §9). A static assertion at the bottom pins that rule.
 */

const PIN = '0.149.1';
const COMETIX_PIN = '2.1.212';
const SDK_PIN = '0.3.218';
const LINUX_TRIPLE = 'x86_64-unknown-linux-musl';

let tmp;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-host-lib-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** Sparse file: stat().size reports `bytes` while consuming no real disk, so
 * the production CODEX_BINARY_FLOOR (200 MiB) is exercised for real. */
function writeSparse(file, bytes, mode = 0o755) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'w');
  fs.ftruncateSync(fd, bytes);
  fs.closeSync(fd);
  fs.chmodSync(file, mode);
}

const OVER_FLOOR = CODEX_BINARY_FLOOR + 1024;

/** A healthy linux-x64 source install under <root>/src/agent-host. */
function buildHostInstall(root, { layout = 'hoisted', platform = 'linux', arch = 'x64' } = {}) {
  const hostRoot = path.join(root, 'src', 'agent-host');
  const nm = path.join(hostRoot, 'node_modules');

  writeJson(path.join(hostRoot, 'package.json'), {
    dependencies: {
      '@anthropic-ai/claude-agent-sdk': SDK_PIN,
      '@cometix/claude-code': COMETIX_PIN,
      '@openai/codex': PIN,
    },
  });

  writeJson(path.join(nm, '@anthropic-ai', 'claude-agent-sdk', 'package.json'), {
    version: SDK_PIN,
  });
  writeJson(path.join(nm, '@cometix', 'claude-code', 'package.json'), { version: COMETIX_PIN });
  writeSparse(path.join(nm, '@cometix', 'claude-code', 'cli.js'), 6 * 1024 * 1024, 0o644);
  fs.mkdirSync(path.join(nm, '@cometix', 'claude-code', 'vendor'), { recursive: true });
  fs.mkdirSync(path.join(nm, 'node-pty', 'build', 'Release'), { recursive: true });

  const key = `${platform}-${arch}`;
  const pkgRel =
    layout === 'nested'
      ? path.join('@openai', 'codex', 'node_modules', '@openai', `codex-${key}`)
      : path.join('@openai', `codex-${key}`);

  writeJson(path.join(nm, '@openai', 'codex', 'package.json'), { version: PIN });
  writeFile(path.join(nm, '@openai', 'codex', 'bin', 'codex.js'), '// launcher\n');

  const pkgDir = path.join(nm, pkgRel);
  writeJson(path.join(pkgDir, 'package.json'), { name: '@openai/codex', version: `${PIN}-${key}` });
  const triple = codexTargetTriple(platform, arch);
  const binName = codexBinaryName(platform);
  const vendorDir = path.join(pkgDir, 'vendor', triple);
  writeJson(path.join(vendorDir, 'codex-package.json'), {
    version: PIN,
    target: triple,
    entrypoint: `bin/${binName}`,
    pathDir: 'codex-path',
    resourcesDir: 'codex-resources',
  });
  writeSparse(path.join(vendorDir, 'bin', binName), OVER_FLOOR);
  writeSparse(
    path.join(
      vendorDir,
      'bin',
      platform === 'win32' ? 'codex-code-mode-host.exe' : 'codex-code-mode-host'
    ),
    1024
  );
  fs.mkdirSync(path.join(vendorDir, 'codex-path'), { recursive: true });
  fs.mkdirSync(path.join(vendorDir, 'codex-resources'), { recursive: true });

  return {
    hostRoot,
    nm,
    pkgDir,
    vendorDir,
    triple,
    binName,
    pkgRel: pkgRel.split(path.sep).join('/'),
  };
}

/** A healthy linux-x64 out-agent-host artifact. */
function buildArtifact(outDir, { layout = 'hoisted', platform = 'linux', arch = 'x64' } = {}) {
  const nm = path.join(outDir, 'node_modules');
  fs.mkdirSync(outDir, { recursive: true });
  writeFile(path.join(outDir, 'index.js'), '// bundle\n');
  writeJson(path.join(outDir, 'package.json'), { type: 'module' });

  writeSparse(path.join(nm, '@cometix', 'claude-code', 'cli.js'), 6 * 1024 * 1024, 0o644);
  fs.mkdirSync(path.join(nm, '@cometix', 'claude-code', 'vendor'), { recursive: true });
  writeFile(path.join(nm, '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs'), '// sdk\n');
  fs.mkdirSync(path.join(nm, 'node-pty', 'build', 'Release'), { recursive: true });

  // T08-a — the permission gate's runtime files and every bundled licence.
  // Part of the BASE artifact, not an opt-in: a build that ships without them
  // is a build whose tool calls run unattended, which is what verifyArtifact
  // now refuses.
  writeJson(path.join(nm, '@gotgenes', 'pi-permission-system', 'package.json'), {
    name: '@gotgenes/pi-permission-system',
    pi: { extensions: ['./src/index.ts'] },
  });
  writeFile(path.join(nm, '@gotgenes', 'pi-permission-system', 'src', 'index.ts'), '// entry\n');
  writeFile(path.join(nm, 'tree-sitter-bash', 'tree-sitter-bash.wasm'), 'wasm');
  // T08-c: the shipped default policy is part of a healthy artifact — the real
  // build writes it after the prune, so the fixture carries it too.
  writeFile(
    path.join(nm, '@gotgenes', 'pi-permission-system', 'config.json'),
    serializeDefaultPermissionPolicy()
  );
  for (const [name, licenseFile] of [
    ['@gotgenes/pi-permission-system', 'LICENSE'],
    ['tree-sitter-bash', 'LICENSE'],
    ['web-tree-sitter', 'LICENSE'],
    ['zod', 'LICENSE'],
    ['node-addon-api', 'LICENSE.md'],
    ['node-gyp-build', 'LICENSE'],
  ]) {
    writeFile(path.join(nm, ...name.split('/'), licenseFile), 'MIT\n');
  }

  const key = `${platform}-${arch}`;
  const pkgRel =
    layout === 'nested'
      ? `@openai/codex/node_modules/@openai/codex-${key}`
      : `@openai/codex-${key}`;

  writeJson(path.join(nm, '@openai', 'codex', 'package.json'), { version: PIN });
  writeFile(path.join(nm, '@openai', 'codex', 'bin', 'codex.js'), '// launcher\n');

  const pkgDir = path.join(nm, ...pkgRel.split('/'));
  writeJson(path.join(pkgDir, 'package.json'), { name: '@openai/codex', version: `${PIN}-${key}` });
  const triple = codexTargetTriple(platform, arch);
  const binName = codexBinaryName(platform);
  const vendorDir = path.join(pkgDir, 'vendor', triple);
  writeJson(path.join(vendorDir, 'codex-package.json'), {
    version: PIN,
    target: triple,
    entrypoint: `bin/${binName}`,
    pathDir: 'codex-path',
    resourcesDir: 'codex-resources',
  });
  writeSparse(path.join(vendorDir, 'bin', binName), OVER_FLOOR);
  writeSparse(
    path.join(
      vendorDir,
      'bin',
      platform === 'win32' ? 'codex-code-mode-host.exe' : 'codex-code-mode-host'
    ),
    1024
  );
  fs.mkdirSync(path.join(vendorDir, 'codex-path'), { recursive: true });
  fs.mkdirSync(path.join(vendorDir, 'codex-resources'), { recursive: true });

  return { nm, pkgDir, vendorDir, triple, binName, pkgRel };
}

const PINS = {
  '@openai/codex': PIN,
  '@cometix/claude-code': COMETIX_PIN,
  '@anthropic-ai/claude-agent-sdk': SDK_PIN,
};

const lx = { platform: 'linux', arch: 'x64' };

// ---------------------------------------------------------------------------
// A6 — esbuild external list
// ---------------------------------------------------------------------------
describe('ESBUILD_EXTERNAL (A6)', () => {
  it('is exactly the runtime-resolved packages, in order', () => {
    expect(ESBUILD_EXTERNAL).toEqual([
      '@anthropic-ai/claude-agent-sdk',
      '@cometix/claude-code',
      '@earendil-works/pi-coding-agent',
    ]);
    expect(ESBUILD_EXTERNAL).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// A3 / A5 — preflight red arms
// ---------------------------------------------------------------------------
describe('preflightHostDeps (A3, A5)', () => {
  it('accepts a healthy hoisted install and reports the resolved package', () => {
    buildHostInstall(tmp);
    const result = preflightHostDeps({ root: tmp, ...lx });
    expect(result.codexPkgRel).toBe('@openai/codex-linux-x64');
    expect(result.codexSkipped).toBeNull();
    expect(result.pins['@openai/codex']).toBe(PIN);
  });

  it('accepts the nested install layout', () => {
    buildHostInstall(tmp, { layout: 'nested' });
    const result = preflightHostDeps({ root: tmp, ...lx });
    expect(result.codexPkgRel).toBe('@openai/codex/node_modules/@openai/codex-linux-x64');
  });

  it('A3-1 red: platform package missing (--omit=optional stub install)', () => {
    const { nm } = buildHostInstall(tmp);
    fs.rmSync(path.join(nm, '@openai', 'codex-linux-x64'), { recursive: true, force: true });
    expect(() => preflightHostDeps({ root: tmp, ...lx })).toThrow(
      /@openai\/codex-linux-x64 is not installed — reinstall src\/agent-host WITH optional dependencies/
    );
  });

  it('A3-2 red: platform package carries the wrong alias version string', () => {
    const { pkgDir } = buildHostInstall(tmp);
    // M3 arm: comparing against the bare pin instead of `${pin}-${key}` must not pass.
    writeJson(path.join(pkgDir, 'package.json'), { name: '@openai/codex', version: PIN });
    expect(() => preflightHostDeps({ root: tmp, ...lx })).toThrow(
      /expected 0\.149\.1-linux-x64, got 0\.149\.1/
    );
  });

  it('A3-3 red: vendor manifest target does not match the triple', () => {
    const { vendorDir } = buildHostInstall(tmp);
    writeJson(path.join(vendorDir, 'codex-package.json'), {
      version: PIN,
      target: 'aarch64-apple-darwin',
      entrypoint: 'bin/codex',
      pathDir: 'codex-path',
      resourcesDir: 'codex-resources',
    });
    expect(() => preflightHostDeps({ root: tmp, ...lx })).toThrow(/vendor manifest mismatch/);
  });

  it('A3-3b red: vendor manifest missing entirely', () => {
    const { vendorDir } = buildHostInstall(tmp);
    fs.rmSync(path.join(vendorDir, 'codex-package.json'), { force: true });
    expect(() => preflightHostDeps({ root: tmp, ...lx })).toThrow(/vendor manifest missing/);
  });

  it('A3-4 red: entry binary below the size floor', () => {
    const { vendorDir } = buildHostInstall(tmp);
    writeSparse(path.join(vendorDir, 'bin', 'codex'), 1024);
    expect(() => preflightHostDeps({ root: tmp, ...lx })).toThrow(
      /codex binary suspiciously small/
    );
  });

  it('A3-5 red: a foreign platform package survived in the install', () => {
    const { nm } = buildHostInstall(tmp);
    fs.mkdirSync(path.join(nm, '@openai', 'codex-darwin-arm64'), { recursive: true });
    expect(() => preflightHostDeps({ root: tmp, ...lx })).toThrow(
      /unexpected foreign platform package: @openai\/codex-darwin-arm64/
    );
  });

  it('A5 red: entry binary lost its exec bit (non-win32)', () => {
    const { vendorDir } = buildHostInstall(tmp);
    fs.chmodSync(path.join(vendorDir, 'bin', 'codex'), 0o644);
    expect(() => preflightHostDeps({ root: tmp, ...lx })).toThrow(/codex binary not executable/);
  });

  it('rejects a range pin', () => {
    const { hostRoot } = buildHostInstall(tmp);
    writeJson(path.join(hostRoot, 'package.json'), {
      dependencies: {
        '@anthropic-ai/claude-agent-sdk': SDK_PIN,
        '@cometix/claude-code': COMETIX_PIN,
        '@openai/codex': `^${PIN}`,
      },
    });
    expect(() => preflightHostDeps({ root: tmp, ...lx })).toThrow(/must be an exact pin/);
  });

  it('A9 whitelist: darwin skips every codex check without throwing', () => {
    buildHostInstall(tmp);
    const result = preflightHostDeps({ root: tmp, platform: 'darwin', arch: 'arm64' });
    expect(result.codexSkipped).toBe('darwin-arm64');
    expect(result.codexPkgRel).toBeNull();
    // The codex pin is not even consulted on a non-shipped platform.
    expect(result.pins['@openai/codex']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// A9 — copy filter whitelist arm
// ---------------------------------------------------------------------------
describe('shouldCopy (A9, M1, M14)', () => {
  const opts = { ...lx, hasPtyPrebuild: false };

  it('keeps the main package and the current platform package', () => {
    expect(shouldCopy('@openai/codex/bin/codex.js', opts)).toBe(true);
    expect(shouldCopy(`@openai/codex-linux-x64/vendor/${LINUX_TRIPLE}/bin/codex`, opts)).toBe(true);
  });

  it('M14 arm: drops all of @openai on a non-shipped platform', () => {
    const mac = { platform: 'darwin', arch: 'arm64', hasPtyPrebuild: true };
    expect(shouldCopy('@openai/codex/bin/codex.js', mac)).toBe(false);
    expect(shouldCopy('@openai/codex-darwin-arm64/vendor/x/bin/codex', mac)).toBe(false);
  });

  it('M1 arm: drops a foreign platform package in the nested layout', () => {
    expect(shouldCopy('@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/x', opts)).toBe(
      false
    );
  });

  it('drops a foreign platform package in the hoisted layout', () => {
    expect(shouldCopy('@openai/codex-win32-x64/vendor/x', opts)).toBe(false);
  });

  it('keeps vendor assets verbatim past the generic suffix filter', () => {
    // A .md inside vendor would be dropped by the generic filter below; the
    // vendor passthrough must win (cometix precedent, spec §3.4-1).
    expect(
      shouldCopy(`@openai/codex-linux-x64/vendor/${LINUX_TRIPLE}/codex-resources/README.md`, opts)
    ).toBe(true);
  });

  it('still drops .bin and the generic suffixes elsewhere', () => {
    expect(shouldCopy('.bin', opts)).toBe(false);
    expect(shouldCopy('some-pkg/index.d.ts', opts)).toBe(false);
    expect(shouldCopy('some-pkg/README.md', opts)).toBe(false);
    expect(shouldCopy('some-pkg/LICENSE', opts)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T08-a — the bundled permission plugin and its tree-sitter dependency
// ---------------------------------------------------------------------------
describe('shouldCopy (T08-a permission plugin)', () => {
  const opts = { ...lx, hasPtyPrebuild: false };
  const PLUGIN = '@gotgenes/pi-permission-system';

  /**
   * The one that would silently break the feature: this package declares
   * `pi.extensions: ["./src/index.ts"]` and ships no runtime JS at all, so the
   * generic `.ts` drop would produce a plugin with no entry point — and an
   * ungated tool call looks exactly like one that needed no approval.
   */
  it('keeps the TypeScript sources the plugin actually runs from', () => {
    expect(shouldCopy(`${PLUGIN}/src/index.ts`, opts)).toBe(true);
    expect(shouldCopy(`${PLUGIN}/src/service.ts`, opts)).toBe(true);
    expect(shouldCopy(`${PLUGIN}/src/access-intent/bash/parser.ts`, opts)).toBe(true);
    expect(shouldCopy(`${PLUGIN}/package.json`, opts)).toBe(true);
    expect(shouldCopy(`${PLUGIN}/schemas/permissions.schema.json`, opts)).toBe(true);
  });

  /** MIT: the copyright notice ships with the binary. */
  it('keeps the licence for every package bundled for the permission system', () => {
    expect(shouldCopy(`${PLUGIN}/LICENSE`, opts)).toBe(true);
    expect(shouldCopy('tree-sitter-bash/LICENSE', opts)).toBe(true);
    expect(shouldCopy('web-tree-sitter/LICENSE', opts)).toBe(true);
    expect(shouldCopy('zod/LICENSE', opts)).toBe(true);
  });

  it('drops the plugin documentation, which never loads at runtime', () => {
    expect(shouldCopy(`${PLUGIN}/docs/guides/getting-started.md`, opts)).toBe(false);
    expect(shouldCopy(`${PLUGIN}/README.md`, opts)).toBe(false);
    expect(shouldCopy(`${PLUGIN}/CHANGELOG.md`, opts)).toBe(false);
  });

  /**
   * The plugin parses bash through the WASM grammar only. The prebuilt `.node`
   * bindings (six platforms, 8.4MB) and the C sources (9.8MB) are dead weight,
   * and shipping foreign-platform binaries is the R2 mistake the @openai rules
   * above exist to prevent.
   */
  /**
   * The walker asks about a DIRECTORY before descending into it, so a rule that
   * only answers for files inside the package silently skips the package
   * entirely. Caught by a real build, not by the file-level assertions below.
   */
  it('admits the package directories themselves so the walker descends', () => {
    expect(shouldCopy('tree-sitter-bash', opts)).toBe(true);
    expect(shouldCopy('@gotgenes', opts)).toBe(true);
    expect(shouldCopy(PLUGIN, opts)).toBe(true);
    expect(shouldCopy('web-tree-sitter', opts)).toBe(true);
  });

  it('keeps only the wasm grammar from tree-sitter-bash', () => {
    expect(shouldCopy('tree-sitter-bash/tree-sitter-bash.wasm', opts)).toBe(true);
    expect(shouldCopy('tree-sitter-bash/package.json', opts)).toBe(true);
    expect(shouldCopy('tree-sitter-bash/prebuilds/linux-x64/tree-sitter-bash.node', opts)).toBe(
      false
    );
    expect(shouldCopy('tree-sitter-bash/prebuilds/darwin-arm64/tree-sitter-bash.node', opts)).toBe(
      false
    );
    expect(shouldCopy('tree-sitter-bash/src/parser.c', opts)).toBe(false);
    expect(shouldCopy('tree-sitter-bash/bindings/node/index.js', opts)).toBe(false);
    expect(shouldCopy('tree-sitter-bash/grammar.js', opts)).toBe(false);
  });

  /** web-tree-sitter loads its own wasm through the generic rules. */
  it('keeps the web-tree-sitter runtime and its wasm', () => {
    expect(shouldCopy('web-tree-sitter/web-tree-sitter.wasm', opts)).toBe(true);
    expect(shouldCopy('web-tree-sitter/web-tree-sitter.js', opts)).toBe(true);
    expect(shouldCopy('web-tree-sitter/web-tree-sitter.cjs', opts)).toBe(true);
    expect(shouldCopy('web-tree-sitter/web-tree-sitter.js.map', opts)).toBe(false);
  });

  /** The licence carve-out is scoped — it must not un-drop the whole tree. */
  it('does not widen the licence exemption to unrelated packages', () => {
    expect(shouldCopy('some-pkg/LICENSE', opts)).toBe(false);
    expect(shouldCopy('@anthropic-ai/claude-agent-sdk/LICENSE', opts)).toBe(false);
  });

  /** The .ts carve-out is scoped too. */
  it('does not widen the TypeScript exemption to unrelated packages', () => {
    expect(shouldCopy('@gotgenes/some-other-package/src/index.ts', opts)).toBe(false);
    expect(shouldCopy('zod/index.d.ts', opts)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A4 — verifyArtifact must-exist / must-not-exist red arms
// ---------------------------------------------------------------------------
describe('verifyArtifact (A4)', () => {
  const outDir = () => path.join(tmp, 'out');

  it('passes on a healthy hoisted artifact and reports the codex size', () => {
    buildArtifact(outDir());
    const result = verifyArtifact({ outDir: outDir(), ...lx, pins: PINS });
    expect(result.codexPkgRel).toBe('@openai/codex-linux-x64');
    expect(result.codexBytes).toBe(OVER_FLOOR);
  });

  it('passes on a healthy nested artifact', () => {
    buildArtifact(outDir(), { layout: 'nested' });
    const result = verifyArtifact({ outDir: outDir(), ...lx, pins: PINS });
    expect(result.codexPkgRel).toBe('@openai/codex/node_modules/@openai/codex-linux-x64');
  });

  // mustExist 1-8, one red arm each.
  const mustExistArms = [
    [
      '1 launcher',
      'node_modules/@openai/codex/bin/codex.js',
      /missing node_modules\/@openai\/codex\/bin\/codex\.js/,
    ],
    [
      '3 platform package.json',
      'node_modules/@openai/codex-linux-x64/package.json',
      /missing node_modules\/@openai\/codex-linux-x64\/package\.json/,
    ],
    [
      '4 vendor manifest',
      `node_modules/@openai/codex-linux-x64/vendor/${LINUX_TRIPLE}/codex-package.json`,
      /missing .*codex-package\.json/,
    ],
    [
      '5 entry binary',
      `node_modules/@openai/codex-linux-x64/vendor/${LINUX_TRIPLE}/bin/codex`,
      /missing .*bin\/codex$/m,
    ],
    [
      '6 code-mode host',
      `node_modules/@openai/codex-linux-x64/vendor/${LINUX_TRIPLE}/bin/codex-code-mode-host`,
      /missing .*codex-code-mode-host/,
    ],
    [
      '7 manifest pathDir',
      `node_modules/@openai/codex-linux-x64/vendor/${LINUX_TRIPLE}/codex-path`,
      /missing .*codex-path/,
    ],
    [
      '8 manifest resourcesDir',
      `node_modules/@openai/codex-linux-x64/vendor/${LINUX_TRIPLE}/codex-resources`,
      /missing .*codex-resources/,
    ],
  ];

  for (const [label, rel, pattern] of mustExistArms) {
    it(`mustExist ${label} — red when absent`, () => {
      buildArtifact(outDir());
      fs.rmSync(path.join(outDir(), ...rel.split('/')), { recursive: true, force: true });
      expect(() => verifyArtifact({ outDir: outDir(), ...lx, pins: PINS })).toThrow(pattern);
    });
  }

  it('mustExist 2 — red when the main package version drifts from the pin', () => {
    const { nm } = buildArtifact(outDir());
    writeJson(path.join(nm, '@openai', 'codex', 'package.json'), { version: '0.147.0' });
    expect(() => verifyArtifact({ outDir: outDir(), ...lx, pins: PINS })).toThrow(
      /@openai\/codex version 0\.147\.0 != pinned 0\.149\.1/
    );
  });

  it('mustExist 3 — red when the platform alias version drifts', () => {
    const { pkgDir } = buildArtifact(outDir());
    writeJson(path.join(pkgDir, 'package.json'), { name: '@openai/codex', version: PIN });
    expect(() => verifyArtifact({ outDir: outDir(), ...lx, pins: PINS })).toThrow(
      /expected 0\.149\.1-linux-x64, got 0\.149\.1/
    );
  });

  it('mustExist 5 — red when the entry binary is below the floor', () => {
    const { vendorDir } = buildArtifact(outDir());
    writeSparse(path.join(vendorDir, 'bin', 'codex'), 1024);
    expect(() => verifyArtifact({ outDir: outDir(), ...lx, pins: PINS })).toThrow(
      /suspiciously small/
    );
  });

  it('mustExist 5 — red when the entry binary lost its exec bit', () => {
    const { vendorDir } = buildArtifact(outDir());
    fs.chmodSync(path.join(vendorDir, 'bin', 'codex'), 0o644);
    expect(() => verifyArtifact({ outDir: outDir(), ...lx, pins: PINS })).toThrow(
      /lost its exec bit/
    );
  });

  // mustNotExist 9 — all ten foreign paths, one red arm each.
  it('mustNotExist 9 — every foreign platform path in both layouts turns it red', () => {
    const rels = foreignCodexPlatformRels('linux', 'x64');
    expect(rels).toHaveLength(10);
    for (const rel of rels) {
      buildArtifact(outDir());
      fs.mkdirSync(path.join(outDir(), 'node_modules', ...rel.split('/')), { recursive: true });
      expect(() => verifyArtifact({ outDir: outDir(), ...lx, pins: PINS })).toThrow(
        new RegExp(`must not ship node_modules/${rel.replace(/[/@]/g, (c) => `\\${c}`)}`)
      );
      fs.rmSync(outDir(), { recursive: true, force: true });
    }
  });

  it('mustNotExist 10 — the whole .bin directory, not just .bin/codex', () => {
    buildArtifact(outDir());
    // Directory present but with no codex link: a path-level assertion on
    // node_modules/.bin/codex would miss this.
    fs.mkdirSync(path.join(outDir(), 'node_modules', '.bin'), { recursive: true });
    expect(() => verifyArtifact({ outDir: outDir(), ...lx, pins: PINS })).toThrow(
      /must not ship node_modules\/\.bin/
    );
  });

  it('mustNotExist 11 — a vendor dir on the main package means someone took the fallback path', () => {
    const { nm } = buildArtifact(outDir());
    fs.mkdirSync(path.join(nm, '@openai', 'codex', 'vendor'), { recursive: true });
    expect(() => verifyArtifact({ outDir: outDir(), ...lx, pins: PINS })).toThrow(
      /must not ship node_modules\/@openai\/codex\/vendor/
    );
  });

  it('mustNotExist 12 (A9) — any @openai at all is red on a non-shipped platform', () => {
    buildArtifact(outDir(), { platform: 'darwin', arch: 'arm64' });
    expect(() =>
      verifyArtifact({ outDir: outDir(), platform: 'darwin', arch: 'arm64', pins: PINS })
    ).toThrow(/must not ship node_modules\/@openai \(codex not shipped for darwin-arm64\)/);
  });

  it('A9 — a mac artifact with no @openai at all passes', () => {
    buildArtifact(outDir());
    fs.rmSync(path.join(outDir(), 'node_modules', '@openai'), { recursive: true, force: true });
    fs.mkdirSync(path.join(outDir(), 'node_modules', 'node-pty', 'prebuilds', 'darwin-arm64'), {
      recursive: true,
    });
    const result = verifyArtifact({
      outDir: outDir(),
      platform: 'darwin',
      arch: 'arm64',
      pins: PINS,
    });
    expect(result.codexBytes).toBeNull();
    expect(result.codexPkgRel).toBeNull();
  });

  it('collects every failure rather than stopping at the first', () => {
    const { nm } = buildArtifact(outDir());
    fs.rmSync(path.join(nm, '@openai', 'codex', 'bin', 'codex.js'), { force: true });
    fs.mkdirSync(path.join(nm, '.bin'), { recursive: true });
    let message = '';
    try {
      verifyArtifact({ outDir: outDir(), ...lx, pins: PINS });
    } catch (error) {
      message = error.message;
    }
    expect(message).toMatch(/codex\.js/);
    expect(message).toMatch(/\.bin/);
  });
});

// ---------------------------------------------------------------------------
// M2 — residual prune must scan the nested root too
// ---------------------------------------------------------------------------
describe('pruneResidualPlatformPackages (M2)', () => {
  it('deletes foreign variants in both the hoisted and the nested root', () => {
    const outDir = path.join(tmp, 'out');
    buildArtifact(outDir);
    const nm = path.join(outDir, 'node_modules');
    const hoistedForeign = path.join(nm, '@openai', 'codex-darwin-arm64');
    const nestedForeign = path.join(
      nm,
      '@openai',
      'codex',
      'node_modules',
      '@openai',
      'codex-win32-x64'
    );
    fs.mkdirSync(hoistedForeign, { recursive: true });
    fs.mkdirSync(nestedForeign, { recursive: true });

    pruneResidualPlatformPackages({ outDir, ...lx });

    expect(fs.existsSync(hoistedForeign)).toBe(false);
    expect(fs.existsSync(nestedForeign)).toBe(false);
    // The current platform's package survives.
    expect(fs.existsSync(path.join(nm, '@openai', 'codex-linux-x64'))).toBe(true);
  });

  it('M5 arm: never prunes the code-mode host binary', () => {
    const outDir = path.join(tmp, 'out');
    const { vendorDir } = buildArtifact(outDir);
    pruneResidualPlatformPackages({ outDir, ...lx });
    expect(fs.existsSync(path.join(vendorDir, 'bin', 'codex-code-mode-host'))).toBe(true);
  });
});

describe('resolveCodexPlatformPkgRel', () => {
  it('returns null when neither candidate is present', () => {
    const nm = path.join(tmp, 'node_modules');
    fs.mkdirSync(nm, { recursive: true });
    expect(resolveCodexPlatformPkgRel(nm, 'linux', 'x64')).toBeNull();
  });

  it('prefers the hoisted layout when both are present', () => {
    const nm = path.join(tmp, 'node_modules');
    fs.mkdirSync(path.join(nm, '@openai', 'codex-linux-x64'), { recursive: true });
    fs.mkdirSync(path.join(nm, '@openai', 'codex', 'node_modules', '@openai', 'codex-linux-x64'), {
      recursive: true,
    });
    expect(resolveCodexPlatformPkgRel(nm, 'linux', 'x64')).toBe('@openai/codex-linux-x64');
  });
});

// ---------------------------------------------------------------------------
// A8 — the committed lockfile carries all six optional platform packages
// ---------------------------------------------------------------------------
describe('src/agent-host/package-lock.json (A8)', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const lock = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'src', 'agent-host', 'package-lock.json'), 'utf8')
  );

  // Expected keys are hand-written literals, not generated from the matrix.
  const expected = [
    ['node_modules/@openai/codex-darwin-arm64', '0.149.1-darwin-arm64', 'darwin', 'arm64'],
    ['node_modules/@openai/codex-darwin-x64', '0.149.1-darwin-x64', 'darwin', 'x64'],
    ['node_modules/@openai/codex-linux-arm64', '0.149.1-linux-arm64', 'linux', 'arm64'],
    ['node_modules/@openai/codex-linux-x64', '0.149.1-linux-x64', 'linux', 'x64'],
    ['node_modules/@openai/codex-win32-arm64', '0.149.1-win32-arm64', 'win32', 'arm64'],
    ['node_modules/@openai/codex-win32-x64', '0.149.1-win32-x64', 'win32', 'x64'],
  ];

  it('declares the codex pin exactly, without a range prefix', () => {
    expect(lock.packages['node_modules/@openai/codex'].version).toBe(PIN);
  });

  for (const [key, version, expectedOs, expectedCpu] of expected) {
    it(`carries ${key} as an optional ${expectedOs}/${expectedCpu} entry`, () => {
      const entry = lock.packages[key];
      expect(entry, `${key} missing from the lockfile`).toBeDefined();
      expect(entry.version).toBe(version);
      expect(entry.optional).toBe(true);
      expect(entry.os).toEqual([expectedOs]);
      expect(entry.cpu).toEqual([expectedCpu]);
    });
  }

  it('has exactly six codex platform entries and no more', () => {
    const found = Object.keys(lock.packages).filter((k) =>
      /^node_modules\/@openai\/codex-[a-z0-9]+-[a-z0-9]+$/.test(k)
    );
    expect(found.sort()).toEqual(expected.map(([k]) => k).sort());
  });
});

// ---------------------------------------------------------------------------
// Spec §11-Q1 two-step: observation is scoped by recorded evidence
// ---------------------------------------------------------------------------
const wx = { platform: 'win32', arch: 'x64' };

describe('q1ObserveApplies (spec §11-Q1)', () => {
  it('lists exactly the platforms this repo has measured', () => {
    // Literal, not derived: adding a platform here is the act that promotes its
    // Q1 items from observed to enforced, so it must be a deliberate edit.
    // win32-x64 joined on 2026-08-21 from CI run 32442630099.
    expect(CODEX_MEASURED_PLATFORMS).toEqual(['linux-x64', 'win32-x64']);
  });

  it('is false for every shipped platform now that both are measured', () => {
    // This is the live regression guard: --observe must be inert on both
    // platforms that actually ship codex.
    expect(q1ObserveApplies('linux', 'x64')).toBe(false);
    expect(q1ObserveApplies('win32', 'x64')).toBe(false);
  });

  it('is still true for a platform nobody has measured', () => {
    expect(q1ObserveApplies('darwin', 'arm64')).toBe(true);
    expect(q1ObserveApplies('linux', 'arm64')).toBe(true);
  });
});

/** Stand-in for the next zero-evidence platform (mac/arm). Injected rather than
 * faked into CODEX_MEASURED_PLATFORMS so the softening arm keeps coverage now
 * that no shipped platform is unmeasured. */
const unmeasured = () => true;

describe('preflightHostDeps under --observe (spec §11-Q1)', () => {
  it('records the missing manifest instead of throwing, on an unmeasured platform', () => {
    const { vendorDir } = buildHostInstall(tmp, wx);
    fs.rmSync(path.join(vendorDir, 'codex-package.json'));

    const result = preflightHostDeps({
      root: tmp,
      ...wx,
      observe: true,
      observeApplies: unmeasured,
    });
    expect(result.observations.join('\n')).toMatch(/vendor manifest missing/);
    // The point of observing: the run continues and still produces readings.
    expect(result.pins['@openai/codex']).toBe(PIN);
  });

  it('still throws on the same tree without --observe', () => {
    const { vendorDir } = buildHostInstall(tmp, wx);
    fs.rmSync(path.join(vendorDir, 'codex-package.json'));

    expect(() => preflightHostDeps({ root: tmp, ...wx })).toThrow(/vendor manifest missing/);
  });

  it('is inert on both measured platforms — the flag alone cannot soften them', () => {
    for (const target of [lx, wx]) {
      const root = fs.mkdtempSync(path.join(tmp, 'inert-'));
      const { vendorDir } = buildHostInstall(root, target);
      fs.rmSync(path.join(vendorDir, 'codex-package.json'));

      expect(() => preflightHostDeps({ root, ...target, observe: true })).toThrow(
        /vendor manifest missing/
      );
    }
  });

  it('records an undersized entry binary but never a pin drift', () => {
    const { vendorDir, binName } = buildHostInstall(tmp, wx);
    writeSparse(path.join(vendorDir, 'bin', binName), 1024);

    const observed = preflightHostDeps({
      root: tmp,
      ...wx,
      observe: true,
      observeApplies: unmeasured,
    });
    expect(observed.observations.join('\n')).toMatch(/suspiciously small/);

    // Version drift is a repo-derived truth, not a Windows unknown: softening
    // it would delete pin-drift detection on the very first Windows run.
    writeJson(path.join(vendorDir, 'codex-package.json'), {
      version: '0.147.0',
      target: codexTargetTriple('win32', 'x64'),
      entrypoint: `bin/${binName}`,
      pathDir: 'codex-path',
      resourcesDir: 'codex-resources',
    });
    expect(() =>
      preflightHostDeps({ root: tmp, ...wx, observe: true, observeApplies: unmeasured })
    ).toThrow(/vendor manifest mismatch/);
  });
});

describe('verifyArtifact under --observe (spec §11-Q1)', () => {
  const outDir = () => path.join(tmp, 'out-agent-host');

  it('records missing layout dirs and an undersized binary, on an unmeasured platform', () => {
    const { vendorDir, binName } = buildArtifact(outDir(), wx);
    fs.rmSync(path.join(vendorDir, 'codex-path'), { recursive: true });
    writeSparse(path.join(vendorDir, 'bin', binName), 1024);

    const result = verifyArtifact({
      outDir: outDir(),
      ...wx,
      pins: PINS,
      observe: true,
      observeApplies: unmeasured,
    });
    const text = result.observations.join('\n');
    expect(text).toMatch(/codex-path/);
    expect(text).toMatch(/suspiciously small/);
  });

  it('still throws on the same artifact without --observe', () => {
    const { vendorDir, binName } = buildArtifact(outDir(), wx);
    fs.rmSync(path.join(vendorDir, 'codex-path'), { recursive: true });
    writeSparse(path.join(vendorDir, 'bin', binName), 1024);

    expect(() => verifyArtifact({ outDir: outDir(), ...wx, pins: PINS })).toThrow(
      /suspiciously small/
    );
  });

  it('is inert on a measured platform', () => {
    const { vendorDir } = buildArtifact(outDir(), lx);
    fs.rmSync(path.join(vendorDir, 'codex-path'), { recursive: true });

    expect(() => verifyArtifact({ outDir: outDir(), ...lx, pins: PINS, observe: true })).toThrow(
      /codex-path/
    );
  });

  it('is inert on win32 too, now that it is measured', () => {
    const { vendorDir } = buildArtifact(outDir(), wx);
    fs.rmSync(path.join(vendorDir, 'codex-path'), { recursive: true });

    expect(() => verifyArtifact({ outDir: outDir(), ...wx, pins: PINS, observe: true })).toThrow(
      /codex-path/
    );
  });

  it('never softens a foreign platform package, even while observing', () => {
    buildArtifact(outDir(), wx);
    fs.mkdirSync(path.join(outDir(), 'node_modules', '@openai', 'codex-darwin-arm64'), {
      recursive: true,
    });

    expect(() =>
      verifyArtifact({
        outDir: outDir(),
        ...wx,
        pins: PINS,
        observe: true,
        observeApplies: unmeasured,
      })
    ).toThrow(/codex-darwin-arm64/);
  });
});

describe('verifyArtifact budget terms (spec §6.3)', () => {
  const outDir = () => path.join(tmp, 'out-agent-host');

  it('reports the whole @openai payload, not just the entry binary', () => {
    const { vendorDir, binName } = buildArtifact(outDir(), lx);
    const result = verifyArtifact({ outDir: outDir(), ...lx, pins: PINS });

    const entryBytes = fs.statSync(path.join(vendorDir, 'bin', binName)).size;
    expect(result.codexBytes).toBe(entryBytes);
    // P must exceed the entry binary — it also carries the main package, the
    // code-mode host and the manifest. Equality here is the old bug: the OK
    // line then reports A0 + P and P's largest file, which cannot be solved
    // for either budget term.
    expect(result.codexPayloadBytes).toBeGreaterThan(entryBytes);

    const openaiBytes = dirSizeOf(path.join(outDir(), 'node_modules', '@openai'));
    expect(result.codexPayloadBytes).toBe(openaiBytes);
  });

  it('reports null when the platform ships no codex', () => {
    const dir = outDir();
    buildArtifact(dir, lx);
    fs.rmSync(path.join(dir, 'node_modules', '@openai'), { recursive: true, force: true });

    const result = verifyArtifact({ outDir: dir, platform: 'darwin', arch: 'arm64', pins: PINS });
    expect(result.codexPayloadBytes).toBeNull();
  });
});

/**
 * T08-a — the permission gate has to be IN the artifact, with the notices its
 * licences require.
 *
 * Each of these is a shape a real build has produced or could produce, and each
 * one fails silently at runtime: a plugin directory with no entry loads nothing,
 * a missing WASM grammar makes the bash surface unevaluable, and a stripped
 * licence is an obligation quietly broken. None of them shows up as an error
 * anywhere else.
 */
describe('verifyArtifact — permission gate and licences', () => {
  const outDir = () => path.join(tmp, 'out-gate');
  const verifyLinux = (dir) =>
    verifyArtifact({ outDir: dir, platform: 'linux', arch: 'x64', pins: PINS });

  it('passes on an artifact that ships the whole gate', () => {
    const dir = outDir();
    buildArtifact(dir, lx);
    expect(() => verifyLinux(dir)).not.toThrow();
  });

  /** The half-copied package: present, and unable to load. */
  it('refuses a permission plugin with no entry point', () => {
    const dir = outDir();
    buildArtifact(dir, lx);
    fs.rmSync(path.join(dir, 'node_modules', '@gotgenes', 'pi-permission-system', 'src'), {
      recursive: true,
      force: true,
    });
    expect(() => verifyLinux(dir)).toThrow(/pi-permission-system\/src\/index\.ts/);
  });

  it('refuses an artifact with no permission plugin at all', () => {
    const dir = outDir();
    buildArtifact(dir, lx);
    fs.rmSync(path.join(dir, 'node_modules', '@gotgenes'), { recursive: true, force: true });
    expect(() => verifyLinux(dir)).toThrow(/pi-permission-system/);
  });

  it('refuses an artifact with no bash grammar for the plugin to parse with', () => {
    const dir = outDir();
    buildArtifact(dir, lx);
    fs.rmSync(path.join(dir, 'node_modules', 'tree-sitter-bash', 'tree-sitter-bash.wasm'));
    expect(() => verifyLinux(dir)).toThrow(/tree-sitter-bash\.wasm/);
  });

  /** The two the audit named: transitive, shipped, and stripped by the blanket rule. */
  it('refuses a shipped package whose licence was stripped', () => {
    for (const [name, licenseFile] of [
      ['node-addon-api', 'LICENSE.md'],
      ['node-gyp-build', 'LICENSE'],
      ['zod', 'LICENSE'],
    ]) {
      const dir = outDir();
      buildArtifact(dir, lx);
      fs.rmSync(path.join(dir, 'node_modules', ...name.split('/'), licenseFile));
      expect(() => verifyLinux(dir)).toThrow(new RegExp(`${name}.*without a licence`));
    }
  });

  /** Absent is fine — the obligation only exists for what actually ships. */
  it('says nothing about a licence-bearing package that is not in the artifact', () => {
    const dir = outDir();
    buildArtifact(dir, lx);
    fs.rmSync(path.join(dir, 'node_modules', 'node-addon-api'), { recursive: true, force: true });
    expect(() => verifyLinux(dir)).not.toThrow();
  });

  it('accepts any spelling of the licence file name', () => {
    const dir = outDir();
    buildArtifact(dir, lx);
    const zod = path.join(dir, 'node_modules', 'zod');
    fs.rmSync(path.join(zod, 'LICENSE'));
    fs.writeFileSync(path.join(zod, 'licence.txt'), 'MIT\n');
    expect(() => verifyLinux(dir)).not.toThrow();
  });
});

/**
 * T08-c — the shipped default permission policy, in the artifact.
 *
 * Every case below is a way for the file to be present and useless. A policy
 * that has quietly become permissive parses fine, loads fine, and produces a
 * session that looks entirely normal — which is the whole problem.
 */
describe('shipped permission policy in the artifact', () => {
  const outDir = () => path.join(tmp, 'out-policy');
  const policyPath = (dir) =>
    path.join(dir, 'node_modules', '@gotgenes', 'pi-permission-system', 'config.json');
  const verifyLinux = (dir) =>
    verifyArtifact({ outDir: dir, platform: 'linux', arch: 'x64', pins: PINS });

  it('writes the policy the module defines, into the artifact only', () => {
    const dir = outDir();
    buildArtifact(dir, lx);
    fs.rmSync(policyPath(dir));

    const written = writeBundledPermissionPolicy(dir);
    expect(written).toBe(policyPath(dir));
    expect(fs.readFileSync(written, 'utf8')).toBe(serializeDefaultPermissionPolicy());
  });

  /**
   * T08-c slice 2 — dev must enforce the same policy the packaged app does.
   *
   * `permissionPlugin.ts` resolves the plugin relative to the running Host
   * entry, which in dev is `src/agent-host/`. Before this helper existed that
   * directory had no `config.json`, so a dev build fell back to the plugin's own
   * bare defaults — SAFE (it asks about everything), and therefore silent: the
   * symptom is extra prompts, while the missing half (`.env` refused outright)
   * just never happens.
   */
  describe('ensureDevPermissionPolicy', () => {
    const devRoot = () => path.join(tmp, 'checkout');
    const devPolicyPath = () => policyPath(path.join(devRoot(), 'src', 'agent-host'));

    it('writes the same bytes into the checkout that the artifact gets', () => {
      buildArtifact(path.join(devRoot(), 'src', 'agent-host'), lx);
      fs.rmSync(devPolicyPath());

      const result = ensureDevPermissionPolicy(devRoot());
      expect(result).toEqual({ written: true, path: devPolicyPath() });
      expect(fs.readFileSync(devPolicyPath(), 'utf8')).toBe(serializeDefaultPermissionPolicy());
    });

    /** A checkout with no deps is a `pnpm install` away; it must not block dev. */
    it('reports rather than throws when the plugin is not installed', () => {
      fs.mkdirSync(devRoot(), { recursive: true });
      const result = ensureDevPermissionPolicy(devRoot());
      expect(result.written).toBe(false);
      expect(result.reason).toMatch(/pnpm install/);
    });

    /** The parity is dev's own step — building still leaves the checkout alone. */
    it('is not reached by a build, which writes only the directory it is given', () => {
      buildArtifact(path.join(devRoot(), 'src', 'agent-host'), lx);
      fs.rmSync(devPolicyPath());
      const artifact = outDir();
      buildArtifact(artifact, lx);

      writeBundledPermissionPolicy(artifact);
      expect(fs.existsSync(devPolicyPath())).toBe(false);
    });
  });

  /** A build that lost the plugin must say so, not scatter a config into thin air. */
  it('refuses to write when the plugin did not survive the copy', () => {
    const dir = outDir();
    buildArtifact(dir, lx);
    fs.rmSync(path.join(dir, 'node_modules', '@gotgenes'), { recursive: true, force: true });
    expect(() => writeBundledPermissionPolicy(dir)).toThrow(/did not survive the copy/);
  });

  it('passes verification on a healthy artifact', () => {
    const dir = outDir();
    buildArtifact(dir, lx);
    expect(verifyBundledPermissionPolicy(dir)).toEqual([]);
    expect(() => verifyLinux(dir)).not.toThrow();
  });

  it('fails verification when the policy is missing or unparseable', () => {
    const dir = outDir();
    buildArtifact(dir, lx);
    fs.rmSync(policyPath(dir));
    expect(() => verifyLinux(dir)).toThrow(/missing .*pi-permission-system\/config\.json/);

    fs.writeFileSync(policyPath(dir), '{ not json');
    expect(() => verifyLinux(dir)).toThrow(/not valid JSON/);
  });

  /**
   * The four floors. Each of these is a one-word edit that turns the shipped
   * policy into no policy at all, and none of them is visible at runtime.
   */
  it('fails verification on a policy that has gone permissive', () => {
    const cases = [
      [
        (policy) => {
          policy.permission['*'] = 'allow';
        },
        /permission\["\*"\] must be "ask"/,
      ],
      [
        (policy) => {
          policy.permission.bash['*'] = 'allow';
        },
        /bash\["\*"\] must be "ask"/,
      ],
      [
        (policy) => {
          policy.permission.external_directory['*'] = 'allow';
        },
        /external_directory\["\*"\] must be "ask"/,
      ],
      [
        (policy) => {
          policy.yoloMode = true;
        },
        /yoloMode must be false/,
      ],
    ];
    for (const [mutate, expected] of cases) {
      const dir = outDir();
      buildArtifact(dir, lx);
      const policy = JSON.parse(fs.readFileSync(policyPath(dir), 'utf8'));
      mutate(policy);
      fs.writeFileSync(policyPath(dir), JSON.stringify(policy, null, 2));
      expect(() => verifyLinux(dir)).toThrow(expected);
    }
  });
});

/** Local byte walker, so the expectation does not reuse the lib's dirSize. */
function dirSizeOf(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirSizeOf(full) : fs.statSync(full).size;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Static discipline: this file must never import the CLI shell (spec §9).
// ---------------------------------------------------------------------------
describe('test hygiene', () => {
  it('imports the library only, never the self-executing CLI shell', () => {
    const self = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
    // Built by concatenation so this assertion cannot match its own source.
    const shell = `${['build', 'agent', 'host'].join('-')}.mjs`;
    const importSpecifiers = [...self.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    expect(importSpecifiers.some((spec) => spec.endsWith(shell))).toBe(false);
  });
});
