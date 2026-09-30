/**
 * Windows diagnostics for the packaged DSH host (dsh-rebase decision 134).
 *
 *   node scripts/dsh-host-windows-diag.mjs --host-dir out-dsh-host --node out-node-runtime\node.exe
 *        [--hooks <smoke hooks.jsonl> ...] [--out <file.json>]
 *
 * Answers, in one CI run, what the packaged smoke's three Windows failures
 * rest on (run 36602434283):
 *   paths    %TEMP% and a directory under it through `fs.realpathSync`,
 *            `fs.realpathSync.native` and `fs.promises.realpath` (all run by the
 *            bundled node), and whether a canonical target is inside the
 *            workspace by each resolver's root — the gate's 8.3 mismatch;
 *   spawns   the chain DSH launched its tools through, read from the smoke's
 *            hook logs (every win32 tool goes through dsh-subprocess-local's
 *            Job runner, a node.exe), and where the artifact's ripgrep resolves;
 *   pty      node-pty from the artifact under each way of starting node (the
 *            old smoke's `--input-type=module -e`, CommonJS `-e`, a file entry,
 *            with and without the hooks, `useConptyDll`, `windowsHide`), with
 *            the reason node-pty gives for a failed start.
 * Prints paths of this machine only; never an environment dump or a credential.
 * Runs on any platform (the pty variants use /bin/sh off Windows).
 */

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnArgv, spawnTarget } from './dsh-host-smoke-lib.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOKS = pathToFileURL(
  path.join(repoRoot, 'src', 'dsh-host', 'tools', 'lib', 'probe-hooks.mjs')
).href;
const isWindows = process.platform === 'win32';

function parseArgs(argv) {
  const args = { hooks: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = () => {
      i += 1;
      if (argv[i] === undefined) throw new Error(`${flag} needs a value`);
      return argv[i];
    };
    if (flag === '--host-dir') args.hostDir = path.resolve(value());
    else if (flag === '--node') args.node = path.resolve(value());
    else if (flag === '--hooks') args.hooks.push(path.resolve(value()));
    else if (flag === '--out') args.out = path.resolve(value());
    else throw new Error(`unknown argument: ${flag}`);
  }
  if (!args.hostDir || !args.node) throw new Error('pass --host-dir and --node');
  return args;
}

/** Run `node <args>` (the bundled node) and collect its output; never throws. */
function runNode(node, args, options = {}) {
  return new Promise((done) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(node, args, {
        cwd: options.cwd ?? os.tmpdir(),
        env: options.env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: options.windowsHide ?? true,
      });
    } catch (error) {
      done({ spawnError: String(error) });
      return;
    }
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 60_000);
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      done({ spawnError: String(error), ms: Date.now() - started });
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      let parsed;
      try {
        parsed = JSON.parse(stdout.trim().split('\n').at(-1) ?? '');
      } catch {
        parsed = undefined;
      }
      done({
        code,
        signal,
        ms: Date.now() - started,
        ...(parsed === undefined ? { stdout: stdout.slice(-1000) } : { result: parsed }),
        ...(stderr ? { stderrTail: stderr } : {}),
      });
    });
  });
}

// ---- paths ------------------------------------------------------------------------

/** Executed by the bundled node: the three resolvers over the same paths. */
const PATHS_PROBE = `
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const [workspace, target] = JSON.parse(process.argv[1]);
const safe = (fn) => { try { return fn(); } catch (error) { return 'ERROR ' + (error.code || error.message); } };
(async () => {
  const resolvers = async (p) => ({
    realpathSync: safe(() => fs.realpathSync(p)),
    realpathSyncNative: safe(() => fs.realpathSync.native(p)),
    promisesRealpath: await fs.promises.realpath(p).catch((e) => 'ERROR ' + (e.code || e.message)),
  });
  const inside = (root, p) => {
    const rel = path.relative(root, p);
    return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep));
  };
  const ws = await resolvers(workspace);
  const canonicalTarget = await fs.promises.realpath(target).catch(() => null);
  process.stdout.write(JSON.stringify({
    node: process.version,
    env: { TEMP: process.env.TEMP ?? null, TMP: process.env.TMP ?? null, USERPROFILE: process.env.USERPROFILE ?? null },
    tmpdir: await resolvers(os.tmpdir()),
    homedir: await resolvers(os.homedir()),
    workspace: { spelled: workspace, ...ws },
    target: { spelled: target, canonical: canonicalTarget },
    // The gate: a target canonicalized by fs.promises.realpath, inside which root?
    targetInside: {
      realpathSyncRoot: canonicalTarget !== null && inside(ws.realpathSync, canonicalTarget),
      realpathSyncNativeRoot: canonicalTarget !== null && inside(ws.realpathSyncNative, canonicalTarget),
      spelledRoot: canonicalTarget !== null && inside(workspace, canonicalTarget),
    },
  }));
})();
`;

