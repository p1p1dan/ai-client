import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyRuntimeEvent,
  applyRuntimeEvents,
  type ChatMessage,
  type ChatSession,
  type ChatSessionsState,
  filterRetiredRuntimeEvents,
  useChatSessionsStore,
} from '../chatSessions';
import { resetRuntimeEventBus } from '../runtimeEventBus';

// Behavior-lock tests for the C-08a batching layer: the pure applyRuntimeEvents
// fold, and the setTimeout-coalesced queue inside initRuntime.

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
    setDraftSessionAgent: () => false,
    sendMessage: async () => {},
    stopActiveSession: async () => {},
    respondPermission: async (_permissionId: string, _allow: boolean) => false,
    respondQuestion: async () => false,
    initRuntime: () => () => {},
    ...overrides,
  };
}

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: SESSION_ID,
    projectId: 'project-demo',
    workspaceId: 'ws-main',
    title: 'Test session',
    status: 'idle',
    updatedAt: 42,
    ...overrides,
  };
}

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'msg-1',
    sessionId: SESSION_ID,
    role: 'assistant',
    blocks: [],
    ...overrides,
  };
}

describe('applyRuntimeEvents — fold semantics', () => {
  it('sees earlier same-batch effects: message.started then two deltas concatenate on the just-created message', () => {
    const state = baseState({ sessions: [makeSession()] });
    const events: RuntimeEvent[] = [
      {
        type: 'message.started',
        seq: 1,
        sessionId: SESSION_ID,
        timestamp: 1,
        payload: { messageId: 'msg-1', role: 'user' },
      },
      {
        type: 'message.delta',
        seq: 2,
        sessionId: SESSION_ID,
        timestamp: 2,
        payload: { messageId: 'msg-1', blockId: 'b1', text: 'Hel' },
      },
      {
        type: 'message.delta',
        seq: 3,
        sessionId: SESSION_ID,
        timestamp: 3,
        payload: { messageId: 'msg-1', blockId: 'b1', text: 'lo' },
      },
    ];

    const patch = applyRuntimeEvents(state, events);

    expect(patch.messages).toEqual({
      [SESSION_ID]: [
        {
          id: 'msg-1',
          sessionId: SESSION_ID,
          role: 'user',
          blocks: [{ id: 'b1', type: 'text', text: 'Hello' }],
        },
      ],
    });
  });

  it('is equivalent to applying each event one at a time and merging every step', () => {
    // session.status / permission.requested stamp updatedAt via Date.now(); pin the
    // clock so the batch path and the manual per-step path observe the same instant.
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    try {
      const base = baseState({ sessions: [makeSession({ status: 'idle' })], messages: {} });
      const events: RuntimeEvent[] = [
        {
          type: 'message.started',
          seq: 1,
          sessionId: SESSION_ID,
          timestamp: 1,
          payload: { messageId: 'msg-1', role: 'assistant' },
        },
        {
          type: 'message.delta',
          seq: 2,
          sessionId: SESSION_ID,
          timestamp: 2,
          payload: { messageId: 'msg-1', blockId: 'b1', text: 'hi' },
        },
        {
          type: 'session.status',
          seq: 3,
          sessionId: SESSION_ID,
          timestamp: 3,
          payload: { status: 'running' },
        },
        {
          type: 'permission.requested',
          seq: 4,
          sessionId: SESSION_ID,
          timestamp: 4,
          payload: { permissionId: 'perm-1', toolName: 'Bash' },
        },
      ];

      const batchPatch = applyRuntimeEvents(base, events);
      const batchState = { ...base, ...batchPatch };

      let manualState: ChatSessionsState = base;
      for (const event of events) {
        const step = applyRuntimeEvent(manualState, event);
        manualState = { ...manualState, ...step };
      }

      expect(batchState).toEqual(manualState);
    } finally {
      vi.useRealTimers();
    }
  });

  it('accumulates changes across independent keys (messages, sessions, pendingPermissions) into one patch', () => {
    const base = baseState({
      sessions: [makeSession({ status: 'idle' })],
      messages: { [SESSION_ID]: [makeMessage({ id: 'msg-1', role: 'assistant', blocks: [] })] },
    });
    const events: RuntimeEvent[] = [
      {
        type: 'message.delta',
        seq: 1,
        sessionId: SESSION_ID,
        timestamp: 1,
        payload: { messageId: 'msg-1', blockId: 'b1', text: 'hi' },
      },
      {
        type: 'session.status',
        seq: 2,
        sessionId: SESSION_ID,
        timestamp: 2,
        payload: { status: 'running' },
      },
      {
        type: 'permission.requested',
        seq: 3,
        sessionId: SESSION_ID,
        timestamp: 3,
        payload: { permissionId: 'perm-1', toolName: 'Bash' },
      },
    ];

    const patch = applyRuntimeEvents(base, events);

    expect(Object.keys(patch)).toEqual(
      expect.arrayContaining(['messages', 'sessions', 'pendingPermissions'])
    );
  });

  it('ignores late events after repository removal deleted the session', () => {
    const removed = baseState({ sessions: [], hostBoundSessionIds: [], messages: {} });
    const events: RuntimeEvent[] = [
      {
        type: 'session.created',
        seq: 1,
        sessionId: SESSION_ID,
        timestamp: 1,
        payload: { runtimeIdentity: 'late-runtime' },
      },
      {
        type: 'message.started',
        seq: 2,
        sessionId: SESSION_ID,
        timestamp: 2,
        payload: { messageId: 'late-message', role: 'user' },
      },
      {
        type: 'permission.requested',
        seq: 3,
        sessionId: SESSION_ID,
        timestamp: 3,
        payload: { permissionId: 'late-permission', toolName: 'read' },
      },
    ];

    const retired = (sessionId: string | null | undefined) => sessionId === SESSION_ID;
    expect(filterRetiredRuntimeEvents(events, retired)).toEqual([]);
    expect(filterRetiredRuntimeEvents(events, () => false)).toEqual(events);
    expect(applyRuntimeEvents(removed, filterRetiredRuntimeEvents(events, retired))).toEqual({});
  });

  it('returns {} for an empty batch', () => {
    const state = baseState();
    expect(applyRuntimeEvents(state, [])).toEqual({});
  });

  it('later session.status wins within one batch; recentSessionIds is not duplicated', () => {
    const base = baseState({
      sessions: [makeSession({ status: 'idle' })],
      recentSessionIds: [],
    });
    const events: RuntimeEvent[] = [
      {
        type: 'session.status',
        seq: 1,
        sessionId: SESSION_ID,
        timestamp: 1,
        payload: { status: 'running' },
      },
      {
        type: 'session.status',
        seq: 2,
        sessionId: SESSION_ID,
        timestamp: 2,
        payload: { status: 'waiting_permission' },
      },
    ];

    const patch = applyRuntimeEvents(base, events);

    expect(patch.sessions?.find((session) => session.id === SESSION_ID)?.status).toBe(
      'waiting_permission'
    );
    expect(patch.recentSessionIds).toEqual([SESSION_ID]);
  });
});

