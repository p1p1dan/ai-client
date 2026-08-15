import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CODEX_METHOD,
  classifyInboundFrame,
  createLineFramer,
  encodeError,
  encodeNotification,
  encodeRequest,
  encodeResult,
  idKey,
  JSONRPC_METHOD_NOT_FOUND,
  MAX_FRAME_BUFFER_BYTES,
  parseFrameLine,
} from '../codexWire.ts';

/**
 * S3 slice 2a — the wire codec, driven by the recorded Codex frames in
 * `fixtures/codex/` (real traffic, paid for in real quota; the originals are
 * gone, see that directory's README).
 *
 * Each assertion below names what it FALSIFIES, because a codec test that only
 * confirms the happy shape would have passed for both bugs this module exists
 * to prevent: reading `jsonrpc`, and `if (frame.id)`.
 */

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/codex/', import.meta.url));

interface Envelope {
  dir: '->' | '<-';
  tMs: number | null;
  raw: unknown;
}

/** The fixtures wrap each frame in a `{dir, tMs, raw}` envelope — the frame is `.raw`. */
function readEnvelopes(file: string): Envelope[] {
  return readFileSync(`${FIXTURE_DIR}${file}`, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Envelope);
}

function fixtureFiles(): string[] {
  return readdirSync(FIXTURE_DIR)
    .filter((name) => name.endsWith('.jsonl'))
    .sort();
}

function allEnvelopes(): Array<{ file: string; envelope: Envelope }> {
  return fixtureFiles().flatMap((file) =>
    readEnvelopes(file).map((envelope) => ({ file, envelope }))
  );
}

/** Frames Codex sent US — the only direction `classifyInboundFrame` judges. */
function inboundFrames(): Array<{ file: string; raw: unknown }> {
  return allEnvelopes()
    .filter(({ envelope }) => envelope.dir === '<-')
    .map(({ file, envelope }) => ({ file, raw: envelope.raw }));
}

// ---------------------------------------------------------------------------
// Recorded traffic (standard #8: a real sample becomes a regression case)
// ---------------------------------------------------------------------------

