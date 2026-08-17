/**
 * Codex app-server wire codec — line-delimited JSON-RPC 2.0, pure, zero IO.
 *
 * This module answers exactly one question per frame: WHICH of the three JSON-RPC
 * shapes is this, so the runtime knows which table to route it through. Getting
 * the answer wrong mis-routes the whole link (a server request answered into our
 * own id↔Promise table settles the wrong promise and leaves Codex waiting
 * forever), so the judgement lives here alone and is asserted against the
 * recorded frames in `__tests__/fixtures/codex/`.
 *
 * ## The classification rule, and the two things it must never do
 *
 *   id + method → server request (Codex asking US; its own id space)
 *   id, no method → response to a request WE sent
 *   no id + method → notification
 *   neither → invalid
 *
 * 1. NEVER read `jsonrpc`. Codex's direct (non-ACP) responses omit the field
 *    entirely — see `fixtures/codex/codex-handshake.jsonl` line 2, an
 *    `initialize` result with `id` + `result` and no `jsonrpc` [实测]. A codec
 *    that gates on `jsonrpc === '2.0'` drops every response the server sends.
 * 2. NEVER write `if (frame.id)`. Server request ids start at 0
 *    (`item/commandExecution/requestApproval` with `"id":0` [实测]), and `0` is
 *    falsy — a truthiness test demotes the first approval of every session to a
 *    notification, so nobody ever answers it. The checks below are `typeof`
 *    tests, which 0 passes.
 *
 * We send `jsonrpc: '2.0'` on everything, because our own recorded outbound
 * frames do [实测]; that is a separate decision from never *reading* it.
 */

export type JsonRpcId = number | string;

export interface JsonRpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

/**
 * A frame received from Codex, already sorted into the shape that decides its
 * routing. `invalid` is a value, not a throw: one malformed line must not kill
 * a session, and the caller logs it and reads the next line.
 */
export type CodexInboundFrame =
  | { kind: 'server_request'; id: JsonRpcId; method: string; params: unknown }
  | { kind: 'response'; id: JsonRpcId; result?: unknown; error?: JsonRpcErrorBody }
  | { kind: 'notification'; method: string; params: unknown }
  | { kind: 'invalid'; reason: 'not_object' | 'no_id_no_method'; raw: unknown };

/** JSON-RPC 2.0 reserved code, for refusing a server request we do not implement. */
export const JSONRPC_METHOD_NOT_FOUND = -32601;

/** Hard ceiling on one unterminated line before the framer drops it (see `createLineFramer`). */
export const MAX_FRAME_BUFFER_BYTES = 32 * 1024 * 1024;

/**
 * The method names this slice is allowed to spell.
 *
 * Evidence per entry — a name with no evidence is a guess, and a guessed method
 * fails at runtime on a machine we cannot reach:
 *
 *   initialize            [实测] fixtures/codex/codex-handshake.jsonl
 *   initialized           [读码] spikes/s1-codex-direct-probe.ts:243
 *   thread/start          [读码] spikes/s1-codex-direct-probe.ts:375
 *   turn/start            [读码] spikes/s1-codex-direct-probe.ts:383
 *   thread/status/changed [实测] fixtures (17 frames across 3 files)
 *   turn/completed        [实测] fixtures
 *   serverRequest/resolved[实测] fixtures
 *   turn/interrupt        [实测] fixtures/codex/codex-method-contract.json
 *   thread/resume         [实测] fixtures/codex/codex-method-contract.json
 *   thread/turns/list     [实测] fixtures/codex/codex-method-contract.json + a
 *                         real round trip (codex-s5-u2a-report.json
 *                         `threadTurnsList`), which is what earns it a place
 *                         here: `thread/items/list` is declared by the same
 *                         contract and answers -32601 [实测].
 *   thread/settings/updated
 *                         [实测] fixtures/codex/codex-method-contract.json
 *                         (serverNotification) + a real capture: overriding
 *                         `model` on `turn/start` broadcast one, carrying the
 *                         full 13-field `threadSettings` object
 *                         [实测 D48 06-probes §P1/§0.4]. It is the ONLY echo
 *                         of a thread's current model — `turn/start`'s own
 *                         response, `turn/started`, `turn/completed` and
 *                         `thread/read` all carry none — which is why the D48
 *                         write-back reads this frame and nothing else.
 *   thread/settings/update
 *                         [实测] fixtures/codex/codex-method-contract.json
 *                         (clientRequest) + a real round trip: changing
 *                         model/effort/approvalPolicy on an IDLE thread returned
 *                         `null` and the next turn ran under all three new
 *                         values, with the un-named `sandbox_policy` untouched
 *                         [实测 D48 06-probes §P3]. Zero turns — this is the
 *                         channel a mid-session permission change uses, so a
 *                         posture can be changed without making the user send a
 *                         message. Its param shapes are pinned separately in
 *                         `fixtures/codex/codex-settings-schema.json`, because
 *                         this server swallows unknown FIELDS as silently as it
 *                         would a renamed method.
 *
 * The last two were [未测] through slice 2a (arbitration §5 U-a/U-b) and are now
 * closed by the generated contract: `codex app-server generate-json-schema`
 * emits the binary's own method inventory, so their spelling is read off the
 * implementation rather than guessed. `codexWireContract.test.ts` pins every
 * entry below against that snapshot, which also turns a codex upgrade that
 * renames a method into a failing test instead of a runtime 'method not found'.
 */
