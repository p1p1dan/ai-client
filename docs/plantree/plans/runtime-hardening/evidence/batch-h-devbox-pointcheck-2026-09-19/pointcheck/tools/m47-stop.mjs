#!/usr/bin/env node
/**
 * Stop this point-check's app, by /proc identity only.
 *
 * Never `pkill -f` and never `stopDevApp()`: this box has run a session-killing
 * accident before (a test that called `process.kill(-1)`), and a pattern match
 * on a command line is exactly how that class of mistake happens. Every target
 * here is identified by its real `exe` link plus a cmdline marker, SIGTERM
 * first, SIGKILL only for what is still there five seconds later.
 */
import fs from 'node:fs';

const NUL = String.fromCharCode(0);

function all() {
  const out = [];
  for (const pid of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    let exe;
    try {
      exe = fs.readlinkSync(`/proc/${pid}/exe`);
    } catch {
      continue;
    }
    let cmd = '';
    try {
      cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split(NUL).filter(Boolean).join(' ');
    } catch {
      /* gone */
    }
    let comm = '';
    try {
      comm = fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
    } catch {
      /* gone */
    }
    out.push({ pid: Number(pid), exe, cmd, comm });
  }
  return out;
}

const isTarget = (p) =>
  (p.exe.includes('/electron/dist/electron') &&
    (p.cmd.includes('remote-debugging-port=9222') ||
      p.comm === 'pi' ||
      p.cmd.includes('pi-coding-agent/dist/bundle/cli.js'))) ||
  (p.exe.endsWith('/node') &&
    (p.cmd.includes('scripts/dev.js') ||
      p.cmd.includes('electron-vite dev') ||
      p.cmd.includes('pi-coding-agent/dist/bundle/cli.js')));

const targets = () => all().filter(isTarget);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const first = targets();
console.log(
  'targets:',
  JSON.stringify(
    first.map((p) => ({ pid: p.pid, comm: p.comm, cmd: p.cmd.slice(0, 80) })),
    null,
    1
  )
);
for (const p of first) {
  try {
    process.kill(p.pid, 'SIGTERM');
  } catch (error) {
    console.log('SIGTERM failed for', p.pid, error.code);
  }
}
await sleep(5000);
const left = targets();
console.log(
  'still up after SIGTERM:',
  left.map((p) => p.pid)
);
for (const p of left) {
  try {
    process.kill(p.pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}
await sleep(2000);
console.log(
  'final:',
  targets().map((p) => p.pid)
);
