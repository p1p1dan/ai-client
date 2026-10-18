import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  PREFIX_WATCH_ENV,
  RESPONSES_CACHE_WATCH_ENV,
  type RequestScopeStore,
  SESSION_METADATA_ENV,
  USER_CONTENT_BLOCKS_ENV,
} from '../../../shared/types/requestScope.ts';
import { RequestScope } from '../requestScope.ts';
import {
  describeRequestTap,
  installRequestTap,
  REQUEST_TAP_LIMITS,
  type RequestTapDeps,
} from '../requestTap.ts';
import { claudeMetadataUserId, deviceIdFrom, gatewaySessionUuid } from '../sessionMetadata.ts';
import { installUserAgentRelay } from '../userAgentRelay.ts';

/**
 * Decision 173 (GitHub issue #9): the request tap appends a chat's gateway
 * session to its anthropic-messages requests (D) and watches whether each
 * request only extends the previous one (B1); every other request, and every
 * request it cannot read, goes out exactly as it came. Decision 182 (U): first
 * it sends every user message's string content as a text block. The bodies
 * are shaped the way pi-ai builds them, and the calls the way the Anthropic
 * SDK makes them: `fetch(url, { signal, method: 'POST', headers: Headers,
 * body })`. TURN and STEP have their user text in blocks already, as U sends
 * it, so that the D and B1 cases see their bodies byte for byte; PI_TURN and
 * PI_STEP are the same messages as pi-ai gives them.
 */

const DEVICE = deviceIdFrom('0f8fad5b-d9cb-469f-a165-70867728950e');
const SESSION = 'aiclient-3f2a9c1e-7d4b-4a8e-9b1c-2d3e4f5a6b7c';
const FORK = 'aiclient-session-fork-5d7f2c1a-3b4e-4f6a-9c8d-7e6f5a4b3c2d';
const MESSAGES_URL = 'https://gw.example.test/v1/messages?beta=true';
const USER_ID = claudeMetadataUserId(DEVICE, gatewaySessionUuid(SESSION));
/** What D adds to the end of a body: the member, then the body's own closing brace. */
const METADATA_TAIL = `,"metadata":{"user_id":${JSON.stringify(USER_ID)}}}`;
const MARK = { type: 'ephemeral', ttl: '1h' };

type Message = { role: string; content: unknown };

/** A request body in pi-ai's shape and key order. */
function requestBody(messages: readonly Message[], overrides: Record<string, unknown> = {}) {
  return {
    model: 'claude-opus-5-5',
    messages,
    max_tokens: 128_000,
    stream: true,
    system: [{ type: 'text', text: 'You are a coding agent.', cache_control: MARK }],
    tools: [{ name: 'read', description: 'Read a file.', input_schema: { type: 'object' } }],
    thinking: { type: 'adaptive', display: 'summarized' },
    ...overrides,
  };
}

const README_TEXT = 'Read the README: say "}" and \\ then 渠道.';
const TESTS_TEXT = 'Now run the tests.';
const text = (value: string) => [{ type: 'text', text: value }];

const TURN: readonly Message[] = [
  { role: 'user', content: text(README_TEXT) },
  {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'Look first.', signature: 'c2lnLTE=' },
      { type: 'tool_use', id: 'toolu_1', name: 'read', input: { path: 'README.md' } },
    ],
  },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Hello.' }] },
];
const STEP: readonly Message[] = [
  { role: 'assistant', content: [{ type: 'text', text: 'It says hello.' }] },
  { role: 'user', content: text(TESTS_TEXT) },
];
/** TURN and STEP as pi-ai gives them: a user message's text a plain string. */
const PI_TURN: readonly Message[] = [{ role: 'user', content: README_TEXT }, ...TURN.slice(1)];
const PI_STEP: readonly Message[] = [STEP[0] as Message, { role: 'user', content: TESTS_TEXT }];

/** The init the Anthropic SDK hands fetch. */
function sdkInit(body: string, headers: Record<string, string> = {}): RequestInit {
  return {
    signal: new AbortController().signal,
    method: 'POST',
    headers: new Headers({
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'fine-grained-tool-streaming-2025-05-14',
      'content-type': 'application/json',
      ...headers,
    }),
    body,
  };
}

const agent = (sessionId = SESSION): RequestScopeStore => ({ sessionId, purpose: 'agent' });

interface SetupOptions {
  env?: Record<string, string>;
  deviceId?: RequestTapDeps['deviceId'];
  limits?: RequestTapDeps['limits'];
  deps?: Partial<RequestTapDeps>;
}

function setup(options: SetupOptions = {}) {
  const scope = new RequestScope();
  const calls: Array<{ input: unknown; init: RequestInit | undefined }> = [];
  const target = {
    fetch: (async (input: unknown, init?: RequestInit) => {
      calls.push({ input, init });
      return new Response('ok');
    }) as typeof globalThis.fetch,
  };
  const base = target.fetch;
  const queue: Array<() => void> = [];
  const lines: string[] = [];
  const warnings: Array<{ key: string; line: string }> = [];
  const deviceId = vi.fn(options.deviceId ?? (async () => DEVICE));
  const clock = { now: 1_760_000_000_000 };
  const status = installRequestTap(target, {
    scope,
    env: options.env ?? {},
    deviceId,
    log: (line) => lines.push(line),
    warnOnce: (key, line) => warnings.push({ key, line }),
    schedule: (fn) => queue.push(fn),
    now: () => clock.now,
    limits: options.limits,
    ...options.deps,
  });
  /** Runs what the tap left for after the request. */
  const settle = () => {
    while (queue.length > 0) queue.shift()?.();
  };
  /**
   * One SDK call to the Messages API inside `store` (none for `null`); done
   * once fetch was called and the tap's work after it ran.
   */
  async function send(
    body: unknown,
    how: { store?: RequestScopeStore | null; headers?: Record<string, string> } = {}
  ) {
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    const init = sdkInit(raw, how.headers);
    const call = () => target.fetch(MESSAGES_URL, init);
    const store = how.store === undefined ? agent() : how.store;
    await (store === null ? call() : scope.run(store, call));
    settle();
    return { init, raw, sent: calls.at(-1) };
  }
  return {
    scope,
    target,
    base,
    calls,
    queue,
    settle,
    lines,
    warnings,
    deviceId,
    clock,
    status,
    send,
  };
}

