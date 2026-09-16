import type { QuestionItem, RuntimeEvent } from '@shared/types/runtimeEvents';
import { describe, expect, it } from 'vitest';
import { applyRuntimeEvent, type ChatSessionsState } from '../chatSessions';

function baseState(overrides: Partial<ChatSessionsState> = {}): ChatSessionsState {
  return {
    projects: [],
    workspaces: [],
    sessions: [
      { id: 's1', projectId: 'p1', workspaceId: 'w1', title: 's1', status: 'idle', updatedAt: 0 },
    ],
    messages: { s1: [{ id: 'asst-1', sessionId: 's1', role: 'assistant', blocks: [] }] },
    activeSessionId: null,
    recentSessionIds: [],
    pendingPermissions: [],
    pendingQuestions: [],
    hostBoundSessionIds: [],
    runtimeReady: false,
    lastError: null,
    historyErrors: {},
    ...overrides,
  } as ChatSessionsState;
}

const SAMPLE_QUESTIONS: QuestionItem[] = [
  {
    question: 'Which approach?',
    header: 'Approach',
    options: [{ label: 'A' }, { label: 'B', description: 'desc' }],
    multiSelect: false,
  },
];

function requestedEvent(questionId: string | undefined, sessionId = 's1'): RuntimeEvent {
  return {
    type: 'question.requested',
    seq: 1,
    timestamp: 1000,
    sessionId,
    payload: {
      questionId,
      questions: SAMPLE_QUESTIONS,
    },
  } as unknown as RuntimeEvent;
}

function resolvedEvent(
  questionId: string | undefined,
  outcome: 'answered' | 'cancelled' | 'rejected',
  extra: { answers?: Record<string, string>; response?: string } = {},
  sessionId = 's1'
): RuntimeEvent {
  return {
    type: 'question.resolved',
    seq: 2,
    timestamp: 2000,
    sessionId,
    payload: {
      questionId,
      outcome,
      ...extra,
    },
  } as unknown as RuntimeEvent;
}

