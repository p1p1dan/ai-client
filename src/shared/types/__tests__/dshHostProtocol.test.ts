import { describe, expect, it } from 'vitest';
import {
  DSH_CHANNEL_OPENING_METHODS,
  DSH_CONFIGURE_TIMEOUT_MS,
  DSH_CREDENTIAL_TIMEOUT_MS,
  dshHostControlKind,
  formatDshChannelId,
  isDshChannelEnvelope,
  isDshChannelId,
  isDshHostChannelClosed,
  isDshHostCloseChannel,
  isDshHostConfigure,
  isDshHostCredentialRequest,
  isDshHostCredentialResult,
  isDshHostFatal,
  isDshHostGcRequest,
  isDshHostGcResult,
  isDshHostPage,
  isDshHostPing,
  isDshHostPong,
  isDshHostReadPageRequest,
  isDshHostReady,
  isDshHostShutdown,
  isDshHostStopped,
  opensDshChannel,
} from '../dshHostProtocol';

const rpc = (type: string, kind = 'request') => ({
  protocolVersion: 1,
  kind,
  generation: 1,
  requestId: 'rpc-1',
  type,
  payload: {},
});

describe('dshHostProtocol channel ids', () => {
  it('mints c<host generation>-<sequence> and accepts only that shape', () => {
    expect(formatDshChannelId(2, 17)).toBe('c2-17');
    expect(isDshChannelId('c2-17')).toBe(true);
    for (const bad of ['c0-1', 'c1-0', 'c-1', 'c1-', '1-1', 'c01-1', ' c1-1', 'c1-1 ', 7, null]) {
      expect(isDshChannelId(bad), String(bad)).toBe(false);
    }
    expect(() => formatDshChannelId(0, 1)).toThrow();
    expect(() => formatDshChannelId(1, 1.5)).toThrow();
  });
});

describe('dshHostProtocol envelopes', () => {
  it('accepts {ch, rpc} with a record rpc in either direction', () => {
    expect(isDshChannelEnvelope({ ch: 'c1-1', rpc: rpc('worker.send') })).toBe(true);
    expect(isDshChannelEnvelope({ ch: 'c1-1', rpc: 'text' })).toBe(false);
    expect(isDshChannelEnvelope({ ch: 'slot-1', rpc: rpc('worker.send') })).toBe(false);
    expect(isDshChannelEnvelope({ slot: 'c1-1', rpc: rpc('worker.send') })).toBe(false);
  });

  it('lets only worker.bootstrap open a channel', () => {
    expect(DSH_CHANNEL_OPENING_METHODS).toEqual(['worker.bootstrap']);
    expect(opensDshChannel(rpc('worker.bootstrap'))).toBe(true);
    for (const other of ['worker.send', 'worker.dispose', 'utility.start', 'worker.stop']) {
      expect(opensDshChannel(rpc(other)), other).toBe(false);
    }
    expect(opensDshChannel(rpc('worker.bootstrap', 'event'))).toBe(false);
    expect(opensDshChannel(null)).toBe(false);
  });
});