describe('classifyInboundFrame — recorded Codex traffic', () => {
  it('sorts every recorded inbound frame, with none falling through to invalid', () => {
    const counts = { server_request: 0, response: 0, notification: 0, invalid: 0 };
    const rejected: unknown[] = [];

    for (const { raw } of inboundFrames()) {
      const frame = classifyInboundFrame(raw);
      counts[frame.kind] += 1;
      if (frame.kind === 'invalid') rejected.push(raw);
    }

    // Falsifies "the classifier drops real frames": every one of the 93 recorded
    // inbound frames must land in a routable bucket. The per-kind totals are
    // pinned rather than just `invalid === 0` so that a classifier which sorts
    // everything into one bucket (e.g. by never finding `id`) still fails.
    expect(rejected).toEqual([]);
    expect(counts).toEqual({
      server_request: 3,
      response: 10,
      notification: 80,
      invalid: 0,
    });
  });

  it('is reading the fixtures it claims to', () => {
    // Falsifies a vacuous pass: if the loader path broke, or a fixture were
    // emptied, the sweep above would assert `[] === []` and stay green.
    const files = fixtureFiles();
    expect(files.length).toBe(7);
    for (const file of files) {
      expect(readEnvelopes(file).filter((e) => e.dir === '<-').length).toBeGreaterThan(0);
    }
    expect(inboundFrames().length).toBe(93);
  });

  it('reads a server request whose id is 0 as a request, not a notification', () => {
    // `item/commandExecution/requestApproval` with `"id":0` — Codex's server
    // request ids start at 0. Falsifies `if (frame.id)`: under a truthiness
    // test this frame becomes a notification, nobody answers the approval, and
    // the turn hangs on `waitingOnApproval` forever.
    const approval = inboundFrames()
      .map(({ raw }) => raw as Record<string, unknown>)
      .find((raw) => raw.method === 'item/commandExecution/requestApproval');
    expect(approval).toBeDefined();
    expect(approval?.id).toBe(0);

    const frame = classifyInboundFrame(approval);
    expect(frame.kind).toBe('server_request');
    expect(frame).toMatchObject({ kind: 'server_request', id: 0 });
  });

  it('reads a response that omits the jsonrpc field', () => {
    // The recorded `initialize` result carries `id` + `result` and NO `jsonrpc`.
    // Falsifies gating on `jsonrpc === '2.0'`: that codec would discard every
    // response Codex sends on the direct (non-ACP) path, so no request we make
    // would ever settle.
    const [initializeResult] = readEnvelopes('codex-handshake.jsonl').filter(
      (e) => e.dir === '<-' && (e.raw as Record<string, unknown>).result !== undefined
    );
    expect(initializeResult).toBeDefined();
    expect(initializeResult?.raw).not.toHaveProperty('jsonrpc');

    const frame = classifyInboundFrame(initializeResult?.raw);
    expect(frame.kind).toBe('response');
    expect(frame).toMatchObject({ kind: 'response', id: 1 });
  });

  it('leaves the one reassembled fragment in the corpus outside the frame space', () => {
    // `codex-command-approval.jsonl` holds one outbound line whose `raw` is the
    // approval DECISION body (`{"decision":"decline"}`), not a JSON-RPC frame —
    // the transcript rescue kept the payload, not the envelope (see the fixture
    // README). Asserting it is `invalid` keeps the sweep above honest: the
    // corpus is not uniformly well-formed, so "no invalid frames" is a claim
    // about the inbound direction only, not a tautology.
    const fragments = allEnvelopes()
      .filter(({ envelope }) => envelope.dir === '->')
      .map(({ envelope }) => classifyInboundFrame(envelope.raw))
      .filter((frame) => frame.kind === 'invalid');
    expect(fragments).toEqual([
      { kind: 'invalid', reason: 'no_id_no_method', raw: { decision: 'decline' } },
    ]);
  });

  it('pins CODEX_METHOD to names with evidence', () => {
    const methodsInCorpus = new Set(
      allEnvelopes()
        .map(({ envelope }) => (envelope.raw as Record<string, unknown>).method)
        .filter((method): method is string => typeof method === 'string')
    );

    // The four the fixtures attest to [实测].
    for (const method of [
      CODEX_METHOD.initialize,
      CODEX_METHOD.statusChanged,
      CODEX_METHOD.turnCompleted,
      CODEX_METHOD.serverRequestResolved,
    ]) {
      expect(methodsInCorpus.has(method)).toBe(true);
    }

    // `turn/interrupt` and `thread/resume` were held out of this table while
    // they were [未测] (arbitration §5 U-a/U-b). The condition that gated them
    // has since been met — the generated contract landed as a fixture — so the
    // rule they were protecting moved rather than disappeared: EVERY name in
    // this table must now be attested by either the recorded corpus or that
    // contract. `codexWireContract.test.ts` owns the contract half; keeping the
    // bar here as "no unattested names" is what stops the next addition from
    // being a guess.
    const values: readonly string[] = Object.values(CODEX_METHOD);
    expect(values).toContain('turn/interrupt');
    expect(values).toContain('thread/resume');
    expect(values.length).toBe(new Set(values).size);
  });
});

// ---------------------------------------------------------------------------
// Classification rule, in isolation
// ---------------------------------------------------------------------------

