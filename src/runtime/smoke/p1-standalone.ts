import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { standaloneHost } from '../host/config.ts';
import { runHostToolsProbe } from './p1-host-tools.ts';

const cwd = await mkdtemp(join(tmpdir(), 'p1-standalone-'));
try {
  const result = await runHostToolsProbe(
    standaloneHost({ PATH: process.env.PATH }),
    cwd,
    process.env.AICLIENT_PROBE_SHELL ?? '/bin/bash'
  );
  console.log(JSON.stringify(result));
  process.exitCode = result.passed ? 0 : 1;
} finally {
  await rm(cwd, { recursive: true, force: true });
}
