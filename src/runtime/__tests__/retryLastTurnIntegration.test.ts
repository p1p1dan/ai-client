/**
 * T135 / decision 045 — the failure card's 「继续」 retries the failed turn on a
 * **real worker** and a real session file; only the provider is pi-ai's faux.
 *
 * The bug this pins: Continue re-sent the failed prompt as a NEW user message,
 * so the model saw the same instruction twice and — with deterministic output —
 * reproduced the same failure. A retry (`worker.send` with `mode: 'retry'`)
 * must add no user message, must ask the model from the context the failed
 * request was sent with, and must leave the failed reply on an abandoned
 * branch rather than on the conversation's main line.
 *
 * What is asserted is what the model was actually SENT (captured inside the
 * faux response factory) and what the file actually holds (decoded with the
 * runtime's own codec), not what the worker says about either.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Entry } from '@earendil-works/pi-agent-core';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PiWorkerRpcServer } from '../../agent-host/piWorkerRpcServer.ts';
import type { RuntimeEvent } from '../../shared/types/runtimeEvents.ts';
import {
  WORKER_RETRY_UNAVAILABLE,
  WORKER_RPC_PROTOCOL_VERSION,
  type WorkerRpcResponse,
} from '../../shared/types/workerRpc.ts';
import { createRuntime } from '../bootstrap.ts';
import type { RuntimeHostConfig } from '../contracts.ts';
import { branchEntries, decodeSession } from '../plugins/session/codec.ts';
import { NativeWorkerRuntime } from '../worker/nativeWorkerRuntime.ts';

const HOST: RuntimeHostConfig = {
  carrier: 'electron-utility',
  tsdReadFallback: 'disabled',
  exec: { mode: 'pipe' },
  childEnv: {},
  cleanupTimeoutMs: 2000,
};
const MODEL = 'faux/faux-retry';
const SESSION = 'logical-retry';
const PROMPT = 'read the notes and summarise them';
/** Terminal, so the run ends on it instead of spending the stream-retry ladder. */
const TERMINAL_FAILURE = '400: upstream rejected the request';

let workspace: string;
let agentDir: string;
let server: PiWorkerRpcServer | undefined;
let faux: ReturnType<typeof fauxProvider>;
let outbound: unknown[] = [];
let requestSequence = 0;

interface SentMessage {
  role: string;
  content: unknown;
}

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
function eventsFor(requestId: string): RuntimeEvent[] {
  return events().filter((event) => event.requestId === requestId);
}

async function waitFor<T>(
  probe: () => T | undefined,
  what: string,
  timeoutMs = 15_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

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

function settled(requestId: string): Promise<RuntimeEvent> {
  return waitFor(
    () =>
      eventsFor(requestId).find(
        (event) => event.type === 'session.status' && event.payload.status === 'idle'
      ),
    `turn ${requestId} to settle`
  );
}

async function send(text: string, requestId: string): Promise<void> {
  await call('worker.send', {
    logicalSessionId: SESSION,
    requestId,
    attemptId: requestId,
    text,
    model: MODEL,
  });
  await settled(requestId);
}

async function retry(requestId: string): Promise<void> {
  await call('worker.send', {
    logicalSessionId: SESSION,
    requestId,
    attemptId: requestId,
    text: '',
    model: MODEL,
    mode: 'retry',
  });
}

/** Every request the model received, in order, as the provider saw it. */
const requestsSeenByModel: SentMessage[][] = [];
function recording(reply: () => ReturnType<typeof fauxAssistantMessage>) {
  return ((context: { messages: SentMessage[] }) => {
    requestsSeenByModel.push(structuredClone(context.messages));
    return reply();
  }) as never;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((block: { type?: string; text?: string }) =>
      block.type === 'text' && block.text !== undefined ? [block.text] : []
    )
    .join('');
}

async function readSession(): Promise<{ entries: Entry[]; branch: Entry[]; raw: string }> {
  const raw = await readFile(join(agentDir, 'sessions', `${SESSION}.jsonl`), 'utf8');
  const document = decodeSession(raw);
  return { entries: document.entries, branch: branchEntries(document), raw };
}

function userEntries(entries: readonly Entry[], text: string): Entry[] {
  return entries.filter(
    (entry) =>
      entry.type === 'message' &&
      entry.message.role === 'user' &&
      textOf(entry.message.content) === text
  );
}

function assistantEntry(entries: readonly Entry[], text: string): Entry | undefined {
  return entries.find(
    (entry) =>
      entry.type === 'message' &&
      entry.message.role === 'assistant' &&
      textOf(entry.message.content) === text
  );
}

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'runtime-retry-work-'));
  agentDir = await mkdtemp(join(tmpdir(), 'runtime-retry-agent-'));
  await writeFile(join(workspace, 'notes.txt'), 'alpha\nbeta\n');
  faux = fauxProvider({
    provider: 'faux',
    models: [{ id: 'faux-retry', name: 'Faux Retry', contextWindow: 128_000, maxTokens: 4_096 }],
  });
  outbound = [];
  requestSequence = 0;
  requestsSeenByModel.length = 0;
  server = new PiWorkerRpcServer({
    port: { postMessage: (message: unknown) => outbound.push(message) },
    generation: 1,
    projectTrusted: true,
    createImportWriter: () => {
      throw new Error('this test supplies no import writer');
    },
    createUtilityRuntime: () => {
      throw new Error('this test supplies no utility runtime');
    },
    createRuntime: (options) =>
      new NativeWorkerRuntime({
        ...options,
        host: HOST,
        agentDir,
        create: (bootstrapOptions) =>
          createRuntime({ ...bootstrapOptions, providers: [faux.provider] }),
      }),
  });
  await call('worker.bootstrap', {
    logicalSessionId: SESSION,
    cwd: workspace,
    permissions: { mode: 'agent', gear: 'auto' },
  });
});

