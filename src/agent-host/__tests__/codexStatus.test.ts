import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CODEX_STATUS_FLAG, mapActiveFlags, readThreadStatus } from '../codexStatus.ts';

/**
 * C10 rule 3 acceptance: `thread/status/changed` is the single source allowed to
 * write a waiting state into `session.status`, so this mapper's behaviour is the
 * whole contract. Every assertion below states what it falsifies.
 *
 * The corpus block is driven by the real rescued frames in
 * `fixtures/codex/*.jsonl` (envelope `{dir,tMs,raw}` — payloads live under
 * `.raw`), so "the fixtures are actually exercised" is itself provable.
 */

interface Envelope {
  dir: string;
  tMs: number | null;
  raw: { method?: string; params?: unknown };
}

/** Every `thread/status/changed` params body recorded in the fixture corpus. */
function fixtureStatusParams(): unknown[] {
  const dir = fileURLToPath(new URL('./fixtures/codex/', import.meta.url));
  const params: unknown[] = [];
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .sort();
  for (const name of files) {
    const lines = readFileSync(`${dir}${name}`, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0);
    for (const line of lines) {
      const envelope = JSON.parse(line) as Envelope;
      if (envelope.raw?.method === 'thread/status/changed') params.push(envelope.raw.params);
    }
  }
  return params;
}

describe('readThreadStatus — real recorded corpus', () => {
  it('reproduces the measured 8/4/2/3 census over every recorded frame', () => {
    // Falsifies: any mapping table that disagrees with the wire on ANY of the
    // four observed shapes, and any test that only feeds hand-written objects
    // (if the fixtures moved or lost frames, the totals below go red).
    const readings = fixtureStatusParams().map(readThreadStatus);
    const census = readings.reduce<Record<string, number>>((acc, reading) => {
      const key = reading.status ?? 'null';
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});

    expect(readings).toHaveLength(17);
    expect(census).toEqual({
      running: 8,
      waiting_question: 4,
      waiting_permission: 2,
      idle: 3,
    });
  });

  it('classifies no recorded frame as malformed and finds no unknown flags', () => {
    // Falsifies: an over-strict narrowing that rejects real traffic (e.g. one
    // that demands an `activeFlags` key on idle), and a flag table with a typo
    // in either constant (a typo would push the real flag into unknownFlags).
    const readings = fixtureStatusParams().map(readThreadStatus);
    expect(readings.filter((r) => r.reason === 'malformed')).toEqual([]);
    expect(readings.flatMap((r) => r.unknownFlags)).toEqual([]);
    expect(readings.filter((r) => r.reason === 'idle')).toHaveLength(3);
    expect(readings.filter((r) => r.reason === 'flags')).toHaveLength(14);
  });

  it('confirms the fixtures really do omit activeFlags on idle frames', () => {
    // Falsifies: the belief that `idle` carries `activeFlags: []`. This is the
    // evidence the regression lock below is guarding; if a future edit
    // "normalises" the fixtures by adding the key, this goes red first.
    const idleStatuses = fixtureStatusParams()
      .map((p) => (p as { status: Record<string, unknown> }).status)
      .filter((s) => s.type === 'idle');

    expect(idleStatuses).toHaveLength(3);
    for (const status of idleStatuses) {
      expect(Object.hasOwn(status, 'activeFlags')).toBe(false);
      expect(Object.keys(status)).toEqual(['type']);
    }
  });

  it('keeps the waiting booleans consistent with the status on every frame', () => {
    // Falsifies: a reading whose booleans and `status` disagree — the caller
    // uses the booleans to decide whether a pending prompt is still live, so a
    // drift between the two fields is a silent desync.
    for (const reading of fixtureStatusParams().map(readThreadStatus)) {
      expect(reading.waitingOnApproval).toBe(reading.status === 'waiting_permission');
      expect(reading.waitingOnQuestion).toBe(reading.status === 'waiting_question');
    }
  });
});

describe('readThreadStatus — idle regression lock', () => {
  it('reads {type:"idle"} with no activeFlags key without throwing', () => {
    // Falsifies: any implementation that touches `status.activeFlags` before
    // branching on `status.type`. Such a mapper throws a TypeError at exactly
    // the moment a turn ends — the single most likely defect in this file.
    expect(() => readThreadStatus({ threadId: 't', status: { type: 'idle' } })).not.toThrow();
    expect(readThreadStatus({ threadId: 't', status: { type: 'idle' } })).toEqual({
      status: 'idle',
      waitingOnQuestion: false,
      waitingOnApproval: false,
      unknownFlags: [],
      reason: 'idle',
    });
  });

  it('never reports "no opinion" for idle', () => {
    // Falsifies: mapping every non-active type to `null`. That would leave the
    // session with no idle signal here and force a second idle truth source
    // (someone re-deriving it from `turn/completed`) — the exact duplication
    // this mapper exists to remove.
    const reading = readThreadStatus({ status: { type: 'idle' } });
    expect(reading.status).not.toBeNull();
    expect(reading.status).toBe('idle');
  });
});

