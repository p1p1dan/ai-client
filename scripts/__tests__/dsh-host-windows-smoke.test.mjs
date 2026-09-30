import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { isRipgrep, spawnArgv, spawnTarget } from '../dsh-host-smoke-lib.mjs';

/**
 * dsh-rebase decision 134 — the packaged DSH host smoke on Windows: what its
 * hooks can see of DSH's spawns (every win32 tool goes through a node.exe
 * runner), how its natives probe starts node (never `--input-type`, which a
 * worker thread inherits and refuses), and the quick Windows workflow.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOST = 'D:\\a\\ai-client\\ai-client\\out-dsh-host';
const NODE = 'D:\\a\\ai-client\\ai-client\\out-node-runtime\\node.exe';
const JOB_RUNNER = `${HOST}\\node_modules\\@deepseek-ai\\dsh-subprocess-local\\lib\\runner.js`;
const ACL_RUNNER = `${HOST}\\node_modules\\@deepseek-ai\\dsh-sandbox-windows-acl\\lib\\runner.js`;
const RG = `${HOST}\\node_modules\\@vscode\\ripgrep-win32-x64\\bin\\rg.exe`;

describe('spawnTarget: the tool behind DSH launchers', () => {
  it('[win-job-runner] reads rg through the Windows Job runner, the only spawn the hooks see', () => {
    const record = {
      kind: 'spawn',
      file: NODE,
      args: [NODE, JOB_RUNNER, '--', RG, '--no-config', '--json', 'MARKER', '.'],
    };
    expect(spawnTarget(record)).toBe(RG);
    expect(isRipgrep(spawnTarget(record))).toBe(true);
  });

  it('[win-acl-runner] reads a sandboxed pwsh through the Job runner and the ACL runner', () => {
    const pwsh = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
    const record = {
      kind: 'spawn',
      file: NODE,
      args: [
        NODE,
        JOB_RUNNER,
        '--',
        NODE,
        ACL_RUNNER,
        '--workspace',
        'C:\\ws',
        '--temp',
        'C:\\t',
        '--mode',
        'workspace-write',
        '--write-sid',
        'S-1-4-1',
        '--temp-write-sid',
        'S-1-4-2',
        '--',
        pwsh,
        '-NoProfile',
        '-Command',
        'Get-Content -- x',
      ],
    };
    expect(spawnTarget(record)).toBe(pwsh);
  });

  it('[systemd-run] keeps reading a Linux user-scope launch as before', () => {
    const record = {
      kind: 'spawn',
      file: '/usr/bin/systemd-run',
      args: [
        '/usr/bin/systemd-run',
        '--user',
        '--scope',
        '--',
        '/opt/node',
        '/host/runner.js',
        '--',
        '/host/node_modules/@vscode/ripgrep-linux-x64/bin/rg',
        '--',
        'x',
      ],
    };
    expect(spawnTarget(record)).toBe('/host/node_modules/@vscode/ripgrep-linux-x64/bin/rg');
  });

  it('reads direct and sync spawns as their own program', () => {
    expect(spawnTarget({ kind: 'spawn', file: '/bin/rg', args: ['/bin/rg', '--', 'x'] })).toBe(
      '/bin/rg'
    );
    const sync = { kind: 'spawn-sync', file: 'taskkill', args: ['/PID', '12', '/T', '/F'] };
    expect(spawnArgv(sync)).toEqual(['taskkill', '/PID', '12', '/T', '/F']);
    expect(spawnTarget(sync)).toBe('taskkill');
    // A node child that is not one of DSH's runners stays itself.
    expect(spawnTarget({ kind: 'spawn', file: NODE, args: [NODE, 'other.js', '--', RG] })).toBe(
      NODE
    );
    expect(isRipgrep('C:\\x\\rg.EXE')).toBe(true);
    expect(isRipgrep('/usr/bin/rgx')).toBe(false);
  });
});

describe('the natives probe starts node as the host does (decision 134)', () => {
  const smoke = readFileSync(path.join(repoRoot, 'scripts', 'packaged-dsh-host-smoke.mjs'), 'utf8');
  const probe = smoke.slice(smoke.indexOf('async function nativeProbe'));
  const spawnCall = probe.slice(probe.indexOf('const child = spawn('), probe.indexOf('stdio:'));

  it('[pty-release] releases the terminal with kill() once it exited, on Windows only, and never forces its own exit', () => {
    const script = probe.slice(0, probe.indexOf('const hookLog'));
    const onExit = script.slice(script.indexOf('term.onExit('));
    expect(onExit).toMatch(/process\.platform === \x27win32\x27\) \{\s*try \{\s*term\.kill\(\);/);
    // The criterion stays "exits 0 by itself": nothing in the probe calls process.exit.
    expect(script).not.toContain('process.exit(');
    // What still holds it is named, on a timer that holds nothing itself.
    expect(script).toMatch(/getActiveResourcesInfo\(\)[\s\S]*?\}, 10000\)\.unref\(\)/);
  });

  it('never passes --input-type, and runs with the host execArgv', () => {
    expect(spawnCall).toContain("'-e'");
    expect(spawnCall).toContain("'--expose-internals'");
    expect(spawnCall).not.toContain('--input-type');
  });

  it('[worker-exec-argv] a worker inheriting --import with --input-type dies of it; CommonJS -e does not', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-smoke-worker-'));
    try {
      const worker = path.join(dir, 'worker.cjs');
      writeFileSync(worker, "require('node:worker_threads').parentPort.postMessage('ready');\n");
      const body = `const w = new Worker(${JSON.stringify(worker)});
        w.on('message', (m) => { process.stdout.write(m); w.terminate(); });
        w.on('error', (e) => process.stdout.write('error: ' + e.message));`;
      const run = (args) =>
        spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 30_000 }).stdout;
      // The smoke's hooks arrive by --import; any preload does.
      const preload = ['--import', 'data:text/javascript,0'];
      const esm = `import { Worker } from 'node:worker_threads'; ${body}`;
      const cjs = `const { Worker } = require('node:worker_threads'); ${body}`;
      // node-pty's Windows ConPTY output is read on such a worker.
      expect(run([...preload, '--input-type=module', '-e', esm])).toMatch(/^error: --input-type/);
      expect(run([...preload, '--expose-internals', '-e', cjs])).toBe('ready');
      // Either flag alone is harmless: the host runs with --expose-internals and a file entry.
      expect(run(['--input-type=module', '-e', esm])).toBe('ready');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('counts a spawn through the Windows runners toward l1RipgrepFromArtifact', () => {
    expect(smoke).toContain("from './dsh-host-smoke-lib.mjs'");
    expect(smoke).toMatch(/target: spawnTarget\(r\)/);
    expect(smoke).toMatch(/isRipgrep\(item\.target\)/);
  });
});

describe('the quick Windows workflow (decision 134)', () => {
  const file = path.join(repoRoot, '.github', 'workflows', 'dsh-host-windows-smoke.yml');
  const workflow = yaml.load(readFileSync(file, 'utf8'));
  const steps = workflow.jobs.smoke.steps;
  const step = (name) => steps.find((item) => item.name === name);

  it('runs on a push to its branch or by hand, read-only', () => {
    expect(workflow.on.push.branches).toEqual(['ci/dsh-host-windows-smoke']);
    expect(workflow.on).toHaveProperty('workflow_dispatch');
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.jobs.smoke['runs-on']).toBe('windows-2022');
  });

  it('builds the host and the bundled node as build-windows does, and no Electron package', () => {
    const runs = steps.map((item) => item.run ?? '').join('\n');
    expect(step('Setup Node.js').with['node-version']).toBe('24');
    expect(runs).toContain('node scripts/build-dsh-host.mjs');
    expect(runs).toContain('node scripts/fetch-node-runtime.mjs --platform win32-x64');
    expect(runs).not.toMatch(/electron-builder|pnpm build\b/);
  });

  it('runs the L1 smoke on the artifact and the bundled node', () => {
    expect(step('DSH host smoke (L1)').run).toContain(
      'packaged-dsh-host-smoke.mjs --level 1 --host-dir out-dsh-host --node out-node-runtime\\node.exe'
    );
  });

  it('always runs the diagnostics without failing the job, and always uploads', () => {
    const diag = step('Windows diagnostics');
    expect(diag.if).toBe('always()');
    expect(diag['continue-on-error']).toBe(true);
    expect(diag.run).toContain('scripts/dsh-host-windows-diag.mjs');
    const upload = steps.find((item) => item.uses?.startsWith('actions/upload-artifact'));
    expect(upload.if).toBe('always()');
    for (const part of ['dist/dsh-host-smoke-report.json', 'dist/smoke-logs/', 'dist/diag/'])
      expect(upload.with.path).toContain(part);
  });
});
