import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { describe, expect, it } from 'vitest';
import { SessionLiveJournal } from '../sessionLiveJournal';

let seq = 0;
function ev(event: Record<string, unknown>): RuntimeEvent {
  seq += 1;
  return { seq, timestamp: seq, ...event } as unknown as RuntimeEvent;
}
const status = (sessionId: string, value: string) =>
  ev({ type: 'session.status', sessionId, payload: { status: value } });
const delta = (sessionId: string, text: string) =>
  ev({ type: 'message.delta', sessionId, payload: { messageId: 'm1', blockId: 'b1', text } });
const asked = (sessionId: string, permissionId: string) =>
  ev({ type: 'permission.requested', sessionId, payload: { permissionId, toolName: 'bash' } });
const answered = (sessionId: string, permissionId: string) =>
  ev({ type: 'permission.resolved', sessionId, payload: { permissionId, allow: true } });
const question = (sessionId: string, questionId: string) =>
  ev({ type: 'question.requested', sessionId, payload: { questionId } });
const questionDone = (sessionId: string, questionId: string) =>
  ev({ type: 'question.resolved', sessionId, payload: { questionId, outcome: 'answered' } });

describe('SessionLiveJournal (issue #25)', () => {
  it('[M25-JOURNAL] a late joiner gets the turn in flight and the prompts still waiting', () => {
    const journal = new SessionLiveJournal();
    journal.record(status('s1', 'running'));
    journal.record(delta('s1', 'hel'));
    journal.record(asked('s1', 'p1'));
    journal.record(asked('s1', 'p2'));
    journal.record(answered('s1', 'p1'));
    journal.record(question('s1', 'q1'));
    journal.record(delta('s2', 'other session'));

    const snapshot = journal.snapshot('s1');
    expect(snapshot.status).toBe('running');
    expect(snapshot.pendingPermissions.map((e) => e.payload.permissionId)).toEqual(['p2']);
    expect(snapshot.pendingQuestions.map((e) => e.payload.questionId)).toEqual(['q1']);
    expect(snapshot.turn.map((entry) => entry.event.type)).toEqual([
      'session.status',
      'message.delta',
      'permission.requested',
      'permission.requested',
      'permission.resolved',
      'question.requested',
    ]);
    expect(snapshot.turnTruncated).toBe(false);

    journal.record(questionDone('s1', 'q1'));
    expect(journal.snapshot('s1').pendingQuestions).toEqual([]);
  });

  it('[M25-JOURNAL] a settled session has no turn and no prompts left', () => {
    const journal = new SessionLiveJournal();
    journal.record(status('s1', 'running'));
    journal.record(asked('s1', 'p1'));
    journal.record(question('s1', 'q1'));
    journal.record(status('s1', 'idle'));
    expect(journal.snapshot('s1')).toEqual({
      status: 'idle',
      pendingPermissions: [],
      pendingQuestions: [],
      turn: [],
      turnTruncated: false,
    });
    // The next turn starts from empty.
    journal.record(status('s1', 'running'));
    expect(journal.snapshot('s1').turn).toHaveLength(1);
  });

  it('[M25-JOURNAL] waiting for an answer is not settled', () => {
    const journal = new SessionLiveJournal();
    journal.record(status('s1', 'running'));
    journal.record(asked('s1', 'p1'));
    journal.record(status('s1', 'waiting_permission'));
    expect(journal.snapshot('s1').pendingPermissions).toHaveLength(1);
    expect(journal.snapshot('s1').turn).toHaveLength(3);
  });

  it('[M25-JOURNAL] a turn that outgrows its buffer says so', () => {
    const journal = new SessionLiveJournal({ turnCapacity: 2 });
    journal.record(status('s1', 'running'));
    journal.record(delta('s1', 'a'));
    journal.record(delta('s1', 'b'));
    const snapshot = journal.snapshot('s1');
    expect(snapshot.turn).toHaveLength(2);
    expect(snapshot.turnTruncated).toBe(true);
  });

  it('[M25-JOURNAL] a reconnecting client catches up by cursor, or is told it cannot', () => {
    const journal = new SessionLiveJournal({ logCapacity: 3 });
    expect(journal.since(0)).toEqual({ entries: [] });
    const first = journal.record(delta('s1', 'a'));
    journal.record(delta('s1', 'b'));
    journal.record(delta('s2', 'c'));
    expect(first).toBe(1);
    expect(journal.cursor).toBe(3);

    const caughtUp = journal.since(1);
    expect('entries' in caughtUp && caughtUp.entries.map((e) => e.cursor)).toEqual([2, 3]);
    expect(journal.since(3)).toEqual({ entries: [] });

    journal.record(delta('s1', 'd'));
    // Cursor 1 has been dropped; a client still at 0 missed it.
    expect(journal.since(0)).toEqual({ gap: true });
    const fromOne = journal.since(1);
    expect('entries' in fromOne && fromOne.entries.map((e) => e.cursor)).toEqual([2, 3, 4]);
  });

  it('[M25-JOURNAL] history pages and stderr are not journalled', () => {
    const journal = new SessionLiveJournal();
    expect(journal.record(ev({ type: 'session.history', sessionId: 's1', payload: {} }))).toBe(
      undefined
    );
    expect(
      journal.record(ev({ type: 'session.stderr', sessionId: 's1', payload: { line: 'x' } }))
    ).toBe(undefined);
    expect(journal.cursor).toBe(0);
    expect(journal.snapshot('s1').turn).toEqual([]);
  });

  it('[M25-JOURNAL] forgetting a session drops its state only', () => {
    const journal = new SessionLiveJournal();
    journal.record(asked('s1', 'p1'));
    journal.forget('s1');
    expect(journal.snapshot('s1').pendingPermissions).toEqual([]);
    expect(journal.since(0)).toMatchObject({ entries: [{ cursor: 1 }] });
  });
});