describe('mapActiveFlags — the four combinations', () => {
  it('maps an empty flag list to running', () => {
    // Falsifies: treating "active with no flags" as idle or as no opinion.
    expect(mapActiveFlags([])).toEqual({
      status: 'running',
      waitingOnQuestion: false,
      waitingOnApproval: false,
      unknownFlags: [],
    });
  });

  it('maps waitingOnUserInput to waiting_question', () => {
    // Falsifies: swapping the two flag constants (the failure would otherwise
    // only show up as the wrong card in the UI).
    expect(mapActiveFlags([CODEX_STATUS_FLAG.question])).toEqual({
      status: 'waiting_question',
      waitingOnQuestion: true,
      waitingOnApproval: false,
      unknownFlags: [],
    });
  });

  it('maps waitingOnApproval to waiting_permission', () => {
    expect(mapActiveFlags([CODEX_STATUS_FLAG.approval])).toEqual({
      status: 'waiting_permission',
      waitingOnQuestion: false,
      waitingOnApproval: true,
      unknownFlags: [],
    });
  });

  it('prefers waiting_permission when both flags are set (constructed case)', () => {
    // CONSTRUCTED, no real sample exists (see arbitration §4.5 / fixtures
    // README "没捞到" #2): the whole corpus contains zero frames with both
    // flags. This asserts a contract ruling, NOT observed behaviour.
    // Falsifies: a question-first ordering, which would hide a destructive
    // approval behind a question card.
    const both = mapActiveFlags([CODEX_STATUS_FLAG.question, CODEX_STATUS_FLAG.approval]);
    expect(both).toEqual({
      status: 'waiting_permission',
      waitingOnQuestion: true,
      waitingOnApproval: true,
      unknownFlags: [],
    });
    // Order-independent: the wire order of the flags must not change the ruling.
    expect(mapActiveFlags([CODEX_STATUS_FLAG.approval, CODEX_STATUS_FLAG.question])).toEqual(both);
  });
});

describe('mapActiveFlags — unknown flags', () => {
  it('reports an unknown-only list as running and records the flag', () => {
    // Falsifies: throwing on (which would hang the turn) or silently dropping
    // (which would leave us permanently unaware of) a flag added by a future
    // codex release.
    expect(mapActiveFlags(['waitingOnSomethingNew'])).toEqual({
      status: 'running',
      waitingOnQuestion: false,
      waitingOnApproval: false,
      unknownFlags: ['waitingOnSomethingNew'],
    });
  });

  it('decides on the known flag while still recording the unknown one', () => {
    // Falsifies: an all-or-nothing narrowing that discards the whole reading as
    // soon as one unrecognised flag appears.
    expect(mapActiveFlags(['waitingOnSomethingNew', CODEX_STATUS_FLAG.question])).toEqual({
      status: 'waiting_question',
      waitingOnQuestion: true,
      waitingOnApproval: false,
      unknownFlags: ['waitingOnSomethingNew'],
    });
  });

  it('keeps unknown flags verbatim and in wire order', () => {
    // Falsifies: normalising/sorting/casing the flag names before handing them
    // to the caller's WARN log — the log must be greppable against real traffic.
    expect(mapActiveFlags(['zeta', 'Alpha', CODEX_STATUS_FLAG.approval]).unknownFlags).toEqual([
      'zeta',
      'Alpha',
    ]);
  });

  it('does not treat an unknown flag as a reason to stay silent', () => {
    // Falsifies: mapping "contains something unknown" to `null`, which would
    // freeze the session's status until the next clean frame.
    const reading = readThreadStatus({ status: { type: 'active', activeFlags: ['brandNew'] } });
    expect(reading.status).toBe('running');
    expect(reading.reason).toBe('flags');
    expect(reading.unknownFlags).toEqual(['brandNew']);
  });
});

describe('readThreadStatus — malformed payloads', () => {
  const malformedInputs: ReadonlyArray<readonly [string, unknown]> = [
    ['null params', null],
    ['undefined params', undefined],
    ['string params', 'thread/status/changed'],
    ['array params', [{ status: { type: 'idle' } }]],
    ['params without a status field', { threadId: 't' }],
    ['status is null', { status: null }],
    ['status is a string', { status: 'idle' }],
    ['status is an array', { status: [] }],
    ['type is missing', { status: { activeFlags: [] } }],
    ['type is an unknown string', { status: { type: 'suspended', activeFlags: [] } }],
    ['type is not a string', { status: { type: 1, activeFlags: [] } }],
    ['activeFlags is a string', { status: { type: 'active', activeFlags: 'waitingOnApproval' } }],
    ['activeFlags is an object', { status: { type: 'active', activeFlags: { 0: 'x' } } }],
    ['activeFlags holds a non-string', { status: { type: 'active', activeFlags: [42] } }],
    ['active without an activeFlags key', { status: { type: 'active' } }],
  ];

  for (const [label, input] of malformedInputs) {
    it(`returns no opinion for ${label}`, () => {
      // Falsifies: trusting `params` as a typed payload. It is untrusted JSON
      // from the protocol boundary, so every one of these must degrade to "no
      // opinion" rather than throw or invent a status.
      expect(() => readThreadStatus(input)).not.toThrow();
      expect(readThreadStatus(input)).toEqual({
        status: null,
        waitingOnQuestion: false,
        waitingOnApproval: false,
        unknownFlags: [],
        reason: 'malformed',
      });
    });
  }

  it('hands back a fresh reading each time so callers cannot poison a shared object', () => {
    // Falsifies: returning a module-level constant for the malformed case — one
    // caller mutating it would corrupt every later reading.
    const first = readThreadStatus(null);
    const second = readThreadStatus(null);
    expect(first).not.toBe(second);
    expect(first.unknownFlags).not.toBe(second.unknownFlags);
  });
});
