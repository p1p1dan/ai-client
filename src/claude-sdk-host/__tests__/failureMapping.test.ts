import { describe, expect, it } from 'vitest';
import { CLAUDE_ENGINE_EXITED } from '../../shared/claudeSdkEngine.ts';
import {
  gatewayMessageOf,
  mapSdkFailure,
  type SdkFailureSignals,
  sanitizeHostLogLine,
} from '../failureMapping.ts';

// The result and assistant shapes below are what the 2.1.300 CLI produced against the fake
// gateway's `CC-ERR` marker (x-should-retry: false), copied from the S-1 measurements.
function httpFailure(
  status: number,
  text: string,
  assistantError: string,
  terminal = 'api_error'
): SdkFailureSignals {
  return {
    assistantError,
    result: {
      subtype: 'success',
      is_error: true,
      api_error_status: status,
      terminal_reason: terminal,
      result: text,
    },
  };
}

const MEASURED = {
  401: httpFailure(401, 'Invalid API key · Fix external API key', 'authentication_failed'),
  403: httpFailure(
    403,
    'Failed to authenticate. API Error: 403 Your API key does not have permission to use the specified resource.',
    'authentication_failed'
  ),
  404: httpFailure(
    404,
    "There's an issue with the selected model (claude-opus-5-5). It may not exist or you may not have access to it.",
    'model_not_found'
  ),
  413: httpFailure(
    413,
    'Request too large (max 32MB). Accumulated images and attachments in the conversation pushed the request over the limit. Remove older images or compact the conversation.',
    'invalid_request',
    'image_error'
  ),
  429: httpFailure(
    429,
    'API Error: Request rejected (429) · Number of requests has exceeded your rate limit.',
    'rate_limit'
  ),
  500: httpFailure(
    500,
    'API Error: 500 Internal server error. This is a server-side issue, usually temporary — try again in a moment. If it persists, check your inference gateway (127.0.0.1:18950).',
    'server_error'
  ),
  529: {
    ...httpFailure(
      529,
      'API Error: Repeated 529 Overloaded errors. The API is at capacity — this is usually temporary. Try again in a moment. If it persists, check your inference gateway (127.0.0.1:18950).',
      'server_error'
    ),
    retry: { error: 'overloaded', error_status: 529 },
  },
  refused: {
    assistantError: 'server_error',
    result: {
      subtype: 'success',
      is_error: true,
      api_error_status: null,
      terminal_reason: 'api_error',
      result:
        'API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)',
    },
  },
} satisfies Record<string, SdkFailureSignals>;

/** No sentence the card prints may carry the CLI's own hints or name Claude Code. */
function expectNeutral(error: string): void {
  expect(error).not.toMatch(/claude code/i);
  expect(error).not.toMatch(/Fix external API key|inference gateway|try again in a moment/i);
}

describe('mapSdkFailure: the classified gateway markers come first', () => {
  it('a gateway with no upstream left is GATEWAY_NO_UPSTREAM, not a plain server error', () => {
    const failure = mapSdkFailure(
      httpFailure(
        503,
        'API Error: 503 no_available_providers: every upstream is busy. This is a server-side issue, usually temporary — try again in a moment.',
        'server_error'
      )
    );
    expect(failure).toEqual({
      errorCode: 'GATEWAY_NO_UPSTREAM',
      error: 'Upstream request failed (HTTP 503): no_available_providers: every upstream is busy',
    });
  });

  it('the stream gate and a refused model setting keep their own codes', () => {
    expect(
      mapSdkFailure(
        httpFailure(
          502,
          'API Error: 502 stream_gate_precommit: prebuffer_overflow.',
          'server_error'
        )
      ).errorCode
    ).toBe('GATEWAY_STREAM_GATE');
    expect(
      mapSdkFailure(
        httpFailure(
          400,
          'API Error: 400 "thinking.type.disabled" is not supported for this model',
          'unknown'
        )
      ).errorCode
    ).toBe('MODEL_SETTING_UNSUPPORTED');
  });
});

