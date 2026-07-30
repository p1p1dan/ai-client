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
    pendingQuestion: null,
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
  it('question.requested appends a question block to the latest assistant message and sets pendingQuestion + session status', () => {
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

    expect(patch.pendingQuestion).toEqual({
      sessionId: 's1',
      questionId: 'q1',
      messageId: 'asst-1',
    });

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

    expect(patch.pendingQuestion).toEqual({
      sessionId: 's1',
      questionId: 'q2',
      messageId: 'msg-question-q2',
    });
  });

  it('question.requested with a missing questionId returns an empty patch', () => {
    const state = baseState();
    expect(applyRuntimeEvent(state, requestedEvent(undefined))).toEqual({});
  });

  it('question.resolved (answered) freezes the block with outcome + answers, and clears pendingQuestion', () => {
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
    expect(patch.pendingQuestion).toBeNull();
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
    expect(patch.pendingQuestion).toBeNull();
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
    expect(patch.pendingQuestion).toBeNull();
  });

  it('question.resolved tolerates an unknown questionId without crashing and clears pendingQuestion', () => {
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
    expect(patch.pendingQuestion).toBeNull();
  });

  it('question.resolved is idempotent — applying the same event twice yields the same result', () => {
    const requested = applyRuntimeEvent(baseState(), requestedEvent('q1'));
    const afterRequested = { ...baseState(), ...requested } as ChatSessionsState;

    const event = resolvedEvent('q1', 'answered', { answers: { 'Which approach?': 'A' } });

    const firstPatch = applyRuntimeEvent(afterRequested, event);
    const afterFirst = { ...afterRequested, ...firstPatch } as ChatSessionsState;
    const secondPatch = applyRuntimeEvent(afterFirst, event);

    expect(secondPatch.messages).toEqual(firstPatch.messages);
    expect(secondPatch.pendingQuestion).toEqual(firstPatch.pendingQuestion);
  });
});
