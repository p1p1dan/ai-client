import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PENDING_REPLIES,
  kindOfServerMethod,
  type PendingAutoReason,
  type PendingKind,
  type PendingServerRequest,
  PendingServerRequestTable,
  type PendingTableOptions,
  SERVER_REQUEST_KINDS,
} from '../codexPending.ts';
import type { JsonRpcId } from '../codexWire.ts';

/**
 * S3 slice 2a — the single pending server-request table (S2 design C10 rule 1).
 *
 * Every assertion below is written against a specific way this table can fail,
 * because the two real bugs here both pass a naive test:
 *   - "the table is empty after close" passes when the entries were deleted
 *     WITHOUT a frame ever being written, which hangs the Codex turn forever;
 *   - "the request was answered" passes when it was answered twice.
 * So the reply channel is a counting recorder, never a boolean.
 */

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/codex/', import.meta.url));

interface Envelope {
  dir: '->' | '<-';
  tMs: number | null;
  raw: unknown;
}

/** Fixtures wrap each frame in `{dir, tMs, raw}` — the frame itself is `.raw`. */
function readEnvelopes(file: string): Envelope[] {
  return readFileSync(`${FIXTURE_DIR}${file}`, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Envelope);
}

const FIXTURE_FILES = [
  'codex-question-requests.jsonl',
  'codex-command-approval.jsonl',
  'codex-filechange-approval-turn.jsonl',
  'codex-question-turn-status.jsonl',
  'codex-handshake.jsonl',
];

/** Every inbound method name in the recorded traffic, deduplicated. */
function inboundMethods(): string[] {
  const seen = new Set<string>();
  for (const file of FIXTURE_FILES) {
    for (const envelope of readEnvelopes(file)) {
      if (envelope.dir !== '<-') continue;
      const raw = envelope.raw as { method?: unknown };
      if (typeof raw?.method === 'string') seen.add(raw.method);
    }
  }
  return Array.from(seen).sort();
}

interface Recorder {
  table: PendingServerRequestTable;
  /** One entry per frame actually written. Length is the "exactly once" evidence. */
  replies: Array<{ id: JsonRpcId; result: unknown }>;
  settled: Array<{ entry: PendingServerRequest; reason: string }>;
  logs: string[];
}

function makeTable(overrides: Partial<PendingTableOptions> = {}): Recorder {
  const replies: Recorder['replies'] = [];
  const settled: Recorder['settled'] = [];
  const logs: string[] = [];
  const table = new PendingServerRequestTable({
    reply: (id, result) => replies.push({ id, result }),
    onSettled: (entry, reason) => settled.push({ entry, reason }),
    log: (msg) => logs.push(msg),
    ...overrides,
  });
  return { table, replies, settled, logs };
}

function entryOf(
  requestId: JsonRpcId,
  sessionId: string,
  kind: PendingKind = 'question',
  method = 'item/tool/requestUserInput'
): PendingServerRequest {
  return {
    requestId,
    sessionId,
    kind,
    method,
    params: { threadId: 't-1' },
    correlationId: `corr-${String(requestId)}`,
    createdAt: 1_786_038_148_321,
  };
}

const ALL_KINDS: PendingKind[] = [
  'question',
  'approval_exec',
  'approval_file_change',
  'approval_permissions',
  'elicitation',
];

const ALL_AUTO_REASONS: PendingAutoReason[] = [
  'unsupported',
  'session_closed',
  'aborted',
  'timed_out',
];

