/**
 * Build the Claude Agent SDK host artifact shipped as resources/claude-sdk-host
 * (route B S-4, docs/plantree/plans/claude-sdk-engine/topics/s4-packaging.md).
 *
 *   node scripts/build-claude-sdk-host.mjs [--platform <p> --arch <a>] [--out <dir>]
 *
 * Output (out-claude-sdk-host/ by default; layout in claude-sdk-host-build-lib.mjs):
 * host.js bundled by esbuild, `npm ci` of src/claude-sdk-host's committed
 * lockfile without peers, pruned to the SDK and the target's CLI, a licence
 * list and a manifest. afterPack copies it; verify-packaged-app.mjs checks the copy.
 *
 * The target defaults to this machine: packaging jobs run on each platform's own
 * runner. `--platform/--arch` build a foreign tree for a static rehearsal only.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertSupportedTarget,
  buildManifest,
  CLAUDE_SDK_HOST_LICENSES,
  CLAUDE_SDK_HOST_MANIFEST,
  CLAUDE_SDK_HOST_OUT_REL,
  CLAUDE_SDK_HOST_SOURCE_REL,
  checkHostMetafile,
  checkLockedSdk,
  checkSdkEntry,
  cliBinaryRel,
  cliPackageName,
  hostBuildOptions,
  licensesOf,
  npmCiArgs,
  pruneTree,
  SDK_PACKAGE,
  STAGED_SOURCE_FILES,
  verifyClaudeSdkHostArtifact,
} from './claude-sdk-host-build-lib.mjs';
import { formatMiB, readJson, sha256File, targetKey } from './dsh-host-build-lib.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = path.join(repoRoot, ...CLAUDE_SDK_HOST_SOURCE_REL.split('/'));

function parseArgs(argv) {
  const args = {
    platform: process.platform,
    arch: process.arch,
    out: path.join(repoRoot, CLAUDE_SDK_HOST_OUT_REL),
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
const log = (message) => console.log(`[build-claude-sdk-host] ${message}`);
const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;

/** Exact pins only, and a lockfile that resolves the SDK at its pin with no dependencies. */
function preflight() {
  const manifest = readJson(path.join(sourceDir, 'package.json'));
  const pin = manifest.dependencies?.[SDK_PACKAGE];
  if (!pin || !/^\d+\.\d+\.\d+$/.test(pin)) {
    throw new Error(
      `src/claude-sdk-host/package.json must pin ${SDK_PACKAGE} exactly (found ${pin})`
    );
  }
  const failures = checkLockedSdk(readJson(path.join(sourceDir, 'package-lock.json')), pin);
  if (failures.length > 0) throw new Error(failures.join('; '));
  return { sdkVersion: pin };
}

function stage(outDir) {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  for (const rel of STAGED_SOURCE_FILES) {
    fs.copyFileSync(path.join(sourceDir, rel), path.join(outDir, rel));
  }
}

async function compile(outDir) {
  let esbuild;
  try {
    esbuild = await import('esbuild');
  } catch {
    throw new Error('esbuild not resolvable from the repo root — run "pnpm install" first');
  }
  const result = await esbuild.build(hostBuildOptions(repoRoot, outDir));
  const verdict = checkHostMetafile(result.metafile, repoRoot);
  if (verdict.failures.length > 0) throw new Error(verdict.failures.join('; '));
  return verdict;
}

