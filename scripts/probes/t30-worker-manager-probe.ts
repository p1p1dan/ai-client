import fs from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { app, utilityProcess } from 'electron';
import type { CreatePiWorkerSlotOptions } from '../../src/main/services/agent-host/createPiWorkerSlot.ts';
import type { RuntimeEvent } from '../../src/shared/types/runtimeEvents.ts';

const workerPath = process.argv.at(-1);
if (!workerPath) throw new Error('worker path required');
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

function writeSse(res: ServerResponse, type: string, payload: unknown): void {
  res.write(`event: ${type}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

const openResponses = new Set<ServerResponse>();
const server = createServer((req, res) => {
  req.on('data', () => undefined);
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    openResponses.add(res);
    res.on('close', () => openResponses.delete(res));
    writeSse(res, 'message_start', {
      type: 'message_start',
      message: {
        id: `msg-${Date.now()}`,
        type: 'message',
        role: 'assistant',
        model: 'probe-model',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    });
    writeSse(res, 'content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    });
    writeSse(res, 'content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'T30-STREAM' },
    });
  });
});

function waitForEvent(
  events: RuntimeEvent[],
  predicate: (event: RuntimeEvent) => boolean,
  timeoutMs = 15_000
): Promise<RuntimeEvent> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      const event = events.find(predicate);
      if (event) return resolve(event);
      if (Date.now() >= deadline) return reject(new Error('timed out waiting for RuntimeEvent'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidGone(pid: number, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (pidExists(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (pidExists(pid)) throw new Error(`worker pid ${pid} exists after disposal`);
}

async function main(): Promise<void> {
  await app.whenReady();
  const { createPiWorkerSlot } = await import(
    '../../src/main/services/agent-host/createPiWorkerSlot.ts'
  );
  const { WorkerManager } = await import('../../src/main/services/agent-host/WorkerManager.ts');
  const { createUtilityProcessWorkerTransport } = await import(
    '../../src/main/services/agent-host/WorkerTransport.ts'
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('probe server address unavailable');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiclient-t30-probe-'));
  const agentDir = path.join(root, 'agent');
  const cwd = path.join(root, 'workspace');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, 'models.json'),
    JSON.stringify({
      providers: {
        probe: {
          baseUrl: `http://127.0.0.1:${address.port}`,
          api: 'anthropic-messages',
          authHeader: true,
          models: [
            {
              id: 'probe-model',
              name: 'T30 Probe',
              reasoning: false,
              contextWindow: 8192,
              maxTokens: 1024,
            },
          ],
        },
      },
    })
  );
  fs.writeFileSync(
    path.join(agentDir, 'auth.json'),
    JSON.stringify({ probe: { type: 'api_key', key: 't30-probe-key' } })
  );

  const workerPids: number[] = [];
  const events: RuntimeEvent[] = [];
  const createSlot = async (options: CreatePiWorkerSlotOptions) => {
    const created = await createPiWorkerSlot({
      ...options,
      createTransport: ({ generation }) => {
        const env = { ...process.env };
        delete env.ELECTRON_RUN_AS_NODE;
        Object.assign(env, {
          PI_CODING_AGENT_DIR: agentDir,
          AICLIENT_PI_TRUST_PROJECT_CONFIG: '0',
          AICLIENT_PI_WORKER_GENERATION: String(generation),
        });
        const child = utilityProcess.fork(workerPath, [], {
          cwd,
          env,
          stdio: 'pipe',
          serviceName: `AiClient T30 Probe ${options.logicalSessionId} g${generation}`,
        });
        child.stderr?.on('data', (chunk) => process.stderr.write(chunk));
        return createUtilityProcessWorkerTransport(child);
      },
      requestTimeoutMs: 10_000,
      disposeTimeoutMs: 5_000,
      exitTimeoutMs: 5_000,
    });
    if (!created.slot.pid) throw new Error('probe worker has no pid');
    workerPids.push(created.slot.pid);
    return created;
  };

  const manager = new WorkerManager({
    createSlot,
    bindRuntimeIdentity: async () => undefined,
    capacity: 2,
    idleTimeoutMs: 0,
    idleSweepIntervalMs: 0,
    onEvent: (event) => events.push(event),
  });

  try {
    await manager.createSession({
      sessionId: 'probe-a',
      workspacePath: cwd,
      model: 'probe/probe-model',
      effort: 'low',
    });
    await manager.createSession({
      sessionId: 'probe-b',
      workspacePath: cwd,
      model: 'probe/probe-model',
      effort: 'low',
    });
    const turnA = await manager.send({
      sessionId: 'probe-a',
      attemptId: 'probe-attempt-a',
      text: 'stream A',
    });
    const turnB = await manager.send({
      sessionId: 'probe-b',
      attemptId: 'probe-attempt-b',
      text: 'stream B',
    });
    await Promise.all([
      waitForEvent(events, (event) => event.type === 'message.delta' && event.requestId === turnA),
      waitForEvent(events, (event) => event.type === 'message.delta' && event.requestId === turnB),
    ]);

    const snapshots = manager.getSlotSnapshots();
    if (snapshots.length !== 2 || new Set(snapshots.map((slot) => slot.sessionFile)).size !== 2) {
      throw new Error(`multi-slot identity failure: ${JSON.stringify(snapshots)}`);
    }

    await new Promise<void>((resolve, reject) => {
      let cleaning = false;
      app.on('will-quit', (event) => {
        if (cleaning) return;
        event.preventDefault();
        cleaning = true;
        manager.disposeAll('app-shutdown').then(resolve, reject);
      });
      app.quit();
    });

    for (const pid of workerPids) await waitForPidGone(pid);
    console.log(
      JSON.stringify({
        ok: true,
        workerPids,
        sessions: snapshots.map((slot) => slot.sessionFile),
        streamedSessions: [
          ...new Set(
            events.filter((event) => event.type === 'message.delta').map((event) => event.sessionId)
          ),
        ],
      })
    );
  } finally {
    manager.forceKillAllNow();
    for (const response of openResponses) response.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
  app.exit(0);
}

void main().catch((error) => {
  console.error('[t30-probe] fatal:', error);
  app.exit(1);
});