describe('kindOfServerMethod / SERVER_REQUEST_KINDS', () => {
  it('classifies every server-request method that appears in the recorded traffic', () => {
    // Falsifies a typo in SERVER_REQUEST_KINDS: a misspelled key would leave a
    // real request unregistered, so nobody would ever answer it.
    const requestLike = inboundMethods().filter((method) =>
      /\/(requestApproval|requestUserInput)$/.test(method)
    );
    // Guards against the assertion going vacuous if the fixtures ever move.
    expect(requestLike).toEqual([
      'item/commandExecution/requestApproval',
      'item/fileChange/requestApproval',
      'item/tool/requestUserInput',
    ]);
    for (const method of requestLike) {
      expect(kindOfServerMethod(method)).not.toBeNull();
    }
  });

  it('maps the three observed methods to distinct kinds', () => {
    // Falsifies a copy-paste where two methods share one kind — slice 3/4 would
    // then route an approval into the question bridge.
    expect(kindOfServerMethod('item/tool/requestUserInput')).toBe('question');
    expect(kindOfServerMethod('item/commandExecution/requestApproval')).toBe('approval_exec');
    expect(kindOfServerMethod('item/fileChange/requestApproval')).toBe('approval_file_change');
  });

  it('keeps item/permissions/requestApproval registrable even though slice 4 refuses it', () => {
    // Falsifies "we do not implement it, so we drop it": dropping means no
    // JSON-RPC response at all, which hangs the turn (arbitration doc §2.2 C-f).
    expect(kindOfServerMethod('item/permissions/requestApproval')).toBe('approval_permissions');
  });

  it('returns null for notification methods seen in the same traffic', () => {
    // Falsifies an over-broad matcher (e.g. `method.includes('item/')`) that
    // would register notifications as pending requests and never settle them.
    for (const method of ['thread/status/changed', 'serverRequest/resolved', 'item/started']) {
      expect(kindOfServerMethod(method)).toBeNull();
    }
  });

  it('returns null for an unknown method', () => {
    expect(kindOfServerMethod('item/somethingNew/requestApproval')).toBeNull();
    expect(kindOfServerMethod('')).toBeNull();
  });

  it('returns null for inherited Object properties', () => {
    // Falsifies a bare `SERVER_REQUEST_KINDS[method]` lookup, which returns
    // Object.prototype.toString (truthy) and would register garbage as a kind.
    for (const method of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) {
      expect(kindOfServerMethod(method)).toBeNull();
    }
  });
});

describe('DEFAULT_PENDING_REPLIES', () => {
  it('produces a refusal body for every kind x every auto reason', () => {
    // Table-driven over the full cross product: falsifies a kind or a reason
    // that falls through to `undefined`, which would be encoded as a null result
    // and rejected by the server's schema.
    const expected: Record<PendingKind, Record<PendingAutoReason, unknown>> = {
      question: {
        unsupported: { answers: {} },
        session_closed: { answers: {} },
        aborted: { answers: {} },
        timed_out: { answers: {} },
      },
      approval_exec: {
        unsupported: { decision: 'decline' },
        session_closed: { decision: 'cancel' },
        aborted: { decision: 'cancel' },
        timed_out: { decision: 'decline' },
      },
      approval_file_change: {
        unsupported: { decision: 'decline' },
        session_closed: { decision: 'cancel' },
        aborted: { decision: 'cancel' },
        timed_out: { decision: 'decline' },
      },
      approval_permissions: {
        unsupported: { permissions: {}, scope: 'turn' },
        session_closed: { permissions: {}, scope: 'turn' },
        aborted: { permissions: {}, scope: 'turn' },
        timed_out: { permissions: {}, scope: 'turn' },
      },
      elicitation: {
        unsupported: { action: 'decline' },
        session_closed: { action: 'decline' },
        aborted: { action: 'decline' },
        timed_out: { action: 'decline' },
      },
    };

    for (const kind of ALL_KINDS) {
      for (const reason of ALL_AUTO_REASONS) {
        expect(DEFAULT_PENDING_REPLIES(entryOf(0, 's', kind), reason)).toEqual(
          expected[kind][reason]
        );
      }
    }
  });

  it('never produces a grant, for any kind or reason', () => {
    // The load-bearing safety property: a drain happens exactly when nobody is
    // left to decide, so an auto reply that reads as approval would let Codex
    // run a command the user never saw. Falsifies any future edit that swaps in
    // 'accept' / 'acceptWithExecpolicyAmendment' / a populated permission grant.
    for (const kind of ALL_KINDS) {
      for (const reason of ALL_AUTO_REASONS) {
        const body = DEFAULT_PENDING_REPLIES(entryOf(0, 's', kind), reason) as Record<
          string,
          unknown
        >;
        expect(JSON.stringify(body)).not.toMatch(/accept|allow|approve|grant/i);
        if ('decision' in body) expect(['cancel', 'decline']).toContain(body.decision);
        if ('answers' in body) expect(body.answers).toEqual({});
        if ('permissions' in body) expect(body.permissions).toEqual({});
        if ('action' in body) expect(body.action).toBe('decline');
      }
    }
  });

  it("uses the wire's clean cancel for questions rather than Claude's empty-payload guard", () => {
    // Falsifies porting `questionBridge`'s "reject empty answers" defence: on
    // this wire `{answers:{}}` IS the cancel (C15 ruled the guard must not be
    // copied), so a guard here would refuse to send the only valid cancel.
    expect(DEFAULT_PENDING_REPLIES(entryOf(0, 's', 'question'), 'session_closed')).toEqual({
      answers: {},
    });
  });
});

