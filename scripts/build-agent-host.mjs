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
 * Pruning rationale lives in docs/plans/ledger-claude-mainline.md (C-01):
 *   - @anthropic-ai/claude-agent-sdk-<platform>: 252MB fallback claude.exe;
 *     dead code because we always pass pathToClaudeCodeExecutable.
 *   - @cometix/claude-code-<platform>: install-time source only; postinstall
 *     copies cli.js + vendor/ into the main package.
 *   - node-pty: keep package.json + lib + prebuilds/<platform>-<arch>
 *     (mirrors the root electron-builder extraResources precedent).
 *   - browser-sdk.js, *.ts/.d.ts, *.map, *.md, LICENSE, .bin: never read at runtime.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hostRoot = path.join(repoRoot, 'src', 'agent-host');
const hostNodeModules = path.join(hostRoot, 'node_modules');
const outDir = path.join(repoRoot, 'out-agent-host');

function fail(message) {
  console.error(`[build-agent-host] ERROR: ${message}`);
  process.exit(1);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// ---------------------------------------------------------------------------
// Preflight: the copy source must be a healthy pinned install.
// ---------------------------------------------------------------------------
function preflight() {
  if (!fs.existsSync(hostNodeModules)) {
    fail(`missing ${hostNodeModules} — run "npm install" in src/agent-host first`);
  }

  const hostPkg = readJson(path.join(hostRoot, 'package.json'));
  const pins = {
    '@cometix/claude-code': hostPkg.dependencies?.['@cometix/claude-code'],
    '@anthropic-ai/claude-agent-sdk': hostPkg.dependencies?.['@anthropic-ai/claude-agent-sdk'],
  };
  for (const [name, pin] of Object.entries(pins)) {
    if (!pin) fail(`src/agent-host/package.json does not declare ${name}`);
    if (/^[\^~]/.test(pin)) fail(`${name} must be an exact pin, got "${pin}"`);
    const installedPkgJson = path.join(hostNodeModules, name, 'package.json');
    if (!fs.existsSync(installedPkgJson)) fail(`${name} is not installed`);
    const installed = readJson(installedPkgJson).version;
    if (installed !== pin) fail(`${name} installed ${installed}, pinned ${pin}`);
  }

  // Guard against a stub install (npm install --omit=optional skips the
  // platform package, so postinstall cannot produce cli.js / vendor).
  const cometixDir = path.join(hostNodeModules, '@cometix', 'claude-code');
  const cliJs = path.join(cometixDir, 'cli.js');
  if (!fs.existsSync(cliJs)) {
    fail('cometix cli.js missing — reinstall src/agent-host WITH optional dependencies');
  }
  if (fs.statSync(cliJs).size < 5 * 1024 * 1024) {
    fail('cometix cli.js suspiciously small — broken postinstall copy?');
  }
  if (!fs.existsSync(path.join(cometixDir, 'vendor'))) {
    fail('cometix vendor/ missing — broken postinstall copy?');
  }

  const prebuild = path.join(
    hostNodeModules,
    'node-pty',
    'prebuilds',
    `${process.platform}-${process.arch}`
  );
  if (!fs.existsSync(prebuild)) {
    fail(`node-pty prebuild missing for ${process.platform}-${process.arch}`);
  }

  return pins;
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
    external: ['@anthropic-ai/claude-agent-sdk', '@cometix/claude-code'],
  });
}

// ---------------------------------------------------------------------------
// Pruned node_modules copy.
// ---------------------------------------------------------------------------
function topPackage(parts) {
  return parts[0].startsWith('@') && parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0];
}

