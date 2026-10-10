/**
 * DSH host artifact rules (dsh-rebase P1-2).
 *
 * scripts/build-dsh-host.mjs applies them to produce out-dsh-host/, afterPack
 * copies that directory to resources/dsh-host, and verify-packaged-app.mjs runs
 * `verifyDshArtifact` again on the packaged copy. Decisions: 011 (the host
 * ships as a build artifact), 013 (clean `npm ci`, deletion pruning,
 * verification), 014 (B-tier pruning and the size budget), 058 (allowlisted
 * plugins are preinstalled; pnpm no longer ships, closing 016), 059 (the
 * build-time plugin audit).
 *
 * Pruning is deletion-based on purpose: every rule names what goes, everything
 * else stays. A mistake shows up as bytes too many (caught by the budget and
 * the foreign-binary check), never as a package silently left out — the
 * failure mode of the agent-host allowlist walker, which asks about a package
 * directory before its files and skips the whole package when only file paths
 * were answered.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  auditBundlePatches,
  checkAllowlistKeys,
  lockPathName,
  parseAllowlist,
  patchRowIds,
} from '../src/shared/dshPluginAllowlist.ts';
import {
  DSH_HOST_ARTIFACT_MAX_BYTES,
  DSH_HOST_ARTIFACT_MAX_FILES,
  DSH_HOST_ARTIFACT_TARGET_BYTES,
  evaluateDshPlugin,
} from './packaging-budget.mjs';

export const DSH_HOST_SOURCE_REL = 'src/dsh-host';
export const DSH_HOST_OUT_REL = 'out-dsh-host';
export const DSH_HOST_MANIFEST = 'dsh-host-manifest.json';
export const DSH_HOST_LICENSES = 'THIRD_PARTY_LICENSES.json';
export const PRODUCT_BUNDLE = '@aiclient/dsh-app';
export const PROBE_BUNDLE = '@aiclient/dsh-probe';
export const MANIFEST_SCHEMA = 1;
/** The plugin allowlist, relative to src/dsh-host (decision 059). */
export const PLUGIN_ALLOWLIST_REL = 'plugins/allowlist.json';

/**
 * Host dependencies that are not plugins (P1-2, P1-6b). Every other entry of
 * src/dsh-host/package.json must be on the plugin allowlist (decision 059).
 * P1-4d3 (decision 114): dsh-tool-ask-user is a plain DSH plugin, not a
 * bundle, so the allowlist cannot carry it; the product bundle mounts it as a
 * row of its own, at the DSH pin like every `@deepseek-ai/dsh-*` here.
 */
export const HOST_DEPENDENCIES = [
  PRODUCT_BUNDLE,
  '@deepseek-ai/cordis',
  '@deepseek-ai/cordis-plugin-group',
  '@deepseek-ai/cordis-plugin-include',
  '@deepseek-ai/cordis-plugin-loader',
  '@deepseek-ai/dsh-app-boot',
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-home-paths',
  '@deepseek-ai/dsh-launch-environment',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-tool-ask-user',
  'tree-sitter-bash',
  'web-tree-sitter',
];

/** Source files staged next to the install; the bundle's own files are listed below. */
export const STAGED_SOURCE_FILES = ['package.json', 'package-lock.json', '.npmrc'];

/**
 * Every file of `src/dsh-host/bundle/` must be either copied as is or produced
 * by esbuild; staging refuses an unknown file instead of dropping it.
 */
export const STAGED_BUNDLE_FILES = ['package.json', 'cordis.patch.yml', 'lib/index.js'];
export const HOST_ENTRY = { entry: 'host.ts', out: 'host.js' };
/**
 * Our own sources host.js may take in (P1-3a: its pure rules in lib/; P1-10b:
 * the plugin allowlist library and the Main/host plugin contract it applies
 * at every start; decision 171: the User-Agent check and relay header name
 * the fetch wrapper shares with Main; decision 173: the request scope names
 * and types the fetch wrapper shares with the bridge and Main); everything
 * else stays external.
 */
export const HOST_INPUTS = [
  'src/dsh-host/host.ts',
  'src/dsh-host/lib/',
  'src/shared/dshPluginAllowlist.ts',
  'src/shared/dshPlugins.ts',
  'src/shared/types/requestScope.ts',
  'src/shared/types/requestUserAgent.ts',
];
/** npm packages host.js imports at run time, from the artifact's node_modules. */
export const HOST_EXTERNALS = ['@deepseek-ai/dsh-app-boot', '@deepseek-ai/dsh-launch-environment'];
/**
 * npm packages the bridge row may import at run time; everything else must be
 * bundled. P1-5a: `installModelSelection` routes each turn (dsh-agent).
 */
export const BRIDGE_EXTERNALS = ['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-agent'];

/**
 * The product bundle's own rows, each an esbuild bundle of our TypeScript:
 * the shared host's only bridge (P1-3a, decision 019), the permission gate
 * (P1-6b, decision 042), the loop guard (P1-8, decisions 065 and 066), the
 * read-only credentials provider (P1-5b, decision 034) and the encrypted-read
 * fallback (P1-13c, decision 091). `inputs` are the source prefixes a row may
 * take in, `externals` the npm packages it may import at run time.
 */
export const BRIDGE_ENTRIES = [
  {
    entry: 'bridge/plugin.ts',
    out: 'bundle/lib/bridge.js',
    row: 'aiclient-bridge',
    // The RPC server Main's channels speak to lives in bridge/ since dsh-rebase
    // P1-12 step 4 (decision 147), when src/agent-host was deleted.
    inputs: ['src/dsh-host/bridge/', 'src/shared/'],
    externals: BRIDGE_EXTERNALS,
  },
  {
    entry: 'permissions/plugin.ts',
    out: 'bundle/lib/permissions.js',
    row: 'aiclient-permissions',
    // The pure library (src/shared/permissions, which since dsh-rebase P1-12
    // step 3 also holds the bundled policy table it reads) and the loop
    // guard's import-free constants (decision 081 rule 2).
    inputs: ['src/dsh-host/permissions/', 'src/shared/', 'src/dsh-host/loopGuard/constants.ts'],
    // Loaded on the first bash call; its wasm and the bash grammar's resolve beside it.
    externals: ['web-tree-sitter'],
  },
  {
    entry: 'loopGuard/plugin.ts',
    out: 'bundle/lib/loop-guard.js',
    row: 'aiclient-loop-guard',
    inputs: ['src/dsh-host/loopGuard/'],
    // isAgentLoopRequest reads a registry private to the host's own dsh-llm.
    externals: ['@deepseek-ai/dsh-llm'],
  },
  {
    entry: 'credentials/plugin.ts',
    out: 'bundle/lib/credentials.js',
    row: 'aiclient-credentials',
    // The repo's one key-shape rule set masks keys in provider failure text.
    inputs: ['src/dsh-host/credentials/', 'src/shared/stderrRedaction.ts'],
    // Its service class extends the abstract `ctx.credentials` seam.
    externals: ['@deepseek-ai/dsh-credentials'],
  },
  {
    entry: 'encryptedRead/plugin.ts',
    out: 'bundle/lib/encrypted-read.js',
    row: 'aiclient-encrypted-read',
    inputs: ['src/dsh-host/encryptedRead/'],
    // FsError must stay the host's own class: dsh-tool-fs routes failures by
    // `instanceof FsError`, and a bundled twin would break that (P1-13c).
    externals: ['@deepseek-ai/dsh-fs'],
  },
];

