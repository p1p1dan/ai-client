/**
 * decision 046 — a Stop always ends the run it reaches, from the moment the run
 * exists (T144).
 *
 * Field report 2026-09-25: after 「继续」 the session showed "running" forever and
 * Stop did nothing. One way there (H3a) is a run that had already announced
 * `running` but was still parked on an await that ignored its abort — the
 * abort listener was only registered once the `Agent` existed. These cases pin
 * the fix at the graph level: every await before the `Agent` races the Stop,
 * a refusal is visible as a refusal, and dispose never waits on a run forever.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RuntimeEventDraft } from '../../shared/types/runtimeEvents.ts';
import { RUN_STOP_CUSTOM_TYPE } from '../../shared/types/sessionHistory.ts';
import { createRuntime, DISPOSE_RUN_GRACE_MS, type RuntimeHandle } from '../bootstrap.ts';
import { RuntimeHostError } from '../host/errors.ts';
import { neverAsked } from './fixtures/approval.ts';

describe('Stop reaches a run from its first await (decision 046)', () => {
  let workspace: string;
  let runtime: RuntimeHandle | undefined;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'runtime-stop-settles-'));
  });

  afterEach(async () => {
    await runtime?.dispose();
    runtime = undefined;
    await rm(workspace, { recursive: true, force: true });
  });

  async function boot(
    options: { subagents?: boolean; session?: boolean } = {}
  ): Promise<RuntimeHandle> {
    const faux = fauxProvider({
      provider: 'faux',
      models: [{ id: 'faux-stop', name: 'Stop probe' }],
    });
    // Only a run that is NOT stopped ever asks.
    faux.setResponses([fauxAssistantMessage('an ordinary answer')]);
    runtime = await createRuntime({
      env: {},
      traceDir: null,
      providers: [faux.provider],
      tools: { cwd: workspace },
      permissions: { approve: neverAsked, gear: 'auto' },
      ...(options.subagents ? { subagents: { home: join(workspace, 'home') } } : {}),
      ...(options.session
        ? { session: { file: join(workspace, 'session.jsonl'), cwd: workspace, mode: 'create' } }
        : {}),
      loop: { singleTurn: false },
    });
    return runtime;
  }

  /** Park the catalog re-read forever; resolves once the run is parked on it. */
  function hangRefresh(handle: RuntimeHandle): Promise<void> {
    const subagents = handle.subagents;
    if (!subagents) throw new Error('expected the builtin subagents to register');
    return new Promise<void>((entered) => {
      subagents.refresh = () => {
        entered();
        return new Promise<void>(() => undefined);
      };
    });
  }

  function record(handle: RuntimeHandle): RuntimeEventDraft[] {
    const events: RuntimeEventDraft[] = [];
    handle.events.subscribe((event) => events.push(event));
    return events;
  }

  const shape = (events: RuntimeEventDraft[]) =>
    events
      .filter((event) => event.type.startsWith('session.'))
      .map((event) =>
        event.type === 'session.status'
          ? `status:${(event.payload as { status: string }).status}`
          : event.type
      );

  it('[T144-loop-01] a Stop during the catalog re-read ends the run as stopped', async () => {
    const handle = await boot({ subagents: true });
    // A catalog directory that never answers: before the fix this await sat
    // between `running` and the abort listener, so the Stop went nowhere.
    const refreshing = hangRefresh(handle);
    const events = record(handle);
    const controller = new AbortController();
    const run = handle.run({ prompt: 'go', systemPrompt: 'probe', signal: controller.signal });
    await refreshing;
    expect(shape(events)).toContain('status:running');

    controller.abort();
    const result = await run;
    expect(result).toMatchObject({ success: false, stopReason: 'aborted', turns: 0 });
    expect(shape(events).slice(-2)).toEqual(['session.stopped', 'status:idle']);
    expect(events.some((event) => event.type === 'session.failed')).toBe(false);
  });

  it('[T144-loop-05] a Stop before the prompt leaves no stop mark on the previous turn', async () => {
    const handle = await boot({ subagents: true, session: true });
    expect((await handle.run({ prompt: 'first', systemPrompt: 'probe' })).success).toBe(true);

    const refreshing = hangRefresh(handle);
    const controller = new AbortController();
    const run = handle.run({ prompt: 'second', systemPrompt: 'probe', signal: controller.signal });
    await refreshing;
    controller.abort();
    expect(await run).toMatchObject({ stopReason: 'aborted' });

    // The second prompt never reached the file, so a run-stop record would be
    // folded onto the FIRST turn's reply when the session is reopened.
    const marks = handle.session
      ?.snapshot()
      .entries.filter(
        (entry) => entry.type === 'custom' && entry.customType === RUN_STOP_CUSTOM_TYPE
      );
    expect(marks).toEqual([]);
  });

  it('[T144-loop-02] a Stop during prompt assembly ends the run before it says running', async () => {
    const handle = await boot();
    let entered!: () => void;
    const composing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    handle.prompt.compose = () => {
      entered();
      return new Promise(() => undefined);
    };
    const events = record(handle);
    const controller = new AbortController();
    const run = handle.run({ prompt: 'go', signal: controller.signal });
    await composing;

    controller.abort();
    await expect(run).rejects.toThrow();
    // `stopping` came from the worker; the answer to it is `stopped`, never a
    // late `running` and never `failed`.
    expect(shape(events)).toEqual(['session.stopped', 'status:idle']);
    expect(events[0]).toMatchObject({ payload: { errorCode: 'aborted' } });
  });

  // The losing side of the race keeps running, and the graph can be torn down
  // under it: its late failure must be consumed, never left unhandled.
  it('[T144-loop-06] a prompt assembly the Stop outran fails late without an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const handle = await boot();
      const late = () =>
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new RuntimeHostError('runtime_disposed', 'host IO is disposed')),
            5
          )
        );

      // Already aborted: the assembly is still awaited, and its failure is the
      // run's to report (as a stop, since the signal is dead).
      handle.prompt.compose = late;
      const dead = new AbortController();
      dead.abort();
      await expect(handle.run({ prompt: 'dead', signal: dead.signal })).rejects.toMatchObject({
        code: 'runtime_disposed',
      });

      // Aborted mid-assembly: the run stops waiting at once, and the assembly
      // fails afterwards with nobody awaiting it.
      let entered!: () => void;
      const composing = new Promise<void>((resolve) => {
        entered = resolve;
      });
      handle.prompt.compose = () => {
        entered();
        return late();
      };
      const controller = new AbortController();
      const run = handle.run({ prompt: 'go', signal: controller.signal });
      await composing;
      controller.abort();
      await expect(run).rejects.toThrow();

      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('[T144-loop-03] start refuses an overlapping run synchronously; run still rejects', async () => {
    const handle = await boot();
    const controller = new AbortController();
    handle.prompt.compose = () => new Promise(() => undefined);
    const first = handle.run({ prompt: 'first', signal: controller.signal });
    expect(() => handle.start({ prompt: 'second', systemPrompt: 'probe' })).toThrow(
      expect.objectContaining({ code: 'runtime_busy' })
    );
    await expect(handle.run({ prompt: 'second', systemPrompt: 'probe' })).rejects.toMatchObject({
      code: 'runtime_busy',
    });
    controller.abort();
    await expect(first).rejects.toThrow();
  });

  it('[T144-loop-04] dispose does not wait forever on a run that ignores its abort', async () => {
    const handle = await boot();
    // A loop that never settles and never listens: the worst case the grace
    // exists for.
    handle.loop.run = () => new Promise(() => undefined);
    void handle.run({ prompt: 'go', systemPrompt: 'probe' }).catch(() => undefined);
    const started = Date.now();
    await expect(handle.dispose()).rejects.toMatchObject({ code: 'run_did_not_settle' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(DISPOSE_RUN_GRACE_MS - 50);
    // The rest of the teardown still ran: the graph refuses new work.
    await expect(handle.run({ prompt: 'again', systemPrompt: 'probe' })).rejects.toMatchObject({
      code: 'runtime_disposed',
    });
    runtime = undefined;
  }, 15_000);
});