export const CODEX_METHOD = {
  initialize: 'initialize',
  initialized: 'initialized',
  threadStart: 'thread/start',
  threadResume: 'thread/resume',
  threadTurnsList: 'thread/turns/list',
  turnStart: 'turn/start',
  turnInterrupt: 'turn/interrupt',
  threadSettingsUpdate: 'thread/settings/update',
  statusChanged: 'thread/status/changed',
  turnCompleted: 'turn/completed',
  serverRequestResolved: 'serverRequest/resolved',
  threadSettingsUpdated: 'thread/settings/updated',
} as const;

/**
 * Pending-table key, typed by construction.
 *
 * JSON-RPC 2.0 allows string ids, and both spikes wrote `pending.get(Number(id))`
 * — `Number('1') === 1`, so a string id `'1'` and a numeric id `1` collide on one
 * entry and the second arrival settles the first one's promise. Prefixing by type
 * makes that collision unrepresentable for three lines.
 */
export function idKey(id: JsonRpcId): string {
  return typeof id === 'number' ? `n:${id}` : `s:${id}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `id` if the frame carries a usable one, else null.
 *
 * `typeof` rather than truthiness (id 0 is real) and rather than `'id' in obj`
 * (a literal `"id": null` — JSON-RPC's marker for "could not even parse your
 * request" — is not an id we can key a table with, and treating it as one would
 * put a `null` in the pending map).
 */
function readId(obj: Record<string, unknown>): JsonRpcId | null {
  const id = obj.id;
  return typeof id === 'number' || typeof id === 'string' ? id : null;
}

/** `method` if present and non-empty; an empty string names nothing. */
function readMethod(obj: Record<string, unknown>): string | null {
  const method = obj.method;
  return typeof method === 'string' && method.length > 0 ? method : null;
}

/**
 * Coerce whatever sat under `error` into a body the caller can reject with.
 *
 * A malformed error body must still settle the pending request: dropping it
 * would leave the promise hanging, which is the exact failure mode the pending
 * table exists to prevent. Nothing is invented — the original value survives
 * under `data`.
 */
function normalizeErrorBody(value: unknown): JsonRpcErrorBody {
  if (!isPlainObject(value)) {
    return { code: 0, message: 'malformed JSON-RPC error body', data: value };
  }
  const body: JsonRpcErrorBody = {
    code: typeof value.code === 'number' ? value.code : 0,
    message: typeof value.message === 'string' ? value.message : 'malformed JSON-RPC error body',
  };
  if ('data' in value) body.data = value.data;
  return body;
}

/** Sort one already-parsed frame. See the module header for the rule and its two bans. */
export function classifyInboundFrame(raw: unknown): CodexInboundFrame {
  if (!isPlainObject(raw)) {
    return { kind: 'invalid', reason: 'not_object', raw };
  }
  const id = readId(raw);
  const method = readMethod(raw);

  if (id !== null && method !== null) {
    return { kind: 'server_request', id, method, params: raw.params };
  }
  if (id !== null) {
    // Typed as the response member (not the union) so the optional fields below
    // are assignable without a cast.
    const frame: Extract<CodexInboundFrame, { kind: 'response' }> = { kind: 'response', id };
    if ('result' in raw) frame.result = raw.result;
    if ('error' in raw) frame.error = normalizeErrorBody(raw.error);
    return frame;
  }
  if (method !== null) {
    return { kind: 'notification', method, params: raw.params };
  }
  return { kind: 'invalid', reason: 'no_id_no_method', raw };
}

/**
 * Parse one line into a frame.
 *
 * `ok: false` means the LINE was not JSON at all (Codex printed something to the
 * same pipe, or the framer handed us a truncated tail). A line that parses but
 * is not a frame is `ok: true` with `kind: 'invalid'` — the two are different
 * incidents and the caller logs them differently.
 */
export function parseFrameLine(
  line: string
): { ok: true; frame: CodexInboundFrame } | { ok: false; error: string } {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: 'empty line' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    return {
      ok: false,
      error: `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { ok: true, frame: classifyInboundFrame(parsed) };
}