describe('PendingServerRequestTable — register', () => {
  it('registers and exposes an entry by its typed id', () => {
    const { table, replies } = makeTable();
    expect(table.register(entryOf(0, 'a'))).toBe(true);
    expect(table.has(0)).toBe(true);
    expect(table.get(0)?.correlationId).toBe('corr-0');
    expect(table.size).toBe(1);
    // Registration must not answer anything — falsifies an eager auto-reply.
    expect(replies).toHaveLength(0);
  });

  it('accepts server request id 0', () => {
    // Falsifies `if (id)` truthiness anywhere in the path: server request ids
    // start at 0 [实测 fixtures], and 0 is falsy.
    const { table } = makeTable();
    expect(table.register(entryOf(0, 'a'))).toBe(true);
    expect(table.has(0)).toBe(true);
    expect(table.size).toBe(1);
  });

  it('rejects a duplicate id without overwriting and without writing a frame', () => {
    // Falsifies "last write wins": overwriting orphans the first request, which
    // then can never be answered. Also falsifies "answer the loser immediately",
    // which would put a stray frame on the wire.
    const { table, replies, settled, logs } = makeTable();
    table.register(entryOf(7, 'a', 'question'));
    const second = { ...entryOf(7, 'b', 'approval_exec'), correlationId: 'corr-second' };

    expect(table.register(second)).toBe(false);
    expect(table.size).toBe(1);
    expect(table.get(7)?.correlationId).toBe('corr-7');
    expect(table.get(7)?.sessionId).toBe('a');
    expect(table.get(7)?.kind).toBe('question');
    expect(replies).toHaveLength(0);
    expect(settled).toHaveLength(0);
    expect(logs.some((line) => line.includes('duplicate'))).toBe(true);
  });

  it("keeps '1' and 1 as two independent entries", () => {
    // Falsifies `pending.get(Number(id))` (what both spikes wrote): Number('1')
    // === 1, so the string-id request would settle the numeric one's entry.
    const { table, replies } = makeTable();
    expect(table.register(entryOf(1, 'a'))).toBe(true);
    expect(table.register(entryOf('1', 'a'))).toBe(true);
    expect(table.size).toBe(2);
    expect(table.get(1)?.correlationId).toBe('corr-1');
    expect(table.get('1')?.correlationId).toBe('corr-1');
    expect(table.get(1)).not.toBe(table.get('1'));

    table.settle(1, { reason: 'answered', result: { answers: {} } });
    expect(table.has(1)).toBe(false);
    expect(table.has('1')).toBe(true);
    expect(replies.map((r) => r.id)).toEqual([1]);
  });
});

