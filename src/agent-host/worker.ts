/**
 * Per-slot Pi worker entry.
 *
 * One isolated process runs this file, owns one PiWorkerRpcServer, and
 * bootstraps at most one Pi AgentSession. Pool/session routing remains in Main.
 */

import { readRuntimeFlags } from '../runtime/flags.ts';
import {
  PI_BORROW_RESOURCES_DIR_ENV,
  PI_OPT_IN_EXTENSIONS_ENV,
  PI_PROJECT_TRUST_ENV,
} from '../shared/piModelConfig.ts';
import {
  PI_WORKER_GENERATION_ENV,
  WORKER_RPC_PROTOCOL_VERSION,
} from '../shared/types/workerRpc.ts';
import { PiWorkerRpcServer, type PiWorkerRpcServerOptions } from './piWorkerRpcServer.ts';

interface ElectronParentPort {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { data: unknown } | unknown) => void): this;
  start(): void;
}

function readPositiveGeneration(value: string | undefined): number {
  const generation = Number(value);
  if (!Number.isSafeInteger(generation) || generation <= 0) {
    throw new Error(`Missing or invalid ${PI_WORKER_GENERATION_ENV}: ${String(value)}`);
  }
  return generation;
}

function readProjectTrusted(value: string | undefined): boolean {
  if (value === '1') return true;
  if (value === '0') return false;
  return false;
}

function messageData(value: { data: unknown } | unknown): unknown {
  if (typeof value === 'object' && value !== null && 'data' in value) {
    return (value as { data: unknown }).data;
  }
  return value;
}

const electronPort = (process as NodeJS.Process & { parentPort?: ElectronParentPort }).parentPort;
const send = process.send?.bind(process);
if (!electronPort && !send) throw new Error('Pi worker requires Electron MessagePort or Node IPC');
const parentPort = electronPort ?? {
  postMessage(message: unknown) {
    if (process.connected) send!(message);
  },
};

// D11: the carrier is the process we are, not the platform we are on. Electron
// gives us a MessagePort; the bundled node.exe Main spawns for packaged Windows
// gives us Node IPC. Everything the runtime derives from the carrier — which
// Node may be spawned for a TSD read, whether there is a fallback at all — is
// decided in `workerHost`, so no plugin below has to know.
const carrier = electronPort ? 'electron-utility' : 'bundled-node';

// Requests must not be dropped while the native module loads. Electron buffers
// until `parentPort.start()`, but Node IPC emits on arrival and a message with
// no listener is simply gone, so both channels are attached now and queued
// until the server exists.
const queued: unknown[] = [];
let deliver = (message: unknown): void => {
  queued.push(message);
};
if (electronPort) {
  electronPort.on('message', (event) => deliver(messageData(event)));
  electronPort.start();
} else {
  process.on('message', (message) => deliver(message));
}

const generation = readPositiveGeneration(process.env[PI_WORKER_GENERATION_ENV]);

/**
 * ARD D8 / P4-2 — which engine this slot runs.
 *
 * The switch is a factory choice, not a second dispatcher: `PiWorkerRpcServer`
 * keeps correlation, generation binding and request serialization for both
 * backends. `legacy` never loads the native module, so an import-time fault in
 * the unfinished runtime cannot reach a user's session.
 */
const backend = readRuntimeFlags(process.env).backend;
let createNativeRuntime: PiWorkerRpcServerOptions['createRuntime'];
if (backend === 'native') {
  const [{ NativeWorkerRuntime }, { workerHost }] = await Promise.all([
    import('../runtime/worker/nativeWorkerRuntime.ts'),
    import('../runtime/host/worker.ts'),
  ]);
  // Electron-only; absent when Main spawned us as the bundled node.exe.
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const host = workerHost({ carrier, ...(resourcesPath ? { resourcesPath } : {}) });
  // Unannotated on purpose: this assignment is what proves NativeWorkerRuntime
  // still satisfies PiWorkerRuntime. The adapter does not import the RPC server
  // (that would drag pi-coding-agent into the native path), so this is the only
  // place the two shapes meet.
  createNativeRuntime = (options) => new NativeWorkerRuntime({ ...options, host });
}

let disposed = false;
const server = new PiWorkerRpcServer({
  port: parentPort,
  generation,
  projectTrusted: readProjectTrusted(process.env[PI_PROJECT_TRUST_ENV]),
  ...(process.env[PI_BORROW_RESOURCES_DIR_ENV]?.trim()
    ? { borrowResourcesFrom: process.env[PI_BORROW_RESOURCES_DIR_ENV]?.trim() }
    : {}),
  ...(process.env[PI_OPT_IN_EXTENSIONS_ENV]?.trim()
    ? { optInExtensions: process.env[PI_OPT_IN_EXTENSIONS_ENV]?.trim() }
    : {}),
  ...(createNativeRuntime ? { createRuntime: createNativeRuntime } : {}),
  log: (...args) => console.error('[pi-worker]', ...args),
  onDisposed: () => {
    disposed = true;
    if (electronPort) {
      setImmediate(() => process.exit(0));
    } else {
      // Let Node drain HTTP/IPC handles instead of forcing libuv teardown on
      // Windows. disconnect flushes queued messages, including the dispose ack.
      process.exitCode = 0;
      if (process.connected) process.disconnect!();
    }
  },
});

deliver = (message) => server.receive(message);
for (const message of queued.splice(0)) server.receive(message);

process.on('uncaughtException', (error) => {
  console.error('[pi-worker] uncaughtException:', error instanceof Error ? error.stack : error);
  process.exitCode = 1;
  setImmediate(() => process.exit(1));
});
process.on('unhandledRejection', (reason) => {
  console.error('[pi-worker] unhandledRejection:', reason);
  process.exitCode = 1;
  setImmediate(() => process.exit(1));
});

if (!electronPort) {
  process.once('disconnect', () => {
    if (disposed) return;
    // A crashed Main must not leave a Node worker or an active tool behind.
    setTimeout(() => process.exit(1), 5000).unref();
    server.receive({
      protocolVersion: WORKER_RPC_PROTOCOL_VERSION,
      kind: 'request',
      generation,
      requestId: 'parent-disconnected',
      type: 'worker.dispose',
      payload: { reason: 'app-shutdown' },
    });
  });
}