function npm(args, cwd) {
  const isWindows = process.platform === 'win32';
  // npm is a .cmd shim on Windows, which spawn only runs through a shell.
  const result = spawnSync(isWindows ? 'npm.cmd' : 'npm', args, {
    cwd,
    stdio: 'inherit',
    shell: isWindows,
    env: { ...process.env, npm_config_update_notifier: 'false' },
  });
  if (result.status !== 0) {
    throw new Error(
      `npm ${args[0]} exited ${result.status ?? result.signal}${result.error ? `: ${result.error.message}` : ''}`
    );
  }
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
    // The trees host.js is built from.
    const dirty = execFileSync(
      'git',
      [
        '-C',
        repoRoot,
        'status',
        '--porcelain',
        '--',
        CLAUDE_SDK_HOST_SOURCE_REL,
        'src/shared',
        'src/dsh-host/bridge',
      ],
      { encoding: 'utf8' }
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
  if (target.platform !== process.platform || target.arch !== process.arch) {
    log(
      `static rehearsal for ${targetKey(target)} on ${process.platform}-${process.arch}; not for packaging`
    );
  }
  const { sdkVersion } = preflight();
  stage(args.out);
  const verdict = await compile(args.out);
  log(
    `compiled host.js (${verdict.inputs.length} inputs, external ${verdict.externals.filter((e) => !e.startsWith('node:')).join(' ') || '-'})`
  );

  const ciArgs = npmCiArgs(target);
  log(`$ npm ${ciArgs.join(' ')}`);
  npm(ciArgs, args.out);
  fs.rmSync(path.join(args.out, 'package-lock.json'), { force: true });
  log(`installed in ${elapsed()}`);
  // B-3: the SDK entry host.js loads needs no package, so the pruning below may drop them all.
  const sdkEntry = await checkSdkEntry(args.out, await import('esbuild'));
  if (sdkEntry.failures.length > 0) throw new Error(sdkEntry.failures.join('; '));
  log(`${SDK_PACKAGE}/${sdkEntry.entry} imports Node built-ins only`);

  const pruned = pruneTree(args.out, target);
  log(
    `pruned ${pruned.removedFiles} files (${formatMiB(pruned.removedBytes)}) in ${pruned.removedDirectories.length} directories; the manifest lists them`
  );
  const cliFile = path.join(args.out, ...cliBinaryRel(target).split('/'));
  // The tarball's mode is kept by npm; asserted by the verifier, set here for a foreign rehearsal.
  if (target.platform !== 'win32' && fs.existsSync(cliFile)) fs.chmodSync(cliFile, 0o755);

  const licenses = licensesOf(args.out);
  if (licenses.failures.length > 0) throw new Error(licenses.failures.join('; '));
  fs.writeFileSync(
    path.join(args.out, CLAUDE_SDK_HOST_LICENSES),
    `${JSON.stringify({ schema: 1, target, packages: licenses.packages }, null, 2)}\n`
  );

  const verified = verifyClaudeSdkHostArtifact({ outDir: args.out, target });
  const cliPackage = cliPackageName(target);
  const manifest = buildManifest({
    target,
    appVersion: readJson(path.join(repoRoot, 'package.json')).version,
    sdkVersion,
    cliPackage,
    cliVersion: readJson(
      path.join(args.out, 'node_modules', ...cliPackage.split('/'), 'package.json')
    ).version,
    cli: verified.cli,
    gitCommit: gitCommit(),
    builtOn: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      npm: npmVersion(),
    },
    builtAt: new Date().toISOString(),
    lockSha256: sha256File(path.join(sourceDir, 'package-lock.json')),
    stats: verified,
    packages: licenses.packages.length,
    pruned: {
      files: pruned.removedFiles,
      bytes: pruned.removedBytes,
      directories: pruned.removedDirectories,
    },
  });
  fs.writeFileSync(
    path.join(args.out, CLAUDE_SDK_HOST_MANIFEST),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  const final = verifyClaudeSdkHostArtifact({ outDir: args.out, target, requireManifest: true });
  log(
    `OK — ${targetKey(target)}: ${formatMiB(final.bytes)} (${final.bytes}B), ${final.files} files, ` +
      `CLI ${manifest.cli.version} ${formatMiB(final.cli.bytes)}, longest path ${final.longestRelativePath}` +
      `${final.budget.overTarget ? '; over the size target' : ''}`
  );
  log(`done in ${elapsed()} -> ${args.out}`);
}

try {
  await main();
} catch (error) {
  console.error(
    `[build-claude-sdk-host] ERROR: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exit(1);
}
