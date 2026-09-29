import {
  DSH_COMPLETION_MAX_TIMEOUT_MS,
  type DshHostCompleted,
} from '@shared/types/dshHostProtocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COMPLETION_TIMEOUT_MESSAGE,
  DshCompletionError,
  DshCompletionService,
} from '../DshCompletionService';
import type { DshHostCompletionInput } from '../DshHostSupervisor';

/**
 * dsh-rebase P1-15 (decisions 039, 125) — Main's one-shot completion service
 * over a fake host: capacity, Main's own deadline, cancel, logout and quit,
 * and how the host's answers become the errors the three features show. The
 * supervisor's half (`startCompletion`) has its own tests; the real engine is
 * the shared-host integration test's.
 */

// The singleton's default host; these tests always pass their own.
vi.mock('../DshHostSupervisor', () => ({ dshHostSupervisor: {} }));

interface FakeCall {
  input: DshHostCompletionInput;
  onDelta?: (text: string) => void;
  answer: (answer: DshHostCompleted) => void;
  fail: (error: Error) => void;
  cancel: ReturnType<typeof vi.fn>;
}

function fakeHost() {
  const calls: FakeCall[] = [];
  const host = {
    startCompletion: vi.fn((input: DshHostCompletionInput, onDelta?: (text: string) => void) => {
      let answer!: (value: DshHostCompleted) => void;
      let fail!: (error: Error) => void;
      const result = new Promise<DshHostCompleted>((resolve, reject) => {
        answer = resolve;
        fail = reject;
      });
      result.catch(() => {});
      // As the supervisor does: a cancel settles the call with a rejection.
      const cancel = vi.fn(() =>
        fail(Object.assign(new Error('cancelled'), { code: 'DSH_HOST_COMPLETION_CANCELLED' }))
      );
      calls.push({ input, ...(onDelta ? { onDelta } : {}), answer, fail, cancel });
      return { result, cancel };
    }),
  };
  return { host, calls };
}

const ok = (text: string, model = 'gw/m1'): DshHostCompleted => ({
  host: 'completed',
  id: 1,
  ok: true,
  text,
  model,
  ms: 3,
});
const failed = (code: string, message: string): DshHostCompleted => ({
  host: 'completed',
  id: 1,
  ok: false,
  error: { code, message },
  ms: 3,
});

const base = { purpose: 'commit-message' as const, prompt: 'Summarize.', timeoutMs: 30_000 };

afterEach(() => {
  vi.useRealTimers();
});

describe('DshCompletionService — the call', () => {
  it('hands the request to the host and resolves with the text and our model id', async () => {
    const { host, calls } = fakeHost();
    const service = new DshCompletionService({ host });
    const pending = service.complete({ ...base, model: 'gw/m1', effort: 'high' });
    expect(calls[0]?.input).toEqual({
      purpose: 'commit-message',
      prompt: 'Summarize.',
      model: 'gw/m1',
      effort: 'high',
      timeoutMs: 30_000,
    });
    // No delta listener: the host is not asked to stream.
    expect(calls[0]?.onDelta).toBeUndefined();
    expect(service.activeCount).toBe(1);
    calls[0]?.answer(ok('feat: x'));
    await expect(pending).resolves.toEqual({ text: 'feat: x', model: 'gw/m1' });
    expect(service.activeCount).toBe(0);
  });

  it('leaves model and effort out when none was chosen (Automatic)', async () => {
    const { host, calls } = fakeHost();
    const service = new DshCompletionService({ host });
    const pending = service.complete(base);
    expect(calls[0]?.input).toEqual({
      purpose: 'commit-message',
      prompt: 'Summarize.',
      timeoutMs: 30_000,
    });
    calls[0]?.answer(ok(''));
    await expect(pending).resolves.toEqual({ text: '', model: 'gw/m1' });
  });

  it('forwards deltas while the call runs, and none after it settled', async () => {
    const { host, calls } = fakeHost();
    const service = new DshCompletionService({ host });
    const deltas: string[] = [];
    const pending = service.complete({
      ...base,
      purpose: 'code-review',
      operationId: 'review-1',
      onDelta: (delta) => deltas.push(delta),
    });
    calls[0]?.onDelta?.('Looks ');
    calls[0]?.onDelta?.('good.');
    service.cancel('review-1');
    calls[0]?.onDelta?.('late');
    await expect(pending).rejects.toMatchObject({ code: 'COMPLETION_CANCELLED' });
    expect(deltas).toEqual(['Looks ', 'good.']);
  });

  it('clamps a deadline setTimeout cannot hold', async () => {
    const { host, calls } = fakeHost();
    const service = new DshCompletionService({ host });
    const pending = service.complete({ ...base, timeoutMs: Number.MAX_SAFE_INTEGER });
    expect(calls[0]?.input.timeoutMs).toBe(DSH_COMPLETION_MAX_TIMEOUT_MS);
    calls[0]?.answer(ok('x'));
    await pending;
  });
});

