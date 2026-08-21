/**
 * Print the shipped Codex payload, file by file, and always exit 0.
 *
 * This is the evidence half of the spec §11-Q1 two-step: the Windows vendor
 * layout, the per-file byte counts and `codex.exe`'s real size are unmeasured,
 * and a run that dies inside a hard gate produces none of them. Observation
 * needs a producer of its own, not just softened assertions.
 *
 * Usage: node scripts/inspect-codex-payload.mjs [--dir <node_modules dir>]
 * Defaults to src/agent-host/node_modules (the npm ci tree, pre-build).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { codexPlatformPkgCandidates } from './codex-platform.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseDir(argv) {
  const i = argv.indexOf('--dir');
  if (i !== -1 && argv[i + 1]) return path.resolve(argv[i + 1]);
  return path.join(repoRoot, 'src', 'agent-host', 'node_modules');
}

const nodeModules = parseDir(process.argv.slice(2));
const platform = process.platform;
const arch = process.arch;
const log = (line) => console.log(`[inspect-codex-payload] ${line}`);

log(`platform=${platform}-${arch} dir=${nodeModules}`);

if (!fs.existsSync(nodeModules)) {
  log('node_modules does not exist — nothing to inspect');
  process.exit(0);
}

// Hoisted vs nested: spec §10.3 lists "npm hoists the platform package" as a
// hardcoded belief with contradictory evidence. This prints both answers.
for (const rel of ['@openai', '@openai/codex/node_modules/@openai']) {
  const dir = path.join(nodeModules, ...rel.split('/'));
  log(`ls ${rel}: ${fs.existsSync(dir) ? fs.readdirSync(dir).join(' ') || '(empty)' : '(absent)'}`);
}

/** Every file under dir, relative + bytes + mode — the §11-Q1 deliverable. */
function walk(dir, base = '') {
  let files = 0;
  let bytes = 0;
  for (const entry of fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = walk(full, rel);
      files += sub.files;
      bytes += sub.bytes;
    } else {
      const st = fs.statSync(full);
      files += 1;
      bytes += st.size;
      log(`  ${String(st.size).padStart(12)}B  ${(st.mode & 0o777).toString(8)}  ${rel}`);
    }
  }
  return { files, bytes };
}

for (const rel of ['@openai/codex', ...codexPlatformPkgCandidates(platform, arch)]) {
  const dir = path.join(nodeModules, ...rel.split('/'));
  if (!fs.existsSync(dir)) {
    log(`${rel}: absent`);
    continue;
  }
  log(`--- ${rel} ---`);
  const { files, bytes } = walk(dir);
  log(`${rel}: ${files} file(s), ${bytes}B total`);
}

// The manifest verbatim: pathDir/resourcesDir/entrypoint are read from it
// rather than hardcoded, so its real Windows content is what unblocks Q1-①.
for (const rel of codexPlatformPkgCandidates(platform, arch)) {
  const vendor = path.join(nodeModules, ...rel.split('/'), 'vendor');
  if (!fs.existsSync(vendor)) continue;
  for (const triple of fs.readdirSync(vendor)) {
    const manifest = path.join(vendor, triple, 'codex-package.json');
    if (!fs.existsSync(manifest)) continue;
    log(`manifest ${rel}/vendor/${triple}/codex-package.json:`);
    console.log(fs.readFileSync(manifest, 'utf8'));
  }
}
