import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runHostToolsProbe } from './p1-host-tools.ts';

// Invoke this entry with the actual packaged Node executable, never a PATH alias.
const [expectedNodePath, shellPath] = process.argv.slice(2);
if (
  process.platform !== 'win32' ||
  !expectedNodePath ||
  !shellPath ||
  resolve(expectedNodePath).toLowerCase() !== resolve(process.execPath).toLowerCase()
) {
  throw new Error(
    'requires Windows bundled node.exe, its absolute path, and the packaged bash path'
  );
}
const cwd = await mkdtemp(join(tmpdir(), 'p1-bundled-node-'));
try {
  const result = await runHostToolsProbe(
    {
      carrier: 'bundled-node',
      node: { path: process.execPath, source: 'bundled' },
      exec: { mode: 'pipe' },
      tsdReadFallback: 'disabled',
      cleanupTimeoutMs: 2000,
      childEnv: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '' },
    },
    cwd,
    shellPath
  );
  console.log(JSON.stringify(result));
  process.exitCode = result.passed ? 0 : 1;
} finally {
  await rm(cwd, { recursive: true, force: true });
}