/** The artifact budget (decision 014). The target is reported, the ceilings fail the build. */
export const DSH_HOST_BUDGET = {
  maxBytes: DSH_HOST_ARTIFACT_MAX_BYTES,
  maxFiles: DSH_HOST_ARTIFACT_MAX_FILES,
  targetBytes: DSH_HOST_ARTIFACT_TARGET_BYTES,
};

export const SUPPORTED_TARGETS = ['linux-x64', 'win32-x64', 'darwin-arm64', 'darwin-x64'];

export function targetKey(target) {
  return `${target.platform}-${target.arch}`;
}

export function assertSupportedTarget(target) {
  if (!SUPPORTED_TARGETS.includes(targetKey(target))) {
    throw new Error(
      `unsupported DSH host target ${targetKey(target)}; expected one of ${SUPPORTED_TARGETS.join(', ')}`
    );
  }
}

// ---- small fs helpers --------------------------------------------------------

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Posix-style relative paths of every entry below `root` (files, links and directories). */
export function walkTree(root) {
  const entries = [];
  const visit = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) entries.push({ rel: childRel, full, kind: 'link' });
      else if (entry.isDirectory()) {
        entries.push({ rel: childRel, full, kind: 'dir' });
        visit(full, childRel);
      } else entries.push({ rel: childRel, full, kind: 'file' });
    }
  };
  if (fs.existsSync(root)) visit(root, '');
  return entries;
}

/** Files, bytes and the longest relative path of a tree; `exclude` is a set of relative paths. */
export function treeStats(root, exclude = new Set()) {
  let files = 0;
  let bytes = 0;
  let longest = '';
  for (const entry of walkTree(root)) {
    if (entry.kind === 'dir' || exclude.has(entry.rel)) continue;
    files += 1;
    bytes += fs.lstatSync(entry.full).size;
    if (entry.rel.length > longest.length) longest = entry.rel;
  }
  return { files, bytes, longestRelativePath: longest.length, longestPath: longest };
}

// ---- preflight ---------------------------------------------------------------

/**
 * Source-side checks before anything is built: exact pins, the committed
 * lockfile, one DSH version everywhere, a bundle peer that matches it (DSH
 * refuses a bundle whose dsh peer does not match the running version), and
 * the plugin allowlist against package.json and the lockfile (decision 059).
 */
export function preflightDshHost(sourceDir) {
  const failures = [];
  const manifest = readJson(path.join(sourceDir, 'package.json'));
  const lockPath = path.join(sourceDir, 'package-lock.json');
  if (!fs.existsSync(lockPath)) failures.push('src/dsh-host/package-lock.json is missing');
  const allowlistPath = path.join(sourceDir, ...PLUGIN_ALLOWLIST_REL.split('/'));
  let allowlist = { schema: 1, plugins: [] };
  let closures = {};
  if (!fs.existsSync(allowlistPath))
    failures.push(`src/dsh-host/${PLUGIN_ALLOWLIST_REL} is missing`);
  else {
    const parsed = parseAllowlist(readJson(allowlistPath));
    allowlist = parsed.allowlist;
    failures.push(...parsed.failures.map((failure) => `allowlist: ${failure}`));
    for (const entry of allowlist.plugins) {
      const record = path.join(path.dirname(allowlistPath), ...entry.review.record.split('/'));
      if (!fs.existsSync(record)) {
        failures.push(`allowlist: ${entry.name} review record ${entry.review.record} is missing`);
      }
    }
  }
  const deps = manifest.dependencies ?? {};
  for (const [name, spec] of Object.entries(deps)) {
    if (name === PRODUCT_BUNDLE) {
      if (spec !== 'file:./bundle') failures.push(`${name} must be "file:./bundle", got "${spec}"`);
      continue;
    }
    if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(String(spec))) {
      failures.push(`${name} must be an exact version, got "${spec}"`);
    }
  }
  const dshPin = deps['@deepseek-ai/dsh-base'];
  if (!dshPin) failures.push('@deepseek-ai/dsh-base is not a dependency');
  for (const [name, spec] of Object.entries(deps)) {
    if (name.startsWith('@deepseek-ai/dsh-') && spec !== dshPin) {
      failures.push(`${name} ${spec} differs from the DSH pin ${dshPin}`);
    }
  }
  if (fs.existsSync(lockPath)) {
    const lock = readJson(lockPath);
    const drift = Object.entries(lock.packages ?? {})
      .filter(([rel]) => /(^|\/)node_modules\/@deepseek-ai\/dsh-[^/]+$/.test(rel))
      .filter(([, entry]) => entry.version !== dshPin)
      .map(([rel, entry]) => `${rel}@${entry.version}`);
    if (drift.length > 0) failures.push(`lockfile DSH packages off the pin: ${drift.join(', ')}`);
    const lockRoot = lock.packages?.['']?.dependencies ?? {};
    for (const [name, spec] of Object.entries(deps)) {
      if (lockRoot[name] !== spec) failures.push(`lockfile root is stale for ${name}`);
    }
    const keys = checkAllowlistKeys({
      allowlist,
      manifest,
      lock,
      hostDependencies: HOST_DEPENDENCIES,
      dshPin,
    });
    failures.push(...keys.failures.map((failure) => `allowlist: ${failure}`));
    closures = keys.closures;
  }
  const bundle = readJson(path.join(sourceDir, 'bundle', 'package.json'));
  const peer = bundle.peerDependencies?.['@deepseek-ai/dsh-llm'];
  if (peer !== dshPin) {
    failures.push(`bundle peer @deepseek-ai/dsh-llm is "${peer}", expected the DSH pin ${dshPin}`);
  }
  if (bundle.name !== PRODUCT_BUNDLE) failures.push(`bundle is named ${bundle.name}`);
  if (failures.length > 0) {
    throw new Error(`DSH host preflight failed:\n  - ${failures.join('\n  - ')}`);
  }
  return { dshPin, version: manifest.version, allowlist, closures };
}

/** Bundle files staging knows about; anything else in `bundle/` is an error. */
export function unknownBundleFiles(sourceDir) {
  const known = new Set([
    ...STAGED_BUNDLE_FILES,
    ...BRIDGE_ENTRIES.map((item) => item.out.slice('bundle/'.length)),
  ]);
  return walkTree(path.join(sourceDir, 'bundle'))
    .filter((entry) => entry.kind !== 'dir' && !entry.rel.split('/').includes('node_modules'))
    .map((entry) => entry.rel)
    .filter((rel) => !known.has(rel));
}

// ---- esbuild ---------------------------------------------------------------

/**
 * host.ts -> host.js: its own `lib/` modules bundled in, every npm package left
 * to resolve from the artifact's node_modules.
 */
export function hostBuildOptions(sourceDir, outDir) {
  return {
    // Metafile paths are relative to this; checkHostMetafile reads them from the repo root.
    absWorkingDir: path.resolve(sourceDir, '..', '..'),
    entryPoints: [path.join(sourceDir, HOST_ENTRY.entry)],
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
      js: '// Built by scripts/build-dsh-host.mjs from src/dsh-host/host.ts. Do not edit.',
    },
  };
}

/** One bridge row: our TypeScript bundled in, every npm package left to DSH's resolution. */
export function bridgeBuildOptions(sourceDir, outDir, item) {
  return {
    // Metafile paths are relative to this; checkBridgeMetafile reads them from the repo root.
    absWorkingDir: path.resolve(sourceDir, '..', '..'),
    entryPoints: [path.join(sourceDir, item.entry)],
    outfile: path.join(outDir, item.out),
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    target: 'node24',
    sourcemap: false,
    metafile: true,
    logLevel: 'warning',
    banner: {
      js: `// Built by scripts/build-dsh-host.mjs from src/dsh-host/${item.entry}. Do not edit.`,
    },
  };
}

