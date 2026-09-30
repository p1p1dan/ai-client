import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * dsh-rebase P1-7e (problem 16, decision 139): the turn clock's live stamps
 * outlive the timeline that showed them.
 */

const { listeners } = vi.hoisted(() => ({ listeners: new Set<(event: unknown) => void>() }));
vi.mock('../runtimeEventBus', () => ({
  subscribeRuntimeEvent: (listener: (event: unknown) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
}));

import {
  applyMetadataEvent,
  resetMessageMetadataRegistryForTests,
  useMessageMetadataStore,
} from '../messageMetadataRegistry';
import { markSessionsLive, markSessionsRetired } from '../sessionRetirement';

const noModel = () => undefined;

function started(sessionId: string, messageId: string, role: string, timestamp: number) {
  return {
    type: 'message.started',
    sessionId,
    seq: timestamp,
    timestamp,
    payload: { messageId, role },
  } as unknown as RuntimeEvent;
}

function completed(sessionId: string, messageId: string, timestamp: number) {
  return {
    type: 'message.completed',
    sessionId,
    seq: timestamp,
    timestamp,
    payload: { messageId },
  } as unknown as RuntimeEvent;
}

function emit(event: RuntimeEvent) {
  for (const listener of [...listeners]) listener(event);
}

const registryOf = (sessionId: string) => useMessageMetadataStore.getState().bySession[sessionId];

beforeEach(() => {
  resetMessageMetadataRegistryForTests();
  listeners.clear();
});

afterEach(() => resetMessageMetadataRegistryForTests());

describe('applyMetadataEvent', () => {
  it('files each chat’s stamps under that chat', () => {
    let state = applyMetadataEvent({}, started('a', 'u1', 'user', 1_000), noModel);
    state = applyMetadataEvent(state, started('b', 'u2', 'user', 2_000), noModel);
    expect(state.a?.byMessage.u1).toEqual({ startedAt: 1_000 });
    expect(state.b?.byMessage.u2).toEqual({ startedAt: 2_000 });
  });

  it('returns the same state for an event it does not read, or one with no chat', () => {
    const state = applyMetadataEvent({}, started('a', 'u1', 'user', 1_000), noModel);
    expect(
      applyMetadataEvent(
        state,
        { type: 'message.delta', sessionId: 'a', payload: {} } as unknown as RuntimeEvent,
        noModel
      )
    ).toBe(state);
    expect(
      applyMetadataEvent(
        state,
        { type: 'usage.updated', payload: {} } as unknown as RuntimeEvent,
        noModel
      )
    ).toBe(state);
  });

  it('stamps the model the resolver names when the event names none', () => {
    const state = applyMetadataEvent({}, started('a', 'm1', 'assistant', 1_000), () => 'pick');
    expect(state.a?.byMessage.m1).toMatchObject({ model: 'pick', reportedModel: null });
  });
});

describe('the run-long listener', () => {
  it('keeps a finished turn’s stamps after the last timeline let go (problem 16)', () => {
    const workspace = useMessageMetadataStore.getState().retain(noModel);
    const timeline = useMessageMetadataStore.getState().retain(noModel);
    emit(started('a', 'u1', 'user', 1_000));
    emit(started('a', 'm1', 'assistant', 2_000));
    emit(completed('a', 'm1', 4_000));
    // The timeline unmounts (the start screen of a New chat); the workspace
    // still holds the listener, and the registry is where it was.
    timeline();
    expect(registryOf('a')?.byMessage.m1).toMatchObject({ completedAt: 4_000, latencyMs: 2_000 });
    workspace();
  });

  it('records a chat that is not on screen', () => {
    const release = useMessageMetadataStore.getState().retain(noModel);
    emit(completed('background', 'm9', 9_000));
    expect(registryOf('background')?.byMessage.m9).toMatchObject({ completedAt: 9_000 });
    release();
  });

  it('subscribes once however many hold it, and stops when the last one lets go', () => {
    const first = useMessageMetadataStore.getState().retain(noModel);
    const second = useMessageMetadataStore.getState().retain(noModel);
    expect(listeners.size).toBe(1);
    first();
    first();
    expect(listeners.size).toBe(1);
    second();
    expect(listeners.size).toBe(0);
  });

  it('ignores a chat the tree sync retired', () => {
    const release = useMessageMetadataStore.getState().retain(noModel);
    markSessionsRetired(['gone']);
    emit(started('gone', 'u1', 'user', 1_000));
    expect(registryOf('gone')).toBeUndefined();
    markSessionsLive(['gone']);
    release();
  });
});

describe('pruning', () => {
  it('drops the registries of chats that are gone, and one rewind replaced', () => {
    useMessageMetadataStore.setState({
      bySession: {
        a: applyMetadataEvent({}, started('a', 'u1', 'user', 1), noModel).a,
        b: applyMetadataEvent({}, started('b', 'u2', 'user', 1), noModel).b,
      } as never,
    });
    useMessageMetadataStore.getState().pruneSessions(['a']);
    expect(Object.keys(useMessageMetadataStore.getState().bySession)).toEqual(['a']);
    useMessageMetadataStore.getState().resetSession('a');
    expect(useMessageMetadataStore.getState().bySession).toEqual({});
  });
});
