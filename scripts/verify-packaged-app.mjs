/**
 * Verify a packaged app: legal notices, the bundled Node runtime and the DSH
 * host artifact (dsh-rebase P1-2), then the DSH host's L1 smoke on the
 * packaged node (`--skip-dsh-smoke` skips it; it needs no Electron).
 *
 * Route B S-4: the Claude Agent SDK host artifact too (resources/claude-sdk-host:
 * structure, the target's CLI, budget), then its smoke, a chat turn on the
 * packaged node against the local fake gateway (`--skip-claude-sdk-smoke`).
 *
 * dsh-rebase P1-12 step 1 (decision 147): the native worker artifact is no
 * longer built or shipped, so its structure, size and Electron bootstrap smoke
 * are gone, and a package that still carries `resources/agent-host` fails.
 *
 * Step 3: the self-owned runtime and the root pi dependencies are deleted too.
 * electron-builder ships every root `dependencies` entry inside app.asar, so
 * the archive is read (its own header, `asar-inspect.mjs`) and fails when it
 * still carries one of the retired packages, or when Main's bundle still
 * holds one of the runtime's marker identifiers.
 *
 * Decision 200: app.asar ships only the node_modules packages Main loads at
 * run time (`runtime-packages.mjs`). The archive must carry all of them and
 * nothing else, Main's bundles may load nothing beyond them, and each one is
 * loaded inside the packaged executable run as Node (`runtime-load-probe.cjs`).
 */

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { builtinModules } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { asarEntry, findAsarPackages, readAsarFile, readAsarHeader } from './asar-inspect.mjs';
import { verifyClaudeSdkHostArtifact } from './claude-sdk-host-build-lib.mjs';
import { verifyDshArtifact } from './dsh-host-build-lib.mjs';
import { NODE_RUNTIME_VERSION, nodeRuntimePinFor } from './node-runtime-pin.mjs';
import { evaluateDshHostArtifact, formatBytes, topDirectories } from './packaging-budget.mjs';
import {
  isRuntimePackage,
  MAIN_RUNTIME_ENTRIES,
  RUNTIME_PACKAGES,
  runtimeSpecifiers,
} from './runtime-packages.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Resource directories the retired native worker used to occupy. */
const RETIRED_RESOURCE_DIRS = ['agent-host'];

/**
 * Packages the retired runtime and native worker brought into app.asar. The
 * DSH host's own `@deepseek-ai/cordis` lives in resources/dsh-host and is not
 * affected; the unscoped `cordis` was the self-owned runtime's.
 */
const RETIRED_ASAR_PACKAGES = [
  '@earendil-works/pi-coding-agent',
  '@earendil-works/pi-agent-core',
  '@gotgenes/pi-permission-system',
  'cordis',
];

/** Identifiers only the self-owned runtime defined; none may reach Main's bundle. */
const RETIRED_MAIN_MARKERS = [
  'NativeWorkerRuntime',
  'RUNTIME_CONFIG_VERSION',
  'CONTEXT_ROLLOVER_SUMMARY',
  'DEFAULT_AGENT_LOOP_CONFIG',
  'resolveWorkerShell',
];

/** The Main bundle inside app.asar. */
const MAIN_BUNDLE = 'out/main/index.js';

function parseArgs(argv) {
  const args = {
    appDir: path.join(repoRoot, 'dist', 'win-unpacked'),
    skipDshSmoke: false,
    skipClaudeSdkSmoke: false,
    reportFile: null,
    dshReportFile: null,
    claudeSdkReportFile: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--app-dir') {
      args.appDir = path.resolve(argv[i + 1] ?? '');
      i += 1;
    } else if (argv[i] === '--report-file') {
      args.reportFile = path.resolve(argv[++i]);
    } else if (argv[i] === '--skip-dsh-smoke') {
      args.skipDshSmoke = true;
    } else if (argv[i] === '--dsh-report-file') {
      args.dshReportFile = path.resolve(argv[++i]);
    } else if (argv[i] === '--skip-claude-sdk-smoke') {
      args.skipClaudeSdkSmoke = true;
    } else if (argv[i] === '--claude-sdk-report-file') {
      args.claudeSdkReportFile = path.resolve(argv[++i]);
    } else {
      throw new Error(`unknown argument: ${argv[i]}`);
    }
  }
  return args;
}

