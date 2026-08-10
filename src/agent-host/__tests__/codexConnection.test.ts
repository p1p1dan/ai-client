import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CODEX_REQUEST_TIMEOUT_MS,
  CodexConnectionClosedError,
  type CodexConnectionCore,
  CodexRpcError,
  createCodexConnection,
  spawnCodexConnection,
} from '../codexConnection.ts';
import { JSONRPC_METHOD_NOT_FOUND, type JsonRpcId } from '../codexWire.ts';

/**
 * S3 slice 2a — the JSON-RPC link to `codex app-server`.
 *
 * Every test drives `createCodexConnection`, which is the same routing core
 * `spawnCodexConnection` runs; only the transport differs (in-memory here, a
 * child process there). A fake link written for the tests would have proved
 * nothing about the shipped one.
 *
 * The failure family this file exists for is "a promise nobody will ever
 * settle": a mis-routed response, a table cleared without rejecting, a request
 * registered on a dead connection. Each test names the shape it falsifies.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures', 'codex');

interface Link {
  core: CodexConnectionCore;
  writes: string[];
  /** Ordered transcript of transport operations — the only way to assert order. */
  ops: string[];
  serverRequests: Array<{ id: JsonRpcId; method: string; params: unknown }>;
  notifications: Array<{ method: string; params: unknown }>;
  stderr: string[];
  exits: Array<{ code: number | null; signal: string | null }>;
  logs: string[];
  /** Parsed view of what we wrote, in order. */
  sent(): Array<Record<string, unknown>>;
}

function makeLink(hooks: { onKill?: (link: Link) => void } = {}): Link {
  const link = {
    writes: [] as string[],
    ops: [] as string[],
    serverRequests: [] as Array<{ id: JsonRpcId; method: string; params: unknown }>,
    notifications: [] as Array<{ method: string; params: unknown }>,
    stderr: [] as string[],
    exits: [] as Array<{ code: number | null; signal: string | null }>,
    logs: [] as string[],
    sent(): Array<Record<string, unknown>> {
      return link.writes.map((line) => JSON.parse(line) as Record<string, unknown>);
    },
  } as Link;

  link.core = createCodexConnection({
    transport: {
      pid: 4242,
      write: (line) => {
        link.writes.push(line);
        link.ops.push(`write:${(JSON.parse(line) as { method?: string }).method ?? 'response'}`);
      },
      kill: (reason) => {
        link.ops.push(`kill:${reason}`);
        hooks.onKill?.(link);
      },
    },
    handlers: {
      onServerRequest: (req) => link.serverRequests.push(req),
      onNotification: (n) => link.notifications.push(n),
      onStderr: (line) => link.stderr.push(line),
      onExit: (info) => link.exits.push(info),
    },
    log: (...args) => link.logs.push(args.map((a) => JSON.stringify(a) ?? String(a)).join(' ')),
  });
  return link;
}

/** One inbound frame, as codex would write it. */
function inbound(frame: Record<string, unknown>): string {
  return `${JSON.stringify(frame)}\n`;
}

