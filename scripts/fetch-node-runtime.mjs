#!/usr/bin/env node
/**
 * Fetch + verify the pinned Node.js runtime bundled into the packaged
 * Windows app (C-15 / D17).
 *
 * Downloads the official win-x64 zip (falling back to a mirror), verifies
 * its SHA-256 against the pin in node-runtime-pin.mjs, extracts node.exe
 * into out-node-runtime/, and sanity-checks `node.exe --version`.
 *
 * Idempotent: a matching out-node-runtime/PIN.json skips the network
 * round-trip entirely. Pass --force to refetch regardless.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NODE_RUNTIME_PIN } from './node-runtime-pin.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const outDir = join(repoRoot, 'out-node-runtime');
const nodeExePath = join(outDir, 'node.exe');
const pinJsonPath = join(outDir, 'PIN.json');

function fail(message) {
  console.error(`[fetch-node-runtime] ERROR: ${message}`);
  process.exit(1);
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function fileExists(filePath) {
  const info = await stat(filePath).catch(() => null);
  return info?.isFile() ?? false;
}

async function alreadySatisfied() {
  if (!(await fileExists(nodeExePath)) || !(await fileExists(pinJsonPath))) return false;
  try {
    const pin = JSON.parse(await readFile(pinJsonPath, 'utf8'));
    return pin.version === NODE_RUNTIME_PIN.version;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Download + checksum. A checksum mismatch is a hard failure (not retried on
// the mirror) since it indicates a corrupted/tampered download, not a
// transient network issue.
// ---------------------------------------------------------------------------
async function downloadZip(destinationPath) {
  const networkErrors = [];
  for (const url of NODE_RUNTIME_PIN.urls) {
    console.log(`[fetch-node-runtime] downloading ${url}`);
    let response;
    try {
      response = await fetch(url, {
        headers: { 'User-Agent': 'AiClient Node Runtime Fetcher' },
      });
      if (!response.ok || !response.body) {
        throw new Error(`${response.status} ${response.statusText}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[fetch-node-runtime] failed to fetch ${url}: ${message}`);
      networkErrors.push(`${url}: ${message}`);
      continue;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    await writeFile(destinationPath, buffer);

    const actual = await sha256File(destinationPath);
    if (actual !== NODE_RUNTIME_PIN.zipSha256) {
      await rm(destinationPath, { force: true });
      fail(
        `checksum mismatch downloading ${url}\n` +
          `  expected: ${NODE_RUNTIME_PIN.zipSha256}\n` +
          `  actual:   ${actual}`
      );
    }
    return url;
  }

  fail(
    `all download URLs failed:\n  ${networkErrors.join('\n  ')}\n` +
      `If offline, manually place the zip at ${destinationPath} and re-run.`
  );
}

// ---------------------------------------------------------------------------
// Extraction. Windows 10+ / windows-2022 CI runners ship bsdtar (libarchive)
// at %SystemRoot%\System32\tar.exe, which understands .zip archives and
// Windows drive-letter paths. Prefer that exact binary: a "tar" resolved via
// PATH may instead hit Git for Windows' bundled GNU tar (no zip support, and
// it misparses "D:\..." as a "host:path" remote-tar spec).
// ---------------------------------------------------------------------------
function resolveTarCommand() {
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
    const bsdtarPath = join(systemRoot, 'System32', 'tar.exe');
    if (existsSync(bsdtarPath)) return bsdtarPath;
  }
  return 'tar';
}

async function extractNodeExe(zipPath, extractDir) {
  const tarCommand = resolveTarCommand();
  try {
    execFileSync(tarCommand, ['-xf', zipPath, '-C', extractDir], {
      stdio: 'pipe',
      windowsHide: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`"${tarCommand}" failed to extract the Node runtime zip: ${message}`);
  }

  const folderName = NODE_RUNTIME_PIN.zipName.replace(/\.zip$/, '');
  const extractedExe = join(extractDir, folderName, 'node.exe');
  if (!(await fileExists(extractedExe))) {
    fail(`extracted archive is missing ${folderName}/node.exe`);
  }
  return extractedExe;
}

async function main() {
  const force = process.argv.includes('--force');

  if (!force && (await alreadySatisfied())) {
    console.log(
      `[fetch-node-runtime] skip — out-node-runtime/node.exe already matches pin v${NODE_RUNTIME_PIN.version}`
    );
    return;
  }

  await mkdir(outDir, { recursive: true });

  const zipPath = join(outDir, `.tmp-${NODE_RUNTIME_PIN.zipName}`);
  await rm(zipPath, { force: true });

  const fetchedFrom = await downloadZip(zipPath);

  const extractDir = await mkdtemp(join(tmpdir(), 'aiclient-node-runtime-'));
  try {
    const extractedExe = await extractNodeExe(zipPath, extractDir);
    await copyFile(extractedExe, nodeExePath);
  } finally {
    await rm(extractDir, { recursive: true, force: true }).catch(() => {});
    await rm(zipPath, { force: true }).catch(() => {});
  }

  const versionOutput = execFileSync(nodeExePath, ['--version'], {
    windowsHide: true,
    encoding: 'utf8',
  }).trim();
  const expectedVersion = `v${NODE_RUNTIME_PIN.version}`;
  if (versionOutput !== expectedVersion) {
    fail(`node.exe --version reported "${versionOutput}", expected "${expectedVersion}"`);
  }

  await writeFile(
    pinJsonPath,
    `${JSON.stringify(
      { version: NODE_RUNTIME_PIN.version, zipSha256: NODE_RUNTIME_PIN.zipSha256, fetchedFrom },
      null,
      2
    )}\n`,
    'utf8'
  );

  const mb = ((await stat(nodeExePath)).size / 1024 / 1024).toFixed(1);
  console.log(
    `[fetch-node-runtime] OK — ${expectedVersion} (${mb}MB) at out-node-runtime/node.exe (from ${fetchedFrom})`
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(`[fetch-node-runtime] ERROR: ${message}`);
  process.exit(1);
});