function firstBytes(file, count) {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(count);
    const read = fs.readSync(fd, buffer, 0, count, 0);
    return buffer.subarray(0, read).toString('latin1');
  } finally {
    fs.closeSync(fd);
  }
}

function checkNodeRuntime(resourceDir, failures) {
  const pin = nodeRuntimePinFor(process.platform, process.arch);
  if (!pin) return;
  const binary = path.join(resourceDir, 'node-runtime', pin.outName);
  if (!fs.existsSync(binary)) {
    failures.push(`missing bundled Node runtime: ${binary}`);
    return;
  }
  if (process.platform !== 'win32' && (fs.statSync(binary).mode & 0o111) === 0) {
    failures.push(`bundled Node runtime is not executable: ${binary}`);
    return;
  }
  try {
    const version = execFileSync(binary, ['--version'], { timeout: 8000, windowsHide: true })
      .toString()
      .trim();
    if (version !== `v${NODE_RUNTIME_VERSION}`) {
      failures.push(`bundled Node runtime version ${version} != v${NODE_RUNTIME_VERSION}`);
    }
  } catch (error) {
    failures.push(`bundled Node runtime is not runnable: ${String(error)}`);
  }
}

function checkLegalNotices(resourceDir, failures) {
  const licensePath = path.join(resourceDir, 'licenses', 'LICENSE');
  const noticesPath = path.join(resourceDir, 'licenses', 'THIRD_PARTY_NOTICES.md');

  if (!fs.existsSync(licensePath)) failures.push(`missing application license: ${licensePath}`);
  if (!fs.existsSync(noticesPath)) {
    failures.push(`missing third-party notices: ${noticesPath}`);
    return;
  }

  const notices = fs.readFileSync(noticesPath, 'utf8');
  for (const required of [
    'Copyright (c) 2026 justhil',
    'Copyright (c) 2026 Num Scope',
    '@earendil-works/pi-agent-core',
    // DSH host (dsh-rebase P1-2): the MIT notice of the @deepseek-ai packages.
    'Copyright (c) 2026 DeepSeek',
    // Claude Agent SDK host (route B S-4): the SDK's and its CLI's own notice.
    '© Anthropic PBC. All rights reserved.',
  ]) {
    if (!notices.includes(required)) {
      failures.push(`third-party notices are missing required attribution: ${required}`);
    }
  }
}

/** dsh-rebase P1-12 step 1: nothing of the native worker may ship. */
function checkNoRetiredResources(resourceDir, failures) {
  for (const name of RETIRED_RESOURCE_DIRS) {
    const dir = path.join(resourceDir, name);
    if (fs.existsSync(dir)) failures.push(`retired native worker resources still packaged: ${dir}`);
  }
}

