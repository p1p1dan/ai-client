import { describe, expect, it } from 'vitest';
import {
  DSH_CHANNEL_OPENING_METHODS,
  DSH_COMPLETION_MAX_TIMEOUT_MS,
  DSH_COMPLETION_PURPOSES,
  DSH_CONFIGURE_TIMEOUT_MS,
  DSH_CREDENTIAL_TIMEOUT_MS,
  dshHostControlKind,
  dshSeedResultKind,
  formatDshChannelId,
  isDshChannelEnvelope,
  isDshChannelId,
  isDshCompletionPurpose,
  isDshHostChannelClosed,
  isDshHostCloseChannel,
  isDshHostCompleteCancel,
  isDshHostCompleted,
  isDshHostCompleteRequest,
  isDshHostCompletionDelta,
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
  isDshHostSeeded,
  isDshHostSeedSessionRequest,
  isDshHostShutdown,
  isDshHostStopped,
  isDshSeedStage,
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

describe('dshHostProtocol seedSession (P1-9c, decision 054)', () => {
  const request = {
    host: 'seedSession',
    id: 3,
    kind: 'pi-file',
    sourceFile: '/p/pi-agent/sessions/s1.jsonl',
    logicalSessionId: 's1',
    cwd: '/work',
  };
  const result = {
    stubFile: '/h/aiclient-sessions/aiclient-s1.dsh.json',
    dshSessionId: 'aiclient-s1',
    reused: false,
    source: { sha256: 'f'.repeat(64), bytes: 120, mtimeMs: 1790000000000.25 },
    converted: 'native-v4-copy',
    legacyPermissions: { mode: 'agent', gear: 'ask' },
    grants: 2,
    images: { admitted: 1, refused: 0 },
    report: { converterVersion: 2, source: { kind: 'pi-session', generation: 'pi-v3' } },
  };

  it('accepts a pi-file request, with or without Main’s stat', () => {
    expect(isDshHostSeedSessionRequest(request)).toBe(true);
    expect(
      isDshHostSeedSessionRequest({ ...request, expect: { bytes: 0, mtimeMs: 1790000000000.5 } })
    ).toBe(true);
  });

  it.each([
    ['another host kind', { ...request, host: 'readPage' }],
    ['no id', { ...request, id: 0 }],
    ['an import without its conversation', { ...request, kind: 'imported-conversation' }],
    ['an unknown source kind', { ...request, kind: 'claude-file' }],
    ['an empty source file', { ...request, sourceFile: '' }],
    ['no logical id', { ...request, logicalSessionId: undefined }],
    ['an empty cwd', { ...request, cwd: '' }],
    ['a stat with a negative size', { ...request, expect: { bytes: -1, mtimeMs: 0 } }],
    ['a stat with a fractional size', { ...request, expect: { bytes: 1.5, mtimeMs: 0 } }],
    ['a stat without mtime', { ...request, expect: { bytes: 1 } }],
    ['a stat that is a list', { ...request, expect: [1, 2] }],
  ])('refuses a request with %s', (_label, bad) => {
    expect(isDshHostSeedSessionRequest(bad)).toBe(false);
  });

  it('accepts a seeded answer: a result, or where it stopped', () => {
    expect(isDshHostSeeded({ host: 'seeded', id: 3, ok: true, result, ms: 12.5 })).toBe(true);
    expect(
      isDshHostSeeded({
        host: 'seeded',
        id: 3,
        ok: true,
        result: { ...result, converted: 'source', legacyPermissions: null, grants: 0 },
        ms: 0,
      })
    ).toBe(true);
    expect(
      isDshHostSeeded({
        host: 'seeded',
        id: 3,
        ok: false,
        error: { stage: 'read', code: 'source_busy', message: 'changed', retryable: true },
        ms: 1,
      })
    ).toBe(true);
  });

  it.each([
    ['ok without a result', { host: 'seeded', id: 3, ok: true, ms: 1 }],
    [
      'ok with an error beside the result',
      { host: 'seeded', id: 3, ok: true, result, error: {}, ms: 1 },
    ],
    [
      'a short sha256',
      {
        host: 'seeded',
        id: 3,
        ok: true,
        result: { ...result, source: { ...result.source, sha256: 'ab' } },
        ms: 1,
      },
    ],
    [
      'an unknown conversion',
      { host: 'seeded', id: 3, ok: true, result: { ...result, converted: 'guess' }, ms: 1 },
    ],
    [
      'a negative image count',
      {
        host: 'seeded',
        id: 3,
        ok: true,
        result: { ...result, images: { admitted: -1, refused: 0 } },
        ms: 1,
      },
    ],
    [
      'an unknown stage',
      {
        host: 'seeded',
        id: 3,
        ok: false,
        error: { stage: 'guess', code: 'x', message: '', retryable: false },
        ms: 1,
      },
    ],
    [
      'a failure without retryable',
      { host: 'seeded', id: 3, ok: false, error: { stage: 'read', code: 'x', message: '' }, ms: 1 },
    ],
    [
      'a failure with a result',
      {
        host: 'seeded',
        id: 3,
        ok: false,
        result,
        error: { stage: 'read', code: 'x', message: '', retryable: false },
        ms: 1,
      },
    ],
    ['no time', { host: 'seeded', id: 3, ok: true, result }],
  ])('refuses an answer with %s', (_label, bad) => {
    expect(isDshHostSeeded(bad)).toBe(false);
  });

  it('knows the nine stages of plan P1-9 shard 02 §5 and the request', () => {
    for (const stage of [
      'request',
      'read',
      'decode',
      'build',
      'admit',
      'create',
      'verify',
      'sidecar',
      'stub',
    ])
      expect(isDshSeedStage(stage), stage).toBe(true);
    expect(isDshSeedStage('commit')).toBe(false);
  });
});

/**
 * P1-9f (decision 056): the same message for a Claude Code / Codex
 * conversation. Its full shape is the host's to check; here only that it is
 * one, and that an import's answer cannot pass for a migration's.
 */
describe('dshHostProtocol seedSession for an import (P1-9f, decision 056)', () => {
  const request = {
    host: 'seedSession',
    id: 4,
    kind: 'imported-conversation',
    conversation: { schemaVersion: 1, entries: [{ kind: 'user', text: 'hi' }] },
    logicalSessionId: 'session-import-codex-1',
    cwd: '/work',
  };
  const result = {
    kind: 'imported-conversation',
    stubFile: '/h/aiclient-sessions/aiclient-session-import-codex-1.dsh.json',
    dshSessionId: 'aiclient-session-import-codex-1',
    reused: false,
    images: { admitted: 0, refused: 0 },
    report: { converterVersion: 2, source: { kind: 'imported-conversation', generation: 'codex' } },
  };

  it('accepts an import request', () => {
    expect(isDshHostSeedSessionRequest(request)).toBe(true);
  });

  it.each([
    ['no conversation', { ...request, conversation: undefined }],
    ['a conversation without entries', { ...request, conversation: { schemaVersion: 1 } }],
    ['a conversation that is a list', { ...request, conversation: [] }],
    ['a source file beside it', { ...request, sourceFile: '/p/s1.jsonl' }],
    ['no logical id', { ...request, logicalSessionId: '' }],
    ['no cwd', { ...request, cwd: undefined }],
  ])('refuses an import request with %s', (_label, bad) => {
    expect(isDshHostSeedSessionRequest(bad)).toBe(false);
  });

  it('accepts an import answer and tells it from a migration answer', () => {
    const answer = { host: 'seeded', id: 4, ok: true, result, ms: 3 };
    expect(isDshHostSeeded(answer)).toBe(true);
    expect(dshSeedResultKind(result as never)).toBe('imported-conversation');
    expect(
      dshSeedResultKind({
        stubFile: '/h/aiclient-sessions/aiclient-s1.dsh.json',
        dshSessionId: 'aiclient-s1',
      } as never)
    ).toBe('pi-file');
  });

  it.each([
    ['an unknown kind', { ...result, kind: 'claude-file' }],
    ['no stub', { ...result, stubFile: '' }],
    ['no reused flag', { ...result, reused: undefined }],
    ['a negative image count', { ...result, images: { admitted: 0, refused: -1 } }],
    ['no report', { ...result, report: undefined }],
  ])('refuses an import answer with %s', (_label, bad) => {
    expect(isDshHostSeeded({ host: 'seeded', id: 4, ok: true, result: bad, ms: 1 })).toBe(false);
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

/**
 * P1-15 (decisions 039, 125): a one-shot completion is a host control of its
 * own — no channel, no session — answered by one `completed`.
 */
describe('dshHostProtocol one-shot completions (P1-15, decision 125)', () => {
  const request = {
    host: 'complete',
    id: 3,
    purpose: 'commit-message',
    prompt: 'Write a commit message for this diff.',
    timeoutMs: 30_000,
  };

  it('knows the three purposes and nothing else', () => {
    expect(DSH_COMPLETION_PURPOSES).toEqual(['commit-message', 'branch-name', 'code-review']);
    for (const purpose of DSH_COMPLETION_PURPOSES)
      expect(isDshCompletionPurpose(purpose)).toBe(true);
    for (const bad of ['title', '', 'Commit-Message', 3, null]) {
      expect(isDshCompletionPurpose(bad), String(bad)).toBe(false);
    }
  });

  it('accepts a request with a purpose, a prompt and a deadline; model, effort and stream optional', () => {
    expect(isDshHostCompleteRequest(request)).toBe(true);
    expect(
      isDshHostCompleteRequest({
        ...request,
        purpose: 'code-review',
        model: 'gw/m1',
        effort: 'high',
        stream: true,
      })
    ).toBe(true);
    // Any effort word passes the shape check; the host's router reads the vocabulary.
    expect(isDshHostCompleteRequest({ ...request, effort: 'default' })).toBe(true);
    expect(isDshHostCompleteRequest({ ...request, timeoutMs: DSH_COMPLETION_MAX_TIMEOUT_MS })).toBe(
      true
    );
  });

  it.each([
    ['no id', { id: undefined }],
    ['a zero id', { id: 0 }],
    ['an unknown purpose', { purpose: 'title' }],
    ['an empty prompt', { prompt: '' }],
    ['a prompt that is not text', { prompt: ['x'] }],
    ['an empty model', { model: '' }],
    ['an empty effort', { effort: '' }],
    ['no deadline', { timeoutMs: undefined }],
    ['a fractional deadline', { timeoutMs: 1.5 }],
    ['a deadline setTimeout cannot hold', { timeoutMs: DSH_COMPLETION_MAX_TIMEOUT_MS + 1 }],
    ['a stream flag that is not boolean', { stream: 'yes' }],
  ])('refuses a request with %s', (_label, patch) => {
    expect(isDshHostCompleteRequest({ ...request, ...patch })).toBe(false);
  });

  it('accepts a cancel and a delta by id', () => {
    expect(isDshHostCompleteCancel({ host: 'complete-cancel', id: 3 })).toBe(true);
    expect(isDshHostCompleteCancel({ host: 'complete-cancel' })).toBe(false);
    expect(isDshHostCompletionDelta({ host: 'completion-delta', id: 3, text: 'fe' })).toBe(true);
    expect(isDshHostCompletionDelta({ host: 'completion-delta', id: 3, text: '' })).toBe(true);
    expect(isDshHostCompletionDelta({ host: 'completion-delta', id: 3 })).toBe(false);
    expect(isDshHostCompletionDelta({ host: 'completion-delta', id: -1, text: 'x' })).toBe(false);
  });

  it('accepts an answer: the text and model, or a coded error, never both', () => {
    const ok = { host: 'completed', id: 3, ok: true, text: 'feat: x', model: 'gw/m1', ms: 12 };
    expect(isDshHostCompleted(ok)).toBe(true);
    expect(isDshHostCompleted({ ...ok, text: '' })).toBe(true);
    const failed = {
      host: 'completed',
      id: 3,
      ok: false,
      error: { code: 'CREDENTIALS_UNAVAILABLE', message: 'no key', dshCode: 'MISSING_CREDENTIAL' },
      ms: 1,
    };
    expect(isDshHostCompleted(failed)).toBe(true);
    const { dshCode: _dsh, ...plain } = failed.error;
    expect(isDshHostCompleted({ ...failed, error: plain })).toBe(true);
    for (const [label, bad] of [
      ['ok without text', { ...ok, text: undefined }],
      ['ok with an error', { ...ok, error: failed.error }],
      ['an empty model', { ...ok, model: '' }],
      ['no ms', { ...ok, ms: undefined }],
      ['a failure with text', { ...failed, text: 'x' }],
      ['a failure without a code', { ...failed, error: { message: 'x' } }],
      ['a failure with an empty dshCode', { ...failed, error: { ...failed.error, dshCode: '' } }],
    ] as const) {
      expect(isDshHostCompleted(bad), label).toBe(false);
    }
  });

  it('reports the new kinds by name, and none of them opens a channel', () => {
    expect(dshHostControlKind(request)).toBe('complete');
    expect(dshHostControlKind({ host: 'completed', id: 1 })).toBe('completed');
    expect(opensDshChannel(rpc('utility.start'))).toBe(false);
    expect(DSH_CHANNEL_OPENING_METHODS).not.toContain('utility.start');
  });
});