const keysOf = (warnings: ReadonlyArray<{ key: string }>) => warnings.map(({ key }) => key);

describe('installRequestTap', () => {
  it('wraps fetch once, and not at all with every part switched off', () => {
    const h = setup();
    expect(h.status).toEqual({
      installed: true,
      sessionMetadata: true,
      prefixWatch: true,
      userContentBlocks: true,
      responsesWatch: true,
    });
    expect(h.target.fetch).not.toBe(h.base);
    const tapped = h.target.fetch;
    const deps: RequestTapDeps = {
      scope: h.scope,
      env: {},
      deviceId: async () => DEVICE,
      log: () => {},
      warnOnce: () => {},
    };
    expect(installRequestTap(h.target, deps).installed).toBe(false);
    expect(h.target.fetch).toBe(tapped);
    const off = setup({
      env: { [SESSION_METADATA_ENV]: '0', [PREFIX_WATCH_ENV]: '0', [USER_CONTENT_BLOCKS_ENV]: '0' },
    });
    expect(off.status).toEqual({
      installed: false,
      sessionMetadata: false,
      prefixWatch: false,
      userContentBlocks: false,
      responsesWatch: true,
    });
    expect(off.target.fetch).toBe(off.base);
    // Any one part on is enough to wrap it.
    const blocksOnly = setup({ env: { [SESSION_METADATA_ENV]: '0', [PREFIX_WATCH_ENV]: '0' } });
    expect(blocksOnly.status.installed).toBe(true);
    const missing = { fetch: undefined as unknown as typeof globalThis.fetch };
    expect(installRequestTap(missing, deps).installed).toBe(false);
  });

  it('asks for no device id before a request needs one', async () => {
    const h = setup();
    expect(h.deviceId).not.toHaveBeenCalled();
    await h.send(requestBody(TURN), { store: { purpose: 'oneshot' } });
    expect(h.deviceId).not.toHaveBeenCalled();
  });

  it('says how it started', () => {
    const on = {
      sessionMetadata: true,
      prefixWatch: true,
      userContentBlocks: true,
      responsesWatch: true,
    };
    const off = {
      sessionMetadata: false,
      prefixWatch: false,
      userContentBlocks: false,
      responsesWatch: true,
    };
    expect(describeRequestTap({ installed: true, ...on })).toBe(
      'request tap: session metadata on, prefix watch on, user content blocks on'
    );
    expect(describeRequestTap({ installed: true, ...on, sessionMetadata: false })).toBe(
      'request tap: session metadata off, prefix watch on, user content blocks on'
    );
    expect(describeRequestTap({ installed: true, ...off, userContentBlocks: true })).toBe(
      'request tap: session metadata off, prefix watch off, user content blocks on'
    );
    expect(describeRequestTap({ installed: false, ...off })).toBe(
      'request tap: session metadata off, prefix watch off, user content blocks off'
    );
    expect(describeRequestTap({ installed: false, ...off, userContentBlocks: true })).toBe(
      'request tap: not installed (no fetch to wrap, or it is wrapped already)'
    );
    // Decision 193 §9: said only when it leaves Responses requests out.
    expect(describeRequestTap({ installed: true, ...on, responsesWatch: false })).toBe(
      'request tap: session metadata on, prefix watch on, user content blocks on, openai-responses watch off'
    );
    expect(describeRequestTap({ installed: true, ...off, responsesWatch: false })).toBe(
      'request tap: session metadata off, prefix watch off, user content blocks off'
    );
  });
});

describe('what the tap leaves alone', () => {
  it("passes every call but a session's Messages request on with its own arguments", async () => {
    const h = setup();
    const raw = JSON.stringify(requestBody(TURN));
    const cases: Array<[string, RequestInit | undefined, RequestScopeStore | undefined]> = [
      ['https://gw.example.test/v1/chat/completions', sdkInit(raw), agent()],
      ['https://gw.example.test/v1/messages/count_tokens?beta=true', sdkInit(raw), agent()],
      [MESSAGES_URL, { ...sdkInit(raw), method: 'GET' }, agent()],
      [MESSAGES_URL, { ...sdkInit(raw), headers: { 'content-type': 'application/json' } }, agent()],
      [MESSAGES_URL, { ...sdkInit(raw), body: new TextEncoder().encode(raw) }, agent()],
      [MESSAGES_URL, undefined, agent()],
      // A one-shot completion, and a store without a session.
      [MESSAGES_URL, sdkInit(raw), { purpose: 'oneshot' }],
      [MESSAGES_URL, sdkInit(raw), { purpose: 'compaction' }],
      // An MCP server's call, outside every scope.
      ['https://mcp.example.test/rpc', { method: 'POST', body: '{}' }, undefined],
    ];
    for (const [input, init, store] of cases) {
      const call = () => h.target.fetch(input, init);
      await (store === undefined ? call() : h.scope.run(store, call));
      expect(h.calls.at(-1)?.input, input).toBe(input);
      expect(h.calls.at(-1)?.init, input).toBe(init);
    }
    expect(h.calls).toHaveLength(cases.length);
    expect(h.queue).toEqual([]);
    expect(h.warnings).toEqual([]);
    expect(h.deviceId).not.toHaveBeenCalled();
  });

  it('sends a Messages request made outside every scope as it came, and says so', async () => {
    const h = setup();
    const { init, sent } = await h.send(requestBody(TURN), { store: null });
    expect(sent?.init).toBe(init);
    expect(h.warnings).toEqual([
      {
        key: 'no-scope',
        line: 'request tap: a model request ran outside every request scope; it went without session metadata or prefix watch',
      },
    ]);
    expect(h.queue).toEqual([]);
  });
});

