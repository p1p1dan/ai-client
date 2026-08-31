import path from 'node:path';
import { PI_WORKER_GENERATION_ENV } from '@shared/types/workerRpc';
import { app, type UtilityProcess, utilityProcess } from 'electron';
import { resolveManagedPiWorkerEnv } from '../piModelConfig';
import { createUtilityProcessWorkerTransport, type WorkerTransport } from './WorkerTransport';

export interface PiWorkerEntryLayout {
  isPackaged: boolean;
  appPath: string;
  resourcesPath: string;
}

export interface PiWorkerProcessOptions {
  generation: number;
  cwd: string;
  entryPath?: string;
  inheritedEnv?: NodeJS.ProcessEnv;
}

export interface ForkedPiWorker {
  process: UtilityProcess;
  transport: WorkerTransport;
}

export function resolvePiWorkerEntryPath(layout: PiWorkerEntryLayout): string {
  return layout.isPackaged
    ? path.join(layout.resourcesPath, 'agent-host', 'worker.js')
    : path.join(layout.appPath, 'src', 'agent-host', 'worker.ts');
}

export function buildPiWorkerEnvironment(input: {
  generation: number;
  inheritedEnv?: NodeJS.ProcessEnv;
  piEnv?: Record<string, string>;
}): Record<string, string> {
  if (!Number.isSafeInteger(input.generation) || input.generation <= 0) {
    throw new Error(`Pi worker generation must be a positive safe integer: ${input.generation}`);
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.inheritedEnv ?? process.env)) {
    if (key !== 'ELECTRON_RUN_AS_NODE' && value !== undefined) env[key] = value;
  }
  Object.assign(env, input.piEnv ?? resolveManagedPiWorkerEnv());
  env[PI_WORKER_GENERATION_ENV] = String(input.generation);
  return env;
}

/** Spawn one utility process for one WorkerSlot generation. */
export function forkPiWorkerProcess(options: PiWorkerProcessOptions): ForkedPiWorker {
  const entryPath =
    options.entryPath ??
    resolvePiWorkerEntryPath({
      isPackaged: app.isPackaged,
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
    });
  const processHandle = utilityProcess.fork(entryPath, [], {
    cwd: options.cwd,
    execArgv: entryPath.endsWith('.ts') ? ['--experimental-strip-types'] : [],
    env: buildPiWorkerEnvironment({
      generation: options.generation,
      inheritedEnv: options.inheritedEnv,
    }),
    stdio: 'pipe',
    serviceName: `AiClient Pi Worker ${options.generation}`,
  });
  return {
    process: processHandle,
    transport: createUtilityProcessWorkerTransport(processHandle),
  };
}