/** The 8.3 short spelling of `file` (cmd's `%~sI`), or null off Windows / when there is none. */
function shortName(file) {
  if (!isWindows) return null;
  try {
    const out = execFileSync(
      process.env.ComSpec || 'cmd.exe',
      ['/d', '/s', '/c', `"for %I in ("${file}") do @echo %~sI"`],
      { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true, timeout: 15_000 }
    );
    return out.trim().split(/\r?\n/).at(-1) || null;
  } catch {
    return null;
  }
}

async function pathsSection(node, scratch) {
  const longDir = path.join(scratch, 'workspace-with-a-long-name');
  fs.mkdirSync(longDir, { recursive: true });
  const target = path.join(longDir, 'marker.txt');
  fs.writeFileSync(target, 'marker\n');
  const cases = { tmpdirWorkspace: [longDir, target] };
  const short = shortName(longDir);
  if (short && short.toLowerCase() !== longDir.toLowerCase()) {
    cases.shortNamedWorkspace = [short, path.join(short, 'marker.txt')];
  }
  const out = { shortNameOfWorkspace: short };
  for (const [name, pair] of Object.entries(cases)) {
    out[name] = await runNode(node, ['-e', PATHS_PROBE, JSON.stringify(pair)]);
  }
  return out;
}

// ---- spawns -----------------------------------------------------------------------

