import { describe, expect, it } from 'vitest';
import type { ExtensionUiState } from '@/components/chat/extensionUiModel';
import type { SubagentActivityState } from '@/components/chat/subagentActivityModel';
import {
  pruneExtensionUiState,
  pruneRecordBySession,
  pruneSubagentActivityState,
} from '../sessionLifecycle';

describe('session lifecycle pruning', () => {
  it('prunes ordinary session-keyed records', () => {
    expect(pruneRecordBySession({ keep: 1, drop: 2 }, ['keep'])).toEqual({ keep: 1 });
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
