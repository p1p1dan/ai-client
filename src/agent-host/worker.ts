/**
 * Per-slot Pi utility worker entry.
 *
 * One Electron utilityProcess runs this file, owns one PiWorkerRpcServer, and
 * bootstraps at most one Pi AgentSession. Pool/session routing remains in Main.
 */

import { PI_PROJECT_TRUST_ENV } from '../shared/piModelConfig.ts';
import { PI_WORKER_GENERATION_ENV } from '../shared/types/workerRpc.ts';
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

const parentPort = (process as NodeJS.Process & { parentPort?: ElectronParentPort }).parentPort;
if (!parentPort) throw new Error('Pi worker must run as an Electron utility process');

const generation = readPositiveGeneration(process.env[PI_WORKER_GENERATION_ENV]);
const server = new PiWorkerRpcServer({
  port: parentPort,
  generation,
  projectTrusted: readProjectTrusted(process.env[PI_PROJECT_TRUST_ENV]),
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

parentPort.on('message', (event) => server.receive(messageData(event)));
parentPort.start();
