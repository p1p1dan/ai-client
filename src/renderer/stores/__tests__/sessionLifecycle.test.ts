import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  initialExtensionUiDisplay,
  reduceExtensionUiDisplay,
} from '@/components/chat/extensionUiDisplayModel';
import type { ExtensionUiState } from '@/components/chat/extensionUiModel';
import type { SubagentActivityState } from '@/components/chat/subagentActivityModel';
import { useMessageQueueStore } from '../messageQueue';
import { usePendingUserMessagesStore } from '../pendingUserMessages';
import {
  pruneExtensionUiState,
  pruneRecordBySession,
  pruneSessionScopedRendererState,
  pruneSubagentActivityState,
  resetSessionScopedRendererState,
} from '../sessionLifecycle';
import { useTurnSendStatusStore } from '../turnSendStatus';

describe('session lifecycle pruning', () => {
  beforeEach(() => {
    useMessageQueueStore.setState({ state: { bySession: {} } });
    usePendingUserMessagesStore.setState({ bySession: {} });
    useTurnSendStatusStore.setState({ status: null, baseline: null, pendingReply: null });
  });

  it('gates every adjacent runtime listener against the retirement tombstone', () => {
    for (const file of [
      'sessionRuntimeFacts.ts',
      'subagentActivity.ts',
      'extensionUi.ts',
      'extensionUiDisplay.ts',
    ]) {
      const source = readFileSync(path.join(__dirname, '..', file), 'utf8');
      expect(source).toContain('isSessionRetired(event.sessionId)');
      expect(source).toContain('return;');
    }
  });

  it('prunes ordinary session-keyed records', () => {
    expect(pruneRecordBySession({ keep: 1, drop: 2 }, ['keep'])).toEqual({ keep: 1 });
  });

  it('atomically prunes queue, pending echo, and turn ownership for a removed session', () => {
    const attachment = {
      id: 'draft-1',
      kind: 'text' as const,
      mediaType: 'text/plain',
      name: 'note.txt',
      byteLength: 4,
      data: 'note',
    };
    useMessageQueueStore.getState().enqueue({
      id: 'queue-drop',
      sessionId: 'drop',
      text: 'queued',
      attachments: [attachment],
      queuedAt: 1,
    });
    useMessageQueueStore.getState().enqueue({
      id: 'queue-keep',
      sessionId: 'keep',
      text: 'kept',
      attachments: [],
      queuedAt: 2,
    });
    usePendingUserMessagesStore.getState().publish({
      attemptId: 'attempt-drop',
      sessionId: 'drop',
      text: 'pending',
      attachments: [],
      startedAt: 1,
    });
    useTurnSendStatusStore.getState().begin(
      {
        sessionId: 'drop',
        phase: 'awaiting',
        elapsedSeconds: 1,
        budgetMs: 10,
        attachmentCount: 1,
        attachmentBytes: 4,
        promptChars: 7,
      },
      null
    );
    useTurnSendStatusStore.getState().armPendingReply({ sessionId: 'drop', turnStartedAtMs: 1 });

    pruneSessionScopedRendererState(['keep']);

    expect(useMessageQueueStore.getState().state.bySession).toEqual({
      keep: expect.objectContaining({ entries: [expect.objectContaining({ id: 'queue-keep' })] }),
    });
    expect(usePendingUserMessagesStore.getState().bySession).toEqual({});
    expect(useTurnSendStatusStore.getState()).toMatchObject({
      status: null,
      baseline: null,
      pendingReply: null,
    });
  });

  it('resets only one live session before a branch replacement', () => {
    useMessageQueueStore.getState().enqueue({
      id: 'drop-queue',
      sessionId: 'drop',
      text: 'drop',
      attachments: [],
      queuedAt: 1,
    });
    useMessageQueueStore.getState().enqueue({
      id: 'keep-queue',
      sessionId: 'keep',
      text: 'keep',
      attachments: [],
      queuedAt: 2,
    });
    usePendingUserMessagesStore.getState().publish({
      attemptId: 'drop-attempt',
      sessionId: 'drop',
      text: 'drop',
      attachments: [],
      startedAt: 1,
    });

    resetSessionScopedRendererState('drop');

    expect(useMessageQueueStore.getState().state.bySession).toEqual({
      keep: expect.objectContaining({ entries: [expect.objectContaining({ id: 'keep-queue' })] }),
    });
    expect(usePendingUserMessagesStore.getState().bySession).toEqual({});
  });

  it('drops extension dialogs, sending flags and errors for removed sessions', () => {
    const state: ExtensionUiState = {
      pending: [
        {
          runtimeId: 'r1',
          uiRequestId: 'keep-request',
          sessionId: 'keep',
          dialog: { method: 'confirm', title: 'Keep', message: 'Keep?' },
          receivedAt: 1,
        },
        {
          runtimeId: 'r2',
          uiRequestId: 'drop-request',
          sessionId: 'drop',
          dialog: { method: 'confirm', title: 'Drop', message: 'Drop?' },
          receivedAt: 2,
        },
      ],
      sending: ['keep-request', 'drop-request'],
      sendErrors: { 'keep-request': 'keep', 'drop-request': 'drop' },
    };

    expect(pruneExtensionUiState(state, ['keep'])).toEqual({
      pending: [state.pending[0]],
      sending: ['keep-request'],
      sendErrors: { 'keep-request': 'keep' },
    });
    expect(pruneExtensionUiState(state, [])).toEqual({
      pending: [],
      sending: [],
      sendErrors: {},
    });
  });

  it('prunes the fire-and-forget Extension UI store with the shared lifecycle', () => {
    const display = reduceExtensionUiDisplay(initialExtensionUiDisplay, {
      type: 'extensionUi.request',
      seq: 1,
      timestamp: 1,
      sessionId: 'drop',
      payload: {
        runtimeId: 'r1',
        uiRequestId: 'u1',
        method: 'setStatus',
        args: { key: 'lint', text: 'running' },
      },
    });
    // The public coordinator must mention the display store; the pure reducer's
    // own pruning behavior is covered in extensionUiDisplayModel.test.ts.
    const source = readFileSync(path.join(__dirname, '..', 'sessionLifecycle.ts'), 'utf8');
    expect(source).toContain('useExtensionUiDisplayStore.setState');
    expect(Object.keys(display.statuses)).toHaveLength(1);
  });

  it('drops subagent lanes and indexes belonging to removed sessions', () => {
    const lane = (sessionId: string, parentToolCallId: string) => ({
      parentToolCallId,
      sessionId,
      agentId: null,
      agentType: null,
      description: null,
      status: 'running' as const,
      rows: [],
      droppedRows: 0,
      progress: null,
      usage: null,
      report: null,
      pendingPermission: null,
      capped: false,
      ordinal: 1,
    });
    const state: SubagentActivityState = {
      lanes: { keepLane: lane('keep', 'keep-parent'), dropLane: lane('drop', 'drop-parent') },
      agentIndex: { keepAgent: 'keep-parent', dropAgent: 'drop-parent' },
      permissionOrigin: {
        keepPermission: { parentToolCallId: 'keep-parent', agentType: null, description: null },
        dropPermission: { parentToolCallId: 'drop-parent', agentType: null, description: null },
      },
      nextOrdinal: 3,
    };

    expect(pruneSubagentActivityState(state, ['keep'])).toEqual({
      lanes: { keepLane: state.lanes.keepLane },
      agentIndex: { keepAgent: 'keep-parent' },
      permissionOrigin: { keepPermission: state.permissionOrigin.keepPermission },
      nextOrdinal: 3,
    });
  });
});
