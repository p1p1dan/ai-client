import { describe, expect, it, vi } from 'vitest';
import {
  type DshRequestErrorAction,
  type DshRequestErrorPayload,
  installRetryVeto,
  vetoUnretryableFailure,
} from '../retryVeto.ts';

/**
 * dsh-rebase P1-7e (decision 140): DSH's automatic retry never repeats a
 * request whose failure text says the same request fails the same way — a
 * company gateway's stream gate, a parameter the model refuses — whatever the
 * route's retry policy says about their class. Every other failure goes on to
 * the rest of the chain untouched.
 */
describe('vetoUnretryableFailure', () => {
  const retry = (): Promise<DshRequestErrorAction> => Promise.resolve({ kind: 'retry' });
  const failure = (message: string, code = 'SERVER'): DshRequestErrorPayload => ({
    failure: { message, code },
  });

  it('[E2B-VETO-1] leaves a stream-gate failure terminal, even as a 5xx', async () => {
    const next = vi.fn(retry);
    for (const message of [
      '500 {"error":{"type":"stream_gate_precommit","reason":"prebuffer_overflow","family":"anthropic"}}',
      '502 stream_gate_precommit',
      'upstream said prebuffer_overflow',
    ]) {
      expect(await vetoUnretryableFailure(failure(message), next), message).toBeUndefined();
    }
    expect(next).not.toHaveBeenCalled();
  });

  it('[E2B-VETO-2] leaves a refused model setting terminal', async () => {
    const next = vi.fn(retry);
    expect(
      await vetoUnretryableFailure(
        failure('500 "thinking.type.disabled" is not supported for this model'),
        next
      )
    ).toBeUndefined();
    expect(next).not.toHaveBeenCalled();
  });

  it('[E2B-VETO-3] passes every other failure on, whatever its class', async () => {
    for (const payload of [
      failure('500 upstream exploded'),
      failure('Connection error.', 'TRANSPORT'),
      failure('429 slow down', 'RATE_LIMIT'),
      {},
      { failure: { code: 'SERVER' } },
    ] as DshRequestErrorPayload[]) {
      const next = vi.fn(retry);
      expect(await vetoUnretryableFailure(payload, next)).toEqual({ kind: 'retry' });
      expect(next).toHaveBeenCalledTimes(1);
    }
  });

  it('[E2B-VETO-4] is installed first on agent/request-error, ahead of the retry policy', () => {
    const on = vi.fn();
    installRetryVeto({ on });
    expect(on).toHaveBeenCalledWith('agent/request-error', vetoUnretryableFailure, {
      prepend: true,
    });
  });
});