/** dsh-rebase P1-12 step 3: app.asar carries no retired package and Main no runtime code. */
function checkAppAsar(resourceDir, failures) {
  const asarPath = path.join(resourceDir, 'app.asar');
  if (!fs.existsSync(asarPath)) return;
  try {
    const { header } = readAsarHeader(asarPath);
    for (const found of findAsarPackages(header, RETIRED_ASAR_PACKAGES)) {
      failures.push(`retired package still packaged in app.asar: ${found}`);
    }
    // An unpacked copy ships just the same.
    const unpacked = `${asarPath}.unpacked`;
    for (const name of RETIRED_ASAR_PACKAGES) {
      const dir = path.join(unpacked, 'node_modules', ...name.split('/'));
      if (fs.existsSync(dir)) failures.push(`retired package still packaged: ${dir}`);
    }
    const main = readAsarFile(asarPath, MAIN_BUNDLE);
    if (!main) {
      failures.push(`app.asar has no ${MAIN_BUNDLE}`);
      return;
    }
    const text = main.toString('utf8');
    for (const marker of RETIRED_MAIN_MARKERS) {
      if (text.includes(marker))
        failures.push(`${MAIN_BUNDLE} still carries runtime code: ${marker}`);
    }
  } catch (error) {
    failures.push(
      `cannot read app.asar: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

const BUILTINS = new Set(builtinModules);

/** Every package directory under any `node_modules` in the archive, nested ones included. */
function asarPackageNames(header) {
  const names = new Set();
  const visit = (node) => {
    for (const [name, child] of Object.entries(node?.files ?? {})) {
      if (name !== 'node_modules') {
        visit(child);
        continue;
      }
      for (const [pkg, pkgNode] of Object.entries(child?.files ?? {})) {
        if (pkg.startsWith('.')) continue;
        const scoped = pkg.startsWith('@') ? Object.entries(pkgNode?.files ?? {}) : null;
        for (const [inner, innerNode] of scoped ?? [[null, pkgNode]]) {
          names.add(inner ? `${pkg}/${inner}` : pkg);
          visit(innerNode);
        }
      }
    }
  };
  visit(header);
  return names;
}

/** Built JS files under a directory of the archive, as `/`-separated paths. */
function asarScripts(header, dir) {
  const files = [];
  const visit = (node, at) => {
    for (const [name, child] of Object.entries(node?.files ?? {})) {
      const here = `${at}/${name}`;
      if (child.files) visit(child, here);
      else if (/\.(c|m)?js$/.test(name)) files.push(here);
    }
  };
  visit(asarEntry(header, dir), dir);
  return files;
}

/**
 * Decision 200: app.asar carries only the packages Main loads at run time
 * (scripts/runtime-packages.mjs), all of them, and Main's bundles load
 * nothing else from node_modules.
 */
function checkRuntimePackages(resourceDir, failures) {
  const asarPath = path.join(resourceDir, 'app.asar');
  if (!fs.existsSync(asarPath)) return;
  try {
    const { header } = readAsarHeader(asarPath);
    const shipped = asarPackageNames(header);
    for (const name of [...shipped].sort()) {
      if (!isRuntimePackage(name)) {
        failures.push(`app.asar carries node_modules/${name}, which Main never loads`);
      }
    }
    for (const name of RUNTIME_PACKAGES) {
      if (!shipped.has(name)) failures.push(`app.asar is missing runtime package ${name}`);
    }
    for (const file of [
      ...asarScripts(header, 'out/main'),
      ...asarScripts(header, 'out/preload'),
    ]) {
      const source = readAsarFile(asarPath, file)?.toString('utf8') ?? '';
      for (const name of runtimeSpecifiers(source)) {
        if (BUILTINS.has(name) || MAIN_RUNTIME_ENTRIES.includes(name)) continue;
        failures.push(`${file} loads ${name} at run time; list it in scripts/runtime-packages.mjs`);
      }
    }
  } catch (error) {
    failures.push(
      `cannot check app.asar packages: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Decision 200: each runtime entry loads inside the packaged executable, run
 * as Node, from where Main resolves it (native addons included), so a package
 * the archive dropped fails here and not on a user's first terminal.
 */
function checkRuntimeLoads(executable, resourceDir, failures) {
  if (!executable || !fs.existsSync(executable)) {
    console.log(
      '[verify-packaged-app] runtime load check skipped (no executable for this platform)'
    );
    return;
  }
  const probe = path.join(repoRoot, 'scripts', 'runtime-load-probe.cjs');
  const result = spawnSync(executable, [probe, resourceDir, ...MAIN_RUNTIME_ENTRIES], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
  });
  const last = result.stdout?.trim().split(/\r?\n/).at(-1) ?? '';
  let report;
  try {
    report = JSON.parse(last);
  } catch {
    failures.push(
      `runtime load check failed (exit ${result.status}): ${(result.stderr ?? '').trim().split(/\r?\n/).slice(-3).join(' | ')}`
    );
    return;
  }
  for (const name of MAIN_RUNTIME_ENTRIES) {
    const outcome = report[name];
    if (!outcome?.ok) {
      failures.push(`runtime package ${name} does not load in the packaged app: ${outcome?.error}`);
    }
  }
  console.log(`[verify-packaged-app] runtime packages load: ${MAIN_RUNTIME_ENTRIES.join(', ')}`);
}

/** The DSH host artifact under resources/dsh-host: structure, budget, TSD header. */
function checkDshHost(resourceDir, failures) {
  const dshDir = path.join(resourceDir, 'dsh-host');
  try {
    const verified = verifyDshArtifact({
      outDir: dshDir,
      target: { platform: process.platform, arch: process.arch },
      requireManifest: true,
    });
    const verdict = evaluateDshHostArtifact(verified);
    console.log(
      `[verify-packaged-app] DSH host artifact: ${formatBytes(verified.bytes)} (${verified.bytes}B), ` +
        `${verified.files} files, ${verified.natives.length} natives${verdict.overTarget ? ' (over the 110MiB target)' : ''}`
    );
    if (verdict.status !== 'ok') {
      failures.push(`DSH host artifact over budget: ${verdict.reasons.join(', ')}`);
      for (const entry of topDirectories(path.join(dshDir, 'node_modules'), 10)) {
        console.log(
          `  ${formatBytes(entry.bytes).padStart(10)}  ${entry.name}${entry.isDirectory ? '/' : ''}`
        );
      }
    }
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
  const hostJs = path.join(dshDir, 'host.js');
  if (fs.existsSync(hostJs) && firstBytes(hostJs, 16).startsWith('%TSD')) {
    failures.push('dsh-host/host.js has a TSD header');
  }
}

/** Route B S-4: the Claude Agent SDK host under resources/claude-sdk-host. */
function checkClaudeSdkHost(resourceDir, failures) {
  const hostDir = path.join(resourceDir, 'claude-sdk-host');
  try {
    const verified = verifyClaudeSdkHostArtifact({
      outDir: hostDir,
      target: { platform: process.platform, arch: process.arch },
      requireManifest: true,
    });
    console.log(
      `[verify-packaged-app] Claude SDK host artifact: ${formatBytes(verified.bytes)} (${verified.bytes}B), ` +
        `${verified.files} files, CLI ${formatBytes(verified.cli.bytes)}` +
        `${verified.budget.overTarget ? ' (over the size target)' : ''}`
    );
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
  const hostJs = path.join(hostDir, 'host.js');
  if (fs.existsSync(hostJs) && firstBytes(hostJs, 16).startsWith('%TSD')) {
    failures.push('claude-sdk-host/host.js has a TSD header');
  }
}

/** Route B S-4 B-9: a chat turn of the packaged SDK host on the packaged node; no Electron. */
function runClaudeSdkSmoke(appDir, reportFile, failures) {
  const helper = path.join(repoRoot, 'scripts', 'packaged-claude-sdk-host-smoke.mjs');
  const report = reportFile ?? path.join(repoRoot, 'dist', 'claude-sdk-host-smoke-report.json');
  const result = spawnSync(process.execPath, [helper, '--app-dir', appDir, '--report', report], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 10 * 60_000,
    windowsHide: true,
  });
  let summary;
  try {
    summary = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? '');
  } catch {
    summary = undefined;
  }
  if (result.status !== 0 || summary?.ok !== true) {
    failures.push(
      `packaged Claude SDK host smoke failed (status=${result.status} signal=${result.signal}): ` +
        `${summary ? `failed checks ${summary.failed.join(', ')}; report ${report}` : ''} ${result.stderr}`.slice(
          -2000
        )
    );
  }
  console.log(
    `[verify-packaged-app] Claude SDK smoke: ${result.stdout.trim().split(/\r?\n/).at(-1) ?? ''}`
  );
  return { claudeSdkSmoke: summary ?? null, report };
}

/** L1 smoke of the packaged DSH host on the packaged node (decision 017); no Electron. */
function runDshSmoke(appDir, reportFile, failures) {
  const helper = path.join(repoRoot, 'scripts', 'packaged-dsh-host-smoke.mjs');
  const report = reportFile ?? path.join(repoRoot, 'dist', 'dsh-host-smoke-report.json');
  const result = spawnSync(
    process.execPath,
    [helper, '--app-dir', appDir, '--level', '1', '--report', report],
    { cwd: repoRoot, encoding: 'utf8', timeout: 10 * 60_000, windowsHide: true }
  );
  let summary;
  try {
    summary = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? '');
  } catch {
    summary = undefined;
  }
  if (result.status !== 0 || summary?.ok !== true) {
    failures.push(
      `packaged DSH host smoke failed (status=${result.status} signal=${result.signal}): ` +
        `${summary ? `failed checks ${summary.failed.join(', ')}; report ${report}` : ''} ${result.stderr}`.slice(
          -2000
        )
    );
  }
  console.log(
    `[verify-packaged-app] DSH smoke: ${result.stdout.trim().split(/\r?\n/).at(-1) ?? ''}`
  );
  return { dshSmoke: summary ?? null, report };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const failures = [];
  if (!fs.existsSync(args.appDir)) failures.push(`app directory does not exist: ${args.appDir}`);
  // Must stay equal to `win.executableName` in electron-builder.yml.
  // `packaging-config.test.mjs` binds the two, because a stale name here fails
  // the CI verify step only AFTER the 20-minute Windows packaging job.
  const windowsExecutable = 'PiLabAi.exe';
  if (process.platform === 'win32' && !fs.existsSync(path.join(args.appDir, windowsExecutable))) {
    failures.push(`missing ${windowsExecutable}`);
  }
  // `linux.executableName`, bound the same way; runs the runtime load check.
  const linuxExecutable = 'aiclient';
  const executable =
    process.platform === 'win32'
      ? path.join(args.appDir, windowsExecutable)
      : process.platform === 'linux'
        ? path.join(args.appDir, linuxExecutable)
        : null;

  const resourceDir =
    process.platform === 'darwin' && args.appDir.endsWith('.app')
      ? path.join(args.appDir, 'Contents', 'Resources')
      : path.join(args.appDir, 'resources');
  if (!fs.existsSync(path.join(resourceDir, 'app.asar'))) {
    failures.push(`missing packaged app archive: ${path.join(resourceDir, 'app.asar')}`);
  }

  checkLegalNotices(resourceDir, failures);

  checkNoRetiredResources(resourceDir, failures);
  checkAppAsar(resourceDir, failures);
  checkRuntimePackages(resourceDir, failures);
  checkRuntimeLoads(executable, resourceDir, failures);
  checkDshHost(resourceDir, failures);
  checkClaudeSdkHost(resourceDir, failures);
  checkNodeRuntime(resourceDir, failures);
  const reports = [];
  if (!args.skipDshSmoke && failures.length === 0) {
    reports.push(runDshSmoke(args.appDir, args.dshReportFile, failures));
  }
  if (!args.skipClaudeSdkSmoke && failures.length === 0) {
    reports.push(runClaudeSdkSmoke(args.appDir, args.claudeSdkReportFile, failures));
  }
  if (args.reportFile)
    fs.writeFileSync(
      args.reportFile,
      `${JSON.stringify({ appDir: args.appDir, reports, failures }, null, 2)}\n`
    );
  if (args.skipDshSmoke) console.log('[verify-packaged-app] DSH smoke skipped (--skip-dsh-smoke)');
  if (args.skipClaudeSdkSmoke) {
    console.log('[verify-packaged-app] Claude SDK smoke skipped (--skip-claude-sdk-smoke)');
  }

  if (failures.length > 0) {
    console.error(`[verify-packaged-app] FAIL — ${failures.join('\n---\n')}`);
    process.exit(1);
  }
  console.log(
    '[verify-packaged-app] PASS — legal notices + no native worker or runtime + runtime packages + DSH host artifact + Claude SDK host artifact + the smokes that ran'
  );
}

try {
  main();
} catch (error) {
  console.error(`[verify-packaged-app] FAIL — ${error instanceof Error ? error.stack : error}`);
  process.exit(1);
}
