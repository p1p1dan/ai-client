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

/**
 * Our own code, passed through as it is (dsh-rebase decision 081's handoff):
 * the loop guard cut a reply that kept repeating delegation calls
 * (`TOOL_CALL_REPETITION` of src/dsh-host/loopGuard/constants.ts, which this
 * import-free module may not load; a test pins the two together). The
 * renderer has a card of its own for it.
 */
export const TOOL_CALL_REPETITION_CODE = 'tool_call_repetition';

/**
 * dsh-rebase P1-7e (decision 140): a company gateway's stream gate refused the
 * reply before the model's first byte (`stream_gate_precommit`, reason
 * `prebuffer_overflow`). The same request fails the same way again, so it is
 * never retried automatically, and its card says so.
 */
export const GATEWAY_STREAM_GATE = 'GATEWAY_STREAM_GATE';

/**
 * dsh-rebase P1-7e (decision 140): the provider refused a request parameter
 * this model does not take (`"thinking.type.disabled" is not supported for
 * this model`). Resending changes nothing until the model's settings do.
 */
export const MODEL_SETTING_UNSUPPORTED = 'MODEL_SETTING_UNSUPPORTED';

export type DshMappedFailureCode =
  | typeof CREDENTIALS_UNAVAILABLE
  | 'PROVIDER_UNAUTHORIZED'
  | 'PROVIDER_RATE_LIMITED'
  | 'CONTEXT_TOO_LARGE'
  | typeof MODEL_NOT_CONFIGURED
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'PROVIDER_ERROR'
  | typeof TOOL_CALL_REPETITION_CODE
  | typeof GATEWAY_STREAM_GATE
  | typeof MODEL_SETTING_UNSUPPORTED;

/**
 * DSH 0.1.7-rc.2's failure codes (`LlmFailure.code` on `turn/end`): the
 * provider-neutral classes of `dsh-llm` and `dsh-llm-pi-ai`, `resolveRoute`'s
 * refusals, and the loop guard's cut. Left out on purpose, so the renderer
 * shows its generic card with DSH's own sentence: `UNKNOWN` (an error with no
 * class), `UNSUPPORTED_CONTENT` (the request carried something the route
 * cannot send; the sentence names it) and `IMAGE_OFFLOAD_REQUIRED` (DSH
 * offloads and retries by itself; it only surfaces when that failed).
 */
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
  // P1-4d1: the rest of what DSH classifies a failed request as.
  // A 400 / 413 the provider refused (native: a malformed request, not retried).
  INVALID_REQUEST: 'PROVIDER_ERROR',
  // A completed response with no content, still empty after DSH's own retries.
  EMPTY_RESPONSE: 'PROVIDER_ERROR',
  // pi-ai's catch-all, and its `pending` / `deferred` terminal states.
  PI_AI_ERROR: 'PROVIDER_ERROR',
  [TOOL_CALL_REPETITION_CODE]: TOOL_CALL_REPETITION_CODE,
};

/** Our code for a DSH failure code, or undefined for one this table does not know. */
export function mapDshFailureCode(code: unknown): DshMappedFailureCode | undefined {
  return typeof code === 'string' && Object.hasOwn(DSH_FAILURE_CODES, code)
    ? DSH_FAILURE_CODES[code]
    : undefined;
}

// Either marker alone is enough: a gateway may name only the gate or only its reason.
const STREAM_GATE_PATTERN = /\bstream_gate_precommit\b|\bprebuffer_overflow\b/i;
const MODEL_SETTING_PATTERN = /\bis not supported for this model\b/i;

/**
 * dsh-rebase P1-7e (decision 140): the two provider failures only their text
 * tells apart, whatever class DSH gave them (a 5xx is `SERVER`, a 400 is
 * `INVALID_REQUEST`, a body pi-ai could not read is `PI_AI_ERROR`). Neither
 * marker is anything DSH writes itself, so a match is the provider's own
 * account. The gate wins when a text carries both.
 */
export function classifyDshFailureText(
  text: unknown
): typeof GATEWAY_STREAM_GATE | typeof MODEL_SETTING_UNSUPPORTED | undefined {
  if (typeof text !== 'string' || text.length === 0) return undefined;
  if (STREAM_GATE_PATTERN.test(text)) return GATEWAY_STREAM_GATE;
  if (MODEL_SETTING_PATTERN.test(text)) return MODEL_SETTING_UNSUPPORTED;
  return undefined;
}

/**
 * Our code for a DSH `LlmFailure` (`{ message, code, … }`): its text first
 * (`classifyDshFailureText`), then its code (`mapDshFailureCode`). The live
 * `session.failed` and the history's failed-turn row read it alike.
 */
export function dshFailureErrorCode(failure: unknown): DshMappedFailureCode | undefined {
  const record =
    typeof failure === 'object' && failure !== null
      ? (failure as { message?: unknown; code?: unknown })
      : undefined;
  return classifyDshFailureText(record?.message) ?? mapDshFailureCode(record?.code);
}

/**
 * Whether retrying the same request cannot help, by the failure's text alone
 * (decision 140): the host's request-error hook refuses DSH's automatic retry
 * for these, whatever the route's retry policy says about their class.
 */
export function isUnretryableDshFailure(failure: unknown): boolean {
  const message =
    typeof failure === 'object' && failure !== null
      ? (failure as { message?: unknown }).message
      : undefined;
  return classifyDshFailureText(message) !== undefined;
}
