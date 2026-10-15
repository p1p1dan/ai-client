// Decision 189 evidence harness (Windows only, not product code): runs the
// Linux-oriented DSH probe tools of src/dsh-host/tools on Windows unedited.
//   node win-shim.mjs <tool.ts> [tool args...]
// 1. `--import <C:\abs\path>` in spawned argv becomes a file:// URL (Node reads
//    a drive-letter path as a URL with scheme `c:`).
// 2. `/proc/meminfo` reads answer MemAvailable from os.freemem().
// 3. SHIM_GATEWAY_MODEL_ID=<id> replaces the `--model-id` a spawned
//    fake-gateway.mjs gets (or adds one), so the reply's `message.model`
//    differs from the requested model (thinking-replay check).
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DRIVE_PATH = /^[A-Za-z]:[\\/]/;

function fixArgs(args) {
  if (!Array.isArray(args)) return args;
  const out = [...args];
  for (let i = 0; i < out.length - 1; i++) {
    if (out[i] === '--import' && DRIVE_PATH.test(out[i + 1])) {
      out[i + 1] = pathToFileURL(out[i + 1]).href;
    }
  }
  const modelId = process.env.SHIM_GATEWAY_MODEL_ID;
  if (modelId && out.some((arg) => typeof arg === 'string' && arg.endsWith('fake-gateway.mjs'))) {
    const at = out.indexOf('--model-id');
    if (at >= 0) out[at + 1] = modelId;
    else out.push('--model-id', modelId);
    console.error(`[win-shim] fake gateway --model-id ${modelId}`);
  }
  return out;
}

const originalSpawn = childProcess.spawn;
childProcess.spawn = function spawn(command, args, ...rest) {
  return originalSpawn.call(this, command, fixArgs(args), ...rest);
};

const PROC_STAT = /^\/proc\/(\d+)\/stat$/;
const PROC_STATUS = /^\/proc\/(\d+)\/status$/;
const originalReadFileSync = fs.readFileSync;
fs.readFileSync = function readFileSync(file, ...rest) {
  if (file === '/proc/meminfo') {
    return `MemAvailable: ${Math.round(os.freemem() / 1024)} kB\n`;
  }
  // 5. Per-process CPU ticks and RSS read as zero (n/a on Windows).
  const stat = typeof file === 'string' ? PROC_STAT.exec(file) : null;
  if (stat) return `${stat[1]} (node) S ${Array(49).fill('0').join(' ')}\n`;
  if (typeof file === 'string' && PROC_STATUS.test(file)) return 'VmRSS:\t0 kB\nVmHWM:\t0 kB\n';
  return originalReadFileSync.call(this, file, ...rest);
};

// 6. SIGSTOP / SIGCONT do not exist on Windows: the signal is skipped (logged),
//    so a probe's Linux-only wedged-host step reports nonsense but the run goes on.
const originalKill = childProcess.ChildProcess.prototype.kill;
childProcess.ChildProcess.prototype.kill = function kill(signal) {
  if (signal === 'SIGSTOP' || signal === 'SIGCONT') {
    console.error(`[win-shim] skipped ${signal} for pid ${this.pid}`);
    return false;
  }
  return originalKill.call(this, signal);
};

// 4. `readdirSync('/proc')` lists no processes (kit.ts waitQuiet / procTable),
//    so process-tree checks see nothing on Windows rather than crash.
const originalReaddirSync = fs.readdirSync;
fs.readdirSync = function readdirSync(dir, ...rest) {
  if (dir === '/proc') return [];
  return originalReaddirSync.call(this, dir, ...rest);
};

syncBuiltinESMExports();

const [tool, ...toolArgs] = process.argv.slice(2);
if (!tool) {
  console.error('usage: node win-shim.mjs <tool.ts> [args...]');
  process.exit(2);
}
const toolPath = path.resolve(tool);
process.argv = [process.argv[0], toolPath, ...toolArgs];
await import(pathToFileURL(toolPath).href);
