/**
 * Per-slot Pi worker entry.
 *
 * One isolated process runs this file, owns one PiWorkerRpcServer, and
 * bootstraps at most one Pi AgentSession. Pool/session routing remains in Main.
 */

import {
  PI_BORROW_RESOURCES_DIR_ENV,
  PI_OPT_IN_EXTENSIONS_ENV,
  PI_PROJECT_TRUST_ENV,
} from '../shared/piModelConfig.ts';
import {
  PI_WORKER_GENERATION_ENV,
  WORKER_RPC_PROTOCOL_VERSION,
} from '../shared/types/workerRpc.ts';
import { PiWorkerRpcServer } from './piWorkerRpcServer.ts';

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

const generation = readPositiveGeneration(process.env[PI_WORKER_GENERATION_ENV]);
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
  log: (...args) => console.error('[pi-worker]', ...args),
  onDisposed: () => setImmediate(() => process.exit(0)),
});

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

if (electronPort) {
  electronPort.on('message', (event) => server.receive(messageData(event)));
  electronPort.start();
} else {
  process.on('message', (message) => server.receive(message));
  process.once('disconnect', () => {
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
