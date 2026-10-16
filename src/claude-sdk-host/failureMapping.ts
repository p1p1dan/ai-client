/**
 * Route B S-1 (decision 7, docs/plantree/plans/claude-sdk-engine/topics/s1-engine-selection.md
 * §1): an SDK turn's failure, mapped onto the failure codes the renderer
 * already has cards for, with a neutral sentence for the card's detail line.
 *
 * The CLI's own sentences are hints for its terminal ("Invalid API key · Fix
 * external API key", "check your inference gateway (…)"), so none is shown:
 * the sentence here is the HTTP status and, when the CLI quoted it, the
 * gateway's own message. Measured on 2.1.300 against the fake gateway's
 * `CC-ERR` marker: an HTTP failure ends the turn with a `success` result whose
 * `is_error` is true, `api_error_status` the status and `result` the CLI's
 * text (`API Error: <status> <gateway message>[. This is a server-side
 * issue …]`, or `API Error: Request rejected (429) · <message>`), after a
 * synthetic assistant message whose `error` names the class. A connection that
 * never got a response has no status and `server_error` as its class.
 *
 * Pure: the host logs the CLI's raw text itself.
 */

import type { SDKAssistantMessageError, TerminalReason } from '@anthropic-ai/claude-agent-sdk';
import { CLAUDE_ENGINE_EXITED } from '../shared/claudeSdkEngine.ts';
import { classifyDshFailureText, MODEL_NOT_CONFIGURED } from '../shared/dshFailureCodes.ts';
import { redactCredentials } from '../shared/stderrRedaction.ts';

export interface SdkFailureSignals {
  /** The turn's result message, when it ended with one (`SDKResultSuccess` with `is_error`, or `SDKResultError`). */
  result?: {
    subtype?: string;
    is_error?: boolean;
    api_error_status?: number | null;
    terminal_reason?: TerminalReason | string;
    errors?: readonly string[];
    result?: string;
  };
  /** `error` of the turn's last top-level assistant message (the CLI's synthetic API-error reply). */
  assistantError?: SDKAssistantMessageError | string;
  /** The turn's last `api_retry` (`SDKAPIRetryMessage`). */
  retry?: { error?: string; error_status?: number | null; no_response?: unknown };
  /** What `query()`'s iterator threw. */
  thrown?: string;
  /** The CLI went away mid-turn without a result. */
  cliExited?: boolean;
}

export interface SdkFailure {
  /** A code the renderer has a card for; absent means its generic card. */
  errorCode?: string;
  /** The card's detail line: never the CLI's wording, never "Claude Code". */
  error: string;
}

const AUTH_ERRORS = new Set([
  'authentication_failed',
  'oauth_org_not_allowed',
  'account_on_hold',
  'verification_required',
  'cloud_credential_error',
]);
const RATE_ERRORS = new Set(['rate_limit', 'billing_error']);
const SERVER_ERRORS = new Set(['overloaded', 'server_error']);

/** The SDK's own error when the CLI process ends (`getProcessExitError`). */
const CLI_EXIT_PATTERN = /\bprocess (?:exited with code|terminated by signal)\b/i;
const TIMEOUT_PATTERN = /\btimed out\b|\btimeout\b|\bETIMEDOUT\b|\bUND_ERR_\w*TIMEOUT\b/i;
const CONNECTION_PATTERN =
  /\b(?:ECONNREFUSED|ECONNRESET|ECONNABORTED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EPIPE)\b|\bsocket hang up\b|\bconnection (?:refused|reset|error)\b|\bunable to connect\b|\bfetch failed\b|\bcertificate\b/i;
const STATUS_PATTERNS = [/\bAPI Error: (?:Repeated )?(\d{3})\b/, /\bRequest rejected \((\d{3})\)/];
/** The gateway's message as the CLI quotes it, before the CLI's own hint. */
const GATEWAY_MESSAGE_PATTERNS = [
  /\bAPI Error: Request rejected \(\d{3}\) · ([^\n]+)/,
  /\bAPI Error: \d{3} ([^\n]+?)(?:\. This is a server-side issue\b[^\n]*)?$/m,
];
/** An error class in the CLI's trailing parentheses: `(ECONNREFUSED)`, `(DEPTH_ZERO_SELF_SIGNED_CERT)`. */
const ERROR_CLASS_PATTERN = /\(([A-Z][A-Z0-9_]{3,})\)/;
const GATEWAY_MESSAGE_MAX_CHARS = 300;

const SUBTYPE_SENTENCES: Readonly<Record<string, string>> = {
  error_max_turns: 'The turn reached its step limit',
  error_max_budget_usd: 'The turn reached its budget limit',
  error_max_structured_output_retries: 'The turn could not produce its structured output',
  error_during_execution: 'The Claude engine failed during the turn',
};

function statusOf(signals: SdkFailureSignals, texts: readonly string[]): number | undefined {
  const fromResult = signals.result?.api_error_status;
  if (typeof fromResult === 'number') return fromResult;
  for (const text of texts) {
    for (const pattern of STATUS_PATTERNS) {
      const match = pattern.exec(text);
      if (match) return Number(match[1]);
    }
  }
  // A result without a status is a request that got no HTTP response, whatever earlier attempts got.
  if (signals.result) return undefined;
  const fromRetry = signals.retry?.error_status;
  return typeof fromRetry === 'number' ? fromRetry : undefined;
}

