import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { app, utilityProcess } from 'electron';
import type {
  WorkerImportConversationPayload,
  WorkerImportConversationResult,
} from '../../src/shared/types/legacyImport.ts';
import type { SessionIndexEntry } from '../../src/shared/types/sessionIndex.ts';
import { isWorkerImportResult } from '../../src/shared/types/workerRpc.ts';

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
    const id = `msg-${Date.now()}`;
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
      delta: { type: 'text_delta', text: 'CONTINUED-IN-PI' },
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

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for probe condition');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function main(): Promise<void> {
  await app.whenReady();
  const { WorkerSlot } = await import('../../src/main/services/agent-host/WorkerSlot.ts');
  const { createUtilityProcessWorkerTransport } = await import(
    '../../src/main/services/agent-host/WorkerTransport.ts'
  );
  const { createPiWorkerSlot } = await import(
    '../../src/main/services/agent-host/createPiWorkerSlot.ts'
  );
  const { ClaudeSessionScanner } = await import(
    '../../src/main/services/legacyImport/ClaudeSessionScanner.ts'
  );
  const { LegacyImportManifest } = await import(
    '../../src/main/services/legacyImport/LegacyImportManifest.ts'
  );
  const { LegacyImportService } = await import(
    '../../src/main/services/legacyImport/LegacyImportService.ts'
  );

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('probe server unavailable');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiclient-t34-probe-'));
  const agentDir = path.join(root, 'agent');
  const cwd = path.join(root, 'workspace');
  const claudeDir = path.join(root, 'claude');
  const projectId = 'project-a';
  const sourceFile = path.join(claudeDir, 'projects', projectId, 'legacy-session.jsonl');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
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
              name: 'T34 Probe',
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
    JSON.stringify({ probe: { type: 'api_key', key: 'probe-key' } })
  );
  fs.writeFileSync(
    sourceFile,
    `${JSON.stringify({ type: 'system', subtype: 'init', cwd })}\n${JSON.stringify({ type: 'user', uuid: 'u1', cwd, message: { role: 'user', content: 'IMPORTED-USER' } })}\n${JSON.stringify(
      {
        type: 'assistant',
        uuid: 'a1',
        message: {
          role: 'assistant',
          model: 'claude-legacy',
          content: [
            { type: 'text', text: 'IMPORTED-ASSISTANT' },
            { type: 'server_tool_use', name: 'display-only' },
          ],
        },
      }
    )}\n`
  );
  const before = fs.statSync(sourceFile);
  const beforeHash = createHash('sha256').update(fs.readFileSync(sourceFile)).digest('hex');
  const pids: number[] = [];
  const envFor = (generation: number) => ({
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    AICLIENT_PI_TRUST_PROJECT_CONFIG: '0',
    AICLIENT_PI_WORKER_GENERATION: String(generation),
  });
  delete envFor(1).ELECTRON_RUN_AS_NODE;

  const rows = new Map<string, SessionIndexEntry>();
  const createImport = async (payload: WorkerImportConversationPayload) => {
    const generation = 1;
    const env = envFor(generation);
    delete env.ELECTRON_RUN_AS_NODE;
    const child = utilityProcess.fork(workerPath, [], {
      cwd,
      env,
      stdio: 'pipe',
      serviceName: 'AiClient T34 Import Probe',
    });
    if (child.pid) pids.push(child.pid);
    const slot = new WorkerSlot({
      slotKey: `import:${payload.logicalSessionId}`,
      cwd,
      generation,
      transport: createUtilityProcessWorkerTransport(child),
      requestTimeoutMs: 120_000,
      disposeTimeoutMs: 5_000,
      exitTimeoutMs: 5_000,
    });
    const result = await slot.request<
      WorkerImportConversationResult,
      WorkerImportConversationPayload
    >('worker.import', payload, { timeoutMs: 120_000 });
    if (slot.pid && !pids.includes(slot.pid)) pids.push(slot.pid);
    if (!isWorkerImportResult(result)) throw new Error('invalid import result');
    let disposed = false;
    return {
      result,
      discard: async () =>
        (
          await slot.request<{ discarded: boolean }>('worker.import.discard', {
            logicalSessionId: payload.logicalSessionId,
            sessionFile: result.finalSessionFile,
          })
        ).discarded,
      dispose: async () => {
        if (!disposed) {
          disposed = true;
          await slot.dispose('slot-dispose');
        }
      },
    };
  };
  const index = {
    get: async (id: string) => rows.get(id),
    createImported: async (entry: SessionIndexEntry) => {
      rows.set(entry.sessionId, entry);
      return entry;
    },
    removeImported: async (id: string, runtimeIdentity: string) => {
      const row = rows.get(id);
      if (!row || row.runtimeIdentity !== runtimeIdentity) return false;
      rows.delete(id);
      return true;
    },
  };
  const service = new LegacyImportService({
    scanner: new ClaudeSessionScanner({ resolveRoots: () => [{ dir: claudeDir, kind: 'legacy' }] }),
    manifest: new LegacyImportManifest({ manifestPath: path.join(root, 'manifest.json') }),
    sessionIndex: index,
    createImport,
    inspectImport: async () => ({ sessionFiles: [] }),
    reconcileImport: async () => ({ removedFiles: 0, remainingFiles: 0 }),
  });

  let liveSlot: Awaited<ReturnType<typeof createPiWorkerSlot>> | null = null;
  const events: Array<{ type?: string }> = [];
  try {
    const batch = await service.importBatch([
      { sourceKind: 'claude-code', projectId, sourceSessionId: 'legacy-session' },
    ]);
    const imported = batch.results[0];
    if (imported?.status !== 'imported' || !imported.session?.runtimeIdentity)
      throw new Error(`import failed: ${JSON.stringify(imported)}`);
    const after = fs.statSync(sourceFile);
    const sourceImmutable =
      before.size === after.size &&
      before.mode === after.mode &&
      before.mtimeMs === after.mtimeMs &&
      beforeHash === createHash('sha256').update(fs.readFileSync(sourceFile)).digest('hex');

    liveSlot = await createPiWorkerSlot({
      slotKey: `session:${imported.session.runtimeIdentity}`,
      logicalSessionId: imported.session.sessionId,
      cwd,
      sessionFile: imported.session.runtimeIdentity,
      model: 'probe/probe-model',
      createTransport: ({ generation }) => {
        const env = envFor(generation);
        delete env.ELECTRON_RUN_AS_NODE;
        const child = utilityProcess.fork(workerPath, [], {
          cwd,
          env,
          stdio: 'pipe',
          serviceName: 'AiClient T34 Continue Probe',
        });
        if (child.pid) pids.push(child.pid);
        return createUtilityProcessWorkerTransport(child);
      },
      onEvent: (message) => {
        if (message.type === 'runtime.event') events.push(message.payload as { type?: string });
      },
      requestTimeoutMs: 20_000,
      disposeTimeoutMs: 5_000,
      exitTimeoutMs: 5_000,
    });
    if (liveSlot.slot.pid && !pids.includes(liveSlot.slot.pid)) pids.push(liveSlot.slot.pid);
    const historyText = JSON.stringify(liveSlot.bootstrap.initialHistory?.page.messages ?? []);
    if (
      !historyText.includes('IMPORTED-USER') ||
      !historyText.includes('IMPORTED-ASSISTANT') ||
      !historyText.includes('server_tool_use')
    )
      throw new Error(`missing imported history: ${historyText}`);
    await liveSlot.slot.request('worker.send', {
      logicalSessionId: imported.session.sessionId,
      requestId: 'probe-turn',
      attemptId: 'probe-attempt',
      text: 'continue',
      model: 'probe/probe-model',
      effort: 'low',
    });
    await waitFor(() => events.some((event) => event.type === 'session.completed'));
    await liveSlot.slot.dispose('slot-dispose');
    liveSlot = null;
    await waitFor(() => pids.every((pid) => !pidExists(pid)), 10_000);
    console.log(
      JSON.stringify({
        ok: true,
        sourceImmutable,
        importedHistory: true,
        continuedInPi: true,
        workerPids: pids,
        orphanWorkerPids: pids.filter(pidExists),
      })
    );
  } finally {
    await liveSlot?.slot.dispose('slot-dispose').catch(() => undefined);
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
    app.quit();
  }
}

void main().catch((error) => {
  console.error(error);
  server.close();
  app.exit(1);
});
