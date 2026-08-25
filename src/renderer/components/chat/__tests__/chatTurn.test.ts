import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ChatBlock, ChatMessage } from '@/stores/chatSessions';
import {
  collapsedLeavesNothing,
  defaultTurnProcessOpen,
  flattenTurnItems,
  groupMessagesIntoTurns,
  hasUnresolvedPermission,
  segmentTurnBody,
  stabilizeTurns,
  type Turn,
  type TurnItem,
  turnHasFailure,
  turnItemPlacement,
} from '../chatTurn';

let messageSeq = 0;

function message(role: ChatMessage['role'], blocks: ChatBlock[] = []): ChatMessage {
  messageSeq += 1;
  return { id: `m${messageSeq}`, sessionId: 's1', role, blocks };
}

const user = (blocks: ChatBlock[] = []) => message('user', blocks);
const assistant = (blocks: ChatBlock[] = []) => message('assistant', blocks);
const system = (blocks: ChatBlock[] = []) => message('system', blocks);
const errorMessage = (blocks: ChatBlock[] = []) => message('error', blocks);

let blockSeq = 0;

function block(type: ChatBlock['type'], extra: Partial<ChatBlock> = {}): ChatBlock {
  blockSeq += 1;
  return { id: `b${blockSeq}`, type, ...extra };
}

const text = (value: string) => block('text', { text: value });
const thinking = (value = 'hmm') => block('thinking', { text: value });
const permission = (resolved?: boolean) =>
  block('permission_request', { permissionId: `p${blockSeq}`, resolved });

function toolPair(toolName: string, opts: { ok?: boolean } = {}): ChatBlock[] {
  blockSeq += 1;
  const callId = `tc${blockSeq}`;
  return [
    { id: `${callId}-call`, type: 'tool_call', toolCallId: callId, toolName, toolInput: {} },
    { id: `${callId}-result`, type: 'tool_result', toolCallId: callId, toolOk: opts.ok ?? true },
  ];
}

function turnOf(body: ChatMessage[], userMessage: ChatMessage | null = null): Turn {
  return { id: userMessage?.id ?? body[0]?.id ?? 'empty', user: userMessage, body };
}

// ---------------------------------------------------------------------------
// F-B1 — grouping
// ---------------------------------------------------------------------------

describe('groupMessagesIntoTurns', () => {
  it('F-B1: [u,a] is one turn; [u,a,u,a] is two', () => {
    const [u1, a1, u2, a2] = [user(), assistant(), user(), assistant()];
    expect(groupMessagesIntoTurns([u1, a1])).toEqual([{ id: u1.id, user: u1, body: [a1] }]);
    expect(groupMessagesIntoTurns([u1, a1, u2, a2])).toEqual([
      { id: u1.id, user: u1, body: [a1] },
      { id: u2.id, user: u2, body: [a2] },
    ]);
  });

  it('F-B1: [a,a] becomes one orphan turn (restored history that opens with a reply)', () => {
    const [a1, a2] = [assistant(), assistant()];
    expect(groupMessagesIntoTurns([a1, a2])).toEqual([{ id: a1.id, user: null, body: [a1, a2] }]);
  });

  it('F-B1: [u,u,a] is two turns and the first body stays empty (T-19 queued sends)', () => {
    const [u1, u2, a1] = [user(), user(), assistant()];
    const turns = groupMessagesIntoTurns([u1, u2, a1]);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toEqual({ id: u1.id, user: u1, body: [] });
    expect(turns[1]).toEqual({ id: u2.id, user: u2, body: [a1] });
  });

  it('F-B1: system and error notices join the turn body, not a turn of their own', () => {
    const [u1, a1, sys, err, u2] = [user(), assistant(), system(), errorMessage(), user()];
    const turns = groupMessagesIntoTurns([u1, a1, sys, err, u2]);
    expect(turns).toHaveLength(2);
    expect(turns[0].body).toEqual([a1, sys, err]);
    expect(turns[1].body).toEqual([]);
  });

  it('F-B1: an empty message list produces no turns', () => {
    expect(groupMessagesIntoTurns([])).toEqual([]);
  });

  // The zero-loss invariant is the one regression worth proving over a
  // generated input space rather than a handful of samples: a grouping bug
  // that silently swallows a `system` notice or the second of two queued
  // `user` sends is invisible in any single example.
  it('F-B1: zero message loss invariant holds for every role sequence up to length 4', () => {
    const roles: ChatMessage['role'][] = ['user', 'assistant', 'system', 'error'];
    const sequences: ChatMessage['role'][][] = [[]];
    for (let length = 1; length <= 4; length += 1) {
      const previous = sequences.filter((seq) => seq.length === length - 1);
      for (const seq of previous) {
        for (const role of roles) sequences.push([...seq, role]);
      }
    }
    expect(sequences).toHaveLength(1 + 4 + 16 + 64 + 256);

    for (const seq of sequences) {
      const messages = seq.map((role) => message(role));
      const turns = groupMessagesIntoTurns(messages);

      const counted = turns.reduce(
        (total, turn) => total + turn.body.length + (turn.user ? 1 : 0),
        0
      );
      expect(counted).toBe(messages.length);

      // Stronger than the count: order is preserved too, so no message can be
      // dropped and compensated for by a duplicate elsewhere.
      const flattened = turns.flatMap((turn) =>
        turn.user ? [turn.user, ...turn.body] : turn.body
      );
      expect(flattened).toEqual(messages);
    }
  });
});

