/**
 * Decision 173 (GitHub issue #9), D: the `metadata.user_id` the host's fetch
 * wrapper appends to every anthropic-messages request, so that the company
 * gateway (claude-code-hub) keeps one chat in one gateway session.
 *
 * The gateway names a Claude session after the request body's
 * `metadata.user_id` alone and never reads a header for it. Without one it
 * falls back to a hash of the first messages kept for 300 seconds, so a long
 * chat changes session every few minutes and the upstream spreads it over
 * backends whose prompt caches never meet. With one, it takes the
 * `session_id` inside as the session, renews it on every request, and passes
 * the value on unchanged.
 *
 * The value has Claude Code's own shape (2.1.78 and later), a JSON object in
 * a string:
 *   device_id     SHA-256 of DSH's anonymous install id under a domain tag,
 *                 so the raw id never leaves;
 *   account_uuid  empty, as Claude Code sends it without an account;
 *   session_id    a UUID v5 of the chat's gateway session key: the DSH
 *                 session id without the suffix a rewind or a migration
 *                 adds, so a rewound chat keeps its gateway session.
 *
 * Loaded by Node type stripping in a source checkout: erasable syntax only.
 */

import { createHash } from 'node:crypto';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** RFC 9562 §5.5: the name-based UUID (SHA-1, version 5) of `name` in `namespace`. */
export function uuidV5(namespace: string, name: string): string {
  if (!UUID_PATTERN.test(namespace)) throw new TypeError(`Not a UUID: ${namespace}`);
  const bytes = createHash('sha1')
    .update(Buffer.from(namespace.replaceAll('-', ''), 'hex'))
    .update(name, 'utf8')
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The namespace of gateway session UUIDs ({@link gatewaySessionUuid}), drawn
 * once at random. Fixed for good: another value moves every chat to a new
 * gateway session, with a cold prompt cache.
 */
export const AICLIENT_GATEWAY_SESSION_NAMESPACE = '767f5ffc-25b7-46e9-892c-9403bedca6e9';

/** `dshSessionIdFor` in src/dsh-host/bridge/dshSessionRuntime.ts: `aiclient-<logical id>`. */
const DSH_SESSION_ID_PREFIX = 'aiclient-';

/**
 * The suffix a rewind or a migration adds to `aiclient-<logical id>`, in the
 * grammar `nextSuffixNumber` (src/dsh-host/bridge/lineage.ts) reads:
 *   `_r<n>`  a rewind's new session (`rewindSessionId`, lineage.ts), n from 2;
 *   `.r<n>`  the same, in lineages written before decision 121;
 *   `_m<n>`  a migration or an import that steps past a log already under
 *            the base id (`createSession` in src/dsh-host/bridge/seedSession.ts),
 *            n from 2;
 *   `.m<n>`  read by the same rule, though never minted.
 * Both mint off the base id, never off an id that already has a suffix, so
 * there is at most one to take off.
 */
const LINEAGE_SUFFIX = /[._][rm][1-9][0-9]*$/;

/**
 * The key of a DSH session's gateway session: its id without a rewind or
 * migration suffix. Every other id keeps its own key: a fork is a chat of its
 * own (`aiclient-session-fork-<uuid>`), and so is the legacy pi row kept
 * beside a migrated chat (`aiclient-<id>_pi`, decision 051); a subagent's
 * session is a bare UUID DSH mints, not ours to shorten.
 */
export function gatewaySessionKey(dshSessionId: string): string {
  if (!dshSessionId.startsWith(DSH_SESSION_ID_PREFIX)) return dshSessionId;
  const base = dshSessionId.replace(LINEAGE_SUFFIX, '');
  return base.length > DSH_SESSION_ID_PREFIX.length ? base : dshSessionId;
}

/** The gateway session of a DSH session: one UUID per chat, the same after a rewind. */
export function gatewaySessionUuid(dshSessionId: string): string {
  return uuidV5(AICLIENT_GATEWAY_SESSION_NAMESPACE, gatewaySessionKey(dshSessionId));
}

/** 64 hex digits standing for DSH's anonymous install id, which cannot be read back from them. */
export function deviceIdFrom(anonymousId: string): string {
  return createHash('sha256').update(`aiclient-device:${anonymousId}`, 'utf8').digest('hex');
}

/** The `metadata.user_id` value, in Claude Code's JSON form and key order. */
export function claudeMetadataUserId(deviceId: string, sessionUuid: string): string {
  return JSON.stringify({ device_id: deviceId, account_uuid: '', session_id: sessionUuid });
}

/** JSON's own whitespace: space, tab, line feed, carriage return. */
function isJsonSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

/**
 * `raw`, a JSON object's text, with `"metadata":{"user_id":…}` added as its
 * last member: every byte of `raw` stays as it was, the member goes in just
 * before the closing brace. Undefined when `raw` does not start with `{` and
 * end with `}`. A body that already has `metadata` is the caller's to leave
 * alone: the text is not parsed here.
 */
export function appendMetadataUserId(raw: string, userId: string): string | undefined {
  let start = 0;
  while (start < raw.length && isJsonSpace(raw.charCodeAt(start))) start += 1;
  let end = raw.length - 1;
  while (end > start && isJsonSpace(raw.charCodeAt(end))) end -= 1;
  if (end <= start || raw[start] !== '{' || raw[end] !== '}') return undefined;
  let last = end - 1;
  while (last > start && isJsonSpace(raw.charCodeAt(last))) last -= 1;
  const separator = last === start ? '' : ',';
  const member = `"metadata":{"user_id":${JSON.stringify(userId)}}`;
  return `${raw.slice(0, end)}${separator}${member}${raw.slice(end)}`;
}

/** The request's URL, when `input` is a string, a URL or a Request without a body. */
function urlOf(input: unknown): URL | undefined {
  if (typeof input === 'string') return new URL(input);
  if (input instanceof URL) return input;
  if (typeof Request === 'function' && input instanceof Request) {
    return input.body === null ? new URL(input.url) : undefined;
  }
  return undefined;
}

/**
 * Whether a `fetch` call is an Anthropic Messages request whose body may be
 * rewritten: POST, to a path ending in `/messages` (query aside, so
 * `/v1/messages?beta=true` is one and `/v1/messages/count_tokens` is not),
 * with an `anthropic-version` header in `init.headers`, a string body in
 * `init`, and no body of a Request's own. The Anthropic SDK pi-ai uses calls
 * `fetch(url, { method: 'POST', headers: Headers, body: string })`. Never
 * throws: anything unreadable is not one.
 */
export function isAnthropicMessagesRequest(input: unknown, init: RequestInit | undefined): boolean {
  try {
    if (typeof init !== 'object' || init === null || typeof init.body !== 'string') return false;
    if (String(init.method ?? 'GET').toUpperCase() !== 'POST') return false;
    const url = urlOf(input);
    if (url === undefined || !url.pathname.endsWith('/messages')) return false;
    return init.headers !== undefined && new Headers(init.headers).has('anthropic-version');
  } catch {
    return false;
  }
}