function shouldCopy(rel) {
  if (rel === '') return true;
  const parts = rel.split('/');
  const top = topPackage(parts);

  if (parts[0] === '.bin' || parts[0] === '.package-lock.json') return false;
  if (/^@anthropic-ai\/claude-agent-sdk-.+/.test(top)) return false;
  if (/^@cometix\/claude-code-.+/.test(top)) return false;
  if (parts[0] === '@img' && parts.length >= 2) {
    if (top !== `@img/sharp-${process.platform}-${process.arch}`) return false;
  }

  if (parts[0] === 'node-pty' && parts.length >= 2) {
    if (parts.length === 2 && parts[1] === 'package.json') return true;
    if (parts[1] === 'lib') return true;
    if (parts[1] === 'prebuilds') {
      if (parts.length === 2) return true;
      return parts[2] === `${process.platform}-${process.arch}`;
    }
    return false;
  }

  if (rel === '@anthropic-ai/claude-agent-sdk/browser-sdk.js') return false;

  // Cometix vendor ships runtime assets (ripgrep etc.) — keep verbatim.
  if (rel.startsWith('@cometix/claude-code/vendor/')) return true;

  const base = parts[parts.length - 1];
  if (/^licen[cs]e(\.|$)/i.test(base)) return false;
  if (
    base.endsWith('.ts') ||
    base.endsWith('.d.mts') ||
    base.endsWith('.d.cts') ||
    base.endsWith('.map') ||
    base.endsWith('.md')
  ) {
    return false;
  }
  return true;
}

function copyNodeModules() {
  fs.cpSync(hostNodeModules, path.join(outDir, 'node_modules'), {
    recursive: true,
    filter: (source) => {
      const rel = path.relative(hostNodeModules, source).split(path.sep).join('/');
      return shouldCopy(rel);
    },
  });
}

// ---------------------------------------------------------------------------
// Verification + reporting.
// ---------------------------------------------------------------------------
function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(full);
    else total += fs.statSync(full).size;
  }
  return total;
}

function verifyArtifact(pins) {
  const mustExist = [
    'index.js',
    'package.json',
    'node_modules/@cometix/claude-code/cli.js',
    'node_modules/@cometix/claude-code/vendor',
    'node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs',
    `node_modules/node-pty/prebuilds/${process.platform}-${process.arch}`,
  ];
  for (const rel of mustExist) {
    if (!fs.existsSync(path.join(outDir, rel))) fail(`artifact incomplete: missing ${rel}`);
  }
  const mustNotExist = [
    `node_modules/@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`,
    `node_modules/@cometix/claude-code-${process.platform}-${process.arch}`,
  ];
  for (const rel of mustNotExist) {
    if (fs.existsSync(path.join(outDir, rel))) fail(`prune failed: ${rel} still present`);
  }
  const mb = (dirSize(outDir) / 1024 / 1024).toFixed(1);
  console.log(
    `[build-agent-host] OK — ${mb}MB at out-agent-host/ ` +
      `(cometix ${pins['@cometix/claude-code']}, sdk ${pins['@anthropic-ai/claude-agent-sdk']})`
  );
}

// On Windows with TEC OCular Agent, .js files written by Node are TSD-encrypted.
// The bundled index.js is rewritten via .tmp.bin + PowerShell copy so the
// artifact stays portable (same pattern as winTsdFixPlugin / afterPack.mjs).
// node_modules copies are fixed later by afterPack on the final resources dir.
function tsdFixBundleOnWindows() {
  if (process.platform !== 'win32') return;
  const target = path.join(outDir, 'index.js');
  fs.writeFileSync(`${target}.tmp.bin`, fs.readFileSync(target));
  const psScript =
    `[System.IO.File]::Copy('${target}.tmp.bin','${target}',$true); ` +
    `Remove-Item '${target}.tmp.bin' -Force`;
  const b64 = Buffer.from(psScript, 'utf16le').toString('base64');
  execSync(`powershell -EncodedCommand ${b64}`, { stdio: 'pipe' });
}

async function main() {
  const started = Date.now();
  const pins = preflight();

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  await bundle();
  fs.writeFileSync(
    path.join(outDir, 'package.json'),
    `${JSON.stringify({ name: 'aiclient-agent-host-artifact', private: true, type: 'module' }, null, 2)}\n`
  );
  copyNodeModules();
  tsdFixBundleOnWindows();
  verifyArtifact(pins);
  console.log(`[build-agent-host] done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

await main();
