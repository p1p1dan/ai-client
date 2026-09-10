// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flattenTurnItems, groupMessagesIntoTurns } from '@/components/chat/chatTurn';
import { initialExtensionUi, reduceExtensionUi } from '@/components/chat/extensionUiModel';
import { PermissionActivityDetails } from '@/components/chat/PermissionActivityRows';
import { derivePermissionActivityRow } from '@/components/chat/permissionActivityRow';
import { canRespondToPermission } from '@/components/chat/questionCardModel';
import { applyRuntimeEvents, type ChatSession, type ChatSessionsState } from '../chatSessions';
import { usePendingUserMessagesStore } from '../pendingUserMessages';
import {
  applyRuntimeEventToGates,
  isTierControlDegraded,
  resetPermissionGateWatchForTests,
  usePermissionGateStore,
} from '../permissionGate';

vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

/**
 * P4-5, renderer half — what the user sees when the native backend drives.
 *
 * The stream below is not written by hand: it is the recording
 * `src/runtime/__tests__/guiEventContract.test.ts` takes from a real session on
 * the self-owned runtime (real RPC server, real Cordis graph, real tools and
 * permission gate; only the provider is faux). That test fails if the backend
 * stops producing it, this one fails if the GUI stops reducing it correctly, and
 * between them "no GUI regression" is a claim with something behind it.
 *
 * The four surfaces P4-5 signs off are one describe block each. What makes them
 * worth asserting is that every defect they cover was SILENT: `applyRuntimeEvent`
 * returns `{}` for a tool row addressed to a message it cannot find, an
 * unrecognised dialog shape simply never opens a modal, and an unpaired
 * optimistic bubble just sits there. None of them throws.
 */

const SESSION_ID = 'logical-gui';
const FIXTURE = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'shared',
  '__tests__',
  'fixtures',
  'nativeGuiEventStream.json'
);

/**
 * `seq` and `timestamp` are stamped by the worker RPC server on the way out and
 * are dropped from the recording; the renderer needs them present and ordered,
 * so they are re-applied here from the array's own order.
 */
const STREAM: RuntimeEvent[] = (
  JSON.parse(readFileSync(FIXTURE, 'utf8')) as Array<Record<string, unknown>>
).map((event, index) => ({ ...event, seq: index + 1, timestamp: 1_000 + index })) as RuntimeEvent[];

const session: ChatSession = {
  id: SESSION_ID,
  projectId: 'project-demo',
  workspaceId: 'ws-main',
  title: 'native session',
  status: 'idle',
  updatedAt: 0,
};

function baseState(overrides: Partial<ChatSessionsState> = {}): ChatSessionsState {
  return {
    projects: [],
    workspaces: [],
    sessions: [session],
    messages: {},
    activeSessionId: SESSION_ID,
    recentSessionIds: [],
    pendingPermissions: [],
    pendingQuestion: null,
    hostBoundSessionIds: [SESSION_ID],
    runtimeReady: true,
    lastError: null,
    historyErrors: {},
    selectSession: () => {},
    sendMessage: async () => {},
    stopActiveSession: async () => {},
    initRuntime: () => () => {},
    ...overrides,
  };
}

/** Fold the whole recording, the way the store's batched flush does. */
function replay(events: readonly RuntimeEvent[] = STREAM): ChatSessionsState {
  return { ...baseState(), ...applyRuntimeEvents(baseState(), [...events]) };
}

describe('timeline', () => {
  it('renders one turn: the prompt, the two tool calls, and the answer', () => {
    const turns = groupMessagesIntoTurns(replay().messages[SESSION_ID] ?? []);
    expect(turns).toHaveLength(1);
    // A second turn here would mean something opened one — which is what a
    // leaked `aiclient.permissions` bookkeeping entry used to do, splitting one
    // exchange into two and heading the transcript with a row of raw JSON.
    expect(flattenTurnItems(turns[0]).map((item) => item.kind)).toEqual([
      'toolGroup',
      'toolGroup',
      'text',
    ]);
  });

  it('keeps every tool row, which means every tool row found its message', () => {
    const blocks = (replay().messages[SESSION_ID] ?? []).flatMap((message) => message.blocks);
    expect(
      blocks.filter((block) => block.type === 'tool_call').map((block) => block.toolName)
    ).toEqual(['read', 'write']);
    expect(blocks.filter((block) => block.type === 'tool_result').map((block) => block.toolOk)) //
      .toEqual([true, true]);
  });

  it('shows no system rows the runtime meant for itself', () => {
    expect((replay().messages[SESSION_ID] ?? []).filter((m) => m.role === 'system')).toEqual([]);
  });

  it('closes with the answer the model actually gave', () => {
    const text = (replay().messages[SESSION_ID] ?? [])
      .flatMap((message) => message.blocks)
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');
    expect(text).toContain('the answer is 42');
  });
});

