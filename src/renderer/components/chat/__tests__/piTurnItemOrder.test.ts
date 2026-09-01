import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { describe, expect, it } from 'vitest';
import {
  applyRuntimeEvents,
  type ChatSession,
  type ChatSessionsState,
} from '@/stores/chatSessions';
import { flattenTurnItems, groupMessagesIntoTurns } from '../chatTurn';

/**
 * T12-a — the renderer half of the interleaving contract.
 *
 * A tool-using pi answer is `prose -> tool -> prose`, and the second paragraph
 * routinely reads the tool's output ("The file says X"). If it renders ahead of
 * the tool row, the answer stops making sense.
 *
 * The layers below were never the problem: `groupTimeline` walks blocks in
 * order and `flattenTurnItems` concatenates body messages in order. What broke
 * was upstream — `piRuntime` reused one message id and one text block id for a
 * whole run, so both paragraphs landed in the same block and that block sat
 * before the tool. `piRuntimeMessageBoundaries.test.ts` locks the Host half;
 * this file locks the outcome the user actually sees, replaying the wire shape
 * the Host now emits.
 */

const SESSION_ID = 'session-1';

function baseState(overrides: Partial<ChatSessionsState> = {}): ChatSessionsState {
  return {
    projects: [],
    workspaces: [],
    sessions: [],
    messages: {},
    activeSessionId: null,
    recentSessionIds: [],
    pendingPermissions: [],
    pendingQuestion: null,
    hostBoundSessionIds: [],
    runtimeReady: false,
    lastError: null,
    historyErrors: {},
    selectSession: () => {},
    sendMessage: async () => {},
    stopActiveSession: async () => {},
    initRuntime: () => () => {},
    ...overrides,
  };
}

const session: ChatSession = {
  id: SESSION_ID,
  projectId: 'project-demo',
  workspaceId: 'ws-main',
  title: 'pi turn',
  status: 'idle',
  updatedAt: 0,
};

/**
 * The wire shape `piRuntime` emits for `prose -> tool -> prose`: the tool stays
 * in the container the first paragraph opened, and the follow-up paragraph
 * opens a second one. Keeping tools on the open container is deliberate — it is
 * what stops a sequential tool run from fragmenting into one group per tool
 * (`piRuntimeMessageBoundaries.test.ts` holds that half).
 */
const WIRE: RuntimeEvent[] = [
  { type: 'message.started', sessionId: SESSION_ID, payload: { messageId: 'u1', role: 'user' } },
  {
    type: 'message.delta',
    sessionId: SESSION_ID,
    payload: { messageId: 'u1', blockId: 'u1-text', text: 'read a.ts' },
  },
  { type: 'message.completed', sessionId: SESSION_ID, payload: { messageId: 'u1' } },

  {
    type: 'message.started',
    sessionId: SESSION_ID,
    payload: { messageId: 'asst-1', role: 'assistant' },
  },
  {
    type: 'message.delta',
    sessionId: SESSION_ID,
    payload: { messageId: 'asst-1', blockId: 'asst-1-text', text: 'Let me read the file.' },
  },
  { type: 'message.completed', sessionId: SESSION_ID, payload: { messageId: 'asst-1' } },

  {
    type: 'tool.started',
    sessionId: SESSION_ID,
    payload: { messageId: 'asst-1', toolCallId: 't1', name: 'Read', input: { path: 'a.ts' } },
  },
  {
    type: 'tool.completed',
    sessionId: SESSION_ID,
    payload: { messageId: 'asst-1', toolCallId: 't1', ok: true, output: 'contents' },
  },

  {
    type: 'message.started',
    sessionId: SESSION_ID,
    payload: { messageId: 'asst-2', role: 'assistant' },
  },
  {
    type: 'message.delta',
    sessionId: SESSION_ID,
    payload: { messageId: 'asst-2', blockId: 'asst-2-text', text: 'The file says X.' },
  },
  { type: 'message.completed', sessionId: SESSION_ID, payload: { messageId: 'asst-2' } },
] as RuntimeEvent[];

function turnItems() {
  const next = applyRuntimeEvents(baseState({ sessions: [session] }), WIRE);
  const turns = groupMessagesIntoTurns(next.messages?.[SESSION_ID] ?? []);
  expect(turns).toHaveLength(1);
  return flattenTurnItems(turns[0]);
}

describe('pi two-step turn renders in the order the model spoke', () => {
  it('puts the follow-up prose after the tool, not before it', () => {
    expect(turnItems().map((item) => item.kind)).toEqual(['text', 'toolGroup', 'text']);
  });

  it('keeps the two paragraphs separate', () => {
    const texts = turnItems()
      .filter((item): item is Extract<typeof item, { kind: 'text' }> => item.kind === 'text')
      .map((item) => item.block.text);

    // The defect's signature was a single glued block:
    // "Let me read the file.The file says X."
    expect(texts).toEqual(['Let me read the file.', 'The file says X.']);
  });

  it('carries the source message id on every item', () => {
    // `flattenTurnItems` stamps this so the .tsx layer can key per message —
    // two assistant messages in one turn is now the normal case, not an edge.
    expect(turnItems().map((item) => item.messageId)).toEqual(['asst-1', 'asst-1', 'asst-2']);
  });
});