export interface CodexLineFramer {
  /** Feed a stdout chunk; returns the lines that completed in it. */
  push(chunk: string): string[];
  /** Bytes currently held as an unterminated line. */
  buffered(): number;
  /** Sticky: this stream has lost at least one frame to the size cap. */
  overflowed(): boolean;
}

/**
 * Reassemble lines out of a byte stream.
 *
 * stdout gives no frame boundaries: one chunk can be half a line, three lines,
 * or the tail of one plus the head of another. Everything up to a `\n` is a
 * line; the remainder stays buffered.
 *
 * Overflow policy — an unterminated line past `maxBytes` is dropped and the
 * framer then skips to the next `\n`. The skip matters: without it the tail of
 * the discarded line surfaces as its own "complete line" and parses as garbage.
 * `overflowed()` latches true because the stream has permanently lost a frame,
 * which is a fact about the session (a pending request will never be answered),
 * not a transient state to clear.
 */
export function createLineFramer(maxBytes: number = MAX_FRAME_BUFFER_BYTES): CodexLineFramer {
  let buffer = '';
  let overflow = false;
  let skipToNewline = false;

  return {
    push(chunk: string): string[] {
      let input = chunk;
      if (skipToNewline) {
        const cut = input.indexOf('\n');
        if (cut === -1) return [];
        input = input.slice(cut + 1);
        skipToNewline = false;
      }
      if (input.length === 0) return [];

      buffer += input;
      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';

      const lines: string[] = [];
      for (const part of parts) {
        // Tolerate CRLF: a \r left on the line would ride into JSON.parse.
        const line = part.endsWith('\r') ? part.slice(0, -1) : part;
        // Blank lines carry no frame; dropping them here spares every consumer
        // the check and keeps `push`'s contract "one entry = one candidate frame".
        if (line.trim().length > 0) lines.push(line);
      }

      if (Buffer.byteLength(buffer, 'utf8') > maxBytes) {
        buffer = '';
        overflow = true;
        skipToNewline = true;
      }
      return lines;
    },
    buffered(): number {
      return Buffer.byteLength(buffer, 'utf8');
    },
    overflowed(): boolean {
      return overflow;
    },
  };
}

const JSONRPC_VERSION = '2.0';

/**
 * Encoders. Each returns a WIRE-READY LINE — the trailing `\n` is included, so
 * the caller writes the string as-is and cannot forget the terminator (a
 * forgotten one silently concatenates two frames into an unparseable third).
 *
 * `undefined` params are dropped by `JSON.stringify`, which is what we want: an
 * absent `params` is legal, a literal `"params": undefined` is not expressible.
 */
export function encodeRequest(id: JsonRpcId, method: string, params: unknown): string {
  return `${JSON.stringify({ jsonrpc: JSONRPC_VERSION, id, method, params })}\n`;
}

export function encodeNotification(method: string, params: unknown): string {
  return `${JSON.stringify({ jsonrpc: JSONRPC_VERSION, method, params })}\n`;
}

/**
 * A success response MUST carry `result`. `undefined` would vanish under
 * `JSON.stringify` and produce a frame that is neither success nor error, so a
 * missing value is sent as an explicit `null`.
 */
export function encodeResult(id: JsonRpcId, result: unknown): string {
  return `${JSON.stringify({
    jsonrpc: JSONRPC_VERSION,
    id,
    result: result === undefined ? null : result,
  })}\n`;
}

export function encodeError(id: JsonRpcId, code: number, message: string): string {
  return `${JSON.stringify({ jsonrpc: JSONRPC_VERSION, id, error: { code, message } })}\n`;
}
