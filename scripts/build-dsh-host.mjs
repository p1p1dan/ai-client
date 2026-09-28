/**
 * Build the DSH host artifact shipped as resources/dsh-host (dsh-rebase P1-2,
 * decisions 011, 013, 014, 016).
 *
 *   node scripts/build-dsh-host.mjs [--platform <p> --arch <a>] [--out <dir>]
 *
 * Output layout (out-dsh-host/ by default):
 *   host.js                     esbuild bundle of src/dsh-host/host.ts and its lib/
 *                               (npm packages external)
 *   package.json                the install anchor (@aiclient/dsh-host)
 *   dsh-host-manifest.json      target, versions, git commit, size, file count, natives
 *   THIRD_PARTY_LICENSES.json   one entry per installed package of the final tree
 *   node_modules/               `npm ci` of the committed lockfile, pruned (B tier);
 *                               @aiclient/dsh-app is a real copy whose bridge rows
 *                               are esbuild bundles of src/dsh-host/bridge
 *
 * The target defaults to this machine: packaging jobs run on each platform's
 * own runner. `--platform/--arch` build a foreign tree for a static rehearsal
 * only (formats and must-haves); afterPack refuses a manifest whose target is
 * not the one being packaged.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertSupportedTarget,
  BRIDGE_ENTRIES,
  bridgeBuildOptions,
  buildManifest,
  checkBridgeMetafile,
  checkHostMetafile,
  collectLicenses,
  DSH_HOST_BUDGET,
  DSH_HOST_LICENSES,
  DSH_HOST_MANIFEST,
  DSH_HOST_OUT_REL,
  DSH_HOST_SOURCE_REL,
  fixExecutableBits,
  formatMiB,
  hostBuildOptions,
  materializeLinks,
  npmCiArgs,
  preflightDshHost,
  pruneTree,
  readJson,
  STAGED_BUNDLE_FILES,
  STAGED_SOURCE_FILES,
  sha256File,
  targetKey,
  unknownBundleFiles,
  verifyDshArtifact,
} from './dsh-host-build-lib.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = path.join(repoRoot, ...DSH_HOST_SOURCE_REL.split('/'));

function parseArgs(argv) {
  const args = {
    platform: process.platform,
    arch: process.arch,
    out: path.join(repoRoot, DSH_HOST_OUT_REL),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i + 1];
    if (argv[i] === '--platform') args.platform = value;
    else if (argv[i] === '--arch') args.arch = value;
    else if (argv[i] === '--out') args.out = path.resolve(value ?? '');
    else throw new Error(`unknown argument: ${argv[i]}`);
    i += 1;
  }
  return args;
}

const started = Date.now();
const log = (message) => console.log(`[build-dsh-host] ${message}`);
const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;

function fail(message) {
  console.error(`[build-dsh-host] ERROR: ${message}`);
  process.exit(1);
}

function stage(outDir) {
  const unknown = unknownBundleFiles(sourceDir);
  if (unknown.length > 0) {
    throw new Error(
      `src/dsh-host/bundle has files staging does not know: ${unknown.join(', ')} — list them in STAGED_BUNDLE_FILES or BRIDGE_ENTRIES`
    );
  }
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  for (const rel of STAGED_SOURCE_FILES) {
    fs.copyFileSync(path.join(sourceDir, rel), path.join(outDir, rel));
  }
  for (const rel of STAGED_BUNDLE_FILES) {
    const dest = path.join(outDir, 'bundle', ...rel.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(sourceDir, 'bundle', ...rel.split('/')), dest);
  }
}

async function compile(outDir) {
  let esbuild;
  try {
    esbuild = await import('esbuild');
  } catch {
    throw new Error('esbuild not resolvable from the repo root — run "pnpm install" first');
  }
  const host = await esbuild.build(hostBuildOptions(sourceDir, outDir));
  const hostVerdict = checkHostMetafile(host.metafile, repoRoot);
  if (hostVerdict.failures.length > 0) throw new Error(hostVerdict.failures.join('; '));
  const bridges = [];
  for (const item of BRIDGE_ENTRIES) {
    const result = await esbuild.build(bridgeBuildOptions(sourceDir, outDir, item));
    const verdict = checkBridgeMetafile(result.metafile, repoRoot, item);
    if (verdict.failures.length > 0) throw new Error(verdict.failures.join('; '));
    bridges.push({ out: item.out, inputs: verdict.inputs.length, externals: verdict.externals });
  }
  return bridges;
}

function npmInstall(outDir, target) {
  const args = npmCiArgs(target);
  const isWindows = process.platform === 'win32';
  log(`$ npm ${args.join(' ')}`);
  // npm is a .cmd shim on Windows, which spawn only runs through a shell.
  const result = spawnSync(isWindows ? 'npm.cmd' : 'npm', args, {
    cwd: outDir,
    stdio: 'inherit',
    shell: isWindows,
    env: { ...process.env, npm_config_update_notifier: 'false' },
  });
  if (result.status !== 0) {
    throw new Error(
      `npm ci exited ${result.status ?? result.signal}${result.error ? `: ${result.error.message}` : ''}`
    );
  }
  return npmVersion();
}

function npmVersion() {
  try {
    return execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--version'], {
      encoding: 'utf8',
      shell: process.platform === 'win32',
    }).trim();
  } catch {
    return 'unknown';
  }
}

function gitCommit() {
  try {
    const sha = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    const dirty = execFileSync(
      'git',
      [
        '-C',
        repoRoot,
        'status',
        '--porcelain',
        '--',
        DSH_HOST_SOURCE_REL,
        'src/agent-host',
        'src/shared',
      ],
      {
        encoding: 'utf8',
      }
    ).trim();
    return dirty ? `${sha}+dirty` : sha;
  } catch {
    return 'unknown';
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const target = { platform: args.platform, arch: args.arch };
  assertSupportedTarget(target);
  const foreign = target.platform !== process.platform || target.arch !== process.arch;
  if (foreign)
    log(
      `static rehearsal for ${targetKey(target)} on ${process.platform}-${process.arch}; not for packaging`
    );

  const { dshPin, version } = preflightDshHost(sourceDir);
  stage(args.out);
  const bridges = await compile(args.out);
  log(
    `compiled host.js and ${bridges.map((item) => `${item.out} (${item.inputs} inputs, external ${item.externals.join(' ') || '-'})`).join(', ')}`
  );

  const npm = npmInstall(args.out, target);
  const materialized = materializeLinks(args.out);
  fs.rmSync(path.join(args.out, 'bundle'), { recursive: true, force: true });
  for (const rel of ['package-lock.json', '.npmrc'])
    fs.rmSync(path.join(args.out, rel), { force: true });
  log(
    `installed in ${elapsed()}; materialized ${materialized.map((item) => item.name).join(', ') || 'nothing'}`
  );

  const pruned = pruneTree(args.out, target);
  const fixed = fixExecutableBits(args.out, target);
  log(
    `pruned ${pruned.removedFiles} files (${formatMiB(pruned.removedBytes)})${fixed.length ? `; chmod 755 ${fixed.join(', ')}` : ''}`
  );

  const packages = collectLicenses(args.out);
  fs.writeFileSync(
    path.join(args.out, DSH_HOST_LICENSES),
    `${JSON.stringify({ schema: 1, target: target, packages }, null, 2)}\n`
  );

  const verified = verifyDshArtifact({ outDir: args.out, target });
  const manifest = buildManifest({
    target,
    version,
    dshPin,
    appVersion: readJson(path.join(repoRoot, 'package.json')).version,
    gitCommit: gitCommit(),
    builtOn: { platform: process.platform, arch: process.arch, node: process.version, npm },
    builtAt: new Date().toISOString(),
    lockSha256: sha256File(path.join(sourceDir, 'package-lock.json')),
    stats: verified,
    natives: verified.natives,
    packages: packages.length,
    pruned: {
      files: pruned.removedFiles,
      bytes: pruned.removedBytes,
      directories: pruned.removedDirectories.map(({ rel, reason, files, bytes }) => ({
        rel,
        reason,
        files,
        bytes,
      })),
    },
    materialized,
  });
  fs.writeFileSync(
    path.join(args.out, DSH_HOST_MANIFEST),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  verifyDshArtifact({ outDir: args.out, target, requireManifest: true });

  const overTarget = verified.bytes > DSH_HOST_BUDGET.targetBytes;
  log(
    `OK — ${targetKey(target)}: ${formatMiB(verified.bytes)} (${verified.bytes}B), ${verified.files} files, ` +
      `${packages.length} packages, ${verified.natives.length} natives, longest path ${verified.longestRelativePath}` +
      `${overTarget ? `; over the ${formatMiB(DSH_HOST_BUDGET.targetBytes)} target` : ''}`
  );
  log(`done in ${elapsed()} -> ${args.out}`);
}

try {
  await main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
