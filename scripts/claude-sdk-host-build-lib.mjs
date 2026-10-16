/**
 * The Claude Agent SDK host artifact shipped as resources/claude-sdk-host
 * (route B S-4, docs/plantree/plans/claude-sdk-engine/topics/s4-packaging.md).
 *
 * Pure helpers and the artifact verifier for scripts/build-claude-sdk-host.mjs,
 * scripts/afterPack.mjs and scripts/verify-packaged-app.mjs. The layout:
 *
 *   host.js                          esbuild bundle of src/claude-sdk-host/host.ts (B-2)
 *   package.json                     the install anchor (`type: module`)
 *   claude-sdk-host-manifest.json    target, versions, CLI path and digest, size (B-8)
 *   THIRD_PARTY_LICENSES.json        one entry per installed package
 *   node_modules/@anthropic-ai/claude-agent-sdk/                 the SDK
 *   node_modules/@anthropic-ai/claude-agent-sdk-<platform>-<arch>/   its CLI (B-3)
 */

import fs from 'node:fs';
import { isBuiltin } from 'node:module';
import path from 'node:path';

import {
  binaryFormat,
  binaryMatchesTarget,
  collectLicenses,
  isDocumentationMarkdown,
  isLicenseFileName,
  readJson,
  sha256File,
  targetKey,
  treeStats,
  walkTree,
} from './dsh-host-build-lib.mjs';
import { evaluateClaudeSdkHostArtifact } from './packaging-budget.mjs';

export const CLAUDE_SDK_HOST_SOURCE_REL = 'src/claude-sdk-host';
export const CLAUDE_SDK_HOST_OUT_REL = 'out-claude-sdk-host';
export const CLAUDE_SDK_HOST_MANIFEST = 'claude-sdk-host-manifest.json';
export const CLAUDE_SDK_HOST_LICENSES = 'THIRD_PARTY_LICENSES.json';
export const CLAUDE_SDK_MANIFEST_SCHEMA = 1;
/** The only npm package host.js imports at run time (B-2). */
export const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';
/** Files copied from the source directory before `npm ci`. */
export const STAGED_SOURCE_FILES = ['package.json', 'package-lock.json'];
export const HOST_ENTRY = { entry: 'host.ts', out: 'host.js' };
/**
 * What host.js may take in: the host's own modules, the shared pure libraries and
 * the DSH bridge's RPC server it answers with. Never its tools or tests.
 */
export const HOST_INPUTS = ['src/claude-sdk-host/', 'src/shared/', 'src/dsh-host/bridge/'];
export const HOST_INPUTS_EXCLUDED = ['src/claude-sdk-host/tools/', '/__tests__/'];
/** The DSH host's targets; macOS builds still produce one, untested (decision 090). */
export const SUPPORTED_TARGETS = ['linux-x64', 'win32-x64', 'darwin-arm64', 'darwin-x64'];

export function assertSupportedTarget(target) {
  if (!SUPPORTED_TARGETS.includes(targetKey(target))) {
    throw new Error(
      `unsupported Claude SDK host target ${targetKey(target)}; expected one of ${SUPPORTED_TARGETS.join(', ')}`
    );
  }
}

/** The SDK's CLI package for `target`: the glibc build on Linux (B-3). */
export function cliPackageName(target) {
  return `${SDK_PACKAGE}-${target.platform}-${target.arch}`;
}

/** The CLI binary, relative to the artifact root (posix). */
export function cliBinaryRel(target) {
  const binary = target.platform === 'win32' ? 'claude.exe' : 'claude';
  return `node_modules/${cliPackageName(target)}/${binary}`;
}

// ---- esbuild -----------------------------------------------------------------

/** host.ts -> host.js: our sources bundled in, every npm package left to node_modules. */
export function hostBuildOptions(repoRoot, outDir) {
  return {
    // Metafile paths are relative to this; checkHostMetafile reads them from the repo root.
    absWorkingDir: repoRoot,
    entryPoints: [path.join(repoRoot, ...CLAUDE_SDK_HOST_SOURCE_REL.split('/'), HOST_ENTRY.entry)],
    outfile: path.join(outDir, HOST_ENTRY.out),
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    target: 'node24',
    sourcemap: false,
    metafile: true,
    logLevel: 'warning',
    banner: {
      js: '// Built by scripts/build-claude-sdk-host.mjs from src/claude-sdk-host/host.ts. Do not edit.',
    },
  };
}