/**
 * What a row bundle took in and left out: inputs must be the entry's own
 * sources (`item.inputs`), imports left external must be Node built-ins or
 * `item.externals`. Defaults to the bridge row.
 */
export function checkBridgeMetafile(metafile, repoRoot, item = BRIDGE_ENTRIES[0]) {
  return checkMetafile('bridge bundle', metafile, repoRoot, item.inputs, item.externals);
}

/** host.js: host.ts and its lib/ taken in, only `HOST_EXTERNALS` left to npm. */
export function checkHostMetafile(metafile, repoRoot) {
  return checkMetafile('host bundle', metafile, repoRoot, HOST_INPUTS, HOST_EXTERNALS);
}

function checkMetafile(label, metafile, repoRoot, allowedInputs, allowedExternals) {
  const failures = [];
  const inputs = Object.keys(metafile.inputs ?? {}).map((input) =>
    path.relative(repoRoot, path.resolve(repoRoot, input)).split(path.sep).join('/')
  );
  for (const input of inputs) {
    if (
      input.includes('node_modules/') ||
      !allowedInputs.some((prefix) => input.startsWith(prefix))
    ) {
      failures.push(`${label} took in ${input}`);
    }
  }
  const externals = new Set();
  for (const output of Object.values(metafile.outputs ?? {})) {
    for (const item of output.imports ?? []) {
      if (item.external) externals.add(item.path);
    }
  }
  for (const specifier of externals) {
    if (specifier.startsWith('node:')) continue;
    if (!allowedExternals.includes(specifier)) {
      failures.push(`${label} imports ${specifier} at run time`);
    }
  }
  return { failures, inputs, externals: [...externals].sort() };
}

// ---- install -----------------------------------------------------------------

/**
 * `npm ci` for the staged host. Never `--omit=optional`: every platform binary
 * is an optional dependency (decision 013). `--os/--cpu` only when the target
 * is not this machine, which is a static rehearsal, never a shipping build.
 */
export function npmCiArgs(target, host = { platform: process.platform, arch: process.arch }) {
  const args = ['ci', '--ignore-scripts', '--no-audit', '--no-fund'];
  if (target.platform !== host.platform || target.arch !== host.arch) {
    args.push(`--os=${target.platform}`, `--cpu=${target.arch}`);
  }
  return args;
}

/** Top-level package directory names of a node_modules directory (`a`, `@s/b`). */
function topLevelNames(modules) {
  if (!fs.existsSync(modules)) return [];
  const names = [];
  for (const entry of fs.readdirSync(modules)) {
    if (entry.startsWith('.')) continue;
    if (entry.startsWith('@')) {
      for (const child of fs.readdirSync(path.join(modules, entry)))
        names.push(`${entry}/${child}`);
    } else names.push(entry);
  }
  return names;
}

function removeLink(link) {
  try {
    fs.unlinkSync(link);
  } catch {
    // A Windows directory junction.
    fs.rmdirSync(link);
  }
}

/**
 * Replace the `file:` links npm leaves under node_modules (npm 10 and 11 both
 * link `file:./bundle`) with real copies of their targets. A link that leaves
 * the staging directory is an error.
 */
export function materializeLinks(stageDir) {
  const modules = path.join(stageDir, 'node_modules');
  const stageReal = fs.realpathSync(stageDir);
  const materialized = [];
  for (const name of topLevelNames(modules)) {
    const link = path.join(modules, ...name.split('/'));
    if (!fs.lstatSync(link).isSymbolicLink()) continue;
    const target = fs.realpathSync(link);
    if (target !== stageReal && !target.startsWith(`${stageReal}${path.sep}`)) {
      throw new Error(`node_modules/${name} links outside the staging directory: ${target}`);
    }
    removeLink(link);
    fs.cpSync(target, link, {
      recursive: true,
      filter: (source) => !path.relative(target, source).split(path.sep).includes('node_modules'),
    });
    materialized.push({ name, from: path.relative(stageReal, target).split(path.sep).join('/') });
  }
  return materialized;
}

// ---- pruning (decision 014, B tier) ----------------------------------------------

const LICENSE_NAME = /^(licen[cs]e|copying|notice|unlicense|copyright)([._-][^/]*)?$/i;
// `notice.d.ts`, `license.js`: code named after a licence, not a licence text.
const CODE_EXTENSION = /\.(c?js|mjs|[cm]?ts|json|map|node)$/i;
const DOC_MARKDOWN_NAME =
  /^(readme|changelog|changes|history|contributing|security|code[_-]of[_-]conduct|upgrading|upgrade|migrating|migration|release[_-]notes|authors|contributors|funding|support|governance|maintainers|api)([._-][^/]*)?\.(md|markdown)$/i;
const NATIVE_SOURCE = /\.(c|cc|cpp|cxx|h|hh|hpp|hxx|s|S|asm|gyp|gypi)$/;
const STRIPPED_EXTENSION = /\.(map|d\.ts|d\.mts|d\.cts|tsbuildinfo|pdb)$/i;

export function isLicenseFileName(base) {
  return LICENSE_NAME.test(base) && !CODE_EXTENSION.test(base);
}

/** Whether `rel` is a package directory (`…node_modules/a` or `…node_modules/@s/b`). */
function isPackageDir(rel) {
  return /(^|\/)node_modules\/(@[^/]+\/)?[^/@][^/]*$/.test(rel);
}

/**
 * Documentation Markdown only: README / CHANGELOG-style names or anything under
 * a `doc` / `docs` directory. Other Markdown may be a runtime asset
 * (@deepseek-ai/dsh-skill-badge reads assets/dsh-badge.md), so it stays.
 * Licence texts stay, and so does the libvips README, which lists the bundled
 * libraries and their licences (decision 013).
 */
export function isDocumentationMarkdown(rel) {
  const parts = rel.split('/');
  const base = parts.at(-1) ?? '';
  if (!/\.(md|markdown)$/i.test(base) || isLicenseFileName(base)) return false;
  if (/node_modules\/@img\/sharp-libvips-[^/]+\/README\.md$/i.test(rel)) return false;
  if (DOC_MARKDOWN_NAME.test(base)) return true;
  return parts.slice(0, -1).some((part) => part === 'doc' || part === 'docs');
}

function sharpVariantOf(name) {
  const match = name.match(/^@img\/sharp-(?:libvips-)?(.+)$/);
  if (!match || name === '@img/sharp-libvips-dev') return null;
  return match[1];
}

/**
 * Why `rel` (relative to the artifact root, posix) is deleted for `target`, or
 * null to keep it. Asked for directories before their contents; a directory
 * answer covers everything below it.
 */
