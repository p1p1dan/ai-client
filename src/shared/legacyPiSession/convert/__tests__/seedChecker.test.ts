import { describe, expect, it } from 'vitest';
import { checkSeed, type DshSeedEvent, jsonFault } from '../index.ts';

/**
 * dsh-rebase P1-9b — the seed checker catches what `dsh-session` would
 * refuse, what `dsh-session/invariant` would flag, and what this converter
 * promises on top. Each case breaks one rule of a valid seed.
 */

function valid(): DshSeedEvent[] {
  const events: Omit<DshSeedEvent, 'seq'>[] = [
    { type: 'turn/start', time: 1, data: { turn: 1 } },
    { type: 'step/start', time: 1, data: { turn: 1, step: 1 } },
    {
      type: 'system/message',
      time: 1,
      data: {
        turn: 1,
        step: 1,
        message: { id: 'u:sys0', role: 'system', content: [], source: { kind: 'system-prompt' } },
      },
      surfaceOp: 'append',
    },
    {
      type: 'user/message',
      time: 1,
      data: {
        id: 'u',
        role: 'user',
        content: [{ type: 'text', text: 'q' }],
        source: { kind: 'user' },
      },
      surfaceOp: 'append',
    },
    {
      type: 'assistant/message',
      time: 2,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'a',
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'c', name: 'read', arguments: '{}' }],
          source: { kind: 'model', provider: 'p', model: 'm' },
        },
        stream: [],
      },
      surfaceOp: 'append',
    },
    {
      type: 'tool/call',
      time: 2,
      data: { turn: 1, step: 1, callId: 'c', name: 'read', arguments: '{}' },
    },
    {
      type: 'tool/result',
      time: 3,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'r',
          role: 'tool',
          content: [],
          source: { kind: 'tool', callId: 'c' },
          toolCallId: 'c',
          isError: false,
        },
      },
      surfaceOp: 'append',
      sourceEventSeqs: [5],
    },
    {
      type: 'aiclient/pi-label',
      time: 3,
      data: { targetMessageId: 'a', label: 'x' },
      ignorable: true,
    },
    { type: 'step/end', time: 3, data: { turn: 1, step: 1 } },
    { type: 'turn/end', time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
    ...compaction(),
  ];
  return events.map((event, seq) => ({ ...event, seq }) as DshSeedEvent);
}

/** Seqs 10–13: a standalone compaction shadowing nodes 3, 4 and 6. */
function compaction(): Omit<DshSeedEvent, 'seq'>[] {
  return [
    { type: 'compaction/start', time: 4, data: { compactionId: 'k', turn: null } },
    {
      type: 'compaction/summary',
      time: 4,
      data: {
        compactionId: 'k',
        summary: [{ type: 'text', text: 's' }],
        shadowedRange: { start: 3, end: 6 },
        shadowedSeqs: [3, 4, 6],
        shadowedTokenCount: 30,
        provider: 'p',
        model: 'm',
      },
    },
    {
      type: 'user/message',
      time: 4,
      data: {
        id: 'k',
        role: 'user',
        content: [],
        source: { kind: 'compact-checkpoint', compactionId: 'k' },
      },
      surfaceOp: { op: 'replace', startSeq: 3, endSeq: 6 },
      sourceEventSeqs: [10, 11, 3, 4, 6],
    },
    { type: 'compaction/end', time: 4, data: { compactionId: 'k', turn: null } },
  ];
}

/** The seed P1-9b wrote: its checkpoint with no transaction around it. */
function bare(): DshSeedEvent[] {
  const events = valid().filter((event) => !event.type.startsWith('compaction/'));
  events.forEach((event, seq) => {
    event.seq = seq;
  });
  const checkpoint = events[10] as DshSeedEvent;
  checkpoint.sourceEventSeqs = [3, 4, 6];
  return events;
}

const rules = (events: DshSeedEvent[]) => [
  ...new Set(checkSeed(events).map((violation) => violation.rule)),
];

function broken(change: (events: DshSeedEvent[]) => void): string[] {
  const events = structuredClone(valid());
  change(events);
  return rules(events);
}