describe('dshHostProtocol control messages', () => {
  it('recognizes Main -> host control', () => {
    expect(isDshHostPing({ host: 'ping', id: 3 })).toBe(true);
    expect(isDshHostPing({ host: 'ping' })).toBe(false);
    expect(isDshHostPing({ host: 'ping', id: 0 })).toBe(false);
    expect(isDshHostCloseChannel({ host: 'close', ch: 'c1-2' })).toBe(true);
    expect(isDshHostCloseChannel({ host: 'close', ch: '' })).toBe(false);
    expect(isDshHostShutdown({ type: 'shutdown' })).toBe(true);
    expect(isDshHostShutdown({ host: 'shutdown' })).toBe(false);
  });

  it('requires a real pid in ready', () => {
    expect(isDshHostReady({ type: 'ready', pid: 4242, node: 'v24' })).toBe(true);
    for (const pid of [0, -1, 1.5, Number.NaN, '4242', undefined]) {
      expect(isDshHostReady({ type: 'ready', pid }), String(pid)).toBe(false);
    }
  });

  it('recognizes fatal and stopped', () => {
    expect(isDshHostFatal({ type: 'fatal', message: 'bundles skipped' })).toBe(true);
    expect(isDshHostFatal({ type: 'fatal' })).toBe(true);
    expect(isDshHostFatal({ type: 'fatal', message: 42 })).toBe(false);
    expect(isDshHostStopped({ type: 'stopped', ms: 12, reason: 'ipc' })).toBe(true);
  });

  it('validates pong numbers and channel entries', () => {
    const pong = {
      host: 'pong',
      id: 1,
      eldMaxMs: 3.5,
      rssMb: 180,
      channels: [
        { ch: 'c1-1', busy: true },
        { ch: 'c1-2', busy: false },
      ],
    };
    expect(isDshHostPong(pong)).toBe(true);
    expect(isDshHostPong({ ...pong, channels: [] })).toBe(true);
    expect(isDshHostPong({ ...pong, id: undefined })).toBe(false);
    expect(isDshHostPong({ ...pong, eldMaxMs: -1 })).toBe(false);
    expect(isDshHostPong({ ...pong, rssMb: Number.POSITIVE_INFINITY })).toBe(false);
    expect(isDshHostPong({ ...pong, channels: [{ ch: 'c1-1' }] })).toBe(false);
    expect(isDshHostPong({ ...pong, channels: [{ ch: 'x', busy: true }] })).toBe(false);
  });

  it('recognizes closed and reports unknown control kinds without accepting them', () => {
    expect(isDshHostChannelClosed({ host: 'closed', ch: 'c3-9' })).toBe(true);
    expect(isDshHostChannelClosed({ host: 'closed' })).toBe(false);
    expect(dshHostControlKind({ host: 'credential', id: 1 })).toBe('credential');
    expect(dshHostControlKind({ type: 'ready', pid: 1 })).toBeUndefined();
    expect(dshHostControlKind('ping')).toBeUndefined();
  });
});

describe('dshHostProtocol gc (P1-3d, decision 024)', () => {
  it('accepts a gc request only with an id, a claimed id list and a grace', () => {
    const request = { host: 'gc', id: 1, claimed: ['aiclient-s1'], graceMs: 86_400_000 };
    expect(isDshHostGcRequest(request)).toBe(true);
    expect(isDshHostGcRequest({ ...request, claimed: [] })).toBe(true);
    expect(isDshHostGcRequest({ ...request, id: 0 })).toBe(false);
    expect(isDshHostGcRequest({ ...request, claimed: ['aiclient-s1', 7] })).toBe(false);
    expect(isDshHostGcRequest({ ...request, claimed: 'aiclient-s1' })).toBe(false);
    expect(isDshHostGcRequest({ ...request, graceMs: -1 })).toBe(false);
    expect(isDshHostGcRequest({ host: 'gc', claimed: [] })).toBe(false);
  });

  it('accepts a gc result with known skip reasons and counts only', () => {
    const result = {
      host: 'gc-result',
      id: 3,
      ok: true,
      deleted: ['aiclient-a'],
      stubsDeleted: 1,
      skipped: { claimed: 4, content: 2, locked: 1 },
      ms: 12,
    };
    expect(isDshHostGcResult(result)).toBe(true);
    expect(isDshHostGcResult({ ...result, ok: false, deleted: [], error: 'no persistence' })).toBe(
      true
    );
    expect(isDshHostGcResult({ ...result, skipped: { swept: 1 } })).toBe(false);
    expect(isDshHostGcResult({ ...result, skipped: { claimed: -1 } })).toBe(false);
    expect(isDshHostGcResult({ ...result, deleted: [1] })).toBe(false);
    expect(isDshHostGcResult({ ...result, error: 42 })).toBe(false);
    expect(isDshHostGcResult({ ...result, id: undefined })).toBe(false);
    expect(dshHostControlKind(result)).toBe('gc-result');
  });
});

