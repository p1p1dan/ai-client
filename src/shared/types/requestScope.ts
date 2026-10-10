/**
 * Decision 173 (GitHub issue #9): what the host's fetch wrapper knows about a
 * model request, and what it found out.
 *
 * The company gateway (claude-code-hub) names a Claude session after the
 * request body's `metadata.user_id` alone; without one it falls back to a
 * short-lived hash, and the upstream spreads one conversation over backends
 * whose prompt caches never meet. So the wrapper appends a stable
 * `metadata.user_id` per chat to every anthropic-messages request
 * (`src/dsh-host/lib/sessionMetadata.ts`), and compares each request's prefix
 * with the previous request of the same session
 * (`src/dsh-host/lib/requestPrefix.ts`), so that a request which does not
 * merely extend the previous one is logged.
 *
 * Every part has an emergency switch: its environment variable set to `0`
 * turns it off ({@link isSwitchedOff}).
 *
 * No imports: the host bundle takes this file in (`HOST_INPUTS` in
 * `scripts/dsh-host-build-lib.mjs`), so it must not pull anything with it.
 */

/** The Cordis service the request scope is offered under. */
export const REQUEST_SCOPE_SERVICE = 'aiclientRequestScope';

/** `0`: no prefix comparison and no divergence log line. */
export const PREFIX_WATCH_ENV = 'AICLIENT_RUNTIME_PREFIX_WATCH';
/** `0`: no `metadata.user_id` is appended. */
export const SESSION_METADATA_ENV = 'AICLIENT_RUNTIME_SESSION_METADATA';
/** `0`: no per-step cache chain check. */
export const CACHE_CHAIN_ENV = 'AICLIENT_RUNTIME_CACHE_CHAIN';

/** Whether `env` turns the switch `name` off: on unless set to `0`. */
export function isSwitchedOff(
  env: Readonly<Record<string, string | undefined>>,
  name: string
): boolean {
  return env[name]?.trim() === '0';
}

/**
 * Why a model request is made: a step of the agent loop, a compaction
 * summary, a session title, or a one-shot completion.
 */
export type RequestPurpose = 'agent' | 'compaction' | 'session-title' | 'oneshot';

/** What a request's async context says about it. */
export interface RequestScopeStore {
  /** The DSH session the request is made for; absent when it serves none. */
  readonly sessionId?: string;
  readonly purpose: RequestPurpose;
}

/**
 * How a request's prefix relates to the previous request of the same session,
 * cache markers aside:
 *
 *   first     no earlier request of the session was seen;
 *   same      the previous request again;
 *   append    the previous request with `added` messages after it, so a
 *             prompt cache can serve everything before them;
 *   diverged  something before the end changed, reported at the first of
 *             `config` (a top-level field or the beta list, named in
 *             `field`), `tools` (the first differing tool, `index`), `system`,
 *             or `messages` (the first differing message, `index`, and its
 *             `role`). `truncated`: the messages are the previous ones cut
 *             short and nothing else. `prevMessages` and `messages` count both
 *             requests' messages.
 */
export type ClientPrefixVerdict =
  | { kind: 'first' }
  | { kind: 'same' }
  | { kind: 'append'; added: number }
  | {
      kind: 'diverged';
      at: 'config' | 'tools' | 'system' | 'messages';
      field?: string;
      index?: number;
      role?: string;
      truncated: boolean;
      prevMessages: number;
      messages: number;
    };

/** A verdict, with the request it was given on. */
export interface ClientPrefixEvidence {
  readonly verdict: ClientPrefixVerdict;
  /** The request's number among the session's requests the wrapper saw, from 1. */
  readonly requestSeq: number;
  /** When the request was seen, in epoch milliseconds. */
  readonly at: number;
}

/** What the rest of the host may read of the request scope. */
export interface RequestScopeView {
  /** The latest evidence on `dshSessionId`'s requests; undefined when none was seen. */
  evidenceFor(dshSessionId: string): ClientPrefixEvidence | undefined;
}
