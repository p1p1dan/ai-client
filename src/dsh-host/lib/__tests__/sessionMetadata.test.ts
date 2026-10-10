import { describe, expect, it } from 'vitest';
import { rewindSessionId } from '../../bridge/lineage.ts';
import { MIGRATION_SUFFIX_LETTER } from '../../bridge/seedSession.ts';
import type { SessionLineageEntry } from '../../bridge/stub.ts';
import {
  AICLIENT_GATEWAY_SESSION_NAMESPACE,
  appendMetadataUserId,
  claudeMetadataUserId,
  deviceIdFrom,
  gatewaySessionKey,
  gatewaySessionUuid,
  isAnthropicMessagesRequest,
  uuidV5,
} from '../sessionMetadata.ts';

/**
 * Decision 173 (GitHub issue #9), D: the `metadata.user_id` that keeps one
 * chat in one gateway session, and the requests it goes on.
 */

const DNS_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const URL_NAMESPACE = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LOGICAL = '3f2a9c1e-7d4b-4a8e-9b1c-2d3e4f5a6b7c';
const BASE = `aiclient-${LOGICAL}`;
const ANONYMOUS_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe('uuidV5', () => {
  it('matches RFC 9562 and an independent implementation', () => {
    // RFC 9562 appendix A.4.
    expect(uuidV5(DNS_NAMESPACE, 'www.example.com')).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2');
    // Python's uuid.uuid5, for the rest.
    expect(uuidV5(DNS_NAMESPACE, 'python.org')).toBe('886313e1-3b8a-5372-9b90-0c9aee199e5d');
    expect(uuidV5(URL_NAMESPACE, 'https://example.com/渠道')).toBe(
      'c54a4d92-ad23-589b-9fd0-bf7ba1f6dd3d'
    );
    expect(uuidV5(DNS_NAMESPACE.toUpperCase(), 'python.org')).toBe(
      '886313e1-3b8a-5372-9b90-0c9aee199e5d'
    );
  });

  it('refuses a namespace that is not a UUID', () => {
    for (const namespace of ['', 'dns', `${DNS_NAMESPACE}0`, DNS_NAMESPACE.replaceAll('-', '')]) {
      expect(() => uuidV5(namespace, 'x'), namespace).toThrow(TypeError);
    }
  });
});