describe('codexConnection — outbound requests use OUR id space', () => {
  it('writes one newline-terminated JSON-RPC request per call, and does not double-terminate', () => {
    // Falsifies a caller re-appending `\n` (the encoders already do) — two
    // terminators produce an empty line, and a missing one glues two frames
    // into an unparseable third.
    const link = makeLink();
    void link.core.connection.request('initialize', { a: 1 });

    expect(link.writes).toHaveLength(1);
    expect(link.writes[0].endsWith('\n')).toBe(true);
    expect(link.writes[0].endsWith('\n\n')).toBe(false);
    expect(link.sent()[0]).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { a: 1 },
    });
  });

  it('numbers our requests from 1 upward and never reuses an id', () => {
    // Falsifies "start at 0 like the server does": ids from the two spaces are
    // then indistinguishable in a traffic log, which is how the shared-table bug
    // stayed invisible in both spikes.
    const link = makeLink();
    void link.core.connection.request('a', {});
    void link.core.connection.request('b', {});
    void link.core.connection.request('c', {});

    expect(link.sent().map((frame) => frame.id)).toEqual([1, 2, 3]);
  });

  it('resolves the matching promise with the result member', async () => {
    const link = makeLink();
    const pending = link.core.connection.request('initialize', {});
    link.core.pushStdout(inbound({ id: 1, result: { codexHome: '/tmp/home' } }));

    await expect(pending).resolves.toEqual({ codexHome: '/tmp/home' });
  });

  it('rejects with the JSON-RPC code when codex answers with an error body', async () => {
    // Falsifies swallowing the code: -32601 means OUR method spelling is wrong
    // (several are [未测]), which is a different incident from a server-side
    // failure of a method that exists.
    const link = makeLink();
    const pending = link.core.connection.request('thread/resume', {});
    link.core.pushStdout(
      inbound({ id: 1, error: { code: JSONRPC_METHOD_NOT_FOUND, message: 'no such method' } })
    );

    await expect(pending).rejects.toBeInstanceOf(CodexRpcError);
    await expect(pending).rejects.toMatchObject({ code: JSONRPC_METHOD_NOT_FOUND });
  });

  it('keeps a server request with the SAME numeric id as an in-flight call out of our table', async () => {
    // THE headline invariant. Codex numbers its own requests from 0 and we
    // number ours from 1, so a collision is a matter of time. With one shared
    // map, the approval below would settle `pending` with the approval's params
    // and the real response would then find nothing.
    const link = makeLink();
    const pending = link.core.connection.request('turn/start', {});
    expect(link.sent()[0].id).toBe(1);

    link.core.pushStdout(
      inbound({ id: 1, method: 'item/commandExecution/requestApproval', params: { cmd: 'ls' } })
    );

    expect(link.serverRequests).toEqual([
      { id: 1, method: 'item/commandExecution/requestApproval', params: { cmd: 'ls' } },
    ]);
    // Still waiting — the server request did not touch it.
    link.core.pushStdout(inbound({ id: 1, result: 'the real answer' }));
    await expect(pending).resolves.toBe('the real answer');
  });

  it('routes a server request whose id is 0, the falsy-id trap', () => {
    // `if (frame.id)` would demote the first approval of every session to a
    // notification and nobody would ever answer it.
    const link = makeLink();
    link.core.pushStdout(inbound({ id: 0, method: 'item/tool/requestUserInput', params: {} }));

    expect(link.serverRequests.map((r) => r.id)).toEqual([0]);
    expect(link.notifications).toEqual([]);
  });

  it('logs and drops a response for an id we are not waiting on', () => {
    // Falsifies routing it anywhere else: an unmatched response must not be
    // re-read as a notification, and must not throw.
    const link = makeLink();
    expect(() => link.core.pushStdout(inbound({ id: 77, result: 'stray' }))).not.toThrow();

    expect(link.notifications).toEqual([]);
    expect(link.logs.some((line) => line.includes('unknown request id'))).toBe(true);
  });

  it('routes notifications by method and never settles an outbound call with one', async () => {
    const link = makeLink();
    const pending = link.core.connection.request('turn/start', {});
    link.core.pushStdout(
      inbound({ method: 'thread/status/changed', params: { status: { type: 'idle' } } })
    );

    expect(link.notifications).toEqual([
      { method: 'thread/status/changed', params: { status: { type: 'idle' } } },
    ]);
    link.core.connection.dispose('done');
    await expect(pending).rejects.toBeInstanceOf(CodexConnectionClosedError);
  });
});