afterEach(async () => {
  await call('worker.dispose', { reason: 'test' }).catch(() => undefined);
  server = undefined;
  await rm(workspace, { recursive: true, force: true });
  await rm(agentDir, { recursive: true, force: true });
});

describe('T135 — Continue retries the failed turn instead of resending its prompt', () => {
  it('re-asks from the tool round the turn completed, with the prompt sent exactly once', async () => {
    faux.setResponses([
      recording(() =>
        fauxAssistantMessage([fauxToolCall('read', { path: 'notes.txt' }, { id: 'call-read' })], {
          stopReason: 'toolUse',
        })
      ),
      recording(() =>
        fauxAssistantMessage('half an ans', { stopReason: 'error', errorMessage: TERMINAL_FAILURE })
      ),
      recording(() => fauxAssistantMessage('the whole answer')),
    ]);

    await send(PROMPT, 'turn-1');
    expect(eventsFor('turn-1').some((event) => event.type === 'session.failed')).toBe(true);
    const before = await readSession();
    const failed = assistantEntry(before.entries, 'half an ans');
    expect(failed).toBeDefined();

    await retry('turn-2');
    await settled('turn-2');

    // What the renderer sees: `running` first (the admission evidence), no user
    // echo at all, the new reply, and a clean completion.
    const seen = eventsFor('turn-2');
    expect(seen[0]).toMatchObject({ type: 'session.status', payload: { status: 'running' } });
    expect(
      seen.some(
        (event) =>
          event.type === 'message.started' && (event.payload as { role?: string }).role === 'user'
      )
    ).toBe(false);
    expect(seen.some((event) => event.type === 'session.completed')).toBe(true);
    expect(seen.some((event) => event.type === 'session.failed')).toBe(false);

    // What the model was sent on the retry: the prompt once, the completed tool
    // round, and not a trace of the failed reply.
    const retried = requestsSeenByModel.at(-1) ?? [];
    expect(requestsSeenByModel).toHaveLength(3);
    expect(
      retried.filter((message) => message.role === 'user').map((m) => textOf(m.content))
    ).toEqual([PROMPT]);
    expect(retried.map((message) => message.role)).toEqual(['user', 'assistant', 'toolResult']);
    expect(JSON.stringify(retried)).not.toContain('half an ans');
    // Identical to the context the failed request carried: that is the turn
    // being retried, not a new one.
    expect(retried).toEqual(requestsSeenByModel[1]);

    // What the file holds: one user entry, the failed reply kept but abandoned,
    // and the new reply as its sibling on the active branch.
    const after = await readSession();
    expect(userEntries(after.entries, PROMPT)).toHaveLength(1);
    const answer = assistantEntry(after.entries, 'the whole answer');
    expect(answer).toBeDefined();
    expect(after.entries.some((entry) => entry.id === failed?.id)).toBe(true);
    expect(answer?.parentId).toBe(failed?.parentId);
    const branchIds = after.branch.map((entry) => entry.id);
    expect(branchIds).not.toContain(failed?.id);
    expect(branchIds.at(-1)).toBe(answer?.id);
    const toolResult = after.branch.find(
      (entry) => entry.type === 'message' && entry.message.role === 'toolResult'
    );
    expect(answer?.parentId).toBe(toolResult?.id);
  }, 60_000);

  it('re-asks from the prompt itself when the first reply failed', async () => {
    faux.setResponses([
      recording(() =>
        fauxAssistantMessage('partial', { stopReason: 'error', errorMessage: TERMINAL_FAILURE })
      ),
      recording(() => fauxAssistantMessage('recovered')),
    ]);

    await send(PROMPT, 'turn-1');
    const failed = assistantEntry((await readSession()).entries, 'partial');

    await retry('turn-2');
    await settled('turn-2');

    const retried = requestsSeenByModel.at(-1) ?? [];
    expect(retried.map((message) => message.role)).toEqual(['user']);
    expect(textOf(retried[0]?.content)).toBe(PROMPT);

    const after = await readSession();
    const prompt = userEntries(after.entries, PROMPT);
    expect(prompt).toHaveLength(1);
    const answer = assistantEntry(after.entries, 'recovered');
    expect(answer?.parentId).toBe(prompt[0]?.id);
    expect(failed?.parentId).toBe(prompt[0]?.id);
    expect(after.branch.map((entry) => entry.id)).not.toContain(failed?.id);
  }, 60_000);

  it('refuses when the last turn completed, without starting a run or touching the file', async () => {
    faux.setResponses([recording(() => fauxAssistantMessage('done'))]);
    await send(PROMPT, 'turn-1');
    const before = await readSession();

    await expect(retry('turn-2')).rejects.toMatchObject({ code: WORKER_RETRY_UNAVAILABLE });

    // No run: nothing for the renderer to settle, and the model was not asked.
    expect(eventsFor('turn-2')).toEqual([]);
    expect(requestsSeenByModel).toHaveLength(1);
    expect((await readSession()).raw).toBe(before.raw);

    // The refusal left nothing latched: an ordinary send goes straight through.
    faux.appendResponses([recording(() => fauxAssistantMessage('next'))]);
    await send('next question', 'turn-3');
    expect(eventsFor('turn-3').some((event) => event.type === 'session.completed')).toBe(true);
  }, 60_000);

  it('stops a retried turn the way it stops any other (decision 046)', async () => {
    faux.setResponses([
      recording(() =>
        fauxAssistantMessage('partial', { stopReason: 'error', errorMessage: TERMINAL_FAILURE })
      ),
      // Parks until the Stop aborts the request.
      ((_context: unknown, options?: { signal?: AbortSignal }) =>
        new Promise((resolve) => {
          const done = () => resolve(fauxAssistantMessage('never finished'));
          if (options?.signal?.aborted) done();
          else options?.signal?.addEventListener('abort', done, { once: true });
        })) as never,
    ]);
    await send(PROMPT, 'turn-1');

    await retry('turn-2');
    await waitFor(
      () =>
        eventsFor('turn-2').find(
          (event) => event.type === 'session.status' && event.payload.status === 'running'
        ),
      'the retry to run'
    );
    await expect(
      call('worker.stop', { logicalSessionId: SESSION, reason: 'user' })
    ).resolves.toEqual({ stopped: true });
    await settled('turn-2');

    const terminals = eventsFor('turn-2')
      .filter((event) => event.type.startsWith('session.') && event.type !== 'session.status')
      .map((event) => event.type);
    expect(terminals).toEqual(['session.stopped']);
    // Still exactly one copy of the prompt, whatever the retry was cut into.
    expect(userEntries((await readSession()).entries, PROMPT)).toHaveLength(1);
  }, 60_000);
});
