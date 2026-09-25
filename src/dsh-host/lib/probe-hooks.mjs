/**
 * Probe instrumentation preloaded with `--import` into the measured process
 * (DSH host and, for parity, our native worker). Never shipped.
 *
 * - Network guard: loopback and local sockets pass; every other outbound
 *   connect is logged and destroyed, so a probe run can never reach the
 *   internet (telemetry, account, catalog fetches) even if a row misbehaves.
 * - Spawn log: every child_process spawn (async and sync) and worker_threads
 *   Worker is logged with its command line. Native spawns (node-pty) bypass
 *   this; the supervisor's process-tree sampling and strace cover them.
 *
 * Records go to the JSONL file named by AICLIENT_PROBE_HOOK_LOG.
 */

import childProcess from 'node:child_process';
import dns from 'node:dns';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { performance } from 'node:perf_hooks';
import workerThreads from 'node:worker_threads';

const logFile = process.env.AICLIENT_PROBE_HOOK_LOG;

function record(kind, detail) {
  if (!logFile) return;
  try {
    fs.appendFileSync(
      logFile,
      `${JSON.stringify({ tMs: Math.round(performance.now()), pid: process.pid, kind, ...detail })}\n`
    );
  } catch {
    // Instrumentation must never break the measured process.
  }
}

// ---- network guard -------------------------------------------------------

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

function connectTarget(args) {
  const first = args[0];
  const options = Array.isArray(first) ? first[0] : first;
  if (options !== null && typeof options === 'object') {
    return { path: options.path, host: options.host ?? 'localhost', port: options.port };
  }
  if (typeof first === 'string' && Number.isNaN(Number(first))) return { path: first };
  return { host: typeof args[1] === 'string' ? args[1] : 'localhost', port: first };
}

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function probeConnect(...args) {
  const target = connectTarget(args);
  if (target.path !== undefined) return originalConnect.apply(this, args);
  const host = String(target.host);
  if (LOOPBACK.has(host) || host.startsWith('127.')) {
    record('net-loopback', { host, port: target.port });
    return originalConnect.apply(this, args);
  }
  record('net-blocked', { host, port: target.port });
  process.nextTick(() =>
    this.destroy(new Error(`P0 probe: outbound network blocked (${host}:${target.port})`))
  );
  return this;
};

const originalLookup = dns.lookup;
dns.lookup = function probeLookup(hostname, ...rest) {
  record('dns-lookup', { hostname });
  return originalLookup.call(this, hostname, ...rest);
};

// ---- spawn log -----------------------------------------------------------

const originalSpawn = childProcess.ChildProcess.prototype.spawn;
childProcess.ChildProcess.prototype.spawn = function probeSpawn(options) {
  record('spawn', { file: options?.file, args: options?.args, cwd: options?.cwd });
  return originalSpawn.call(this, options);
};

for (const name of ['spawnSync', 'execSync', 'execFileSync']) {
  const original = childProcess[name];
  childProcess[name] = function probeSyncSpawn(command, ...rest) {
    const args = Array.isArray(rest[0]) ? rest[0] : undefined;
    record('spawn-sync', { via: name, file: command, args });
    return original.call(this, command, ...rest);
  };
}

const OriginalWorker = workerThreads.Worker;
workerThreads.Worker = class ProbeWorker extends OriginalWorker {
  constructor(filename, options) {
    record('worker-thread', { filename: String(filename).slice(0, 300) });
    super(filename, options);
  }
};

syncBuiltinESMExports();
record('hooks-installed', { argv: process.argv.slice(1), execArgv: process.execArgv });