function readJsonl(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function spawnsSection(node, hostDir, hookLogs) {
  const chains = new Map();
  for (const record of hookLogs.flatMap(readJsonl)) {
    if (record.kind !== 'spawn' && record.kind !== 'spawn-sync') continue;
    const argv = spawnArgv(record);
    const target = spawnTarget(record);
    // Model arguments are cut: the chain is the launcher prefix and the tool.
    const prefix = argv.slice(0, Math.max(1, argv.indexOf(target) + 1)).slice(0, 24);
    const key = JSON.stringify(prefix);
    const seen = chains.get(key);
    if (seen) seen.count += 1;
    else
      chains.set(key, { kind: record.kind, pid: record.pid, launcher: prefix, target, count: 1 });
  }
  const resolved = await runNode(node, [
    '--input-type=module',
    '-e',
    `
    import { createRequire } from 'node:module';
    const req = createRequire(${JSON.stringify(path.join(hostDir, 'package.json'))});
    const safe = async (fn) => { try { return await fn(); } catch (error) { return 'ERROR ' + error.message; } };
    const rgPath = await safe(async () => (await import(req.resolve('@vscode/ripgrep'))).rgPath);
    process.stdout.write(JSON.stringify({
      execPath: process.execPath,
      rgPath,
      jobRunner: await safe(() => req.resolve('@deepseek-ai/dsh-subprocess-local/runner')),
      aclRunner: await safe(() => req.resolve('@deepseek-ai/dsh-sandbox-windows-acl/runner')),
    }));
    `,
  ]);
  return { hookLogs, chains: [...chains.values()].slice(0, 40), resolved };
}

// ---- pty ---------------------------------------------------------------------------

/** node-pty from the artifact, one terminal; `run(opts)` or `node pty-probe.cjs <json>`. */
const PTY_PROBE = `
const { createRequire } = require('node:module');
const shortArgv = () => process.execArgv.map((a) => (a.length > 80 ? a.slice(0, 80) + '...' : a));
async function run(opts) {
  const req = createRequire(opts.anchor);
  const started = Date.now();
  const pty = req('node-pty');
  return new Promise((done) => {
    let text = '';
    let reason;
    let term;
    try {
      term = pty.spawn(opts.file, opts.args, {
        name: 'xterm-256color',
        cols: 80,
        rows: 10,
        cwd: opts.cwd,
        env: { ...process.env, TERM: 'xterm-256color' },
        ...(opts.useConptyDll ? { useConptyDll: true } : {}),
      });
    } catch (error) {
      done({ thrown: String(error?.message ?? error), execArgv: shortArgv() });
      return;
    }
    term._agent?.onError?.((error) => { reason = String(error?.message ?? error); });
    const timer = setTimeout(() => {
      try { term.kill(); } catch {}
      done({ timedOut: true, text: text.slice(-300), reason, ms: Date.now() - started, execArgv: shortArgv() });
    }, 20000);
    term.onData((chunk) => { text += chunk; });
    term.onExit(({ exitCode, signal }) => {
      clearTimeout(timer);
      done({ exitCode, signal, sawOk: text.includes('pty-ok'), text: text.slice(-300), reason, ms: Date.now() - started, execArgv: shortArgv() });
    });
  });
}
/** Print the result; a process something still holds after 5 s says so and exits. */
function report(out) {
  process.stdout.write(JSON.stringify(out) + '\\n');
  setTimeout(() => {
    process.stderr.write('probe: still alive 5 s after the terminal exited\\n');
    process.exit(0);
  }, 5000).unref();
}
module.exports = { run, report };
if (require.main === module) run(JSON.parse(process.argv[2])).then(report);
`;

async function ptySection(node, hostDir, scratch) {
  const probe = path.join(scratch, 'pty-probe.cjs');
  fs.writeFileSync(probe, PTY_PROBE);
  const cwd = fs.mkdtempSync(path.join(scratch, 'pty-cwd-'));
  const anchor = path.join(hostDir, 'package.json');
  const shell = isWindows
    ? { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/c', 'echo pty-ok'] }
    : { file: '/bin/sh', args: ['-c', 'echo pty-ok'] };
  const slow = isWindows
    ? {
        file: 'powershell.exe',
        args: [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Write-Output pty-ok; Start-Sleep -Milliseconds 800',
        ],
      }
    : { file: '/bin/sh', args: ['-c', 'echo pty-ok; sleep 0.8'] };
  const opts = (extra = {}) => JSON.stringify({ anchor, cwd, ...shell, ...extra });
  const esmEval = (o) =>
    `const m = await import(${JSON.stringify(pathToFileURL(probe).href)}); m.default.report(await m.default.run(${o}));`;
  const cjsEval = (o) => `const m = require(${JSON.stringify(probe)}); m.run(${o}).then(m.report);`;
  const env = { ...process.env, AICLIENT_PROBE_HOOK_LOG: path.join(scratch, 'pty-hooks.jsonl') };
  const variants = {
    // The smoke's natives probe until decision 134.
    'old-smoke: hooks + --input-type=module -e': [
      '--import',
      HOOKS,
      '--input-type=module',
      '-e',
      esmEval(opts()),
    ],
    'old-smoke + useConptyDll': [
      '--import',
      HOOKS,
      '--input-type=module',
      '-e',
      esmEval(opts({ useConptyDll: true })),
    ],
    'no hooks, --input-type=module -e': ['--input-type=module', '-e', esmEval(opts())],
    // The smoke's natives probe from decision 134 on.
    'new-smoke: --expose-internals + hooks + CommonJS -e': [
      '--expose-internals',
      '--import',
      HOOKS,
      '-e',
      cjsEval(opts()),
    ],
    // As the host itself would (a file entry).
    'file entry + --expose-internals + hooks': [
      '--expose-internals',
      '--import',
      HOOKS,
      probe,
      opts(),
    ],
    'file entry, no hooks': [probe, opts()],
    'file entry, useConptyDll': [probe, opts({ useConptyDll: true })],
    'file entry, longer-lived powershell': [probe, JSON.stringify({ anchor, cwd, ...slow })],
  };
  const out = {};
  for (const [name, args] of Object.entries(variants)) {
    out[name] = await runNode(node, args, { env, cwd });
  }
  out['file entry, windowsHide false'] = await runNode(node, [probe, opts()], {
    env,
    cwd,
    windowsHide: false,
  });
  return out;
}

// ---- main --------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aiclient-dsh-diag-'));
  const report = {
    diag: 'dsh-host-windows',
    platform: `${process.platform}-${process.arch}`,
    hostDir: args.hostDir,
    node: args.node,
    scratch,
    startedAt: new Date().toISOString(),
  };
  const section = async (name, fn) => {
    try {
      report[name] = await fn();
    } catch (error) {
      report[name] = { error: String(error?.stack ?? error) };
    }
    process.stderr.write(`[dsh-diag] ${name}: done\n`);
  };
  await section('paths', () => pathsSection(args.node, scratch));
  await section('spawns', () => spawnsSection(args.node, args.hostDir, args.hooks));
  await section('pty', () => ptySection(args.node, args.hostDir, scratch));
  report.finishedAt = new Date().toISOString();
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (args.out) {
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, json);
  }
  process.stdout.write(json);
  fs.rmSync(scratch, { recursive: true, force: true });
}

try {
  await main();
} catch (error) {
  process.stderr.write(`[dsh-diag] ERROR ${error?.stack ?? error}\n`);
  process.exitCode = 2;
}