describe('classifyInboundFrame — the rule', () => {
  it('treats id + method as a server request even when the id is 0 or empty-string', () => {
    // Constructed control for the two falsy ids JavaScript has. 0 is [实测]
    // (Codex starts there); `''` is defensive — a truthiness check fails both.
    expect(classifyInboundFrame({ id: 0, method: 'x' })).toEqual({
      kind: 'server_request',
      id: 0,
      method: 'x',
      params: undefined,
    });
    expect(classifyInboundFrame({ id: '', method: 'x', params: { a: 1 } })).toEqual({
      kind: 'server_request',
      id: '',
      method: 'x',
      params: { a: 1 },
    });
  });

  it('treats id without method as a response, with or without jsonrpc', () => {
    expect(classifyInboundFrame({ id: 7, result: null })).toEqual({
      kind: 'response',
      id: 7,
      result: null,
    });
    expect(classifyInboundFrame({ jsonrpc: '2.0', id: 'a', result: 1 })).toEqual({
      kind: 'response',
      id: 'a',
      result: 1,
    });
  });

  it('never consults jsonrpc: a frame carrying only jsonrpc is invalid', () => {
    // Falsifies "the version field participates in routing" from the other
    // side — a well-versioned frame with neither id nor method is still junk.
    expect(classifyInboundFrame({ jsonrpc: '2.0' })).toEqual({
      kind: 'invalid',
      reason: 'no_id_no_method',
      raw: { jsonrpc: '2.0' },
    });
  });

  it('treats method without id as a notification', () => {
    expect(classifyInboundFrame({ method: CODEX_METHOD.statusChanged, params: { a: 1 } })).toEqual({
      kind: 'notification',
      method: CODEX_METHOD.statusChanged,
      params: { a: 1 },
    });
  });

  it('rejects non-objects as not_object, arrays included', () => {
    for (const raw of [null, undefined, 42, 'str', true, [{ id: 1, method: 'x' }]]) {
      expect(classifyInboundFrame(raw)).toEqual({ kind: 'invalid', reason: 'not_object', raw });
    }
  });

  it('does not accept a null or non-scalar id as an id', () => {
    // `"id": null` is JSON-RPC's "I could not parse your request" marker, not a
    // key. Falsifies `'id' in obj`: that test would file this as a response and
    // put `null` into the pending table, where nothing can ever match it.
    expect(classifyInboundFrame({ id: null, result: 1 })).toMatchObject({
      kind: 'invalid',
      reason: 'no_id_no_method',
    });
    expect(classifyInboundFrame({ id: null, method: 'x' })).toEqual({
      kind: 'notification',
      method: 'x',
      params: undefined,
    });
    expect(classifyInboundFrame({ id: { n: 1 }, result: 1 })).toMatchObject({ kind: 'invalid' });
  });

  it('does not accept an empty method as a method', () => {
    expect(classifyInboundFrame({ method: '', params: 1 })).toMatchObject({
      kind: 'invalid',
      reason: 'no_id_no_method',
    });
    expect(classifyInboundFrame({ id: 4, method: '' })).toMatchObject({ kind: 'response' });
  });

  it('distinguishes a missing result from a null one', () => {
    // Falsifies `result ?? undefined` style normalization: `{id, result: null}`
    // is a successful response, `{id}` alone is a malformed one, and a pending
    // table that cannot tell them apart resolves a failed call as success.
    expect(classifyInboundFrame({ id: 1, result: null })).toHaveProperty('result', null);
    expect(classifyInboundFrame({ id: 1 })).not.toHaveProperty('result');
  });

  it('carries an error body through, and normalizes a malformed one instead of dropping it', () => {
    expect(
      classifyInboundFrame({ id: 1, error: { code: -32601, message: 'nope', data: 'x' } })
    ).toEqual({ kind: 'response', id: 1, error: { code: -32601, message: 'nope', data: 'x' } });
    // Falsifies "ignore an error body we cannot read": the pending request must
    // still settle, or the renderer waits forever on a call that already failed.
    expect(classifyInboundFrame({ id: 1, error: 'boom' })).toEqual({
      kind: 'response',
      id: 1,
      error: { code: 0, message: 'malformed JSON-RPC error body', data: 'boom' },
    });
  });
});

// ---------------------------------------------------------------------------
// idKey
// ---------------------------------------------------------------------------

describe('idKey', () => {
  it('keeps a string id and the equal-looking number id apart', () => {
    // Falsifies `pending.get(Number(id))` (what both spikes wrote):
    // `Number('1') === 1`, so `'1'` and `1` would share one pending entry and
    // the second response would settle the first request's promise.
    expect(idKey('1')).toBe('s:1');
    expect(idKey(1)).toBe('n:1');
    expect(idKey('1')).not.toBe(idKey(1));
  });

  it('produces a non-empty key for id 0 and the empty string', () => {
    expect(idKey(0)).toBe('n:0');
    expect(idKey('')).toBe('s:');
  });
});

