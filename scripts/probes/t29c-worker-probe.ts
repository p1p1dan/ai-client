import fs from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { app, utilityProcess } from 'electron';
import type { RuntimeEvent } from '../../src/shared/types/runtimeEvents.ts';
import type {
  WorkerSendPayload,
  WorkerSendResult,
  WorkerStopPayload,
  WorkerStopResult,
} from '../../src/shared/types/workerRpc.ts';

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
      delta: { type: 'text_delta', text: 'STREAM-STARTED' },
    });
    // Held open until worker.stop aborts the request.
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

async function waitForPidGone(pid: number, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (pidExists(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (pidExists(pid)) throw new Error(`worker pid ${pid} exists after disposal`);
}

async function main(): Promise<void> {
  console.error('[t29c-probe] waiting for app ready');
  await app.whenReady();
  console.error('[t29c-probe] app ready; loading WorkerSlot modules');
  const { createPiWorkerSlot } = await import(
    '../../src/main/services/agent-host/createPiWorkerSlot.ts'
  );
  const { createUtilityProcessWorkerTransport } = await import(
    '../../src/main/services/agent-host/WorkerTransport.ts'
  );
  console.error('[t29c-probe] starting server');
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('probe server address unavailable');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiclient-t29c-probe-'));
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
              name: 'T29-c Probe',
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
    JSON.stringify({ probe: { type: 'api_key', key: 't29c-probe-key' } })
  );

  const workerPids: number[] = [];
  let generation = 0;

  async function create(logicalSessionId: string, events: RuntimeEvent[]) {
    generation += 1;
    const created = await createPiWorkerSlot({
      slotKey: `probe:${logicalSessionId}`,
      logicalSessionId,
      cwd,
      generation,
      model: 'probe/probe-model',
      effort: 'low',
      createTransport: ({ generation: workerGeneration }) => {
        const env = { ...process.env };
        delete env.ELECTRON_RUN_AS_NODE;
        Object.assign(env, {
          PI_CODING_AGENT_DIR: agentDir,
          AICLIENT_PI_TRUST_PROJECT_CONFIG: '0',
          AICLIENT_PI_WORKER_GENERATION: String(workerGeneration),
        });
        const child = utilityProcess.fork(workerPath, [], {
          cwd,
          env,
          stdio: 'pipe',
          serviceName: `AiClient T29-c Probe ${workerGeneration}`,
        });
        child.stderr?.on('data', (chunk) => process.stderr.write(chunk));
        return createUtilityProcessWorkerTransport(child);
      },
      onEvent: (message) => {
        if (message.type === 'runtime.event') events.push(message.payload as RuntimeEvent);
      },
      requestTimeoutMs: 10_000,
      disposeTimeoutMs: 5_000,
      exitTimeoutMs: 5_000,
    });
    if (!created.slot.pid) throw new Error('probe worker has no pid after bootstrap');
    workerPids.push(created.slot.pid);
    return created;
  }

  try {
    // Full explicit stop/dispose closure.
    console.error('[t29c-probe] explicit slot');
    const firstEvents: RuntimeEvent[] = [];
    const first = await create('probe-explicit', firstEvents);
    const firstTurn = 'probe-turn-explicit';
    console.error('[t29c-probe] explicit bootstrapped');
    const sendResult = await first.slot.request<WorkerSendResult, WorkerSendPayload>(
      'worker.send',
      {
        logicalSessionId: 'probe-explicit',
        requestId: firstTurn,
        attemptId: 'probe-attempt-explicit',
        text: 'stream then wait',
      }
    );
    if (!sendResult.accepted) throw new Error('send was not admitted');
    console.error('[t29c-probe] send admitted');
    await waitForEvent(
      firstEvents,
      (event) => event.type === 'message.delta' && event.requestId === firstTurn
    );
    console.error('[t29c-probe] stream observed');
    const stopResult = await first.slot.request<WorkerStopResult, WorkerStopPayload>(
      'worker.stop',
      {
        logicalSessionId: 'probe-explicit',
        reason: 'user',
      }
    );
    if (!stopResult.stopped) throw new Error('active turn was not stopped');
    await waitForEvent(
      firstEvents,
      (event) => event.type === 'session.stopped' && event.requestId === firstTurn
    );
    const terminals = firstEvents.filter(
      (event) =>
        event.requestId === firstTurn &&
        (event.type === 'session.completed' ||
          event.type === 'session.failed' ||
          event.type === 'session.stopped')
    );
    if (terminals.length !== 1 || terminals[0]?.type !== 'session.stopped') {
      throw new Error(`terminal arbitration failed: ${JSON.stringify(terminals)}`);
    }
    await first.slot.dispose('slot-dispose');
    console.error('[t29c-probe] explicit disposed');

    // App-close path while a turn is active.
    console.error('[t29c-probe] app-close slot');
    const closeEvents: RuntimeEvent[] = [];
    const closing = await create('probe-app-close', closeEvents);
    const closeTurn = 'probe-turn-app-close';
    await closing.slot.request<WorkerSendResult, WorkerSendPayload>('worker.send', {
      logicalSessionId: 'probe-app-close',
      requestId: closeTurn,
      attemptId: 'probe-attempt-app-close',
      text: 'hold until app quit',
    });
    await waitForEvent(
      closeEvents,
      (event) => event.type === 'message.delta' && event.requestId === closeTurn
    );

    console.error('[t29c-probe] app close stream observed');
    await new Promise<void>((resolve, reject) => {
      let cleaning = false;
      app.on('will-quit', (event) => {
        if (cleaning) return;
        event.preventDefault();
        cleaning = true;
        closing.slot.dispose('app-shutdown').then(resolve, reject);
      });
      app.quit();
    });

    for (const pid of workerPids) await waitForPidGone(pid);
    console.log(
      JSON.stringify({
        ok: true,
        workerPids,
        explicitTerminal: terminals[0]?.type,
        explicitSessionFile: first.bootstrap.sessionFile,
        appCloseSessionFile: closing.bootstrap.sessionFile,
        streamed: firstEvents.some((event) => event.type === 'message.delta'),
      })
    );
  } finally {
    for (const response of openResponses) response.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
  app.exit(0);
}

void main().catch((error) => {
  console.error('[t29c-probe] fatal:', error);
  app.exit(1);
});