describe('D: session metadata', () => {
  it('appends metadata.user_id to a body without metadata, every other byte as it was', async () => {
    const h = setup();
    const { init, raw, sent } = await h.send(requestBody(TURN));
    const body = String(sent?.init?.body);
    expect(body).toBe(`${raw.slice(0, -1)}${METADATA_TAIL}`);
    expect(JSON.parse(body)).toEqual({ ...JSON.parse(raw), metadata: { user_id: USER_ID } });
    // Everything else of the call is the caller's, and the caller's init is left alone.
    expect(sent?.input).toBe(MESSAGES_URL);
    expect(sent?.init).not.toBe(init);
    expect(sent?.init?.headers).toBe(init.headers);
    expect(sent?.init?.signal).toBe(init.signal);
    expect(sent?.init?.method).toBe('POST');
    expect(init.body).toBe(raw);
    expect(h.deviceId).toHaveBeenCalledTimes(1);
    expect(h.warnings).toEqual([]);
  });

  it('gives a rewound chat and its auxiliary requests one gateway session, and a fork its own', async () => {
    const h = setup();
    const userIdOf = async (store: RequestScopeStore) => {
      const { sent } = await h.send(requestBody(TURN), { store });
      return JSON.parse(String(sent?.init?.body)).metadata.user_id as string;
    };
    expect(await userIdOf(agent())).toBe(USER_ID);
    expect(await userIdOf(agent(`${SESSION}_r2`))).toBe(USER_ID);
    expect(await userIdOf({ sessionId: SESSION, purpose: 'compaction' })).toBe(USER_ID);
    expect(await userIdOf({ sessionId: SESSION, purpose: 'session-title' })).toBe(USER_ID);
    expect(await userIdOf(agent(FORK))).toBe(
      claudeMetadataUserId(DEVICE, gatewaySessionUuid(FORK))
    );
    expect(h.deviceId).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a user_id', { user_id: 'user_theirs_account__session_x' }],
    ['no user_id', { session_id: 'theirs' }],
    ['nothing in it', {}],
    ['null for it', null],
  ])('never touches a metadata with %s', async (_what, metadata) => {
    const h = setup();
    const { init, sent } = await h.send(requestBody(TURN, { metadata }));
    expect(sent?.init).toBe(init);
    expect(h.deviceId).not.toHaveBeenCalled();
  });

  it('leaves a body that is no Messages request alone', async () => {
    const h = setup();
    for (const body of [{ messages: [] }, { model: 'm' }, { model: 'm', messages: 'x' }, [1], 42]) {
      const { init, sent } = await h.send(body);
      expect(sent?.init, JSON.stringify(body)).toBe(init);
    }
    expect(h.deviceId).not.toHaveBeenCalled();
  });

  it('holds the first requests until the device id is known, and no request after', async () => {
    let release: (id: string) => void = () => {};
    const h = setup({
      deviceId: () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    });
    const send = () =>
      h.scope.run(agent(), () =>
        h.target.fetch(MESSAGES_URL, sdkInit(JSON.stringify(requestBody(TURN))))
      );
    const first = send();
    const second = send();
    await Promise.resolve();
    expect(h.calls).toHaveLength(0);
    release(DEVICE);
    await Promise.all([first, second]);
    expect(h.calls.map(({ init }) => String(init?.body).endsWith(METADATA_TAIL))).toEqual([
      true,
      true,
    ]);
    // Known now: the next request is handed on at once.
    const third = send();
    expect(h.calls).toHaveLength(3);
    await third;
    expect(String(h.calls[2]?.init?.body).endsWith(METADATA_TAIL)).toBe(true);
    expect(h.deviceId).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['resolves to nothing', async () => undefined],
    [
      'rejects',
      async () => {
        throw new Error('EACCES: /home/someone/secret');
      },
    ],
    [
      'throws',
      () => {
        throw new Error('EACCES: /home/someone/secret');
      },
    ],
  ])('sends without metadata when the device id %s, and asks once', async (_what, deviceId) => {
    const h = setup({ deviceId: deviceId as RequestTapDeps['deviceId'] });
    for (let n = 0; n < 3; n += 1) {
      const { init, sent } = await h.send(requestBody(TURN));
      expect(sent?.init).toBe(init);
    }
    expect(h.deviceId).toHaveBeenCalledTimes(1);
    expect(h.warnings).toEqual([
      {
        key: 'device-id',
        line: 'request tap: no anonymous install id could be read or made; model requests go without session metadata',
      },
    ]);
  });

  it(`appends nothing with ${SESSION_METADATA_ENV}=0, and still watches`, async () => {
    const h = setup({ env: { [SESSION_METADATA_ENV]: '0' } });
    expect(h.status).toEqual({
      installed: true,
      sessionMetadata: false,
      prefixWatch: true,
      userContentBlocks: true,
      responsesWatch: true,
    });
    const { init, sent } = await h.send(requestBody(TURN));
    expect(sent?.init).toBe(init);
    expect(h.deviceId).not.toHaveBeenCalled();
    expect(h.scope.evidenceFor(SESSION)?.verdict).toEqual({ kind: 'first' });
  });

  it('appends nothing to a request with a Content-Length header of its own', async () => {
    const h = setup();
    const { init, raw, sent } = await h.send(requestBody(TURN), {
      headers: { 'content-length': '999' },
    });
    expect(sent?.init).toBe(init);
    expect(init.body).toBe(raw);
    expect(keysOf(h.warnings)).toEqual(['content-length']);
    expect(h.scope.evidenceFor(SESSION)?.verdict).toEqual({ kind: 'first' });
  });
});

