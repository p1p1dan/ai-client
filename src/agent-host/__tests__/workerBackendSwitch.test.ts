import { fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PI_WORKER_GENERATION_ENV,
  WORKER_RPC_PROTOCOL_VERSION,
  type WorkerRpcResponse,
} from '../../shared/types/workerRpc.ts';

/**
 * ARD D8 / P4-2 — `AICLIENT_RUNTIME_BACKEND` decides which engine a slot runs.
 *
 * Driven through the real worker entry rather than by unit-testing the flag
 * reader, because the thing that can silently rot is the wiring: the entry
 * loads the native module behind a dynamic import and hands the RPC server a
 * factory, and none of that is exercised by importing `readRuntimeFlags`.
 *
 * The native engine is identified by an error only it can produce — it needs an
 * agent directory, and says which variable supplies it. Reaching that message
 * proves the native factory was constructed and called; the legacy backend has
 * no such requirement and never mentions the variable.
 */

const WORKER_ENTRY = path.resolve(__dirname, '..', 'worker.ts');
const TIMEOUT_MS = 30_000;

let workdir: string | undefined;
let child: ReturnType<typeof fork> | undefined;

afterEach(() => {
  child?.kill('SIGKILL');
  child = undefined;
  if (workdir) rmSync(workdir, { recursive: true, force: true });
  workdir = undefined;
});

function bootstrapRequest(cwd: string) {
  return {
    protocolVersion: WORKER_RPC_PROTOCOL_VERSION,
    kind: 'request' as const,
    generation: 1,
    requestId: 'req-1',
    type: 'worker.bootstrap' as const,
    payload: { logicalSessionId: 'logical-1', cwd },
  };
}

/** Start the real worker entry over Node IPC and answer one bootstrap. */
async function bootstrapOnce(backend: string | undefined): Promise<WorkerRpcResponse> {
  workdir = mkdtempSync(path.join(tmpdir(), 'aiclient-backend-'));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    [PI_WORKER_GENERATION_ENV]: '1',
  };
  if (backend) env.AICLIENT_RUNTIME_BACKEND = backend;
  else delete env.AICLIENT_RUNTIME_BACKEND;
  // Deleted so the native path cannot pick one up from the developer's shell
  // and answer with a real bootstrap instead of the expected complaint.
  delete env.AICLIENT_RUNTIME_AGENT_DIR;
  delete env.PI_CODING_AGENT_DIR;

  const proc = fork(WORKER_ENTRY, [], {
    execArgv: ['--experimental-strip-types'],
    cwd: workdir,
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child = proc;
  proc.stdout?.resume();
  proc.stderr?.resume();

  return await new Promise<WorkerRpcResponse>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('worker did not answer')), TIMEOUT_MS - 2000);
    proc.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    proc.on('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`worker exited early (code=${code}, signal=${signal})`));
    });
    proc.on('message', (message) => {
      const response = message as WorkerRpcResponse;
      if (response.kind !== 'response' || response.requestId !== 'req-1') return;
      clearTimeout(timer);
      resolve(response);
    });
    proc.send(bootstrapRequest(workdir as string));
  });
}

describe('worker backend switch (D8)', () => {
  it(
    'native routes bootstrap to the self-owned runtime',
    async () => {
      const response = await bootstrapOnce('native');
      expect(response.ok).toBe(false);
      if (response.ok) return;
      expect(response.error.message).toMatch(/AICLIENT_RUNTIME_AGENT_DIR/);
    },
    TIMEOUT_MS
  );

  it(
    'an unrecognised value falls back to legacy rather than to unfinished code',
    async () => {
      // Typos are expected on a hand-set dev variable; the safe reading is the
      // shipped engine, so the native runtime must not answer here.
      const response = await bootstrapOnce('nativ');
      if (!response.ok) {
        expect(response.error.message).not.toMatch(/AICLIENT_RUNTIME_AGENT_DIR/);
      }
    },
    TIMEOUT_MS
  );
});
