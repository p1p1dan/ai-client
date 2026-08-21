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
import {
  foreignCodexPlatformRels,
  q1ObserveApplies,
  resolveCodexPlatformPkgRel,
} from './agent-host-build-lib.mjs';
import {
  codexBinaryName,
  codexPlatformKey,
  codexTargetTriple,
  isCodexShippedPlatform,
} from './codex-platform.mjs';
import { describeExit, isCleanExit, samePathText } from './codex-smoke-lib.mjs';
import { NODE_RUNTIME_VERSION, nodeRuntimePinFor } from './node-runtime-pin.mjs';
import {
  evaluateAgentHostSize,
  evaluateAppDirSize,
  evaluateCodexBinarySize,
  formatBytes,
  topDirectories,
} from './packaging-budget.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = {
    appDir: path.join(repoRoot, 'dist', 'win-unpacked'),
    skipSmoke: false,
    skipCodexSmoke: false,
    observe: false,
    codexPin: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--app-dir') {
      args.appDir = path.resolve(argv[i + 1] ?? '');
      i += 1;
    } else if (argv[i] === '--skip-smoke') {
      args.skipSmoke = true;
    } else if (argv[i] === '--observe') {
      // Spec §11-Q1 step one. Inert on a platform already in
      // CODEX_MEASURED_PLATFORMS, so it cannot soften a measured platform.
      args.observe = true;
    } else if (argv[i] === '--codex-pin') {
      // For runs outside the repo (encrypted-machine spot checks): the expected
      // version has to come from somewhere that is NOT the tree under test.
      args.codexPin = argv[i + 1] ?? '';
      i += 1;
    } else if (argv[i] === '--skip-codex-smoke') {
      // Independent of --skip-smoke on purpose: lets D36/D41 troubleshooting
      // disable just this section without losing the Claude-side smoke.
      args.skipCodexSmoke = true;
    } else {
      console.error(`[verify-packaged-app] unknown argument: ${argv[i]}`);
      process.exit(1);
    }
  }
  return args;
}

const failures = [];
const observations = [];
/** True while spec §11-Q1 observation is in effect for THIS platform. Set once
 * in main() so every Q1 call site stays a one-liner. */
let q1Observing = false;

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

/**
 * A check on a spec §11-Q1 zero-evidence item: the Windows vendor layout, the
 * 200 MiB floor, and `codex.exe --version`'s exact output. On an unmeasured
 * platform a miss is RECORDED, not failed — the first run exists to produce
 * those readings, and dying on them yields no evidence at all. Returns whether
 * it passed, so callers can still skip dependent work.
 */
function checkQ1(label, ok, detail = '') {
  if (ok || !q1Observing) return check(label, ok, detail);
  const suffix = detail ? ` (${detail})` : '';
  console.log(`  OBS  ${label}${suffix}`);
  observations.push(`${label}${suffix}`);
  return false;
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

/**
 * The codex pin as declared by the REPO, or --codex-pin. Never read from the
 * packaged tree: an expected value taken from the artifact under test makes the
 * assertion self-satisfying — main package, platform package, manifest and the
 * native binary can all drift together to another version and still agree.
 */
function expectedCodexPin(override) {
  if (override) return override;
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'src', 'agent-host', 'package.json'), 'utf8')
    );
    return pkg.dependencies?.['@openai/codex'] ?? null;
  } catch {
    return null;
  }
}

