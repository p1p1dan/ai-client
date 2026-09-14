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

/**
 * The worker entry's wiring, driven through the real process.
 *
 * This file was the backend-switch test until P6-5 retired the second engine.
 * What is left is the part that could always rot silently: the entry loads the
 * runtime behind a dynamic import and hands the RPC server three factories, and
 * none of that is exercised by importing `readRuntimeFlags`.
 *
 * The engine is identified by an error only it can produce — it needs an agent
 * directory, and names the variable that supplies one. Reaching that message
 * proves the factory was constructed and called rather than merely defined.
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
async function bootstrapOnce(): Promise<WorkerRpcResponse> {
  workdir = mkdtempSync(path.join(tmpdir(), 'aiclient-entry-'));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    [PI_WORKER_GENERATION_ENV]: '1',
  };
  delete env.AICLIENT_RUNTIME_BACKEND;
  // Deleted so the runtime cannot pick one up from the developer's shell
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

/**
 * P6-2 — drive one `utility.start` through the real entry.
 *
 * Same identification trick as the bootstrap case: the runtime complains about
 * a missing catalog directory by name, which the deleted pi runner never did —
 * it resolved its own agent directory and failed, if at all, about models or
 * authentication.
 */
async function utilityOnce(): Promise<WorkerRpcResponse> {
  workdir = mkdtempSync(path.join(tmpdir(), 'aiclient-utility-'));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    [PI_WORKER_GENERATION_ENV]: '1',
  };
  delete env.AICLIENT_RUNTIME_BACKEND;
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
    proc.on('message', (message) => {
      const response = message as WorkerRpcResponse;
      if (response.kind !== 'response' || response.requestId !== 'util-1') return;
      clearTimeout(timer);
      resolve(response);
    });
    proc.send({
      protocolVersion: WORKER_RPC_PROTOCOL_VERSION,
      kind: 'request',
      generation: 1,
      requestId: 'util-1',
      type: 'utility.start',
      payload: {
        operationId: 'op-1',
        cwd: workdir,
        prompt: 'name this conversation',
        timeoutMs: 5000,
      },
    });
  });
}

/**
 * P5-4 — drive one `worker.import` through the real entry.
 *
 * Same reasoning as the bootstrap cases above: the thing that rots is the
 * wiring, not the writer. The assertion stays written the way it was when there
 * were two writers to tell apart — a v4 header under
 * `<agentDir>/sessions/<id>.jsonl` — because that is still the contract Main
 * keys on when it goes looking for what the import produced.
 */
async function importOnce(agentDir: string): Promise<{
  response: WorkerRpcResponse;
  workspace: string;
}> {
  workdir = mkdtempSync(path.join(tmpdir(), 'aiclient-import-'));
  const proc = fork(WORKER_ENTRY, [], {
    execArgv: ['--experimental-strip-types'],
    cwd: workdir,
    env: {
      ...process.env,
      [PI_WORKER_GENERATION_ENV]: '1',
      AICLIENT_RUNTIME_AGENT_DIR: agentDir,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child = proc;
  proc.stdout?.resume();
  proc.stderr?.resume();
  const workspace = workdir;
  const response = await new Promise<WorkerRpcResponse>((resolve, reject) => {
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
      const answer = message as WorkerRpcResponse;
      if (answer.kind !== 'response' || answer.requestId !== 'import-1') return;
      clearTimeout(timer);
      resolve(answer);
    });
    proc.send({
      protocolVersion: WORKER_RPC_PROTOCOL_VERSION,
      kind: 'request',
      generation: 1,
      requestId: 'import-1',
      type: 'worker.import',
      payload: {
        logicalSessionId: 'logical-1',
        targetPiSessionId: 'import-claude-code-e2e',
        conversation: {
          schemaVersion: 1,
          importerVersion: 'b4-legacy-v2',
          sourceKind: 'claude-code',
          stableSourceIdentity: 'claude:/x:1',
          sourceSessionId: '1',
          workspacePath: workspace,
          title: '导入的会话',
          sourceFingerprint: {
            stableSourceIdentity: 'claude:/x:1',
            contentHash: 'abc',
            size: 1,
            mode: 0o600,
            mtimeMs: 1,
          },
          entries: [
            { kind: 'user', text: '你好' },
            { kind: 'assistant', blocks: [{ type: 'text', text: '你也好' }] },
          ],
          diagnostics: [],
        },
      },
    });
  });
  return { response, workspace };
}

describe('worker conversation import (P5-4)', () => {
  it(
    'writes the imported session under the agent directory Main will look in',
    async () => {
      const agentDir = mkdtempSync(path.join(tmpdir(), 'aiclient-import-agent-'));
      try {
        const { response } = await importOnce(agentDir);
        expect(response.ok).toBe(true);
        if (!response.ok) return;
        const result = response.result as { finalSessionFile: string; piSessionId: string };
        expect(result.finalSessionFile).toBe(
          path.join(agentDir, 'sessions', 'import-claude-code-e2e.jsonl')
        );
        const header = JSON.parse(
          readFileSync(result.finalSessionFile, 'utf8').split('\n')[0] as string
        );
        expect(header).toMatchObject({ kind: 'header', version: 4, id: 'import-claude-code-e2e' });
      } finally {
        rmSync(agentDir, { recursive: true, force: true });
      }
    },
    TIMEOUT_MS
  );
});

describe('worker entry wiring', () => {
  it(
    'flushes the dispose acknowledgement and exits naturally over Node IPC',
    async () => {
      await bootstrapOnce();
      const proc = child!;
      const messages: WorkerRpcResponse[] = [];
      proc.on('message', (message) => messages.push(message as WorkerRpcResponse));
      const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
        proc.once('exit', (code, signal) => resolve({ code, signal }));
      });
      proc.send({
        protocolVersion: WORKER_RPC_PROTOCOL_VERSION,
        kind: 'request',
        generation: 1,
        requestId: 'dispose-test',
        type: 'worker.dispose',
        payload: { reason: 'app-shutdown' },
      });
      expect(await exited).toEqual({ code: 0, signal: null });
      expect(messages).toContainEqual(
        expect.objectContaining({ requestId: 'dispose-test', ok: true, result: { disposed: true } })
      );
    },
    TIMEOUT_MS
  );

  it(
    'routes bootstrap to the self-owned runtime, with or without a stale variable',
    async () => {
      const response = await bootstrapOnce();
      expect(response.ok).toBe(false);
      if (response.ok) return;
      expect(response.error.message).toMatch(/AICLIENT_RUNTIME_AGENT_DIR/);
    },
    TIMEOUT_MS
  );

  it(
    'runs one-shot completions on the native runtime too (P6-2)',
    async () => {
      const response = await utilityOnce();
      expect(response.ok).toBe(false);
      if (response.ok) return;
      expect(response.error.message).toMatch(/AICLIENT_RUNTIME_AGENT_DIR/);
    },
    TIMEOUT_MS
  );
});
