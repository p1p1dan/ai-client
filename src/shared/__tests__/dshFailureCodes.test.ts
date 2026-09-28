import { describe, expect, it } from 'vitest';
import {
  CREDENTIALS_UNAVAILABLE,
  MODEL_NOT_CONFIGURED,
  mapDshFailureCode,
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

  it('maps a code it does not know, or no code, to nothing', () => {
    for (const code of ['EMPTY_RESPONSE', 'constructor', '', undefined, 7]) {
      expect(mapDshFailureCode(code), String(code)).toBeUndefined();
    }
  });
});