// ---------------------------------------------------------------------------
// Flatten (turn body -> ordered items)
// ---------------------------------------------------------------------------

describe('flattenTurnItems · FB7 permission join wiring', () => {
  /**
   * The join lives in `toolCard.ts` and is exercised directly there; these two
   * exist so the WIRING cannot rot silently. Dropping the call would leave
   * every `joinResolvedPermissions` test green while the app went back to
   * rendering two rows.
   */
  it('folds a resolved permission into the tool row it settled', () => {
    const callId = 'tc-join';
    const a1 = assistant([
      {
        id: `${callId}-call`,
        type: 'tool_call',
        toolCallId: callId,
        toolName: 'Write',
        toolInput: {},
      },
      { id: `${callId}-result`, type: 'tool_result', toolCallId: callId, toolOk: true },
    ]);
    // Second message on purpose: the store routes an approval to "the last
    // non-history assistant message", not to the one the call landed on.
    const a2 = assistant([
      {
        id: 'perm-join',
        type: 'permission_request',
        permissionId: `${callId}-call`,
        toolName: 'Write',
        resolved: true,
        allowed: true,
      },
    ]);
    const items = flattenTurnItems(turnOf([a1, a2]));
    expect(items.map((entry) => entry.kind)).toEqual(['toolGroup']);
  });

  it('leaves a pending permission as its own item — the Allow/Deny surface must survive', () => {
    const callId = 'tc-pending';
    const a1 = assistant([
      {
        id: `${callId}-call`,
        type: 'tool_call',
        toolCallId: callId,
        toolName: 'Write',
        toolInput: {},
      },
      {
        id: 'perm-pending',
        type: 'permission_request',
        permissionId: `${callId}-call`,
        toolName: 'Write',
      },
    ]);
    const items = flattenTurnItems(turnOf([a1]));
    expect(items.map((entry) => entry.kind)).toEqual(['toolGroup', 'permission']);
  });
});

describe('flattenTurnItems', () => {
  it('concatenates each assistant message in message order, stamping the source messageId', () => {
    const a1 = assistant([text('one')]);
    const a2 = assistant([text('two')]);
    const items = flattenTurnItems(turnOf([a1, a2]));
    expect(items.map((item) => item.kind)).toEqual(['text', 'text']);
    expect(items.map((item) => item.messageId)).toEqual([a1.id, a2.id]);
  });

  it('maps a system/error message to a single notice item carrying the whole message', () => {
    const err = errorMessage([text('host died')]);
    const items = flattenTurnItems(turnOf([err]));
    expect(items).toEqual([{ kind: 'notice', message: err, messageId: err.id }]);
  });

  it('keeps block order within a message (tool group before the trailing prose)', () => {
    const a1 = assistant([thinking(), ...toolPair('Read'), text('done')]);
    expect(flattenTurnItems(turnOf([a1])).map((item) => item.kind)).toEqual(['toolGroup', 'text']);
  });
});

// ---------------------------------------------------------------------------
// F-B2 / F-B6 — process / answer split
// ---------------------------------------------------------------------------

function item(kind: TurnItem['kind']): { kind: TurnItem['kind'] } {
  return { kind };
}

