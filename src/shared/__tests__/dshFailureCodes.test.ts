import { describe, expect, it } from 'vitest';
import { TOOL_CALL_REPETITION } from '../../dsh-host/loopGuard/constants.ts';
import {
  CREDENTIALS_UNAVAILABLE,
  classifyDshFailureText,
  dshFailureErrorCode,
  GATEWAY_NO_UPSTREAM,
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

/**
 * Decision 165: Anthropic's answers when an adaptive-only model was sent
 * budget thinking or `disabled` are the same kind of refused setting. Bodies
 * from issue #4 (request ids made up).
 */
describe('an adaptive-only model sent the wrong thinking (decision 165)', () => {
  const REQUIRES =
    '400 {"error":{"type":"<nil>","message":"claude-opus-5-5 requires adaptive thinking; omit thinking or use ***.type=adaptive and output_config.effort (request id: x)"}}';
  const BETWEEN_TOOLS =
    'status_code=400, To turn thinking off on this model, send "thinking": {"type": "between_tools"} instead of {"type": "disabled"}.';

  it('[AT-CLASS-1] names both answers, and each marker alone, as a refused setting', () => {
    for (const text of [
      REQUIRES,
      BETWEEN_TOOLS,
      'status_code=400, claude-opus-5-5 requires adaptive thinking; omit thinking',
      'Requires Adaptive Thinking',
      'between_tools',
      'use thinking.type=adaptive and output_config.effort',
    ]) {
      expect(classifyDshFailureText(text), text).toBe(MODEL_SETTING_UNSUPPORTED);
    }
    expect(dshFailureErrorCode({ message: REQUIRES, code: 'INVALID_REQUEST' })).toBe(
      MODEL_SETTING_UNSUPPORTED
    );
    expect(isUnretryableDshFailure({ message: REQUIRES, code: 'INVALID_REQUEST' })).toBe(true);
    expect(isUnretryableDshFailure({ message: BETWEEN_TOOLS, code: 'INVALID_REQUEST' })).toBe(true);
  });

  it('[AT-CLASS-2] leaves a 400 without these markers as it was', () => {
    for (const text of [
      '400 {"error":{"type":"invalid_request_error","message":"max_tokens: must be at most 8192"}}',
      '400 thinking budget too small',
      '400 adaptive',
      '400 output_config is invalid',
      '400 between tools',
      '400 effort must be one of low, medium, high',
    ]) {
      expect(classifyDshFailureText(text), text).toBeUndefined();
      expect(dshFailureErrorCode({ message: text, code: 'INVALID_REQUEST' }), text).toBe(
        'PROVIDER_ERROR'
      );
    }
  });

  it('[AT-CLASS-3] the stream gate and the no-upstream answer still win over it', () => {
    expect(classifyDshFailureText(`stream_gate_precommit ${REQUIRES}`)).toBe(GATEWAY_STREAM_GATE);
    expect(classifyDshFailureText(`no_available_providers ${REQUIRES}`)).toBe(GATEWAY_NO_UPSTREAM);
  });
});

/**
 * dsh-rebase decision 146 (GW-2): a company gateway that answers it has no
 * upstream left for the request is read off its text too, and is not retried.
 * The bodies are shaped like the real-gateway pass's (P1-5 R2, R8), with the
 * session marker and upstream ids made up.
 */
describe('a gateway with no upstream left (decision 146)', () => {
  const NO_PROVIDERS =
    '503: {"message":"No available providers (cch_session_id: s-1)","type":"no_available_providers","code":"no_available_providers","details":{"totalAttempts":1,"filteredProviders":[{"id":1,"reason":"disabled"}]}}';
  const ALL_DOWN =
    '503: {"message":"所有供应商暂时不可用，请稍后重试 (cch_session_id: s-2)","type":"service_unavailable_error","code":"service_unavailable_error"}';

  it('[GW2-CLASS-1] names both answers, by the type token or by the sentence', () => {
    for (const text of [
      NO_PROVIDERS,
      ALL_DOWN,
      'no_available_providers',
      'NO_AVAILABLE_PROVIDERS',
      '所有供应商不可用',
      // What the Anthropic SDK leaves of a body whose top level has a `message`:
      // the sentence, without the type token (the fake gateway's P1-NOUP, live).
      '503 No available providers (cch_session_id: s-3)',
    ]) {
      expect(classifyDshFailureText(text), text).toBe(GATEWAY_NO_UPSTREAM);
    }
  });

  it('[GW2-CLASS-2] leaves an ordinary 5xx alone, a bare service_unavailable_error included', () => {
    for (const text of [
      '503 Service Unavailable',
      '503: {"message":"upstream timed out","type":"service_unavailable_error","code":"service_unavailable_error"}',
      '502 Bad Gateway',
      'no providers available',
      'available_providers',
    ]) {
      expect(classifyDshFailureText(text), text).toBeUndefined();
    }
  });

  it('[GW2-CLASS-3] maps to its own code over SERVER, and is a failure a retry cannot help', () => {
    expect(dshFailureErrorCode({ message: NO_PROVIDERS, code: 'SERVER' })).toBe(
      GATEWAY_NO_UPSTREAM
    );
    expect(dshFailureErrorCode({ message: ALL_DOWN, code: 'SERVER' })).toBe(GATEWAY_NO_UPSTREAM);
    expect(isUnretryableDshFailure({ message: NO_PROVIDERS, code: 'SERVER' })).toBe(true);
    expect(isUnretryableDshFailure({ message: ALL_DOWN, code: 'SERVER' })).toBe(true);
    expect(isUnretryableDshFailure({ message: '503 Service Unavailable', code: 'SERVER' })).toBe(
      false
    );
  });

  it('[GW2-CLASS-4] the stream gate still wins over it', () => {
    expect(classifyDshFailureText(`stream_gate_precommit ${NO_PROVIDERS}`)).toBe(
      GATEWAY_STREAM_GATE
    );
  });
});