describe('DshCompletionService — errors as the features show them', () => {
  it('names the host’s code in front of its sentence', async () => {
    const { host, calls } = fakeHost();
    const service = new DshCompletionService({ host });
    const pending = service.complete(base);
    calls[0]?.answer(failed('CREDENTIALS_UNAVAILABLE', 'no key for the route'));
    const error = await pending.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DshCompletionError);
    expect(error).toMatchObject({
      code: 'COMPLETION_FAILED',
      failureCode: 'CREDENTIALS_UNAVAILABLE',
      message: 'CREDENTIALS_UNAVAILABLE: no key for the route',
    });
  });

  it('reports the host’s own deadline as the timeout the UI translates', async () => {
    const { host, calls } = fakeHost();
    const service = new DshCompletionService({ host });
    const pending = service.complete(base);
    calls[0]?.answer(failed('completion_timeout', 'no answer within 30000 ms'));
    await expect(pending).rejects.toMatchObject({
      code: 'COMPLETION_TIMEOUT',
      message: COMPLETION_TIMEOUT_MESSAGE,
    });
    expect(COMPLETION_TIMEOUT_MESSAGE).toBe('timeout');
  });

  it('reports a host that could not be had, or went away, as unavailable', async () => {
    const { host, calls } = fakeHost();
    const service = new DshCompletionService({ host });
    const pending = service.complete(base);
    calls[0]?.fail(
      Object.assign(new Error('DSH_HOST_START_FAILED: the DSH host refused to start: x'), {
        code: 'DSH_HOST_START_FAILED',
      })
    );
    await expect(pending).rejects.toMatchObject({
      code: 'COMPLETION_UNAVAILABLE',
      failureCode: 'DSH_HOST_START_FAILED',
      message: 'DSH_HOST_START_FAILED: the DSH host refused to start: x',
    });
  });

  it('refuses a third at once, an empty prompt, a bad deadline and a repeated id', async () => {
    const { host, calls } = fakeHost();
    const service = new DshCompletionService({ host });
    const first = service.complete({ ...base, operationId: 'a' });
    const second = service.complete(base);
    await expect(service.complete(base)).rejects.toMatchObject({
      code: 'COMPLETION_CAPACITY_EXCEEDED',
    });
    expect(calls).toHaveLength(2);
    calls[1]?.answer(ok('x'));
    await second;
    await expect(service.complete({ ...base, prompt: '  ' })).rejects.toMatchObject({
      code: 'COMPLETION_FAILED',
    });
    await expect(service.complete({ ...base, timeoutMs: 0 })).rejects.toMatchObject({
      code: 'COMPLETION_FAILED',
    });
    await expect(service.complete({ ...base, operationId: 'a' })).rejects.toMatchObject({
      code: 'COMPLETION_FAILED',
    });
    expect(calls).toHaveLength(2);
    calls[0]?.answer(ok('y'));
    await first;
  });
});

describe('DshCompletionService — deadline, cancel, logout and quit', () => {
  it('gives up at Main’s deadline, tells the host, and ignores its late answer', async () => {
    vi.useFakeTimers();
    const { host, calls } = fakeHost();
    const service = new DshCompletionService({ host });
    const pending = service.complete({ ...base, timeoutMs: 5_000 });
    const outcome = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(calls[0]?.cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toMatchObject({ code: 'COMPLETION_TIMEOUT', message: 'timeout' });
    expect(calls[0]?.cancel).toHaveBeenCalledTimes(1);
    calls[0]?.answer(ok('too late'));
    await vi.advanceTimersByTimeAsync(0);
    expect(service.activeCount).toBe(0);
  });

  it('cancels one completion by its operation id, and nothing else', async () => {
    const { host, calls } = fakeHost();
    const service = new DshCompletionService({ host });
    const review = service.complete({ ...base, operationId: 'review-7' });
    const other = service.complete(base);
    expect(service.cancel('nope')).toBe(false);
    expect(service.cancel('review-7')).toBe(true);
    expect(service.cancel('review-7')).toBe(false);
    await expect(review).rejects.toMatchObject({
      code: 'COMPLETION_CANCELLED',
      message: 'cancelled',
    });
    expect(calls[0]?.cancel).toHaveBeenCalledTimes(1);
    expect(calls[1]?.cancel).not.toHaveBeenCalled();
    calls[1]?.answer(ok('x'));
    await expect(other).resolves.toMatchObject({ text: 'x' });
  });

  it('invalidateAll cancels everything in flight and stays usable (logout)', async () => {
    const { host, calls } = fakeHost();
    const service = new DshCompletionService({ host });
    const one = service.complete(base).catch((error: unknown) => error);
    const two = service.complete(base).catch((error: unknown) => error);
    await service.invalidateAll();
    expect(await one).toMatchObject({ code: 'COMPLETION_CANCELLED' });
    expect(await two).toMatchObject({ code: 'COMPLETION_CANCELLED' });
    expect(calls.every((call) => call.cancel.mock.calls.length === 1)).toBe(true);
    const next = service.complete(base);
    calls[2]?.answer(ok('after sign-in'));
    await expect(next).resolves.toMatchObject({ text: 'after sign-in' });
  });

  it('disposeAll and forceKillAllNow cancel everything and refuse what comes after', async () => {
    const { host, calls } = fakeHost();
    const disposed = new DshCompletionService({ host });
    const running = disposed.complete(base).catch((error: unknown) => error);
    await disposed.disposeAll();
    expect(await running).toMatchObject({ code: 'COMPLETION_CANCELLED' });
    await expect(disposed.complete(base)).rejects.toMatchObject({
      code: 'COMPLETION_UNAVAILABLE',
    });

    const killed = new DshCompletionService({ host });
    const cut = killed.complete(base).catch((error: unknown) => error);
    killed.forceKillAllNow();
    expect(killed.activeCount).toBe(0);
    expect(await cut).toMatchObject({ code: 'COMPLETION_CANCELLED' });
    await expect(killed.complete(base)).rejects.toMatchObject({
      code: 'COMPLETION_UNAVAILABLE',
    });
    expect(calls).toHaveLength(2);
  });
});