/** host.js took in only `HOST_INPUTS` and leaves only Node built-ins and the SDK to run time. */
export function checkHostMetafile(metafile, repoRoot) {
  const failures = [];
  const inputs = Object.keys(metafile.inputs ?? {}).map((input) =>
    path.relative(repoRoot, path.resolve(repoRoot, input)).split(path.sep).join('/')
  );
  for (const input of inputs) {
    const allowed =
      !input.includes('node_modules/') &&
      HOST_INPUTS.some((prefix) => input.startsWith(prefix)) &&
      !HOST_INPUTS_EXCLUDED.some((part) => input.includes(part));
    if (!allowed) failures.push(`host bundle took in ${input}`);
  }
  const externals = new Set();
  for (const output of Object.values(metafile.outputs ?? {})) {
    for (const item of output.imports ?? []) {
      if (item.external) externals.add(item.path);
    }
  }
  for (const specifier of externals) {
    if (specifier === SDK_PACKAGE || isBuiltin(specifier)) continue;
    failures.push(`host bundle imports ${specifier} at run time`);
  }
  return { failures, inputs, externals: [...externals].sort() };
}

// ---- install -----------------------------------------------------------------

/**
 * `npm ci` for the staged host (B-3): no peers (the SDK's `sdk.mjs` imports Node
 * built-ins only), never `--omit=optional` (the CLI is an optional dependency).
 * `--os/--cpu` only for a foreign target, which is a static rehearsal.
 */
export function npmCiArgs(target, host = { platform: process.platform, arch: process.arch }) {
  const args = ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=peer'];
  if (target.platform !== host.platform || target.arch !== host.arch) {
    args.push(`--os=${target.platform}`, `--cpu=${target.arch}`);
  }
  return args;
}

/**
 * Why `rel` (artifact-relative, posix) is deleted for `target`, or null to keep
 * it. Directories are asked before their contents.
 */
export function pruneReason(rel, kind, target, licenseTexts = new Set()) {
  const parts = rel.split('/');
  const base = parts.at(-1) ?? '';
  if (parts[0] !== 'node_modules') return null;
  // A file a package's `license` field points at (`SEE LICENSE IN README.md`, the SDK's).
  if (licenseTexts.has(rel)) return null;
  if (kind === 'dir' && base === '.bin') return 'npm bin links';
  if (rel === 'node_modules/.package-lock.json') return 'npm hidden lockfile';
  // Only the SDK and the target's CLI stay. `--omit=peer` drops the SDK's peers but
  // npm leaves their own dependencies (express, ajv, ...) behind, unflagged.
  const top = rel.match(/^node_modules\/((?:@[^/]+\/)?[^/@][^/]*)$/);
  if (top && kind === 'dir' && !keptPackages(target).includes(top[1])) {
    return /^@anthropic-ai\/claude-agent-sdk-/.test(top[1])
      ? 'CLI for another platform or libc'
      : 'not used at run time (left by a peer dependency)';
  }
  if (kind === 'dir') return null;
  if (isLicenseFileName(base)) return null;
  if (/\.(d\.[cm]?ts|map)$/i.test(base)) return 'declaration or source map';
  if (isDocumentationMarkdown(rel)) return 'documentation';
  return null;
}

/**
 * Files named by a top-level package's `license: "SEE LICENSE IN <file>"`,
 * artifact-relative: they are the licence text and are never pruned.
 */
export function licenseReferences(root) {
  const kept = new Set();
  const modules = path.join(root, 'node_modules');
  for (const name of topLevelPackages(root)) {
    const manifestFile = path.join(modules, ...name.split('/'), 'package.json');
    if (!fs.existsSync(manifestFile)) continue;
    const license = readJson(manifestFile).license;
    const match = typeof license === 'string' ? license.match(/^SEE LICEN[CS]E IN (.+)$/i) : null;
    if (match) kept.add(`node_modules/${name}/${match[1].trim().replace(/^\.\//, '')}`);
  }
  return kept;
}

/** The packages the artifact keeps: the SDK and the target's CLI. */
export function keptPackages(target) {
  return [SDK_PACKAGE, cliPackageName(target)];
}

/**
 * The SDK as locked must have no dependencies of its own: B-3 keeps only it and
 * its CLI, which holds while its run-time entry imports Node built-ins only. An
 * SDK that gains one fails the build, so the pruning is revisited.
 */
export function checkLockedSdk(lock, pin) {
  const failures = [];
  const entry = lock.packages?.[`node_modules/${SDK_PACKAGE}`];
  if (entry?.version !== pin) {
    failures.push(`package-lock.json resolves ${SDK_PACKAGE}@${entry?.version}, not ${pin}`);
  }
  const deps = Object.keys(entry?.dependencies ?? {});
  if (deps.length > 0) {
    failures.push(`${SDK_PACKAGE}@${entry?.version} now depends on ${deps.join(', ')}; review B-3`);
  }
  return failures;
}

