/**
 * P6-2 — what the worker process actually loads, measured rather than reasoned.
 *
 * `nativeWorkerDependencyBoundary.test.ts` reads the static import graph, which
 * cannot see a dynamic `await import()`. This one runs the real worker entry
 * under Node's module hooks and records every specifier it resolves, so the
 * claim being made is the strong one: a native install's worker never loads
 * pi-coding-agent, not even lazily, not for one-shot completions.
 *
 * The positive control is the point of the test: a recorder that quietly logged
 * nothing would make the assertion pass for the wrong reason. Until P6-5 that
 * control was the legacy engine, which loaded the package for real; with that
 * engine retired, a throwaway process that imports the package plays the part.
 */

import { fork } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PI_WORKER_GENERATION_ENV,
  WORKER_RPC_PROTOCOL_VERSION,
  type WorkerRpcResponse,
} from '../../shared/types/workerRpc.ts';

const WORKER_ENTRY = path.resolve(__dirname, '..', 'worker.ts');
const RECORDER = path.resolve(__dirname, 'fixtures', 'recordModuleLoads.mjs');
const TIMEOUT_MS = 30_000;
const PI_CLI_PACKAGE = '@earendil-works/pi-coding-agent';

let workdir: string | undefined;
let child: ReturnType<typeof fork> | undefined;

afterEach(() => {
  child?.kill('SIGKILL');
  child = undefined;
  if (workdir) rmSync(workdir, { recursive: true, force: true });
  workdir = undefined;
});

/** One request against the worker entry; returns every specifier it resolved. */
async function specifiersLoadedDuring(
  job: 'worker.bootstrap' | 'utility.start' = 'worker.bootstrap'
): Promise<string[]> {
  workdir = mkdtempSync(path.join(tmpdir(), 'aiclient-modlog-'));
  const logPath = path.join(workdir, 'modules.log');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    [PI_WORKER_GENERATION_ENV]: '1',
    AICLIENT_MODULE_LOG: logPath,
  };
  // Left unset so the native engine answers with its own complaint instead of
  // running a real turn; the imports under measurement have already happened.
  delete env.AICLIENT_RUNTIME_AGENT_DIR;
  delete env.PI_CODING_AGENT_DIR;

  const proc = fork(WORKER_ENTRY, [], {
    execArgv: ['--experimental-strip-types', '--import', RECORDER],
    cwd: workdir,
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child = proc;
  proc.stdout?.resume();
  proc.stderr?.resume();

  await new Promise<WorkerRpcResponse>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('worker did not answer')), TIMEOUT_MS - 2000);
    proc.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    proc.on('message', (message) => {
      const response = message as WorkerRpcResponse;
      if (response.kind !== 'response' || response.requestId !== 'req-1') return;
      clearTimeout(timer);
      resolve(response);
    });
    proc.send({
      protocolVersion: WORKER_RPC_PROTOCOL_VERSION,
      kind: 'request',
      generation: 1,
      requestId: 'req-1',
      type: job,
      payload:
        job === 'worker.bootstrap'
          ? { logicalSessionId: 'logical-1', cwd: workdir as string }
          : {
              operationId: 'op-1',
              cwd: workdir as string,
              prompt: 'name this conversation',
              timeoutMs: 5000,
            },
    });
  });

  return readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
}

describe('P6-2 what a worker process loads', () => {
  it(
    'records pi-coding-agent when a process really loads it — the control',
    async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'aiclient-modlog-control-'));
      try {
        const logPath = path.join(dir, 'modules.log');
        const probe = fork(path.join(__dirname, 'fixtures', 'loadPiCliProbe.mjs'), [], {
          execArgv: ['--import', RECORDER],
          env: { ...process.env, AICLIENT_MODULE_LOG: logPath },
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
        const code = await new Promise<number | null>((resolve) => probe.on('exit', resolve));
        expect(code).toBe(0);
        const loaded = readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
        expect(loaded.some((specifier) => specifier.startsWith(PI_CLI_PACKAGE))).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    TIMEOUT_MS
  );

  it(
    'never loads pi-coding-agent in a real worker',
    async () => {
      const loaded = await specifiersLoadedDuring();
      // The runtime's own packages must be there, or the process did too little
      // for "did not load pi" to mean anything.
      expect(loaded.some((specifier) => specifier.includes('pi-agent-core'))).toBe(true);
      expect(loaded.filter((specifier) => specifier.startsWith(PI_CLI_PACKAGE))).toEqual([]);
    },
    TIMEOUT_MS
  );

  it(
    'never loads it for a one-shot completion either',
    async () => {
      // The path that used to be the exception: tool-free completions ran on
      // pi's ModelRuntime even in a native install.
      const loaded = await specifiersLoadedDuring('utility.start');
      expect(loaded.some((specifier) => specifier.includes('pi-ai'))).toBe(true);
      expect(loaded.filter((specifier) => specifier.startsWith(PI_CLI_PACKAGE))).toEqual([]);
    },
    TIMEOUT_MS
  );
});
