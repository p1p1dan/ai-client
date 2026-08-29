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

import { serializeDefaultPermissionPolicy } from '../src/agent-host/permissionPolicy.mjs';
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
export const ESBUILD_EXTERNAL = [
  '@anthropic-ai/claude-agent-sdk',
  '@cometix/claude-code',
  '@earendil-works/pi-coding-agent',
];

/** Entry-binary size floor: guards against LFS pointers / truncated downloads,
 * NOT against version drift (that is the manifest's job).
 *
 * Originally derived from codex 0.145.0's linux-x64 entry binary (296 MiB),
 * floored to two thirds. Both terms of that derivation shrank in 0.149.1 —
 * linux 310,730,800 B -> 258,227,840 B (246.3 MiB) and win32
 * 359,245,096 B -> 297,481,008 B (283.7 MiB), both re-measured 2026-08-26 —
 * so the constant is now ~81% of the smaller platform rather than ~67%.
 *
 * It is deliberately NOT lowered to restore the old ratio: a truncation guard
 * only gets weaker by moving down, and 200 MiB still clears every shipped
 * platform. What this DOES mean is that the ratio is no longer self-renewing:
 * re-check this constant on every codex bump, and if an upstream binary ever
 * lands under ~250 MiB, re-derive rather than assume. */
export const CODEX_BINARY_FLOOR = 200 * 1024 * 1024;

/**
 * Platforms whose codex payload has actually been measured in this repo, i.e.
 * platforms past step one of the spec §11-Q1 two-step.
 *
 * This list — NOT a CLI flag — is what turns observation off. `observe: true`
 * is inert for a platform listed here, so the flag can be left in the workflow
 * without ever softening a platform that already has evidence, and adding a
 * platform's measured numbers automatically promotes its Q1 items to hard
 * gates on the next run. A flag that softened unconditionally would be one
 * forgotten line away from a permanent hole.
 */
export const CODEX_MEASURED_PLATFORMS = ['linux-x64', 'win32-x64'];

/**
 * Whether spec §11-Q1 observation still applies to this platform.
 *
 * Both shipped platforms are now measured, so in production this returns false
 * everywhere that ships codex and the softening arm has no live consumer. It is
 * kept — and injectable as `observeApplies` in the two functions below — for the
 * NEXT platform to be added (mac/arm), which arrives with zero evidence exactly
 * as win32 did. The injection seam exists so the softening arm keeps test
 * coverage instead of rotting until then.
 */
export function q1ObserveApplies(platform, arch) {
  return !CODEX_MEASURED_PLATFORMS.includes(`${platform}-${arch}`);
}

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
 * @returns {{pins: Record<string,string>, codexPkgRel: string|null,
 *            observations: string[]}}
 * @throws {Error} on any unhealthy install
 */
