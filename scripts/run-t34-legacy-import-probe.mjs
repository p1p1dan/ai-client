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
if (!fs.existsSync(workerPath)) throw new Error(`worker artifact missing: ${workerPath}`);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiclient-t34-runner-'));
const entry = path.join(temp, 'probe.cjs');
const require = createRequire(import.meta.url);
try {
  const esbuild = await import('esbuild');
  await esbuild.build({
    entryPoints: [path.join(repoRoot, 'scripts', 'probes', 't34-legacy-import-probe.ts')],
    outfile: entry,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    sourcemap: false,
    tsconfig: path.join(repoRoot, 'tsconfig.json'),
  });
  const result = spawnSync(require('electron'), ['--no-sandbox', entry, workerPath], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
  });
  if (result.status !== 0) throw new Error(`T34 probe failed\n${result.stderr}\n${result.stdout}`);
  const report = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? '');
  for (const key of ['ok', 'sourceImmutable', 'importedHistory', 'continuedInPi']) {
    if (report[key] !== true) throw new Error(`invalid T34 report: ${JSON.stringify(report)}`);
  }
  if (report.orphanWorkerPids?.length) throw new Error(`orphan workers: ${JSON.stringify(report)}`);
  console.log(JSON.stringify(report));
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
