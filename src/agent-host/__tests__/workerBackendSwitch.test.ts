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

/**
 * P5-4 — drive one `worker.import` through the real entry on the native
 * backend.
 *
 * Same reasoning as the bootstrap cases above: the thing that rots is the
 * wiring, not the writer. And the two writers are distinguishable from the
 * outside without inspecting imports — the native one publishes a v4 JSONL
 * header under `<agentDir>/sessions/<id>.jsonl`, while the pi writer produces a
 * pi session in a directory its own SDK derives from the workspace.
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
      AICLIENT_RUNTIME_BACKEND: 'native',
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
    'native writes the imported session itself, without loading pi-coding-agent',
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

describe('worker backend switch (D8)', () => {
  it(
    'flushes the dispose acknowledgement and exits naturally over Node IPC',
    async () => {
      await bootstrapOnce('native');
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
