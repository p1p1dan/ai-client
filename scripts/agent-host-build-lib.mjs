/**
 * Build logic for the Agent Host artifact, extracted from build-agent-host.mjs
 * so unit tests can exercise preflight / shouldCopy / verifyArtifact / prune
 * without running a real build (packaging spec §9, 改判 ②).
 *
 * Discipline:
 *   - nothing executes on import (no top-level statements, no self-run);
 *   - no process.exit — every failure throws, the CLI shell maps it to exit 1;
 *   - no process.platform / process.arch reads — callers inject them, so a
 *     Linux test box can exercise the win32 and darwin arms.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  CODEX_PLATFORM_DIRS,
  codexBinaryName,
  codexPlatformKey,
  codexPlatformPkgCandidates,
  codexPlatformPkgLeafName,
  codexTargetTriple,
  isCodexShippedPlatform,
  isForeignCodexPlatformPath,
} from './codex-platform.mjs';

/** SDK + Cometix stay external and resolve from the sibling node_modules at
 * runtime. Codex is NOT here on purpose: it is spawned as an external CLI and
 * never imported, so listing it would be a no-op that misleads the next reader
 * (packaging spec §0.2-①). */
export const ESBUILD_EXTERNAL = ['@anthropic-ai/claude-agent-sdk', '@cometix/claude-code'];

/** Entry-binary size floor: guards against LFS pointers / truncated downloads,
 * NOT against version drift (that is the manifest's job). Derived from the
 * linux-x64 measurement of 296 MiB, floored to two thirds and rounded down.
 * The win32 binary's real size is unmeasured — see spec §11-Q1. */
export const CODEX_BINARY_FLOOR = 200 * 1024 * 1024;

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(full);
    else total += fs.statSync(full).size;
  }
  return total;
}

function topPackage(parts) {
  return parts[0].startsWith('@') && parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0];
}

/** node-pty ships prebuilds for darwin/win32 and compiles into build/Release on
 * linux. The copy rules differ per layout, so the caller resolves it once. */
export function hasNodePtyPrebuild({ hostNodeModules, platform, arch }) {
  return fs.existsSync(path.join(hostNodeModules, 'node-pty', 'prebuilds', `${platform}-${arch}`));
}

/**
 * Locate the codex platform package inside a node_modules tree.
 * Returns the '/'-joined path relative to node_modules, or null when absent.
 * Both candidates come from codexPlatformPkgCandidates so preflight, verify and
 * the packaged verifier can never drift into a second source of truth.
 */
export function resolveCodexPlatformPkgRel(nodeModulesDir, platform, arch) {
  for (const rel of codexPlatformPkgCandidates(platform, arch)) {
    if (fs.existsSync(path.join(nodeModulesDir, ...rel.split('/')))) return rel;
  }
  return null;
}

/** Every foreign platform package path that must not survive a copy, in both
 * the hoisted and the nested layout (spec §3.6-9: 5 platforms × 2 layouts). */
export function foreignCodexPlatformRels(platform, arch) {
  const currentKey = codexPlatformKey(platform, arch);
  const rels = [];
  for (const key of Object.keys(CODEX_PLATFORM_DIRS)) {
    if (key === currentKey) continue;
    rels.push(`@openai/codex-${key}`, `@openai/codex/node_modules/@openai/codex-${key}`);
  }
  return rels;
}

// ---------------------------------------------------------------------------
// Preflight: the copy source must be a healthy pinned install.
// ---------------------------------------------------------------------------

/**
 * @returns {{pins: Record<string,string>, codexPkgRel: string|null}}
 * @throws {Error} on any unhealthy install
 */
