import fs from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { app, utilityProcess } from 'electron';
import type { CreatePiWorkerSlotOptions } from '../../src/main/services/agent-host/createPiWorkerSlot.ts';
import type { RuntimeEvent } from '../../src/shared/types/runtimeEvents.ts';
import type { SessionTreeNode } from '../../src/shared/types/sessionHistory.ts';
import type { SessionIndexEntry } from '../../src/shared/types/sessionIndex.ts';

const workerPath = process.argv.at(-1);
if (!workerPath) throw new Error('worker path required');
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

function writeSse(res: ServerResponse, type: string, payload: unknown): void {
  res.write(`event: ${type}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

const server = createServer((req, res) => {
  req.on('data', () => undefined);
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const id = `msg-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    writeSse(res, 'message_start', {
      type: 'message_start',
      message: {
        id,
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
      delta: { type: 'text_delta', text: 'PROBE-REPLY' },
    });
    writeSse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
    writeSse(res, 'message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    });
    writeSse(res, 'message_stop', { type: 'message_stop' });
    res.end();
  });
});

function waitForEvent(
  events: RuntimeEvent[],
  predicate: (event: RuntimeEvent) => boolean,
  timeoutMs = 20_000
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

async function waitForCondition(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidGone(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (pidExists(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (pidExists(pid)) throw new Error(`worker pid ${pid} exists after disposal`);
}

function userNode(nodes: SessionTreeNode[], preview: string): SessionTreeNode {
  const node = nodes.find(
    (candidate) => candidate.role === 'user' && candidate.preview === preview
  );
  if (!node) throw new Error(`missing user node ${preview}`);
  return node;
}

function assistantChild(nodes: SessionTreeNode[], parentId: string): SessionTreeNode {
  const node = nodes.find(
    (candidate) => candidate.parentId === parentId && candidate.role === 'assistant'
  );
  if (!node) throw new Error(`missing assistant child of ${parentId}`);
  return node;
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

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiclient-t33-probe-'));
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
              name: 'T33 Probe',
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
    JSON.stringify({ probe: { type: 'api_key', key: 't33-probe-key' } })
  );

  const workerPids: number[] = [];
  const events: RuntimeEvent[] = [];
  const index = new Map<string, SessionIndexEntry>();
  index.set('source', {
    sessionId: 'source',
    agent: 'pi',
    workspacePath: cwd,
    title: 'Source',
    model: 'probe/probe-model',
    updatedAt: Date.now(),
    archived: false,
  });

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
          serviceName: `AiClient T33 Probe ${options.logicalSessionId} g${generation}`,
        });
        child.stderr?.on('data', (chunk) => process.stderr.write(chunk));
        return createUtilityProcessWorkerTransport(child);
      },
      requestTimeoutMs: 15_000,
      disposeTimeoutMs: 5_000,
      exitTimeoutMs: 5_000,
    });
    if (!created.slot.pid) throw new Error('probe worker has no pid');
    workerPids.push(created.slot.pid);
    return created;
  };

  const manager = new WorkerManager({
    createSlot,
    bindRuntimeIdentity: async (sessionId, runtimeIdentity) => {
      const existing = index.get(sessionId);
      if (!existing) throw new Error(`missing index row ${sessionId}`);
      index.set(sessionId, { ...existing, runtimeIdentity, updatedAt: Date.now() });
    },
    commitResumed: async (input) => {
      const existing = index.get(input.sessionId);
      if (!existing || existing.runtimeIdentity !== input.runtimeIdentity) {
        throw new Error(`resume index mismatch ${input.sessionId}`);
      }
      index.set(input.sessionId, {
        ...existing,
        workspacePath: input.workspacePath,
        ...(input.piLeaf ? { piLeaf: input.piLeaf } : {}),
        updatedAt: Date.now(),
      });
    },
    commitPiLeaf: async ({ sessionId, runtimeIdentity, piLeaf }) => {
      const existing = index.get(sessionId);
      if (!existing || existing.runtimeIdentity !== runtimeIdentity) {
        throw new Error(`leaf index mismatch ${sessionId}`);
      }
      index.set(sessionId, { ...existing, piLeaf, updatedAt: Date.now() });
    },
    createForked: async (entry) => {
      if (index.has(entry.sessionId)) throw new Error(`duplicate fork ${entry.sessionId}`);
      index.set(entry.sessionId, { ...entry });
      return { ...entry };
    },
    capacity: 2,
    idleTimeoutMs: 0,
    idleSweepIntervalMs: 0,
    onEvent: (event) => events.push(event),
  });

  const sendAndSettle = async (sessionId: string, text: string) => {
    const requestId = await manager.send({
      sessionId,
      attemptId: `attempt-${sessionId}-${text}`,
      text,
      model: 'probe/probe-model',
      effort: 'low',
    });
    await waitForEvent(
      events,
      (event) => event.type === 'session.completed' && event.requestId === requestId
    );
    return requestId;
  };

  try {
    await manager.createSession({
      sessionId: 'source',
      workspacePath: cwd,
      model: 'probe/probe-model',
      effort: 'low',
    });
    await sendAndSettle('source', 'A');
    await sendAndSettle('source', 'B');
    await sendAndSettle('source', 'C');

    const sourceFile = manager.getSlotSnapshots()[0]?.sessionFile;
    if (!sourceFile) throw new Error('source durable session file missing');
    const beforeStat = fs.statSync(sourceFile);
    const firstTree = await manager.getSessionTree({ sessionId: 'source', requestSequence: 1 });
    const aUser = userNode(firstTree.snapshot.nodes, 'A');
    const aAssistant = assistantChild(firstTree.snapshot.nodes, aUser.id);
    const bUser = userNode(firstTree.snapshot.nodes, 'B');
    const cUser = userNode(firstTree.snapshot.nodes, 'C');

    const rewind = await manager.rewindSession({
      sessionId: 'source',
      entryId: aAssistant.id,
      confirmed: true,
    });
    const rewindCheckpoint = index.get('source')?.piLeaf;
    if (!rewindCheckpoint || rewindCheckpoint.activeEntryId !== aAssistant.id) {
      throw new Error(`rewind checkpoint mismatch: ${JSON.stringify(rewindCheckpoint)}`);
    }
    await manager.closeSession('source');
    await manager.resumeSession({
      sessionId: 'source',
      sessionFile: sourceFile,
      workspacePath: cwd,
      model: 'probe/probe-model',
      effort: 'low',
      leafCheckpoint: rewindCheckpoint,
    });
    const reopenedTree = await manager.getSessionTree({ sessionId: 'source', requestSequence: 2 });
    if (reopenedTree.snapshot.leaf.activeEntryId !== aAssistant.id) {
      throw new Error('rewound leaf did not survive exact-file reopen');
    }

    await sendAndSettle('source', 'D');
    await waitForCondition(() => {
      const leaf = index.get('source')?.piLeaf;
      return Boolean(leaf && leaf.fileTailEntryId !== rewindCheckpoint.fileTailEntryId);
    });
    const branchedTree = await manager.getSessionTree({ sessionId: 'source', requestSequence: 3 });
    const dUser = userNode(branchedTree.snapshot.nodes, 'D');
    if (!branchedTree.snapshot.nodes.some((node) => node.id === bUser.id)) {
      throw new Error('B branch disappeared after rewind/send D');
    }
    if (!branchedTree.snapshot.nodes.some((node) => node.id === cUser.id)) {
      throw new Error('C branch disappeared after rewind/send D');
    }
    if (bUser.parentId !== dUser.parentId) {
      throw new Error(
        `B and D do not branch from the same point: ${bUser.parentId} vs ${dUser.parentId}`
      );
    }
    const afterRewindStat = fs.statSync(sourceFile);
    if (afterRewindStat.ino !== beforeStat.ino || afterRewindStat.size < beforeStat.size) {
      throw new Error('rewind replaced or truncated the source JSONL');
    }

    const sourceLeafBeforeFork = branchedTree.snapshot.leaf;
    const forked = await manager.forkSession({
      sourceSessionId: 'source',
      entryId: aAssistant.id,
      sourceTitle: 'Source',
      model: 'probe/probe-model',
    });
    const forkSessionId = forked.session.sessionId;
    if (forked.session.runtimeIdentity === sourceFile) {
      throw new Error('fork reused the source Pi session file');
    }
    const sourceAfterFork = await manager.getSessionTree({
      sessionId: 'source',
      requestSequence: 4,
    });
    if (sourceAfterFork.snapshot.leaf.activeEntryId !== sourceLeafBeforeFork.activeEntryId) {
      throw new Error('fork changed the source active leaf');
    }

    await Promise.all([sendAndSettle('source', 'E'), sendAndSettle(forkSessionId, 'F')]);
    const sourceFinal = await manager.getSessionTree({ sessionId: 'source', requestSequence: 5 });
    const forkFinal = await manager.getSessionTree({
      sessionId: forkSessionId,
      requestSequence: 1,
    });
    userNode(sourceFinal.snapshot.nodes, 'E');
    userNode(forkFinal.snapshot.nodes, 'F');
    if (sourceFinal.snapshot.sessionFile === forkFinal.snapshot.sessionFile) {
      throw new Error('source and fork share one durable file');
    }

    await manager.disposeAll('app-shutdown');
    for (const pid of workerPids) await waitForPidGone(pid);
    console.log(
      JSON.stringify({
        ok: true,
        rewindBranchesPreserved: true,
        rewindSurvivedRestart: rewind.leaf.activeEntryId === aAssistant.id,
        forkSourceUnchanged: true,
        forkIndependentSlot: true,
        independentContinuation: true,
        workerPids,
        orphanWorkerPids: workerPids.filter(pidExists),
        sourceFile,
        forkFile: forkFinal.snapshot.sessionFile,
      })
    );
  } finally {
    manager.forceKillAllNow();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
  app.exit(0);
}

void main().catch((error) => {
  console.error('[t33-probe] fatal:', error);
  app.exit(1);
});
