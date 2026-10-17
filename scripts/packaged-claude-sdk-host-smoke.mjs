/**
 * Route B S-4 (docs/plantree/plans/claude-sdk-engine/topics/s4-packaging.md
 * B-9): the packaged Claude Agent SDK host runs chat turns.
 *
 *   node scripts/packaged-claude-sdk-host-smoke.mjs --app-dir dist/win-unpacked [--report <file>]
 *   node scripts/packaged-claude-sdk-host-smoke.mjs --host-dir out-claude-sdk-host [--node <node>]
 *
 * With `--app-dir` the bundled node (resources/node-runtime) runs
 * src/claude-sdk-host/tools/host-probe.ts, whose host is the packaged
 * resources/claude-sdk-host/host.js handed the packaged CLI binary, as Main
 * hands it (B-4). `--host-dir` checks an unpacked artifact on this node.
 *
 * Both run from a copy under `<temp>/PiLab Ai/resources`: outside the checkout,
 * so nothing resolves from the repository's node_modules, and under a path with
 * a space, as the installed `Programs\PiLab Ai` is (`--in-place` skips the copy).
 * Every model request goes to the local fake gateway (`--plan claude-sdk`),
 * started on a free port with a throwaway state and log; no key is real.
 *
 * The last stdout line is a JSON summary `{ ok, checks, failed }`; the exit
 * code is 0 only when every probe check passed.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cliBinaryRel } from './claude-sdk-host-build-lib.mjs';
import { nodeRuntimePinFor } from './node-runtime-pin.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GATEWAY = path.join(repoRoot, 'src', 'dsh-host', 'tools', 'fake-gateway.mjs');
const PROBE = path.join(repoRoot, 'src', 'claude-sdk-host', 'tools', 'host-probe.ts');
const DEFAULT_SCENARIOS = ['text', 'tools'];
/** Inside verify-packaged-app's 10 minutes, so a hang still ends in a report. */
const PROBE_TIMEOUT_MS = 8 * 60_000;
const log = (message) => console.error(`[claude-sdk-smoke] ${message}`);

function parseArgs(argv) {
  const args = {
    appDir: null,
    hostDir: null,
    node: null,
    report: null,
    scenarios: DEFAULT_SCENARIOS,
    inPlace: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i + 1];
    if (argv[i] === '--in-place') {
      args.inPlace = true;
      continue;
    }
    if (argv[i] === '--app-dir') args.appDir = path.resolve(value ?? '');
    else if (argv[i] === '--host-dir') args.hostDir = path.resolve(value ?? '');
    else if (argv[i] === '--node') args.node = path.resolve(value ?? '');
    else if (argv[i] === '--report') args.report = path.resolve(value ?? '');
    else if (argv[i] === '--scenarios')
      args.scenarios = (value ?? '').split(/[ ,]+/).filter(Boolean);
    else throw new Error(`unknown argument: ${argv[i]}`);
    i += 1;
  }
  if (!args.appDir === !args.hostDir) throw new Error('give exactly one of --app-dir, --host-dir');
  return args;
}

/** The node, host directory and CLI binary the smoke drives. */
export function smokeLayout(args, platform = process.platform, arch = process.arch) {
  let hostDir = args.hostDir;
  let node = args.node ?? process.execPath;
  if (args.appDir) {
    const resources =
      platform === 'darwin' && args.appDir.endsWith('.app')
        ? path.join(args.appDir, 'Contents', 'Resources')
        : path.join(args.appDir, 'resources');
    hostDir = path.join(resources, 'claude-sdk-host');
    const pin = nodeRuntimePinFor(platform, arch);
    if (!args.node && pin) node = path.join(resources, 'node-runtime', pin.outName);
  }
  return {
    node,
    hostDir,
    entry: path.join(hostDir, 'host.js'),
    cli: path.join(hostDir, ...cliBinaryRel({ platform, arch }).split('/')),
  };
}

/**
 * A copy of the layout under `<dir>/PiLab Ai/resources`: the host directory, and
 * the node binary when it is the bundled one (`copyNode`).
 */
export function isolatedLayout(layout, dir, { copyNode }) {
  const resources = path.join(dir, 'PiLab Ai', 'resources');
  const hostDir = path.join(resources, 'claude-sdk-host');
  fs.cpSync(layout.hostDir, hostDir, { recursive: true });
  let node = layout.node;
  if (copyNode) {
    node = path.join(resources, 'node-runtime', path.basename(layout.node));
    fs.mkdirSync(path.dirname(node), { recursive: true });
    fs.copyFileSync(layout.node, node);
  }
  return {
    node,
    hostDir,
    entry: path.join(hostDir, 'host.js'),
    cli: path.join(hostDir, path.relative(layout.hostDir, layout.cli)),
  };
}

