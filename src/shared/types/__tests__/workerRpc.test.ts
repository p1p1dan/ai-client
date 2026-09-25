import { describe, expect, it } from 'vitest';
import {
  isWorkerBootstrapPayload,
  isWorkerBootstrapResult,
  isWorkerForkPayload,
  isWorkerForkResult,
  isWorkerHistoryPayload,
  isWorkerHistoryResult,
  isWorkerInspectImportedSessionPayload,
  isWorkerInterjectResult,
  isWorkerReconcileImportedSessionPayload,
  isWorkerReloadPayload,
  isWorkerReloadResult,
  isWorkerRewindPayload,
  isWorkerRewindResult,
  isWorkerRpcEvent,
  isWorkerRpcMessage,
  isWorkerRpcRequest,
  isWorkerRpcResponse,
  isWorkerSendPayload,
  isWorkerSendResult,
  isWorkerStopPayload,
  isWorkerStopResult,
  isWorkerTreePayload,
  isWorkerTreeResult,
  isWorkerUtilityCancelPayload,
  isWorkerUtilityDeltaEvent,
  isWorkerUtilityStartPayload,
  isWorkerUtilityStartResult,
  isWorkerUtilityTerminalEvent,
  normalizeWorkerCapabilities,
  WORKER_RPC_PROTOCOL_VERSION,
} from '../workerRpc';

const base = {
  protocolVersion: WORKER_RPC_PROTOCOL_VERSION,
  generation: 1,
};