describe('a body the tap cannot read', () => {
  it('goes as it came, and the warning quotes none of it', async () => {
    const h = setup();
    const { init, sent } = await h.send(
      '{"model":"m","messages":[{"role":"user","content":"x"}],"x":SECRET-TEXT}'
    );
    expect(sent?.init).toBe(init);
    expect(h.warnings).toEqual([
      { key: 'parse', line: 'request tap: a model request body is not JSON; it went as it is' },
    ]);
    expect(h.deviceId).not.toHaveBeenCalled();
  });

  it('goes as it is when too long to parse, and its chain starts over', async () => {
    const small = JSON.stringify(requestBody(TURN));
    const h = setup({ limits: { maxParsedBody: small.length } });
    await h.send(requestBody(TURN));
    const big = requestBody([...TURN, ...STEP]);
    const { init, sent } = await h.send(big);
    expect(sent?.init).toBe(init);
    expect(h.warnings).toEqual([
      {
        key: 'parse-size',
        line: `request tap: a model request body over ${small.length} characters went as it is, without session metadata or prefix watch`,
      },
    ]);
    // The request after it is compared with nothing.
    await h.send(requestBody(TURN));
    expect(h.scope.evidenceFor(SESSION)).toMatchObject({
      verdict: { kind: 'first' },
      requestSeq: 3,
    });
  });

  it('reports the default limits in MB', () => {
    expect(REQUEST_TAP_LIMITS).toEqual({
      maxParsedBody: 64 * 1024 * 1024,
      maxWatchedBody: 16 * 1024 * 1024,
      chainsKept: 64,
      chainIdleMs: 2 * 60 * 60 * 1000,
    });
  });
});