describe('applyRuntimeEvent — question events (C-04)', () => {
  it('question.requested appends a question block to the latest assistant message and parks it in pendingQuestions + sets the session status', () => {
    const state = baseState();
    const patch = applyRuntimeEvent(state, requestedEvent('q1'));

    const message = patch.messages?.s1?.find((item) => item.id === 'asst-1');
    expect(message?.blocks).toEqual([
      {
        id: 'q1',
        type: 'question',
        questionId: 'q1',
        questions: SAMPLE_QUESTIONS,
        resolved: false,
      },
    ]);

    expect(patch.pendingQuestions).toEqual([
      {
        sessionId: 's1',
        questionId: 'q1',
        messageId: 'asst-1',
      },
    ]);

    const session = patch.sessions?.find((item) => item.id === 's1');
    expect(session?.status).toBe('waiting_question');
  });

  it('question.requested creates a new msg-question-* message when no assistant message exists', () => {
    const state = baseState({ messages: {} });
    const patch = applyRuntimeEvent(state, requestedEvent('q2'));

    expect(patch.messages?.s1).toHaveLength(1);
    const message = patch.messages?.s1?.[0];
    expect(message?.id).toBe('msg-question-q2');
    expect(message?.role).toBe('assistant');
    expect(message?.sessionId).toBe('s1');
    expect(message?.blocks).toEqual([
      {
        id: 'q2',
        type: 'question',
        questionId: 'q2',
        questions: SAMPLE_QUESTIONS,
        resolved: false,
      },
    ]);

    expect(patch.pendingQuestions).toEqual([
      {
        sessionId: 's1',
        questionId: 'q2',
        messageId: 'msg-question-q2',
      },
    ]);
  });

  it('question.requested with a missing questionId returns an empty patch', () => {
    const state = baseState();
    expect(applyRuntimeEvent(state, requestedEvent(undefined))).toEqual({});
  });

  it('question.resolved (answered) freezes the block with outcome + answers, and dequeues it from pendingQuestions', () => {
    const requested = applyRuntimeEvent(baseState(), requestedEvent('q1'));
    const afterRequested = { ...baseState(), ...requested } as ChatSessionsState;

    const patch = applyRuntimeEvent(
      afterRequested,
      resolvedEvent('q1', 'answered', { answers: { 'Which approach?': 'A' } })
    );

    const message = patch.messages?.s1?.find((item) => item.id === 'asst-1');
    const block = message?.blocks.find((item) => item.id === 'q1');
    expect(block).toEqual({
      id: 'q1',
      type: 'question',
      questionId: 'q1',
      questions: SAMPLE_QUESTIONS,
      resolved: true,
      questionOutcome: 'answered',
      questionAnswers: { 'Which approach?': 'A' },
    });
    expect(patch.pendingQuestions).toEqual([]);
  });

  it('question.resolved (cancelled) freezes the block with the cancelled outcome', () => {
    const requested = applyRuntimeEvent(baseState(), requestedEvent('q1'));
    const afterRequested = { ...baseState(), ...requested } as ChatSessionsState;

    const patch = applyRuntimeEvent(afterRequested, resolvedEvent('q1', 'cancelled'));

    const message = patch.messages?.s1?.find((item) => item.id === 'asst-1');
    const block = message?.blocks.find((item) => item.id === 'q1');
    expect(block).toEqual({
      id: 'q1',
      type: 'question',
      questionId: 'q1',
      questions: SAMPLE_QUESTIONS,
      resolved: true,
      questionOutcome: 'cancelled',
    });
    expect(patch.pendingQuestions).toEqual([]);
  });

  it('question.resolved (rejected) freezes the block with the rejected outcome and freeform response', () => {
    const requested = applyRuntimeEvent(baseState(), requestedEvent('q1'));
    const afterRequested = { ...baseState(), ...requested } as ChatSessionsState;

    const patch = applyRuntimeEvent(
      afterRequested,
      resolvedEvent('q1', 'rejected', { response: 'no thanks' })
    );

    const message = patch.messages?.s1?.find((item) => item.id === 'asst-1');
    const block = message?.blocks.find((item) => item.id === 'q1');
    expect(block).toEqual({
      id: 'q1',
      type: 'question',
      questionId: 'q1',
      questions: SAMPLE_QUESTIONS,
      resolved: true,
      questionOutcome: 'rejected',
      questionResponse: 'no thanks',
    });
    expect(patch.pendingQuestions).toEqual([]);
  });

  it('question.resolved tolerates an unknown questionId without crashing, and (A15) leaves the queue parked since the id does not match', () => {
    const requested = applyRuntimeEvent(baseState(), requestedEvent('q1'));
    const afterRequested = { ...baseState(), ...requested } as ChatSessionsState;

    const patch = applyRuntimeEvent(afterRequested, resolvedEvent('unknown-question', 'answered'));

    const message = patch.messages?.s1?.find((item) => item.id === 'asst-1');
    // Block for q1 is untouched — still unresolved — because the resolved event targeted a different id.
    expect(message?.blocks.find((item) => item.id === 'q1')).toEqual({
      id: 'q1',
      type: 'question',
      questionId: 'q1',
      questions: SAMPLE_QUESTIONS,
      resolved: false,
    });
    // Patch carries no dock change at all (not even an explicit null) — the dock stays put.
    expect(patch.pendingQuestions).toBeUndefined();
    expect({ ...afterRequested, ...patch }.pendingQuestions).toEqual(
      afterRequested.pendingQuestions
    );
  });

  it('question.resolved is idempotent — applying the same event twice converges to the same state', () => {
    const requested = applyRuntimeEvent(baseState(), requestedEvent('q1'));
    const afterRequested = { ...baseState(), ...requested } as ChatSessionsState;

    const event = resolvedEvent('q1', 'answered', { answers: { 'Which approach?': 'A' } });

    const firstPatch = applyRuntimeEvent(afterRequested, event);
    const afterFirst = { ...afterRequested, ...firstPatch } as ChatSessionsState;
    const secondPatch = applyRuntimeEvent(afterFirst, event);
    const afterSecond = { ...afterFirst, ...secondPatch } as ChatSessionsState;

    expect(secondPatch.messages).toEqual(firstPatch.messages);
    // The dock is already cleared after the first apply, so the guard is a
    // no-op on the second apply (patch omits the field) — compare the
    // resulting STATE, not the raw patch, to assert true idempotency.
    expect(afterSecond.pendingQuestions).toEqual(afterFirst.pendingQuestions);
  });
});

describe('applyRuntimeEvent — question.resolved dock guard (A15)', () => {
  it('a mismatched questionId (same session) leaves the queue untouched', () => {
    const requested = applyRuntimeEvent(baseState(), requestedEvent('q1'));
    const afterRequested = { ...baseState(), ...requested } as ChatSessionsState;

    const patch = applyRuntimeEvent(afterRequested, resolvedEvent('q-other', 'answered'));

    expect(patch.pendingQuestions).toBeUndefined();
    expect({ ...afterRequested, ...patch }.pendingQuestions).toEqual(
      afterRequested.pendingQuestions
    );
  });

  it('a mismatched sessionId (same questionId) leaves the queue untouched', () => {
    const requested = applyRuntimeEvent(baseState(), requestedEvent('q1'));
    const afterRequested = { ...baseState(), ...requested } as ChatSessionsState;

    // Same questionId 'q1', but the event belongs to a different session.
    const patch = applyRuntimeEvent(afterRequested, resolvedEvent('q1', 'answered', {}, 's2'));

    expect(patch.pendingQuestions).toBeUndefined();
    expect({ ...afterRequested, ...patch }.pendingQuestions).toEqual(
      afterRequested.pendingQuestions
    );
  });

  it('a matching sessionId + questionId dequeues it normally (guard does not block the happy path)', () => {
    const requested = applyRuntimeEvent(baseState(), requestedEvent('q1'));
    const afterRequested = { ...baseState(), ...requested } as ChatSessionsState;

    const patch = applyRuntimeEvent(afterRequested, resolvedEvent('q1', 'answered'));

    expect(patch.pendingQuestions).toEqual([]);
  });
});