export function preflightHostDeps({ root, platform, arch }) {
  const hostRoot = path.join(root, 'src', 'agent-host');
  const hostNodeModules = path.join(hostRoot, 'node_modules');
  const fail = (message) => {
    throw new Error(message);
  };

  if (!fs.existsSync(hostNodeModules)) {
    fail(`missing ${hostNodeModules} — run "npm install" in src/agent-host first`);
  }

  const hostPkg = readJson(path.join(hostRoot, 'package.json'));
  const shipsCodex = isCodexShippedPlatform(platform, arch);
  const pinNames = ['@cometix/claude-code', '@anthropic-ai/claude-agent-sdk'];
  if (shipsCodex) pinNames.push('@openai/codex');

  const pins = {};
  for (const name of pinNames) {
    const pin = hostPkg.dependencies?.[name];
    if (!pin) fail(`src/agent-host/package.json does not declare ${name}`);
    if (/^[\^~]/.test(pin)) fail(`${name} must be an exact pin, got "${pin}"`);
    const installedPkgJson = path.join(hostNodeModules, name, 'package.json');
    if (!fs.existsSync(installedPkgJson)) fail(`${name} is not installed`);
    const installed = readJson(installedPkgJson).version;
    if (installed !== pin) fail(`${name} installed ${installed}, pinned ${pin}`);
    pins[name] = pin;
  }

  // Guard against a stub install (npm install --omit=optional skips the
  // platform package, so postinstall cannot produce cli.js / vendor).
  const cometixDir = path.join(hostNodeModules, '@cometix', 'claude-code');
  const cliJs = path.join(cometixDir, 'cli.js');
  if (!fs.existsSync(cliJs)) {
    fail('cometix cli.js missing — reinstall src/agent-host WITH optional dependencies');
  }
  if (fs.statSync(cliJs).size < 5 * 1024 * 1024) {
    fail('cometix cli.js suspiciously small — broken postinstall copy?');
  }
  if (!fs.existsSync(path.join(cometixDir, 'vendor'))) {
    fail('cometix vendor/ missing — broken postinstall copy?');
  }

  const prebuild = path.join(hostNodeModules, 'node-pty', 'prebuilds', `${platform}-${arch}`);
  const buildRelease = path.join(hostNodeModules, 'node-pty', 'build', 'Release');
  if (!fs.existsSync(prebuild) && !fs.existsSync(buildRelease)) {
    fail(`node-pty native binary missing for ${platform}-${arch}`);
  }

  if (!shipsCodex) {
    return { pins, codexPkgRel: null, codexSkipped: `${platform}-${arch}` };
  }

  const key = codexPlatformKey(platform, arch);
  const pin = pins['@openai/codex'];

  // 1. platform package present (either layout)
  const codexPkgRel = resolveCodexPlatformPkgRel(hostNodeModules, platform, arch);
  if (!codexPkgRel) {
    fail(
      `@openai/codex-${key} is not installed — reinstall src/agent-host WITH optional dependencies`
    );
  }
  const codexPkgDir = path.join(hostNodeModules, ...codexPkgRel.split('/'));

  // 2. alias version string: the platform package's own name is "@openai/codex"
  //    and its version carries the platform suffix (spec §0.3-A).
  const expectedVersion = `${pin}-${key}`;
  const platformVersion = readJson(path.join(codexPkgDir, 'package.json')).version;
  if (platformVersion !== expectedVersion) {
    fail(`@openai/codex-${key}: expected ${expectedVersion}, got ${platformVersion}`);
  }

  // 3. upstream vendor manifest — stronger than guessing paths ourselves.
  const triple = codexTargetTriple(platform, arch);
  const vendorDir = path.join(codexPkgDir, 'vendor', triple);
  const manifestPath = path.join(vendorDir, 'codex-package.json');
  if (!fs.existsSync(manifestPath)) {
    fail(`vendor manifest missing: ${codexPkgRel}/vendor/${triple}/codex-package.json`);
  }
  const manifest = readJson(manifestPath);
  if (manifest.version !== pin || manifest.target !== triple) {
    fail(
      `vendor manifest mismatch: expected {version:${pin},target:${triple}}, ` +
        `got {version:${manifest.version},target:${manifest.target}}`
    );
  }
  const entrypoint = path.join(vendorDir, ...String(manifest.entrypoint).split('/'));
  if (!fs.existsSync(entrypoint)) {
    fail(`vendor manifest entrypoint missing: ${manifest.entrypoint}`);
  }

  // 4. entry binary sanity: size floor + exec bit (non-win32).
  const entryStat = fs.statSync(entrypoint);
  if (entryStat.size < CODEX_BINARY_FLOOR) {
    fail(
      `codex binary suspiciously small: ${entryStat.size}B < ${CODEX_BINARY_FLOOR}B ` +
        `(${manifest.entrypoint})`
    );
  }
  if (platform !== 'win32' && (entryStat.mode & 0o111) === 0) {
    fail(`codex binary not executable: ${manifest.entrypoint} (mode ${entryStat.mode.toString(8)})`);
  }

  // 5. no foreign platform packages in the install (R2: 347MB × 5).
  for (const rel of foreignCodexPlatformRels(platform, arch)) {
    if (fs.existsSync(path.join(hostNodeModules, ...rel.split('/')))) {
      fail(`unexpected foreign platform package: ${rel}`);
    }
  }

  return { pins, codexPkgRel, codexSkipped: null };
}

// ---------------------------------------------------------------------------
// Copy filter.
// ---------------------------------------------------------------------------