describe('B1: prefix watch', () => {
  const PREFIX_LINE =
    /^prefix-watch: session=[\w.:-]+ purpose=[a-z-]+ req=\d+ verdict=diverged at=[a-z-]+( [a-z]+=\S+)*$/;

  it('compares after the request is handed on', async () => {
    const h = setup();
    await h.send(requestBody(TURN));
    const pending = h.scope.run(agent(), () =>
      h.target.fetch(MESSAGES_URL, sdkInit(JSON.stringify(requestBody([...TURN, ...STEP]))))
    );
    // Handed on at once; the comparison waits its turn.
    expect(h.calls).toHaveLength(2);
    expect(h.queue).toHaveLength(1);
    expect(h.scope.evidenceFor(SESSION)?.verdict).toEqual({ kind: 'first' });
    await pending;
    h.settle();
    expect(h.scope.evidenceFor(SESSION)?.verdict).toEqual({ kind: 'append', added: 2 });
  });

  it("logs a divergence only, and keeps each agent request's verdict; a retry's stands aside", async () => {
    const h = setup();
    const evidence = () => h.scope.evidenceFor(SESSION);

    h.clock.now += 1000;
    await h.send(requestBody(TURN));
    expect(evidence()).toEqual({ verdict: { kind: 'first' }, requestSeq: 1, at: h.clock.now });

    h.clock.now += 1000;
    const appendedAt = h.clock.now;
    await h.send(requestBody([...TURN, ...STEP]));
    const appended = { verdict: { kind: 'append', added: 2 }, requestSeq: 2, at: appendedAt };
    expect(evidence()).toEqual(appended);

    // A retry: the same request again.
    h.clock.now += 1000;
    await h.send(requestBody([...TURN, ...STEP]));
    expect(evidence()).toEqual(appended);
    expect(h.lines).toEqual([]);

    // The system prompt changed (plan mode left).
    h.clock.now += 1000;
    const changed = { system: [{ type: 'text', text: 'You are a coding agent. Act.' }] };
    await h.send(requestBody([...TURN, ...STEP], changed));
    expect(evidence()).toMatchObject({
      verdict: { kind: 'diverged', at: 'system', truncated: false },
      requestSeq: 4,
    });

    // The history cut back, as a rewind does.
    await h.send(requestBody(TURN, changed));
    expect(evidence()).toMatchObject({
      verdict: { kind: 'diverged', at: 'messages', index: 3, truncated: true },
      requestSeq: 5,
    });

    // An earlier message rewritten.
    const rewritten = [TURN[0], { role: 'assistant', content: [{ type: 'text', text: 'Sure.' }] }];
    await h.send(requestBody([...rewritten, TURN[2]] as Message[], changed));

    expect(h.lines).toEqual([
      `prefix-watch: session=${SESSION} purpose=agent req=4 verdict=diverged at=system`,
      `prefix-watch: session=${SESSION} purpose=agent req=5 verdict=diverged at=messages index=3/3 role=assistant truncated=true`,
      `prefix-watch: session=${SESSION} purpose=agent req=6 verdict=diverged at=messages index=1/3 role=assistant truncated=false`,
    ]);
    for (const line of h.lines) {
      expect(line).toMatch(PREFIX_LINE);
      expect(line).not.toMatch(/[0-9a-f]{16}/);
    }
  });

  it('keeps a chain per session and purpose, and the verdicts of agent requests only', async () => {
    const h = setup();
    await h.send(requestBody(TURN));
    await h.send(requestBody([...TURN, ...STEP], { max_tokens: 4096 }), {
      store: { sessionId: SESSION, purpose: 'compaction' },
    });
    await h.send(requestBody(STEP), { store: { sessionId: SESSION, purpose: 'compaction' } });
    await h.send(requestBody(TURN), { store: { sessionId: SESSION, purpose: 'session-title' } });
    await h.send(requestBody(STEP), { store: agent(FORK) });
    expect(h.scope.evidenceFor(SESSION)).toMatchObject({
      verdict: { kind: 'first' },
      requestSeq: 1,
    });
    expect(h.scope.evidenceFor(FORK)).toMatchObject({ verdict: { kind: 'first' }, requestSeq: 1 });
    expect(h.lines).toEqual([
      `prefix-watch: session=${SESSION} purpose=compaction req=2 verdict=diverged at=messages index=0/2 role=assistant truncated=false`,
    ]);
  });

  it('forgets the least recently used chain past its limit', async () => {
    const h = setup({ limits: { chainsKept: 2 } });
    await h.send(requestBody(TURN), { store: agent('aiclient-a') });
    await h.send(requestBody(TURN), { store: agent('aiclient-b') });
    await h.send(requestBody([...TURN, ...STEP]), { store: agent('aiclient-a') });
    // A third chain: b, the least recently used, is forgotten; a is kept.
    await h.send(requestBody(TURN), { store: agent('aiclient-c') });
    await h.send(requestBody([...TURN, ...STEP, ...STEP]), { store: agent('aiclient-a') });
    expect(h.scope.evidenceFor('aiclient-a')).toMatchObject({
      verdict: { kind: 'append', added: 2 },
      requestSeq: 3,
    });
    await h.send(requestBody([...TURN, ...STEP]), { store: agent('aiclient-b') });
    expect(h.scope.evidenceFor('aiclient-b')).toMatchObject({
      verdict: { kind: 'first' },
      requestSeq: 1,
    });
  });

  it('forgets a chain idle for over two hours', async () => {
    const h = setup();
    await h.send(requestBody(TURN));
    h.clock.now += REQUEST_TAP_LIMITS.chainIdleMs;
    await h.send(requestBody([...TURN, ...STEP]));
    expect(h.scope.evidenceFor(SESSION)).toMatchObject({
      verdict: { kind: 'append', added: 2 },
      requestSeq: 2,
    });
    h.clock.now += REQUEST_TAP_LIMITS.chainIdleMs + 1;
    await h.send(requestBody([...TURN, ...STEP, ...STEP]));
    expect(h.scope.evidenceFor(SESSION)).toMatchObject({
      verdict: { kind: 'first' },
      requestSeq: 1,
    });
  });

  it('skips a body too long to hash, still with its metadata, and its chain starts over', async () => {
    const small = JSON.stringify(requestBody(TURN));
    const h = setup({ limits: { maxWatchedBody: small.length } });
    await h.send(requestBody(TURN));
    const { raw, sent } = await h.send(requestBody([...TURN, ...STEP]));
    expect(String(sent?.init?.body)).toBe(`${raw.slice(0, -1)}${METADATA_TAIL}`);
    expect(h.warnings).toEqual([
      {
        key: 'watch-size',
        line: `request tap: the prefix watch skips model request bodies over ${small.length} characters`,
      },
    ]);
    expect(h.scope.evidenceFor(SESSION)).toMatchObject({
      verdict: { kind: 'first' },
      requestSeq: 1,
    });
    await h.send(requestBody(TURN));
    expect(h.scope.evidenceFor(SESSION)).toMatchObject({
      verdict: { kind: 'first' },
      requestSeq: 3,
    });
  });

  it('writes a session id it cannot vouch for as ?', async () => {
    const h = setup();
    const odd = 'aiclient-a b\nc';
    await h.send(requestBody(TURN), { store: agent(odd) });
    await h.send(requestBody(STEP), { store: agent(odd) });
    expect(h.lines).toEqual([
      'prefix-watch: session=? purpose=agent req=2 verdict=diverged at=messages index=0/2 role=assistant truncated=false',
    ]);
  });

  it(`watches nothing with ${PREFIX_WATCH_ENV}=0, and still appends`, async () => {
    const h = setup({ env: { [PREFIX_WATCH_ENV]: '0' } });
    expect(h.status).toEqual({
      installed: true,
      sessionMetadata: true,
      prefixWatch: false,
      userContentBlocks: true,
      responsesWatch: true,
    });
    const { raw, sent } = await h.send(requestBody(TURN));
    await h.send(requestBody(STEP));
    expect(String(sent?.init?.body)).toBe(`${raw.slice(0, -1)}${METADATA_TAIL}`);
    expect(h.queue).toEqual([]);
    expect(h.lines).toEqual([]);
    expect(h.scope.evidenceFor(SESSION)).toBeUndefined();
  });
});

