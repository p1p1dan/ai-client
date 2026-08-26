/**
 * Codex platform matrix — single source of truth shared by
 * build-agent-host.mjs (via agent-host-build-lib.mjs), verify-packaged-app.mjs
 * and their unit tests.
 *
 * No IO, no `process` reads: every function takes platform/arch as arguments.
 * Source of truth = @openai/codex@0.149.1 bin/codex.js:16-23
 * (PLATFORM_PACKAGE_BY_TARGET), transcribed 2026-08-19.
 */

/** Six optionalDependencies target platforms → upstream Rust target triple. */
export const CODEX_PLATFORM_DIRS = {
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
};

/**
 * Platforms this build actually ships codex for (D52-② / packaging spec §3.2).
 * Key set is asserted equal to NODE_RUNTIME_PINS in P3 (spec C9/A2c).
 */
export const CODEX_SHIPPED_PLATFORMS = ['win32-x64', 'linux-x64'];

/** 'win32','x64' -> 'win32-x64' */
export function codexPlatformKey(platform, arch) {
  return `${platform}-${arch}`;
}

/** Whitelist lookup — true only for platforms this build ships codex for. */
export function isCodexShippedPlatform(platform, arch) {
  return CODEX_SHIPPED_PLATFORMS.includes(codexPlatformKey(platform, arch));
}

/** Leaf package name (no @openai scope), e.g. 'codex-win32-x64'. */
export function codexPlatformPkgLeafName(platform, arch) {
  return `codex-${codexPlatformKey(platform, arch)}`;
}

/** e.g. 'x86_64-pc-windows-msvc'. Throws for an unknown platform key. */
export function codexTargetTriple(platform, arch) {
  const key = codexPlatformKey(platform, arch);
  const triple = CODEX_PLATFORM_DIRS[key];
  if (!triple) throw new Error(`codexTargetTriple: unknown platform key "${key}"`);
  return triple;
}

/** 'codex.exe' on win32, 'codex' elsewhere. */
export function codexBinaryName(platform) {
  return platform === 'win32' ? 'codex.exe' : 'codex';
}

/**
 * The two relative locations npm may place the current platform's package
 * under (packaging spec §3.4-3): hoisted (project install) and nested
 * (global install, or a hoist collision). Written as literal template
 * strings — not derived from a shared helper — so a fixture built from this
 * function can never accidentally match an expectation built from the same
 * function (packaging spec §3.2 assertion discipline).
 */
export function codexPlatformPkgCandidates(platform, arch) {
  const leaf = codexPlatformPkgLeafName(platform, arch);
  return [`@openai/${leaf}`, `@openai/codex/node_modules/@openai/${leaf}`];
}

/**
 * True when `rel` (a '/'-joined path relative to node_modules) belongs to a
 * codex platform package for a platform OTHER than the given one — in either
 * the hoisted or the nested (@openai/codex/node_modules/@openai/...) layout.
 * Checked per path segment so a false-lookalike name (e.g. "codexfoo") can
 * never match.
 */
export function isForeignCodexPlatformPath(rel, platform, arch) {
  const currentKey = codexPlatformKey(platform, arch);
  for (const segment of rel.split('/')) {
    const match = /^codex-(.+)$/.exec(segment);
    if (!match) continue;
    const suffix = match[1];
    if (suffix in CODEX_PLATFORM_DIRS && suffix !== currentKey) return true;
  }
  return false;
}