/**
 * The file `import '@anthropic-ai/claude-agent-sdk'` loads: `exports["."]` for an
 * import (`import`, `node` or `default` condition), else `main`.
 */
export function sdkEntryOf(manifest) {
  const pick = (value) => {
    if (typeof value === 'string') return value;
    if (!value || typeof value !== 'object') return undefined;
    return pick(value.import ?? value.node ?? value.default);
  };
  const exported = pick(manifest.exports?.['.'] ?? manifest.exports);
  return (exported ?? manifest.main ?? 'index.js').replace(/^\.\//, '');
}

/**
 * B-3's premise, checked on the installed SDK at build time: the entry host.js
 * loads imports no package at run time, only Node built-ins. esbuild parses the
 * import graph (a text scan of the minified bundle reads strings as imports).
 * Measured on 0.3.300: `sdk.mjs` imports none; `core.mjs`, which host.js never
 * loads, imports zod and the MCP SDK.
 */
export async function checkSdkEntry(outDir, esbuild) {
  const dir = path.join(outDir, 'node_modules', ...SDK_PACKAGE.split('/'));
  const entry = sdkEntryOf(readJson(path.join(dir, 'package.json')));
  const result = await esbuild.build({
    entryPoints: [path.join(dir, ...entry.split('/'))],
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    write: false,
    metafile: true,
    logLevel: 'silent',
  });
  const external = new Set();
  for (const output of Object.values(result.metafile.outputs ?? {})) {
    for (const item of output.imports ?? []) {
      if (item.external && !isBuiltin(item.path)) external.add(item.path);
    }
  }
  return {
    entry,
    failures: [...external]
      .sort()
      .map((spec) => `${SDK_PACKAGE}/${entry} imports ${spec} at run time; review B-3`),
  };
}

/** Delete what `pruneReason` names below `<root>/node_modules`. */
export function pruneTree(root, target) {
  const licenseTexts = licenseReferences(root);
  const removed = [];
  let removedFiles = 0;
  let removedBytes = 0;
  const visit = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const childRel = `${rel}/${entry.name}`;
      const full = path.join(dir, entry.name);
      const kind = entry.isSymbolicLink() ? 'link' : entry.isDirectory() ? 'dir' : 'file';
      const reason = pruneReason(childRel, kind, target, licenseTexts);
      if (reason === null) {
        if (kind === 'dir') visit(full, childRel);
        continue;
      }
      const stats = kind === 'dir' ? treeStats(full) : { files: 1, bytes: fs.lstatSync(full).size };
      removedFiles += stats.files;
      removedBytes += stats.bytes;
      if (kind === 'dir') removed.push({ rel: childRel, reason, ...stats });
      fs.rmSync(full, { recursive: true, force: true });
    }
  };
  const modules = path.join(root, 'node_modules');
  if (fs.existsSync(modules)) {
    visit(modules, 'node_modules');
    for (const entry of fs.readdirSync(modules, { withFileTypes: true })) {
      const full = path.join(modules, entry.name);
      if (entry.isDirectory() && entry.name.startsWith('@') && fs.readdirSync(full).length === 0) {
        fs.rmdirSync(full);
      }
    }
  }
  return { removedDirectories: removed, removedFiles, removedBytes };
}

/** Top-level package names under `<root>/node_modules` (`a`, `@s/b`). */
export function topLevelPackages(root) {
  const modules = path.join(root, 'node_modules');
  if (!fs.existsSync(modules)) return [];
  const names = [];
  for (const entry of fs.readdirSync(modules)) {
    if (entry.startsWith('.')) continue;
    if (entry.startsWith('@')) {
      for (const child of fs.readdirSync(path.join(modules, entry)))
        names.push(`${entry}/${child}`);
    } else names.push(entry);
  }
  return names.sort();
}

// ---- verification ---------------------------------------------------------------

/** Files the artifact must hold for `target`. */
export function requiredFiles(target, { requireManifest = false } = {}) {
  return [
    HOST_ENTRY.out,
    'package.json',
    `node_modules/${SDK_PACKAGE}/package.json`,
    `node_modules/${SDK_PACKAGE}/sdk.mjs`,
    cliBinaryRel(target),
    ...(requireManifest ? [CLAUDE_SDK_HOST_MANIFEST, CLAUDE_SDK_HOST_LICENSES] : []),
  ];
}