describe('gateway session', () => {
  it('has a fixed namespace of its own', () => {
    // Another value moves every chat to a new gateway session: never change it.
    expect(AICLIENT_GATEWAY_SESSION_NAMESPACE).toBe('767f5ffc-25b7-46e9-892c-9403bedca6e9');
    expect(AICLIENT_GATEWAY_SESSION_NAMESPACE).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  it('is one UUID v5 per chat, the same every time', () => {
    const uuid = gatewaySessionUuid(BASE);
    // Python's uuid.uuid5 over the same namespace and key.
    expect(uuid).toBe('00b40e9c-ca34-5701-b180-adfcd6671c63');
    expect(uuid).toMatch(UUID);
    expect(gatewaySessionUuid(BASE)).toBe(uuid);
    const others = [
      'aiclient-9b1c2d3e-4f5a-4b7c-8d9e-0a1b2c3d4e5f',
      'aiclient-session-fork-5d7f2c1a-3b4e-4f6a-9c8d-7e6f5a4b3c2d',
      // A subagent's session, as DSH names it.
      '7c9e6679-7425-40de-944b-e07fc1f90ae7',
    ].map(gatewaySessionUuid);
    expect(new Set([uuid, ...others]).size).toBe(4);
  });

  it.each([
    ['a chat', BASE, BASE],
    ['a rewind', `${BASE}_r2`, BASE],
    ['a later rewind', `${BASE}_r17`, BASE],
    ['a rewind of a lineage written before decision 121', `${BASE}.r3`, BASE],
    ['a migration past an earlier log', `${BASE}_m2`, BASE],
    ['the legacy separator for a migration', `${BASE}.m4`, BASE],
    [
      'an import past an earlier log',
      `aiclient-session-import-codex-${LOGICAL}_m2`,
      `aiclient-session-import-codex-${LOGICAL}`,
    ],
    ['the legacy pi row of a migrated chat', `${BASE}_pi`, `${BASE}_pi`],
    ['a rewind of that row', `${BASE}_pi_r2`, `${BASE}_pi`],
    ['a migration of that row', `${BASE}_pi_m3`, `${BASE}_pi`],
    ['a fork', `aiclient-session-fork-${LOGICAL}`, `aiclient-session-fork-${LOGICAL}`],
    [
      'a rewind of a fork',
      `aiclient-session-fork-${LOGICAL}_r2`,
      `aiclient-session-fork-${LOGICAL}`,
    ],
    ['a subagent', LOGICAL, LOGICAL],
    ['a session that is not ours', 'p0-2-env_r2', 'p0-2-env_r2'],
    ['a number no rewind mints', `${BASE}_r0`, `${BASE}_r0`],
    ['a number with a leading zero', `${BASE}_r02`, `${BASE}_r02`],
    ['another letter', `${BASE}_x2`, `${BASE}_x2`],
    ['no number', `${BASE}_r`, `${BASE}_r`],
    ['nothing left but the prefix', 'aiclient-_r2', 'aiclient-_r2'],
  ])('keys %s', (_what, dshSessionId, key) => {
    expect(gatewaySessionKey(dshSessionId)).toBe(key);
  });

  it('agrees with the ids rewinds and migrations mint (lineage.ts, seedSession.ts)', () => {
    const entry = (dshSessionId: string): SessionLineageEntry => ({
      dshSessionId,
      reason: 'rewind',
      at: 0,
    });
    const minted = [
      rewindSessionId(BASE, []),
      rewindSessionId(BASE, [entry(`${BASE}_r2`)], 1),
      // A migrated chat rewinds off the base id, never off its `_m<n>` id.
      rewindSessionId(BASE, [{ ...entry(`${BASE}_m2`), reason: 'create' }]),
      rewindSessionId(BASE, [entry(`${BASE}.r5`)]),
      `${BASE}_${MIGRATION_SUFFIX_LETTER}2`,
    ];
    expect(minted).toEqual([`${BASE}_r2`, `${BASE}_r4`, `${BASE}_r2`, `${BASE}_r6`, `${BASE}_m2`]);
    for (const id of minted) expect(gatewaySessionKey(id), id).toBe(BASE);
    expect(new Set(minted.map(gatewaySessionUuid))).toEqual(new Set([gatewaySessionUuid(BASE)]));
  });
});

describe('the metadata.user_id value', () => {
  it('stands for the anonymous id with 64 hex digits, not the id itself', () => {
    const deviceId = deviceIdFrom(ANONYMOUS_ID);
    // sha256("aiclient-device:" + id), as Python's hashlib computes it.
    expect(deviceId).toBe('5ea44682e413ba06b2cdd9ef733aabad47ec434e913279a68bd5e56bfdb92770');
    expect(deviceId).toMatch(/^[0-9a-f]{64}$/);
    expect(deviceIdFrom(ANONYMOUS_ID)).toBe(deviceId);
    expect(deviceIdFrom('another-install')).not.toBe(deviceId);
  });

  it("has Claude Code's JSON form and key order", () => {
    expect(claudeMetadataUserId('d'.repeat(64), gatewaySessionUuid(BASE))).toBe(
      `{"device_id":"${'d'.repeat(64)}","account_uuid":"","session_id":"00b40e9c-ca34-5701-b180-adfcd6671c63"}`
    );
  });
});

/**
 * claude-code-hub's reading of a Claude request's session, re-implemented
 * here rather than imported (paths in that repository):
 *   - src/lib/claude-code/metadata-user-id.ts `parseClaudeMetadataUserId`: a
 *     string, trimmed, not empty; read as JSON first, where a non-array object
 *     whose `session_id` is a string not blank once trimmed gives that trimmed
 *     id (and `device_id` / `account_uuid` when they are strings); else the
 *     legacy `user_<device>_account__session_<id>`;
 *   - same file, `hasUsableClaudeMetadataUserId` (applied by
 *     `injectClaudeMetadataUserIdWithContext` and the forwarder): a string
 *     not blank once trimmed is left as the client sent it;
 *   - src/lib/session-manager.ts `extractClientSessionId`: the request's
 *     `metadata` must be an object, its `user_id` read as above (a request
 *     with an `input` array is Codex's and read otherwise); a session id found
 *     there is used as it stands by `getOrCreateSessionId`, no hash fallback;
 *   - src/lib/request-identity.ts `buildPublicSessionIdentity`: an id
 *     starting `pfx:` or `sid:` is replaced by a key-bound digest;
 *   - src/drizzle/schema.ts: `session_id` and `session_identity` are
 *     varchar(64).
 */
const LEGACY_USER_ID = /^user_(.+?)_account__session_(.+)$/;

function gatewayParse(userId: unknown) {
  const none = { sessionId: null, format: null, deviceId: null, accountUuid: null };
  if (typeof userId !== 'string' || userId.trim() === '') return none;
  const trimmed = userId.trim();
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const sessionId = typeof record.session_id === 'string' ? record.session_id.trim() : null;
      if (sessionId) {
        return {
          sessionId,
          format: 'json',
          deviceId: typeof record.device_id === 'string' ? record.device_id : null,
          accountUuid: typeof record.account_uuid === 'string' ? record.account_uuid : null,
        };
      }
    }
  } catch {
    // Not JSON: the legacy form below.
  }
  const legacy = LEGACY_USER_ID.exec(trimmed);
  const sessionId = legacy?.[2]?.trim();
  if (!sessionId) return none;
  return { sessionId, format: 'legacy', deviceId: legacy?.[1] || null, accountUuid: null };
}