describe('PendingServerRequestTable — settle', () => {
  it('writes exactly one frame, removes the entry and notifies', () => {
    const { table, replies, settled } = makeTable();
    table.register(entryOf(0, 'a'));

    expect(table.settle(0, { reason: 'answered', result: { answers: { q: 'x' } } })).toBe(true);
    expect(replies).toEqual([{ id: 0, result: { answers: { q: 'x' } } }]);
    expect(table.size).toBe(0);
    expect(settled).toHaveLength(1);
    expect(settled[0]?.reason).toBe('answered');
    expect(settled[0]?.entry.correlationId).toBe('corr-0');
  });

  it('has already written the frame and removed the entry by the time onSettled runs', () => {
    // Falsifies an observer that fires before the wire write: the runtime emits
    // `question.resolved` from onSettled, so a crash between the two would show
    // the user a resolved card while Codex still waits. Observed state is
    // captured, not asserted inline — an assertion thrown inside onSettled is
    // swallowed by the table's guard and the test would pass regardless.
    const replies: JsonRpcId[] = [];
    let observed: { replyCount: number; stillPending: boolean; size: number } | null = null;
    const table = new PendingServerRequestTable({
      reply: (id) => replies.push(id),
      onSettled: () => {
        observed = { replyCount: replies.length, stillPending: table.has(0), size: table.size };
      },
    });
    table.register(entryOf(0, 'a'));
    table.settle(0, { reason: 'answered', result: null });

    expect(observed).toEqual({ replyCount: 1, stillPending: false, size: 0 });
  });

  it('passes the answered result through verbatim without consulting the fallback', () => {
    // Falsifies a fallback that runs on every settle: a user cancel travels the
    // 'answered' path with its own body, and rewriting it would replace the
    // bridge's decision with a generic refusal.
    let fallbackCalls = 0;
    const { table, replies } = makeTable({
      fallback: () => {
        fallbackCalls += 1;
        return { decision: 'decline' };
      },
    });
    table.register(entryOf(0, 'a', 'approval_exec'));
    table.settle(0, { reason: 'answered', result: { decision: 'accept' } });

    expect(replies[0]?.result).toEqual({ decision: 'accept' });
    expect(fallbackCalls).toBe(0);
  });

  it('does not write a second frame on a repeated settle', () => {
    // THE duplicate-response guard: a second result for an id the server has
    // already resolved pollutes its own pending table.
    const { table, replies, settled, logs } = makeTable();
    table.register(entryOf(0, 'a'));
    table.settle(0, { reason: 'answered', result: { answers: {} } });

    expect(table.settle(0, { reason: 'answered', result: { answers: { late: 'y' } } })).toBe(false);
    expect(table.settle(0, { reason: 'aborted' })).toBe(false);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.result).toEqual({ answers: {} });
    expect(settled).toHaveLength(1);
    expect(logs.some((line) => line.includes('unknown id'))).toBe(true);
  });

  it('returns false and writes nothing for an id that was never registered', () => {
    const { table, replies, settled } = makeTable();
    expect(table.settle(42, { reason: 'session_closed' })).toBe(false);
    expect(replies).toHaveLength(0);
    expect(settled).toHaveLength(0);
  });

  it('removes the entry before the reply runs, so a reentrant settle cannot double-answer', () => {
    // Falsifies "reply first, delete after": a reply implementation that
    // synchronously re-enters (flush -> error path -> settle) would otherwise
    // find the entry still pending and write a second frame.
    // The reentrant result is captured rather than asserted inline: the table
    // guards `reply`, so an assertion throwing in here would be swallowed.
    const replies: Array<{ id: JsonRpcId; result: unknown }> = [];
    let reentrantResult: boolean | 'not-run' = 'not-run';
    const table = new PendingServerRequestTable({
      reply: (id, result) => {
        replies.push({ id, result });
        if (reentrantResult === 'not-run') {
          reentrantResult = table.settle(id, { reason: 'aborted' });
        }
      },
    });
    table.register(entryOf(0, 'a'));
    table.settle(0, { reason: 'answered', result: { answers: {} } });

    expect(reentrantResult).toBe(false);
    expect(replies).toHaveLength(1);
  });
});

