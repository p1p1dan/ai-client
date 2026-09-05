import type { SessionRuntimeStatus } from '@shared/types/runtimeEvents';
import { describe, expect, it } from 'vitest';
import type { ChatBlock, ChatMessage } from '@/stores/chatSessions';
import {
  deriveRunPanelView,
  deriveRunTools,
  formatRunDuration,
  type RunPanelInput,
} from '../surfaces/runPanelModel';

const ALL_STATUSES: SessionRuntimeStatus[] = [
  'idle',
  'starting',
  'running',
  'waiting_permission',
  'waiting_question',
  'stopping',
  'completed',
  'failed',
  'disconnected',
];

function message(role: ChatMessage['role'], blocks: ChatBlock[], id = 'm1'): ChatMessage {
  return { id, sessionId: 's1', role, blocks };
}

function toolCall(toolCallId: string, toolName: string): ChatBlock {
  return { id: toolCallId, type: 'tool_call', toolCallId, toolName };
}

function toolResult(toolCallId: string, ok: boolean): ChatBlock {
  return { id: `${toolCallId}-result`, type: 'tool_result', toolCallId, toolOk: ok };
}

function input(overrides: Partial<RunPanelInput> = {}): RunPanelInput {
  return {
    sessionId: 's1',
    status: 'idle',
    messages: [],
    turnSend: null,
    actualModel: null,
    configuredModel: null,
    effortLabel: null,
    lastTurnMs: null,
    ...overrides,
  };
}

describe('deriveRunPanelView — status mapping (U06-a acceptance ①)', () => {
  it('gives every one of the nine runtime statuses a headline and a tone', () => {
    for (const status of ALL_STATUSES) {
      const view = deriveRunPanelView(input({ status }));
      expect(view.status, status).toBe(status);
      expect(view.headline.length, status).toBeGreaterThan(0);
      expect(['idle', 'active', 'attention', 'error']).toContain(view.tone);
    }
  });

  it('never relabels the raw status — the headline is a second, separate field', () => {
    const view = deriveRunPanelView(input({ status: 'waiting_permission' }));
    expect(view.status).toBe('waiting_permission');
    expect(view.headline).toBe('Waiting for approval');
    expect(view.tone).toBe('attention');
  });

  it('marks failure as an error tone and the two waits as attention', () => {
    expect(deriveRunPanelView(input({ status: 'failed' })).tone).toBe('error');
    expect(deriveRunPanelView(input({ status: 'waiting_question' })).tone).toBe('attention');
    expect(deriveRunPanelView(input({ status: 'disconnected' })).tone).toBe('attention');
  });

  it('refines a running turn into tool / thinking, and only while running', () => {
    const withOpenTool = [message('assistant', [toolCall('t1', 'Read')])];
    expect(deriveRunPanelView(input({ status: 'running', messages: withOpenTool })).headline).toBe(
      'Running a tool'
    );
    // A settled tool is not what the agent is doing now.
    expect(
      deriveRunPanelView(input({ status: 'idle', messages: [...withOpenTool] })).activity
    ).toBeNull();

    const thinking = [message('assistant', [{ id: 'b1', type: 'thinking', text: 'hm' }])];
    expect(deriveRunPanelView(input({ status: 'running', messages: thinking })).headline).toBe(
      'Thinking'
    );
  });

  it('reports no session as its own state rather than a fake idle turn', () => {
    const view = deriveRunPanelView(input({ sessionId: null, status: 'running' }));
    expect(view.status).toBeNull();
    expect(view.empty).toBe(true);
  });
});

describe('deriveRunTools', () => {
  it('finds the open tool call, counts calls and failures of the last turn only', () => {
    const messages = [
      message('assistant', [toolCall('old', 'Bash'), toolResult('old', true)], 'm0'),
      message('user', [{ id: 'u1', type: 'text', text: 'again' }], 'm1'),
      message(
        'assistant',
        [
          toolCall('t1', 'Read'),
          toolResult('t1', false),
          toolCall('t2', 'Edit'),
          toolResult('t2', true),
          toolCall('t3', 'Bash'),
        ],
        'm2'
      ),
    ];
    expect(deriveRunTools(messages)).toEqual({ activeTool: 'Bash', calls: 3, failed: 1 });
  });

  it('reports nothing for a session that has never had an assistant turn', () => {
    expect(deriveRunTools([message('user', [{ id: 'u1', type: 'text', text: 'hi' }])])).toEqual({
      activeTool: null,
      calls: 0,
      failed: 0,
    });
  });
});

describe('deriveRunPanelView — the clock (acceptance ③)', () => {
  it('drops a turn snapshot that belongs to another session', () => {
    const view = deriveRunPanelView(
      input({
        sessionId: 's1',
        turnSend: { sessionId: 's2', phase: 'awaiting', elapsedSeconds: 42 },
        lastTurnMs: 3000,
      })
    );
    // Falls back to this session's own last turn instead of showing s2's clock.
    expect(view.elapsedLabel).toBe('3s');
    expect(view.elapsedLive).toBe(false);
    expect(view.phase).toBeNull();
  });

  it('prefers the in-flight turn over the last completed one', () => {
    const view = deriveRunPanelView(
      input({
        turnSend: { sessionId: 's1', phase: 'handshake', elapsedSeconds: 5 },
        lastTurnMs: 90_000,
      })
    );
    expect(view.elapsedLabel).toBe('5s');
    expect(view.elapsedLive).toBe(true);
    expect(view.phase).toBe('handshake');
  });

  it('shows no clock at all when neither exists', () => {
    expect(deriveRunPanelView(input()).elapsedLabel).toBeNull();
  });
});

describe('deriveRunPanelView — model provenance', () => {
  it('prefers the runtime-reported model and says so', () => {
    const view = deriveRunPanelView(input({ actualModel: 'pi/a', configuredModel: 'pi/b' }));
    expect(view.model).toBe('pi/a');
    expect(view.modelReported).toBe(true);
  });

  it('falls back to the configured pick without claiming it was reported', () => {
    const view = deriveRunPanelView(input({ configuredModel: 'pi/b' }));
    expect(view.model).toBe('pi/b');
    expect(view.modelReported).toBe(false);
  });
});

describe('deriveRunPanelView — no usage shell (acceptance ②)', () => {
  it('exposes no usage/context-occupancy fields at all until T38 lands', () => {
    const view = deriveRunPanelView(input({ status: 'running' }));
    for (const key of ['usage', 'contextWindow', 'contextPercent', 'tokensPerSecond']) {
      expect(view).not.toHaveProperty(key);
    }
  });

  it('an idle session that has already run is not "empty" — it still has facts', () => {
    expect(deriveRunPanelView(input({ lastTurnMs: 1200 })).empty).toBe(false);
    expect(deriveRunPanelView(input({ configuredModel: 'pi/a' })).empty).toBe(false);
    expect(deriveRunPanelView(input()).empty).toBe(true);
  });
});

describe('formatRunDuration', () => {
  it('formats seconds under a minute and m/s above it', () => {
    expect(formatRunDuration(0)).toBe('0s');
    expect(formatRunDuration(1400)).toBe('1s');
    expect(formatRunDuration(59_000)).toBe('59s');
    expect(formatRunDuration(60_000)).toBe('1m 0s');
    expect(formatRunDuration(185_000)).toBe('3m 5s');
  });
});
