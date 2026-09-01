import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workerPath = path.resolve(
  process.argv[2] ?? path.join(repoRoot, 'out-agent-host', 'worker.js')
);
if (!fs.existsSync(workerPath)) {
  throw new Error(`worker artifact missing: ${workerPath} — run pnpm build:agent-host first`);
}
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiclient-t30-runner-'));
const entry = path.join(temp, 'probe.cjs');
const require = createRequire(import.meta.url);

function pidExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

try {
  const esbuild = await import('esbuild');
  await esbuild.build({
    entryPoints: [path.join(repoRoot, 'scripts', 'probes', 't30-worker-manager-probe.ts')],
    outfile: entry,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    sourcemap: false,
    tsconfig: path.join(repoRoot, 'tsconfig.json'),
  });

  const electronPath = require('electron');
  const result = spawnSync(electronPath, ['--no-sandbox', entry, workerPath], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 90_000,
    windowsHide: true,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
  });
  if (result.status !== 0) {
    throw new Error(
      `T30 Electron probe failed (status=${result.status} signal=${result.signal})\n` +
        `${result.stderr}\n${result.stdout}`
    );
  }
  const line = result.stdout.trim().split(/\r?\n/).at(-1) ?? '';
  const report = JSON.parse(line);
  if (
    report.ok !== true ||
    report.sessions?.length !== 2 ||
    report.streamedSessions?.length !== 2 ||
    !report.resumedSession ||
    report.resumeEventOrder?.join(',') !== 'session.resumed,session.history,session.status'
  ) {
    throw new Error(`invalid T30 probe report: ${JSON.stringify(report)}`);
  }
  for (const pid of report.workerPids ?? []) {
    if (pidExists(pid)) throw new Error(`orphan worker pid after Electron exit: ${pid}`);
  }
  console.log(JSON.stringify(report));
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