export function preflightHostDeps({
  root,
  platform,
  arch,
  observe = false,
  observeApplies = q1ObserveApplies,
}) {
  const hostRoot = path.join(root, 'src', 'agent-host');
  const hostNodeModules = path.join(hostRoot, 'node_modules');
  const observations = [];
  const fail = (message) => {
    throw new Error(message);
  };
  // Spec §11-Q1: the Windows vendor layout and the entry binary's size are
  // unmeasured, so on the first run they are observed rather than enforced —
  // otherwise the run dies here and produces none of the evidence it exists to
  // collect. Everything else stays hard.
  const soften = observe && observeApplies(platform, arch);
  const q1 = (message) => {
    if (soften) observations.push(message);
    else fail(message);
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
    return { pins, codexPkgRel: null, codexSkipped: `${platform}-${arch}`, observations };
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
  // Conventional fallback path: under observation the size/exec readings below
  // must still be produced when the manifest itself is what went missing.
  let entryRel = `bin/${codexBinaryName(platform)}`;
  if (!fs.existsSync(manifestPath)) {
    q1(`vendor manifest missing: ${codexPkgRel}/vendor/${triple}/codex-package.json`);
  } else {
    const manifest = readJson(manifestPath);
    // Version/target are repo-derived truths, not Windows unknowns — softening
    // them would erase pin-drift detection, so they stay hard everywhere.
    if (manifest.version !== pin || manifest.target !== triple) {
      fail(
        `vendor manifest mismatch: expected {version:${pin},target:${triple}}, ` +
          `got {version:${manifest.version},target:${manifest.target}}`
      );
    }
    entryRel = String(manifest.entrypoint);
    if (!fs.existsSync(path.join(vendorDir, ...entryRel.split('/')))) {
      fail(`vendor manifest entrypoint missing: ${entryRel}`);
    }
  }

  // 4. entry binary sanity: size floor + exec bit (non-win32).
  const entrypoint = path.join(vendorDir, ...entryRel.split('/'));
  if (!fs.existsSync(entrypoint)) {
    q1(`codex entry binary missing: ${entryRel}`);
  } else {
    const entryStat = fs.statSync(entrypoint);
    if (entryStat.size < CODEX_BINARY_FLOOR) {
      q1(
        `codex binary suspiciously small: ${entryStat.size}B < ${CODEX_BINARY_FLOOR}B (${entryRel})`
      );
    }
    if (platform !== 'win32' && (entryStat.mode & 0o111) === 0) {
      fail(`codex binary not executable: ${entryRel} (mode ${entryStat.mode.toString(8)})`);
    }
  }

  // 5. no foreign platform packages in the install (R2: 347MB × 5).
  for (const rel of foreignCodexPlatformRels(platform, arch)) {
    if (fs.existsSync(path.join(hostNodeModules, ...rel.split('/')))) {
      fail(`unexpected foreign platform package: ${rel}`);
    }
  }

  return { pins, codexPkgRel, codexSkipped: null, observations };
}

// ---------------------------------------------------------------------------
// Copy filter.
// ---------------------------------------------------------------------------

/**
 * T08-a — packages bundled for the permission system, whose LICENSE files must
 * travel with the binary. All MIT/Apache-style licences that require the
 * copyright notice to be distributed with the software.
 *
 * The list is derived from what actually SHIPS, not from what the permission
 * plugin declares: `node-addon-api` and `node-gyp-build` arrive transitively
 * (via `tree-sitter-bash` and `node-pty`), were present in every artifact, and
 * had their licences dropped by the blanket rule below — the exact obligation
 * this set exists to meet. `verifyArtifact` now checks the whole set against the
 * built tree, so a package that ships without its notice fails the build rather
 * than waiting for someone to notice.
 */
export const LICENSE_BEARING_PACKAGES = new Set([
  '@gotgenes/pi-permission-system',
  'tree-sitter-bash',
  'web-tree-sitter',
  'zod',
  'node-addon-api',
  'node-gyp-build',
]);

/** Where the bundled plugin reads a distributor default from. */
export const BUNDLED_PERMISSION_POLICY_REL =
  'node_modules/@gotgenes/pi-permission-system/config.json';

/**
 * T08-c — write the shipped permission policy into the bundled plugin.
 *
 * The plugin reads `<extensionRoot>/config.json` as its LOWEST-precedence
 * scope, so this is a default the user's own agentDir config overrides rather
 * than a setting we impose.
 *
 * Takes the directory to write into rather than deciding it, because there are
 * two and they are written by different things: the BUILD writes the artifact,
 * and `pnpm dev` writes the checkout through {@link ensureDevPermissionPolicy}.
 * Running a build still does not touch the checkout — the parity is dev's own
 * explicit step, not a side effect of building.
 */
export function writeBundledPermissionPolicy(outDir) {
  const target = path.join(outDir, ...BUNDLED_PERMISSION_POLICY_REL.split('/'));
  if (!fs.existsSync(path.dirname(target))) {
    throw new Error(
      `cannot write the permission policy: ${path.dirname(target)} is missing — the plugin did not survive the copy`
    );
  }
  fs.writeFileSync(target, serializeDefaultPermissionPolicy());
  return target;
}

/** In dev the Host runs from here, and resolves its plugin from this directory. */
export const DEV_AGENT_HOST_DIR_REL = 'src/agent-host';

/**
 * Give `pnpm dev` the same shipped policy the packaged app has.
 *
 * Without this the two do not enforce the same rules. `permissionPlugin.ts`
 * resolves the plugin relative to the running Host entry, which in dev is
 * `src/agent-host/` — a directory the build never writes — so a developer (or
 * anyone doing acceptance on a dev build) got the plugin's own bare fallback
 * instead of our policy. That fallback is SAFE (it asks about everything), which
 * is exactly why the gap could sit there unnoticed: the symptom is extra
 * prompts, and the missing half is silent. `cat .env` would prompt rather than
 * being refused outright, and a test of the shipped deny list would pass for
 * the wrong reason.
 *
 * Returns rather than throws when the plugin is not installed: a checkout with
 * no `node_modules` is a `pnpm install` away, and blocking `pnpm dev` on it
 * would be the wrong trade. The Host refuses to start a session with no gate
 * anyway, so the fail-closed behaviour does not depend on this.
 */
export function ensureDevPermissionPolicy(repoRoot) {
  const outDir = path.join(repoRoot, ...DEV_AGENT_HOST_DIR_REL.split('/'));
  const pluginDir = path.dirname(path.join(outDir, ...BUNDLED_PERMISSION_POLICY_REL.split('/')));
  if (!fs.existsSync(pluginDir)) {
    return { written: false, reason: `${pluginDir} is missing — run pnpm install` };
  }
  return { written: true, path: writeBundledPermissionPolicy(outDir) };
}

/**
 * The three properties of the shipped policy that, if lost, would leave a
 * plausible-looking config with no gate in it.
 *
 * Checked against the ARTIFACT rather than the source module: a build that
 * writes the file and then prunes or truncates it fails here, and an edit that
 * loosens the policy without meaning to fails here too. Deliberately narrow —
 * this is a floor, not a copy of the policy.
 */
export function verifyBundledPermissionPolicy(outDir) {
  const target = path.join(outDir, ...BUNDLED_PERMISSION_POLICY_REL.split('/'));
  if (!fs.existsSync(target)) return [`missing ${BUNDLED_PERMISSION_POLICY_REL}`];
  let parsed;
  try {
    parsed = readJson(target);
  } catch (error) {
    return [`${BUNDLED_PERMISSION_POLICY_REL} is not valid JSON: ${error.message}`];
  }
  const failures = [];
  const permission = parsed.permission ?? {};
  // A permissive universal fallback would silently cover every surface the
  // policy does not name, including extension tools nobody has seen yet.
  if (permission['*'] !== 'ask') failures.push('shipped policy: permission["*"] must be "ask"');
  // The plugin's own docs: a config whose top-level `*` is permissive with no
  // bash rule lets every command inherit it. Ours must state bash outright.
  if (permission.bash?.['*'] !== 'ask') {
    failures.push('shipped policy: permission.bash["*"] must be "ask"');
  }
  // Leaving the working directory is the worktree boundary (D-Q9 decision 3).
  if (permission.external_directory?.['*'] !== 'ask') {
    failures.push('shipped policy: permission.external_directory["*"] must be "ask"');
  }
  // Yolo re-permits even the wrapper floors; it must never ship on.
  if (parsed.yoloMode !== false) failures.push('shipped policy: yoloMode must be false');
  return failures;
}

/** Names a licence file: `LICENSE`, `LICENCE.md`, `license.txt`, … */
export function isLicenseFileName(base) {
  return /^licen[cs]e(\.|$)/i.test(base);
}

/**
 * The licence file inside `packageDir`, or `null`.
 *
 * Top level only, and by name: a licence quoted inside a README is not a
 * distributed notice, and descending would turn a dependency's own vendored
 * licences into a false pass for the package itself.
 */
export function findLicenseFile(packageDir) {
  if (!fs.existsSync(packageDir)) return null;
  for (const entry of fs.readdirSync(packageDir, { withFileTypes: true })) {
    if (entry.isFile() && isLicenseFileName(entry.name)) return entry.name;
  }
  return null;
}

export function shouldCopy(rel, { platform, arch, hasPtyPrebuild }) {
  if (rel === '') return true;
  const parts = rel.split('/');
  const top = topPackage(parts);
  const base = parts[parts.length - 1];

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

  // T08-a — @gotgenes/pi-permission-system (MIT) is bundled so tool approval
  // works without the user having installed anything globally.
  //
  // Its runtime entry is TYPESCRIPT: package.json declares
  // `pi.extensions: ["./src/index.ts"]` and `dist/` holds nothing but a
  // `.d.ts`. pi strips types when it loads an extension, so the generic
  // `.ts` drop below would ship this package with no entry point at all —
  // a permission system that silently fails to load is worse than none,
  // because the absence looks exactly like "nothing needed approval".
  if (top === '@gotgenes/pi-permission-system') {
    // Docs are the only real weight here and never load at runtime.
    if (rel.includes('/docs/')) return false;
    if (/^(README|CHANGELOG)\./i.test(base)) return false;
    return true;
  }

  // tree-sitter-bash: the plugin parses bash through the WASM grammar only
  // (`require.resolve("tree-sitter-bash/tree-sitter-bash.wasm")` in its
  // access-intent/bash/parser.ts). The prebuilt `.node` bindings (8.4MB, six
  // platforms) and the C grammar sources (9.8MB) are never loaded — shipping
  // them would add ~18MB of dead weight per install, and the foreign-platform
  // binaries would repeat the R2 mistake `@openai` guards against above.
  if (top === 'tree-sitter-bash') {
    // The walker asks about the package DIRECTORY before descending into it, so
    // this arm must say yes to it or the whole package is skipped and the bash
    // parser has no grammar to load.
    if (parts.length === 1) return true;
    if (parts.length !== 2) return false;
    // LICENSE included: this branch returns before the licence rule below.
    return base === 'package.json' || base.endsWith('.wasm') || isLicenseFileName(base);
  }

  // T08-a: MIT obliges us to ship the copyright notice with the binary, so the
  // packages bundled for the permission system keep theirs. (The blanket drop
  // below predates this and covers the rest of the tree — a wider audit is its
  // own task, not something to smuggle in here.)
  if (LICENSE_BEARING_PACKAGES.has(top) && isLicenseFileName(base)) return true;
  if (isLicenseFileName(base)) return false;
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
 * @returns {{codexBytes: number|null, codexPayloadBytes: number|null,
 *            codexPkgRel: string|null, observations: string[]}}
 * @throws {Error} listing every failed check
 */
export function verifyArtifact({
  outDir,
  platform,
  arch,
  pins,
  observe = false,
  observeApplies = q1ObserveApplies,
}) {
  const failures = [];
  const observations = [];
  // Same §11-Q1 scope as preflight — see q1ObserveApplies.
  const soften = observe && observeApplies(platform, arch);
  const q1 = (message) => {
    if (soften) observations.push(message);
    else failures.push(message);
  };
  const nodeModules = path.join(outDir, 'node_modules');
  const abs = (rel) => path.join(outDir, ...rel.split('/'));
  const mustExist = (rel, note) => {
    if (!fs.existsSync(abs(rel))) failures.push(`missing ${rel}${note ? ` (${note})` : ''}`);
  };
  const q1MustExist = (rel, note) => {
    if (!fs.existsSync(abs(rel))) q1(`missing ${rel}${note ? ` (${note})` : ''}`);
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

  // T08-a — the permission gate's runtime files.
  //
  // Asserted individually rather than as "the directory exists": the packaging
  // filter treats this package specially (it keeps `.ts`, which the generic rule
  // drops), so a tree that is present but missing its ENTRY is a real outcome —
  // and the Host would then start with no gate, which looks exactly like a
  // session where nothing needed approval.
  for (const rel of [
    'node_modules/@gotgenes/pi-permission-system/package.json',
    'node_modules/@gotgenes/pi-permission-system/src/index.ts',
    // The plugin parses bash through the WASM grammar only; without it the bash
    // surface cannot be evaluated at all.
    'node_modules/tree-sitter-bash/tree-sitter-bash.wasm',
  ]) {
    mustExist(rel, 'permission gate');
  }

  failures.push(...verifyBundledPermissionPolicy(outDir));

  // MIT/Apache obliges us to distribute the copyright notice with the binary.
  // Driven off what is IN the artifact, not off a hand-kept list of what we
  // think ships: `node-addon-api` and `node-gyp-build` arrive transitively and
  // shipped for months with their notices stripped by the blanket licence drop.
  for (const name of LICENSE_BEARING_PACKAGES) {
    const packageDir = abs(`node_modules/${name}`);
    if (!fs.existsSync(packageDir)) continue;
    if (!findLicenseFile(packageDir)) {
      failures.push(`node_modules/${name} ships without a licence file`);
    }
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
  let codexPayloadBytes = null;
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
      failures.push(`@openai/codex version ${readJson(mainPkgJson).version} != pinned ${pin}`);
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
        q1(`missing ${vendorRel}/codex-package.json`);
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
          if (!dirName) q1(`${vendorRel}/codex-package.json has no ${dirKey}`);
          else q1MustExist(`${vendorRel}/${dirName}`, `manifest.${dirKey}`);
        }
      }

      const binName = codexBinaryName(platform);
      const entryRel = `${vendorRel}/bin/${binName}`;
      const entryAbs = abs(entryRel);
      if (!fs.existsSync(entryAbs)) {
        q1(`missing ${entryRel}`);
      } else {
        const stat = fs.statSync(entryAbs);
        codexBytes = stat.size;
        if (stat.size < CODEX_BINARY_FLOOR) {
          q1(`${entryRel} suspiciously small: ${stat.size}B < ${CODEX_BINARY_FLOOR}B`);
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

    // `P` in the spec §6.3 budget: the WHOLE shipped @openai payload (main
    // package + this platform's package after pruning), not the entry binary.
    // Printing only the entry binary next to the total leaves `A0 + P` one
    // equation short of solving for either term, which is exactly what blocks
    // filling in PACKAGING_BUDGET for a platform that has never been measured.
    const openaiDir = abs('node_modules/@openai');
    if (fs.existsSync(openaiDir)) codexPayloadBytes = dirSize(openaiDir);
  }

  if (failures.length > 0) {
    throw new Error(`artifact verification failed:\n  - ${failures.join('\n  - ')}`);
  }
  return { codexBytes, codexPayloadBytes, codexPkgRel, observations };
}
