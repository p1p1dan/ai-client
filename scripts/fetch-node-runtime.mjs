#!/usr/bin/env node
/**
 * Fetch + verify the pinned Node.js runtime bundled into the packaged app
 * (C-15 / D17, multi-platform since D36).
 *
 * Downloads the official archive for the target platform (falling back to a
 * mirror), verifies its SHA-256 against the pin in node-runtime-pin.mjs,
 * extracts the node binary into out-node-runtime/, and sanity-checks
 * `<binary> --version`.
 *
 *   node scripts/fetch-node-runtime.mjs                      # host platform
 *   node scripts/fetch-node-runtime.mjs --platform linux-x64 # explicit
 *   node scripts/fetch-node-runtime.mjs --force              # ignore the cache
 *
 * A platform with no pin (mac today) prints a skip notice and exits 0 — NOT a
 * failure. `dist:prereq` chains this into build:mac/build:mac:unsigned/
 * build:mac:debug, and "mac is out of scope for this batch" must not mean
 * "the mac build now breaks" (packaging spec §5.3).
 *
 * Idempotent: a matching out-node-runtime/PIN.json skips the network
 * round-trip entirely. The cache is keyed on version AND platform, so a win
 * cache can never masquerade as a linux one.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NODE_RUNTIME_VERSION, nodeRuntimePinFor } from './node-runtime-pin.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const outDir = join(repoRoot, 'out-node-runtime');
const pinJsonPath = join(outDir, 'PIN.json');

/** `--platform <key>`, defaulting to the host. */
function resolveTargetPin(argv) {
  const flagIndex = argv.indexOf('--platform');
  if (flagIndex === -1) {
    return {
      key: `${process.platform}-${process.arch}`,
      pin: nodeRuntimePinFor(process.platform, process.arch),
    };
  }
  const key = argv[flagIndex + 1];
  if (!key) fail('--platform requires a value, e.g. --platform linux-x64');
  const [platform, arch] = key.split('-');
  return { key, pin: nodeRuntimePinFor(platform, arch) };
}

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

async function alreadySatisfied(pin, outPath) {
  if (!(await fileExists(outPath)) || !(await fileExists(pinJsonPath))) return false;
  try {
    const cached = JSON.parse(await readFile(pinJsonPath, 'utf8'));
    // Both fields: version alone would let a win-x64 cache satisfy a linux-x64
    // request, silently shipping node.exe inside a Linux package.
    return cached.version === NODE_RUNTIME_VERSION && cached.platformKey === pin.platformKey;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Download + checksum. A checksum mismatch is a hard failure (not retried on
// the mirror) since it indicates a corrupted/tampered download, not a
// transient network issue.
// ---------------------------------------------------------------------------
async function downloadArchive(pin, destinationPath) {
  const networkErrors = [];
  for (const url of pin.urls) {
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
    if (actual !== pin.sha256) {
      await rm(destinationPath, { force: true });
      fail(
        `checksum mismatch downloading ${url}\n` +
          `  expected: ${pin.sha256}\n` +
          `  actual:   ${actual}`
      );
    }
    return url;
  }

  fail(
    `all download URLs failed:\n  ${networkErrors.join('\n  ')}\n` +
      `If offline, manually place the archive at ${destinationPath} and re-run.`
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

async function extractNodeBinary(pin, archivePath, extractDir) {
  const isTarGz = pin.archiveName.endsWith('.tar.gz');
  // .zip keeps the bsdtar path above; .tar.gz needs an explicit -z.
  const tarCommand = isTarGz ? 'tar' : resolveTarCommand();
  const args = isTarGz
    ? ['-xzf', archivePath, '-C', extractDir]
    : ['-xf', archivePath, '-C', extractDir];
  try {
    execFileSync(tarCommand, args, { stdio: 'pipe', windowsHide: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`"${tarCommand}" failed to extract the Node runtime archive: ${message}`);
  }

  const folderName = pin.archiveName.replace(/\.(zip|tar\.gz)$/, '');
  const extracted = join(extractDir, folderName, ...pin.binaryRel.split('/'));
  if (!(await fileExists(extracted))) {
    fail(`extracted archive is missing ${folderName}/${pin.binaryRel}`);
  }
  return extracted;
}

async function main() {
  const force = process.argv.includes('--force');
  const { key, pin } = resolveTargetPin(process.argv);

  // No pin for this platform: skip, do not fail. See the header note.
  if (!pin) {
    console.log(
      `[fetch-node-runtime] skip — no bundled Node runtime pinned for ${key}; ` +
        `the app will fall back to machine Node discovery on this platform.`
    );
    return;
  }

  const outPath = join(outDir, pin.outName);

  if (!force && (await alreadySatisfied(pin, outPath))) {
    console.log(
      `[fetch-node-runtime] skip — out-node-runtime/${pin.outName} already matches ` +
        `pin v${NODE_RUNTIME_VERSION} (${pin.platformKey})`
    );
    return;
  }

  await mkdir(outDir, { recursive: true });

  const archivePath = join(outDir, `.tmp-${pin.archiveName}`);
  await rm(archivePath, { force: true });

  const fetchedFrom = await downloadArchive(pin, archivePath);

  const extractDir = await mkdtemp(join(tmpdir(), 'aiclient-node-runtime-'));
  try {
    const extracted = await extractNodeBinary(pin, archivePath, extractDir);
    await copyFile(extracted, outPath);
  } finally {
    await rm(extractDir, { recursive: true, force: true }).catch(() => {});
    await rm(archivePath, { force: true }).catch(() => {});
  }

  // copyFile preserves mode, but assert rather than assume: without the exec
  // bit the version check below fails with a bare EACCES that names nothing.
  if (process.platform !== 'win32' && pin.outName !== 'node.exe') {
    const mode = (await stat(outPath)).mode;
    if ((mode & 0o111) === 0) {
      fail(
        `extracted ${pin.outName} is not executable (mode ${(mode & 0o777).toString(8)}) — ` +
          `the archive or the copy lost the exec bit`
      );
    }
  }

  // Only self-check when the binary can actually run on this host.
  const runnable = pin.platformKey === `${process.platform}-${process.arch}`;
  const expectedVersion = `v${NODE_RUNTIME_VERSION}`;
  if (runnable) {
    const versionOutput = execFileSync(outPath, ['--version'], {
      windowsHide: true,
      encoding: 'utf8',
    }).trim();
    if (versionOutput !== expectedVersion) {
      fail(`${pin.outName} --version reported "${versionOutput}", expected "${expectedVersion}"`);
    }
  } else {
    console.log(
      `[fetch-node-runtime] note — cross-platform fetch (${pin.platformKey} on ` +
        `${process.platform}-${process.arch}); skipping the --version self-check`
    );
  }

  await writeFile(
    pinJsonPath,
    `${JSON.stringify(
      {
        version: NODE_RUNTIME_VERSION,
        platformKey: pin.platformKey,
        sha256: pin.sha256,
        outName: pin.outName,
        fetchedFrom,
      },
      null,
      2
    )}\n`,
    'utf8'
  );

  const mb = ((await stat(outPath)).size / 1024 / 1024).toFixed(1);
  console.log(
    `[fetch-node-runtime] OK — ${expectedVersion} ${pin.platformKey} (${mb}MB) at ` +
      `out-node-runtime/${pin.outName} (from ${fetchedFrom})`
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(`[fetch-node-runtime] ERROR: ${message}`);
  process.exit(1);
});