const data = (event: DshSeedEvent | undefined) => event?.data as Record<string, unknown>;

describe('checkSeed', () => {
  it('accepts a loop-shaped seed with a compaction', () => {
    expect(checkSeed(valid())).toEqual([]);
  });

  it.each<[string, (events: DshSeedEvent[]) => void, string]>([
    [
      'a seq gap',
      (events) => {
        (events[4] as DshSeedEvent).seq = 9;
      },
      'seed/seq',
    ],
    [
      'an unknown envelope key',
      (events) => {
        Object.assign(events[0] as object, { extra: 1 });
      },
      'seed/envelope',
    ],
    [
      'a fractional time',
      (events) => {
        (events[0] as DshSeedEvent).time = 1.5;
      },
      'seed/envelope',
    ],
    [
      'an undefined value',
      (events) => {
        data(events[0]).turnless = undefined;
      },
      'seed/json',
    ],
    [
      'an unknown required event',
      (events) => {
        (events[7] as DshSeedEvent).type = 'custom/thing';
        delete (events[7] as DshSeedEvent).ignorable;
      },
      'seed/type',
    ],
    [
      'an aiclient record that is not ignorable',
      (events) => {
        delete (events[7] as DshSeedEvent).ignorable;
      },
      'shape/ignorable',
    ],
    [
      'a message without surfaceOp',
      (events) => {
        delete (events[3] as DshSeedEvent).surfaceOp;
      },
      'seed/surface',
    ],
    [
      'sources on a boundary event',
      (events) => {
        (events[0] as DshSeedEvent).sourceEventSeqs = [0];
      },
      'seed/surface',
    ],
    [
      'a replacement over the system head',
      (events) => {
        (events[12] as DshSeedEvent).surfaceOp = { op: 'replace', startSeq: 2, endSeq: 6 };
        (events[12] as DshSeedEvent).sourceEventSeqs = [10, 11, 2, 3, 4, 6];
      },
      'seed/surface-replace',
    ],
    [
      'a replacement that does not cite what it shadows',
      (events) => {
        (events[12] as DshSeedEvent).sourceEventSeqs = [10, 11, 3];
      },
      'seed/surface-replace',
    ],
    [
      'a summary that names another span than the checkpoint shadows',
      (events) => {
        data(events[11]).shadowedSeqs = [3, 4];
        data(events[11]).shadowedRange = { start: 3, end: 4 };
      },
      'read/compaction',
    ],
    [
      'a summary without the route that wrote it',
      (events) => {
        delete data(events[11]).model;
      },
      'read/compaction',
    ],
    [
      'a summary without a shadow price',
      (events) => {
        data(events[11]).shadowedTokenCount = -1;
      },
      'read/compaction',
    ],
    [
      'a start owned by a turn that is not open',
      (events) => {
        data(events[10]).turn = 1;
      },
      'read/compaction',
    ],
    [
      'an end that changes the owner',
      (events) => {
        data(events[13]).turn = 2;
      },
      'read/compaction',
    ],
    [
      'an end for another compaction',
      (events) => {
        data(events[13]).compactionId = 'other';
      },
      'read/compaction',
    ],
    [
      'a checkpoint of another compaction',
      (events) => {
        data(events[12]).source = { kind: 'compact-checkpoint', compactionId: 'other' };
      },
      'read/compaction',
    ],
    [
      'a checkpoint that does not cite its start and summary first',
      (events) => {
        (events[12] as DshSeedEvent).sourceEventSeqs = [3, 4, 6];
      },
      'read/compaction',
    ],
    [
      'a message without id',
      (events) => {
        data(events[3]).id = '';
      },
      'seed/message',
    ],
    [
      'a reply without a model source',
      (events) => {
        (data(events[4]).message as Record<string, unknown>).source = { kind: 'model' };
      },
      'seed/message',
    ],
    [
      'an error on a successful result',
      (events) => {
        data(events[6]).error = { name: 'x', code: 'y' };
      },
      'seed/message',
    ],
    [
      'a step event outside its step',
      (events) => {
        data(events[4]).step = 2;
      },
      'invariant/step',
    ],
    [
      'a result with no call',
      (events) => {
        (data(events[6]).message as Record<string, unknown>).source = { kind: 'tool', callId: 'z' };
        (data(events[6]).message as Record<string, unknown>).toolCallId = 'z';
      },
      'invariant/tool',
    ],
    [
      'a call that does not match its reply',
      (events) => {
        data(events[5]).name = 'write';
      },
      'shape/tool-pairing',
    ],
    [
      'a result that does not cite its call',
      (events) => {
        (events[6] as DshSeedEvent).sourceEventSeqs = [4];
      },
      'shape/tool-pairing',
    ],
    [
      'a repeated message id',
      (events) => {
        (data(events[4]).message as Record<string, unknown>).id = 'u';
      },
      'shape/message-id',
    ],
    [
      'an interrupted reply with calls',
      (events) => {
        data(events[4]).interrupted = true;
      },
      'shape/interrupted',
    ],
    [
      'an unknown turn end',
      (events) => {
        data(events[9]).reason = { kind: 'maybe' };
      },
      'shape/turn-end',
    ],
    [
      'a system prompt with text',
      (events) => {
        (data(events[2]).message as Record<string, unknown>).content = [
          { type: 'text', text: 'x' },
        ];
      },
      'shape/system-head',
    ],
  ])('flags %s', (_name, change, rule) => {
    expect(broken(change)).toContain(rule);
  });

  it('flags a call left without a result, and turns left open', () => {
    const events = valid().slice(0, 6);
    expect(rules(events)).toEqual(expect.arrayContaining(['shape/balanced']));
    const unanswered = valid().filter((event) => event.type !== 'tool/result' && event.seq < 10);
    unanswered.forEach((event, seq) => {
      event.seq = seq;
    });
    expect(rules(unanswered)).toContain('shape/tool-pairing');
  });

  it('flags a replacing checkpoint outside a compaction transaction (P1-9c E1)', () => {
    expect(rules(bare())).toEqual(['read/compaction']);
    // An appended checkpoint shadows nothing: DSH's reader asks no transaction of it.
    const appended = bare();
    const checkpoint = appended[10] as DshSeedEvent;
    checkpoint.surfaceOp = 'append';
    delete checkpoint.sourceEventSeqs;
    expect(rules(appended)).toEqual([]);
  });

  it('flags a compaction left open, and a turn boundary inside one', () => {
    const open = valid().slice(0, 13);
    expect(rules(open)).toEqual(['read/compaction']);
    const crossing = valid().slice(0, 13);
    crossing.push({ type: 'turn/start', seq: 13, time: 5, data: { turn: 2 } });
    expect(rules(crossing)).toContain('read/compaction');
  });

  it('flags a summary that is not right before its checkpoint', () => {
    const events = valid();
    // Swap summary and start: the summary then precedes the start, not the checkpoint.
    const [start, summary] = [events[10], events[11]] as DshSeedEvent[];
    events[10] = { ...summary, seq: 10 };
    events[11] = { ...start, seq: 11 };
    expect(rules(events)).toContain('read/compaction');
  });

  it('refuses session/end-seed: the constructor appends it', () => {
    const events = valid();
    events.push({ type: 'session/end-seed', seq: events.length, time: 5, data: {} });
    expect(rules(events)).toContain('shape/end-seed');
  });

  it('names where a value stops being lossless JSON', () => {
    expect(jsonFault({ a: [1, { b: Number.NaN }] })).toBe('data.a[1].b is not finite');
    expect(jsonFault({ a: -0 })).toBe('data.a is not finite');
    expect(jsonFault({ a: new Date(0) })).toBe('data.a is not a plain object');
    const holey = [1, 2, 3];
    delete holey[1];
    expect(jsonFault(holey)).toBe('data[1] is a hole');
    expect(jsonFault({ a: [null, 'x', true, { b: 1 }] })).toBeUndefined();
  });
});
