/** Shared Pi worker and runtime-neutral types. */

/**
 * Reasoning effort levels accepted by Pi worker bootstrap and send payloads.
 * Omit the value to inherit the model default.
 */
export const SESSION_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export type SessionEffortLevel = (typeof SESSION_EFFORT_LEVELS)[number];

/** Runtime-boundary guard for an untrusted effort value. */
export function isSessionEffortLevel(value: unknown): value is SessionEffortLevel {
  return typeof value === 'string' && (SESSION_EFFORT_LEVELS as readonly string[]).includes(value);
}

/** User-provided content attached to a Pi worker turn. */
export interface SessionAttachment {
  kind: 'image' | 'text';
  /** MIME type, e.g. image/png or text/plain. */
  mediaType: string;
  data: string;
  /** Display or document title, e.g. the pasted file name. */
  name?: string;
}

/** Runtime binary discovered for a utility worker. */
export interface NodeRuntimeInfo {
  /** Absolute path to the node binary. */
  execPath: string;
  /** Full runtime version, e.g. v24.18.0. */
  version: string;
  /** Parsed major version, e.g. 24. */
  major: number;
  source: NodeRuntimeSource;
}

export type NodeRuntimeSource = 'env' | 'nvm' | 'fnm' | 'volta' | 'path' | 'explicit' | 'bundled';

export interface NodeRuntimeResolveResult {
  ok: boolean;
  runtime?: NodeRuntimeInfo;
  error?: string;
  /** Candidates inspected for diagnostics. */
  candidates: Array<{ path: string; reason: string }>;
}