function readHead(file, size = 4096) {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(size);
    const read = fs.readSync(fd, buffer, 0, size, 0);
    return buffer.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The checks every copy of the artifact must pass (after the build, after
 * afterPack, in the packaged app): required files, exactly the SDK and the
 * target's CLI installed, a CLI binary for the target (executable off Windows),
 * the budget (B-7), and with `requireManifest` a manifest naming this target
 * and this CLI. Throws with every failure; returns the measurements.
 */
export function verifyClaudeSdkHostArtifact({ outDir, target, requireManifest = false }) {
  const failures = [];
  for (const rel of requiredFiles(target, { requireManifest })) {
    if (!fs.existsSync(path.join(outDir, ...rel.split('/')))) failures.push(`missing ${rel}`);
  }
  const packages = topLevelPackages(outDir);
  const expected = [SDK_PACKAGE, cliPackageName(target)].sort();
  if (packages.join(',') !== expected.join(',')) {
    failures.push(
      `node_modules holds ${packages.join(', ') || 'nothing'}; expected ${expected.join(', ')}`
    );
  }
  const cliRel = cliBinaryRel(target);
  const cliFile = path.join(outDir, ...cliRel.split('/'));
  let cli = null;
  if (fs.existsSync(cliFile)) {
    const detected = binaryFormat(readHead(cliFile));
    if (!binaryMatchesTarget(detected, target)) {
      failures.push(
        `${cliRel} is ${detected ? `${detected.format} ${detected.arch}` : 'not a binary'}, not for ${targetKey(target)}`
      );
    }
    // A Windows filesystem keeps no execute bit: a foreign rehearsal built there is
    // checked on its own runner (afterPack, verify-packaged-app).
    if (
      target.platform !== 'win32' &&
      process.platform !== 'win32' &&
      (fs.statSync(cliFile).mode & 0o111) === 0
    ) {
      failures.push(`${cliRel} has no execute bit`);
    }
    cli = { rel: cliRel, bytes: fs.statSync(cliFile).size, sha256: sha256File(cliFile) };
  }
  const stats = treeStats(outDir);
  const budget = evaluateClaudeSdkHostArtifact(stats);
  if (budget.status !== 'ok') {
    failures.push(
      `over budget (${budget.reasons.join(', ')}): ${stats.bytes} bytes / ${stats.files} files, ceiling ${budget.ceiling.bytes} / ${budget.ceiling.files}`
    );
  }
  if (requireManifest && fs.existsSync(path.join(outDir, CLAUDE_SDK_HOST_MANIFEST))) {
    const manifest = readJson(path.join(outDir, CLAUDE_SDK_HOST_MANIFEST));
    const built = `${manifest.target?.platform}-${manifest.target?.arch}`;
    if (built !== targetKey(target))
      failures.push(`manifest names ${built}, not ${targetKey(target)}`);
    if (manifest.cli?.rel !== cliRel) failures.push(`manifest names CLI ${manifest.cli?.rel}`);
    if (cli && manifest.cli?.sha256 !== cli.sha256)
      failures.push('the CLI does not match the manifest');
  }
  if (failures.length > 0) {
    throw new Error(`Claude SDK host artifact at ${outDir}:\n  - ${failures.join('\n  - ')}`);
  }
  return { ...stats, packages, cli, budget };
}

/** The manifest (B-8). */
export function buildManifest({
  target,
  appVersion,
  sdkVersion,
  cliPackage,
  cliVersion,
  cli,
  gitCommit,
  builtOn,
  builtAt,
  lockSha256,
  stats,
  packages,
  pruned,
}) {
  return {
    schema: CLAUDE_SDK_MANIFEST_SCHEMA,
    target,
    appVersion,
    sdk: { name: SDK_PACKAGE, version: sdkVersion },
    cli: {
      package: cliPackage,
      version: cliVersion,
      rel: cli.rel,
      bytes: cli.bytes,
      sha256: cli.sha256,
    },
    gitCommit,
    builtOn,
    builtAt,
    lockSha256,
    bytes: stats.bytes,
    files: stats.files,
    longestRelativePath: stats.longestRelativePath,
    packages,
    pruned,
  };
}

/** One entry per installed package, for THIRD_PARTY_LICENSES.json; every one names a licence. */
export function licensesOf(root) {
  const packages = collectLicenses(root);
  const failures = packages
    .filter((item) => item.license === null)
    .map((item) => `${item.path} has no license field`);
  return { packages, failures };
}

/** Every regular file below `root`, for callers that rewrite them (afterPack's TSD fix). */
export function artifactFiles(root) {
  return walkTree(root).filter((entry) => entry.kind === 'file');
}