export function pruneReason(rel, kind, target) {
  const parts = rel.split('/');
  const base = parts.at(-1) ?? '';
  if (parts[0] !== 'node_modules') return null;
  const key = targetKey(target);

  if (kind === 'dir' && base === '.bin') return 'npm bin links';
  if (rel === 'node_modules/.package-lock.json') return 'npm hidden lockfile';

  // A package that carries every platform in one tarball.
  let match = rel.match(/(^|\/)node_modules\/node-pty\/prebuilds\/([^/]+)$/);
  if (match && kind === 'dir' && match[2] !== key) return 'node-pty prebuild for another platform';
  if (/(^|\/)node_modules\/node-pty\/third_party$/.test(rel) && target.platform !== 'win32') {
    return 'node-pty conpty payload (Windows only)';
  }
  match = rel.match(/(^|\/)node_modules\/node-pty\/third_party\/conpty\/[^/]+\/([^/]+)$/);
  if (match && kind === 'dir' && match[2] !== `win10-${target.arch}`) {
    return 'node-pty conpty payload for another architecture';
  }
  if (/(^|\/)node_modules\/node-pty\/(src|deps)$/.test(rel) && kind === 'dir') {
    return 'node-pty native sources';
  }

  // Package-level variants npm installs regardless of platform or libc.
  match = rel.match(/(^|\/)node_modules\/(@img\/[^/]+)$/);
  if (match && kind === 'dir') {
    const variant = sharpVariantOf(match[2]);
    if (variant !== null && variant !== key) return `sharp variant ${variant}`;
  }
  if (/(^|\/)node_modules\/@emnapi$/.test(rel) && kind === 'dir') return 'wasm32 runtime';
  if (/(^|\/)node_modules\/@deepseek-ai\/node-addon-system-linux-[^/]+\/bin\/musl$/.test(rel)) {
    return 'node-addon-system musl build';
  }
  if (/(^|\/)node_modules\/@koromix\/koffi-linux-[^/]+\/musl_[^/]+$/.test(rel) && kind === 'dir') {
    return 'koffi musl build';
  }
  // P1-6b: the permission row loads the bash grammar's wasm, never its native binding.
  if (/(^|\/)node_modules\/tree-sitter-bash\/(prebuilds|src)$/.test(rel) && kind === 'dir') {
    return 'tree-sitter-bash native binding (the wasm grammar is used)';
  }
  if (/(^|\/)node_modules\/web-tree-sitter\/debug$/.test(rel) && kind === 'dir') {
    return 'web-tree-sitter debug build';
  }

  if (kind === 'dir') return null;
  if (isLicenseFileName(base)) return null;
  if (STRIPPED_EXTENSION.test(base)) return 'source map, declaration or debug symbols';
  if (isDocumentationMarkdown(rel)) return 'documentation';
  // C / C++ sources and gyp files.
  if (NATIVE_SOURCE.test(base)) return 'native sources';
  return null;
}

/** Delete what `pruneReason` names below `<root>/node_modules`; directories are asked first. */
export function pruneTree(root, target) {
  const removed = [];
  let removedFiles = 0;
  let removedBytes = 0;
  const visit = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const childRel = `${rel}/${entry.name}`;
      const full = path.join(dir, entry.name);
      const kind = entry.isSymbolicLink() ? 'link' : entry.isDirectory() ? 'dir' : 'file';
      const reason = pruneReason(childRel, kind, target);
      if (reason === null) {
        if (kind === 'dir') visit(full, childRel);
        continue;
      }
      const stats = kind === 'dir' ? treeStats(full) : { files: 1, bytes: fs.lstatSync(full).size };
      removedFiles += stats.files;
      removedBytes += stats.bytes;
      if (kind === 'dir')
        removed.push({ rel: childRel, reason, files: stats.files, bytes: stats.bytes });
      fs.rmSync(full, { recursive: true, force: true });
    }
  };
  const modules = path.join(root, 'node_modules');
  if (fs.existsSync(modules)) visit(modules, 'node_modules');
  return { removedDirectories: removed, removedFiles, removedBytes };
}

// ---- executable bits ---------------------------------------------------------

/** Files that must keep an execute bit, per target (no-op on Windows). */
export function executablePaths(target) {
  const key = targetKey(target);
  if (target.platform === 'linux') {
    return [
      `node_modules/@vscode/ripgrep-${key}/bin/rg`,
      `node_modules/@deepseek-ai/node-addon-system-${key}/bin/landlock-run`,
    ];
  }
  if (target.platform === 'darwin') {
    return [
      `node_modules/@vscode/ripgrep-${key}/bin/rg`,
      // dsh-subprocess-local's postinstall sets it; --ignore-scripts skips that (decision 013).
      `node_modules/node-pty/prebuilds/${key}/spawn-helper`,
    ];
  }
  return [];
}

/** darwin: `spawn-helper` gets 0755 because the install script that sets it never runs. */
export function fixExecutableBits(root, target) {
  const fixed = [];
  if (target.platform !== 'darwin') return fixed;
  const helper = path.join(
    root,
    'node_modules',
    'node-pty',
    'prebuilds',
    targetKey(target),
    'spawn-helper'
  );
  if (fs.existsSync(helper)) {
    fs.chmodSync(helper, 0o755);
    fixed.push(path.relative(root, helper).split(path.sep).join('/'));
  }
  return fixed;
}

// ---- binaries ----------------------------------------------------------------

const PE_MACHINES = { 34404: 'x64', 43620: 'arm64', 332: 'ia32' };
const ELF_MACHINES = { 62: 'x64', 183: 'arm64', 3: 'ia32', 40: 'arm' };
const MACHO_CPUS = { 16777223: 'x64', 16777228: 'arm64', 7: 'ia32', 12: 'arm' };
const NATIVE_EXTENSION = /\.(node|dll|exe|so|dylib)$|\.so\.\d[\d.]*$/i;