describe('segmentTurnBody (FB4 — prose never collapses)', () => {
  /**
   * The interface lock between FB4 and FB7. Member by member on purpose: a
   * `satisfies Record<TurnItemKind, …>` check would constrain a lookup table,
   * but this is a function, and the black-list rewrite (`kind !== 'toolGroup'`
   * -> answer) satisfies the type and breaks the meaning. FB7 adding or
   * retiring a kind has to come through here.
   */
  it('[FB4-1] turnItemPlacement is a whitelist, asserted member by member', () => {
    expect(turnItemPlacement('text')).toBe('answer');
    expect(turnItemPlacement('notice')).toBe('notice');
    expect(turnItemPlacement('question')).toBe('process');
    expect(turnItemPlacement('permission')).toBe('process');
    expect(turnItemPlacement('toolGroup')).toBe('process');
  });

  it('[FB4-2] cuts maximal same-placement runs, in order', () => {
    const kinds = ['text', 'toolGroup', 'text', 'toolGroup', 'text'] as const;
    const segments = segmentTurnBody(kinds.map((kind) => item(kind)));
    expect(segments.map((segment) => segment.kind)).toEqual([
      'answer',
      'process',
      'answer',
      'process',
      'answer',
    ]);
    expect(segments.every((segment) => segment.items.length === 1)).toBe(true);
  });

  it('[FB4-3] adjacent same-placement items share ONE segment', () => {
    const segments = segmentTurnBody([item('text'), item('text'), item('toolGroup')]);
    expect(segments.map((segment) => segment.kind)).toEqual(['answer', 'process']);
    expect(segments[0].items).toHaveLength(2);
  });

  /**
   * The defect FB4 exists to fix. Under the old tail rule a turn ending in an
   * error notice had `answer === []` and folded EVERY paragraph before it into
   * the collapsed segment — the user's report was "my prose disappeared into
   * Worked for".
   */
  it('[FB4-4] a trailing notice no longer drags the prose before it into the shell', () => {
    const segments = segmentTurnBody([
      item('text'),
      item('toolGroup'),
      item('text'),
      item('notice'),
    ]);
    expect(segments.map((segment) => segment.kind)).toEqual([
      'answer',
      'process',
      'answer',
      'notice',
    ]);
  });

  it('[FB4-5] collapsedLeavesNothing is true only when EVERY segment collapses', () => {
    const of = (...kinds: TurnItem['kind'][]) => segmentTurnBody(kinds.map((kind) => item(kind)));
    expect(collapsedLeavesNothing(of('toolGroup', 'permission'))).toBe(true);
    expect(collapsedLeavesNothing(of('toolGroup', 'text'))).toBe(false);
    // A notice renders outside the shell, so it is something left over. Without
    // these two arms the formula could be written `every(s => s.kind !== 'answer')`
    // and still pass.
    expect(collapsedLeavesNothing(of('toolGroup', 'notice'))).toBe(false);
    expect(collapsedLeavesNothing(of('notice'))).toBe(false);
  });

  it('F-B6: appending to the streaming text block does not move a boundary', () => {
    const streamingBlock = text('partial');
    const reply = assistant([thinking(), ...toolPair('Read'), streamingBlock]);
    const before = segmentTurnBody(flattenTurnItems(turnOf([reply])));
    expect(before.map((segment) => segment.kind)).toEqual(['process', 'answer']);

    streamingBlock.text = 'partial and then some more tokens';
    const after = segmentTurnBody(flattenTurnItems(turnOf([reply])));
    expect(after.map((segment) => segment.kind)).toEqual(before.map((segment) => segment.kind));
  });

  /**
   * The pre-FB4 counterpart of this case asserted the answer moved INTO process
   * when a tool call arrived after it ("moves it into process exactly once").
   * That is the behaviour being retired: the first paragraph now stays visible.
   */
  it('F-B6: a tool call after some prose leaves that prose outside the shell', () => {
    const reply = assistant([text('first pass')]);
    expect(segmentTurnBody(flattenTurnItems(turnOf([reply]))).map((s) => s.kind)).toEqual([
      'answer',
    ]);

    reply.blocks.push(...toolPair('Bash'));
    expect(segmentTurnBody(flattenTurnItems(turnOf([reply]))).map((s) => s.kind)).toEqual([
      'answer',
      'process',
    ]);

    reply.blocks.push(text('second pass'));
    expect(segmentTurnBody(flattenTurnItems(turnOf([reply]))).map((s) => s.kind)).toEqual([
      'answer',
      'process',
      'answer',
    ]);
  });

  it('F-B2: an unresolved permission stays in the process segment (block order, not promoted)', () => {
    const segments = segmentTurnBody([item('toolGroup'), item('permission')]);
    expect(segments.map((segment) => segment.kind)).toEqual(['process']);
    expect(segments[0].items.map((entry) => entry.kind)).toEqual(['toolGroup', 'permission']);
  });
});

