import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CODEX_BINARY_FLOOR,
  ESBUILD_EXTERNAL,
  foreignCodexPlatformRels,
  preflightHostDeps,
  pruneResidualPlatformPackages,
  resolveCodexPlatformPkgRel,
  shouldCopy,
  verifyArtifact,
} from '../agent-host-build-lib.mjs';

/**
 * Packaging spec §7.1 A3 / A4 / A5 / A6 / A8 / A9 — the T2 construction layer.
 *
 * This file imports the library ONLY, never the CLI shell: the shell has a
 * top-level `await main()` whose third line rm -rf's out-agent-host/, so a bare
 * import would delete the developer's artifact and process.exit the vitest
 * worker (spec §9). A static assertion at the bottom pins that rule.
 */

const PIN = '0.145.0';
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
  const vendorDir = path.join(pkgDir, 'vendor', LINUX_TRIPLE);
  writeJson(path.join(vendorDir, 'codex-package.json'), {
    version: PIN,
    target: LINUX_TRIPLE,
    entrypoint: 'bin/codex',
    pathDir: 'codex-path',
    resourcesDir: 'codex-resources',
  });
  writeSparse(path.join(vendorDir, 'bin', 'codex'), OVER_FLOOR);
  writeSparse(path.join(vendorDir, 'bin', 'codex-code-mode-host'), 1024);
  fs.mkdirSync(path.join(vendorDir, 'codex-path'), { recursive: true });
  fs.mkdirSync(path.join(vendorDir, 'codex-resources'), { recursive: true });

  return { hostRoot, nm, pkgDir, vendorDir, pkgRel: pkgRel.split(path.sep).join('/') };
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

  const key = `${platform}-${arch}`;
  const pkgRel =
    layout === 'nested'
      ? `@openai/codex/node_modules/@openai/codex-${key}`
      : `@openai/codex-${key}`;

  writeJson(path.join(nm, '@openai', 'codex', 'package.json'), { version: PIN });
  writeFile(path.join(nm, '@openai', 'codex', 'bin', 'codex.js'), '// launcher\n');

  const pkgDir = path.join(nm, ...pkgRel.split('/'));
  writeJson(path.join(pkgDir, 'package.json'), { name: '@openai/codex', version: `${PIN}-${key}` });
  const vendorDir = path.join(pkgDir, 'vendor', LINUX_TRIPLE);
  writeJson(path.join(vendorDir, 'codex-package.json'), {
    version: PIN,
    target: LINUX_TRIPLE,
    entrypoint: 'bin/codex',
    pathDir: 'codex-path',
    resourcesDir: 'codex-resources',
  });
  writeSparse(path.join(vendorDir, 'bin', 'codex'), OVER_FLOOR);
  writeSparse(path.join(vendorDir, 'bin', 'codex-code-mode-host'), 1024);
  fs.mkdirSync(path.join(vendorDir, 'codex-path'), { recursive: true });
  fs.mkdirSync(path.join(vendorDir, 'codex-resources'), { recursive: true });

  return { nm, pkgDir, vendorDir, pkgRel };
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
  it('is exactly the two runtime-resolved packages, in order', () => {
    // Element-wise equality, not toContain: a stray third entry (e.g. codex,
    // which is spawned as a CLI and never imported) must turn this red.
    expect(ESBUILD_EXTERNAL).toEqual(['@anthropic-ai/claude-agent-sdk', '@cometix/claude-code']);
    expect(ESBUILD_EXTERNAL).toHaveLength(2);
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
      /expected 0\.145\.0-linux-x64, got 0\.145\.0/
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
      /@openai\/codex version 0\.147\.0 != pinned 0\.145\.0/
    );
  });

  it('mustExist 3 — red when the platform alias version drifts', () => {
    const { pkgDir } = buildArtifact(outDir());
    writeJson(path.join(pkgDir, 'package.json'), { name: '@openai/codex', version: PIN });
    expect(() => verifyArtifact({ outDir: outDir(), ...lx, pins: PINS })).toThrow(
      /expected 0\.145\.0-linux-x64, got 0\.145\.0/
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
    ['node_modules/@openai/codex-darwin-arm64', '0.145.0-darwin-arm64', 'darwin', 'arm64'],
    ['node_modules/@openai/codex-darwin-x64', '0.145.0-darwin-x64', 'darwin', 'x64'],
    ['node_modules/@openai/codex-linux-arm64', '0.145.0-linux-arm64', 'linux', 'arm64'],
    ['node_modules/@openai/codex-linux-x64', '0.145.0-linux-x64', 'linux', 'x64'],
    ['node_modules/@openai/codex-win32-arm64', '0.145.0-win32-arm64', 'win32', 'arm64'],
    ['node_modules/@openai/codex-win32-x64', '0.145.0-win32-x64', 'win32', 'x64'],
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
