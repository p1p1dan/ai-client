import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workerPath = path.resolve(
  process.argv[2] ?? path.join(repoRoot, 'out-agent-host', 'worker.js')
);
if (!fs.existsSync(workerPath)) {
  throw new Error(`worker artifact missing: ${workerPath} — run pnpm build:agent-host first`);
}
// Inside node_modules so the bundle can require the native `node-pty` the real
// Pi TUI controller uses; a tmpdir entry would not resolve it.
const outDir = fs.mkdtempSync(path.join(repoRoot, 'node_modules', '.aiclient-t37b-'));
const entry = path.join(outDir, 'probe.cjs');
const home = fs.mkdtempSync(path.join(repoRoot, 'node_modules', '.aiclient-t37b-home-'));
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
    entryPoints: [path.join(repoRoot, 'scripts', 'probes', 't37b-longevity-probe.ts')],
    outfile: entry,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron', 'node-pty'],
    sourcemap: false,
    tsconfig: path.join(repoRoot, 'tsconfig.json'),
  });

  const electronPath = require('electron');
  const result = spawnSync(electronPath, ['--no-sandbox', entry, repoRoot, workerPath], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 420_000,
    windowsHide: true,
    env: {
      ...process.env,
      // Keep app state, Pi CLI config and Electron userData off the real profile.
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      XDG_CACHE_HOME: path.join(home, '.cache'),
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    },
  });
  if (result.status !== 0) {
    throw new Error(
      `T37-b Electron probe failed (status=${result.status} signal=${result.signal})\n` +
        `${result.stderr}\n${result.stdout}`
    );
  }
  const line = result.stdout.trim().split(/\r?\n/).at(-1) ?? '';
  const report = JSON.parse(line);
  const failures = [];
  if (report.ok !== true) failures.push('probe did not report ok');
  if (report.pool?.capacityError !== 'worker_capacity_reached' || !report.pool?.capacityRetryable) {
    failures.push('all-protected pool did not raise a retryable capacity error');
  }
  if (report.reopen?.eventOrder?.join(',') !== 'session.resumed,session.history,session.status') {
    failures.push('reopen event order regression');
  }
  if (!(report.reopen?.reopenedMessages > 0)) failures.push('reopen hydrated no history');
  const expectedCycles = Number(process.env.AICLIENT_T37B_CYCLES ?? 6);
  if (report.longevity?.cycles !== expectedCycles) failures.push('churn cycle count changed');
  if (report.longevity?.churnCycles?.length !== expectedCycles) {
    failures.push('churn accounting missing');
  }
  if (!(report.longevity?.worstDrainMs <= 2000)) failures.push('closed workers drained slowly');
  if (!(report.longevity?.rssGrowthMiB <= 120)) failures.push('unbounded Main RSS growth');
  if (!(report.idle?.reclaimMs >= report.idle?.timeoutMs)) {
    failures.push('idle reclaim did not come from the background sweep');
  }
  if (!/capacity reached/i.test(report.pty?.capacityError ?? '')) {
    failures.push('PTY over-subscription was not rejected');
  }
  if (report.pty?.spawns !== 3) failures.push('PTY spawn accounting changed');
  for (const pid of report.workerPids ?? []) {
    if (pidExists(pid)) failures.push(`orphan worker pid after Electron exit: ${pid}`);
  }
  for (const pid of report.ptyPids ?? []) {
    if (pidExists(pid)) failures.push(`orphan Pi TUI pty pid after Electron exit: ${pid}`);
  }
  if (failures.length > 0) {
    throw new Error(`invalid T37-b probe report: ${failures.join('; ')}\n${line}`);
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
}