describe('codexConnection — one bad line never takes the link down', () => {
  it('survives non-JSON, an object with neither id nor method, and keeps reading', () => {
    const link = makeLink();
    link.core.pushStdout('this is not json\n');
    link.core.pushStdout(inbound({ hello: 'world' }));
    link.core.pushStdout(inbound({ method: 'turn/completed', params: { ok: true } }));

    // The good frame after two bad ones still arrived.
    expect(link.notifications).toEqual([{ method: 'turn/completed', params: { ok: true } }]);
    expect(link.logs.some((line) => line.includes('unparseable stdout line'))).toBe(true);
    expect(link.logs.some((line) => line.includes('invalid frame'))).toBe(true);
  });

  it('never logs the content of an unparseable line', () => {
    // T-35: a broken stdout line can carry anything the model was writing.
    const link = makeLink();
    link.core.pushStdout('{"secret":"sk-ant-do-not-log"\n');

    expect(link.logs.join(' ')).not.toContain('sk-ant-do-not-log');
  });

  it('reassembles a frame split across chunks and routes it exactly once', () => {
    const link = makeLink();
    const frame = inbound({ method: 'turn/completed', params: { n: 1 } });
    link.core.pushStdout(frame.slice(0, 10));
    expect(link.notifications).toHaveLength(0);
    link.core.pushStdout(frame.slice(10, 25));
    link.core.pushStdout(frame.slice(25));

    expect(link.notifications).toHaveLength(1);
  });

  it('does not let a throwing handler stop the read loop', () => {
    // A runtime bug in one notification handler must not cost every later
    // frame on the connection, including responses others are awaiting.
    const seen: string[] = [];
    const core = createCodexConnection({
      transport: { write: () => undefined, kill: () => undefined },
      handlers: {
        onServerRequest: () => undefined,
        onNotification: (n) => {
          seen.push(n.method);
          if (n.method === 'boom') throw new Error('handler exploded');
        },
        onStderr: () => undefined,
        onExit: () => undefined,
      },
      log: () => undefined,
    });

    expect(() =>
      core.pushStdout(inbound({ method: 'boom' }) + inbound({ method: 'after' }))
    ).not.toThrow();
    expect(seen).toEqual(['boom', 'after']);
  });
});

