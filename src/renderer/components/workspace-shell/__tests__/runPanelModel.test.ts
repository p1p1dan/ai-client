import type { PiUsagePayload } from '@shared/piUsage';
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
    usage: null,
    configuredContextWindow: null,
    toolStatus: null,
    ...overrides,
  };
}

/** A settled `usage.updated` payload as `buildPiUsagePayload` produces one. */
function usagePayload(overrides: Partial<PiUsagePayload> = {}): PiUsagePayload {
  return {
    input: 12_000,
    output: 480,
    cacheRead: 9_000,
    cacheWrite: 1_200,
    totalTokens: 22_680,
    costUsd: 0.0504,
    context: { tokens: 21_400, contextWindow: 200_000, percent: 10.7 },
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
    expect(deriveRunTools(messages)).toEqual({
      activeTool: 'Bash',
      activeToolStatus: null,
      calls: 3,
      failed: 1,
    });
  });

  it('reports nothing for a session that has never had an assistant turn', () => {
    expect(deriveRunTools([message('user', [{ id: 'u1', type: 'text', text: 'hi' }])])).toEqual({
      activeTool: null,
      activeToolStatus: null,
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
  // U06-a's rule survives T38 unchanged: the panel must not grow a shell for
  // numbers it does not have. What changed is only WHEN it has them.
  it('reports no occupancy, no window and no usage until the runtime says something', () => {
    const view = deriveRunPanelView(input({ status: 'running' }));
    expect(view.occupancy).toBeNull();
    expect(view.contextWindowOnly).toBeNull();
    expect(view.usage).toBeNull();
  });

  it('an idle session that has already run is not "empty" — it still has facts', () => {
    expect(deriveRunPanelView(input({ lastTurnMs: 1200 })).empty).toBe(false);
    expect(deriveRunPanelView(input({ configuredModel: 'pi/a' })).empty).toBe(false);
    expect(deriveRunPanelView(input({ usage: usagePayload() })).empty).toBe(false);
    expect(deriveRunPanelView(input()).empty).toBe(true);
  });
});

describe('deriveRunPanelView — occupancy and usage (U06-b)', () => {
  it('splits the runtime-reported context into used and free', () => {
    const view = deriveRunPanelView(input({ usage: usagePayload() }));
    expect(view.occupancy).toEqual({
      usedTokens: 21_400,
      contextWindow: 200_000,
      percent: 10.7,
      freeTokens: 178_600,
    });
    // The window is already printed beside the ring; no second copy.
    expect(view.contextWindowOnly).toBeNull();
  });

  it('shows no ring when Pi reports tokens as unknown, but still names the window', () => {
    const view = deriveRunPanelView(
      input({
        usage: usagePayload({ context: { tokens: null, contextWindow: 200_000, percent: null } }),
      })
    );
    // Post-compaction: `tokens: null` is Pi's real answer, not a missing one.
    expect(view.occupancy).toBeNull();
    expect(view.contextWindowOnly).toBe(200_000);
  });

  it('falls back to the configured model window only while nothing has run', () => {
    expect(deriveRunPanelView(input({ configuredContextWindow: 128_000 })).contextWindowOnly).toBe(
      128_000
    );
    // Once the runtime has answered, its own window wins — the configured model
    // and the model that actually replied are allowed to differ.
    const answered = deriveRunPanelView(
      input({ usage: usagePayload(), configuredContextWindow: 128_000 })
    );
    expect(answered.occupancy?.contextWindow).toBe(200_000);
    expect(answered.contextWindowOnly).toBeNull();
  });

  it('clamps an over-100% report instead of sweeping the arc past a full circle', () => {
    const view = deriveRunPanelView(
      input({
        usage: usagePayload({
          context: { tokens: 260_000, contextWindow: 200_000, percent: 130 },
        }),
      })
    );
    expect(view.occupancy).toEqual({
      usedTokens: 260_000,
      contextWindow: 200_000,
      percent: 100,
      freeTokens: 0,
    });
  });

  it('carries the last turn totals without summing turns together', () => {
    const view = deriveRunPanelView(input({ usage: usagePayload({ output: 900 }) }));
    expect(view.usage).toEqual({
      input: 12_000,
      output: 900,
      cacheRead: 9_000,
      cacheWrite: 1_200,
      totalTokens: 22_680,
      costUsd: 0.0504,
    });
    // The occupancy fields do not leak into the usage row's own shape.
    expect(view.usage).not.toHaveProperty('context');
  });

  it('drops another session’s usage the same way it drops its clock', () => {
    expect(deriveRunPanelView(input({ sessionId: null, usage: usagePayload() })).usage).toBeNull();
  });
});

describe('deriveRunTools — live tool status (T38-c)', () => {
  const messages = [message('assistant', [toolCall('t1', 'read')])];

  it('shows the status only against the call that published it', () => {
    expect(deriveRunTools(messages, { toolCallId: 't1', status: 'Downloaded 3/12' })).toMatchObject(
      {
        activeTool: 'read',
        activeToolStatus: 'Downloaded 3/12',
      }
    );
    // A line left over from a previous call must not appear under this one.
    expect(deriveRunTools(messages, { toolCallId: 't0', status: 'stale' })).toMatchObject({
      activeTool: 'read',
      activeToolStatus: null,
    });
  });

  it('reports no status when none was published or nothing is running', () => {
    expect(deriveRunTools(messages).activeToolStatus).toBeNull();
    expect(
      deriveRunTools([message('assistant', [toolCall('t1', 'read'), toolResult('t1', true)])], {
        toolCallId: 't1',
        status: 'done',
      }).activeToolStatus
    ).toBeNull();
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