describe('dshHostProtocol readPage (P1-4a, decision 030)', () => {
  const request = {
    host: 'readPage',
    id: 4,
    stubFile: '/dsh-home/aiclient-sessions/aiclient-s1.dsh.json',
    logicalSessionId: 's1',
  };

  it('accepts a read with an id, a stub and a logical id; offset and limit as worker.history bounds them', () => {
    expect(isDshHostReadPageRequest(request)).toBe(true);
    expect(isDshHostReadPageRequest({ ...request, offset: 80, limit: 40 })).toBe(true);
    expect(isDshHostReadPageRequest({ ...request, offset: 0, limit: 500 })).toBe(true);
    for (const bad of [
      { ...request, id: 0 },
      { ...request, id: undefined },
      { ...request, stubFile: '' },
      { ...request, stubFile: 7 },
      { ...request, logicalSessionId: '' },
      { ...request, offset: -1 },
      { ...request, offset: 1.5 },
      { ...request, limit: 0 },
      { ...request, limit: 501 },
      { ...request, host: 'readpage' },
    ]) {
      expect(isDshHostReadPageRequest(bad), JSON.stringify(bad)).toBe(false);
    }
    expect(dshHostControlKind(request)).toBe('readPage');
  });

  const page = {
    messages: [
      { id: 'h:u1', role: 'user', blocks: [{ type: 'text', id: 'h:u1:text:0', text: 'hi' }] },
    ],
    offset: 0,
    limit: 80,
    totalCount: 1,
    hasMore: false,
  };

  it('accepts a page answer: ok with a page, or not ok with a coded error, never both', () => {
    expect(isDshHostPage({ host: 'page', id: 4, ok: true, page, ms: 3.2 })).toBe(true);
    expect(
      isDshHostPage({
        host: 'page',
        id: 4,
        ok: false,
        error: { code: 'dsh_session_missing', message: 'gone' },
        ms: 0,
      })
    ).toBe(true);
    for (const bad of [
      { host: 'page', id: 4, ok: true, ms: 1 },
      { host: 'page', id: 4, ok: true, page, error: { code: 'x', message: '' }, ms: 1 },
      { host: 'page', id: 4, ok: false, page, error: { code: 'x', message: '' }, ms: 1 },
      { host: 'page', id: 4, ok: false, error: { code: '', message: 'm' }, ms: 1 },
      { host: 'page', id: 4, ok: false, error: 'dsh_session_missing', ms: 1 },
      { host: 'page', id: 4, ok: true, page, ms: -1 },
      { host: 'page', ok: true, page, ms: 1 },
      { host: 'page', id: 4, ok: true, page: { ...page, limit: 501 }, ms: 1 },
      { host: 'page', id: 4, ok: true, page: { ...page, hasMore: 'no' }, ms: 1 },
      {
        host: 'page',
        id: 4,
        ok: true,
        page: { ...page, messages: [{ id: 'u1', role: 'user', blocks: [] }] },
        ms: 1,
      },
    ]) {
      expect(isDshHostPage(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('dshHostProtocol model plan and keys (P1-5, decisions 033 and 034)', () => {
  const configure = {
    host: 'configure',
    nonce: 'n-1',
    revision: 'r-1',
    routes: { gw: { models: [] } },
    defaultModel: { provider: 'gw', model: 'm1' },
    index: {},
    refs: { AICLIENT_KEY_GW_1A2B: 'gw' },
  };

  it('accepts a configure with a nonce, a revision, the plan tables and a default model', () => {
    expect(isDshHostConfigure(configure)).toBe(true);
    for (const [field, bad] of [
      ['nonce', ''],
      ['revision', undefined],
      ['routes', []],
      ['index', null],
      ['refs', { A: 1 }],
      ['defaultModel', { provider: 'gw' }],
    ] as const) {
      expect(isDshHostConfigure({ ...configure, [field]: bad }), field).toBe(false);
    }
  });

  it('accepts a credential request with an id, a reference and a nonce', () => {
    const request = { host: 'credential', id: 4, ref: 'AICLIENT_KEY_GW_1A2B', nonce: 'n-1' };
    expect(isDshHostCredentialRequest(request)).toBe(true);
    expect(isDshHostCredentialRequest({ ...request, id: 0 })).toBe(false);
    expect(isDshHostCredentialRequest({ ...request, ref: '' })).toBe(false);
    expect(isDshHostCredentialRequest({ ...request, nonce: 7 })).toBe(false);
  });

  it('accepts a result carrying a key, or a known failure, and nothing in between', () => {
    expect(
      isDshHostCredentialResult({ host: 'credential-result', id: 4, ok: true, value: 'k' })
    ).toBe(true);
    for (const error of ['unavailable', 'refused']) {
      expect(
        isDshHostCredentialResult({ host: 'credential-result', id: 4, ok: false, error })
      ).toBe(true);
    }
    expect(
      isDshHostCredentialResult({ host: 'credential-result', id: 4, ok: true, value: '' })
    ).toBe(false);
    expect(
      isDshHostCredentialResult({ host: 'credential-result', id: 4, ok: false, error: 'why' })
    ).toBe(false);
  });

  it('gives the host 10 s for configure and a key request 5 s', () => {
    expect(DSH_CONFIGURE_TIMEOUT_MS).toBe(10_000);
    expect(DSH_CREDENTIAL_TIMEOUT_MS).toBe(5_000);
  });
});