// ---------------------------------------------------------------------------
// F-B3 / F-B4 — collapsible default state
// ---------------------------------------------------------------------------

describe('defaultTurnProcessOpen', () => {
  const closed = {
    isActive: false,
    hasUnresolvedPermission: false,
    hasFailure: false,
    collapsedLeavesNothing: false,
  };

  it('F-B3: six-case truth table', () => {
    expect(defaultTurnProcessOpen({ ...closed, isActive: true })).toBe(true);
    expect(defaultTurnProcessOpen({ ...closed, hasUnresolvedPermission: true })).toBe(true);
    // Priority case: nothing else is true, and it is still open. Burying an
    // unresolved authorization card inside a collapsed shell re-opens the
    // round-2 point-check #5 failure surface, so this rule outranks the rest.
    expect(
      defaultTurnProcessOpen({
        isActive: false,
        hasUnresolvedPermission: true,
        hasFailure: false,
        collapsedLeavesNothing: false,
      })
    ).toBe(true);
    expect(defaultTurnProcessOpen({ ...closed, hasFailure: true })).toBe(true);
    expect(defaultTurnProcessOpen({ ...closed, collapsedLeavesNothing: true })).toBe(true);
    expect(defaultTurnProcessOpen(closed)).toBe(false);
  });

  it('F-B3: an omitted field reads as false (a completed history turn collapses)', () => {
    expect(defaultTurnProcessOpen({})).toBe(false);
  });
});

describe('[FB4-6] the authorization red line keeps its position', () => {
  const source = readFileSync(fileURLToPath(new URL('../chatTurn.ts', import.meta.url)), 'utf8');

  /**
   * `hasUnresolvedPermission` is a SEPARATE, FIRST return, not one disjunct
   * among four. Folded into the `Boolean(a || b || c)` line below it the truth
   * table is identical today — which is exactly why a behaviour assertion
   * cannot tell the two apart — but the guarantee is gone: any rule added later
   * that returns `false` would then be able to outrank it and bury a pending
   * authorization card inside a collapsed shell.
   */
  it('the unresolved-permission branch is the first statement of the body', () => {
    const start = source.indexOf('export function defaultTurnProcessOpen(');
    expect(start, 'defaultTurnProcessOpen not found').toBeGreaterThan(-1);
    const body = source.slice(source.indexOf('{', start), source.indexOf('\n}', start));
    const statements = body
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && line !== '{');
    expect(statements[0]).toBe('if (input.hasUnresolvedPermission) return true;');
    // …and it is not ALSO a disjunct in the fallthrough, which would make the
    // first return look redundant to the next person who reads it.
    expect(statements[1]).not.toContain('hasUnresolvedPermission');
  });
});

describe('hasUnresolvedPermission', () => {
  it('F-B4: an unanswered permission_request is unresolved', () => {
    expect(hasUnresolvedPermission(turnOf([assistant([permission()])]))).toBe(true);
    expect(hasUnresolvedPermission(turnOf([assistant([permission(false)])]))).toBe(true);
  });

  it('F-B4: resolved: true is not unresolved', () => {
    expect(hasUnresolvedPermission(turnOf([assistant([permission(true)])]))).toBe(false);
  });

  it('F-B4: a turn with no permission block at all is false', () => {
    expect(hasUnresolvedPermission(turnOf([assistant([text('hi')])]))).toBe(false);
    expect(hasUnresolvedPermission(turnOf([]))).toBe(false);
  });

  it('F-B4: scans every body message, not just the first', () => {
    const turn = turnOf([assistant([text('hi')]), assistant([permission()])]);
    expect(hasUnresolvedPermission(turn)).toBe(true);
  });
});