describe('mapSdkFailure: one row per HTTP class (measured shapes)', () => {
  it('401 and 403, and the auth classes without a status, are PROVIDER_UNAUTHORIZED', () => {
    expect(mapSdkFailure(MEASURED[401])).toEqual({
      errorCode: 'PROVIDER_UNAUTHORIZED',
      error: 'Upstream request failed (HTTP 401)',
    });
    expect(mapSdkFailure(MEASURED[403])).toEqual({
      errorCode: 'PROVIDER_UNAUTHORIZED',
      error:
        'Upstream request failed (HTTP 403): Your API key does not have permission to use the specified resource.',
    });
    for (const kind of [
      'authentication_failed',
      'oauth_org_not_allowed',
      'account_on_hold',
      'verification_required',
      'cloud_credential_error',
    ]) {
      expect(mapSdkFailure({ assistantError: kind }).errorCode).toBe('PROVIDER_UNAUTHORIZED');
    }
  });

  it('429, rate_limit and billing_error are PROVIDER_RATE_LIMITED', () => {
    expect(mapSdkFailure(MEASURED[429])).toEqual({
      errorCode: 'PROVIDER_RATE_LIMITED',
      error: 'Upstream request failed (HTTP 429): Number of requests has exceeded your rate limit.',
    });
    expect(mapSdkFailure({ assistantError: 'rate_limit' }).errorCode).toBe('PROVIDER_RATE_LIMITED');
    expect(mapSdkFailure({ assistantError: 'billing_error' }).errorCode).toBe(
      'PROVIDER_RATE_LIMITED'
    );
  });

  it('404 and model_not_found are MODEL_NOT_CONFIGURED', () => {
    expect(mapSdkFailure(MEASURED[404])).toEqual({
      errorCode: 'MODEL_NOT_CONFIGURED',
      error: 'Upstream request failed (HTTP 404)',
    });
    expect(mapSdkFailure({ assistantError: 'model_not_found' }).errorCode).toBe(
      'MODEL_NOT_CONFIGURED'
    );
  });

  it('413 (the CLI calls it image_error) and terminal prompt_too_long are CONTEXT_TOO_LARGE', () => {
    expect(mapSdkFailure(MEASURED[413])).toEqual({
      errorCode: 'CONTEXT_TOO_LARGE',
      error: 'Upstream request failed (HTTP 413)',
    });
    expect(
      mapSdkFailure({
        result: { subtype: 'success', is_error: true, terminal_reason: 'prompt_too_long' },
      })
    ).toEqual({
      errorCode: 'CONTEXT_TOO_LARGE',
      error: 'The conversation is too large for the model',
    });
    // Measured: a gateway's 400 "prompt is too long" arrives as terminal prompt_too_long.
    expect(
      mapSdkFailure(
        httpFailure(
          400,
          'Prompt is too long · the request is ~250000 tokens (limit 200000) but this conversation is only ~2345 tokens — the rest is system prompt, tool definitions, and attachment content.',
          'invalid_request',
          'prompt_too_long'
        )
      )
    ).toEqual({ errorCode: 'CONTEXT_TOO_LARGE', error: 'Upstream request failed (HTTP 400)' });
  });

  it('408, 504, a first-byte timeout and a timed-out connection are TIMEOUT', () => {
    expect(mapSdkFailure(httpFailure(408, 'API Error: 408 Request timed out', 'unknown'))).toEqual({
      errorCode: 'TIMEOUT',
      error: 'Upstream request failed (HTTP 408): Request timed out',
    });
    expect(
      mapSdkFailure(httpFailure(504, 'API Error: 504 Gateway timeout.', 'server_error')).errorCode
    ).toBe('TIMEOUT');
    expect(
      mapSdkFailure({
        assistantError: 'unknown',
        retry: {
          error: 'unknown',
          error_status: null,
          no_response: { waited_ms: 1, retry_wait_ms: 1 },
        },
      })
    ).toEqual({ errorCode: 'TIMEOUT', error: 'The upstream did not answer in time' });
    expect(
      mapSdkFailure({
        result: {
          subtype: 'success',
          is_error: true,
          api_error_status: null,
          result: 'API Error: Request timed out.',
        },
      }).errorCode
    ).toBe('TIMEOUT');
  });

  it('a connection that got no HTTP response is NETWORK_ERROR', () => {
    expect(mapSdkFailure(MEASURED.refused)).toEqual({
      errorCode: 'NETWORK_ERROR',
      error: 'Could not reach the upstream (ECONNREFUSED)',
    });
    expect(
      mapSdkFailure({
        result: {
          subtype: 'success',
          is_error: true,
          api_error_status: null,
          result:
            'API Error: Unable to connect to API: Self-signed certificate detected (DEPTH_ZERO_SELF_SIGNED_CERT).',
        },
      })
    ).toEqual({
      errorCode: 'NETWORK_ERROR',
      error: 'Could not reach the upstream (DEPTH_ZERO_SELF_SIGNED_CERT)',
    });
    // Only the retries said why: they had no HTTP response either.
    expect(
      mapSdkFailure({ assistantError: 'unknown', retry: { error: 'unknown', error_status: null } })
        .errorCode
    ).toBe('NETWORK_ERROR');
  });

  it('500, 529, overloaded and any other 4xx/5xx are PROVIDER_ERROR', () => {
    expect(mapSdkFailure(MEASURED[500])).toEqual({
      errorCode: 'PROVIDER_ERROR',
      error: 'Upstream request failed (HTTP 500): Internal server error',
    });
    expect(mapSdkFailure(MEASURED[529])).toEqual({
      errorCode: 'PROVIDER_ERROR',
      error: 'Upstream request failed (HTTP 529)',
    });
    expect(mapSdkFailure(httpFailure(400, 'API Error: 400 Invalid request', 'unknown'))).toEqual({
      errorCode: 'PROVIDER_ERROR',
      error: 'Upstream request failed (HTTP 400): Invalid request',
    });
    expect(mapSdkFailure({ assistantError: 'overloaded' }).errorCode).toBe('PROVIDER_ERROR');
  });

  it('a result without a status ignores the status an earlier retry saw', () => {
    expect(
      mapSdkFailure({ ...MEASURED.refused, retry: { error: 'overloaded', error_status: 529 } })
        .errorCode
    ).toBe('NETWORK_ERROR');
  });
});