function gatewayClientSessionId(body: Record<string, unknown>): string | null {
  if (Array.isArray(body.input)) return null;
  const metadata = body.metadata;
  if (typeof metadata !== 'object' || metadata === null) return null;
  const record = metadata as Record<string, unknown>;
  const fromUserId = gatewayParse(record.user_id).sessionId;
  if (fromUserId) return fromUserId;
  return typeof record.session_id === 'string' && record.session_id.length > 0
    ? record.session_id
    : null;
}

describe("the gateway's reading (claude-code-hub contract)", () => {
  const deviceId = deviceIdFrom(ANONYMOUS_ID);

  it.each([
    ['a chat', BASE],
    ['a fork', `aiclient-session-fork-${LOGICAL}`],
    ['a subagent', '7c9e6679-7425-40de-944b-e07fc1f90ae7'],
  ])('takes the session of %s as it is sent', (_what, dshSessionId) => {
    const sessionUuid = gatewaySessionUuid(dshSessionId);
    const userId = claudeMetadataUserId(deviceId, sessionUuid);
    expect(gatewayParse(userId)).toEqual({
      sessionId: sessionUuid,
      format: 'json',
      deviceId,
      accountUuid: '',
    });
    // Kept as sent: never replaced by the gateway's own value.
    expect(userId.trim()).toBe(userId);
    expect(userId.trim()).not.toBe('');
    // Stored and shown as it is: no reserved prefix, and it fits the columns.
    expect(sessionUuid.trim()).toBe(sessionUuid);
    expect(sessionUuid.startsWith('pfx:')).toBe(false);
    expect(sessionUuid.startsWith('sid:')).toBe(false);
    expect(sessionUuid.length).toBeLessThanOrEqual(64);
    expect(sessionUuid).toMatch(UUID);
  });

  it('finds the session in a request body the wrapper wrote', () => {
    const sessionUuid = gatewaySessionUuid(`${BASE}_r3`);
    const raw = JSON.stringify({ model: 'claude-opus-5-5', messages: [], stream: true });
    const body = appendMetadataUserId(raw, claudeMetadataUserId(deviceId, sessionUuid));
    expect(gatewayClientSessionId(JSON.parse(String(body)))).toBe(gatewaySessionUuid(BASE));
    // Without it the gateway has nothing to go on (and falls back to a hash).
    expect(gatewayClientSessionId(JSON.parse(raw))).toBeNull();
  });
});

describe('appendMetadataUserId', () => {
  const userId = claudeMetadataUserId(deviceIdFrom(ANONYMOUS_ID), gatewaySessionUuid(BASE));

  it('adds metadata as the last member and leaves every byte before it', () => {
    const value = {
      model: 'claude-opus-5-5',
      messages: [{ role: 'user', content: 'Say "}" and \\ then 渠道.' }],
      system: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral' } }],
      stream: true,
      nested: {},
    };
    const raw = JSON.stringify(value);
    const result = appendMetadataUserId(raw, userId);
    expect(result).toBeDefined();
    const text = String(result);
    expect(text.startsWith(raw.slice(0, -1))).toBe(true);
    expect(text.endsWith('}')).toBe(true);
    expect(JSON.parse(text)).toEqual({ ...JSON.parse(raw), metadata: { user_id: userId } });
    expect(Object.keys(JSON.parse(text)).at(-1)).toBe('metadata');
    expect(text.slice(raw.length - 1)).toBe(`,"metadata":{"user_id":${JSON.stringify(userId)}}}`);
  });

  it('adds no comma to an empty object, and keeps whitespace where it was', () => {
    expect(appendMetadataUserId('{}', 'u')).toBe('{"metadata":{"user_id":"u"}}');
    expect(appendMetadataUserId(' { \n} \n', 'u')).toBe(' { \n"metadata":{"user_id":"u"}} \n');
    expect(JSON.parse(String(appendMetadataUserId('{ "a" : 1 }\n', 'u')))).toEqual({
      a: 1,
      metadata: { user_id: 'u' },
    });
  });

  it('refuses text that is not an object', () => {
    for (const raw of ['', '   ', '[]', '"x"', '1', 'null', '}', '{', '{"a":1', '[{}]', 'x}']) {
      expect(appendMetadataUserId(raw, userId), raw).toBeUndefined();
    }
  });
});