// ---------------------------------------------------------------------------
// parseFrameLine
// ---------------------------------------------------------------------------

describe('parseFrameLine', () => {
  it('parses a recorded line', () => {
    const line = JSON.stringify({ method: CODEX_METHOD.turnCompleted, params: { turn: {} } });
    const result = parseFrameLine(line);
    expect(result).toEqual({
      ok: true,
      frame: { kind: 'notification', method: CODEX_METHOD.turnCompleted, params: { turn: {} } },
    });
  });

  it('reports non-JSON as a line failure rather than throwing', () => {
    // Codex's stdout is shared with anything its launcher prints; a stray line
    // must not take the session down.
    const result = parseFrameLine('Debugger attached.');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('invalid JSON');
  });

  it('reports a blank line as a line failure', () => {
    expect(parseFrameLine('   ')).toEqual({ ok: false, error: 'empty line' });
  });

  it('separates "not JSON" from "JSON but not a frame"', () => {
    // Falsifies collapsing the two: a truncated pipe and a protocol violation
    // are different incidents, and only the second is worth reporting upstream.
    const result = parseFrameLine('{"hello":1}');
    expect(result).toEqual({
      ok: true,
      frame: { kind: 'invalid', reason: 'no_id_no_method', raw: { hello: 1 } },
    });
  });
});

// ---------------------------------------------------------------------------
// createLineFramer
// ---------------------------------------------------------------------------

describe('createLineFramer', () => {
  it('holds a half line until its newline arrives', () => {
    const framer = createLineFramer();
    expect(framer.push('{"method":"turn/')).toEqual([]);
    expect(framer.buffered()).toBeGreaterThan(0);
    expect(framer.push('completed"}\n')).toEqual(['{"method":"turn/completed"}']);
    expect(framer.buffered()).toBe(0);
  });

  it('splits several frames delivered in one chunk, keeping the trailing partial', () => {
    // The recorded turns emit bursts at the same millisecond (three frames at
    // `tMs: 11236`), so multi-frame chunks are the normal case, not the edge.
    const framer = createLineFramer();
    expect(framer.push('{"a":1}\n{"b":2}\n{"c":')).toEqual(['{"a":1}', '{"b":2}']);
    expect(framer.buffered()).toBe(5);
  });

  it('drops blank and CRLF-terminated lines cleanly', () => {
    const framer = createLineFramer();
    // Falsifies emitting whitespace as a frame (every consumer would need its
    // own blank check) and falsifies leaving `\r` on the line (JSON.parse
    // tolerates it here, but the raw line is also what gets logged).
    expect(framer.push('\n\n  \n{"a":1}\r\n')).toEqual(['{"a":1}']);
  });

  it('drops an oversized line, latches overflowed, and resyncs at the next newline', () => {
    const framer = createLineFramer(16);
    expect(framer.push('x'.repeat(64))).toEqual([]);
    expect(framer.overflowed()).toBe(true);
    expect(framer.buffered()).toBe(0);

    // Falsifies "clear the buffer and carry on": without the resync the tail of
    // the discarded line surfaces as its own line and parses as garbage.
    expect(framer.push('tail-of-the-dropped-line\n{"a":1}\n')).toEqual(['{"a":1}']);
    // Latched: the stream permanently lost a frame, which the caller must be
    // able to report even after it recovers.
    expect(framer.overflowed()).toBe(true);
  });

  it('measures the buffer in bytes, not characters', () => {
    // Falsifies `buffer.length` as the cap: a UTF-8 diff of multi-byte text
    // would be allowed roughly 3x the intended memory.
    const framer = createLineFramer();
    framer.push('你好');
    expect(framer.buffered()).toBe(6);
  });

  it('defaults its cap to MAX_FRAME_BUFFER_BYTES', () => {
    const framer = createLineFramer();
    framer.push('y'.repeat(1_000_000));
    expect(framer.overflowed()).toBe(false);
    expect(MAX_FRAME_BUFFER_BYTES).toBe(32 * 1024 * 1024);
  });
});