/**
 * chat-event-01 / chat-event-02 (T044).
 *
 * The question queue used to be a single slot that `question.requested`
 * overwrote, so a second `ask` took the first card off screen — unanswerable
 * (the dock only shows the slot, the timeline draws nothing for an unresolved
 * question) and unsettled, which parks that turn until the user presses Stop.
 * And nothing ever took `waiting_question` back off the session, so the Run
 * panel kept saying "Waiting for an answer" for the rest of the turn.
 */
describe('applyRuntimeEvent — concurrent questions (chat-event-01/02)', () => {
  /** Two `ask` calls from the same assistant message, neither answered yet. */
  function parkTwoQuestions(): ChatSessionsState {
    const first = applyRuntimeEvent(baseState(), requestedEvent('q1'));
    const afterFirst = { ...baseState(), ...first } as ChatSessionsState;
    const second = applyRuntimeEvent(afterFirst, requestedEvent('q2'));
    return { ...afterFirst, ...second } as ChatSessionsState;
  }

  function statusOf(state: ChatSessionsState, sessionId = 's1'): string | undefined {
    return state.sessions.find((item) => item.id === sessionId)?.status;
  }

  it('chat-event-01: a second question parks alongside the first instead of displacing it', () => {
    const state = parkTwoQuestions();

    expect(state.pendingQuestions).toEqual([
      { sessionId: 's1', questionId: 'q1', messageId: 'asst-1' },
      { sessionId: 's1', questionId: 'q2', messageId: 'asst-1' },
    ]);
    // Both cards exist in the transcript, both still answerable.
    const blocks = state.messages.s1?.find((item) => item.id === 'asst-1')?.blocks ?? [];
    expect(blocks.map((block) => block.questionId)).toEqual(['q1', 'q2']);
    expect(blocks.every((block) => block.resolved === false)).toBe(true);
    expect(statusOf(state)).toBe('waiting_question');
  });

  it('chat-event-01: answering the SECOND question first retires only that card and leaves the first answerable', () => {
    const parked = parkTwoQuestions();

    const patch = applyRuntimeEvent(
      parked,
      resolvedEvent('q2', 'answered', { answers: { 'Which approach?': 'B' } })
    );
    const afterSecond = { ...parked, ...patch } as ChatSessionsState;

    // The out-of-order answer takes its own entry out of the queue and nothing else.
    expect(afterSecond.pendingQuestions).toEqual([
      { sessionId: 's1', questionId: 'q1', messageId: 'asst-1' },
    ]);
    const blocks = afterSecond.messages.s1?.find((item) => item.id === 'asst-1')?.blocks ?? [];
    expect(blocks.find((block) => block.questionId === 'q1')?.resolved).toBe(false);
    expect(blocks.find((block) => block.questionId === 'q2')?.resolved).toBe(true);
    // Still one question outstanding, so the session stays parked on it.
    expect(statusOf(afterSecond)).toBe('waiting_question');

    const finalPatch = applyRuntimeEvent(
      afterSecond,
      resolvedEvent('q1', 'answered', { answers: { 'Which approach?': 'A' } })
    );
    const final = { ...afterSecond, ...finalPatch } as ChatSessionsState;

    expect(final.pendingQuestions).toEqual([]);
    // chat-event-02: last answer in, the turn is running again.
    expect(statusOf(final)).toBe('running');
  });

  it('chat-event-01: a redelivered question.requested neither duplicates the card nor double-parks the queue entry', () => {
    const parked = parkTwoQuestions();

    const patch = applyRuntimeEvent(parked, requestedEvent('q1'));
    const after = { ...parked, ...patch } as ChatSessionsState;

    expect(after.pendingQuestions).toEqual(parked.pendingQuestions);
    const blocks = after.messages.s1?.find((item) => item.id === 'asst-1')?.blocks ?? [];
    expect(blocks.filter((block) => block.questionId === 'q1')).toHaveLength(1);
  });

  it('chat-event-02: the answer takes the session out of waiting_question and back to running', () => {
    const requested = applyRuntimeEvent(baseState(), requestedEvent('q1'));
    const afterRequested = { ...baseState(), ...requested } as ChatSessionsState;
    expect(statusOf(afterRequested)).toBe('waiting_question');

    const patch = applyRuntimeEvent(afterRequested, resolvedEvent('q1', 'answered'));

    expect(patch.sessions?.find((item) => item.id === 's1')?.status).toBe('running');
  });

  it('chat-event-02: a resolution arriving after the turn ended leaves the session status alone', () => {
    const requested = applyRuntimeEvent(baseState(), requestedEvent('q1'));
    const afterRequested = { ...baseState(), ...requested } as ChatSessionsState;
    // The turn ended first (Stop / completion): `idle` is not a waiting state,
    // so the late `question.resolved` must not push it back to running.
    const ended = {
      ...afterRequested,
      sessions: afterRequested.sessions.map((item) => ({ ...item, status: 'idle' as const })),
    };

    const patch = applyRuntimeEvent(ended, resolvedEvent('q1', 'cancelled'));

    expect(patch.sessions).toBeUndefined();
  });
});