describe('permission trail', () => {
  it('keeps the recorded allowed gates accessible in the collapsed approval details', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const blocks = (replay().messages[SESSION_ID] ?? []).flatMap((message) => message.blocks);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(createElement(PermissionActivityDetails, { blocks })));
      const details = container.querySelector('details')!;
      expect(details.open).toBe(false);
      await act(async () => details.querySelector('summary')!.click());
      expect(details.open).toBe(true);
      expect(details.querySelectorAll('li')).toHaveLength(2);
      expect(details.textContent).toContain('Allowed read');
      expect(details.textContent).toContain('Allowed write');
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  });

  it('records both gates — including the one that never raised a dialog', () => {
    const rows = (replay().messages[SESSION_ID] ?? [])
      .flatMap((message) => message.blocks)
      .filter((block) => block.type === 'permission_activity')
      .map((block) => derivePermissionActivityRow(block.permissionActivity!));

    expect(rows.map((row) => [row.label, row.tone])).toEqual([
      // `policy_allow` raises no modal at all, so this row is the ONLY evidence
      // the read was gated rather than simply unchecked. Drawn quietly (`auto`)
      // because nobody decided it.
      ['Allowed read', 'auto'],
      // The write was approved by the user, and says so.
      ['Allowed write', 'allowed'],
    ]);
  });

  it('merges the prompt and the decision into one row per gate', () => {
    const blocks = (replay().messages[SESSION_ID] ?? [])
      .flatMap((message) => message.blocks)
      .filter((block) => block.type === 'permission_activity');
    // Three `permission.activity` events (one decision, one prompt+decision
    // pair) must not become three rows: the transcript would show the same
    // approval twice.
    expect(blocks.map((block) => block.permissionActivity?.requestId)).toEqual([
      'call-1',
      'call-2',
    ]);
  });

  it('attaches each row to the message holding its tool call', () => {
    const owners = (replay().messages[SESSION_ID] ?? [])
      .filter((message) => message.blocks.some((block) => block.type === 'permission_activity'))
      .map((message) => message.blocks.map((block) => block.type));
    expect(owners).toEqual([
      ['tool_call', 'permission_activity', 'tool_result'],
      // The gated write also carries the card the user answered, on the same
      // message as the call it gates — the trail and the question are one row.
      ['tool_call', 'permission_activity', 'permission_request', 'tool_result'],
    ]);
  });
});

describe('permission card', () => {
  /**
   * The gate used to arrive as a `ui.select` blob, which is why this suite once
   * asserted a dialog with three option strings. The native backend now asks
   * with `permission.requested`, so what has to survive the replay is the CARD's
   * inputs — without them the card is back to printing a serialized argument
   * object.
   */
  it('opens exactly one answerable card for the gated write', () => {
    const state = replay();
    const blocks = (state.messages[SESSION_ID] ?? []).flatMap((message) =>
      message.blocks.filter((block) => block.type === 'permission_request')
    );
    expect(blocks).toHaveLength(1);
    const block = blocks[0]!;
    expect(block.toolName).toBe('write');
    expect(block.permissionKind).toBe('file_change');
    expect(block.permissionDecisions).toEqual(['allow', 'allow_session', 'deny']);
    // What the user is actually deciding about.
    expect(block.toolInput).toMatchObject({ content: 'hi\n' });
    expect(block.permissionDetail).toMatchObject({ kind: 'file_change' });
    // By the end of the recording the gate has been answered, so the queue is
    // empty again and the card is frozen — the pending state is asserted below
    // at the only moment it exists.
    expect(state.pendingPermissions).toHaveLength(0);
    expect(block.resolved).toBe(true);
  });

  it('queues the gate as answerable until the answer lands', () => {
    let state = baseState();
    for (const event of STREAM) {
      if (event.type === 'permission.resolved') break;
      state = { ...state, ...applyRuntimeEvents(state, [event]) };
    }
    expect(state.pendingPermissions).toHaveLength(1);
    const queued = state.pendingPermissions[0]!;
    expect(queued.sessionId).toBe(SESSION_ID);
    // The head of the queue is the one the card unlocks; a block whose id is
    // not the head renders as waiting.
    expect(canRespondToPermission(state.pendingPermissions, SESSION_ID, queued.permissionId)).toBe(
      true
    );
    expect(canRespondToPermission(state.pendingPermissions, SESSION_ID, 'another-id')).toBe(false);
  });

  it('no longer opens an extension UI dialog for a permission', () => {
    // Both channels exist; a gate must travel on exactly one of them, or the
    // user is asked the same question twice in two different shapes.
    let state = initialExtensionUi;
    for (const event of STREAM) state = reduceExtensionUi(state, event);
    expect(state.pending).toHaveLength(0);
  });
});

