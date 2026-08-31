/**
 * Build the worker-only Pi AgentSession artifact shipped via electron-builder.
 *
 * Output layout (out-agent-host/):
 *   worker.js      per-slot Pi utility worker entry
 *   package.json   ESM marker
 *   node_modules/  pruned Pi SDK + permission-system runtime dependencies
 *
 * The artifact stays as plain files under resources/agent-host so the utility
 * process can load it directly and Windows TSD remediation can inspect it.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  dirSize,
  ESBUILD_EXTERNAL,
  preflightHostDeps,
  shouldCopy,
  verifyArtifact,
  writeBundledPermissionPolicy,
} from './agent-host-build-lib.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hostRoot = path.join(repoRoot, 'src', 'agent-host');
const hostNodeModules = path.join(hostRoot, 'node_modules');
const outDir = path.join(repoRoot, 'out-agent-host');
const platform = process.platform;
const arch = process.arch;

function fail(message) {
  console.error(`[build-agent-host] ERROR: ${message}`);
  process.exit(1);
}

function guard(label, fn) {
  try {
    return fn();
  } catch (error) {
    fail(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function bundle() {
  let esbuild;
  try {
    esbuild = await import('esbuild');
  } catch {
    fail('esbuild not resolvable from repo root — run "pnpm install" first');
  }
  await esbuild.build({
    entryPoints: [path.join(hostRoot, 'worker.ts')],
    outfile: path.join(outDir, 'worker.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    sourcemap: false,
    external: ESBUILD_EXTERNAL,
  });
}

function copyNodeModules() {
  const destRoot = path.join(outDir, 'node_modules');
  const walk = (relDir) => {
    const srcDir = relDir === '' ? hostNodeModules : path.join(hostNodeModules, relDir);
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
      const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      if (!shouldCopy(rel, { platform, arch })) continue;
      const src = path.join(hostNodeModules, rel);
      const dest = path.join(destRoot, rel);
      const stat = entry.isSymbolicLink() ? fs.statSync(src) : entry;
      if (stat.isDirectory()) {
        fs.mkdirSync(dest, { recursive: true });
        walk(rel);
      } else if (stat.isFile()) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
      }
    }
  };
  fs.mkdirSync(destRoot, { recursive: true });
  walk('');
}

function tsdFixWorkerOnWindows() {
  if (platform !== 'win32') return;
  const target = path.join(outDir, 'worker.js');
  fs.writeFileSync(`${target}.tmp.bin`, fs.readFileSync(target));
  const psScript =
    `[System.IO.File]::Copy('${target}.tmp.bin','${target}',$true); ` +
    `Remove-Item '${target}.tmp.bin' -Force`;
  const b64 = Buffer.from(psScript, 'utf16le').toString('base64');
  execSync(`powershell -EncodedCommand ${b64}`, { stdio: 'pipe' });
}

async function main() {
  const started = Date.now();
  const { installed } = guard('preflight', () => preflightHostDeps({ root: repoRoot }));

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  await bundle();
  fs.writeFileSync(
    path.join(outDir, 'package.json'),
    `${JSON.stringify({ name: 'aiclient-pi-worker-artifact', private: true, type: 'module' }, null, 2)}\n`
  );
  copyNodeModules();
  guard('policy', () => writeBundledPermissionPolicy(outDir));
  tsdFixWorkerOnWindows();
  const { totalBytes } = guard('verify', () => verifyArtifact({ outDir }));
  const measuredBytes = dirSize(outDir);
  if (measuredBytes !== totalBytes) fail('artifact size changed during verification');

  console.log(
    `[build-agent-host] OK — ${(totalBytes / 1024 / 1024).toFixed(1)}MiB (${totalBytes}B), ` +
      `worker-only, pi ${installed['@earendil-works/pi-coding-agent']}, ` +
      `permission ${installed['@gotgenes/pi-permission-system']}`
  );
  console.log(`[build-agent-host] done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

await main();
