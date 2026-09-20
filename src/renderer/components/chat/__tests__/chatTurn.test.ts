import { describe, expect, it } from 'vitest';
import type { ChatBlock, ChatMessage } from '@/stores/chatSessions';
import {
  countAssistantReplyChars,
  flattenTurnItems,
  groupMessagesIntoTurns,
  mergeAdjacentToolGroups,
  segmentTurnBody,
  stabilizeTurns,
  type Turn,
  type TurnItem,
  turnItemPlacement,
} from '../chatTurn';
import { countProcessSteps } from '../turnProcessFold';

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
// T105 — the item layer stitches adjacent tool groups across messages
// ---------------------------------------------------------------------------

/**
 * `groupTimeline` is per-MESSAGE, so one continuous stream of tool calls is cut
 * wherever the Host opened a new assistant message — and opening a new message
 * per tool result is the normal shape, not an edge case. The aggregate the user
 * asked for is 「少数几条过程摘要」, so those cuts have to be sewn back together
 * before the row layer ever sees them.
 */
describe('mergeAdjacentToolGroups (T105)', () => {
  const groupsOf = (items: readonly TurnItem[]) =>
    items.filter((item) => item.kind === 'toolGroup');

  const entryCount = (items: readonly TurnItem[]) =>
    items.reduce((total, item) => (item.kind === 'toolGroup' ? total + item.entries.length : total), 0);

  it('[MERGE-1] two groups that touch across a message boundary become one', () => {
    const a1 = assistant([...toolPair('Read')]);
    const a2 = assistant([...toolPair('Grep')]);
    const items = flattenTurnItems(turnOf([a1, a2]));
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('toolGroup');
    if (items[0].kind !== 'toolGroup') throw new Error('expected a toolGroup');
    expect(items[0].entries).toHaveLength(2);
  });

  it('[MERGE-2] the merge keeps the FIRST item’s messageId, so the key does not move', () => {
    // `turnItemKey` is `${messageId}~group-${blockIndex}`. Taking the tail's id
    // would re-key the row on every merge and remount it, discarding the
    // reader's expanded state mid-turn.
    const a1 = assistant([...toolPair('Read')]);
    const a2 = assistant([...toolPair('Grep')]);
    const merged = flattenTurnItems(turnOf([a1, a2]))[0];
    expect(merged.messageId).toBe(a1.id);
    if (merged.kind !== 'toolGroup') throw new Error('expected a toolGroup');
    expect(merged.blockIndex).toBe(0);
  });

  it('[MERGE-3] records every contributing message in `messageIds`', () => {
    // The field the renderer needs: it looks the streaming thinking block up
    // per MESSAGE, so without this the live thought of any message after the
    // first silently stops updating — no error, nothing red.
    const a1 = assistant([...toolPair('Read')]);
    const a2 = assistant([...toolPair('Grep')]);
    const a3 = assistant([...toolPair('Bash')]);
    const merged = flattenTurnItems(turnOf([a1, a2, a3]))[0];
    if (merged.kind !== 'toolGroup') throw new Error('expected a toolGroup');
    expect(merged.messageIds).toEqual([a1.id, a2.id, a3.id]);
  });

  it('[MERGE-4] a group that did NOT merge carries no `messageIds` at all', () => {
    // Absence is the signal "one message" — a group that always carried a
    // single-element array would make every consumer branch for nothing.
    const a1 = assistant([...toolPair('Read')]);
    const items = flattenTurnItems(turnOf([a1]));
    if (items[0].kind !== 'toolGroup') throw new Error('expected a toolGroup');
    expect(items[0].messageIds).toBeUndefined();
  });

  it('[MERGE-5] prose between two groups is a real interruption — no merge', () => {
    const a1 = assistant([...toolPair('Read')]);
    const a2 = assistant([text('here is what I found'), ...toolPair('Grep')]);
    const items = flattenTurnItems(turnOf([a1, a2]));
    expect(items.map((item) => item.kind)).toEqual(['toolGroup', 'text', 'toolGroup']);
    // The second group must survive as its OWN item with its own id — the
    // shape assertion above is satisfied by the pre-merge code too, so it is
    // this that actually distinguishes "not merged" from "not implemented".
    expect(items[2].messageId).toBe(a2.id);
    expect((items[2] as { messageIds?: unknown }).messageIds).toBeUndefined();
  });

  it('[MERGE-6] a QUESTION between two groups is not merged through', () => {
    const a1 = assistant([...toolPair('Read')]);
    const a2 = assistant([{ id: 'q1', type: 'question' }, ...toolPair('Grep')]);
    const items = flattenTurnItems(turnOf([a1, a2]));
    expect(items.map((item) => item.kind)).toEqual(['toolGroup', 'question', 'toolGroup']);
    expect(items[2].messageId).toBe(a2.id);
  });

  it('[MERGE-7] an UNANSWERED permission between two groups is not merged through', () => {
    // The Allow/Deny surface: a merge here would put the pending card's
    // neighbours in one row and leave the card itself wedged between two
    // aggregates with nothing to anchor it to.
    const a1 = assistant([...toolPair('Read')]);
    const a2 = assistant([
      { id: 'p1', type: 'permission_request', permissionId: 'nothing-matches', toolName: 'Bash' },
      ...toolPair('Grep'),
    ]);
    const items = flattenTurnItems(turnOf([a1, a2]));
    expect(items.map((item) => item.kind)).toEqual(['toolGroup', 'permission', 'toolGroup']);
    expect(items[2].messageId).toBe(a2.id);
  });

  it('[MERGE-8] a NOTICE between two groups is not merged through', () => {
    const a1 = assistant([...toolPair('Read')]);
    const sys = system([text('session resumed')]);
    const a2 = assistant([...toolPair('Grep')]);
    const items = flattenTurnItems(turnOf([a1, sys, a2]));
    expect(items.map((item) => item.kind)).toEqual(['toolGroup', 'notice', 'toolGroup']);
    expect(items[2].messageId).toBe(a2.id);
  });

  it('[MERGE-9] conserves Σ entries and the process step count', () => {
    // The merge moves entries between items; it may never drop or duplicate
    // one. `countProcessSteps` is what the head reports as 「N 个步骤」, so a
    // merge that changed the total would silently change the head's copy.
    const a1 = assistant([...toolPair('Read'), thinking()]);
    const a2 = assistant([...toolPair('Grep'), ...toolPair('Bash')]);
    const merged = flattenTurnItems(turnOf([a1, a2]));
    expect(entryCount(merged)).toBe(4);
    expect(countProcessSteps(merged as never)).toBe(4);
  });

  it('[MERGE-10] is idempotent, and preserves everything it does not merge', () => {
    const a1 = assistant([...toolPair('Read')]);
    const a2 = assistant([...toolPair('Grep')]);
    const once = flattenTurnItems(turnOf([a1, a2]));
    // Re-running over an already-merged list finds no two adjacent groups, so
    // the second pass is a no-op — asserted on identity, which is the property
    // `useMemo` and `React.memo` downstream actually depend on.
    expect(mergeAdjacentToolGroups(once)).toEqual(once);
    expect(mergeAdjacentToolGroups(once)[0]).toBe(once[0]);
  });

  it('[MERGE-11] a lone group and an empty list pass through untouched', () => {
    const a1 = assistant([...toolPair('Read')]);
    const items = flattenTurnItems(turnOf([a1]));
    expect(mergeAdjacentToolGroups(items)).toEqual(items);
    expect(mergeAdjacentToolGroups([])).toEqual([]);
  });

  it('[MERGE-12] three messages in a row merge into ONE group, keys unchanged', () => {
    const a1 = assistant([...toolPair('Read')]);
    const a2 = assistant([...toolPair('Grep')]);
    const a3 = assistant([...toolPair('Bash')]);
    const merged = groupsOf(flattenTurnItems(turnOf([a1, a2, a3])));
    expect(merged).toHaveLength(1);
    expect(merged[0].messageId).toBe(a1.id);
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

/**
 * ⚠️ RETIRED (2026-08-25, user decision): the `defaultTurnProcessOpen`,
 * `[FB4-6]`, `hasUnresolvedPermission` and `turnHasFailure` blocks went with
 * the turn-level collapse those functions served. See `chatTurn.ts`'s closing
 * note for why the authorization red line got STRONGER rather than weaker —
 * the process segment now renders unconditionally, so a pending Allow/Deny card
 * cannot be hidden at all, and the guarantee is asserted structurally in
 * `messageTimelineWiring.test.ts` instead of as a first-return ordering rule
 * here.
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

describe('F06 assistant reply character count', () => {
  const text = (value: string) => block('text', { text: value });

  it('is zero for a turn with no assistant text, so the status line shows no ↓', () => {
    expect(countAssistantReplyChars([])).toBe(0);
    expect(countAssistantReplyChars([assistant([])])).toBe(0);
  });

  it('counts only prose, never thinking or tool traffic', () => {
    const body = [
      assistant([
        block('thinking', { text: 'a very long private deliberation' }),
        block('tool_call', { toolName: 'read', text: 'read(path)' }),
        block('tool_result', { text: 'x'.repeat(4000) }),
        text('Hello'),
      ]),
    ];
    expect(countAssistantReplyChars(body)).toBe(5);
  });

  it('accumulates across blocks and across messages as the stream grows', () => {
    const first = assistant([text('abc')]);
    expect(countAssistantReplyChars([first])).toBe(3);
    expect(countAssistantReplyChars([assistant([text('abc'), text('de')])])).toBe(5);
    expect(countAssistantReplyChars([assistant([text('abc')]), assistant([text('de')])])).toBe(5);
  });

  it('counts code points, the same unit the ↑ count uses', () => {
    // Four CJK characters and one astral emoji: 5 code points, 7 UTF-16 units.
    expect(countAssistantReplyChars([assistant([text('你好世界🙂')])])).toBe(5);
  });

  it('ignores the user side and non-assistant notices', () => {
    const body = [
      system([text('session resumed')]),
      errorMessage([text('something failed')]),
      assistant([text('ok')]),
    ];
    expect(countAssistantReplyChars(body)).toBe(2);
    expect(countAssistantReplyChars([user([text('a long question')])])).toBe(0);
  });

  it('excludes replayed history, so a hydration cannot inflate the count', () => {
    const replayed: ChatMessage = {
      id: 'h:abc',
      sessionId: 's1',
      role: 'assistant',
      blocks: [text('previous answer')],
    };
    expect(countAssistantReplyChars([replayed])).toBe(0);
    expect(countAssistantReplyChars([replayed, assistant([text('new')])])).toBe(3);
  });
});
