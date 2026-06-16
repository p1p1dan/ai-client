#!/usr/bin/env node
/**
 * DEPRECATED — prefer `scripts/prepare-vflow-resources.mjs`.
 *
 * This script still works and is kept for back-compatibility with the original
 * "sibling repo" workflow (the developer has a checkout of the vflow repo as a
 * sibling directory of this project). For the new default — packing
 * `@p1p1dan/vflow` from GitHub Packages so neither CI nor a freshly cloned
 * project requires a sibling vflow checkout — use:
 *
 *     pnpm prepare:vflow                          # default: from GitHub Packages
 *     pnpm prepare:vflow --from-sibling ../vflow  # equivalent to this script
 *
 * Keeping this file around so that anyone who scripted around it (e.g. a
 * "develop vflow against client" dev loop) is not broken; new build pipelines
 * should target prepare-vflow-resources.mjs only.
 *
 * --- ORIGINAL DOCS ---
 * Sync vflow template resources from the vflow repo into resources/vflow/
 * AND produce an offline npm tgz at resources/vflow-pkg/ as a fallback for
 * `npm install -g` when the public registry is unreachable.
 *
 * Usage: node scripts/sync-vflow-resources.mjs [path-to-vflow-repo]
 * Default vflow repo path: ../vflow (sibling directory)
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

const vflowRepo = process.argv[2] || path.resolve(PROJECT_ROOT, '..', 'vflow');
const vflowSrc = path.join(vflowRepo, 'src', 'vflow');
const dst = path.join(PROJECT_ROOT, 'resources', 'vflow');
const pkgDst = path.join(PROJECT_ROOT, 'resources', 'vflow-pkg');

function copytree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copytree(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

if (!fs.existsSync(vflowSrc)) {
  console.error(`[sync-vflow] vflow source not found: ${vflowSrc}`);
  process.exit(1);
}

if (fs.existsSync(dst)) {
  fs.rmSync(dst, { recursive: true, force: true });
}

fs.mkdirSync(dst, { recursive: true });

// Copy cli.mjs and detect.mjs
fs.copyFileSync(path.join(vflowSrc, 'cli.mjs'), path.join(dst, 'cli.mjs'));
fs.copyFileSync(path.join(vflowSrc, 'detect.mjs'), path.join(dst, 'detect.mjs'));

// Copy template directories
copytree(path.join(vflowSrc, 'template_vflow'), path.join(dst, 'template_vflow'));
copytree(path.join(vflowSrc, 'template_claude'), path.join(dst, 'template_claude'));

const count = fs.readdirSync(dst, { recursive: true }).length;
console.log(`[sync-vflow] Synced ${count} entries to resources/vflow/`);

// Run `npm pack` against the vflow repo so we have an offline installable tgz.
// AgentInstaller falls back to `npm install -g <tgz>` when the public registry
// is unreachable.
if (fs.existsSync(pkgDst)) {
  fs.rmSync(pkgDst, { recursive: true, force: true });
}
fs.mkdirSync(pkgDst, { recursive: true });

const isWindows = process.platform === 'win32';
const npmCommand = isWindows ? 'npm.cmd' : 'npm';
const packResult = spawnSync(npmCommand, ['pack', '--pack-destination', pkgDst], {
  cwd: vflowRepo,
  stdio: ['ignore', 'pipe', 'pipe'],
  encoding: 'utf-8',
  shell: isWindows,
});

if (packResult.status !== 0) {
  console.error(`[sync-vflow] npm pack failed (exit ${packResult.status}):`);
  console.error(packResult.stderr || packResult.stdout || '<no output>');
  process.exit(1);
}

const tgzEntries = fs
  .readdirSync(pkgDst)
  .filter((name) => name.endsWith('.tgz'));

if (tgzEntries.length === 0) {
  console.error('[sync-vflow] npm pack succeeded but no .tgz produced');
  process.exit(1);
}

for (const name of tgzEntries) {
  const size = fs.statSync(path.join(pkgDst, name)).size;
  if (size <= 0) {
    console.error(`[sync-vflow] tgz is empty: ${name}`);
    process.exit(1);
  }
  console.log(`[sync-vflow] Packed ${name} (${size} bytes) into resources/vflow-pkg/`);
}
