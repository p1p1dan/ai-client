import { describe, expect, it } from 'vitest';
import type { ChatBlock, ChatMessage } from '@/stores/chatSessions';
import {
  defaultTurnProcessOpen,
  flattenTurnItems,
  groupMessagesIntoTurns,
  hasUnresolvedPermission,
  splitTurnBody,
  stabilizeTurns,
  type Turn,
  type TurnItem,
  turnHasFailure,
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

describe('splitTurnBody', () => {
  it('F-B2: [think,tool,text,tool,text] splits 4 / 1', () => {
    const items = ['toolGroup', 'toolGroup', 'text', 'toolGroup', 'text'].map((kind) =>
      item(kind as TurnItem['kind'])
    );
    const { process, answer } = splitTurnBody(items);
    expect(process).toHaveLength(4);
    expect(answer).toHaveLength(1);
  });

  it('F-B2: a single text block is all answer, no process (no collapsible shell renders)', () => {
    const { process, answer } = splitTurnBody([item('text')]);
    expect(process).toHaveLength(0);
    expect(answer).toHaveLength(1);
  });

  it('F-B2: a turn ending in a tool row is all process, no answer', () => {
    const { process, answer } = splitTurnBody([item('toolGroup')]);
    expect(process).toHaveLength(1);
    expect(answer).toHaveLength(0);
  });

  it('F-B2: a trailing run of text items all belongs to the answer', () => {
    const { process, answer } = splitTurnBody([item('text'), item('text')]);
    expect(process).toHaveLength(0);
    expect(answer).toHaveLength(2);
  });

  it('F-B2: an unresolved permission stays in the process segment (block order, not promoted)', () => {
    const { process, answer } = splitTurnBody([item('toolGroup'), item('permission')]);
    expect(process.map((entry) => entry.kind)).toEqual(['toolGroup', 'permission']);
    expect(answer).toHaveLength(0);
  });

  it('F-B2: a trailing notice terminates the answer tail (spec §4.4 is a literal text-tail rule)', () => {
    const { process, answer } = splitTurnBody([item('text'), item('notice')]);
    expect(process).toHaveLength(2);
    expect(answer).toHaveLength(0);
  });

  it('F-B6: appending to the streaming text block does not move the split', () => {
    const streamingBlock = text('partial');
    const reply = assistant([thinking(), ...toolPair('Read'), streamingBlock]);
    const before = splitTurnBody(flattenTurnItems(turnOf([reply])));
    expect([before.process.length, before.answer.length]).toEqual([1, 1]);

    streamingBlock.text = 'partial and then some more tokens';
    const after = splitTurnBody(flattenTurnItems(turnOf([reply])));
    expect([after.process.length, after.answer.length]).toEqual([
      before.process.length,
      before.answer.length,
    ]);
  });

  it('F-B6: a new tool call after the answer moves it into process exactly once', () => {
    const reply = assistant([text('first pass')]);
    expect(splitTurnBody(flattenTurnItems(turnOf([reply]))).answer).toHaveLength(1);

    reply.blocks.push(...toolPair('Bash'));
    const mid = splitTurnBody(flattenTurnItems(turnOf([reply])));
    expect([mid.process.length, mid.answer.length]).toEqual([2, 0]);

    reply.blocks.push(text('second pass'));
    const settled = splitTurnBody(flattenTurnItems(turnOf([reply])));
    expect([settled.process.length, settled.answer.length]).toEqual([2, 1]);
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
    answerEmpty: false,
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
        answerEmpty: false,
      })
    ).toBe(true);
    expect(defaultTurnProcessOpen({ ...closed, hasFailure: true })).toBe(true);
    expect(defaultTurnProcessOpen({ ...closed, answerEmpty: true })).toBe(true);
    expect(defaultTurnProcessOpen(closed)).toBe(false);
  });

  it('F-B3: an omitted field reads as false (a completed history turn collapses)', () => {
    expect(defaultTurnProcessOpen({})).toBe(false);
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