describe('worker RPC boundary guards', () => {
  it('accepts a complete request envelope', () => {
    expect(
      isWorkerRpcRequest({
        ...base,
        kind: 'request',
        requestId: 'rpc-1',
        type: 'ping',
        payload: {},
      })
    ).toBe(true);
  });

  it('accepts success and structured error responses', () => {
    const success = {
      ...base,
      kind: 'response',
      requestId: 'rpc-1',
      ok: true,
      result: { pong: true },
    };
    const failure = {
      ...base,
      kind: 'response',
      requestId: 'rpc-2',
      ok: false,
      error: { code: 'BAD_REQUEST', message: 'nope' },
    };

    expect(isWorkerRpcResponse(success)).toBe(true);
    expect(isWorkerRpcResponse(failure)).toBe(true);
    expect(isWorkerRpcMessage(success)).toBe(true);
    expect(isWorkerRpcMessage(failure)).toBe(true);
  });

  it('validates the one-session bootstrap payload and acknowledgement', () => {
    expect(
      isWorkerBootstrapPayload({
        logicalSessionId: 'logical-1',
        cwd: '/repo',
        model: 'pilab/company-model',
        effort: 'high',
      })
    ).toBe(true);
    expect(isWorkerBootstrapPayload({ logicalSessionId: '', cwd: '/repo' })).toBe(false);
    expect(isWorkerBootstrapPayload({ logicalSessionId: '   ', cwd: '/repo' })).toBe(false);
    expect(isWorkerBootstrapPayload({ logicalSessionId: 'logical-1', cwd: '   ' })).toBe(false);
    expect(
      isWorkerBootstrapPayload({ logicalSessionId: 'logical-1', cwd: '/repo', effort: 'ultra' })
    ).toBe(false);
    // U08-2: the guard used to restate five level words, so a bootstrap
    // carrying Pi's `off` or `minimal` was rejected WHOLESALE — not just the
    // effort field — and the session never started.
    for (const effort of ['off', 'minimal']) {
      expect(
        isWorkerBootstrapPayload({ logicalSessionId: 'logical-1', cwd: '/repo', effort })
      ).toBe(true);
    }

    // concurrency-02: a boolean or nothing at all. This is the first of the
    // three gates that keep a forced writer-lock takeover from happening by
    // accident, so a truthy non-boolean must not get through — Main's
    // `spawnForceTakeover` would drop it too, but the guard is what protects a
    // worker reached by any other route.
    for (const forceTakeover of [true, false, undefined]) {
      expect(
        isWorkerBootstrapPayload({ logicalSessionId: 'logical-1', cwd: '/repo', forceTakeover })
      ).toBe(true);
    }
    for (const forceTakeover of ['yes', 1, 'true', {}]) {
      expect(
        isWorkerBootstrapPayload({ logicalSessionId: 'logical-1', cwd: '/repo', forceTakeover })
      ).toBe(false);
    }

    // The two prompt cache TTLs: absent is the shipped default, and anything
    // that is not one of the two accepted spellings is REJECTED rather than
    // coerced — a worker that fell back silently would run a lifetime the
    // settings page is not showing.
    for (const promptCacheTtl of ['5m', '1h', undefined]) {
      expect(
        isWorkerBootstrapPayload({ logicalSessionId: 'logical-1', cwd: '/repo', promptCacheTtl })
      ).toBe(true);
    }
    for (const ttl of ['1 hour', 'long', '60m', 5, {}]) {
      expect(
        isWorkerBootstrapPayload({
          logicalSessionId: 'logical-1',
          cwd: '/repo',
          promptCacheTtl: ttl,
        })
      ).toBe(false);
      expect(
        isWorkerBootstrapPayload({
          logicalSessionId: 'logical-1',
          cwd: '/repo',
          subagentPromptCacheTtl: ttl,
        })
      ).toBe(false);
    }

    expect(
      isWorkerBootstrapResult({
        bootstrapped: true,
        logicalSessionId: 'logical-1',
        piSessionId: 'pi-1',
        cwd: '/repo',
        agentDir: '/managed/pi-agent',
        projectTrusted: false,
        permissionGate: 'bundled',
        leaf: { activeEntryId: null, fileTailEntryId: null },
        initialHistory: {
          logicalSessionId: 'logical-1',
          sessionFile: '/sessions/pi-1.jsonl',
          workspacePath: '/repo',
          page: { messages: [], offset: 0, limit: 80, totalCount: 0, hasMore: false },
        },
      })
    ).toBe(true);
    expect(
      isWorkerBootstrapResult({
        bootstrapped: true,
        logicalSessionId: 'logical-1',
        piSessionId: '',
        cwd: '/repo',
        agentDir: '/managed/pi-agent',
        projectTrusted: false,
        permissionGate: 'missing',
      })
    ).toBe(false);
  });

  it('validates branch-history page requests and exact-session results', () => {
    expect(isWorkerHistoryPayload({ logicalSessionId: 'logical-1', offset: 80, limit: 40 })).toBe(
      true
    );
    expect(isWorkerHistoryPayload({ logicalSessionId: 'logical-1', offset: -1 })).toBe(false);
    expect(isWorkerHistoryPayload({ logicalSessionId: 'logical-1', limit: 501 })).toBe(false);
    expect(
      isWorkerHistoryResult({
        logicalSessionId: 'logical-1',
        sessionFile: '/sessions/pi-1.jsonl',
        workspacePath: '/repo',
        page: {
          messages: [
            {
              id: 'h:u1',
              entryId: 'u1',
              role: 'user',
              blocks: [{ type: 'text', id: 'h:u1:text:0', text: 'hello' }],
            },
          ],
          offset: 0,
          limit: 80,
          totalCount: 1,
          hasMore: false,
        },
      })
    ).toBe(true);
    expect(
      isWorkerHistoryResult({
        logicalSessionId: 'logical-1',
        sessionFile: '/sessions/pi-1.jsonl',
        workspacePath: '/repo',
        page: { messages: [], offset: 0, limit: 0, totalCount: 0, hasMore: false },
      })
    ).toBe(false);
  });

  it('validates bounded tree, confirmed rewind, and independent fork results', () => {
    const snapshot = {
      logicalSessionId: 'logical-1',
      sessionFile: '/sessions/pi-1.jsonl',
      workspacePath: '/repo',
      leaf: { activeEntryId: 'a', fileTailEntryId: 'c' },
      nodes: [
        {
          id: 'a',
          parentId: null,
          depth: 0,
          entryType: 'message',
          childCount: 2,
          forkable: true,
          active: true,
          leaf: true,
        },
      ],
      totalNodes: 1,
      returnedNodes: 1,
      truncated: false,
    };
    const history = {
      logicalSessionId: 'logical-1',
      sessionFile: '/sessions/pi-1.jsonl',
      workspacePath: '/repo',
      page: { messages: [], offset: 0, limit: 80, totalCount: 0, hasMore: false },
    };
    expect(isWorkerTreePayload({ logicalSessionId: 'logical-1' })).toBe(true);
    expect(isWorkerTreeResult({ snapshot })).toBe(true);
    expect(
      isWorkerRewindPayload({
        logicalSessionId: 'logical-1',
        targetEntryId: 'a',
        confirmed: true,
      })
    ).toBe(true);
    expect(
      isWorkerRewindPayload({
        logicalSessionId: 'logical-1',
        targetEntryId: 'a',
        confirmed: false,
      })
    ).toBe(false);
    expect(
      isWorkerRewindResult({
        logicalSessionId: 'logical-1',
        sessionFile: '/sessions/pi-1.jsonl',
        workspacePath: '/repo',
        targetEntryId: 'a',
        leaf: snapshot.leaf,
        history,
        tree: { snapshot },
      })
    ).toBe(true);
    // A reload names the file it expects to be reloaded, so a worker can
    // refuse one aimed at a session it does not own.
    expect(
      isWorkerReloadPayload({
        logicalSessionId: 'logical-1',
        sessionFile: '/sessions/pi-1.jsonl',
      })
    ).toBe(true);
    expect(isWorkerReloadPayload({ logicalSessionId: 'logical-1' })).toBe(false);
    expect(isWorkerReloadPayload({ logicalSessionId: 'logical-1', sessionFile: '  ' })).toBe(false);
    expect(
      isWorkerReloadResult({
        logicalSessionId: 'logical-1',
        sessionFile: '/sessions/pi-1.jsonl',
        workspacePath: '/repo',
        leaf: snapshot.leaf,
        history,
      })
    ).toBe(true);
    expect(
      isWorkerReloadResult({
        logicalSessionId: 'logical-1',
        sessionFile: '/sessions/pi-1.jsonl',
        workspacePath: '/repo',
        history,
      })
    ).toBe(false);
    expect(isWorkerForkPayload({ logicalSessionId: 'logical-1', entryId: 'a' })).toBe(true);
    expect(
      isWorkerForkResult({
        logicalSessionId: 'logical-1',
        sourceSessionFile: '/sessions/pi-1.jsonl',
        sessionFile: '/sessions/pi-fork.jsonl',
        piSessionId: 'pi-fork',
        workspacePath: '/repo',
        leaf: snapshot.leaf,
        history: { ...history, sessionFile: '/sessions/pi-fork.jsonl' },
      })
    ).toBe(true);
  });

  it('validates send admission, stop, and Extension UI payloads', () => {
    expect(
      isWorkerSendPayload({
        logicalSessionId: 'logical-1',
        requestId: 'turn-1',
        attemptId: 'attempt-1',
        text: 'hello',
        model: 'glm/glm-5',
        effort: 'xhigh',
        attachments: [
          { kind: 'image', mediaType: 'image/png', data: 'base64' },
          { kind: 'text', mediaType: 'text/plain', data: 'notes', name: 'notes.txt' },
        ],
      })
    ).toBe(true);
    expect(isWorkerSendPayload({ logicalSessionId: 'logical-1', requestId: '', text: 'x' })).toBe(
      false
    );
    expect(
      isWorkerSendPayload({
        logicalSessionId: 'logical-1',
        requestId: 'turn-1',
        attemptId: 'attempt-1',
        text: 'x',
        attachments: [{ kind: 'binary', mediaType: 'x', data: 'x' }],
      })
    ).toBe(false);
    expect(isWorkerSendResult({ accepted: true, requestId: 'turn-1' })).toBe(true);
    expect(isWorkerStopPayload({ logicalSessionId: 'logical-1', reason: 'user' })).toBe(true);
    expect(isWorkerStopPayload({ logicalSessionId: 'logical-1', reason: 'later' })).toBe(false);
    expect(isWorkerStopResult({ stopped: false })).toBe(true);
    // decision 046: `turnActive` is optional (absent = not reported) but typed.
    expect(isWorkerInterjectResult({ interjected: false })).toBe(true);
    expect(isWorkerInterjectResult({ interjected: false, turnActive: false })).toBe(true);
    expect(isWorkerInterjectResult({ interjected: false, turnActive: 'no' })).toBe(false);
  });

  it('validates sessionless utility requests and terminal events', () => {
    expect(
      isWorkerUtilityStartPayload({
        operationId: 'utility-1',
        cwd: '/repo',
        prompt: 'Summarize this diff',
        model: 'pilab/company-model',
        effort: 'high',
        timeoutMs: 60_000,
      })
    ).toBe(true);
    expect(
      isWorkerUtilityStartPayload({
        operationId: 'utility-1',
        cwd: '/repo',
        prompt: '   ',
        timeoutMs: 60_000,
      })
    ).toBe(false);
    expect(
      isWorkerUtilityStartPayload({
        operationId: 'utility-1',
        cwd: '/repo',
        prompt: 'x',
        timeoutMs: 600_001,
      })
    ).toBe(false);
    expect(isWorkerUtilityStartResult({ accepted: true, operationId: 'utility-1' })).toBe(true);
    expect(isWorkerUtilityCancelPayload({ operationId: 'utility-1', reason: 'timeout' })).toBe(
      true
    );
    expect(isWorkerUtilityCancelPayload({ operationId: 'utility-1', reason: 'later' })).toBe(false);
    expect(
      isWorkerUtilityDeltaEvent({
        ...base,
        kind: 'event',
        type: 'utility.delta',
        payload: { operationId: 'utility-1', delta: 'hello' },
      })
    ).toBe(true);
    expect(
      isWorkerUtilityTerminalEvent({
        ...base,
        kind: 'event',
        type: 'utility.terminal',
        payload: {
          operationId: 'utility-1',
          state: 'completed',
          text: 'hello',
          model: 'pilab/company-model',
        },
      })
    ).toBe(true);
  });

  it('rejects a targetPiSessionId that is not a safe path segment on the import inspect/reconcile RPCs', () => {
    // import-catalog-07: both handlers join targetPiSessionId straight into a
    // session file path in the worker process.
    expect(
      isWorkerInspectImportedSessionPayload({
        logicalSessionId: 'logical-1',
        workspacePath: '/repo',
        targetPiSessionId: 'import-1',
      })
    ).toBe(true);
    expect(
      isWorkerReconcileImportedSessionPayload({
        logicalSessionId: 'logical-1',
        workspacePath: '/repo',
        targetPiSessionId: 'import-1',
      })
    ).toBe(true);
    for (const targetPiSessionId of ['', '.', '..', '../escape', 'a/b', 'a\\b']) {
      expect(
        isWorkerInspectImportedSessionPayload({
          logicalSessionId: 'logical-1',
          workspacePath: '/repo',
          targetPiSessionId,
        }),
        targetPiSessionId
      ).toBe(false);
      expect(
        isWorkerReconcileImportedSessionPayload({
          logicalSessionId: 'logical-1',
          workspacePath: '/repo',
          targetPiSessionId,
        }),
        targetPiSessionId
      ).toBe(false);
    }
  });

  it('keeps transport request identity separate from product turn identity', () => {
    const request = {
      ...base,
      kind: 'request',
      requestId: 'rpc-9',
      type: 'worker.send',
      payload: {
        logicalSessionId: 'logical-1',
        requestId: 'turn-3',
        attemptId: 'attempt-3',
        text: 'hello',
      },
    };
    expect(isWorkerRpcRequest(request)).toBe(true);
    expect(request.requestId).not.toBe(request.payload.requestId);
  });

  it('accepts an event envelope without a request ID', () => {
    expect(
      isWorkerRpcEvent({
        ...base,
        kind: 'event',
        type: 'runtime.event',
        payload: { type: 'session.status' },
      })
    ).toBe(true);
  });

  it('rejects invalid protocol versions, generations, and error shapes', () => {
    expect(
      isWorkerRpcRequest({
        ...base,
        protocolVersion: 99,
        kind: 'request',
        requestId: 'rpc-1',
        type: 'ping',
        payload: {},
      })
    ).toBe(false);
    expect(
      isWorkerRpcEvent({
        ...base,
        generation: 0,
        kind: 'event',
        type: 'runtime.event',
        payload: {},
      })
    ).toBe(false);
    expect(
      isWorkerRpcResponse({
        ...base,
        kind: 'response',
        requestId: 'rpc-1',
        ok: false,
        error: { message: 'missing code' },
      })
    ).toBe(false);
    expect(
      isWorkerRpcResponse({
        ...base,
        kind: 'response',
        requestId: 'rpc-2',
        ok: false,
        error: { code: 'BAD_REQUEST', message: 'nope', retryable: 'yes' },
      })
    ).toBe(false);
  });
});