/** `PROBE CHECKS: all N passed` / `PROBE CHECKS: k of N failed` and the failed lines. */
export function parseProbeOutput(stdout) {
  const passed = stdout.match(/PROBE CHECKS: all (\d+) passed/);
  if (passed) return { ok: true, checks: Number(passed[1]), failed: [] };
  const failedLine = stdout.match(/PROBE CHECKS: (\d+) of (\d+) failed/);
  const failed = [...stdout.matchAll(/^\s+- (.+)$/gm)].map((match) => match[1]);
  return {
    ok: false,
    checks: failedLine ? Number(failedLine[2]) : 0,
    failed: failed.length > 0 ? failed : ['the probe did not report its checks'],
  };
}

function startGateway(dir) {
  const child = spawn(
    process.execPath,
    [
      GATEWAY,
      '--port',
      '0',
      '--plan',
      'claude-sdk',
      '--reset',
      '--model-id',
      'claude-opus-5-5',
      '--state',
      path.join(dir, 'gw-state.json'),
      '--log',
      path.join(dir, 'gw.log'),
    ],
    { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
  );
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(
      () => reject(new Error(`fake gateway did not start: ${output}`)),
      15_000
    );
    const onData = (chunk) => {
      output += chunk.toString();
      const match = output.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve({ child, url: match[1] });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => reject(new Error(`fake gateway exited ${code}: ${output}`)));
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const packaged = smokeLayout(args);
  for (const file of [packaged.node, packaged.entry, packaged.cli, GATEWAY, PROBE]) {
    if (!fs.existsSync(file)) throw new Error(`missing ${file}`);
  }
  // /tmp may be noexec on Linux; the DSH smoke picks /var/tmp the same way. On Windows the
  // temp directory is spelled in full: GitHub's runners set TEMP to an 8.3 short path, and
  // the CLI asks before every read or write under such a path, which the probe's scripted
  // turns do not expect (a workspace the user opens is spelled in full).
  const base =
    process.platform === 'linux' && fs.existsSync('/var/tmp')
      ? '/var/tmp'
      : fs.realpathSync.native(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(base, 'claude-sdk-smoke-'));
  const layout = args.inPlace
    ? packaged
    : isolatedLayout(packaged, dir, { copyNode: Boolean(args.appDir) && !args.node });
  const workspace = path.join(dir, 'workspace');
  const configDir = path.join(dir, 'config');
  fs.mkdirSync(workspace);
  fs.mkdirSync(configDir);
  const started = Date.now();
  const gateway = await startGateway(dir);
  log(`gateway ${gateway.url}; node ${layout.node}; host ${layout.entry}`);
  let result;
  try {
    const env = { ...process.env };
    // Nothing from this shell may change what the packaged host runs (B-5), and no key is real.
    for (const name of Object.keys(env)) {
      if (/^AICLIENT_CLAUDE_SDK_/i.test(name) || /^PROBE_/i.test(name)) delete env[name];
    }
    Object.assign(env, {
      PROBE_HOST_ENTRY: layout.entry,
      PROBE_CONFIG_DIR: configDir,
      AICLIENT_CLAUDE_SDK_CLI: layout.cli,
    });
    result = spawnSync(layout.node, [PROBE, gateway.url, workspace, ...args.scenarios], {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
  } finally {
    gateway.child.kill();
  }
  const verdict = parseProbeOutput(result.stdout ?? '');
  const ok = verdict.ok && result.status === 0;
  const report = {
    ok,
    node: layout.node,
    entry: layout.entry,
    cli: layout.cli,
    packaged: packaged.entry,
    scenarios: args.scenarios,
    checks: verdict.checks,
    failed: verdict.failed,
    probeExit: result.status,
    probeSignal: result.signal,
    durationMs: Date.now() - started,
    workDir: dir,
  };
  if (args.report) {
    fs.mkdirSync(path.dirname(args.report), { recursive: true });
    fs.writeFileSync(
      args.report,
      `${JSON.stringify({ ...report, stdoutTail: (result.stdout ?? '').slice(-20_000), stderrTail: (result.stderr ?? '').slice(-5_000) }, null, 2)}\n`
    );
  }
  if (ok) fs.rmSync(dir, { recursive: true, force: true });
  else log(`kept ${dir} for diagnosis; probe stderr: ${(result.stderr ?? '').slice(-2000)}`);
  console.log(JSON.stringify({ ok, checks: verdict.checks, failed: verdict.failed }));
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    log(error instanceof Error ? (error.stack ?? error.message) : String(error));
    console.log(
      JSON.stringify({ ok: false, checks: 0, failed: [String(error?.message ?? error)] })
    );
    process.exit(1);
  });
}