describe('initRuntime — batching (RUNTIME_EVENT_FLUSH_MS / RUNTIME_EVENT_MAX_QUEUE)', () => {
  let captured: ((event: RuntimeEvent) => void) | null = null;
  let unsubSpy: ReturnType<typeof vi.fn>;
  let activeCleanup: (() => void) | null = null;

  function statusEvent(seq: number, status: ChatSession['status']): RuntimeEvent {
    return {
      type: 'session.status',
      seq,
      sessionId: SESSION_ID,
      timestamp: seq,
      payload: { status },
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    captured = null;
    unsubSpy = vi.fn();
    activeCleanup = null;
    // `initRuntime` now subscribes through the shared runtime-event bus, whose
    // singleton outlives a test file — drop it so this test's `onRuntimeEvent`
    // mock is the one the bus attaches to.
    resetRuntimeEventBus();

    (globalThis as { window?: unknown }).window = {
      electronAPI: {
        chat: {
          onRuntimeEvent: (callback: (event: RuntimeEvent) => void) => {
            captured = callback;
            return unsubSpy;
          },
          ensureHost: () => Promise.resolve(),
        },
      },
    } as unknown as typeof globalThis.window;

    useChatSessionsStore.setState({
      runtimeReady: false,
      messages: {},
      sessions: [makeSession({ status: 'idle' })],
      activeSessionId: SESSION_ID,
      recentSessionIds: [],
      pendingPermissions: [],
      pendingQuestion: null,
      hostBoundSessionIds: [],
      lastError: null,
      historyErrors: {},
    });
  });

  afterEach(() => {
    if (activeCleanup) {
      activeCleanup();
      activeCleanup = null;
    }
    vi.useRealTimers();
    Reflect.deleteProperty(globalThis, 'window');
  });

  it('coalesces a burst of events into a single flush after RUNTIME_EVENT_FLUSH_MS', () => {
    activeCleanup = useChatSessionsStore.getState().initRuntime();
    expect(captured).not.toBeNull();

    const listener = vi.fn();
    const unsubscribeListener = useChatSessionsStore.subscribe(listener);

    const events: RuntimeEvent[] = [
      {
        type: 'message.started',
        seq: 1,
        sessionId: SESSION_ID,
        timestamp: 1,
        payload: { messageId: 'msg-1', role: 'assistant' },
      },
      {
        type: 'message.delta',
        seq: 2,
        sessionId: SESSION_ID,
        timestamp: 2,
        payload: { messageId: 'msg-1', blockId: 'b1', text: 'Hel' },
      },
      {
        type: 'message.delta',
        seq: 3,
        sessionId: SESSION_ID,
        timestamp: 3,
        payload: { messageId: 'msg-1', blockId: 'b1', text: 'lo' },
      },
    ];
    for (const event of events) {
      captured?.(event);
    }

    // Not flushed yet — queued behind the 16ms timer.
    expect(listener).toHaveBeenCalledTimes(0);
    expect(useChatSessionsStore.getState().messages).toEqual({});

    vi.advanceTimersByTime(16);

    expect(listener).toHaveBeenCalledTimes(1);
    const message = useChatSessionsStore
      .getState()
      .messages[SESSION_ID]?.find((item) => item.id === 'msg-1');
    expect(message?.blocks).toEqual([{ id: 'b1', type: 'text', text: 'Hello' }]);

    unsubscribeListener();
  });

  it('flushes immediately once the queue reaches RUNTIME_EVENT_MAX_QUEUE, before any timer advance', () => {
    activeCleanup = useChatSessionsStore.getState().initRuntime();

    const listener = vi.fn();
    const unsubscribeListener = useChatSessionsStore.subscribe(listener);

    const QUEUE_MAX = 256;
    for (let i = 0; i < QUEUE_MAX; i += 1) {
      const status = i % 2 === 0 ? 'running' : 'waiting_permission';
      captured?.(statusEvent(i + 1, status));
    }

    // The 256th push triggers an immediate synchronous flush — no timer advance needed.
    expect(listener).toHaveBeenCalledTimes(1);
    const session = useChatSessionsStore.getState().sessions.find((item) => item.id === SESSION_ID);
    // Last event (index 255, odd) carried 'waiting_permission'.
    expect(session?.status).toBe('waiting_permission');

    unsubscribeListener();
  });

  it('cleanup drains the pending queue with a final flush and unsubscribes', () => {
    const cleanup = useChatSessionsStore.getState().initRuntime();
    activeCleanup = null; // we call cleanup ourselves below

    const events: RuntimeEvent[] = [
      {
        type: 'session.status',
        seq: 1,
        sessionId: SESSION_ID,
        timestamp: 1,
        payload: { status: 'running' },
      },
      {
        type: 'session.status',
        seq: 2,
        sessionId: SESSION_ID,
        timestamp: 2,
        payload: { status: 'waiting_question' },
      },
    ];
    for (const event of events) {
      captured?.(event);
    }

    // No timer advance — cleanup itself must drain the queue.
    cleanup();

    const session = useChatSessionsStore.getState().sessions.find((item) => item.id === SESSION_ID);
    expect(session?.status).toBe('waiting_question');
    expect(unsubSpy).toHaveBeenCalledTimes(1);
  });
});
