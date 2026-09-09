/**
 * Provider/model error classification.
 *
 * Ported from PI-Desktop `packages/agent-runtime/src/agent-errors.ts`
 * (`948ee676`). pi-ai folds provider failures into `errorMessage` strings
 * (usually "<status>: <body>") and SDK error objects carry the HTTP status
 * under shape-specific fields, so classification probes structured fields
 * first and falls back to message keywords.
 *
 * The retry layer is the only consumer: the code decides whether a failure may
 * claim a retry budget, and which budget.
 */

export interface ClassifiedProviderError {
  code: string;
  message: string;
  retriable: boolean;
  /** Safe, low-cardinality diagnostics for the trace. */
  details?: Record<string, unknown>;
}

/** Keep trace rows small; provider bodies can be huge. */
const MAX_ERROR_MESSAGE_CHARS = 600;

const NETWORK_PATTERN =
  /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|ENETUNREACH|EHOSTUNREACH|UND_ERR|fetch failed|socket hang up|network error|connection error|connection refused|dns/i;

const CONTEXT_PATTERN =
  /context[ _-]?length|maximum context|context window|too many tokens|prompt is too long|input token count|exceeds the (?:maximum|model)|token limit/i;

const STREAM_TERMINATION_PATTERN =
  /\bterminated\b|stream ended without finish_reason|premature(?:ly)?\s+(?:closed|ended)|(?:stream|response).*(?:closed|interrupted)/i;

// Provider bodies get pasted into the trace, so control characters are
// exactly what this pattern is for.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function redactSensitiveErrorText(message: string): string {
  return message
    .replace(/(["']?authorization["']?\s*[:=]\s*["']?\s*bearer\s+)[^\s,"'}]+/gi, '$1[REDACTED]')
    .replace(
      /(["']?(?:api[_-]?key|access[_-]?token|password)["']?\s*[:=]\s*["']?)[^"',}\s]+/gi,
      '$1[REDACTED]'
    )
    .replace(CONTROL_CHARACTERS, '');
}

interface ErrorLike {
  status?: unknown;
  statusCode?: unknown;
  code?: unknown;
  cause?: unknown;
  message?: unknown;
}

function asErrorLike(value: unknown): ErrorLike | undefined {
  return typeof value === 'object' && value !== null ? (value as ErrorLike) : undefined;
}

/**
 * Probe the HTTP status across SDK error shapes: `status` / `statusCode`
 * fields (walking the `cause` chain), then a leading "<status>:" or a
 * "(status)" / "status code NNN" marker in the message.
 */
function extractStatus(error: unknown, message: string): number | undefined {
  let current = asErrorLike(error);
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (typeof current.statusCode === 'number') return current.statusCode;
    if (typeof current.status === 'number') return current.status;
    current = asErrorLike(current.cause);
  }
  const patterns = [
    /^\s*(\d{3})\s*:/,
    /^\s*(\d{3})\b/,
    /\((\d{3})\)/,
    /status(?: code)?[ :]+(\d{3})\b/i,
  ];
  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match) {
      const status = Number(match[1]);
      if (status >= 400 && status < 600) return status;
    }
  }
  return undefined;
}

function hasNetworkCause(error: unknown, message: string): boolean {
  if (NETWORK_PATTERN.test(message)) return true;
  let current = asErrorLike(error);
  for (let depth = 0; depth < 4 && current; depth += 1) {
    const code = typeof current.code === 'string' ? current.code : '';
    const nested = typeof current.message === 'string' ? current.message : '';
    if (NETWORK_PATTERN.test(code) || NETWORK_PATTERN.test(nested)) return true;
    current = asErrorLike(current.cause);
  }
  return false;
}

function extractErrorCode(error: unknown): string | number | undefined {
  let current = asErrorLike(error);
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (typeof current.code === 'number') {
      return Number.isSafeInteger(current.code) ? current.code : undefined;
    }
    if (typeof current.code === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(current.code)) {
      return current.code;
    }
    current = asErrorLike(current.cause);
  }
  return undefined;
}

export function classifyProviderFailure(error: unknown): ClassifiedProviderError {
  const rawMessage =
    typeof error === 'string' ? error : error instanceof Error ? error.message : String(error);
  const safeMessage = redactSensitiveErrorText(rawMessage);
  const message =
    safeMessage.length > MAX_ERROR_MESSAGE_CHARS
      ? `${safeMessage.slice(0, MAX_ERROR_MESSAGE_CHARS)}…`
      : safeMessage;
  const status = extractStatus(error, rawMessage);
  const providerCode = extractErrorCode(error);
  const details = {
    ...(status !== undefined ? { providerStatus: status } : {}),
    ...(providerCode !== undefined ? { providerCode } : {}),
  };
  const result = (code: string, retriable: boolean): ClassifiedProviderError => ({
    code,
    message,
    retriable,
    ...(Object.keys(details).length > 0 ? { details } : {}),
  });

  if ((error instanceof Error && error.name === 'AbortError') || /\babort/i.test(rawMessage)) {
    return result('TURN_ABORTED', false);
  }
  // Network failures never carry an HTTP status; probe before the status logic
  // so a "fetch failed" cause does not fall through to the generic bucket.
  if (hasNetworkCause(error, rawMessage)) return result('NETWORK_ERROR', true);

  if (status !== undefined) {
    if (status === 401 || status === 403) return result('PROVIDER_UNAUTHORIZED', false);
    if (status === 408) return result('TIMEOUT', true);
    if (status === 413) return result('CONTEXT_TOO_LARGE', false);
    if (status === 429) return result('PROVIDER_RATE_LIMITED', true);
    if (status === 404) return result('MODEL_NOT_CONFIGURED', false);
    if (status >= 500) return result('PROVIDER_ERROR', true);
    if (status === 400 || status === 422) {
      if (CONTEXT_PATTERN.test(rawMessage)) return result('CONTEXT_TOO_LARGE', false);
      // Malformed request (wrong api style, bad params) — resending will not help.
      return result('PROVIDER_ERROR', false);
    }
    return result('PROVIDER_ERROR', true);
  }

  if (
    /invalid[ _]api[ _]key|api key not valid|unauthorized|authentication|permission denied/i.test(
      rawMessage
    )
  ) {
    return result('PROVIDER_UNAUTHORIZED', false);
  }
  if (/rate.?limit|too many requests|quota|overloaded/i.test(rawMessage)) {
    return result('PROVIDER_RATE_LIMITED', true);
  }
  if (CONTEXT_PATTERN.test(rawMessage)) return result('CONTEXT_TOO_LARGE', false);
  if (/model.{0,20}(not found|does not exist|unknown)|unknown model/i.test(rawMessage)) {
    return result('MODEL_NOT_CONFIGURED', false);
  }
  if (/timeout|timed out/i.test(rawMessage)) return result('TIMEOUT', true);
  if (STREAM_TERMINATION_PATTERN.test(rawMessage) || /stream/i.test(rawMessage)) {
    return result('STREAM_FAILED', true);
  }
  return result('PROVIDER_ERROR', true);
}