describe('PendingServerRequestTable — drain', () => {
  it('drains one session only, replying exactly once per entry with the given reason', () => {
    // Core acceptance (arbitration doc §3 item 3). The counter is the point:
    // `size === 0` alone passes for a bare Map.clear(), which leaves Codex in
    // waitingOn* forever.
    const { table, replies, settled } = makeTable();
    table.register(entryOf(0, 'a', 'question', 'item/tool/requestUserInput'));
    table.register(entryOf(1, 'a', 'approval_exec', 'item/commandExecution/requestApproval'));
    table.register(
      entryOf('tok-2', 'a', 'approval_file_change', 'item/fileChange/requestApproval')
    );
    table.register(entryOf(3, 'b', 'question', 'item/tool/requestUserInput'));
    table.register(entryOf(4, 'b', 'approval_exec', 'item/commandExecution/requestApproval'));

    const drained = table.drain({ sessionId: 'a' }, 'session_closed');

    // (1) only session a, in registration order
    expect(drained.map((entry) => entry.requestId)).toEqual([0, 1, 'tok-2']);
    // (2) exactly one frame per drained entry — count, not "table is empty"
    expect(replies).toHaveLength(3);
    expect(replies.map((reply) => reply.id)).toEqual([0, 1, 'tok-2']);
    expect(new Set(replies.map((reply) => JSON.stringify(reply.id))).size).toBe(3);
    expect(replies.map((reply) => reply.result)).toEqual([
      { answers: {} },
      { decision: 'cancel' },
      { decision: 'cancel' },
    ]);
    // (3) each carries the concrete reason, not a generic "gone"
    expect(settled).toHaveLength(3);
    expect(settled.every((record) => record.reason === 'session_closed')).toBe(true);
    expect(settled.map((record) => record.entry.correlationId)).toEqual([
      'corr-0',
      'corr-1',
      'corr-tok-2',
    ]);
    // (4) session a empty, session b untouched — no frame written for b
    expect(table.sizeFor('a')).toBe(0);
    expect(table.sizeFor('b')).toBe(2);
    expect(table.size).toBe(2);
    expect(table.has(3)).toBe(true);
    expect(table.has(4)).toBe(true);
  });

  it('drains everything when no sessionId is given', () => {
    // Connection death (arbitration doc §2.3 O-d): the process is gone but the
    // cards are still on screen. Falsifies a filter that treats a missing
    // sessionId as "match nothing".
    const { table, replies } = makeTable();
    table.register(entryOf(0, 'a'));
    table.register(entryOf(1, 'b'));

    expect(table.drain({}, 'aborted')).toHaveLength(2);
    expect(replies).toHaveLength(2);
    expect(table.size).toBe(0);
  });

  it('is a no-op for a session with nothing pending', () => {
    const { table, replies } = makeTable();
    table.register(entryOf(0, 'a'));
    expect(table.drain({ sessionId: 'zzz' }, 'session_closed')).toEqual([]);
    expect(replies).toHaveLength(0);
    expect(table.size).toBe(1);
  });

  it('drains a second time as a no-op instead of re-answering', () => {
    // Falsifies a close path that runs twice (session.close + connection exit)
    // writing two frames per request.
    const { table, replies } = makeTable();
    table.register(entryOf(0, 'a'));
    table.drain({ sessionId: 'a' }, 'session_closed');
    expect(table.drain({ sessionId: 'a' }, 'aborted')).toEqual([]);
    expect(replies).toHaveLength(1);
  });

  it('keeps draining the rest when one reply throws', () => {
    // Falsifies letting a writer error escape: the drain would stop halfway and
    // the remaining requests would stay registered AND unanswered — the exact
    // hang this table exists to prevent.
    const seen: JsonRpcId[] = [];
    const logs: string[] = [];
    const table = new PendingServerRequestTable({
      reply: (id) => {
        seen.push(id);
        if (id === 1) throw new Error('stdin closed');
      },
      log: (msg) => logs.push(msg),
    });
    table.register(entryOf(0, 'a'));
    table.register(entryOf(1, 'a'));
    table.register(entryOf(2, 'a'));

    expect(() => table.drain({ sessionId: 'a' }, 'session_closed')).not.toThrow();
    expect(seen).toEqual([0, 1, 2]);
    expect(table.size).toBe(0);
    expect(logs.some((line) => line.includes('reply'))).toBe(true);
  });

  it('keeps draining the rest when onSettled throws', () => {
    // Same failure family via the observer: an event-emit error must not strand
    // the remaining pending requests.
    const replies: JsonRpcId[] = [];
    const table = new PendingServerRequestTable({
      reply: (id) => replies.push(id),
      onSettled: (entry) => {
        if (entry.requestId === 0) throw new Error('emit failed');
      },
    });
    table.register(entryOf(0, 'a'));
    table.register(entryOf(1, 'a'));

    expect(() => table.drain({ sessionId: 'a' }, 'aborted')).not.toThrow();
    expect(replies).toEqual([0, 1]);
    expect(table.size).toBe(0);
  });

  it('uses the injected fallback instead of the defaults when one is supplied', () => {
    const { table, replies } = makeTable({
      fallback: (entry, reason) => ({ custom: `${entry.kind}:${reason}` }),
    });
    table.register(entryOf(0, 'a', 'approval_file_change'));
    table.drain({ sessionId: 'a' }, 'timed_out');
    expect(replies[0]?.result).toEqual({ custom: 'approval_file_change:timed_out' });
  });
});

