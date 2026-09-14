/**
 * P6-2 — the one-shot completion path on the self-owned runtime.
 *
 * What these pin is the contract Main already depends on (deltas then exactly
 * one terminal event, a cancel that settles as `cancelled`, model errors in the
 * worker's vocabulary), because the switch away from pi-coding-agent has to be
 * invisible to `PiUtilityService`.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  WorkerUtilityDeltaPayload,
  WorkerUtilityStartPayload,
  WorkerUtilityTerminalPayload,
} from '../../shared/types/workerRpc.ts';
import { createRuntime } from '../bootstrap.ts';
import { standaloneHost } from '../host/config.ts';
import { NativeUtilityRuntime } from '../worker/nativeUtility.ts';

let dir: string;
let live: NativeUtilityRuntime[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'native-utility-'));
});
afterEach(async () => {
  for (const runtime of live) await runtime.dispose().catch(() => {});
  live = [];
  await rm(dir, { recursive: true, force: true });
});

/**
 * A runtime whose catalog is pi-ai's own faux provider.
 *
 * Everything under test still runs — the real bootstrap, the real model
 * adapter, the real stream loop — and nothing reaches a network.
 */
function harness(options: { agentDir?: string; responses?: unknown[] } = {}) {
  const faux = fauxProvider({
    provider: 'test',
    models: [{ id: 'test', name: 'Test', contextWindow: 32_000, maxTokens: 4096 }],
  });
  if (options.responses) faux.setResponses(options.responses as never[]);
  const deltas: WorkerUtilityDeltaPayload[] = [];
  const terminals: WorkerUtilityTerminalPayload[] = [];
  let announce: (payload: WorkerUtilityTerminalPayload) => void = () => {};
  const settled = new Promise<WorkerUtilityTerminalPayload>((resolve) => {
    announce = resolve;
  });
  const runtime = new NativeUtilityRuntime({
    host: standaloneHost({}),
    ...(options.agentDir ? { agentDir: options.agentDir } : {}),
    env: {},
    emitDelta: (payload) => deltas.push(payload),
    emitTerminal: (payload) => {
      terminals.push(payload);
      announce(payload);
    },
    create: (bootstrap) => createRuntime({ ...bootstrap, providers: [faux.provider] }),
  });
  live.push(runtime);
  return { deltas, terminals, settled, runtime };
}

const request = (
  overrides: Partial<WorkerUtilityStartPayload> = {}
): WorkerUtilityStartPayload => ({
  operationId: 'op-1',
  cwd: dir,
  prompt: 'name this conversation',
  timeoutMs: 10_000,
  ...overrides,
});

/** A response that never arrives, so the stream is still open to cancel. */
const hangs = (() => new Promise(() => {})) as never;

describe('P6-2 native one-shot completions', () => {
  it('streams the answer and settles once, without pi-coding-agent', async () => {
    const { deltas, terminals, settled, runtime } = harness({
      responses: [fauxAssistantMessage('a short title')],
    });
    await expect(runtime.start(request())).resolves.toEqual({
      accepted: true,
      operationId: 'op-1',
    });
    const terminal = await settled;
    expect(deltas.map((delta) => delta.delta).join('')).toBe('a short title');
    expect(terminal).toMatchObject({
      operationId: 'op-1',
      state: 'completed',
      text: 'a short title',
      model: 'test/test',
    });
    expect(terminals).toHaveLength(1);
  });

  it('refuses a second operation while one is still running', async () => {
    const { runtime } = harness({ responses: [hangs] });
    await runtime.start(request());
    await expect(runtime.start(request({ operationId: 'op-2' }))).rejects.toThrow(
      /already has an active operation/
    );
  });

  it('states a bad model in the worker vocabulary, not the catalog code', async () => {
    const { runtime } = harness({ responses: [fauxAssistantMessage('unused')] });
    await expect(runtime.start(request({ model: 'nobody/nothing' }))).rejects.toThrow(
      /model is unavailable/
    );
    await expect(runtime.start(request({ model: 'no-slash' }))).rejects.toThrow(
      /Expected provider\/model/
    );
  });

  it('settles as cancelled, and a cancel for another operation changes nothing', async () => {
    const { settled, runtime } = harness({ responses: [hangs] });
    await runtime.start(request());
    await expect(runtime.cancel({ operationId: 'op-other', reason: 'user' })).resolves.toEqual({
      cancelled: false,
    });
    await expect(runtime.cancel({ operationId: 'op-1', reason: 'user' })).resolves.toEqual({
      cancelled: true,
    });
    expect((await settled).state).toBe('cancelled');
  });

  it('takes the thinking level the agent directory pinned for that model', async () => {
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({ defaultThinkingLevel: 'low', modelThinkingLevels: { 'test/test': 'high' } }),
      'utf8'
    );
    const seen: (string | undefined)[] = [];
    const { settled, runtime } = harness({
      agentDir: dir,
      responses: [
        ((_context: unknown, streamOptions: { reasoning?: string } | undefined) => {
          seen.push(streamOptions?.reasoning);
          return fauxAssistantMessage('ok');
        }) as never,
      ],
    });
    await runtime.start(request());
    expect((await settled).state).toBe('completed');
    // The per-model pin wins over the default, and the request carries it.
    expect(seen).toEqual(['high']);
  });

  it('lets an explicit request effort override what the directory pinned', async () => {
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({ modelThinkingLevels: { 'test/test': 'high' } }),
      'utf8'
    );
    const seen: (string | undefined)[] = [];
    const { settled, runtime } = harness({
      agentDir: dir,
      responses: [
        ((_context: unknown, streamOptions: { reasoning?: string } | undefined) => {
          seen.push(streamOptions?.reasoning);
          return fauxAssistantMessage('ok');
        }) as never,
      ],
    });
    await runtime.start(request({ effort: 'minimal' }));
    await settled;
    expect(seen).toEqual(['minimal']);
  });
});
