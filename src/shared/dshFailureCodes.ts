// New in dsh-rebase P1-5b
/**
 * DSH's failure codes in the vocabulary the native runtime classified provider
 * failures with (`providerErrors.ts`), plus one of its own (design shard 03 §5).
 *
 * The DSH bridge puts the mapped code on `session.failed` as `errorCode`, next
 * to DSH's own sentence, and answers a turn it cannot route with
 * `MODEL_NOT_CONFIGURED`. A code DSH adds later maps to nothing: the renderer
 * then shows its generic card with DSH's sentence, rather than a wrong reason.
 *
 * Pure and import-free: Main, the renderer and the host's bridge (loaded by
 * Node type stripping) all read it.
 */

/** Signed out, or the system keyring is locked: the host got no key for the route. */
export const CREDENTIALS_UNAVAILABLE = 'CREDENTIALS_UNAVAILABLE';

/** The model is not in the plan, or the plan has no model at all. */
export const MODEL_NOT_CONFIGURED = 'MODEL_NOT_CONFIGURED';

export type DshMappedFailureCode =
  | typeof CREDENTIALS_UNAVAILABLE
  | 'PROVIDER_UNAUTHORIZED'
  | 'PROVIDER_RATE_LIMITED'
  | 'CONTEXT_TOO_LARGE'
  | typeof MODEL_NOT_CONFIGURED
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'PROVIDER_ERROR';

const DSH_FAILURE_CODES: Readonly<Record<string, DshMappedFailureCode>> = {
  MISSING_CREDENTIAL: CREDENTIALS_UNAVAILABLE,
  INVALID_CREDENTIAL: 'PROVIDER_UNAUTHORIZED',
  AUTH: 'PROVIDER_UNAUTHORIZED',
  RATE_LIMIT: 'PROVIDER_RATE_LIMITED',
  QUOTA: 'PROVIDER_RATE_LIMITED',
  ACCOUNT_QUOTA: 'PROVIDER_RATE_LIMITED',
  CONTEXT_WINDOW_EXCEEDED: 'CONTEXT_TOO_LARGE',
  UNKNOWN_MODEL: MODEL_NOT_CONFIGURED,
  NO_ADAPTER: MODEL_NOT_CONFIGURED,
  // `resolveRoute`'s own refusals (`@shared/dshModelPlan`).
  MODEL_NOT_IN_PLAN: MODEL_NOT_CONFIGURED,
  MODEL_CATALOG_EMPTY: MODEL_NOT_CONFIGURED,
  TIMEOUT: 'TIMEOUT',
  TRANSPORT: 'NETWORK_ERROR',
  SERVER: 'PROVIDER_ERROR',
};

/** Our code for a DSH failure code, or undefined for one this table does not know. */
export function mapDshFailureCode(code: unknown): DshMappedFailureCode | undefined {
  return typeof code === 'string' && Object.hasOwn(DSH_FAILURE_CODES, code)
    ? DSH_FAILURE_CODES[code]
    : undefined;
}
