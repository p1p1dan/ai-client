/**
 * Bundles and runs the H/21 offline import-scan probe (see
 * `scripts/probes/h21-conversation-import-scan.ts`). Same esbuild-then-node
 * shape as the T34 probe runner, minus Electron: nothing here needs a worker.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiclient-h21-scan-'));
const entry = path.join(temp, 'probe.cjs');
try {
  const esbuild = await import('esbuild');
  await esbuild.build({
    entryPoints: [path.join(repoRoot, 'scripts', 'probes', 'h21-conversation-import-scan.ts')],
    outfile: entry,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    sourcemap: false,
    tsconfig: path.join(repoRoot, 'tsconfig.json'),
  });
  const result = spawnSync(process.execPath, [entry], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 300_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`probe failed\n${result.stderr}\n${result.stdout}`);
  console.log(result.stdout.trim());
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