describe('PendingServerRequestTable — views', () => {
  it('list() is a snapshot that cannot mutate the table', () => {
    // Falsifies returning the live Map values view: a caller iterating while
    // draining would then skip entries and leave them unanswered.
    const { table } = makeTable();
    table.register(entryOf(0, 'a'));
    const snapshot = table.list();
    table.settle(0, { reason: 'answered', result: null });
    expect(snapshot).toHaveLength(1);
    expect(table.list()).toHaveLength(0);
  });

  it('sizeFor counts only the named session', () => {
    const { table } = makeTable();
    table.register(entryOf(0, 'a'));
    table.register(entryOf(1, 'b'));
    table.register(entryOf(2, 'b'));
    expect(table.sizeFor('a')).toBe(1);
    expect(table.sizeFor('b')).toBe(2);
    expect(table.sizeFor('missing')).toBe(0);
    expect(table.size).toBe(3);
  });

  it('works without optional log/onSettled callbacks', () => {
    // Falsifies an unguarded `this.options.log(...)` call, which would throw on
    // the very first duplicate id in production where no logger is wired.
    const replies: JsonRpcId[] = [];
    const table = new PendingServerRequestTable({ reply: (id) => replies.push(id) });
    table.register(entryOf(0, 'a'));
    expect(table.register(entryOf(0, 'a'))).toBe(false);
    expect(table.settle(99, { reason: 'aborted' })).toBe(false);
    expect(table.drain({ sessionId: 'a' }, 'session_closed')).toHaveLength(1);
    expect(replies).toEqual([0]);
  });
});

describe('registration keys are exactly the attested request kinds', () => {
  it('exposes no method beyond the ones a real contract declares', () => {
    // Falsifies adding a guessed method name. The elicitation entry was held
    // back through slice 2a for exactly that reason and only landed once the
    // generated contract spelled it; `codexWireContract.test.ts` checks each of
    // these against that snapshot, so this list stays a deliberate set rather
    // than whatever accumulated.
    expect(Object.keys(SERVER_REQUEST_KINDS).sort()).toEqual([
      'item/commandExecution/requestApproval',
      'item/fileChange/requestApproval',
      'item/permissions/requestApproval',
      'item/tool/requestUserInput',
      'mcpServer/elicitation/request',
    ]);
    // Every declared kind is now reachable — an unreachable kind is dead code
    // that looks like coverage.
    expect(new Set(Object.values(SERVER_REQUEST_KINDS))).toEqual(
      new Set([
        'question',
        'approval_exec',
        'approval_file_change',
        'approval_permissions',
        'elicitation',
      ])
    );
  });
});
