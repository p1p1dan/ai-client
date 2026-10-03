/**
 * Verify a packaged app: legal notices, the bundled Node runtime and the DSH
 * host artifact (dsh-rebase P1-2), then the DSH host's L1 smoke on the
 * packaged node (`--skip-dsh-smoke` skips it; it needs no Electron).
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
 */

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findAsarPackages, readAsarFile, readAsarHeader } from './asar-inspect.mjs';
import { verifyDshArtifact } from './dsh-host-build-lib.mjs';
import { NODE_RUNTIME_VERSION, nodeRuntimePinFor } from './node-runtime-pin.mjs';
import { evaluateDshHostArtifact, formatBytes, topDirectories } from './packaging-budget.mjs';

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
    reportFile: null,
    dshReportFile: null,
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
    '@earendil-works/pi-coding-agent',
    // DSH host (dsh-rebase P1-2): the MIT notice of the @deepseek-ai packages.
    'Copyright (c) 2026 DeepSeek',
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
  checkDshHost(resourceDir, failures);
  checkNodeRuntime(resourceDir, failures);
  const reports = [];
  if (!args.skipDshSmoke && failures.length === 0) {
    reports.push(runDshSmoke(args.appDir, args.dshReportFile, failures));
  }
  if (args.reportFile)
    fs.writeFileSync(
      args.reportFile,
      `${JSON.stringify({ appDir: args.appDir, reports, failures }, null, 2)}\n`
    );
  if (args.skipDshSmoke) console.log('[verify-packaged-app] DSH smoke skipped (--skip-dsh-smoke)');

  if (failures.length > 0) {
    console.error(`[verify-packaged-app] FAIL — ${failures.join('\n---\n')}`);
    process.exit(1);
  }
  console.log(
    '[verify-packaged-app] PASS — legal notices + no native worker or runtime + DSH host artifact + DSH smoke if it ran'
  );
}

try {
  main();
} catch (error) {
  console.error(`[verify-packaged-app] FAIL — ${error instanceof Error ? error.stack : error}`);
  process.exit(1);
}
