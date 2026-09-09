import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExtensionUiRequest } from '../../agent-host/extensionUiBridge.ts';
import { PiWorkerRpcServer } from '../../agent-host/piWorkerRpcServer.ts';
import type { RuntimeEvent } from '../../shared/types/runtimeEvents.ts';
import type { SessionTreeSnapshot } from '../../shared/types/sessionHistory.ts';
import {
  WORKER_RPC_PROTOCOL_VERSION,
  type WorkerForkResult,
  type WorkerRewindResult,
  type WorkerRpcResponse,
} from '../../shared/types/workerRpc.ts';
import { createRuntime } from '../bootstrap.ts';
import type { RuntimeHostConfig } from '../contracts.ts';
import { NativeWorkerRuntime } from '../worker/nativeWorkerRuntime.ts';

/**
 * P4-4 — the full chain on the native backend: multi-turn loop, tool execution,
 * permission approval, compaction and durable session, driven through the real
 * `PiWorkerRpcServer` rather than by calling the runtime directly.
 *
 * Only two things are stood in for: the provider (pi-ai's own faux, so the
 * assertions are deterministic and nothing is billed) and the message port. The
 * dispatcher, the adapter, the Cordis graph, the tools, the permission gate and
 * the JSONL writer are all the real ones — which is the point, since every bug
 * P4-1..P4-3 could have introduced lives in the seams between them. The process
 * boundary itself is covered by `agent-host/__tests__/workerBackendSwitch`.
 */

const HOST: RuntimeHostConfig = {
  carrier: 'electron-utility',
  tsdReadFallback: 'disabled',
  exec: { mode: 'pipe' },
  childEnv: {},
  cleanupTimeoutMs: 2000,
};
const MODEL = 'faux/faux-e2e';

let workspace: string;
let agentDir: string;
let server: PiWorkerRpcServer | undefined;
let faux: ReturnType<typeof fauxProvider>;
let outbound: unknown[];

/** Everything the port received, split the way the caller cares about it. */
function responses(): WorkerRpcResponse[] {
  return outbound.filter(
    (message): message is WorkerRpcResponse => (message as { kind?: string }).kind === 'response'
  );
}
function events(): RuntimeEvent[] {
  return outbound
    .filter((message) => (message as { type?: string }).type === 'runtime.event')
    .map((message) => (message as { payload: RuntimeEvent }).payload);
}

let requestSequence = 0;
async function call<T>(type: string, payload: unknown): Promise<T> {
  const requestId = `rpc-${++requestSequence}`;
  server?.receive({
    protocolVersion: WORKER_RPC_PROTOCOL_VERSION,
    kind: 'request',
    generation: 1,
    requestId,
    type,
    payload,
  });
  const response = await waitFor(
    () => responses().find((item) => item.requestId === requestId),
    `response to ${type}`
  );
  if (!response.ok) throw Object.assign(new Error(response.error.message), response.error);
  return response.result as T;
}

async function waitFor<T>(
  probe: () => T | undefined,
  what: string,
  timeoutMs = 10_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Resolves when the turn reaches its terminal status. */
function turnIdle(): Promise<RuntimeEvent> {
  return waitFor(
    () =>
      events().find((event) => event.type === 'session.status' && event.payload.status === 'idle'),
    'the turn to go idle'
  );
}

function startServer(): void {
  outbound = [];
  server = new PiWorkerRpcServer({
    port: { postMessage: (message: unknown) => outbound.push(message) },
    generation: 1,
    projectTrusted: true,
    createRuntime: (options) =>
      new NativeWorkerRuntime({
        ...options,
        host: HOST,
        agentDir,
        // The only substitution: pi-ai's faux provider in place of the network.
        create: (bootstrapOptions) =>
          createRuntime({ ...bootstrapOptions, providers: [faux.provider] }),
      }),
  });
}

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'runtime-e2e-work-'));
  agentDir = await mkdtemp(join(tmpdir(), 'runtime-e2e-agent-'));
  await writeFile(join(workspace, 'notes.txt'), 'the answer is 42\n');
  faux = fauxProvider({
    provider: 'faux',
    models: [{ id: 'faux-e2e', name: 'Faux E2E', contextWindow: 128_000, maxTokens: 4_096 }],
  });
  requestSequence = 0;
  startServer();
});

afterEach(async () => {
  await call('worker.dispose', { reason: 'test' }).catch(() => undefined);
  server = undefined;
  await rm(workspace, { recursive: true, force: true });
  await rm(agentDir, { recursive: true, force: true });
});

async function bootstrap(overrides: Record<string, unknown> = {}) {
  return await call<{ sessionFile: string; piSessionId: string }>('worker.bootstrap', {
    logicalSessionId: 'logical-e2e',
    cwd: workspace,
    permissions: { mode: 'agent', gear: 'ask' },
    ...overrides,
  });
}