describe('R: openai-responses requests (decision 193 §9)', () => {
  const RESPONSES_URL = 'https://gw.example.test/v1/responses';
  type Item = Record<string, unknown>;
  const FIRST: readonly Item[] = [
    { role: 'user', content: [{ type: 'input_text', text: 'Read the README.' }] },
    {
      type: 'function_call',
      id: 'fc_1',
      call_id: 'call_1',
      name: 'read',
      arguments: '{"file_path":"README.md"}',
    },
    { type: 'function_call_output', call_id: 'call_1', output: 'Hello.' },
  ];
  const NEXT: readonly Item[] = [
    { role: 'assistant', content: [{ type: 'output_text', text: 'It says hello.' }] },
    { role: 'user', content: [{ type: 'input_text', text: 'Now run the tests.' }] },
  ];

  /** A Responses body in pi-ai's shape and key order. */
  function responsesBody(input: readonly Item[], overrides: Record<string, unknown> = {}) {
    return {
      model: 'gpt-6',
      input: [{ role: 'developer', content: 'You are a coding agent.' }, ...input],
      stream: true,
      prompt_cache_key: SESSION,
      prompt_cache_retention: '24h',
      store: false,
      max_output_tokens: 128_000,
      tools: [{ type: 'function', name: 'read', parameters: { type: 'object' } }],
      reasoning: { effort: 'high', summary: 'auto' },
      ...overrides,
    };
  }

  /** One OpenAI SDK call to the Responses API inside `store`. */
  async function sendResponses(
    h: ReturnType<typeof setup>,
    body: unknown,
    store: RequestScopeStore | null = agent()
  ) {
    const init: RequestInit = {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer fake' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
      signal: new AbortController().signal,
    };
    const call = () => h.target.fetch(RESPONSES_URL, init);
    await (store === null ? call() : h.scope.run(store, call));
    h.settle();
    return { init, sent: h.calls.at(-1) };
  }

  it("watches a session's request and sends it with its very own arguments", async () => {
    const h = setup();
    const evidence = () => h.scope.evidenceFor(SESSION);
    const first = await sendResponses(h, responsesBody(FIRST));
    expect(first.sent?.input).toBe(RESPONSES_URL);
    expect(first.sent?.init).toBe(first.init);
    expect(evidence()).toMatchObject({ verdict: { kind: 'first' }, requestSeq: 1 });

    const next = await sendResponses(h, responsesBody([...FIRST, ...NEXT]));
    expect(next.sent?.init).toBe(next.init);
    expect(evidence()).toMatchObject({ verdict: { kind: 'append', added: 2 }, requestSeq: 2 });
    expect(h.lines).toEqual([]);
    // Never metadata, never a rewrite: pi-ai names the session in prompt_cache_key.
    expect(h.deviceId).not.toHaveBeenCalled();
    expect(h.warnings).toEqual([]);
  });

  it('logs where a request diverged: the instructions, a cache key, an item', async () => {
    const h = setup();
    await sendResponses(h, responsesBody(FIRST, { instructions: 'Be brief.' }));
    await sendResponses(h, responsesBody(FIRST, { instructions: 'Be thorough.' }));
    await sendResponses(
      h,
      responsesBody(FIRST, { instructions: 'Be thorough.', prompt_cache_key: 'other' })
    );
    const edited = [FIRST[0], FIRST[1], { ...FIRST[2], output: 'Trimmed.' }] as Item[];
    await sendResponses(
      h,
      responsesBody([...edited, ...NEXT], {
        instructions: 'Be thorough.',
        prompt_cache_key: 'other',
      })
    );
    expect(h.lines).toEqual([
      `prefix-watch: session=${SESSION} purpose=agent req=2 verdict=diverged at=system`,
      `prefix-watch: session=${SESSION} purpose=agent req=3 verdict=diverged at=config field=prompt_cache_key`,
      `prefix-watch: session=${SESSION} purpose=agent req=4 verdict=diverged at=messages index=3/6 role=function_call_output truncated=false`,
    ]);
  });

  it('leaves one-shot requests, requests outside a session and other paths alone', async () => {
    const h = setup();
    await sendResponses(h, responsesBody(FIRST), { purpose: 'oneshot' });
    await sendResponses(h, responsesBody(FIRST), null);
    await h.scope.run(agent(), () =>
      h.target.fetch('https://gw.example.test/v1/responses/resp_1/cancel', {
        method: 'POST',
        body: '{}',
      })
    );
    expect(h.queue).toEqual([]);
    expect(h.scope.evidenceFor(SESSION)).toBeUndefined();
    expect(keysOf(h.warnings)).toEqual(['no-scope']);
  });

  it('starts the chain over after a body that is not JSON, quoting none of it', async () => {
    const h = setup();
    await sendResponses(h, responsesBody(FIRST));
    const { init, sent } = await sendResponses(h, '{"input": [secret');
    expect(sent?.init).toBe(init);
    await sendResponses(h, responsesBody([...FIRST, ...NEXT]));
    expect(h.scope.evidenceFor(SESSION)).toMatchObject({
      verdict: { kind: 'first' },
      requestSeq: 3,
    });
    expect(h.warnings).toEqual([
      { key: 'parse', line: 'request tap: a model request body is not JSON; it went as it is' },
    ]);
  });

  it(`watches no Responses request with ${RESPONSES_CACHE_WATCH_ENV}=0, Messages ones still`, async () => {
    const h = setup({ env: { [RESPONSES_CACHE_WATCH_ENV]: '0' } });
    expect(h.status.responsesWatch).toBe(false);
    await sendResponses(h, responsesBody(FIRST));
    expect(h.queue).toEqual([]);
    expect(h.scope.evidenceFor(SESSION)).toBeUndefined();
    await h.send(requestBody(TURN));
    expect(h.scope.evidenceFor(SESSION)).toMatchObject({ verdict: { kind: 'first' } });
  });
});

