/**
 * Build the Agent Host artifact shipped via electron-builder extraResources.
 *
 * Output layout (out-agent-host/):
 *   index.js       esbuild bundle of src/agent-host/index.ts (ESM, node)
 *   package.json   {"type":"module"} so index.js runs as ESM
 *   node_modules/  pruned copy of src/agent-host/node_modules
 *
 * The artifact must stay plain files under resources/agent-host (never asar):
 * on TSD-encrypted machines only the whitelisted external node.exe can read it.
 *
 * This file is the CLI shell: orchestration and IO only. Every decision
 * (preflight rules, copy filter, prune rules, artifact assertions) lives in
 * ./agent-host-build-lib.mjs so vitest can exercise it without running a real
 * build — see docs/plans/2026-08-19-stage4-packaging-spec.md §9 (改判 ②).
 *
 * Pruning rationale lives in docs/plans/ledger-claude-mainline.md (C-01):
 *   - @anthropic-ai/claude-agent-sdk-<platform>: 252MB fallback claude.exe;
 *     dead code because we always pass pathToClaudeCodeExecutable.
 *   - @cometix/claude-code-<platform>: install-time source only; postinstall
 *     copies cli.js + vendor/ into the main package.
 *   - @openai/codex-<platform>: only the current platform's package ships;
 *     each foreign variant costs ~347MB (spec §3.4).
 *   - node-pty: keep package.json + lib + prebuilds/<platform>-<arch>
 *     (mirrors the root electron-builder extraResources precedent).
 *   - browser-sdk.js, *.ts/.d.ts, *.map, *.md, LICENSE, .bin: never read at runtime.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  dirSize,
  ESBUILD_EXTERNAL,
  hasNodePtyPrebuild,
  preflightHostDeps,
  pruneResidualPlatformPackages,
  shouldCopy,
  verifyArtifact,
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

/** Run a lib function that throws on failure, mapping the throw to exit 1. */
function guard(label, fn) {
  try {
    return fn();
  } catch (error) {
    fail(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ---------------------------------------------------------------------------
// Bundle host sources (shared/types get inlined; SDK + Cometix stay external
// and resolve from the sibling node_modules at runtime).
// ---------------------------------------------------------------------------
async function bundle() {
  let esbuild;
  try {
    esbuild = await import('esbuild');
  } catch {
    fail('esbuild not resolvable from repo root — run "pnpm install" first');
  }
  await esbuild.build({
    entryPoints: [path.join(hostRoot, 'index.ts')],
    outfile: path.join(outDir, 'index.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    sourcemap: false,
    external: ESBUILD_EXTERNAL,
  });
}

// Hand-rolled recursive copy instead of fs.cpSync({filter}): on the Windows
// CI runner cpSync demonstrably ignored the filter wholesale (runs
// 31860506141 / 31861138363, 2026-08-15 — .bin, browser-sdk.js, .ts/.md and
// the 252MB platform packages all shipped; the identical code filters
// correctly on Linux). Walking ourselves makes the include/exclude decision
// platform-independent: `rel` is built with '/' directly, no path.sep games.
// Symlinks are dereferenced (nothing load-bearing links out of the tree; a
// copied dangling link would be strictly worse).
function copyNodeModules() {
  const hasPtyPrebuild = hasNodePtyPrebuild({ hostNodeModules, platform, arch });
  const destRoot = path.join(outDir, 'node_modules');
  const walk = (relDir) => {
    const srcDir = relDir === '' ? hostNodeModules : path.join(hostNodeModules, relDir);
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
      const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      if (!shouldCopy(rel, { platform, arch, hasPtyPrebuild })) continue;
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

// On Windows with TEC OCular Agent, .js files written by Node are TSD-encrypted.
// The bundled index.js is rewritten via .tmp.bin + PowerShell copy so the
// artifact stays portable (same pattern as winTsdFixPlugin / afterPack.mjs).
// node_modules copies are fixed later by afterPack on the final resources dir.
function tsdFixBundleOnWindows() {
  if (platform !== 'win32') return;
  const target = path.join(outDir, 'index.js');
  fs.writeFileSync(`${target}.tmp.bin`, fs.readFileSync(target));
  const psScript =
    `[System.IO.File]::Copy('${target}.tmp.bin','${target}',$true); ` +
    `Remove-Item '${target}.tmp.bin' -Force`;
  const b64 = Buffer.from(psScript, 'utf16le').toString('base64');
  execSync(`powershell -EncodedCommand ${b64}`, { stdio: 'pipe' });
}

/** Report line carries the raw codex byte count so every CI run leaves a size
 * baseline for the packaging gate to regress against (spec §3.6). */
function reportOk({ pins, codexBytes, codexPayloadBytes, codexPkgRel }) {
  const totalBytes = dirSize(outDir);
  const mb = (totalBytes / 1024 / 1024).toFixed(1);
  const parts = [
    `cometix ${pins['@cometix/claude-code']}`,
    `sdk ${pins['@anthropic-ai/claude-agent-sdk']}`,
  ];
  if (codexPkgRel) {
    parts.push(`codex ${pins['@openai/codex']}/${platform}-${arch} entry ${codexBytes}B`);
  } else {
    parts.push(`codex not shipped for ${platform}-${arch}`);
  }
  // Both budget terms, already split. Spec §6.3 defines P as the whole @openai
  // payload, so a line carrying only the total and the entry binary cannot be
  // decomposed into A0 and P — and PACKAGING_BUDGET needs both.
  if (codexPayloadBytes !== null && codexPayloadBytes !== undefined) {
    console.log(
      `[build-agent-host] budget terms for PACKAGING_BUDGET['${platform}-${arch}']: ` +
        `baseAgentHost=${totalBytes - codexPayloadBytes}B codexPayload=${codexPayloadBytes}B ` +
        `(total ${totalBytes}B = A0 + P)`
    );
  }
  // Exact byte count alongside the MB: the packaging budget (packaging spec
  // §6.3) is filled in from this line, and a rounded MB would bake half a
  // megabyte of headroom that was never measured into the gate.
  console.log(
    `[build-agent-host] OK — ${mb}MB (${totalBytes}B) at out-agent-host/ (${parts.join(', ')})`
  );
}

/** Spec §11-Q1 first-run observation. Inert on platforms already listed in
 * CODEX_MEASURED_PLATFORMS, so leaving this flag in a workflow cannot soften a
 * platform that already has evidence. */
const observe = process.argv.slice(2).includes('--observe');

function reportObservations(stage, observations) {
  if (!observations?.length) return;
  console.log(
    `[build-agent-host] OBSERVE (${stage}, spec §11-Q1) — ${observations.length} unmet ` +
      `expectation(s) recorded instead of failing; fill in the real values, then drop --observe:`
  );
  for (const line of observations) console.log(`    - ${line}`);
}

async function main() {
  const started = Date.now();
  if (observe) console.log(`[build-agent-host] --observe requested for ${platform}-${arch}`);
  const {
    pins,
    codexPkgRel: sourceCodexRel,
    codexSkipped,
    observations: preflightObservations,
  } = guard('preflight', () => preflightHostDeps({ root: repoRoot, platform, arch, observe }));
  reportObservations('preflight', preflightObservations);
  if (codexSkipped) {
    console.log(`[build-agent-host] skip: codex not shipped for ${codexSkipped}`);
  } else {
    console.log(`[build-agent-host] codex platform package: ${sourceCodexRel}`);
  }

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  await bundle();
  fs.writeFileSync(
    path.join(outDir, 'package.json'),
    `${JSON.stringify({ name: 'aiclient-agent-host-artifact', private: true, type: 'module' }, null, 2)}\n`
  );
  copyNodeModules();
  pruneResidualPlatformPackages({ outDir, platform, arch });
  tsdFixBundleOnWindows();
  const {
    codexBytes,
    codexPayloadBytes,
    codexPkgRel,
    observations: verifyObservations,
  } = guard('verify', () => verifyArtifact({ outDir, platform, arch, pins, observe }));
  reportObservations('verify', verifyObservations);
  reportOk({ pins, codexBytes, codexPayloadBytes, codexPkgRel });
  console.log(`[build-agent-host] done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

await main();
