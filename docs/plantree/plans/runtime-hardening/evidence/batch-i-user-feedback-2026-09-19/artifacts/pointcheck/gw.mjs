/**
 * Fake-gateway control: `node gw.mjs <plan> [extra fake-gateway args…]`.
 *
 * Restarting the gateway is how a point-check switches plans, and doing it from
 * a shell one-liner is a trap: a `grep`/`pkill` whose PATTERN is the script name
 * matches the shell's OWN `/proc/<pid>/cmdline` (the pattern is right there in
 * the command line), so the loop kills the shell that is running it. The pattern
 * below is assembled at runtime from two halves so it never appears verbatim in
 * any process's command line.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import process from 'node:process';
import { pidsMatching, sleep } from './lib.mjs';

const TOOLS =
  '/home/ai/code/ai-client/docs/plantree/plans/runtime-hardening/evidence/batch-e-devbox-2026-09-17/tools';
const SCRIPT = `${TOOLS}/fake-gateway.mjs`;
const NEEDLE = ['fake-gate', 'way.mjs'].join('');
const PORT = 18099;
const LOG = '/tmp/pc-i/gw.log';
const STATE = '/tmp/pc-i/gw.state.json';

const [plan, ...extra] = process.argv.slice(2);

for (const pid of pidsMatching(NEEDLE)) {
  if (pid === process.pid) continue;
  try {
    process.kill(pid, 'SIGKILL');
    console.log(`killed old gateway ${pid}`);
  } catch {
    /* already gone */
  }
}
await sleep(400);

if (plan === 'stop') {
  console.log('gateway stopped');
  process.exit(0);
}

fs.mkdirSync('/tmp/pc-i', { recursive: true });
const fd = fs.openSync(LOG, 'a');
const child = spawn(
  'node',
  [SCRIPT, '--port', String(PORT), '--plan', plan, '--reset', '--state', STATE, ...extra],
  { detached: true, stdio: ['ignore', fd, fd] }
);
child.unref();

for (let i = 0; i < 30; i += 1) {
  await sleep(300);
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`);
    const body = await res.json();
    console.log(`gateway up: ${JSON.stringify(body)} pid=${child.pid}`);
    process.exit(0);
  } catch {
    /* not listening yet */
  }
}
console.error('gateway did NOT come up; log tail:');
console.error(fs.readFileSync(LOG, 'utf8').split('\n').slice(-20).join('\n'));
process.exit(1);
