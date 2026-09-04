import { describe, expect, it } from 'vitest';
import {
  isWorkerBootstrapPayload,
  isWorkerBootstrapResult,
  isWorkerExtensionUiResponsePayload,
  isWorkerForkPayload,
  isWorkerForkResult,
  isWorkerHistoryPayload,
  isWorkerHistoryResult,
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
    expect(
      isWorkerExtensionUiResponsePayload({
        logicalSessionId: 'logical-1',
        response: { runtimeId: 'runtime-1', uiRequestId: 'ui-1', ok: false },
      })
    ).toBe(true);
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