describe('turnHasFailure', () => {
  it('detects toolOk === false anywhere in the body', () => {
    expect(turnHasFailure(turnOf([assistant(toolPair('Bash', { ok: false }))]))).toBe(true);
  });

  it('a successful turn is not a failure', () => {
    expect(turnHasFailure(turnOf([assistant(toolPair('Bash'))]))).toBe(false);
    expect(turnHasFailure(turnOf([]))).toBe(false);
  });
});

/**
 * Review batch F7. The store hands the timeline a fresh bucket array on every
 * streamed token, so `groupMessagesIntoTurns` mints a fresh object for every
 * turn in the session — and `React.memo` on `ChatTurn` never holds. This pass
 * is what keeps a token's re-render cost proportional to the turn it landed in.
 */
describe('stabilizeTurns (F7)', () => {
  it('F7: an unchanged turn keeps its previous object identity', () => {
    const first = user([text('q1')]);
    const reply = assistant([text('a1')]);
    const previous = groupMessagesIntoTurns([first, reply]);
    const next = groupMessagesIntoTurns([first, reply]);

    // The fold itself allocates fresh objects — that is the problem being solved.
    expect(next[0]).not.toBe(previous[0]);
    expect(stabilizeTurns(previous, next)[0]).toBe(previous[0]);
  });

  it('F7: a token in the last turn only changes the last turn', () => {
    const q1 = user([text('q1')]);
    const a1 = assistant([text('a1')]);
    const q2 = user([text('q2')]);
    const a2 = assistant([text('partial')]);
    const previous = stabilizeTurns([], groupMessagesIntoTurns([q1, a1, q2, a2]));

    // `upsertMessage` replaces exactly the message it touched and keeps every
    // other identity, which is what makes a reference comparison sufficient.
    const a2Grown = { ...a2, blocks: [text('partial plus more')] };
    const stabilized = stabilizeTurns(previous, groupMessagesIntoTurns([q1, a1, q2, a2Grown]));

    expect(stabilized[0]).toBe(previous[0]);
    expect(stabilized[1]).not.toBe(previous[1]);
    expect(stabilized[1].body[0]).toBe(a2Grown);
  });

  it('F7: a new turn is not reused from anywhere', () => {
    const q1 = user([text('q1')]);
    const a1 = assistant([text('a1')]);
    const previous = stabilizeTurns([], groupMessagesIntoTurns([q1, a1]));
    const q2 = user([text('q2')]);
    const stabilized = stabilizeTurns(previous, groupMessagesIntoTurns([q1, a1, q2]));

    expect(stabilized).toHaveLength(2);
    expect(stabilized[0]).toBe(previous[0]);
    expect(stabilized[1].user).toBe(q2);
  });

  it('F7: a turn that gained its first reply is NOT reused', () => {
    const q1 = user([text('q1')]);
    const previous = stabilizeTurns([], groupMessagesIntoTurns([q1]));
    const a1 = assistant([text('a1')]);
    const stabilized = stabilizeTurns(previous, groupMessagesIntoTurns([q1, a1]));

    expect(stabilized[0]).not.toBe(previous[0]);
    expect(stabilized[0].body).toHaveLength(1);
  });

  // Fed its own output back in, as `MessageTimeline`'s `useMemo` does.
  it('F7: idempotent', () => {
    const q1 = user([text('q1')]);
    const a1 = assistant([text('a1')]);
    const once = stabilizeTurns([], groupMessagesIntoTurns([q1, a1]));
    const twice = stabilizeTurns(once, groupMessagesIntoTurns([q1, a1]));
    expect(twice[0]).toBe(once[0]);
    expect(stabilizeTurns(twice, groupMessagesIntoTurns([q1, a1]))[0]).toBe(once[0]);
  });

  // F-B1's invariant must survive the pass: reuse may not drop or duplicate a
  // turn, whatever the previous list looked like.
  it('F7: never changes the turn list itself', () => {
    const q1 = user([text('q1')]);
    const a1 = assistant([text('a1')]);
    const q2 = user([text('q2')]);
    const next = groupMessagesIntoTurns([q1, a1, q2]);
    const stale = groupMessagesIntoTurns([user([text('gone')])]);
    const stabilized = stabilizeTurns(stale, next);

    expect(stabilized.map((turn) => turn.id)).toEqual(next.map((turn) => turn.id));
    expect(stabilizeTurns([], next)).toEqual(next);
  });
});