function isDirectory(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function readJsonOrNull(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
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
/** Raw leading bytes, for magic-number checks. */
function firstBytesBuffer(file, n) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(n);
    const read = fs.readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * D9 — a path counts as a usable file only when it IS a file with content.
 * `existsSync` says yes to a same-named directory and to a zero-byte stub.
 */
function isUsableFile(file) {
  try {
    const st = fs.statSync(file);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

/**
 * D2 — TSD header scan.
 *
 * Deliberately has NO `if (exists)` guard: the previous shape produced no
 * assertion at all when the file was missing, so the check silently evaporated
 * exactly when something was wrong (spec §10.1 "同名空壳"). Every path passed
 * here is one mustExist already asserted, so a missing file is a real failure.
 */
function checkNoTsdHeader(label, file) {
  if (!fs.existsSync(file)) {
    check(`no TSD header in ${label}`, false, 'file missing');
    return;
  }
  check(`no TSD header in ${label}`, !firstBytes(file, 16).startsWith('%TSD'));
}

/**
 * The §3.6 mustExist/mustNotExist contract, re-asserted on the PACKAGED tree.
 * Shares codex-platform.mjs and agent-host-build-lib.mjs with the build-time
 * verifier rather than restating the table — a second copy would drift.
 */
function checkCodexStructure(hostDir, codexPin) {
  const platform = process.platform;
  const arch = process.arch;
  const nodeModules = path.join(hostDir, 'node_modules');

  if (!isCodexShippedPlatform(platform, arch)) {
    // Whitelist arm (mac): nothing from @openai may ship at all (改判 ⑧).
    check(
      `pruned: no agent-host/node_modules/@openai (codex not shipped for ${platform}-${arch})`,
      !fs.existsSync(path.join(nodeModules, '@openai'))
    );
    return null;
  }

  const key = codexPlatformKey(platform, arch);
  const triple = codexTargetTriple(platform, arch);

  const launcher = path.join(nodeModules, '@openai', 'codex', 'bin', 'codex.js');
  // D9: isUsableFile, not existsSync — a directory named codex.js would pass
  // the latter and then fail at spawn time with a useless error.
  check('agent-host codex launcher (bin/codex.js is a real file)', isUsableFile(launcher));
  check(
    'pruned: no agent-host/node_modules/@openai/codex/vendor',
    !fs.existsSync(path.join(nodeModules, '@openai', 'codex', 'vendor')),
    'main package must have no vendor dir'
  );

  // The main package.json is load-bearing at RUNTIME, not metadata: codex.js
  // locates the platform package through require.resolve('<pkg>/package.json'),
  // which needs this file and the platform one. Asserting them here keeps the
  // structure section standing on its own under --skip-codex-smoke.
  const mainPkgJson = path.join(nodeModules, '@openai', 'codex', 'package.json');
  if (
    check('agent-host codex main package.json (require.resolve entry)', isUsableFile(mainPkgJson))
  ) {
    const version = readJsonOrNull(mainPkgJson)?.version;
    check(
      `codex main package version === repo pin ${codexPin}`,
      Boolean(codexPin) && version === codexPin,
      `got ${version}`
    );
  }

  const pkgRel = resolveCodexPlatformPkgRel(nodeModules, platform, arch);
  if (!check(`agent-host codex platform package (${key})`, Boolean(pkgRel))) return null;

  const pkgDir = path.join(nodeModules, ...pkgRel.split('/'));
  const vendorDir = path.join(pkgDir, 'vendor', triple);
  const manifestPath = path.join(vendorDir, 'codex-package.json');

  // Second half of the require.resolve target, plus the §0.3-A alias version.
  const platformPkgJson = path.join(pkgDir, 'package.json');
  if (check(`agent-host codex platform package.json (${key})`, isUsableFile(platformPkgJson))) {
    const version = readJsonOrNull(platformPkgJson)?.version;
    const expected = codexPin ? `${codexPin}-${key}` : null;
    check(
      `codex platform package version === ${expected}`,
      Boolean(expected) && version === expected,
      `got ${version}`
    );
  }

  let manifest = null;
  if (checkQ1(`agent-host codex vendor manifest (${triple})`, isUsableFile(manifestPath))) {
    manifest = readJsonOrNull(manifestPath);
    check(
      'codex vendor manifest target matches this platform',
      manifest?.target === triple,
      `got ${manifest?.target}`
    );
    // Third copy of the version. Asserting only `target` here left the packaged
    // verifier blind to a whole-tree drift onto another version.
    check(
      `codex vendor manifest version === repo pin ${codexPin}`,
      Boolean(codexPin) && manifest?.version === codexPin,
      `got ${manifest?.version}`
    );
    // Directory names come from the manifest, never hardcoded: the win32
    // variant's layout is unmeasured (spec §11-Q1). isDirectory, not
    // existsSync — a same-named plain file is not the directory codex reads.
    for (const dirKey of ['pathDir', 'resourcesDir']) {
      const dirName = manifest?.[dirKey];
      if (!checkQ1(`codex manifest declares ${dirKey}`, Boolean(dirName))) continue;
      checkQ1(
        `agent-host codex vendor/${dirName} is a directory (manifest.${dirKey})`,
        isDirectory(path.join(vendorDir, dirName))
      );
    }
  }

  const binName = codexBinaryName(platform);
  const entry = path.join(vendorDir, 'bin', binName);
  let codexBytes = null;
  if (check(`agent-host codex entry binary (${binName})`, isUsableFile(entry))) {
    const st = fs.statSync(entry);
    codexBytes = st.size;

    // Single-file floor: catches truncation, LFS pointers and placeholders.
    // Q1-② — codex.exe's real size has never been measured, so on an
    // unmeasured platform this reports rather than fails, and the printed bytes
    // are what CODEX_BINARY_FLOOR gets re-derived from.
    const verdict = evaluateCodexBinarySize(st.size);
    checkQ1(
      `codex entry binary >= ${formatBytes(verdict.floor)}`,
      verdict.status === 'ok',
      `${formatBytes(st.size)} (${st.size}B)`
    );

    // D1 — magic number. Stronger than "not %TSD": it also rejects truncation,
    // placeholders and anything rewritten into a different format.
    const magic = firstBytesBuffer(entry, 4);
    if (platform === 'win32') {
      check(
        'codex entry binary is a PE image (MZ)',
        magic.subarray(0, 2).toString('latin1') === 'MZ',
        magic.toString('hex')
      );
    } else {
      check(
        'codex entry binary is an ELF image (\x7fELF)',
        magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])),
        magic.toString('hex')
      );
      // D3 — exec bit at the end of the packaging chain.
      check(
        'codex entry binary is executable',
        (st.mode & 0o111) !== 0,
        `mode ${(st.mode & 0o777).toString(8)}`
      );
    }
  }

  // Kept on purpose (spec §3.5) — assert so nobody prunes it as an obvious
  // 44MiB saving without redoing that analysis.
  const hostBin = path.join(
    vendorDir,
    'bin',
    platform === 'win32' ? 'codex-code-mode-host.exe' : 'codex-code-mode-host'
  );
  check('agent-host codex code-mode host present', isUsableFile(hostBin), 'spec §3.5 keeps this');

  // D2 — TSD scan over the codex files. afterPack.fixTsdEncryption only
  // rewrites .js/.cjs/.mjs, so the native binaries never pass through it: that
  // is "implicitly correct" and has never been verified at this size on a real
  // TSD machine. This makes it explicit.
  checkNoTsdHeader('codex bin/codex.js', launcher);
  checkNoTsdHeader(`codex vendor/${triple}/bin/${binName}`, entry);
  checkNoTsdHeader(`codex vendor/${triple}/bin/${path.basename(hostBin)}`, hostBin);

  // Foreign platform packages, both layouts (spec §3.6-9: 5 platforms x 2).
  for (const rel of foreignCodexPlatformRels(platform, arch)) {
    check(
      `pruned: no agent-host/node_modules/${rel}`,
      !fs.existsSync(path.join(nodeModules, ...rel.split('/'))),
      'foreign platform package'
    );
  }

  // `P` for the spec §6.3 secondary gate: the whole shipped @openai payload,
  // the same term build-agent-host reports for the budget table.
  const openaiDir = path.join(nodeModules, '@openai');
  const codexPayloadBytes = fs.existsSync(openaiDir) ? dirSize(openaiDir) : null;

  return { pkgRel, codexBytes, codexPayloadBytes };
}

function checkStructure(appDir, codexPin) {
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
  // No exists guard — these are mustExist paths asserted just above, and the
  // old guarded form produced no assertion at all when the file was missing.
  for (const rel of ['index.js', 'node_modules/@cometix/claude-code/cli.js']) {
    checkNoTsdHeader(rel, path.join(hostDir, rel));
  }

  const codex = checkCodexStructure(hostDir, codexPin);

  // ---- Size gate (REQ-14, spec §6.3) -------------------------------------
  const totalBytes = dirSize(hostDir);
  const platformKey = `${process.platform}-${process.arch}`;
  const verdict = evaluateAgentHostSize(platformKey, totalBytes);
  console.log(
    `[verify-packaged-app] resources/agent-host size: ${formatBytes(totalBytes)} (${totalBytes}B)`
  );

  if (verdict.status === 'no-budget') {
    // Not a pass. Budgets are filled in from a real run's measured bytes; a
    // platform with none is PENDING, and saying "ok" here would let it read
    // as green forever (spec §11-Q1 two-step).
    console.log(
      `[verify-packaged-app] PENDING size budget for ${platformKey} — ` +
        `no measured baseline yet. Fill PACKAGING_BUDGET['${platformKey}'] in ` +
        `scripts/packaging-budget.mjs from the bytes printed above, then this ` +
        `gate becomes enforcing.`
    );
  } else {
    const range = `${formatBytes(verdict.floor)}..${formatBytes(verdict.ceiling)}`;
    const ok = check(
      `agent-host size within budget (${range})`,
      verdict.status === 'ok',
      formatBytes(totalBytes)
    );
    if (!ok) {
      // D7 — a gate that says "12MB over" without saying who grew makes the
      // next person re-derive the breakdown by hand.
      const why = verdict.status === 'over' ? 'over ceiling' : 'under floor';
      console.log(`[verify-packaged-app] size breakdown (${why}), top 10 by bytes:`);
      for (const entry of topDirectories(hostDir, 10)) {
        console.log(
          `    ${formatBytes(entry.bytes).padStart(10)}  ${entry.name}${entry.isDirectory ? '/' : ''}`
        );
      }
      const nm = path.join(hostDir, 'node_modules');
      if (fs.existsSync(nm)) {
        console.log('[verify-packaged-app] node_modules top 10:');
        for (const entry of topDirectories(nm, 10)) {
          console.log(
            `    ${formatBytes(entry.bytes).padStart(10)}  node_modules/${entry.name}${entry.isDirectory ? '/' : ''}`
          );
        }
      }
    }
  }

  return codex;
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
  const pin = nodeRuntimePinFor(process.platform, process.arch);
  if (!pin) return null;
  const execPath = path.join(appDir, 'resources', 'node-runtime', pin.outName);
  if (!check(`bundled ${pin.outName} present (resources/node-runtime)`, fs.existsSync(execPath))) {
    return null;
  }
  if (process.platform !== 'win32') {
    const mode = fs.statSync(execPath).mode;
    if (
      !check(
        `bundled ${pin.outName} executable`,
        (mode & 0o111) !== 0,
        `mode ${(mode & 0o777).toString(8)}`
      )
    ) {
      return null;
    }
  }
  let version = '';
  try {
    version = execFileSync(execPath, ['--version'], { timeout: 8000, windowsHide: true })
      .toString()
      .trim();
  } catch (err) {
    check(`bundled ${pin.outName} runnable`, false, String(err));
    return null;
  }
  const expected = `v${NODE_RUNTIME_VERSION}`;
  if (!check(`bundled node version ${expected}`, version === expected, `got ${version}`)) {
    return null;
  }
  const mb = (fs.statSync(execPath).size / (1024 * 1024)).toFixed(1);
  console.log(`[verify-packaged-app] bundled ${pin.outName}: ${version}, ${mb}MB`);
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
// 4.5: Codex smoke — two zero-quota levels (spec §6.2). Neither spends credit
// nor needs credentials; the real-turn level (S3) stays out of CI entirely.
// ---------------------------------------------------------------------------

/** Response and exit budgets are timed SEPARATELY: one combined timeout would
 * misdiagnose "replied but never exits" as "never started". Seeds are the 10x
 * band over the measured 178-188ms initialize; refill from real runs. */
const CODEX_RESPONSE_TIMEOUT_MS = 2000;
const CODEX_EXIT_TIMEOUT_MS = 2000;
/** app-server is long-lived; an unbounded `stdout +=` would eat CI memory when
 * it misbehaves. The existing Claude smoke accumulates without a cap — not a
 * pattern to copy. */
const CODEX_STDOUT_BYTE_CAP = 1024 * 1024;
const CODEX_STDOUT_LINE_CAP = 200;

/**
 * Platforms whose `initialize` reply shape has actually been observed, and are
 * therefore past step one of the spec §6.2 two-step. Enforced there, observed
 * everywhere else.
 *
 * Keyed on RECORDED EVIDENCE, never on what happened at run time: branching on
 * "did it start?" is the forbidden "assert if it works, skip if it doesn't"
 * shape. A platform only joins this list once a real run's frame is pasted
 * below.
 *
 * linux-x64 observed 2026-08-20 against the packaged layout:
 *   {"id":1,"result":{"userAgent":"…/0.145.0 (Ubuntu 26.4.0; x86_64) …",
 *    "codexHome":"<the temp dir we passed>","platformFamily":"unix",
 *    "platformOs":"linux"}}  — exited cleanly after stdin close.
 * win32-x64 observed 2026-08-21 on CI run 32442630099 against the packaged
 * layout — app-server replied to `initialize` with no auth.json present, the
 * open question §10.3 flagged as "Windows: zero evidence":
 *   {"id":1,"result":{"userAgent":"aiclient-verify/0.145.0 (Windows 10.0.20348;
 *    x86_64) unknown (aiclient-verify; 0)","codexHome":"C:\\Users\\runneradmin\\
 *    AppData\\Local\\Temp\\aiclient-codex-smoke-qAWyh8","platformFamily":
 *    "windows","platformOs":"windows"}}
 * exited=true clean=true (code 0).
 */
const CODEX_S2_ENFORCED_PLATFORMS = ['linux-x64', 'win32-x64'];

/**
 * Kill the whole tree, not just the direct child. The chain is three deep —
 * node → codex.js → the native codex binary — so `child.kill()` alone leaves
 * the native process alive on the runner, where it can hold the job open.
 */
function killTree(child) {
  if (!child || child.killed) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });
    } else {
      // spawned detached, so the pid doubles as the process-group id
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

/** S1 — `node <codex.js> --version`. Proves the launcher is readable, the
 * platform package resolves, and the native binary actually executes. */
function runCodexVersionSmoke(runtime, codexJs) {
  return new Promise((resolve) => {
    const child = spawn(runtime.execPath, [codexJs, '--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      killTree(child);
      resolve({
        ok: false,
        reason: `no exit within ${CODEX_EXIT_TIMEOUT_MS * 5}ms`,
        stdout,
        stderr,
      });
    }, CODEX_EXIT_TIMEOUT_MS * 5);
    child.stdout.on('data', (b) => {
      stdout += b.toString('utf8');
    });
    child.stderr.on('data', (b) => {
      stderr += b.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: String(err), stdout, stderr });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

/** S2 — spawn `app-server`, send exactly one `initialize`, read the reply.
 * Zero quota: initialize is answered even with no credentials present. */
function runCodexAppServerSmoke(runtime, codexJs, codexHome) {
  return new Promise((resolve) => {
    const child = spawn(runtime.execPath, [codexJs, 'app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
      env: { ...process.env, CODEX_HOME: codexHome },
    });

    let buf = '';
    let bytes = 0;
    let lines = 0;
    let settled = false;
    let firstFrame = null;
    let stderr = '';

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(responseTimer);
      clearTimeout(exitTimer);
      if (!result.exited) killTree(child);
      resolve(result);
    };

    const responseTimer = setTimeout(
      () =>
        finish({
          ok: false,
          reason: `no initialize reply within ${CODEX_RESPONSE_TIMEOUT_MS}ms`,
          stderr,
        }),
      CODEX_RESPONSE_TIMEOUT_MS
    );
    let exitTimer = setTimeout(() => {}, 0);

    child.stderr.on('data', (b) => {
      stderr += b.toString('utf8').slice(0, 4096);
    });

    child.stdout.on('data', (b) => {
      bytes += b.length;
      if (bytes > CODEX_STDOUT_BYTE_CAP) {
        finish({ ok: false, reason: `stdout exceeded ${CODEX_STDOUT_BYTE_CAP}B cap`, stderr });
        return;
      }
      buf += b.toString('utf8');
      let idx = buf.indexOf('\n');
      while (idx !== -1) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        lines += 1;
        if (lines > CODEX_STDOUT_LINE_CAP) {
          finish({
            ok: false,
            reason: `stdout exceeded ${CODEX_STDOUT_LINE_CAP}-line cap`,
            stderr,
          });
          return;
        }
        if (line.trim() && firstFrame === null) {
          try {
            firstFrame = JSON.parse(line);
          } catch {
            firstFrame = { _unparsed: line.slice(0, 400) };
          }
          clearTimeout(responseTimer);
          // Got the reply; close stdin and give it its own budget to exit.
          try {
            child.stdin.end();
          } catch {
            /* already closed */
          }
          exitTimer = setTimeout(
            () =>
              finish({
                ok: true,
                frame: firstFrame,
                exited: false,
                exitClean: false,
                exitStatus: `still running after ${CODEX_EXIT_TIMEOUT_MS}ms`,
                stderr,
              }),
            CODEX_EXIT_TIMEOUT_MS
          );
        }
        idx = buf.indexOf('\n');
      }
    });

    child.on('error', (err) => finish({ ok: false, reason: String(err), exited: true, stderr }));
    // `close` fires for exit 7 and for SIGKILL exactly as it does for a clean
    // exit, so the status must be read off the event: ignoring both arguments
    // turned "exited cleanly" into "close happened", which is always true here.
    child.on('close', (code, signal) =>
      finish(
        firstFrame
          ? {
              ok: true,
              frame: firstFrame,
              exited: true,
              exitClean: isCleanExit({ code, signal }),
              exitStatus: describeExit({ code, signal }),
              stderr,
            }
          : {
              ok: false,
              reason: `exited before replying (${describeExit({ code, signal })})`,
              exited: true,
              stderr,
            }
      )
    );

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'aiclient-verify', version: '0', title: 'AiClient verify' } },
      })}\n`
    );
  });
}

async function checkCodexSmoke(appDir, runtime, codexPin) {
  const codexJs = path.join(
    appDir,
    'resources',
    'agent-host',
    'node_modules',
    '@openai',
    'codex',
    'bin',
    'codex.js'
  );
  if (!check('codex smoke: packaged launcher present', isUsableFile(codexJs))) return;

  // S1 — exact version match. `includes('codex')` would let a wrong pin pass.
  const s1 = await runCodexVersionSmoke(runtime, codexJs);
  const expected = `codex-cli ${codexPin}`;
  // Q1-③ — the exact stdout shape is measured on linux only. On an unmeasured
  // platform a mismatch is recorded together with the raw output (which is what
  // the assertion gets re-derived from) instead of failing the job. NEVER
  // relaxed to `includes`: that would let a wrong pin pass everywhere forever.
  checkQ1(
    `codex S1 smoke: --version === "${expected}"`,
    s1.ok && s1.stdout === expected,
    s1.ok
      ? `got "${s1.stdout}"`
      : `${s1.reason ?? `exit ${s1.code}`}${s1.stderr ? ` | ${s1.stderr.slice(0, 200)}` : ''}`
  );

  // S2 — three-level process chain under the packaged layout, which S1 cannot
  // prove. Observation mode on first run (spec §6.2 two-step): Windows has zero
  // evidence for app-server's behaviour without auth.json.
  // realpath, not the raw mkdtemp result: os.tmpdir() yields an 8.3 short path
  // on Windows runners and codex echoes the resolved long form, so the echo
  // assertion below would fail on the very directory we just handed it.
  const codexHome = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), 'aiclient-codex-smoke-'))
  );
  try {
    const s2 = await runCodexAppServerSmoke(runtime, codexJs, codexHome);
    const platformKey = `${process.platform}-${process.arch}`;
    const frameJson = s2.ok ? JSON.stringify(s2.frame) : '';

    // Always print the raw observation, enforced or not — this is what the
    // next platform's entry in CODEX_S2_ENFORCED_PLATFORMS gets written from.
    console.log(
      s2.ok
        ? `[verify-packaged-app] codex S2 frame (${platformKey}): exited=${s2.exited} ` +
            `clean=${s2.exitClean} (${s2.exitStatus}) ${frameJson.slice(0, 500)}`
        : `[verify-packaged-app] codex S2 failure (${platformKey}): ${s2.reason}` +
            `${s2.stderr ? ` | stderr: ${s2.stderr.slice(0, 300)}` : ''}`
    );

    if (CODEX_S2_ENFORCED_PLATFORMS.includes(platformKey)) {
      // Three-level process chain proven under the packaged layout — the half
      // S1 cannot reach. All three assertions are platform-independent
      // semantics, so they stay meaningful wherever this is turned on.
      if (check('codex S2 smoke: app-server replied to initialize', s2.ok, s2.reason ?? '')) {
        const result = s2.frame?.result ?? {};
        check(
          'codex S2 smoke: initialize echoed our CODEX_HOME',
          samePathText(result.codexHome, codexHome),
          `got ${result.codexHome}, sent ${codexHome}`
        );
        check(
          'codex S2 smoke: platformOs matches this platform',
          result.platformOs === (process.platform === 'win32' ? 'windows' : process.platform),
          `got ${result.platformOs}`
        );
        check(
          'codex S2 smoke: process exited cleanly after stdin close',
          s2.exitClean === true,
          s2.exitStatus ?? ''
        );
      }
    } else {
      console.log(
        `[verify-packaged-app] codex S2 is OBSERVE-ONLY on ${platformKey} — no recorded ` +
          `frame shape yet. Paste the frame above into CODEX_S2_ENFORCED_PLATFORMS in ` +
          `scripts/verify-packaged-app.mjs to make it enforcing (spec §6.2 two-step).`
      );
    }
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
}

/**
 * Spec §6.3 secondary gate. WARN only, never a failure: this bound is about
 * total runaway, and Electron/monaco swings unrelated to this batch must not
 * turn the packaging chain red. The measured bytes are printed either way, so
 * an unset baseline can be filled from a real run.
 */
function checkAppDirSize(appDir, structure) {
  if (!fs.existsSync(appDir)) return;
  const platformKey = `${process.platform}-${process.arch}`;
  const bytes = dirSize(appDir);
  const verdict = evaluateAppDirSize(platformKey, bytes, structure?.codexPayloadBytes ?? null);

  console.log(`[verify-packaged-app] appDir total: ${formatBytes(bytes)} (${bytes}B)`);
  if (verdict.status === 'no-baseline') {
    console.log(
      `[verify-packaged-app] PENDING appDir baseline for ${platformKey} — fill ` +
        `APP_DIR_BASELINE in scripts/packaging-budget.mjs with this platform's ` +
        `pre-codex appDir bytes to arm the spec §6.3 secondary warning.`
    );
    return;
  }
  if (verdict.status === 'over') {
    console.warn(
      `[verify-packaged-app] WARN appDir ${formatBytes(bytes)} exceeds ` +
        `${formatBytes(verdict.ceiling)} = 2 x (baseline + codex payload). ` +
        `Not a failure (spec §6.3), but something grew a lot.`
    );
  }
}

// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Observation is scoped by RECORDED EVIDENCE, not by the flag alone: on a
  // platform already in CODEX_MEASURED_PLATFORMS `--observe` does nothing, so
  // the workflow line cannot quietly soften a gate that has evidence behind it.
  q1Observing = args.observe && q1ObserveApplies(process.platform, process.arch);
  if (args.observe && !q1Observing) {
    console.log(
      `[verify-packaged-app] --observe ignored: ${process.platform}-${process.arch} is already ` +
        `measured (spec §11-Q1 step two)`
    );
  } else if (q1Observing) {
    console.log(
      `[verify-packaged-app] OBSERVE MODE for ${process.platform}-${process.arch} — spec §11-Q1 ` +
        `items report instead of failing (step one)`
    );
  }

  const codexPin = expectedCodexPin(args.codexPin);
  check(
    'codex pin resolvable from repo (not from the tree under test)',
    Boolean(codexPin),
    codexPin ?? 'pass --codex-pin <version> when running outside the repo'
  );

  const structure = checkStructure(args.appDir, codexPin);

  checkAppDirSize(args.appDir, structure);

  const bundled = checkNodeRuntime(args.appDir);

  // 改判 ④ — the load-bearing assertion of D36. A platform WITH a pin must
  // produce a working bundled runtime, asserted on its own and deliberately
  // NOT folded into the `node24 || bundled` OR below. Without this, a broken
  // bundled runtime is invisible: NodeRuntimeResolver.probeNodeBinary only
  // `continue`s past a candidate that fails to probe, so the app silently
  // falls back to machine Node, so any machine that has a usable Node on PATH
  // stays green while shipping a runtime that does not work on a bare user
  // machine.
  const runtimePin = nodeRuntimePinFor(process.platform, process.arch);
  if (runtimePin) {
    check(
      `bundled Node runtime usable for ${runtimePin.platformKey} (independent of machine Node)`,
      Boolean(bundled),
      bundled ? `${bundled.version} at ${bundled.execPath}` : 'bundled runtime missing or unusable'
    );
  }

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

  // Codex smoke sits here on purpose: it needs `bundled`, but it is NOT part of
  // the Claude smoke's condition chain below.
  if (!args.skipCodexSmoke && isCodexShippedPlatform(process.platform, process.arch)) {
    if (!smokeRuntime) {
      // Deliberately NOT the existing "skip, no runtime available" branch: on a
      // platform that HAS a pin, having no runtime is itself the D36 failure.
      check('codex smoke runtime available', false, 'no bundled or machine Node 24');
    } else if (failures.length > 0) {
      console.log('[verify-packaged-app] codex smoke skipped — structure already failed');
    } else {
      // The expected version is the repo's, never the packaged tree's: reading
      // it back out of the artifact under test made S1 self-satisfying.
      if (codexPin) await checkCodexSmoke(args.appDir, smokeRuntime, codexPin);
      else console.log('[verify-packaged-app] codex smoke skipped — no expected pin');
    }
  } else if (args.skipCodexSmoke) {
    console.log('[verify-packaged-app] codex smoke skipped (--skip-codex-smoke)');
  }

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

  if (observations.length > 0) {
    console.log(
      `[verify-packaged-app] OBSERVED ${observations.length} spec §11-Q1 item(s) — record these, ` +
        `fill in the real values, then drop --observe so they become gates:`
    );
    for (const line of observations) console.log(`    - ${line}`);
  }

  if (failures.length > 0) {
    console.error(
      `[verify-packaged-app] FAIL — ${failures.length} check(s): ${failures.join('; ')}`
    );
    process.exit(1);
  }
  console.log(
    observations.length > 0
      ? `[verify-packaged-app] PASS (with ${observations.length} observation(s) — NOT a full gate)`
      : '[verify-packaged-app] PASS'
  );
}

await main();