describe('codexConnection — teardown settles everything, in the right order', () => {
  it('rejects every outstanding request with CodexConnectionClosedError on dispose', async () => {
    const link = makeLink();
    const a = link.core.connection.request('one', {});
    const b = link.core.connection.request('two', {});
    link.core.connection.dispose('session closed');

    await expect(a).rejects.toBeInstanceOf(CodexConnectionClosedError);
    await expect(b).rejects.toBeInstanceOf(CodexConnectionClosedError);
  });

  it('rejects BEFORE it kills, proven with a transport that exits inside kill()', async () => {
    // The ordering cannot be observed through promise callbacks (they run on a
    // later microtask), so it is observed through the REASON: a transport whose
    // kill is immediately fatal would, under the reversed order, settle these
    // promises with "process exited" instead of the caller's dispose reason.
    const link = makeLink({
      onKill: (self) => self.core.handleExit({ code: 143, signal: null }),
    });
    const pending = link.core.connection.request('thread/start', {});
    link.core.connection.dispose('host shutdown');

    await expect(pending).rejects.toThrow(/connection disposed \(host shutdown\)/);
    expect(link.ops).toEqual(['write:thread/start', 'kill:host shutdown']);
  });

  it('is idempotent: a second dispose neither kills again nor throws', () => {
    const link = makeLink();
    link.core.connection.dispose('first');
    link.core.connection.dispose('second');

    expect(link.ops.filter((op) => op.startsWith('kill:'))).toEqual(['kill:first']);
  });

  it('rejects a request made after teardown immediately, without writing anything', async () => {
    // Falsifies registering it: a promise on a dead link is a permanent wait.
    const link = makeLink();
    link.core.connection.dispose('closed');
    const pending = link.core.connection.request('turn/start', {});

    await expect(pending).rejects.toBeInstanceOf(CodexConnectionClosedError);
    expect(link.writes).toHaveLength(0);
  });

  it('drops reply/notify after teardown instead of throwing', async () => {
    // The pending-table drain writes its refusal frames during teardown; a throw
    // there would abort the drain with entries still registered and unanswered.
    const link = makeLink();
    link.core.connection.dispose('closed');

    expect(() => link.core.connection.reply(0, { answers: {} })).not.toThrow();
    expect(() => link.core.connection.replyError(1, -32601, 'nope')).not.toThrow();
    expect(() => link.core.connection.notify('initialized', {})).not.toThrow();
    expect(link.writes).toHaveLength(0);
  });

  it('rejects outstanding requests when the process dies on its own, then reports the exit once', async () => {
    // Arbitration doc §2.3 O-d: a crashed process with live promises is the same
    // permanent-wait failure as a missed close.
    const link = makeLink();
    const pending = link.core.connection.request('turn/start', {});
    link.core.handleExit({ code: 1, signal: null });
    link.core.handleExit({ code: 1, signal: null });

    await expect(pending).rejects.toBeInstanceOf(CodexConnectionClosedError);
    await expect(pending).rejects.toThrow(/process exited/);
    expect(link.exits).toEqual([{ code: 1, signal: null }]);
    expect(link.core.connection.alive).toBe(false);
  });

  it('is already closed by the time onExit runs, so teardown cannot register new work', async () => {
    // The runtime tears the session down inside onExit (drain the pending table,
    // dispose). Anything it sends during that teardown must be refused
    // immediately rather than parked on a process that is already gone.
    const link = makeLink();
    const pending = link.core.connection.request('turn/start', {});
    let aliveInsideExit: boolean | null = null;
    let refusedInsideExit: unknown = null;
    const core = createCodexConnection({
      transport: { write: () => undefined, kill: () => undefined },
      handlers: {
        onServerRequest: () => undefined,
        onNotification: () => undefined,
        onStderr: () => undefined,
        onExit: () => {
          aliveInsideExit = core.connection.alive;
          refusedInsideExit = core.connection.request('too late', {}).catch((err) => err);
        },
      },
      log: () => undefined,
    });
    core.handleExit({ code: null, signal: 'SIGKILL' });

    expect(aliveInsideExit).toBe(false);
    await expect(refusedInsideExit as Promise<unknown>).resolves.toBeInstanceOf(
      CodexConnectionClosedError
    );
    link.core.handleExit({ code: null, signal: null });
    await expect(pending).rejects.toBeInstanceOf(CodexConnectionClosedError);
  });
});

describe('codexConnection — request timeouts', () => {
  it('rejects after the deadline and forgets the entry, so a late answer cannot re-settle it', async () => {
    const link = makeLink();
    const pending = link.core.connection.request('turn/start', {}, 5);

    await expect(pending).rejects.toThrow(/timed out after 5ms/);
    // The late response now belongs to nobody. It must be dropped quietly
    // rather than settling an already-rejected promise (an unhandled throw
    // inside the read loop) or being re-read as some other frame kind.
    expect(() => link.core.pushStdout(inbound({ id: 1, result: 'late' }))).not.toThrow();
    expect(link.logs.some((line) => line.includes('unknown request id'))).toBe(true);
  });

  it('defaults to the exported budget and lets the caller shorten it', async () => {
    // Pins that the default is a named constant rather than a literal buried in
    // the call site: the handshake deliberately runs on a shorter one.
    expect(CODEX_REQUEST_TIMEOUT_MS).toBeGreaterThan(1_000);
    const link = makeLink();
    const fast = link.core.connection.request('slow', {}, 1);
    await expect(fast).rejects.toThrow(/timed out after 1ms/);
  });
});

