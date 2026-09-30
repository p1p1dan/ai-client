import { describe, expect, it } from 'vitest';
import { TOOL_CALL_REPETITION } from '../../dsh-host/loopGuard/constants.ts';
import {
  CREDENTIALS_UNAVAILABLE,
  classifyDshFailureText,
  dshFailureErrorCode,
  GATEWAY_STREAM_GATE,
  isUnretryableDshFailure,
  MODEL_NOT_CONFIGURED,
  MODEL_SETTING_UNSUPPORTED,
  mapDshFailureCode,
  TOOL_CALL_REPETITION_CODE,
} from '../dshFailureCodes';

/** dsh-rebase P1-5b — design shard 03 §5: DSH's failure codes in ours. */
describe('mapDshFailureCode', () => {
  it('maps every code the design lists', () => {
    expect(
      Object.fromEntries(
        [
          'MISSING_CREDENTIAL',
          'INVALID_CREDENTIAL',
          'AUTH',
          'RATE_LIMIT',
          'QUOTA',
          'ACCOUNT_QUOTA',
          'CONTEXT_WINDOW_EXCEEDED',
          'UNKNOWN_MODEL',
          'NO_ADAPTER',
          'MODEL_NOT_IN_PLAN',
          'MODEL_CATALOG_EMPTY',
          'TIMEOUT',
          'TRANSPORT',
          'SERVER',
        ].map((code) => [code, mapDshFailureCode(code)])
      )
    ).toEqual({
      MISSING_CREDENTIAL: CREDENTIALS_UNAVAILABLE,
      INVALID_CREDENTIAL: 'PROVIDER_UNAUTHORIZED',
      AUTH: 'PROVIDER_UNAUTHORIZED',
      RATE_LIMIT: 'PROVIDER_RATE_LIMITED',
      QUOTA: 'PROVIDER_RATE_LIMITED',
      ACCOUNT_QUOTA: 'PROVIDER_RATE_LIMITED',
      CONTEXT_WINDOW_EXCEEDED: 'CONTEXT_TOO_LARGE',
      UNKNOWN_MODEL: MODEL_NOT_CONFIGURED,
      NO_ADAPTER: MODEL_NOT_CONFIGURED,
      MODEL_NOT_IN_PLAN: MODEL_NOT_CONFIGURED,
      MODEL_CATALOG_EMPTY: MODEL_NOT_CONFIGURED,
      TIMEOUT: 'TIMEOUT',
      TRANSPORT: 'NETWORK_ERROR',
      SERVER: 'PROVIDER_ERROR',
    });
  });

  it('[P1-4d1] maps the rest of what DSH classifies a failed request as', () => {
    expect(
      Object.fromEntries(
        ['INVALID_REQUEST', 'EMPTY_RESPONSE', 'PI_AI_ERROR'].map((code) => [
          code,
          mapDshFailureCode(code),
        ])
      )
    ).toEqual({
      INVALID_REQUEST: 'PROVIDER_ERROR',
      EMPTY_RESPONSE: 'PROVIDER_ERROR',
      PI_AI_ERROR: 'PROVIDER_ERROR',
    });
  });

  it("[P1-4d1] passes the loop guard's own code through, the one the renderer has a card for", () => {
    expect(TOOL_CALL_REPETITION_CODE).toBe(TOOL_CALL_REPETITION);
    expect(mapDshFailureCode(TOOL_CALL_REPETITION)).toBe(TOOL_CALL_REPETITION);
  });

  it('maps a code it does not know, or no code, to nothing', () => {
    for (const code of [
      'UNKNOWN',
      'UNSUPPORTED_CONTENT',
      'IMAGE_OFFLOAD_REQUIRED',
      'constructor',
      '',
      undefined,
      7,
    ]) {
      expect(mapDshFailureCode(code), String(code)).toBeUndefined();
    }
  });
});

/**
 * dsh-rebase P1-7e (decision 140): two provider failures only their text tells
 * apart, from whatever class DSH gave them.
 */
describe('classifyDshFailureText / dshFailureErrorCode', () => {
  const GATE_BODY =
    '{"error":{"type":"stream_gate_precommit","reason":"prebuffer_overflow","family":"anthropic","limit":65536}}';

  it('[E2B-CLASS-1] names a gateway stream gate by either marker, in any wrapping', () => {
    for (const text of [
      GATE_BODY,
      `500 ${GATE_BODY}`,
      'stream_gate_precommit',
      'the gateway reported prebuffer_overflow',
      'STREAM_GATE_PRECOMMIT',
    ]) {
      expect(classifyDshFailureText(text), text).toBe(GATEWAY_STREAM_GATE);
    }
  });

  it('[E2B-CLASS-2] names a parameter the model does not take', () => {
    expect(
      classifyDshFailureText('400 "thinking.type.disabled" is not supported for this model')
    ).toBe(MODEL_SETTING_UNSUPPORTED);
    expect(classifyDshFailureText('Temperature Is Not Supported For This Model')).toBe(
      MODEL_SETTING_UNSUPPORTED
    );
  });

  it('[E2B-CLASS-3] the gate wins when a text carries both; anything else is nothing', () => {
    expect(classifyDshFailureText(`${GATE_BODY} (thinking is not supported for this model)`)).toBe(
      GATEWAY_STREAM_GATE
    );
    for (const text of [
      '500 upstream exploded',
      'stream gate',
      'prebuffer',
      'not supported',
      'pi-ai model "fake-1" does not support image input',
      '',
      undefined,
      7,
    ]) {
      expect(classifyDshFailureText(text), String(text)).toBeUndefined();
    }
  });

  it('[E2B-CLASS-4] a failure is read by its text first, then by its code', () => {
    expect(dshFailureErrorCode({ message: `502 ${GATE_BODY}`, code: 'SERVER' })).toBe(
      GATEWAY_STREAM_GATE
    );
    expect(dshFailureErrorCode({ message: GATE_BODY, code: 'PI_AI_ERROR' })).toBe(
      GATEWAY_STREAM_GATE
    );
    expect(
      dshFailureErrorCode({
        message: '"thinking.type.disabled" is not supported for this model',
        code: 'INVALID_REQUEST',
      })
    ).toBe(MODEL_SETTING_UNSUPPORTED);
    expect(dshFailureErrorCode({ message: 'boom', code: 'SERVER' })).toBe('PROVIDER_ERROR');
    expect(dshFailureErrorCode({ code: 'TRANSPORT' })).toBe('NETWORK_ERROR');
    expect(dshFailureErrorCode({ message: 'boom', code: 'UNKNOWN' })).toBeUndefined();
    expect(dshFailureErrorCode(undefined)).toBeUndefined();
    expect(dshFailureErrorCode('SERVER')).toBeUndefined();
  });

  it('[E2B-CLASS-5] exactly those two are the failures a retry cannot help', () => {
    expect(isUnretryableDshFailure({ message: GATE_BODY, code: 'SERVER' })).toBe(true);
    expect(
      isUnretryableDshFailure({ message: 'x is not supported for this model', code: 'SERVER' })
    ).toBe(true);
    expect(isUnretryableDshFailure({ message: '500 upstream exploded', code: 'SERVER' })).toBe(
      false
    );
    expect(isUnretryableDshFailure({ code: 'SERVER' })).toBe(false);
    expect(isUnretryableDshFailure(null)).toBe(false);
  });
});
