import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { describe, expect, it } from 'vitest';
import { applyRuntimeEvent, type ChatMessage, type ChatSessionsState } from '@/stores/chatSessions';
import { groupMessagesIntoTurns } from '../chatTurn';
import { autoTurnHeadView, dshNoticeRowView } from '../dshTimelineRowModel';

/**
 * dsh-rebase P1-7a (decisions 072 rules 3-4, 099 rules 7-8, 106 rule 36, 118):
 * the two light rows a DSH timeline adds. A notice arrives live as a
 * `custom.message` of kind `dsh:<source>` and replays as a history row named
 * after its live copy; a turn head is a user message with an `origin`, which
 * still opens its turn.
 */

const SESSION = 's1';

function state(messages: ChatMessage[] = []): ChatSessionsState {
  return { sessions: [], messages: { [SESSION]: messages } } as unknown as ChatSessionsState;
}

function customMessage(customType: string, content: string, messageId = 'dsh-notice-12') {
  return {
    type: 'custom.message',
    sessionId: SESSION,
    seq: 1,
    timestamp: 1,
    payload: { messageId, customType, content },
  } as RuntimeEvent;
}

function reduced(event: RuntimeEvent): ChatMessage {
  const patch = applyRuntimeEvent(state(), event);
  const message = patch.messages?.[SESSION]?.[0];
  if (!message) throw new Error('no message');
  return message;
}

describe('DSH notices (P1-7a)', () => {
  it('[P7A-NOTICE-LIVE] a dsh:<kind> custom message keeps its text alone and names its kind', () => {
    const message = reduced(customMessage('dsh:tool-jobs', 'background job bash-3 finished'));
    expect(message).toMatchObject({ role: 'system', noticeKind: 'tool-jobs' });
    expect(message.blocks[0]?.text).toBe('background job bash-3 finished');
    expect(dshNoticeRowView(message)).toEqual({
      kind: 'notice',
      text: 'background job bash-3 finished',
      expandable: false,
    });
  });

  it('[P7A-NOTICE-OTHER] any other custom message keeps the customType line and its Alert', () => {
    const message = reduced(customMessage('extension.note', 'visible', 'custom-b'));
    expect(message.noticeKind).toBeUndefined();
    expect(message.blocks[0]?.text).toBe('extension.note\nvisible');
    expect(dshNoticeRowView(message)).toBeNull();
  });

  it('[P7A-NOTICE-COMMAND] a command send’s answer is drawn whole; its error as a failure', () => {
    const answer = reduced(customMessage('dsh:command', 'Goal\nStatus: active', 'dsh-command-7'));
    expect(dshNoticeRowView(answer)).toEqual({
      kind: 'command',
      text: 'Goal\nStatus: active',
      expandable: false,
    });
    const failed = reduced(customMessage('dsh:command-error', 'No goal', 'dsh-command-8'));
    expect(dshNoticeRowView(failed)?.kind).toBe('command-error');
  });

  it('[P7A-NOTICE-HISTORY] a replayed notice is known by its live id; a long one opens in place', () => {
    const replayed: ChatMessage = {
      id: 'h:e12',
      sessionId: SESSION,
      role: 'system',
      liveMessageId: 'dsh-notice-12',
      blocks: [{ id: 'h:e12:notice:0', type: 'text', text: `line one\n${'x'.repeat(40)}` }],
    };
    expect(dshNoticeRowView(replayed)).toEqual({
      kind: 'notice',
      text: `line one\n${'x'.repeat(40)}`,
      expandable: true,
    });
    // A context summary or an imported-history banner is not a DSH notice.
    expect(dshNoticeRowView({ ...replayed, liveMessageId: undefined, id: 'h:summary' })).toBeNull();
  });
});

describe('Turn heads (P1-7a, replacing decision 106 rule 36’s empty bubble)', () => {
  const head = (origin: ChatMessage['origin'], text = ''): ChatMessage => ({
    id: 'dsh-user-15',
    sessionId: SESSION,
    role: 'user',
    blocks: text ? [{ id: 'dsh-user-15-text', type: 'text', text }] : [],
    origin,
  });

  it('[P7A-HEAD-VIEW] a goal round has no words of its own; a wake-up carries DSH’s account', () => {
    expect(autoTurnHeadView(head({ kind: 'goal', round: 3, maxRounds: 256 }))).toEqual({
      origin: { kind: 'goal', round: 3, maxRounds: 256 },
      detail: '',
      expandable: false,
    });
    expect(autoTurnHeadView(head({ kind: 'job' }, 'background job bash-3 finished'))).toMatchObject(
      { detail: 'background job bash-3 finished', expandable: false }
    );
    expect(
      autoTurnHeadView(head({ kind: 'agent-message' }, `hello\n${'y'.repeat(200)}`))?.expandable
    ).toBe(true);
    expect(autoTurnHeadView({ id: 'u', sessionId: SESSION, role: 'user', blocks: [] })).toBeNull();
  });

  it('[P7A-HEAD-TURN] a head still opens its own turn, so the clock and work group count per round', () => {
    const messages: ChatMessage[] = [
      {
        id: 'dsh-user-1',
        sessionId: SESSION,
        role: 'user',
        blocks: [{ id: 't', type: 'text', text: 'set a goal' }],
      },
      { id: 'a1', sessionId: SESSION, role: 'assistant', blocks: [] },
      head({ kind: 'goal', round: 1, maxRounds: 4 }),
      { id: 'a2', sessionId: SESSION, role: 'assistant', blocks: [] },
    ];
    const turns = groupMessagesIntoTurns(messages);
    expect(turns.map((turn) => turn.user?.id)).toEqual(['dsh-user-1', 'dsh-user-15']);
    expect(turns[1]?.user?.origin).toEqual({ kind: 'goal', round: 1, maxRounds: 4 });
    expect(turns[1]?.body.map((message) => message.id)).toEqual(['a2']);
  });
});

describe('a plan review’s approval notice (decision 169)', () => {
  it('is the app’s own sentence, a dictionary key the row translates; other notices are not', () => {
    const approval = reduced(
      customMessage(
        'dsh:aiclient-plan-review',
        'Plan approved: set as the goal, running on full auto.'
      )
    );
    expect(dshNoticeRowView(approval)).toMatchObject({
      kind: 'notice',
      text: 'Plan approved: set as the goal, running on full auto.',
      translatable: true,
    });
    const job = reduced(customMessage('dsh:tool-jobs', 'background job bash-3 finished'));
    expect(dshNoticeRowView(job)).not.toHaveProperty('translatable');
  });
});
