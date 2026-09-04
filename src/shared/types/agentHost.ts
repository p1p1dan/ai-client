/** Shared Pi worker and runtime-neutral types. */

/**
 * Thinking levels accepted by Pi worker bootstrap and send payloads.
 *
 * This is Pi's `ThinkingLevel` vocabulary verbatim, in Pi's own ascending order
 * (`THINKING_LEVEL_OPTIONS` in `@earendil-works/pi-coding-agent`). The five
 * middle words are also the Claude Agent SDK's `EffortLevel`, which is why the
 * name kept saying "effort" — but `off` and `minimal` exist only in Pi, so
 * treating this union as the Claude one silently drops two real levels (U08-2).
 *
 * `off` is a LEVEL, not the absence of one. Omitting the field entirely means
 * "let Pi apply its own default" (`DEFAULT_THINKING_LEVEL`, currently `medium`);
 * sending `off` pins reasoning off. The two must never collapse into each other
 * — see `EFFORT_DEFAULT_ID` in `renderer/components/chat/efforts.ts` for the UI
 * side of the same distinction.
 */
export const SESSION_EFFORT_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export type SessionEffortLevel = (typeof SESSION_EFFORT_LEVELS)[number];

/**
 * Runtime-boundary guard for an untrusted effort value.
 *
 * Every layer that validates or narrows an effort value must call this rather
 * than spelling the words out again: the five-word copies this replaced are how
 * `off`/`minimal` reached a boundary and were rejected or cast away.
 */
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