async function send(text: string, requestId = 'turn-1') {
  return await call('worker.send', {
    logicalSessionId: 'logical-e2e',
    requestId,
    attemptId: 'attempt-1',
    text,
    model: MODEL,
  });
}

describe('native backend end to end (P4-4)', () => {
  it('runs a multi-turn loop that calls a tool and persists the transcript', async () => {
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('read', { path: 'notes.txt' }, { id: 'call-1' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('The note says the answer is 42.'),
    ]);
    const boot = await bootstrap();
    await send('What does notes.txt say?');
    await turnIdle();

    const toolStarted = events().find((event) => event.type === 'tool.started');
    const toolCompleted = events().find((event) => event.type === 'tool.completed');
    expect(toolStarted).toBeDefined();
    expect(toolCompleted).toBeDefined();
    // Two provider calls: the tool result has to go back to the model, which is
    // exactly what `singleTurn` would have prevented.
    expect(faux.state.callCount).toBe(2);
    expect(
      events()
        .filter((event) => event.type === 'message.delta')
        .map((event) => (event.payload as { text?: string }).text)
        .join('')
    ).toContain('42');

    // Durable, and durable in the format P3-1 promised: the same file the
    // bootstrap result named, holding a v4 header.
    const transcript = await readFile(boot.sessionFile, 'utf8');
    expect(JSON.parse(transcript.split('\n')[0] as string)).toMatchObject({
      kind: 'header',
      version: 4,
    });
    expect(transcript).toContain('notes.txt');

    const history = await call<{ page: { messages: unknown[] } }>('worker.history', {
      logicalSessionId: 'logical-e2e',
    });
    expect(history.page.messages.length).toBeGreaterThan(0);
  });

  it('routes a write through the approval gate and honours the answer', async () => {
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall('write', { path: 'created.txt', content: 'hi\n' }, { id: 'call-1' })],
        { stopReason: 'toolUse' }
      ),
      fauxAssistantMessage('Done.'),
    ]);
    await bootstrap();
    await send('Create created.txt');

    const request = await waitFor(
      () =>
        events().find((event) => event.type === 'extensionUi.request') as
          | (RuntimeEvent & { payload: ExtensionUiRequest })
          | undefined,
      'the approval dialog'
    );
    // `ask` must actually ask: a gear that silently allowed the write would
    // still produce a green test without this.
    expect(request.payload.method).toBe('select');
    await call('worker.extensionUi.respond', {
      logicalSessionId: 'logical-e2e',
      response: {
        runtimeId: request.payload.runtimeId,
        uiRequestId: request.payload.uiRequestId,
        ok: true,
        value: '允许一次',
      },
    });
    await turnIdle();
    await expect(readFile(join(workspace, 'created.txt'), 'utf8')).resolves.toBe('hi\n');
  });

  it('a denied approval fails the tool without failing the session', async () => {
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall('write', { path: 'denied.txt', content: 'no\n' }, { id: 'call-1' })],
        { stopReason: 'toolUse' }
      ),
      fauxAssistantMessage('Understood, I will not write it.'),
    ]);
    await bootstrap();
    await send('Create denied.txt');
    const request = await waitFor(
      () =>
        events().find((event) => event.type === 'extensionUi.request') as
          | (RuntimeEvent & { payload: ExtensionUiRequest })
          | undefined,
      'the approval dialog'
    );
    await call('worker.extensionUi.respond', {
      logicalSessionId: 'logical-e2e',
      response: {
        runtimeId: request.payload.runtimeId,
        uiRequestId: request.payload.uiRequestId,
        ok: true,
        value: '拒绝',
      },
    });
    await turnIdle();
    await expect(readFile(join(workspace, 'denied.txt'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    // The refusal belongs to the tool call, not to the conversation.
    expect(events().some((event) => event.type === 'session.failed')).toBe(false);
  });

  it('answers a stop without waiting for the provider to notice it', async () => {
    const PROVIDER_DELAY_MS = 3_000;
    faux.setResponses([
      async () => {
        // Deliberately abort-deaf, standing in for a provider that keeps a
        // socket open after the cancel. The RPC chain is serialized, so a stop
        // that waited for the turn would hold every later request — including
        // the dispose — for this long.
        await new Promise((resolve) => setTimeout(resolve, PROVIDER_DELAY_MS));
        return fauxAssistantMessage('too late');
      },
    ]);
    await bootstrap();
    await send('take your time');
    const started = Date.now();
    const stopped = await call<{ stopped: boolean }>('worker.stop', {
      logicalSessionId: 'logical-e2e',
      reason: 'user',
    });
    expect(stopped).toEqual({ stopped: true });
    expect(Date.now() - started).toBeLessThan(PROVIDER_DELAY_MS / 2);
    expect(
      events().some(
        (event) => event.type === 'session.status' && event.payload.status === 'stopping'
      )
    ).toBe(true);
  }, 20_000);

  it('accepts a compaction request and applies it at the next turn boundary', async () => {
    faux.setResponses([fauxAssistantMessage('first')]);
    await bootstrap();
    await send('hello');
    await turnIdle();

    expect(await call('worker.compact', { logicalSessionId: 'logical-e2e' })).toEqual({
      compacted: true,
    });

    // Deferred, not immediate: the window is replaced when the next turn is
    // prepared, so no summary is ever cut into a half-finished tool batch.
    faux.setResponses([fauxAssistantMessage('second')]);
    outbound = [];
    await send('and again', 'turn-2');
    await turnIdle();
    expect(faux.state.callCount).toBe(2);
  });

  it('reports the branch tree and refuses an unsupported reload explicitly', async () => {
    faux.setResponses([fauxAssistantMessage('first')]);
    await bootstrap();
    await send('hello');
    await turnIdle();

    const tree = await call<{ snapshot: { logicalSessionId: string } }>('worker.tree', {
      logicalSessionId: 'logical-e2e',
    });
    expect(tree.snapshot.logicalSessionId).toBe('logical-e2e');

    // An absent optional method must surface as a named error, never as a
    // success that quietly did nothing.
    await expect(
      call('worker.reload', { logicalSessionId: 'logical-e2e', sessionFile: 'x' })
    ).rejects.toMatchObject({ code: 'WORKER_RELOAD_UNAVAILABLE' });
  });

  it('rewinds to a user turn and hands back the text to re-edit', async () => {
    faux.setResponses([fauxAssistantMessage('first'), fauxAssistantMessage('second')]);
    await bootstrap();
    await send('remember this');
    await turnIdle();
    outbound = [];
    await send('and this', 'turn-2');
    await turnIdle();

    const tree = await call<{ snapshot: SessionTreeSnapshot }>('worker.tree', {
      logicalSessionId: 'logical-e2e',
    });
    const target = tree.snapshot.nodes.find(
      (node) => node.role === 'user' && node.preview?.includes('and this')
    );
    expect(target).toBeDefined();

    const rewound = await call<WorkerRewindResult>('worker.rewind', {
      logicalSessionId: 'logical-e2e',
      targetEntryId: target?.id,
      confirmed: true,
    });
    // Rewinding to a user turn puts its text back in the composer; the branch
    // it started is left behind rather than deleted.
    expect(rewound.editorText).toContain('and this');
    expect(rewound.history.page.messages.length).toBeGreaterThan(0);
    expect(rewound.tree.snapshot.nodes.length).toBe(tree.snapshot.nodes.length);
  });

  it('stages a fork as an independent file and can discard it again', async () => {
    faux.setResponses([fauxAssistantMessage('first')]);
    const boot = await bootstrap();
    await send('hello');
    await turnIdle();

    const tree = await call<{ snapshot: SessionTreeSnapshot }>('worker.tree', {
      logicalSessionId: 'logical-e2e',
    });
    const forkable = tree.snapshot.nodes.findLast((node) => node.forkable);
    expect(forkable).toBeDefined();

    const fork = await call<WorkerForkResult>('worker.fork', {
      logicalSessionId: 'logical-e2e',
      entryId: forkable?.id,
    });
    expect(fork.sourceSessionFile).toBe(boot.sessionFile);
    expect(fork.sessionFile).not.toBe(boot.sessionFile);
    expect(fork.piSessionId).not.toBe(boot.piSessionId);
    // Read back from the fork file, not projected from the parent: the next
    // slot opens this file, so its history has to come from it.
    expect(fork.history.page.messages.length).toBeGreaterThan(0);
    await expect(readFile(fork.sessionFile, 'utf8')).resolves.toContain('"kind":"header"');

    expect(
      await call('worker.fork.discard', {
        logicalSessionId: 'logical-e2e',
        sessionFile: fork.sessionFile,
      })
    ).toEqual({ discarded: true });
    await expect(readFile(fork.sessionFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    // A file this worker never staged is not ours to delete.
    expect(
      await call('worker.fork.discard', {
        logicalSessionId: 'logical-e2e',
        sessionFile: join(workspace, 'not-a-fork.jsonl'),
      })
    ).toEqual({ discarded: false });
  });

  it('migrates a legacy tier onto the two D14 axes', async () => {
    faux.setResponses([fauxAssistantMessage('ok')]);
    await bootstrap();
    // `handsoff` becomes agent + accept-edits, so the write that needed an
    // approval above must now go through without one.
    await call('worker.setPermissionTier', {
      logicalSessionId: 'logical-e2e',
      tier: 'handsoff',
    });
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall('write', { path: 'auto.txt', content: 'ok\n' }, { id: 'call-1' })],
        { stopReason: 'toolUse' }
      ),
      fauxAssistantMessage('written'),
    ]);
    outbound = [];
    await send('write auto.txt', 'turn-2');
    await turnIdle();
    expect(events().some((event) => event.type === 'extensionUi.request')).toBe(false);
    await expect(readFile(join(workspace, 'auto.txt'), 'utf8')).resolves.toBe('ok\n');
  });
});