describe('mapSdkFailure: the engine itself', () => {
  it('the CLI going away mid-turn is claude_engine_exited', () => {
    expect(mapSdkFailure({ cliExited: true })).toEqual({
      errorCode: CLAUDE_ENGINE_EXITED,
      error: 'The Agent SDK engine exited',
    });
  });

  it('a throw is mapped by its text: the SDK exit errors, then the HTTP rows', () => {
    for (const thrown of [
      'Claude Code process exited with code 1. stderr: boom',
      'Claude Code process terminated by signal SIGKILL',
    ]) {
      expect(mapSdkFailure({ thrown })).toEqual({
        errorCode: CLAUDE_ENGINE_EXITED,
        error: 'The Agent SDK engine exited',
      });
    }
    expect(
      mapSdkFailure({
        thrown:
          'Claude Code returned an error result: API Error: 500 Internal server error. This is a server-side issue, usually temporary.',
      })
    ).toEqual({
      errorCode: 'PROVIDER_ERROR',
      error: 'Upstream request failed (HTTP 500): Internal server error',
    });
  });

  it('anything else carries no code and a neutral sentence', () => {
    expect(mapSdkFailure({ thrown: 'Claude Code hit something odd' })).toEqual({
      error: 'The Agent SDK engine reported an error',
    });
    expect(
      mapSdkFailure({
        result: {
          subtype: 'error_max_turns',
          is_error: true,
          errors: ['Reached maximum number of turns (5)'],
        },
      })
    ).toEqual({ error: 'The turn reached its step limit' });
    expect(
      mapSdkFailure({ result: { subtype: 'error_during_execution', is_error: true, errors: [] } })
    ).toEqual({ error: 'The Agent SDK engine failed during the turn' });
    expect(mapSdkFailure({ assistantError: 'max_output_tokens' })).toEqual({
      error: 'The Agent SDK engine reported an error',
    });
  });
});

describe('the card sentence', () => {
  it('never carries the CLI hints or the words Claude Code, for every measured row', () => {
    for (const signals of Object.values(MEASURED)) expectNeutral(mapSdkFailure(signals).error);
    expectNeutral(mapSdkFailure({ thrown: 'Claude Code process exited with code 2' }).error);
  });

  it('drops a gateway message that names Claude Code', () => {
    expect(
      mapSdkFailure(
        httpFailure(500, 'API Error: 500 Claude Code is not allowed here', 'server_error')
      ).error
    ).toBe('Upstream request failed (HTTP 500)');
  });

  it('blanks the key and credential shapes a gateway echoes back', () => {
    const failure = mapSdkFailure(
      httpFailure(
        401,
        'Failed to authenticate. API Error: 401 invalid x-api-key sk-fake-secret-123 (also sk-ant-api03-abcdef)',
        'authentication_failed'
      ),
      ['sk-fake-secret-123']
    );
    expect(failure.errorCode).toBe('PROVIDER_UNAUTHORIZED');
    expect(failure.error).not.toContain('sk-fake-secret-123');
    expect(failure.error).not.toContain('sk-ant-api03-abcdef');
    expect(failure.error).toMatch(/^Upstream request failed \(HTTP 401\): invalid x-api-key/);
  });

  it('keeps a quoted gateway message to one bounded line', () => {
    const message = gatewayMessageOf([`API Error: 500 ${'x'.repeat(400)}`]);
    expect(message?.length).toBe(301);
    expect(gatewayMessageOf(['Invalid API key · Fix external API key'])).toBeUndefined();
  });
});

describe('sanitizeHostLogLine', () => {
  it('blanks the key and credential shapes and never names Claude Code', () => {
    const key = 'sk-fake-short-key';
    const line = sanitizeHostLogLine(
      `[cli] Claude Code process exited; API Error: 401 invalid x-api-key ${key} · Authorization: Bearer abcdefghijklmnopqrstuvwxyz`,
      [key]
    );
    expect(line).not.toContain(key);
    expect(line).not.toMatch(/claude code/i);
    expect(line).toContain('Agent SDK engine process exited');
    expect(line).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });
});
