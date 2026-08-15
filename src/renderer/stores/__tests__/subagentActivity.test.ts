import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initialSubagentActivity } from '@/components/chat/subagentActivityModel';
import { resetRuntimeEventBus } from '../runtimeEventBus';
import { useSubagentActivityStore } from '../subagentActivity';

/**
 * T-34: the store shell around `reduceSubagentActivity` — subscription
 * lifecycle only (the fold logic is covered exhaustively by
 * `subagentActivityModel.test.ts`). Mirrors `sessionRuntimeFacts.test.ts`,
 * the T-35 precedent this shell copies structurally.
 */
describe('useSubagentActivityStore', () => {
  let captured: ((event: RuntimeEvent) => void) | null = null;
  let unsubSpy: ReturnType<typeof vi.fn>;
  let onRuntimeEventSpy: ReturnType<typeof vi.fn>;

  function startedEvent(parentToolCallId: string): RuntimeEvent {
    return {
      type: 'subagent.activity',
      seq: 1,
      sessionId: 's1',
      timestamp: 1,
      payload: { kind: 'started', parentToolCallId, agentId: 'a1' },
    } as unknown as RuntimeEvent;
  }

  beforeEach(() => {
    // `init()` subscribes through the shared runtime-event bus, whose singleton
    // outlives a test file — drop it so the bus attaches to THIS test's mock.
    resetRuntimeEventBus();
    captured = null;
    unsubSpy = vi.fn();
    onRuntimeEventSpy = vi.fn((callback: (event: RuntimeEvent) => void) => {
      captured = callback;
      return unsubSpy;
    });

    (globalThis as { window?: unknown }).window = {
      electronAPI: {
        chat: {
          onRuntimeEvent: onRuntimeEventSpy,
        },
      },
    } as unknown as typeof globalThis.window;

    useSubagentActivityStore.setState({ ...initialSubagentActivity, listening: false });
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'window');
  });

  it('starts empty and not listening', () => {
    const state = useSubagentActivityStore.getState();
    expect(state.lanes).toEqual({});
    expect(state.permissionOrigin).toEqual({});
    expect(state.listening).toBe(false);
  });

  it('subscribes exactly once and folds an incoming event into a lane', () => {
    const unsubscribe = useSubagentActivityStore.getState().init();
    expect(onRuntimeEventSpy).toHaveBeenCalledTimes(1);
    captured?.(startedEvent('toolu_1'));
    expect(useSubagentActivityStore.getState().lanes.toolu_1?.status).toBe('running');
    unsubscribe();
  });

  it('an unrelated event leaves the lanes reference untouched (no phantom re-render)', () => {
    const unsubscribe = useSubagentActivityStore.getState().init();
    captured?.(startedEvent('toolu_1'));
    const before = useSubagentActivityStore.getState().lanes;
    captured?.({
      type: 'message.delta',
      seq: 2,
      sessionId: 's1',
      timestamp: 2,
      payload: { messageId: 'm', blockId: 'b', text: 'x' },
    } as unknown as RuntimeEvent);
    expect(useSubagentActivityStore.getState().lanes).toBe(before);
    unsubscribe();
  });

  it('is a latch — a second init() installs no second listener', () => {
    const first = useSubagentActivityStore.getState().init();
    const second = useSubagentActivityStore.getState().init();
    expect(onRuntimeEventSpy).toHaveBeenCalledTimes(1);
    second();
    expect(useSubagentActivityStore.getState().listening).toBe(true);
    first();
    expect(useSubagentActivityStore.getState().listening).toBe(false);
    expect(unsubSpy).toHaveBeenCalledTimes(1);
  });

  it('cleanup resets the latch and allows a fresh subscribe (StrictMode remount)', () => {
    const unsubscribe = useSubagentActivityStore.getState().init();
    unsubscribe();
    expect(useSubagentActivityStore.getState().listening).toBe(false);
    const again = useSubagentActivityStore.getState().init();
    expect(onRuntimeEventSpy).toHaveBeenCalledTimes(2);
    again();
  });
});