/** `text` with each of `secrets` (the gateway key) blanked out, then the generic credential rules. */
export function redactSecrets(text: string, secrets: readonly string[] = []): string {
  let clean = text;
  for (const secret of secrets) if (secret) clean = clean.split(secret).join('[redacted]');
  return redactCredentials(clean);
}

/**
 * A line the host writes to stderr. Main forwards it to the renderer (the Host
 * stderr panel), so it gets what any UI text gets: the key and credential
 * shapes blanked out, and never the name Claude Code (plan hard constraint 4).
 */
export function sanitizeHostLogLine(text: string, secrets: readonly string[] = []): string {
  return redactSecrets(text, secrets).replace(/claude code/gi, 'Claude engine');
}

/** The gateway's own message, when the CLI quoted it: one line, redacted, never naming Claude Code. */
export function gatewayMessageOf(
  texts: readonly string[],
  secrets: readonly string[] = []
): string | undefined {
  for (const text of texts) {
    for (const pattern of GATEWAY_MESSAGE_PATTERNS) {
      const raw = pattern.exec(text)?.[1]?.replace(/\s+/g, ' ').trim();
      if (!raw || /claude code/i.test(raw)) continue;
      const clean = redactSecrets(raw, secrets);
      return clean.length > GATEWAY_MESSAGE_MAX_CHARS
        ? `${clean.slice(0, GATEWAY_MESSAGE_MAX_CHARS)}…`
        : clean;
    }
  }
  return undefined;
}

function sentenceOf(
  signals: SdkFailureSignals,
  texts: readonly string[],
  status: number | undefined,
  errorCode: string | undefined,
  secrets: readonly string[]
): string {
  if (errorCode === CLAUDE_ENGINE_EXITED) return 'The Claude engine exited';
  if (status !== undefined) {
    const message = gatewayMessageOf(texts, secrets);
    return `Upstream request failed (HTTP ${status})${message ? `: ${message}` : ''}`;
  }
  if (errorCode === 'TIMEOUT') return 'The upstream did not answer in time';
  if (errorCode === 'NETWORK_ERROR') {
    const errorClass = texts.map((text) => ERROR_CLASS_PATTERN.exec(text)?.[1]).find(Boolean);
    return `Could not reach the upstream${errorClass ? ` (${errorClass})` : ''}`;
  }
  if (errorCode === 'CONTEXT_TOO_LARGE') return 'The conversation is too large for the model';
  const subtype = signals.result?.subtype;
  if (subtype && Object.hasOwn(SUBTYPE_SENTENCES, subtype)) return SUBTYPE_SENTENCES[subtype];
  return 'The Claude engine reported an error';
}

function codeOf(
  signals: SdkFailureSignals,
  texts: readonly string[],
  status: number | undefined
): string | undefined {
  // The company gateway's own markers (stream gate, no upstream, model setting) first.
  const byText = classifyDshFailureText(texts.join('\n'));
  if (byText) return byText;
  if (signals.cliExited || texts.some((text) => CLI_EXIT_PATTERN.test(text))) {
    return CLAUDE_ENGINE_EXITED;
  }
  const kind = signals.assistantError ?? signals.retry?.error;
  if ((kind && AUTH_ERRORS.has(kind)) || status === 401 || status === 403) {
    return 'PROVIDER_UNAUTHORIZED';
  }
  if ((kind && RATE_ERRORS.has(kind)) || status === 429) return 'PROVIDER_RATE_LIMITED';
  if (kind === 'model_not_found' || status === 404) return MODEL_NOT_CONFIGURED;
  if (signals.result?.terminal_reason === 'prompt_too_long' || status === 413) {
    return 'CONTEXT_TOO_LARGE';
  }
  const noResponse = status === undefined;
  if (
    status === 408 ||
    status === 504 ||
    (noResponse &&
      (Boolean(signals.retry?.no_response) || texts.some((text) => TIMEOUT_PATTERN.test(text))))
  ) {
    return 'TIMEOUT';
  }
  if (
    noResponse &&
    (texts.some((text) => CONNECTION_PATTERN.test(text)) ||
      (signals.retry !== undefined && signals.retry.error_status === null))
  ) {
    return 'NETWORK_ERROR';
  }
  if ((kind && SERVER_ERRORS.has(kind)) || (status !== undefined && status >= 400)) {
    return 'PROVIDER_ERROR';
  }
  return undefined;
}

/**
 * The code and sentence for one failed SDK turn (decision 7's table, in its
 * order). `secrets` (the gateway key) are blanked out of any quoted text.
 */
export function mapSdkFailure(
  signals: SdkFailureSignals,
  secrets: readonly string[] = []
): SdkFailure {
  const texts = [signals.result?.result, ...(signals.result?.errors ?? []), signals.thrown].filter(
    (text): text is string => typeof text === 'string' && text.length > 0
  );
  const status = statusOf(signals, texts);
  const errorCode = codeOf(signals, texts, status);
  const error = sentenceOf(signals, texts, status, errorCode, secrets);
  return errorCode ? { errorCode, error } : { error };
}
