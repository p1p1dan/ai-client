/**
 * Pinned Node runtime bundled into the packaged app (C-15 / D17, D36).
 *
 * Both platforms share one version. The build-side table is asserted against
 * Main's runtime lookup table so afterPack and runtime resolution cannot drift.
 *
 * SHA-256 values are transcribed verbatim from the official
 * https://nodejs.org/dist/v24.18.0/SHASUMS256.txt (fetched 2026-08-20T07:52:21Z).
 * Never compute, guess, or "fix up" these by hand.
 */

export const NODE_RUNTIME_VERSION = '24.18.0';

/** Mirror order matters: official first, npmmirror as the fallback source. */
function runtimeUrls(archiveName) {
  return [
    `https://nodejs.org/dist/v${NODE_RUNTIME_VERSION}/${archiveName}`,
    `https://registry.npmmirror.com/-/binary/node/v${NODE_RUNTIME_VERSION}/${archiveName}`,
  ];
}

/**
 * Keyed by `<platform>-<arch>`.
 *
 * - `binaryRel`: path of the node binary INSIDE the extracted archive folder.
 * - `outName`: what it is called in out-node-runtime/.
 */
export const NODE_RUNTIME_PINS = {
  'win32-x64': {
    platformKey: 'win32-x64',
    archiveName: `node-v${NODE_RUNTIME_VERSION}-win-x64.zip`,
    sha256: '0ae68406b42d7725661da979b1403ec9926da205c6770827f33aac9d8f26e821',
    binaryRel: 'node.exe',
    outName: 'node.exe',
    urls: runtimeUrls(`node-v${NODE_RUNTIME_VERSION}-win-x64.zip`),
  },
  'linux-x64': {
    platformKey: 'linux-x64',
    // .tar.gz rather than .tar.xz: mirrors the in-repo precedent in
    // build-remote-runtime-bundle.mjs and avoids an implicit `xz` dependency
    // on the runner.
    archiveName: `node-v${NODE_RUNTIME_VERSION}-linux-x64.tar.gz`,
    sha256: '783130984963db7ba9cbd01089eaf2c2efb055c7c1693c943174b967b3050cb8',
    binaryRel: 'bin/node',
    outName: 'node',
    urls: runtimeUrls(`node-v${NODE_RUNTIME_VERSION}-linux-x64.tar.gz`),
  },
};

/**
 * `'win32','x64'` -> the win32-x64 pin. Returns `undefined` for a platform we
 * do not bundle a runtime for (mac today) — callers must treat that as "skip",
 * never as an error: `dist:prereq` runs this on every platform including the
 * mac build scripts (packaging spec §5.3).
 */
export function nodeRuntimePinFor(platform, arch) {
  return NODE_RUNTIME_PINS[`${platform}-${arch}`];
}

/**
 * Transitional alias kept so the pre-D36 shape keeps resolving. New code should
 * use nodeRuntimePinFor(). Removed when P3 closes out.
 */
export const NODE_RUNTIME_PIN = {
  version: NODE_RUNTIME_VERSION,
  platform: 'win-x64',
  zipName: NODE_RUNTIME_PINS['win32-x64'].archiveName,
  zipSha256: NODE_RUNTIME_PINS['win32-x64'].sha256,
  urls: NODE_RUNTIME_PINS['win32-x64'].urls,
};
