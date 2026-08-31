import { describe, expect, it } from 'vitest';
import {
  isWorkerBootstrapPayload,
  isWorkerBootstrapResult,
  isWorkerExtensionUiResponsePayload,
  isWorkerRpcEvent,
  isWorkerRpcMessage,
  isWorkerRpcRequest,
  isWorkerRpcResponse,
  isWorkerSendPayload,
  isWorkerSendResult,
  isWorkerStopPayload,
  isWorkerStopResult,
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

    expect(
      isWorkerBootstrapResult({
        bootstrapped: true,
        logicalSessionId: 'logical-1',
        piSessionId: 'pi-1',
        cwd: '/repo',
        agentDir: '/managed/pi-agent',
        projectTrusted: false,
        permissionGate: 'bundled',
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

  it('validates send admission, stop, and Extension UI payloads', () => {
    expect(
      isWorkerSendPayload({
        logicalSessionId: 'logical-1',
        requestId: 'turn-1',
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

  it('keeps transport request identity separate from product turn identity', () => {
    const request = {
      ...base,
      kind: 'request',
      requestId: 'rpc-9',
      type: 'worker.send',
      payload: { logicalSessionId: 'logical-1', requestId: 'turn-3', text: 'hello' },
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