/** Executable format and architecture from the header bytes, or null when not a binary. */
export function binaryFormat(bytes) {
  if (bytes.length >= 64 && bytes[0] === 0x4d && bytes[1] === 0x5a) {
    const pe = bytes.readUInt32LE(0x3c);
    if (pe + 26 > bytes.length || bytes.toString('latin1', pe, pe + 4) !== 'PE\0\0') return null;
    const machine = bytes.readUInt16LE(pe + 4);
    const magic = bytes.readUInt16LE(pe + 24);
    return {
      format: magic === 0x20b ? 'PE32+' : 'PE32',
      arch: PE_MACHINES[machine] ?? `0x${machine.toString(16)}`,
    };
  }
  if (bytes.length >= 20 && bytes.toString('latin1', 0, 4) === '\x7fELF') {
    const little = bytes[5] === 1;
    const machine = little ? bytes.readUInt16LE(18) : bytes.readUInt16BE(18);
    return {
      format: bytes[4] === 2 ? 'ELF64' : 'ELF32',
      arch: ELF_MACHINES[machine] ?? `0x${machine.toString(16)}`,
    };
  }
  if (bytes.length >= 8) {
    const be = bytes.readUInt32BE(0);
    if (be === 0xcffaedfe || be === 0xcefaedfe) {
      const cpu = bytes.readUInt32LE(4);
      return {
        format: be === 0xcffaedfe ? 'Mach-O 64' : 'Mach-O',
        arch: MACHO_CPUS[cpu] ?? `0x${cpu.toString(16)}`,
      };
    }
    if (be === 0xcafebabe) {
      const count = bytes.readUInt32BE(4);
      // Java class files share the magic; their minor/major version is never this small.
      if (count === 0 || count > 16 || bytes.length < 8 + count * 20) return null;
      const arches = [];
      for (let i = 0; i < count; i += 1) {
        const cpu = bytes.readUInt32BE(8 + i * 20);
        arches.push(MACHO_CPUS[cpu] ?? `0x${cpu.toString(16)}`);
      }
      return { format: 'Mach-O universal', arch: arches.join('+'), arches };
    }
  }
  return null;
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

/** Whether a detected binary runs on `target`. */
export function binaryMatchesTarget(detected, target) {
  if (detected === null) return false;
  if (target.platform === 'win32')
    return detected.format === 'PE32+' && detected.arch === target.arch;
  if (target.platform === 'linux')
    return detected.format === 'ELF64' && detected.arch === target.arch;
  if (target.platform === 'darwin') {
    if (detected.format === 'Mach-O 64') return detected.arch === target.arch;
    if (detected.format === 'Mach-O universal') return detected.arches.includes(target.arch);
  }
  return false;
}

/** Every binary in the tree: by native extension, or by header for extensionless executables. */
export function scanBinaries(root) {
  const binaries = [];
  for (const entry of walkTree(root)) {
    if (entry.kind !== 'file') continue;
    const byExtension = NATIVE_EXTENSION.test(entry.rel);
    const detected = binaryFormat(readHead(entry.full));
    if (!byExtension && detected === null) continue;
    binaries.push({ rel: entry.rel, full: entry.full, detected, byExtension });
  }
  return binaries;
}

/** Natives each target must ship; patterns are over artifact-relative posix paths. */
export function requiredNatives(target) {
  const key = targetKey(target);
  const esc = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const k = esc(key);
  const narb = { linux: `${k}-gnu`, win32: `${k}-msvc`, darwin: k }[target.platform];
  const common = [
    [
      'node-addon-require-builtin',
      new RegExp(`^node_modules/node-addon-require-builtin-${narb}/.+\\.node$`),
    ],
    ['koffi', new RegExp(`^node_modules/@koromix/koffi-${k}/.*koffi\\.node$`)],
    ['ripgrep', new RegExp(`^node_modules/@vscode/ripgrep-${k}/bin/rg(\\.exe)?$`)],
    ['sharp', new RegExp(`^node_modules/@img/sharp-${k}/lib/sharp-${k}[^/]*\\.node$`)],
  ];
  if (target.platform === 'win32') {
    return [
      ...common,
      ['node-pty conpty', new RegExp(`^node_modules/node-pty/prebuilds/${k}/conpty\\.node$`)],
      [
        'node-pty console list',
        new RegExp(`^node_modules/node-pty/prebuilds/${k}/conpty_console_list\\.node$`),
      ],
      [
        'node-pty OpenConsole',
        new RegExp(`^node_modules/node-pty/prebuilds/${k}/conpty/OpenConsole\\.exe$`),
      ],
      [
        'node-pty conpty.dll',
        new RegExp(`^node_modules/node-pty/prebuilds/${k}/conpty/conpty\\.dll$`),
      ],
      ['libvips', new RegExp(`^node_modules/@img/sharp-${k}/lib/libvips[^/]*\\.dll$`)],
    ];
  }
  const shared = [
    ...common,
    ['node-pty', new RegExp(`^node_modules/node-pty/prebuilds/${k}/pty\\.node$`)],
    [
      'node-addon-system',
      new RegExp(`^node_modules/@deepseek-ai/node-addon-system-${k}/.*system\\.node$`),
    ],
  ];
  if (target.platform === 'linux') {
    return [
      ...shared,
      [
        'landlock-run',
        new RegExp(`^node_modules/@deepseek-ai/node-addon-system-${k}/bin/landlock-run$`),
      ],
      ['libvips', new RegExp(`^node_modules/@img/sharp-libvips-${k}/lib/libvips-cpp\\.so[^/]*$`)],
    ];
  }
  return [
    ...shared,
    ['node-pty spawn-helper', new RegExp(`^node_modules/node-pty/prebuilds/${k}/spawn-helper$`)],
    ['libvips', new RegExp(`^node_modules/@img/sharp-libvips-${k}/lib/libvips-cpp[^/]*\\.dylib$`)],
  ];
}

// ---- licences ----------------------------------------------------------------

/** Packages whose licence text must travel with the artifact (licenses shard §3). */
export const LICENSE_FILE_REQUIRED = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/cordis',
  'koffi',
  'node-pty',
  'sharp',
  '@vscode/ripgrep',
  'web-tree-sitter',
  'tree-sitter-bash',
];

function licenseOf(manifest) {
  if (typeof manifest.license === 'string') return manifest.license;
  if (manifest.license && typeof manifest.license.type === 'string') return manifest.license.type;
  if (Array.isArray(manifest.licenses)) {
    const names = manifest.licenses
      .map((item) => (typeof item === 'string' ? item : item?.type))
      .filter(Boolean);
    if (names.length > 0) return `(${names.join(' OR ')})`;
  }
  return null;
}

/**
 * One entry per installed package of the final tree (nested node_modules
 * included): name, version, the `license` field, and its licence files.
 */
export function collectLicenses(root) {
  const packages = [];
  for (const entry of walkTree(path.join(root, 'node_modules'))) {
    if (entry.kind !== 'file' || !entry.rel.endsWith('package.json')) continue;
    const dirRel = entry.rel.split('/').slice(0, -1).join('/');
    const rel = `node_modules/${dirRel}`;
    if (!isPackageDir(rel)) continue;
    let manifest;
    try {
      manifest = readJson(entry.full);
    } catch {
      continue;
    }
    if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') continue;
    const dir = path.dirname(entry.full);
    const licenseFiles = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((item) => item.isFile() && isLicenseFileName(item.name))
      .map((item) => `${rel}/${item.name}`)
      .sort();
    packages.push({
      name: manifest.name,
      version: manifest.version,
      license: licenseOf(manifest),
      path: rel,
      licenseFiles,
    });
  }
  return packages.sort((a, b) => a.path.localeCompare(b.path));
}

/** Every package names a licence; the core ones carry the text (libvips' README is a required file). */
export function checkLicenses(packages) {
  const failures = [];
  for (const item of packages) {
    if (item.license === null) failures.push(`${item.path} has no license field`);
  }
  for (const name of LICENSE_FILE_REQUIRED) {
    const item = packages.find((candidate) => candidate.path === `node_modules/${name}`);
    if (!item) failures.push(`licence check: node_modules/${name} is missing`);
    else if (item.licenseFiles.length === 0)
      failures.push(`node_modules/${name} ships without a licence file`);
  }
  return failures;
}

// ---- plugins (decisions 058, 059) ----------------------------------------------

/** Licences a plugin and the closure it brings may carry: permissive only (decision 059). */
export const PLUGIN_LICENSES = new Set([
  'MIT',
  'ISC',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'BlueOak-1.0.0',
  'CC0-1.0',
  'Unlicense',
]);

/**
 * Whether an SPDX expression is acceptable: `OR` needs one allowed side, `AND`
 * both. A `WITH` exception, `SEE LICENSE IN …` or a malformed expression is not.
 */
export function isAllowedLicense(expression, allowed = PLUGIN_LICENSES) {
  if (typeof expression !== 'string') return false;
  const tokens = expression.match(/\(|\)|[^\s()]+/g) ?? [];
  let at = 0;
  const keyword = (word) => tokens[at]?.toUpperCase() === word;
  const primary = () => {
    const token = tokens[at++];
    if (token === '(') {
      const value = either();
      if (tokens[at++] !== ')') throw new Error('unbalanced');
      return value;
    }
    if (token === undefined || token === ')' || /^(AND|OR|WITH)$/i.test(token)) {
      throw new Error('unexpected token');
    }
    if (keyword('WITH')) {
      at += 2;
      return false;
    }
    return allowed.has(token);
  };
  const both = () => {
    let value = primary();
    while (keyword('AND')) {
      at += 1;
      const right = primary();
      value = value && right;
    }
    return value;
  };
  const either = () => {
    let value = both();
    while (keyword('OR')) {
      at += 1;
      const right = both();
      value = value || right;
    }
    return value;
  };
  try {
    const value = either();
    return at === tokens.length && value;
  } catch {
    return false;
  }
}

