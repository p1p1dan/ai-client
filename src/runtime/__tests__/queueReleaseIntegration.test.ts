/**
 * 排队消息在**真实 worker**上按先进先出释放。
 *
 * 这个用例原来在 `scripts/__tests__/pi-queue-release-integration.test.mjs`，驱动的是
 * 旧引擎 `PiWorkerSession`；P6-5 把那个引擎退役后，用例跟着搬到自有 runtime——要验的
 * 事情一个字没变，换的只是底下那台发动机。
 *
 * 为什么值得单独验一遍：排队逻辑本身（`messageQueue.ts` / `queueReleaseTransaction.ts`）
 * 有自己的单测，但它们只知道「取一条、跑一条、跑砸了放回去」。真正会出事的是**引擎这一侧
 * 的接缝**——一条回合还没结算就收下一条会不会串、附件拼进提示词时会不会丢。所以这里用
 * 真实 RPC server + 真实 NativeWorkerRuntime + 真实会话文件，只把 provider 换成 pi-ai
 * 自己的 faux。
 *
 * **不 import 渲染层那两个模块**：它们经 `attachments.ts` 一路牵进 `@shared/*` 与 `@/`
 * 两套路径别名，而 `src/runtime` 是独立子包、tsconfig 里没有这些别名——把别名加进去等于
 * 让 runtime 包认识渲染层。排队那几步（取队首、跑、跑砸了放回去）在这里按同样的顺序手写，
 * 它们自己的行为由渲染层的单测钉住。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PiWorkerRpcServer } from '../../agent-host/piWorkerRpcServer.ts';
import type { RuntimeEvent } from '../../shared/types/runtimeEvents.ts';
import {
  WORKER_RPC_PROTOCOL_VERSION,
  type WorkerRpcResponse,
} from '../../shared/types/workerRpc.ts';
import { createRuntime } from '../bootstrap.ts';
import type { RuntimeHostConfig } from '../contracts.ts';
import { NativeWorkerRuntime } from '../worker/nativeWorkerRuntime.ts';

const HOST: RuntimeHostConfig = {
  carrier: 'electron-utility',
  tsdReadFallback: 'disabled',
  exec: { mode: 'pipe' },
  childEnv: {},
  cleanupTimeoutMs: 2000,
};
const MODEL = 'faux/faux-queue';
const SESSION = 'logical-queue';

let workspace: string;
let agentDir: string;
let server: PiWorkerRpcServer | undefined;
let faux: ReturnType<typeof fauxProvider>;
let outbound: unknown[] = [];
let requestSequence = 0;

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

/**
 * The user text the model saw on each call, captured from the request itself.
 *
 * A response factory rather than a log on the handle: pi-ai's faux keeps no
 * request history, and reading the session file afterwards would only prove
 * what was WRITTEN — the claim here is about what was actually sent, and in
 * which order.
 */
const promptsSeenByModel: string[] = [];
function recordingResponse(reply: string) {
  return ((context: { messages: Array<{ role: string; content: unknown }> }) => {
    const last = [...context.messages].reverse().find((message) => message.role === 'user');
    const content = last?.content;
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content
              .flatMap((block: { type?: string; text?: string }) =>
                block.type === 'text' && block.text !== undefined ? [block.text] : []
              )
              .join('')
          : '';
    promptsSeenByModel.push(text);
    return fauxAssistantMessage(reply);
  }) as never;
}

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'runtime-queue-work-'));
  agentDir = await mkdtemp(join(tmpdir(), 'runtime-queue-agent-'));
  faux = fauxProvider({
    provider: 'faux',
    models: [{ id: 'faux-queue', name: 'Faux Queue', contextWindow: 128_000, maxTokens: 4_096 }],
  });
  outbound = [];
  requestSequence = 0;
  promptsSeenByModel.length = 0;
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
});

afterEach(async () => {
  await call('worker.dispose', { reason: 'test' }).catch(() => undefined);
  server = undefined;
  await rm(workspace, { recursive: true, force: true });
  await rm(agentDir, { recursive: true, force: true });
});

async function send(text: string, requestId: string, attachments: unknown[] = []): Promise<void> {
  const before = events().length;
  await call('worker.send', {
    logicalSessionId: SESSION,
    requestId,
    attemptId: requestId,
    text,
    model: MODEL,
    ...(attachments.length ? { attachments } : {}),
  });
  await waitFor(
    () =>
      events()
        .slice(before)
        .find((event) => event.type === 'session.status' && event.payload.status === 'idle'),
    `turn ${requestId} to settle`
  );
}

describe('queued messages release in order through the native worker', () => {
  it('sends a running turn first, then all three queued entries in FIFO', async () => {
    faux.setResponses(
      Array.from({ length: 4 }, (_, index) => recordingResponse(`reply ${index + 1}`))
    );
    await call('worker.bootstrap', {
      logicalSessionId: SESSION,
      cwd: workspace,
      permissions: { mode: 'agent', gear: 'auto' },
    });

    await send('long-running turn', 'turn-1');

    const queued = [
      {
        id: 'q1',
        sessionId: SESSION,
        text: 'first queued',
        attachments: [
          {
            id: 'a1',
            kind: 'text' as const,
            mediaType: 'text/plain',
            name: 'note.txt',
            byteLength: 5,
            data: 'hello',
          },
        ],
        queuedAt: 1,
      },
      { id: 'q2', sessionId: SESSION, text: 'second queued', attachments: [], queuedAt: 2 },
      { id: 'q3', sessionId: SESSION, text: 'third queued', attachments: [], queuedAt: 3 },
    ];
    let state: (typeof queued)[number][] = [...queued];

    // The release loop, in the order the renderer transaction runs it: take the
    // head, send it, and only drop it from the queue once the turn settled.
    let released = 0;
    while (state.length > 0) {
      const entry = state[0] as (typeof queued)[number];
      released += 1;
      await send(entry.text, `queued-${released}`, [...entry.attachments]);
      state = state.slice(1);
    }

    // The model saw them in the order they were queued, and the attachment was
    // carried into the prompt rather than dropped at the seam.
    const spoken = promptsSeenByModel;
    expect(spoken.filter((text) => text.includes('long-running turn'))).not.toEqual([]);
    const ordered = ['long-running turn', 'first queued', 'second queued', 'third queued'].map(
      (needle) => spoken.findIndex((text) => text.includes(needle))
    );
    expect(ordered.every((index) => index >= 0)).toBe(true);
    expect([...ordered].sort((a, b) => a - b)).toEqual(ordered);
    expect(spoken.some((text) => text.includes('note.txt') && text.includes('hello'))).toBe(true);
    expect(state).toEqual([]);
  }, 60_000);
});