/**
 * T026 — the capability inventory is normalized where it is READ, not where the
 * bootstrap payload is judged legal.
 *
 * The field replaced `extensions`, which fed a sidebar panel; a panel list that
 * arrives garbled must cost the panel and nothing else. Putting it in
 * `isWorkerBootstrapResult` would make a malformed server row fail the whole
 * bootstrap — the U08-2 failure mode — so these two properties are tested
 * together on purpose.
 */
describe('normalizeWorkerCapabilities', () => {
  const bootstrap = {
    bootstrapped: true,
    logicalSessionId: 'logical-1',
    piSessionId: 'pi-1',
    cwd: '/repo',
    agentDir: '/agent',
    projectTrusted: true,
    permissionGate: 'bundled' as const,
    leaf: { activeEntryId: null, fileTailEntryId: null },
  };

  it('returns null when nothing reported one', () => {
    expect(normalizeWorkerCapabilities(undefined)).toBeNull();
    expect(normalizeWorkerCapabilities(null)).toBeNull();
    expect(normalizeWorkerCapabilities('mcp')).toBeNull();
    // An object with nothing readable in it is not a report either.
    expect(normalizeWorkerCapabilities({})).toBeNull();
    expect(normalizeWorkerCapabilities({ skills: 'many', mcpServers: 'two' })).toBeNull();
  });

  it('keeps an empty server list apart from an absent one', () => {
    // The distinction the panel renders as "none configured" vs "not reported".
    expect(normalizeWorkerCapabilities({ mcpServers: [] })).toEqual({ mcpServers: [] });
    expect(normalizeWorkerCapabilities({ skills: 0 })).toEqual({ skills: 0 });
    expect(normalizeWorkerCapabilities({ skills: 2 })?.mcpServers).toBeUndefined();
  });

  it('drops one unreadable member without taking the others with it', () => {
    expect(
      normalizeWorkerCapabilities({
        mcpServers: [{ name: 'good', ok: true, toolCount: 3 }, { ok: true }, null, 'nope'],
        skills: 4,
        promptTemplates: -1,
        subagents: 2.7,
      })
    ).toEqual({
      mcpServers: [{ name: 'good', ok: true, toolCount: 3 }],
      skills: 4,
      // A negative count is not a count; a fractional one is truncated.
      subagents: 2,
    });
  });

  it('reports a failed server rather than omitting it', () => {
    // "Declared and did not come up" is the fact a user needs; dropping it
    // would render the same as never having configured the server at all.
    expect(
      normalizeWorkerCapabilities({
        mcpServers: [{ name: 'broken', ok: false, toolCount: 9, error: 'ECONNREFUSED' }],
      })
    ).toEqual({ mcpServers: [{ name: 'broken', ok: false, toolCount: 0, error: 'ECONNREFUSED' }] });
    // An error on a healthy server is not carried: it would render a Failed
    // badge next to working tools.
    expect(
      normalizeWorkerCapabilities({ mcpServers: [{ name: 'ok', ok: true, error: 'stale' }] })
    ).toEqual({ mcpServers: [{ name: 'ok', ok: true, toolCount: 0 }] });
  });

  it('never lets a malformed inventory fail the bootstrap payload itself', () => {
    expect(isWorkerBootstrapResult({ ...bootstrap, capabilities: 'nonsense' })).toBe(true);
    expect(isWorkerBootstrapResult({ ...bootstrap, capabilities: { mcpServers: [{}] } })).toBe(
      true
    );
    expect(isWorkerBootstrapResult(bootstrap)).toBe(true);
  });
});
