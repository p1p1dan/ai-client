/**
 * C-02: automated verification of the packaged app's Agent Host.
 *
 * Usage:
 *   node scripts/verify-packaged-app.mjs [--app-dir dist/win-unpacked] [--skip-smoke]
 *
 * Checks:
 *   1. App shell: executable + resources/app.asar present.
 *   2. resources/agent-host structure: same mustExist/mustNotExist contract as
 *      scripts/build-agent-host.mjs, plus TSD-header sanity (files must be
 *      plain bytes, not "%TSD-Header..." — catches shipping encrypted output).
 *   3. Node 24 resolution: light replica of NodeRuntimeResolver's search order
 *      (AICLIENT_NODE24_PATH → nvm roots → PATH), proving a packaged install
 *      on this machine can find a runtime for the Host.
 *   4. Bundled Node runtime (win32, C-15): resources/node-runtime/node.exe
 *      present and --version matches the pin; the PONG smoke below prefers it
 *      over machine Node, proving a Node-less user machine still works.
 *   5. PONG smoke against resources/agent-host/index.js — reuses
 *      spikes/phase2-sdk-runtime-smoke.ts (shared test gateway credentials via
 *      testCredentials.ts). Retries once: gateway model flakes ≠ packaging bugs.
 *
 * Env:
 *   AICLIENT_NODE24_PATH             explicit Node 24 binary
 *   AICLIENT_SMOKE_USE_LOCAL_SETTINGS=1  use ~/.claude settings (debug only)
 *   AICLIENT_TEST_AUTH_TOKEN / AICLIENT_TEST_BASE_URL  override gateway creds
 */

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NODE_RUNTIME_PIN } from './node-runtime-pin.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = { appDir: path.join(repoRoot, 'dist', 'win-unpacked'), skipSmoke: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--app-dir') {
      args.appDir = path.resolve(argv[i + 1] ?? '');
      i += 1;
    } else if (argv[i] === '--skip-smoke') {
      args.skipSmoke = true;
    } else {
      console.error(`[verify-packaged-app] unknown argument: ${argv[i]}`);
      process.exit(1);
    }
  }
  return args;
}

const failures = [];
function check(label, ok, detail = '') {
  const suffix = detail ? ` (${detail})` : '';
  if (ok) {
    console.log(`  ok   ${label}${suffix}`);
  } else {
    console.log(`  FAIL ${label}${suffix}`);
    failures.push(label);
  }
  return ok;
}

function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(full);
    else total += fs.statSync(full).size;
  }
  return total;
}

function firstBytes(file, n) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(n);
    const read = fs.readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, read).toString('latin1');
  } finally {
    fs.closeSync(fd);
  }
}

function expectedCometixPin() {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'src', 'agent-host', 'package.json'), 'utf8')
  );
  return pkg.dependencies?.['@cometix/claude-code'] ?? '';
}

