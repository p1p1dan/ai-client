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

  it('[GW2-VETO] leaves a gateway with no upstream left terminal (decision 146)', async () => {
    const next = vi.fn(retry);
    for (const message of [
      '503: {"message":"No available providers","type":"no_available_providers","code":"no_available_providers"}',
      '503: {"message":"所有供应商暂时不可用，请稍后重试","type":"service_unavailable_error"}',
      // The same body through the Anthropic SDK: only its top-level message is left.
      '503 No available providers (cch_session_id: s-1)',
    ]) {
      expect(await vetoUnretryableFailure(failure(message), next), message).toBeUndefined();
    }
    expect(next).not.toHaveBeenCalled();
    // A bare 503 is still an ordinary server error, and is retried.
    const plain = vi.fn(retry);
    expect(
      await vetoUnretryableFailure(
        failure('503: {"message":"busy","type":"service_unavailable_error"}'),
        plain
      )
    ).toEqual({ kind: 'retry' });
    expect(plain).toHaveBeenCalledTimes(1);
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
