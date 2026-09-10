import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { PI_WORKER_GENERATION_ENV } from '@shared/types/workerRpc';
import { app, type UtilityProcess, utilityProcess } from 'electron';
import { resolveManagedPiWorkerEnv } from '../piModelConfig';
import {
  createNodeProcessWorkerTransport,
  createUtilityProcessWorkerTransport,
  type WorkerTransport,
} from './WorkerTransport';

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
  process: UtilityProcess | ChildProcess;
  transport: WorkerTransport;
}

export function resolvePiWorkerEntryPath(layout: PiWorkerEntryLayout): string {
  return layout.isPackaged
    ? path.join(layout.resourcesPath, 'agent-host', 'worker.js')
    : path.join(layout.appPath, 'src', 'agent-host', 'worker.ts');
}

export function resolveCurrentPiWorkerEntryPath(): string {
  return resolvePiWorkerEntryPath({
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
  });
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

/** Spawn one isolated process for one WorkerSlot generation. */
export function forkPiWorkerProcess(options: PiWorkerProcessOptions): ForkedPiWorker {
  const entryPath = options.entryPath ?? resolveCurrentPiWorkerEntryPath();
  // A cwd that no longer exists makes `spawn`/`fork` fail with ENOENT naming
  // the COMMAND, not the directory — which is how a missing temp workspace
  // surfaced on the encrypted Windows host as `spawn ...\node.exe ENOENT`
  // while node.exe was sitting on disk the whole time. Check it here, next to
  // the runtime check below that already exists for exactly this reason.
  if (!existsSync(options.cwd)) {
    throw new Error(
      `WORKER_WORKSPACE_MISSING: Pi worker working directory is missing: ${options.cwd}`
    );
  }
  const env = buildPiWorkerEnvironment({
    generation: options.generation,
    inheritedEnv: options.inheritedEnv,
  });
  if (app.isPackaged && process.platform === 'win32') {
    // D20: TUI works on the affected encrypted Windows host; GUI utilityProcess does not.
    // Use the same bundled Node runtime, including for descendant tools.
    const nodePath = path.join(process.resourcesPath, 'node-runtime', 'node.exe');
    if (!existsSync(nodePath)) throw new Error(`Pi Node runtime is missing: ${nodePath}`);
    env.PATH = `${path.dirname(nodePath)};${env.PATH || env.Path || ''}`;
    env.Path = env.PATH;
    const processHandle = spawn(nodePath, [entryPath], {
      cwd: options.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });
    return { process: processHandle, transport: createNodeProcessWorkerTransport(processHandle) };
  }
  const processHandle = utilityProcess.fork(entryPath, [], {
    cwd: options.cwd,
    execArgv: entryPath.endsWith('.ts') ? ['--experimental-strip-types'] : [],
    env,
    stdio: 'pipe',
    serviceName: `AiClient Pi Worker ${options.generation}`,
  });
  return {
    process: processHandle,
    transport: createUtilityProcessWorkerTransport(processHandle),
  };
}