// ---------------------------------------------------------------------------
// Encoders
// ---------------------------------------------------------------------------

describe('encoders', () => {
  it('emits one wire-ready line per frame', () => {
    // The trailing newline is part of the returned string — falsifies a caller
    // having to remember it, which would concatenate two frames into one
    // unparseable line.
    for (const line of [
      encodeRequest(1, CODEX_METHOD.threadStart, { cwd: '/tmp' }),
      encodeNotification(CODEX_METHOD.initialized, {}),
      encodeResult(0, { answers: {} }),
      encodeError(0, JSONRPC_METHOD_NOT_FOUND, 'unsupported'),
    ]) {
      expect(line.endsWith('\n')).toBe(true);
      expect(line.split('\n').filter((part) => part.length > 0).length).toBe(1);
    }
  });

  it('stamps jsonrpc 2.0 on everything we send', () => {
    // We never READ this field (see the classifier), but our own recorded
    // outbound frames carry it, so we keep sending it.
    expect(JSON.parse(encodeRequest(1, 'm', null))).toMatchObject({ jsonrpc: '2.0' });
    expect(JSON.parse(encodeNotification('m', null))).toMatchObject({ jsonrpc: '2.0' });
    expect(JSON.parse(encodeResult(1, null))).toMatchObject({ jsonrpc: '2.0' });
    expect(JSON.parse(encodeError(1, -1, 'e'))).toMatchObject({ jsonrpc: '2.0' });
  });

  it('omits params entirely when there are none', () => {
    expect(JSON.parse(encodeRequest(3, 'm', undefined))).toEqual({
      jsonrpc: '2.0',
      id: 3,
      method: 'm',
    });
    expect(JSON.parse(encodeNotification('m', undefined))).toEqual({ jsonrpc: '2.0', method: 'm' });
  });

  it('never lets a notification carry an id', () => {
    // Falsifies a copy-paste of `encodeRequest`: an id on a notification makes
    // Codex treat it as a request and wait for a response we will never send.
    const encoded = JSON.parse(encodeNotification(CODEX_METHOD.initialized, {})) as object;
    expect('id' in encoded).toBe(false);
  });

  it('sends an explicit null result rather than an empty response', () => {
    // Falsifies passing `undefined` through: `JSON.stringify` would drop the
    // key and produce a frame that is neither a success nor an error.
    const encoded = JSON.parse(encodeResult(2, undefined)) as object;
    expect(encoded).toEqual({ jsonrpc: '2.0', id: 2, result: null });
    expect('result' in encoded).toBe(true);
  });

  it('round-trips through its own classifier', () => {
    // The codec's two halves must agree: what we encode as a request must be
    // readable as a request, or the peer-side symmetry assumption is wrong.
    const roundTrip = (line: string) => parseFrameLine(line.trimEnd());
    expect(roundTrip(encodeRequest('s1', 'm', { a: 1 }))).toEqual({
      ok: true,
      frame: { kind: 'server_request', id: 's1', method: 'm', params: { a: 1 } },
    });
    expect(roundTrip(encodeNotification('m', { a: 1 }))).toEqual({
      ok: true,
      frame: { kind: 'notification', method: 'm', params: { a: 1 } },
    });
    expect(roundTrip(encodeResult(0, { ok: true }))).toEqual({
      ok: true,
      frame: { kind: 'response', id: 0, result: { ok: true } },
    });
    expect(roundTrip(encodeError(0, JSONRPC_METHOD_NOT_FOUND, 'unsupported'))).toEqual({
      ok: true,
      frame: {
        kind: 'response',
        id: 0,
        error: { code: JSONRPC_METHOD_NOT_FOUND, message: 'unsupported' },
      },
    });
  });

  it('pins the method-not-found code', () => {
    expect(JSONRPC_METHOD_NOT_FOUND).toBe(-32601);
  });
});