describe('U: user content blocks (decision 182)', () => {
  /** pi-ai's cache mark as it shows in the JSON text. */
  const MARK_JSON = `,"cache_control":${JSON.stringify(MARK)}`;
  const CONTEXT_TEXT = '<context>cwd: /work</context>';
  /** pi-ai's first step of a turn: the context a string, the input a marked block. */
  const PI_STEP_ONE: readonly Message[] = [
    { role: 'user', content: CONTEXT_TEXT },
    { role: 'user', content: [{ type: 'text', text: README_TEXT, cache_control: MARK }] },
  ];
  /** Its second step: the input no longer last, so a plain string; the tool result marked. */
  const PI_STEP_TWO: readonly Message[] = [
    { role: 'user', content: CONTEXT_TEXT },
    { role: 'user', content: README_TEXT },
    TURN[1] as Message,
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: 'Hello.', cache_control: MARK },
      ],
    },
  ];

  it('sends each user string as a text block, then appends the metadata', async () => {
    const h = setup();
    const { init, raw, sent } = await h.send(requestBody([...PI_TURN, ...PI_STEP]));
    const blocks = JSON.stringify(requestBody([...TURN, ...STEP]));
    expect(String(sent?.init?.body)).toBe(`${blocks.slice(0, -1)}${METADATA_TAIL}`);
    // The caller's init is left alone; the rest of the call is its own.
    expect(init.body).toBe(raw);
    expect(sent?.init?.headers).toBe(init.headers);
    expect(sent?.init?.signal).toBe(init.signal);
    expect(h.warnings).toEqual([]);
  });

  it('does it on every kind of request, a one-shot one and one outside every scope included', async () => {
    const h = setup();
    const blocks = JSON.stringify(requestBody(TURN));
    const stores: Array<[RequestScopeStore | null, boolean]> = [
      [{ sessionId: SESSION, purpose: 'compaction' }, true],
      [{ sessionId: SESSION, purpose: 'session-title' }, true],
      [{ purpose: 'oneshot' }, false],
      [{ purpose: 'compaction' }, false],
      [null, false],
    ];
    for (const [store, metadata] of stores) {
      const { sent } = await h.send(requestBody(PI_TURN), { store });
      expect(String(sent?.init?.body), JSON.stringify(store)).toBe(
        metadata ? `${blocks.slice(0, -1)}${METADATA_TAIL}` : blocks
      );
    }
    expect(keysOf(h.warnings)).toEqual(['no-scope']);
  });

  it("keeps a turn's second step the same bytes as its first, up to the first's end, marks aside", async () => {
    const h = setup();
    const first = await h.send(requestBody(PI_STEP_ONE));
    const second = await h.send(requestBody(PI_STEP_TWO));
    const one = String(first.sent?.init?.body).replaceAll(MARK_JSON, '');
    const two = String(second.sent?.init?.body).replaceAll(MARK_JSON, '');
    // Everything before the first step's closing `]` of its messages, its last message included.
    const messages = JSON.stringify((JSON.parse(one) as { messages: unknown[] }).messages);
    const shared = one.slice(0, one.indexOf(messages) + messages.length - 1);
    expect(shared.length).toBeGreaterThan(messages.length);
    expect(two.startsWith(`${shared},`)).toBe(true);
    // The input went out as a block both times: the mark moved, nothing else.
    expect(JSON.parse(two).messages[1]).toEqual({ role: 'user', content: text(README_TEXT) });
    expect(h.scope.evidenceFor(SESSION)?.verdict).toEqual({ kind: 'append', added: 2 });
    expect(h.lines).toEqual([]);
  });

  it(`sends strings as they are with ${USER_CONTENT_BLOCKS_ENV}=0, and the watch names the form change`, async () => {
    const h = setup({ env: { [USER_CONTENT_BLOCKS_ENV]: '0' } });
    expect(h.status).toEqual({
      installed: true,
      sessionMetadata: true,
      prefixWatch: true,
      userContentBlocks: false,
      responsesWatch: true,
    });
    await h.send(requestBody(PI_STEP_ONE));
    const { raw, sent } = await h.send(requestBody(PI_STEP_TWO));
    expect(String(sent?.init?.body)).toBe(`${raw.slice(0, -1)}${METADATA_TAIL}`);
    // pi-ai's own second step: the input, a block before, is a string now.
    expect(h.scope.evidenceFor(SESSION)?.verdict).toEqual({
      kind: 'diverged',
      at: 'message-form',
      index: 1,
      role: 'user',
      form: 'string',
      truncated: false,
      prevMessages: 2,
      messages: 4,
    });
    expect(h.lines).toEqual([
      `prefix-watch: session=${SESSION} purpose=agent req=2 verdict=diverged at=message-form index=1/4 role=user form=string`,
    ]);
    // A one-shot request with U off is not the tap's at all.
    const { init, sent: oneshot } = await h.send(requestBody(PI_TURN), {
      store: { purpose: 'oneshot' },
    });
    expect(oneshot?.init).toBe(init);
  });

  it('sends neither blocks nor metadata with a Content-Length header of its own, and watches what went', async () => {
    const h = setup();
    const { init, raw, sent } = await h.send(requestBody(PI_TURN), {
      headers: { 'content-length': '999' },
    });
    expect(sent?.init).toBe(init);
    expect(init.body).toBe(raw);
    expect(h.warnings).toEqual([
      {
        key: 'content-length',
        line: 'request tap: a model request with a Content-Length header of its own went as it is, without session metadata or user content blocks',
      },
    ]);
    await h.send(requestBody([...PI_TURN, ...PI_STEP]), { headers: { 'content-length': '999' } });
    expect(h.scope.evidenceFor(SESSION)?.verdict).toEqual({ kind: 'append', added: 2 });
    // Outside a session too.
    const { init: other, sent: oneshot } = await h.send(requestBody(PI_TURN), {
      store: { purpose: 'oneshot' },
      headers: { 'content-length': '999' },
    });
    expect(oneshot?.init).toBe(other);
  });
});

