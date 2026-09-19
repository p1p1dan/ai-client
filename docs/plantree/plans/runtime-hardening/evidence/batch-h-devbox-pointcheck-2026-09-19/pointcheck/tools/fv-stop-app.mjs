#!/usr/bin/env node
/**
 * fv-stop-app.mjs — stop the dev instance this batch started, by /proc.
 *
 * Never `pkill -f` and never `stopDevApp()` (which is `pkill -f` underneath):
 * a pattern match on a command line hits any process that merely MENTIONS the
 * port — including the probe that is doing the killing. Every candidate is
 * confirmed through `/proc/<pid>/exe` (a real electron binary, or the node that
 * runs the dev script) before it is signalled, own pid and `node -e` one-liners
 * excluded, SIGTERM first with five seconds' grace, SIGKILL only for survivors.
 */
import fs from 'node:fs';

const SELF = process.pid;

function candidates() {
  const found = [];
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === SELF) continue;
    let exe = null;
    let cmd = '';
    try {
      exe = fs.readlinkSync(`/proc/${pid}/exe`);
    } catch {
      continue;
    }
    try {
      cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
    } catch {
      continue;
    }
    // A `node -e '…'` whose SOURCE mentions the dev script is not the dev
    // script. Match on argv[1] being a real path, never on a free-text scan.
    const argv = cmd.split(' ').filter(Boolean);
    if (argv[1] === '-e' || argv[1] === '--eval') continue;
    const isElectron = /electron\/dist\/electron$/.test(exe) && cmd.includes('remote-debugging-port=9222');
    const isDevNode =
      /\/node$/.test(exe) &&
      (argv.some((a) => a.endsWith('scripts/dev.js')) ||
        argv.some((a) => a.endsWith('.bin/electron-vite')) ||
        (argv[1] === 'exec' && argv[2] === 'electron-vite'));
    if (isElectron || isDevNode) found.push({ pid, exe, cmd: cmd.slice(0, 120) });
  }
  return found;
}

const first = candidates();
console.log(`candidates: ${JSON.stringify(first, null, 1)}`);
for (const { pid } of first) {
  try {
    process.kill(pid, 'SIGTERM');
    console.log(`SIGTERM ${pid}`);
  } catch (error) {
    console.log(`SIGTERM ${pid} failed: ${error.message}`);
  }
}
await new Promise((r) => setTimeout(r, 5000));
const left = candidates();
for (const { pid } of left) {
  try {
    process.kill(pid, 'SIGKILL');
    console.log(`SIGKILL ${pid}`);
  } catch (error) {
    console.log(`SIGKILL ${pid} failed: ${error.message}`);
  }
}
await new Promise((r) => setTimeout(r, 2000));
console.log(`remaining: ${JSON.stringify(candidates())}`);