export function shouldCopy(rel, { platform, arch, hasPtyPrebuild }) {
  if (rel === '') return true;
  const parts = rel.split('/');
  const top = topPackage(parts);

  if (parts[0] === '.bin' || parts[0] === '.package-lock.json') return false;
  if (/^@anthropic-ai\/claude-agent-sdk-.+/.test(top)) return false;
  if (/^@cometix\/claude-code-.+/.test(top)) return false;
  if (parts[0] === '@img' && parts.length >= 2) {
    if (top !== `@img/sharp-${platform}-${arch}`) return false;
  }

  if (parts[0] === '@openai') {
    // Platforms outside the ship whitelist get no codex at all — this is what
    // keeps a 296MiB unsigned Mach-O out of the mac notarization chain (改判 ⑧).
    if (!isCodexShippedPlatform(platform, arch)) return false;
    const leaf = codexPlatformPkgLeafName(platform, arch);
    if (parts.length >= 2 && top !== '@openai/codex' && top !== `@openai/${leaf}`) return false;
    // topPackage() only looks at the first two segments, so a nested foreign
    // package (@openai/codex/node_modules/@openai/codex-darwin-arm64/...) would
    // pass the check above — this catches it per segment.
    if (isForeignCodexPlatformPath(rel, platform, arch)) return false;
    // Vendor ships upstream runtime assets; keep verbatim rather than letting
    // the generic suffix filter below drop future additions (cometix precedent).
    if (rel.includes(`${leaf}/vendor/`)) return true;
  }

  if (parts[0] === 'node-pty' && parts.length >= 2) {
    if (parts.length === 2 && parts[1] === 'package.json') return true;
    if (parts[1] === 'lib') return true;
    if (parts[1] === 'prebuilds') {
      if (parts.length === 2) return true;
      return parts[2] === `${platform}-${arch}`;
    }
    // Linux only: install-time compile lands in build/Release (no prebuilds).
    // When an official prebuild exists (darwin/win32), skip build/ entirely —
    // the loader prefers build/Release and must not pick up a local compile.
    if (parts[1] === 'build' && !hasPtyPrebuild) {
      if (parts.length === 2) return true;
      return parts[2] === 'Release';
    }
    return false;
  }

  if (rel === '@anthropic-ai/claude-agent-sdk/browser-sdk.js') return false;

  // Cometix vendor ships runtime assets (ripgrep etc.) — keep verbatim.
  if (rel.startsWith('@cometix/claude-code/vendor/')) return true;

  const base = parts[parts.length - 1];
  if (/^licen[cs]e(\.|$)/i.test(base)) return false;
  if (
    base.endsWith('.ts') ||
    base.endsWith('.d.mts') ||
    base.endsWith('.d.cts') ||
    base.endsWith('.map') ||
    base.endsWith('.md')
  ) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Residual prune (belt-and-braces after the copy).
// ---------------------------------------------------------------------------

/**
 * The copy filter above already skips platform-variant packages, but on the
 * Windows CI runner cpSync's filter demonstrably let a variant through (run
 * 31860506141, 2026-08-15). Deleting after the fact is idempotent where the
 * filter worked — and codex's residual cost is 347MB per stray variant.
 */
export function pruneResidualPlatformPackages({ outDir, platform, arch }) {
  const rules = [
    ['@anthropic-ai', /^claude-agent-sdk-.+/],
    ['@cometix', /^claude-code-.+/],
    ['@img', new RegExp(`^sharp-(?!${platform}-${arch}$).+`)],
    ['@openai', new RegExp(`^codex-(?!${platform}-${arch}$).+`)],
  ];
  const scanRoots = [
    path.join(outDir, 'node_modules'),
    path.join(outDir, 'node_modules', '@openai', 'codex', 'node_modules'),
  ];
  for (const root of scanRoots) {
    for (const [scope, pattern] of rules) {
      const dir = path.join(root, scope);
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) {
        if (pattern.test(name)) {
          fs.rmSync(path.join(dir, name), { recursive: true, force: true });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Artifact verification.
// ---------------------------------------------------------------------------

/**
 * @returns {{codexBytes: number|null, codexPkgRel: string|null}}
 * @throws {Error} listing every failed check
 */
export function verifyArtifact({ outDir, platform, arch, pins }) {
  const failures = [];
  const nodeModules = path.join(outDir, 'node_modules');
  const abs = (rel) => path.join(outDir, ...rel.split('/'));
  const mustExist = (rel, note) => {
    if (!fs.existsSync(abs(rel))) failures.push(`missing ${rel}${note ? ` (${note})` : ''}`);
  };
  const mustNotExist = (rel, note) => {
    if (fs.existsSync(abs(rel))) failures.push(`must not ship ${rel}${note ? ` (${note})` : ''}`);
  };

  for (const rel of [
    'index.js',
    'package.json',
    'node_modules/@cometix/claude-code/cli.js',
    'node_modules/@cometix/claude-code/vendor',
    'node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs',
  ]) {
    mustExist(rel);
  }

  const ptyBinaries = [
    `node_modules/node-pty/prebuilds/${platform}-${arch}`,
    'node_modules/node-pty/build/Release',
  ];
  if (!ptyBinaries.some((rel) => fs.existsSync(abs(rel)))) {
    failures.push(`missing node-pty native binary (${ptyBinaries.join(' or ')})`);
  }

  for (const rel of [
    `node_modules/@anthropic-ai/claude-agent-sdk-${platform}-${arch}`,
    `node_modules/@cometix/claude-code-${platform}-${arch}`,
  ]) {
    mustNotExist(rel);
  }
  mustNotExist('node_modules/.bin', 'npm bin symlink dir');

  let codexBytes = null;
  let codexPkgRel = null;

  if (!isCodexShippedPlatform(platform, arch)) {
    // Whitelist arm: nothing from @openai may ship on this platform (改判 ⑧).
    mustNotExist('node_modules/@openai', `codex not shipped for ${platform}-${arch}`);
  } else {
    const pin = pins?.['@openai/codex'];
    mustExist('node_modules/@openai/codex/bin/codex.js', 'REQ-8 node wrapper');
    mustNotExist('node_modules/@openai/codex/vendor', 'main package must have no vendor dir');

    const mainPkgJson = abs('node_modules/@openai/codex/package.json');
    if (!fs.existsSync(mainPkgJson)) {
      failures.push('missing node_modules/@openai/codex/package.json');
    } else if (pin && readJson(mainPkgJson).version !== pin) {
      failures.push(
        `@openai/codex version ${readJson(mainPkgJson).version} != pinned ${pin}`
      );
    }

    codexPkgRel = resolveCodexPlatformPkgRel(nodeModules, platform, arch);
    if (!codexPkgRel) {
      failures.push(
        `missing codex platform package (${codexPlatformPkgCandidates(platform, arch).join(' or ')})`
      );
    } else {
      const key = codexPlatformKey(platform, arch);
      const triple = codexTargetTriple(platform, arch);
      const pkgRoot = `node_modules/${codexPkgRel}`;
      const vendorRel = `${pkgRoot}/vendor/${triple}`;

      const platformPkgJson = abs(`${pkgRoot}/package.json`);
      if (!fs.existsSync(platformPkgJson)) {
        failures.push(`missing ${pkgRoot}/package.json`);
      } else if (pin) {
        const expected = `${pin}-${key}`;
        const got = readJson(platformPkgJson).version;
        if (got !== expected) failures.push(`${pkgRoot}: expected ${expected}, got ${got}`);
      }

      const manifestPath = abs(`${vendorRel}/codex-package.json`);
      if (!fs.existsSync(manifestPath)) {
        failures.push(`missing ${vendorRel}/codex-package.json`);
      } else {
        const manifest = readJson(manifestPath);
        if (manifest.version !== pin || manifest.target !== triple) {
          failures.push(
            `${vendorRel}/codex-package.json mismatch: ` +
              `{version:${manifest.version},target:${manifest.target}}`
          );
        }
        // Directory names come from the manifest, never hardcoded — the win32
        // variant's layout is unmeasured (spec §11-Q1).
        for (const dirKey of ['pathDir', 'resourcesDir']) {
          const dirName = manifest[dirKey];
          if (!dirName) failures.push(`${vendorRel}/codex-package.json has no ${dirKey}`);
          else mustExist(`${vendorRel}/${dirName}`, `manifest.${dirKey}`);
        }
      }

      const binName = codexBinaryName(platform);
      const entryRel = `${vendorRel}/bin/${binName}`;
      const entryAbs = abs(entryRel);
      if (!fs.existsSync(entryAbs)) {
        failures.push(`missing ${entryRel}`);
      } else {
        const stat = fs.statSync(entryAbs);
        codexBytes = stat.size;
        if (stat.size < CODEX_BINARY_FLOOR) {
          failures.push(`${entryRel} suspiciously small: ${stat.size}B < ${CODEX_BINARY_FLOOR}B`);
        }
        if (platform !== 'win32' && (stat.mode & 0o111) === 0) {
          failures.push(`${entryRel} lost its exec bit (mode ${stat.mode.toString(8)})`);
        }
      }

      // code-mode host: kept on purpose (spec §3.5) — assert so nobody prunes
      // it as an "obvious" 44MiB saving without redoing that analysis.
      const hostBin = platform === 'win32' ? 'codex-code-mode-host.exe' : 'codex-code-mode-host';
      mustExist(`${vendorRel}/bin/${hostBin}`, 'spec §3.5 keeps this on purpose');
    }

    for (const rel of foreignCodexPlatformRels(platform, arch)) {
      mustNotExist(`node_modules/${rel}`, 'foreign platform package');
    }
  }

  if (failures.length > 0) {
    throw new Error(`artifact verification failed:\n  - ${failures.join('\n  - ')}`);
  }
  return { codexBytes, codexPkgRel };
}
