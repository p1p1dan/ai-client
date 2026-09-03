/** Verify a packaged app's worker-only Pi runtime payload. */

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyArtifact } from './agent-host-build-lib.mjs';
import { NODE_RUNTIME_VERSION, nodeRuntimePinFor } from './node-runtime-pin.mjs';
import { evaluateWorkerArtifactSize, formatBytes, topDirectories } from './packaging-budget.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

function parseArgs(argv) {
  const args = { appDir: path.join(repoRoot, 'dist', 'win-unpacked'), skipSmoke: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--app-dir') {
      args.appDir = path.resolve(argv[i + 1] ?? '');
      i += 1;
    } else if (argv[i] === '--skip-smoke') {
      args.skipSmoke = true;
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
  ]) {
    if (!notices.includes(required)) {
      failures.push(`third-party notices are missing required attribution: ${required}`);
    }
  }
}

function runWorkerSmoke(workerPath, failures) {
  let electronPath;
  try {
    electronPath = require('electron');
  } catch (error) {
    failures.push(`Electron binary is unavailable for worker smoke: ${String(error)}`);
    return;
  }
  const helper = path.join(repoRoot, 'scripts', 'packaged-worker-smoke.cjs');
  const result = spawnSync(electronPath, ['--no-sandbox', helper, workerPath], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
  });
  if (result.status !== 0) {
    failures.push(
      `packaged worker bootstrap/dispose smoke failed (status=${result.status} signal=${result.signal}): ` +
        `${result.stderr || result.stdout}`.slice(-2000)
    );
    return;
  }
  let report;
  try {
    const line = result.stdout.trim().split(/\r?\n/).at(-1) ?? '';
    report = JSON.parse(line);
  } catch {
    failures.push(`packaged worker smoke returned invalid JSON: ${result.stdout.slice(-1000)}`);
    return;
  }
  if (report.ok !== true || !Number.isSafeInteger(report.workerPid)) {
    failures.push(`packaged worker smoke returned an invalid result: ${JSON.stringify(report)}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const failures = [];
  if (!fs.existsSync(args.appDir)) failures.push(`app directory does not exist: ${args.appDir}`);
  if (process.platform === 'win32' && !fs.existsSync(path.join(args.appDir, 'AiClient.exe'))) {
    failures.push('missing AiClient.exe');
  }

  const resourceDir =
    process.platform === 'darwin' && args.appDir.endsWith('.app')
      ? path.join(args.appDir, 'Contents', 'Resources')
      : path.join(args.appDir, 'resources');
  if (!fs.existsSync(path.join(resourceDir, 'app.asar'))) {
    failures.push(`missing packaged app archive: ${path.join(resourceDir, 'app.asar')}`);
  }

  checkLegalNotices(resourceDir, failures);

  const hostDir = path.join(resourceDir, 'agent-host');
  try {
    verifyArtifact({ outDir: hostDir });
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }

  const workerPath = path.join(hostDir, 'worker.js');
  if (fs.existsSync(workerPath) && firstBytes(workerPath, 16).startsWith('%TSD')) {
    failures.push('agent-host/worker.js has a TSD header');
  }
  if (fs.existsSync(hostDir)) {
    const totalBytes = fs.readdirSync(hostDir, { withFileTypes: true }).reduce((total, entry) => {
      const target = path.join(hostDir, entry.name);
      const measure = (value) => {
        const stat = fs.statSync(value);
        if (stat.isFile()) return stat.size;
        return fs
          .readdirSync(value)
          .reduce((sum, name) => sum + measure(path.join(value, name)), 0);
      };
      return total + measure(target);
    }, 0);
    const verdict = evaluateWorkerArtifactSize(totalBytes);
    console.log(
      `[verify-packaged-app] worker artifact: ${formatBytes(totalBytes)} (${totalBytes}B)`
    );
    if (verdict.status !== 'ok') {
      failures.push(
        `worker artifact exceeds ${formatBytes(verdict.ceiling)} safety ceiling: ${formatBytes(totalBytes)}`
      );
      for (const entry of topDirectories(hostDir, 10)) {
        console.log(
          `  ${formatBytes(entry.bytes).padStart(10)}  ${entry.name}${entry.isDirectory ? '/' : ''}`
        );
      }
    }
  }

  checkNodeRuntime(resourceDir, failures);
  if (!args.skipSmoke && failures.length === 0) runWorkerSmoke(workerPath, failures);
  if (args.skipSmoke) console.log('[verify-packaged-app] worker smoke skipped (--skip-smoke)');

  if (failures.length > 0) {
    console.error(`[verify-packaged-app] FAIL — ${failures.join('\n---\n')}`);
    process.exit(1);
  }
  console.log(
    '[verify-packaged-app] PASS — legal notices + worker-only artifact + bootstrap/dispose/exit'
  );
}

try {
  main();
} catch (error) {
  console.error(`[verify-packaged-app] FAIL — ${error instanceof Error ? error.stack : error}`);
  process.exit(1);
}
