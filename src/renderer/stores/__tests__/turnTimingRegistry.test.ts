import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * dsh-rebase P1-7e (decision 140; decision 139's leftover): the live stamps of
 * thoughts and tool calls outlive the timeline that showed them, as the turn
 * clock's do since problem 16 (`messageMetadataRegistry.test.ts`).
 */

const { listeners } = vi.hoisted(() => ({ listeners: new Set<(event: unknown) => void>() }));
vi.mock('../runtimeEventBus', () => ({
  subscribeRuntimeEvent: (listener: (event: unknown) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
}));

import { markSessionsLive, markSessionsRetired } from '../sessionRetirement';
import {
  applyTurnTimingEvent,
  resetTurnTimingRegistryForTests,
  useTurnTimingStore,
} from '../turnTimingRegistry';

function thought(type: 'thinking.started' | 'thinking.completed', sessionId: string, at: number) {
  return {
    type,
    sessionId,
    seq: at,
    timestamp: at,
    payload: { messageId: 'm1', blockId: 'm1:th' },
  } as unknown as RuntimeEvent;
}

function tool(type: 'tool.started' | 'tool.completed', sessionId: string, at: number) {
  return {
    type,
    sessionId,
    seq: at,
    timestamp: at,
    payload: { messageId: 'm1', toolCallId: 'c1' },
  } as unknown as RuntimeEvent;
}

function emit(event: RuntimeEvent) {
  for (const listener of [...listeners]) listener(event);
}

const registryOf = (sessionId: string) => useTurnTimingStore.getState().bySession[sessionId];

beforeEach(() => {
  resetTurnTimingRegistryForTests();
  listeners.clear();
});

afterEach(() => resetTurnTimingRegistryForTests());

describe('applyTurnTimingEvent', () => {
  it('[E2B-TT-1] files each chat’s thoughts and calls under that chat', () => {
    let state = applyTurnTimingEvent({}, thought('thinking.started', 'a', 1_000));
    state = applyTurnTimingEvent(state, thought('thinking.completed', 'a', 3_000));
    state = applyTurnTimingEvent(state, tool('tool.started', 'b', 2_000));
    expect(state.a?.byBlock['m1:th']).toEqual({
      startedAt: 1_000,
      completedAt: 3_000,
      durationMs: 2_000,
    });
    expect(state.a?.byToolCall).toEqual({});
    expect(state.b?.byToolCall.c1).toEqual({ startedAt: 2_000 });
  });

  it('[E2B-TT-2] the same state for an event it does not read, or one that names no chat', () => {
    const state = applyTurnTimingEvent({}, thought('thinking.started', 'a', 1_000));
    expect(
      applyTurnTimingEvent(state, {
        type: 'message.delta',
        sessionId: 'a',
        payload: {},
      } as unknown as RuntimeEvent)
    ).toBe(state);
    expect(
      applyTurnTimingEvent(state, {
        type: 'thinking.started',
        payload: { blockId: 'x' },
      } as unknown as RuntimeEvent)
    ).toBe(state);
  });
});

describe('the run-long listener', () => {
  it('[E2B-TT-3] keeps a thought’s duration after the last timeline let go', () => {
    const workspace = useTurnTimingStore.getState().retain();
    const timeline = useTurnTimingStore.getState().retain();
    emit(thought('thinking.started', 'a', 1_000));
    emit(thought('thinking.completed', 'a', 4_000));
    timeline();
    expect(registryOf('a')?.byBlock['m1:th']?.durationMs).toBe(3_000);
    workspace();
  });

  it('[E2B-TT-4] records a chat that is not on screen, and ignores a retired one', () => {
    const release = useTurnTimingStore.getState().retain();
    emit(thought('thinking.started', 'background', 1_000));
    expect(registryOf('background')?.byBlock['m1:th']).toEqual({ startedAt: 1_000 });
    markSessionsRetired(['gone']);
    try {
      emit(thought('thinking.started', 'gone', 1_000));
      expect(registryOf('gone')).toBeUndefined();
    } finally {
      markSessionsLive(['gone']);
    }
    release();
  });

  it('[E2B-TT-5] subscribes once however many hold it, and stops when the last one lets go', () => {
    const first = useTurnTimingStore.getState().retain();
    const second = useTurnTimingStore.getState().retain();
    expect(listeners.size).toBe(1);
    first();
    first();
    expect(listeners.size).toBe(1);
    second();
    expect(listeners.size).toBe(0);
  });

  it('[E2B-TT-6] a rewind clears its chat; a chat that is gone is pruned', () => {
    const release = useTurnTimingStore.getState().retain();
    emit(thought('thinking.started', 'a', 1_000));
    emit(thought('thinking.started', 'b', 1_000));
    emit(thought('thinking.started', 'c', 1_000));
    useTurnTimingStore.getState().resetSession('a');
    expect(registryOf('a')).toBeUndefined();
    const before = useTurnTimingStore.getState().bySession;
    useTurnTimingStore.getState().resetSession('a');
    expect(useTurnTimingStore.getState().bySession).toBe(before);
    useTurnTimingStore.getState().pruneSessions(['b']);
    expect(Object.keys(useTurnTimingStore.getState().bySession)).toEqual(['b']);
    const pruned = useTurnTimingStore.getState().bySession;
    useTurnTimingStore.getState().pruneSessions(['b']);
    expect(useTurnTimingStore.getState().bySession).toBe(pruned);
    release();
  });
});