describe('a tap that never costs the request', () => {
  const throwing = () => {
    throw new Error('dependency failed: SECRET');
  };

  it('sends the request as it came when the scope cannot be read', async () => {
    const h = setup();
    vi.spyOn(h.scope, 'current').mockImplementation(throwing);
    const { init, sent } = await h.send(requestBody(TURN), { store: null });
    expect(sent?.init).toBe(init);
    expect(h.warnings).toEqual([
      { key: 'tap', line: 'request tap: failed (Error); the request went as it came' },
    ]);
  });

  it.each([
    ['schedule', { schedule: throwing }],
    ['now', { now: throwing }],
  ] as Array<
    [string, Partial<RequestTapDeps>]
  >)('still appends when %s throws', async (_what, deps) => {
    const h = setup({ deps });
    const { raw, sent } = await h.send(requestBody(TURN));
    expect(String(sent?.init?.body)).toBe(`${raw.slice(0, -1)}${METADATA_TAIL}`);
    expect(h.warnings).toEqual([
      {
        key: 'prefix-watch',
        line: 'request tap: the prefix watch failed (Error); requests are not affected',
      },
    ]);
  });

  it('still sends when warning throws', async () => {
    const h = setup({ deps: { warnOnce: throwing } });
    const { init, sent } = await h.send('not json');
    expect(sent?.init).toBe(init);
    const { raw, sent: second } = await h.send(requestBody(TURN), { headers: {} });
    expect(String(second?.init?.body)).toBe(`${raw.slice(0, -1)}${METADATA_TAIL}`);
  });

  it('keeps watching after a comparison failed', async () => {
    const h = setup({ deps: { log: throwing } });
    const record = vi.spyOn(h.scope, 'recordEvidence');
    record.mockImplementationOnce(throwing);
    await h.send(requestBody(TURN));
    await h.send(requestBody([...TURN, ...STEP]));
    expect(h.scope.evidenceFor(SESSION)).toMatchObject({
      verdict: { kind: 'append', added: 2 },
      requestSeq: 2,
    });
    await h.send(requestBody(STEP));
    expect(keysOf(h.warnings)).toEqual(['prefix-watch', 'prefix-watch']);
    expect(JSON.stringify(h.warnings)).not.toContain('SECRET');
  });
});

describe('with the User-Agent relay', () => {
  it('wraps the relay: the body gets its metadata, the headers their User-Agent', async () => {
    const calls: Array<RequestInit | undefined> = [];
    const target = {
      fetch: (async (_input: unknown, init?: RequestInit) => {
        calls.push(init);
        return new Response('ok');
      }) as typeof globalThis.fetch,
    };
    expect(installUserAgentRelay(target)).toBe(true);
    const scope = new RequestScope();
    const status = installRequestTap(target, {
      scope,
      env: {},
      deviceId: async () => DEVICE,
      log: () => {},
      warnOnce: () => {},
      schedule: () => {},
    });
    expect(status.installed).toBe(true);
    const raw = JSON.stringify(requestBody(TURN));
    const relayed = {
      'user-agent': 'deepseek-harness/0.1.7-rc.2',
      'x-aiclient-user-agent': 'claude-cli-pilab/1.1.0-dsh.8',
    };
    await scope.run(agent(), () => target.fetch(MESSAGES_URL, sdkInit(raw, relayed)));
    expect(String(calls[0]?.body)).toBe(`${raw.slice(0, -1)}${METADATA_TAIL}`);
    const headers = new Headers(calls[0]?.headers);
    expect(headers.get('user-agent')).toBe('claude-cli-pilab/1.1.0-dsh.8');
    expect(headers.has('x-aiclient-user-agent')).toBe(false);
    // A relayed request of another API: the relay acts, the tap does not.
    const other = sdkInit('{}', relayed);
    await scope.run(agent(), () =>
      target.fetch('https://gw.example.test/v1/chat/completions', other)
    );
    expect(calls[1]?.body).toBe('{}');
    expect(new Headers(calls[1]?.headers).get('user-agent')).toBe('claude-cli-pilab/1.1.0-dsh.8');
  });
});

describe("on the wire, through Node's own fetch", () => {
  const received: Array<{ body: string; length: string | undefined }> = [];
  let base = '';
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.push({
        body: Buffer.concat(chunks).toString('utf8'),
        length: req.headers['content-length'],
      });
      res.end('ok');
    });
  });

  beforeAll(async () => {
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
  });

  it('the server reads the body with its metadata, at its full length', async () => {
    const scope = new RequestScope();
    const target = { fetch: globalThis.fetch.bind(globalThis) as typeof globalThis.fetch };
    installRequestTap(target, {
      scope,
      env: {},
      deviceId: async () => DEVICE,
      log: () => {},
      warnOnce: () => {},
      schedule: () => {},
    });
    const raw = JSON.stringify(requestBody(TURN));
    const response = await scope.run(agent(), () =>
      target.fetch(`${base}/v1/messages?beta=true`, sdkInit(raw))
    );
    await response.text();
    const body = `${raw.slice(0, -1)}${METADATA_TAIL}`;
    // Decision 182: pi-ai's strings, sent as blocks, also at their full length.
    const pi = JSON.stringify(requestBody([...PI_TURN, ...PI_STEP]));
    const second = await scope.run(agent(), () =>
      target.fetch(`${base}/v1/messages?beta=true`, sdkInit(pi))
    );
    await second.text();
    const blocks = `${JSON.stringify(requestBody([...TURN, ...STEP])).slice(0, -1)}${METADATA_TAIL}`;
    expect(received).toEqual([
      { body, length: String(Buffer.byteLength(body)) },
      { body: blocks, length: String(Buffer.byteLength(blocks)) },
    ]);
  });
});