describe('isAnthropicMessagesRequest', () => {
  const MESSAGES = 'https://gw.example.test/v1/messages';
  /** The call the Anthropic SDK in pi-ai makes for a stream. */
  const sdkInit = (): RequestInit => ({
    method: 'POST',
    headers: new Headers({
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    }),
    body: '{"model":"claude-opus-5-5","messages":[]}',
  });

  it('takes the SDK call, in every shape of URL and headers', () => {
    expect(isAnthropicMessagesRequest(MESSAGES, sdkInit())).toBe(true);
    expect(isAnthropicMessagesRequest(`${MESSAGES}?beta=true`, sdkInit())).toBe(true);
    expect(isAnthropicMessagesRequest(new URL(`${MESSAGES}?beta=true`), sdkInit())).toBe(true);
    expect(isAnthropicMessagesRequest(new Request(MESSAGES), sdkInit())).toBe(true);
    expect(
      isAnthropicMessagesRequest('https://gw.example.test/anthropic/v1/messages', sdkInit())
    ).toBe(true);
    expect(isAnthropicMessagesRequest(MESSAGES, { ...sdkInit(), method: 'post' })).toBe(true);
    for (const headers of [
      { 'Anthropic-Version': '2023-06-01' },
      [['ANTHROPIC-VERSION', '2023-06-01']] as [string, string][],
    ]) {
      expect(isAnthropicMessagesRequest(MESSAGES, { ...sdkInit(), headers })).toBe(true);
    }
  });

  it.each([
    ['a GET', MESSAGES, { ...sdkInit(), method: 'GET' }],
    ['no method (GET)', MESSAGES, { ...sdkInit(), method: undefined }],
    ['another API', 'https://gw.example.test/v1/chat/completions', sdkInit()],
    ['token counting', 'https://gw.example.test/v1/messages/count_tokens?beta=true', sdkInit()],
    ['a trailing slash', 'https://gw.example.test/v1/messages/', sdkInit()],
    ['no anthropic-version', MESSAGES, { ...sdkInit(), headers: { 'x-api-key': 'k' } }],
    ['no headers', MESSAGES, { ...sdkInit(), headers: undefined }],
    ['a byte body', MESSAGES, { ...sdkInit(), body: new TextEncoder().encode('{}') }],
    ['no body', MESSAGES, { ...sdkInit(), body: undefined }],
    ['no init', MESSAGES, undefined],
    ['a relative URL', '/v1/messages', sdkInit()],
    ['an unreadable URL', 'not a url', sdkInit()],
    ['an object for a URL', { href: MESSAGES }, sdkInit()],
    ['headers Fetch refuses', MESSAGES, { ...sdkInit(), headers: { 'bad name': 'v' } }],
  ])('refuses %s', (_what, input, init) => {
    expect(isAnthropicMessagesRequest(input, init as RequestInit | undefined)).toBe(false);
  });

  it('refuses a Request that carries its own body', () => {
    const request = new Request(MESSAGES, { method: 'POST', body: '{}' });
    expect(isAnthropicMessagesRequest(request, sdkInit())).toBe(false);
  });

  it('never throws', () => {
    const init = sdkInit();
    Object.defineProperty(init, 'method', {
      get() {
        throw new Error('boom');
      },
    });
    expect(isAnthropicMessagesRequest(MESSAGES, init)).toBe(false);
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(isAnthropicMessagesRequest(revoked.proxy, sdkInit())).toBe(false);
    expect(isAnthropicMessagesRequest(MESSAGES, revoked.proxy as RequestInit)).toBe(false);
  });
});