describe('codexConnection — replies use THEIR id, notifications carry none', () => {
  it('writes a result frame for a server request id, including 0', () => {
    const link = makeLink();
    link.core.connection.reply(0, { answers: {} });

    expect(link.sent()[0]).toEqual({ jsonrpc: '2.0', id: 0, result: { answers: {} } });
  });

  it('writes an error frame with the given code', () => {
    const link = makeLink();
    link.core.connection.replyError('abc', JSONRPC_METHOD_NOT_FOUND, 'unsupported');

    expect(link.sent()[0]).toEqual({
      jsonrpc: '2.0',
      id: 'abc',
      error: { code: JSONRPC_METHOD_NOT_FOUND, message: 'unsupported' },
    });
  });

  it('never lets a reply consume one of our own pending entries', async () => {
    // Replying to server id 1 must not settle OUR request id 1.
    const link = makeLink();
    const pending = link.core.connection.request('turn/start', {});
    link.core.connection.reply(1, { decision: 'decline' });
    link.core.pushStdout(inbound({ id: 1, result: 'ours' }));

    await expect(pending).resolves.toBe('ours');
  });

  it('writes notifications with a method and no id', () => {
    const link = makeLink();
    link.core.connection.notify('initialized', {});

    expect(link.sent()[0]).toEqual({ jsonrpc: '2.0', method: 'initialized', params: {} });
    expect(link.sent()[0]).not.toHaveProperty('id');
  });
});

describe('codexConnection — stderr and process identity', () => {
  it('forwards stderr one line at a time, reassembling split chunks', () => {
    const link = makeLink();
    link.core.pushStderr('first line\nsecond ');
    link.core.pushStderr('line\n');

    expect(link.stderr).toEqual(['first line', 'second line']);
  });

  it('exposes pid and alive from the transport', () => {
    const link = makeLink();
    expect(link.core.connection.pid).toBe(4242);
    expect(link.core.connection.alive).toBe(true);
    link.core.connection.dispose('bye');
    expect(link.core.connection.alive).toBe(false);
  });

  it('exports a spawn factory (the only child_process caller in the Codex path)', () => {
    // Not executed: this repo starts a real child in exactly one suite
    // (protocolErrors.test.ts) and this slice does not widen that. What is
    // asserted is that the shipped factory exists and is a function — its
    // routing behaviour is covered above, because it runs the same core.
    expect(typeof spawnCodexConnection).toBe('function');
  });
});

describe('codexConnection — recorded frames route the way the codec says', () => {
  /** Fixture envelope: `{dir, tMs, raw}` — readers must go through `.raw`. */
  function inboundFixtureFrames(file: string): string[] {
    return readFileSync(path.join(FIXTURES, file), 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { dir: string; raw: unknown })
      .filter((entry) => entry.dir === '<-')
      .map((entry) => `${JSON.stringify(entry.raw)}\n`);
  }

  it('sorts the recorded question turn into server requests and notifications', () => {
    // Real bytes, through the real core: `item/tool/requestUserInput` (ids 0 and
    // 1) are requests we owe answers to, `serverRequest/resolved` is not.
    const link = makeLink();
    const frames = inboundFixtureFrames('codex-question-requests.jsonl');
    for (const frame of frames) link.core.pushStdout(frame);

    expect(link.serverRequests.map((r) => `${r.method}#${String(r.id)}`)).toEqual([
      'item/tool/requestUserInput#0',
      'item/tool/requestUserInput#1',
    ]);
    expect([...new Set(link.notifications.map((n) => n.method))]).toEqual([
      'serverRequest/resolved',
    ]);
    // Every recorded frame reached exactly one destination — nothing dropped
    // into `invalid`, nothing routed twice. Derived from the fixture rather
    // than a hardcoded count, so re-rescuing more frames cannot silently
    // shrink what this asserts.
    expect(link.serverRequests.length + link.notifications.length).toBe(frames.length);
    expect(link.logs.filter((line) => line.includes('invalid frame'))).toEqual([]);
  });

  it('settles the recorded initialize response, which carries no jsonrpc member', async () => {
    // The one frame that would be dropped by a codec gating on `jsonrpc==='2.0'`
    // — and dropping it hangs every session at the handshake.
    const link = makeLink();
    const pending = link.core.connection.request('initialize', {});
    for (const frame of inboundFixtureFrames('codex-handshake.jsonl')) {
      link.core.pushStdout(frame);
    }

    await expect(pending).resolves.toMatchObject({ codexHome: expect.any(String) });
  });
});