describe('composer', () => {
  it('runs and then goes idle, so the send control comes back', () => {
    const seen: string[] = [];
    let state = baseState();
    for (const event of STREAM) {
      state = { ...state, ...applyRuntimeEvents(state, [event]) };
      const status = state.sessions.find((item) => item.id === SESSION_ID)?.status;
      if (status && seen.at(-1) !== status) seen.push(status);
    }
    // `waiting_permission` between the two: the composer has to show that the
    // turn is parked on a question rather than still working.
    expect(seen).toEqual(['running', 'waiting_permission', 'idle']);
  });

  it('retires the optimistic bubble once the authoritative echo arrives', () => {
    usePendingUserMessagesStore.setState({ bySession: {} });
    const store = usePendingUserMessagesStore.getState();
    store.publish({
      attemptId: 'attempt-1',
      sessionId: SESSION_ID,
      text: 'read then write',
      attachments: [],
      startedAt: 0,
    });

    // The pairing the store's subscription performs on every event.
    for (const event of STREAM) {
      if (
        event.type === 'message.started' &&
        event.sessionId &&
        event.payload.role === 'user' &&
        event.payload.attemptId
      ) {
        usePendingUserMessagesStore
          .getState()
          .acknowledgeAttempt(event.sessionId, event.payload.attemptId, event.payload.messageId);
      }
    }

    const pending = usePendingUserMessagesStore.getState().bySession[SESSION_ID]?.[0];
    // Without an `attemptId` on the wire this stays undefined and the flush's
    // clear condition never holds — the user's prompt sits on screen twice for
    // the life of the session.
    expect(pending?.authoritativeMessageId).toBe('user-turn-1-1');
    expect(
      (replay().messages[SESSION_ID] ?? []).some(
        (message) => message.id === pending?.authoritativeMessageId
      )
    ).toBe(true);
  });

  it('shows the attachment back on the user message it was sent with', () => {
    const user = (replay().messages[SESSION_ID] ?? []).find((message) => message.role === 'user');
    expect(user?.blocks.map((block) => block.text).join('')).toContain('read then write');
    const echo = STREAM.find(
      (event) => event.type === 'message.started' && event.payload.role === 'user'
    );
    expect(echo?.type === 'message.started' && echo.payload.attachments).toEqual([
      { kind: 'text', mediaType: 'text/plain', name: 'spec.md' },
    ]);
  });
});

describe('settings', () => {
  beforeEach(() => resetPermissionGateWatchForTests());

  it('leaves the permission control fully enabled on the self-owned gate', () => {
    // Main mints this one from the worker's bootstrap answer; the native
    // runtime enforces the two D14 axes itself and has no user-supplied pi
    // permission plugin to be displaced by, so it reports `bundled`.
    applyRuntimeEventToGates({
      type: 'session.created',
      sessionId: SESSION_ID,
      seq: 1,
      timestamp: 1,
      payload: { agent: 'pi', permissionGate: 'bundled' },
    } as RuntimeEvent);
    expect(isTierControlDegraded(usePermissionGateStore.getState().gates, SESSION_ID)).toBe(false);
  });
});
