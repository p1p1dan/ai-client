/**
 * Which platforms ship a bundled Node runtime, and what the binary is called
 * (C-15 / D17, multi-platform since D36).
 *
 * This is the Main-side half of a two-sided fact. The build-side source of
 * truth is `scripts/node-runtime-pin.mjs`, which additionally carries the
 * version, archive names, URLs and SHA-256 values that Main has no use for.
 * Main does not import that file: it is an untyped `.mjs` outside `src/`, and
 * the repo's convention for build↔Main shared constants is to state the fact
 * on each side and pin them together with an assertion — the same arrangement
 * used for `AICLIENT_NODE_EXEC_PATH` and `COMETIX_PIN`.
 *
 * `src/shared/agentHost/__tests__/nodeRuntimePin.test.ts` asserts this table
 * and the build-side table agree key-for-key and name-for-name, so the two
 * cannot drift apart silently.
 */
export const BUNDLED_NODE_RUNTIME_BINARIES: Readonly<Record<string, string>> = {
  'win32-x64': 'node.exe',
  'linux-x64': 'node',
};

/**
 * Binary name of the bundled runtime for a platform, or `undefined` when we do
 * not bundle one (mac today) — callers must fall back to machine Node
 * discovery rather than handing the resolver a path that cannot exist.
 */
export function bundledNodeRuntimeBinaryFor(platform: string, arch: string): string | undefined {
  return BUNDLED_NODE_RUNTIME_BINARIES[`${platform}-${arch}`];
}