// ---------------------------------------------------------------------------
// 1 + 2: structure checks
// ---------------------------------------------------------------------------
function checkStructure(appDir) {
  console.log(`[verify-packaged-app] app dir: ${appDir}`);
  if (!check('app dir exists', fs.existsSync(appDir))) return;

  if (process.platform === 'win32') {
    check('AiClient.exe present', fs.existsSync(path.join(appDir, 'AiClient.exe')));
  }
  check('resources/app.asar present', fs.existsSync(path.join(appDir, 'resources', 'app.asar')));

  const hostDir = path.join(appDir, 'resources', 'agent-host');
  if (!check('resources/agent-host present', fs.existsSync(hostDir))) return;

  const platformArch = `${process.platform}-${process.arch}`;
  const mustExist = [
    'index.js',
    'package.json',
    'node_modules/@cometix/claude-code/cli.js',
    'node_modules/@cometix/claude-code/vendor',
    'node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs',
  ];
  for (const rel of mustExist) {
    check(`agent-host/${rel}`, fs.existsSync(path.join(hostDir, rel)));
  }
  check(
    'agent-host node-pty native binary',
    fs.existsSync(path.join(hostDir, 'node_modules', 'node-pty', 'prebuilds', platformArch)) ||
      fs.existsSync(path.join(hostDir, 'node_modules', 'node-pty', 'build', 'Release'))
  );
  const mustNotExist = [
    `node_modules/@anthropic-ai/claude-agent-sdk-${platformArch}`,
    `node_modules/@cometix/claude-code-${platformArch}`,
    'node_modules/.bin',
    'node_modules/@anthropic-ai/claude-agent-sdk/browser-sdk.js',
  ];
  for (const rel of mustNotExist) {
    check(`pruned: no agent-host/${rel}`, !fs.existsSync(path.join(hostDir, rel)));
  }

  const artifactPkg = path.join(hostDir, 'package.json');
  if (fs.existsSync(artifactPkg)) {
    const type = JSON.parse(fs.readFileSync(artifactPkg, 'utf8')).type;
    check('agent-host package.json type=module', type === 'module');
  }

  const cliJs = path.join(hostDir, 'node_modules', '@cometix', 'claude-code', 'cli.js');
  if (fs.existsSync(cliJs)) {
    check('cometix cli.js > 5MB', fs.statSync(cliJs).size > 5 * 1024 * 1024);
  }

  // TSD sanity: shipped files must be plain bytes readable by any process.
  for (const rel of ['index.js', 'node_modules/@cometix/claude-code/cli.js']) {
    const file = path.join(hostDir, rel);
    if (fs.existsSync(file)) {
      check(`no TSD header in ${rel}`, !firstBytes(file, 16).startsWith('%TSD'));
    }
  }

  const mb = (dirSize(hostDir) / 1024 / 1024).toFixed(1);
  console.log(`[verify-packaged-app] resources/agent-host size: ${mb}MB`);
}

// ---------------------------------------------------------------------------
// 3: Node 24 resolution (light replica of NodeRuntimeResolver's order)
// ---------------------------------------------------------------------------
function node24Candidates() {
  const home = os.homedir();
  const binary = process.platform === 'win32' ? 'node.exe' : 'node';
  const candidates = [];
  if (process.env.AICLIENT_NODE24_PATH) {
    candidates.push({ path: process.env.AICLIENT_NODE24_PATH, source: 'env' });
  }

  const nvmRoots = [];
  if (process.env.NVM_HOME) nvmRoots.push(process.env.NVM_HOME);
  if (process.platform === 'win32') {
    nvmRoots.push(
      path.join(home, 'AppData', 'Local', 'nvm'),
      path.join(home, 'AppData', 'Roaming', 'nvm'),
      'C:\\nvm4w'
    );
  } else {
    nvmRoots.push(path.join(home, '.nvm', 'versions', 'node'));
  }
  for (const root of nvmRoots) {
    if (!fs.existsSync(root)) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    const versions = entries
      .filter((name) => /^v?24\./.test(name))
      .sort()
      .reverse();
    for (const v of versions) {
      candidates.push({ path: path.join(root, v, binary), source: 'nvm' });
    }
  }

  const pathEnv = process.env.PATH ?? process.env.Path ?? '';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (dir.trim()) candidates.push({ path: path.join(dir.trim(), binary), source: 'path' });
  }
  return candidates;
}