/**
 * What the reviewer reads by hand (P1-10 shard 03 §6.2 items 5 and 6). A hit
 * is a pointer, never a verdict: the report goes into the manifest and the
 * review record, and passes the build either way.
 */
export const SENSITIVE_API_PATTERNS = [
  [
    'credentials',
    /\bctx\.credentials\b|\bcredentials\s*\.\s*(?:resolve|get|list)\b|['"]credentials['"]/,
  ],
  ['process-env', /\bprocess\.env\b/],
  [
    'ipc',
    /\bprocess\.(?:send|channel|disconnect)\b|\bprocess\.(?:on|once|addListener)\(\s*['"](?:message|disconnect)['"]/,
  ],
  [
    'subprocess',
    /\bchild_process\b|\bctx\.subprocess\b|['"]subprocess['"]|\bspawnTerminal\b|\bexecFile(?:Sync)?\s*\(/,
  ],
  [
    'network',
    /\bfetch\s*\(|['"](?:node:)?(?:http|https|http2|net|tls|dns|dgram)['"]|['"](?:ws|undici|axios|node-fetch|got)['"]|\bnew\s+WebSocket\b|\bXMLHttpRequest\b/,
  ],
  [
    'fs-write',
    /\b(?:writeFile|appendFile|mkdir|rmdir|unlink|rename|copyFile|symlink|chmod|chown|truncate|createWriteStream)(?:Sync)?\s*\(|\bfs(?:\.promises)?\.(?:rm|cp)(?:Sync)?\s*\(/,
  ],
  ['eval', /\beval\s*\(|\bnew\s+Function\s*\(/],
  ['dynamic-import', /\bimport\s*\(\s*[^'"`\s)]|\brequire\s*\(\s*[^'"`\s)]/],
  ['vm', /['"](?:node:)?vm['"]/],
  ['worker-threads', /['"](?:node:)?worker_threads['"]/],
  [
    'monkey-patch',
    /\bModule\._(?:load|resolveFilename|extensions|compile)\b|\brequire\.cache\b|\bObject\.defineProperty\(\s*(?:globalThis|global|process)\b|\b(?:globalThis|global)\.[A-Za-z_$][\w$]*\s*=(?!=)/,
  ],
  ['telemetry', /\b(?:telemetry|analytics|sentry|posthog|mixpanel)\b/i],
  [
    'hooks',
    /['"](?:tools\/pre-execute|approval\/request|agent\/request|system-prompt\/assemble|llm\/[\w/-]+)['"]/,
  ],
];

/** Per category: how many lines hit, and the first `perCategory` of them. */
export function scanSensitiveApis(root, dirs, perCategory = 10) {
  const counts = {};
  const hits = [];
  for (const dir of dirs) {
    for (const entry of walkTree(dir)) {
      if (entry.kind !== 'file' || !/\.(c?js|mjs)$/.test(entry.rel)) continue;
      const file = path.relative(root, entry.full).split(path.sep).join('/');
      fs.readFileSync(entry.full, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          for (const [category, pattern] of SENSITIVE_API_PATTERNS) {
            if (!pattern.test(line)) continue;
            counts[category] = (counts[category] ?? 0) + 1;
            if (counts[category] <= perCategory) hits.push({ category, file, line: index + 1 });
          }
        });
    }
  }
  return { counts, hits };
}

/** The patch files a `dsh.bundle` declares, as DSH reads them (dsh-app-boot `bundlePatchFiles`). */
function declaredPatchFiles(bundle) {
  const declared = typeof bundle?.patch === 'string' ? [bundle.patch] : bundle?.patch;
  if (!Array.isArray(declared) || !declared.every((file) => typeof file === 'string')) return null;
  return declared;
}

/** The staged dsh-app-boot: peers and patches judged exactly as the host will judge them. */
export async function loadStagedDsh(outDir) {
  const entry = path.join(
    outDir,
    'node_modules',
    '@deepseek-ai',
    'dsh-app-boot',
    'lib',
    'index.js'
  );
  const boot = await import(pathToFileURL(entry).href);
  return {
    evaluatePluginCompatibility: boot.evaluatePluginCompatibility,
    loadOverlayPatches: boot.loadOverlayPatches,
  };
}

/** Row ids the product composition already has: dsh-base and @aiclient/dsh-app. */
export function productRowIds(outDir, dsh) {
  const ids = new Set();
  for (const name of ['@deepseek-ai/dsh-base', PRODUCT_BUNDLE]) {
    const dir = path.join(outDir, 'node_modules', ...name.split('/'));
    const files = declaredPatchFiles(readJson(path.join(dir, 'package.json')).dsh?.bundle) ?? [];
    for (const file of files) {
      for (const id of patchRowIds(
        dsh.loadOverlayPatches('build-dsh-host', path.join(dir, file))
      )) {
        ids.add(id);
      }
    }
  }
  return ids;
}

function displayOf(dir, manifest) {
  let locale = {};
  const file = path.join(dir, 'locale', 'en.json');
  try {
    if (fs.existsSync(file)) locale = readJson(file);
  } catch {
    // Display text falls back to package.json.
  }
  const text = (value) => (typeof value === 'string' ? value : undefined);
  return {
    title: text(locale.title) ?? manifest.name,
    description: text(locale.description) ?? text(manifest.description) ?? '',
    ...(typeof manifest.icon === 'string' ? { icon: manifest.icon } : {}),
  };
}

/**
 * The post-install half of the plugin audit (decision 059), on the pruned
 * tree: identity, no `dsh.client` / `bin`, a DSH bundle, compatibility with
 * the pinned DSH (DSH's own rule, no exemption), the bundle patch, licences,
 * size, and the sensitive-API report. `dsh` is {@link loadStagedDsh}; the
 * source half (double key, closure, install scripts) ran in the preflight.
 * Returns the manifest's `plugins` section, in allowlist order.
 */
export function auditInstalledPlugins({ outDir, allowlist, closures, dshPin, dsh }) {
  const failures = [];
  const plugins = [];
  if (allowlist.plugins.length === 0) return { failures, plugins };
  const existingIds = productRowIds(outDir, dsh);
  for (const entry of allowlist.plugins) {
    const { name, version } = entry;
    const own = `node_modules/${name}`;
    const dir = path.join(outDir, ...own.split('/'));
    const fail = (message) => failures.push(`${name}@${version}: ${message}`);
    if (!fs.existsSync(path.join(dir, 'package.json'))) {
      fail('is not installed');
      continue;
    }
    const manifest = readJson(path.join(dir, 'package.json'));
    if (manifest.name !== name || manifest.version !== version) {
      fail(`installed as ${manifest.name}@${manifest.version}`);
    }
    if (manifest.dsh?.client !== undefined) fail('carries dsh.client (a UI plugin)');
    if (manifest.bin !== undefined) fail('declares bin');

    try {
      const issue = dsh.evaluatePluginCompatibility(manifest, {}, dshPin);
      if (issue)
        fail(`incompatible with DSH ${dshPin}: ${JSON.stringify(issue.peers)} (no exemption)`);
    } catch (error) {
      fail(`peer check failed: ${error.message}`);
    }

    let expressions = [];
    const patchFiles = declaredPatchFiles(manifest.dsh?.bundle);
    if (patchFiles === null) fail('is not a DSH bundle (no dsh.bundle.patch)');
    else {
      const patches = [];
      for (const file of patchFiles) {
        const abs = path.resolve(dir, file);
        if (!abs.startsWith(`${dir}${path.sep}`)) {
          fail(`bundle patch ${file} lies outside the package`);
          continue;
        }
        try {
          patches.push(...dsh.loadOverlayPatches('build-dsh-host', abs));
        } catch (error) {
          fail(error.message);
        }
      }
      const audit = auditBundlePatches({
        patches,
        packageName: name,
        packageUrl: pathToFileURL(dir).href,
        rows: entry.rows,
        existingIds,
      });
      for (const failure of audit.failures) fail(failure);
      expressions = audit.expressions;
    }

    const license = licenseOf(manifest);
    if (!isAllowedLicense(license))
      fail(`licence ${license ?? '(none)'} is not on the plugin list`);
    const hasLicenseFile = fs
      .readdirSync(dir, { withFileTypes: true })
      .some((item) => item.isFile() && isLicenseFileName(item.name));
    if (!hasLicenseFile) fail('ships without a licence file');
    const closure = closures[name] ?? [];
    for (const rel of closure) {
      const file = path.join(outDir, ...rel.split('/'), 'package.json');
      if (!fs.existsSync(file)) continue;
      const depLicense = licenseOf(readJson(file));
      if (!isAllowedLicense(depLicense)) {
        fail(`${lockPathName(rel)} has licence ${depLicense ?? '(none)'}, not on the plugin list`);
      }
    }

    // Measured over the package and the closure it brings; nested paths are counted once.
    const paths = [own, ...closure];
    const roots = paths
      .filter((rel) => !paths.some((other) => other !== rel && rel.startsWith(`${other}/`)))
      .map((rel) => path.join(outDir, ...rel.split('/')))
      .filter((abs) => fs.existsSync(abs));
    const size = roots.reduce(
      (sum, abs) => {
        const stats = treeStats(abs);
        return { bytes: sum.bytes + stats.bytes, files: sum.files + stats.files };
      },
      { bytes: 0, files: 0 }
    );
    const budget = evaluateDshPlugin(size, entry.limits);
    if (budget.status !== 'ok') {
      fail(
        `${formatMiB(size.bytes)} / ${size.files} files is over its ${formatMiB(budget.ceiling.bytes)} / ${budget.ceiling.files} ceiling`
      );
    }

    plugins.push({
      name,
      version,
      kind: entry.kind,
      integrity: entry.integrity,
      defaultEnabled: entry.defaultEnabled,
      description: typeof manifest.description === 'string' ? manifest.description : '',
      display: displayOf(dir, manifest),
      rows: entry.rows,
      tools: entry.tools,
      replaces: entry.replaces ?? [],
      review: entry.review,
      license,
      dependencies: Object.keys(entry.dependencies ?? {}).sort(),
      bytes: size.bytes,
      files: size.files,
      limits: budget.ceiling,
      patchExpressions: expressions,
      sensitiveApis: scanSensitiveApis(outDir, roots),
    });
  }
  return { failures, plugins };
}

// ---- verification ------------------------------------------------------------

/** Files every target ships (relative to the artifact root). */
export function requiredFiles(target) {
  const files = [
    'host.js',
    'package.json',
    DSH_HOST_LICENSES,
    'node_modules/@aiclient/dsh-app/package.json',
    'node_modules/@aiclient/dsh-app/cordis.patch.yml',
    'node_modules/@aiclient/dsh-app/lib/index.js',
    'node_modules/@aiclient/dsh-app/lib/bridge.js',
    'node_modules/@deepseek-ai/dsh-base/package.json',
    'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js',
    'node_modules/@deepseek-ai/dsh-launch-environment/package.json',
    // Loaded by path at run time, so nothing but this list vouches for them.
    'node_modules/@deepseek-ai/dsh-skill-badge/assets/dsh-badge.md',
    'node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/worker.cjs',
    'node_modules/@deepseek-ai/dsh-ptc-runtime-node/lib/process.js',
    // P1-6b: the permission row and its bash parser, read by path on the first bash call.
    'node_modules/@aiclient/dsh-app/lib/permissions.js',
    'node_modules/web-tree-sitter/web-tree-sitter.wasm',
    'node_modules/tree-sitter-bash/tree-sitter-bash.wasm',
    // P1-8: the loop guard row, which host.ts requires to be composed on.
    'node_modules/@aiclient/dsh-app/lib/loop-guard.js',
    // P1-13c: the encrypted-read fallback row, required on the same way.
    'node_modules/@aiclient/dsh-app/lib/encrypted-read.js',
  ];
  // libvips: the library list and versions travel with the binaries (licenses shard §2.3).
  if (target.platform === 'win32')
    files.push(`node_modules/@img/sharp-${targetKey(target)}/versions.json`);
  else {
    const vips = `node_modules/@img/sharp-libvips-${targetKey(target)}`;
    files.push(`${vips}/README.md`, `${vips}/versions.json`);
  }
  return files;
}

/** Paths that must not exist in any artifact. */
export const FORBIDDEN_PATHS = [
  'host.ts',
  'bundle',
  'node_modules/.bin',
  'node_modules/.package-lock.json',
  `node_modules/${PROBE_BUNDLE}`,
  'node_modules/@emnapi',
];

const FORBIDDEN_FILE = /\.(map|d\.ts|d\.mts|d\.cts|tsbuildinfo|pdb)$/i;
/** Decision 058: no package manager ships, at any depth. */
const PACKAGE_MANAGER_DIR = /(^|\/)node_modules\/(pnpm|@pnpm)$/;

/**
 * Structural verification of an artifact directory for `target`. Throws with
 * every failure; returns the numbers the manifest records. `requireManifest`
 * is set for a packaged copy, which must carry the build's manifest.
 */
export function verifyDshArtifact({ outDir, target, requireManifest = false }) {
  const failures = [];
  const abs = (rel) => path.join(outDir, ...rel.split('/'));
  if (!fs.existsSync(outDir)) throw new Error(`DSH host artifact is missing: ${outDir}`);

  for (const rel of requiredFiles(target)) {
    if (!fs.existsSync(abs(rel))) failures.push(`missing ${rel}`);
  }
  if (requireManifest && !fs.existsSync(abs(DSH_HOST_MANIFEST)))
    failures.push(`missing ${DSH_HOST_MANIFEST}`);
  for (const rel of FORBIDDEN_PATHS) {
    if (fs.existsSync(abs(rel))) failures.push(`must not ship ${rel}`);
  }

  // host.js carries its own lib/ modules; a TypeScript import would not resolve.
  if (fs.existsSync(abs(HOST_ENTRY.out))) {
    const host = fs.readFileSync(abs(HOST_ENTRY.out), 'utf8');
    if (/(?:from|import)\s*\(?\s*['"]\.{1,2}\/[^'"]*\.ts['"]/.test(host)) {
      failures.push(`${HOST_ENTRY.out} still loads TypeScript sources (not the esbuild bundle)`);
    }
  }

  const entries = walkTree(outDir);
  for (const entry of entries) {
    if (entry.kind === 'link') failures.push(`symbolic link: ${entry.rel}`);
    else if (entry.kind === 'file' && FORBIDDEN_FILE.test(entry.rel))
      failures.push(`must not ship ${entry.rel}`);
    else if (entry.kind === 'dir' && entry.rel.endsWith('/.bin'))
      failures.push(`must not ship ${entry.rel}`);
    else if (entry.kind === 'dir' && PACKAGE_MANAGER_DIR.test(entry.rel))
      failures.push(`must not ship ${entry.rel}: no package manager ships (decision 058)`);
  }

  // The product bundle: bridges are bundled JS, the probe row is absent (decision 015).
  const app = abs('node_modules/@aiclient/dsh-app');
  if (fs.existsSync(app)) {
    const patch = fs.existsSync(path.join(app, 'cordis.patch.yml'))
      ? fs.readFileSync(path.join(app, 'cordis.patch.yml'), 'utf8')
      : '';
    if (/id:\s*aiclient-probe\b/.test(patch) || patch.includes(PROBE_BUNDLE)) {
      failures.push('product bundle patch composes the aiclient-probe row');
    }
    // Decision 082: plugin installs never run on the user's machine, so this
    // row's own layer must already disable it (host.ts's REQUIRED_DISABLED
    // overlay restates it, but the static patch is the first line of defense).
    // Row bodies aren't nested, so slice from the row's own `- id:` line to
    // the next top-level `- ` line (or end of file) and inspect only that.
    const rowStart = patch.search(/^- id:\s*plugin-manager\s*$/m);
    if (rowStart === -1) {
      failures.push('product bundle patch does not disable plugin-manager (decision 082)');
    } else {
      const afterStart = patch.slice(rowStart + 1);
      const nextRow = afterStart.search(/^- /m);
      const pluginManagerRow = nextRow === -1 ? afterStart : afterStart.slice(0, nextRow);
      if (!/^\s*disabled:\s*true\s*$/m.test(pluginManagerRow)) {
        failures.push('product bundle patch does not disable plugin-manager (decision 082)');
      }
      if (/registry:/.test(pluginManagerRow)) {
        failures.push(
          'product bundle patch still configures a plugin-manager registry (decision 082)'
        );
      }
    }
    for (const item of BRIDGE_ENTRIES) {
      const file = path.join(app, 'lib', path.basename(item.out));
      if (!fs.existsSync(file)) continue;
      const text = fs.readFileSync(file, 'utf8');
      if (/from\s+['"][^'"]+\.ts['"]|import\(\s*new URL\(/.test(text)) {
        failures.push(`${item.out} still loads TypeScript sources (not the esbuild bundle)`);
      }
      if (!text.includes(`'${item.row}'`) && !text.includes(`"${item.row}"`)) {
        failures.push(`${item.out} does not define the ${item.row} row`);
      }
    }
    for (const entry of walkTree(app)) {
      if (entry.kind !== 'file' || !/\.(c?js|mjs)$/.test(entry.rel)) continue;
      if (/\bname\s*=\s*['"]aiclient-probe['"]/.test(fs.readFileSync(entry.full, 'utf8'))) {
        failures.push(`product bundle carries the aiclient-probe plugin: ${entry.rel}`);
      }
    }
  }

  // Natives: every binary is the target's format; the target's must-haves exist.
  const binaries = scanBinaries(outDir);
  for (const binary of binaries) {
    if (!binaryMatchesTarget(binary.detected, target)) {
      const seen = binary.detected
        ? `${binary.detected.format} ${binary.detected.arch}`
        : 'unknown format';
      failures.push(`${binary.rel} is ${seen}, not ${targetKey(target)}`);
    }
  }
  const natives = binaries.map((binary) => ({
    path: binary.rel,
    format: binary.detected ? `${binary.detected.format} ${binary.detected.arch}` : 'unknown',
    bytes: fs.statSync(binary.full).size,
    sha256: sha256File(binary.full),
  }));
  for (const [label, pattern] of requiredNatives(target)) {
    if (!natives.some((item) => pattern.test(item.path)))
      failures.push(`missing ${label} native for ${targetKey(target)}`);
  }
  if (target.platform !== 'win32' && process.platform !== 'win32') {
    for (const rel of executablePaths(target)) {
      if (fs.existsSync(abs(rel)) && (fs.statSync(abs(rel)).mode & 0o111) === 0) {
        failures.push(`${rel} is not executable`);
      }
    }
  }

  // Licences: the JSON exists and agrees with the tree.
  let packages = [];
  if (fs.existsSync(abs(DSH_HOST_LICENSES))) {
    try {
      packages = readJson(abs(DSH_HOST_LICENSES)).packages ?? [];
    } catch (error) {
      failures.push(`${DSH_HOST_LICENSES} is not valid JSON: ${error.message}`);
    }
    const onDisk = collectLicenses(outDir);
    const listed = new Set(packages.map((item) => `${item.path}@${item.version}`));
    const unlisted = onDisk.filter((item) => !listed.has(`${item.path}@${item.version}`));
    if (unlisted.length > 0) {
      failures.push(
        `${DSH_HOST_LICENSES} misses ${unlisted.length} package(s): ${unlisted
          .slice(0, 5)
          .map((item) => item.path)
          .join(', ')}`
      );
    }
    failures.push(...checkLicenses(onDisk));
  }

  // Budget (decision 014), measured without the manifest, which records it.
  const stats = treeStats(outDir, new Set([DSH_HOST_MANIFEST]));
  if (stats.bytes > DSH_HOST_BUDGET.maxBytes) {
    failures.push(
      `artifact is ${formatMiB(stats.bytes)}, over the ${formatMiB(DSH_HOST_BUDGET.maxBytes)} ceiling`
    );
  }
  if (stats.files > DSH_HOST_BUDGET.maxFiles) {
    failures.push(
      `artifact has ${stats.files} files, over the ${DSH_HOST_BUDGET.maxFiles} ceiling`
    );
  }

  if (requireManifest && fs.existsSync(abs(DSH_HOST_MANIFEST))) {
    try {
      const manifest = readJson(abs(DSH_HOST_MANIFEST));
      if (manifest.schema !== MANIFEST_SCHEMA) failures.push(`manifest schema ${manifest.schema}`);
      if (manifest.target?.platform !== target.platform || manifest.target?.arch !== target.arch) {
        failures.push(
          `manifest target ${manifest.target?.platform}-${manifest.target?.arch} is not ${targetKey(target)}`
        );
      }
      // Decision 059: the plugins section lists what is preinstalled, even when empty.
      if (!Array.isArray(manifest.plugins)) failures.push('manifest has no plugins section');
      else {
        for (const plugin of manifest.plugins) {
          const file = abs(`node_modules/${plugin?.name}/package.json`);
          const installed = fs.existsSync(file) ? readJson(file).version : undefined;
          if (installed !== plugin?.version) {
            failures.push(
              `manifest plugin ${plugin?.name}@${plugin?.version} is not installed (found ${installed ?? 'nothing'})`
            );
          }
        }
      }
    } catch (error) {
      failures.push(`${DSH_HOST_MANIFEST} is not valid JSON: ${error.message}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `DSH host artifact verification failed (${targetKey(target)}):\n  - ${failures.join('\n  - ')}`
    );
  }
  return { ...stats, natives, packages: packages.length };
}

export function formatMiB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)}MiB`;
}

/** The manifest written beside host.js; host.js reports part of it in `ready`. */
export function buildManifest({
  target,
  version,
  dshPin,
  appVersion,
  gitCommit,
  builtOn,
  stats,
  natives,
  packages,
  pruned,
  materialized,
  lockSha256,
  builtAt,
  plugins = [],
}) {
  return {
    schema: MANIFEST_SCHEMA,
    artifact: '@aiclient/dsh-host',
    version,
    dsh: dshPin,
    appVersion,
    gitCommit,
    target: { platform: target.platform, arch: target.arch },
    builtOn,
    builtAt,
    lockSha256,
    files: stats.files,
    bytes: stats.bytes,
    longestRelativePath: stats.longestRelativePath,
    budget: DSH_HOST_BUDGET,
    packages,
    pruned,
    materialized,
    natives,
    // Decision 059: the audited allowlisted plugins; Main and the host read the list from here.
    plugins,
  };
}
