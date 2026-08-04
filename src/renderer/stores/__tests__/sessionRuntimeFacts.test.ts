import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionRuntimeFactsStore } from '../sessionRuntimeFacts';

/**
 * T-14: the store shell around `reduceSessionRuntimeFacts` — subscription
 * lifecycle only (the fold logic itself is covered exhaustively by
 * `contextSurfaceModel.test.ts`). Mirrors the
 * `chatSessionsBatch.test.ts` mock-`window.electronAPI` pattern used for
 * `chatSessions.ts`'s own `initRuntime`.
 */
describe('useSessionRuntimeFactsStore', () => {
  let captured: ((event: RuntimeEvent) => void) | null = null;
  let unsubSpy: ReturnType<typeof vi.fn>;
  let onRuntimeEventSpy: ReturnType<typeof vi.fn>;

  function permissionModeEvent(sessionId: string, permissionMode: string): RuntimeEvent {
    return {
      type: 'session.created',
      seq: 1,
      sessionId,
      timestamp: 1,
      payload: { permissionMode },
    } as unknown as RuntimeEvent;
  }

  beforeEach(() => {
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

    useSessionRuntimeFactsStore.setState({ factsBySession: {}, listening: false });
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'window');
  });

  it('starts with an empty facts map and not listening', () => {
    const state = useSessionRuntimeFactsStore.getState();
    expect(state.factsBySession).toEqual({});
    expect(state.listening).toBe(false);
  });

  it('subscribes exactly once when init() is called', () => {
    const unsubscribe = useSessionRuntimeFactsStore.getState().init();
    expect(onRuntimeEventSpy).toHaveBeenCalledTimes(1);
    expect(useSessionRuntimeFactsStore.getState().listening).toBe(true);
    unsubscribe();
  });

  it('folds an incoming event into factsBySession', () => {
    const unsubscribe = useSessionRuntimeFactsStore.getState().init();
    expect(captured).not.toBeNull();
    captured?.(permissionModeEvent('s1', 'acceptEdits'));

    expect(useSessionRuntimeFactsStore.getState().factsBySession).toEqual({
      s1: { permissionMode: 'acceptEdits' },
    });
    unsubscribe();
  });

  it('is a latch — a second init() call while already listening installs no second listener', () => {
    const first = useSessionRuntimeFactsStore.getState().init();
    const second = useSessionRuntimeFactsStore.getState().init();

    expect(onRuntimeEventSpy).toHaveBeenCalledTimes(1);

    second(); // no-op cleanup — the latch never handed out ownership
    expect(useSessionRuntimeFactsStore.getState().listening).toBe(true);

    first();
    expect(useSessionRuntimeFactsStore.getState().listening).toBe(false);
    expect(unsubSpy).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes and resets the latch on cleanup, allowing a fresh subscribe afterwards', () => {
    const unsubscribe = useSessionRuntimeFactsStore.getState().init();
    unsubscribe();

    expect(unsubSpy).toHaveBeenCalledTimes(1);
    expect(useSessionRuntimeFactsStore.getState().listening).toBe(false);

    const again = useSessionRuntimeFactsStore.getState().init();
    expect(onRuntimeEventSpy).toHaveBeenCalledTimes(2);
    again();
  });
});