function resolveNode24() {
  for (const candidate of node24Candidates()) {
    if (!fs.existsSync(candidate.path)) continue;
    try {
      const version = execFileSync(candidate.path, ['--version'], {
        timeout: 8000,
        windowsHide: true,
      })
        .toString()
        .trim();
      if (/^v24\./.test(version)) {
        return { execPath: candidate.path, version, source: candidate.source };
      }
    } catch {
      // keep probing
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 3.5: Bundled Node runtime (C-15) — exists, version-pinned, runnable.
// ---------------------------------------------------------------------------
function checkNodeRuntime(appDir) {
  if (process.platform !== 'win32') return null;
  const execPath = path.join(appDir, 'resources', 'node-runtime', 'node.exe');
  if (!check('bundled node.exe present (resources/node-runtime)', fs.existsSync(execPath))) {
    return null;
  }
  let version = '';
  try {
    version = execFileSync(execPath, ['--version'], { timeout: 8000, windowsHide: true })
      .toString()
      .trim();
  } catch (err) {
    check('bundled node.exe runnable', false, String(err));
    return null;
  }
  const expected = `v${NODE_RUNTIME_PIN.version}`;
  if (!check(`bundled node version ${expected}`, version === expected, `got ${version}`)) {
    return null;
  }
  const mb = (fs.statSync(execPath).size / (1024 * 1024)).toFixed(1);
  console.log(`[verify-packaged-app] bundled node.exe: ${version}, ${mb}MB`);
  return { execPath, version, source: 'bundled' };
}

// ---------------------------------------------------------------------------
// 4: PONG smoke via the existing spike, pointed at the packaged host entry.
// ---------------------------------------------------------------------------
function runSmokeOnce(node24, hostEntry) {
  return new Promise((resolve) => {
    const child = spawn(
      node24.execPath,
      [
        '--experimental-strip-types',
        path.join(repoRoot, 'src', 'agent-host', 'spikes', 'phase2-sdk-runtime-smoke.ts'),
      ],
      {
        cwd: path.join(repoRoot, 'src', 'agent-host'),
        env: {
          ...process.env,
          AICLIENT_SMOKE_HOST_ENTRY: hostEntry,
          AICLIENT_NODE24: node24.execPath,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (buf) => {
      stdout += buf.toString('utf8');
    });
    child.stderr.on('data', (buf) => {
      stderr += buf.toString('utf8');
    });
    child.on('close', () => {
      try {
        resolve({ report: JSON.parse(stdout), stderr });
      } catch {
        resolve({ report: null, stderr: `${stderr}\n--- unparseable stdout ---\n${stdout}` });
      }
    });
  });
}

async function checkSmoke(appDir, node24) {
  const hostEntry = path.join(appDir, 'resources', 'agent-host', 'index.js');
  const pin = expectedCometixPin();

  let result = await runSmokeOnce(node24, hostEntry);
  if (!result.report?.ok) {
    console.log('[verify-packaged-app] smoke attempt 1 failed — retrying once (network flake?)');
    result = await runSmokeOnce(node24, hostEntry);
  }

  const report = result.report;
  if (!check('packaged host PONG smoke ok', report?.ok === true)) {
    console.log(`--- smoke report ---\n${JSON.stringify(report, null, 2)}`);
    console.log(`--- smoke stderr tail ---\n${result.stderr.slice(-1200)}`);
    return;
  }
  const ready = report.hostReady ?? {};
  check(`host.ready cometixVersion=${pin}`, ready.cometixVersion === pin);
  check('assistant replied PONG', String(report.assistantPreview).includes('PONG'));
}

// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));

  checkStructure(args.appDir);

  const bundled = checkNodeRuntime(args.appDir);

  const node24 = resolveNode24();
  check(
    'Node 24 resolvable (packaged-state search order)',
    Boolean(node24) || Boolean(bundled),
    node24
      ? `${node24.version} via ${node24.source}: ${node24.execPath}`
      : 'machine none; bundled only'
  );

  // Bundled runtime first (C-15): proves a user machine without Node works.
  const smokeRuntime = bundled ?? node24;
  if (!args.skipSmoke && smokeRuntime && failures.length === 0) {
    console.log(
      `[verify-packaged-app] smoke runtime: ${smokeRuntime.source} ${smokeRuntime.execPath}`
    );
    await checkSmoke(args.appDir, smokeRuntime);
  } else if (args.skipSmoke) {
    console.log('[verify-packaged-app] smoke skipped (--skip-smoke)');
  } else if (failures.length > 0) {
    console.log('[verify-packaged-app] smoke skipped — structure checks failed');
  } else {
    console.log('[verify-packaged-app] smoke skipped — no runtime available');
  }

  if (failures.length > 0) {
    console.error(
      `[verify-packaged-app] FAIL — ${failures.length} check(s): ${failures.join('; ')}`
    );
    process.exit(1);
  }
  console.log('[verify-packaged-app] PASS');
}

await main();
