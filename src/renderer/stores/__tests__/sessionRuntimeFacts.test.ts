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

  // Opus m9: `init()`'s own cleanup already resets `listening: false` before
  // unsubscribing (the block above), so a caller never needs to — and must
  // not — force that reset itself. `ChatWorkspace.tsx` used to copy the
  // `setState({ listening: false })` workaround from the adjacent
  // `chatSessions.ts` `runtimeReady` latch (a red-line file whose own cleanup
  // does NOT reset its latch, which is why that one genuinely needs the
  // workaround). Doing the same here defeated this store's latch instead.
  it('regression (Opus m9): resetting `listening` externally while a listener is still installed breaks the latch and installs a second one', () => {
    const first = useSessionRuntimeFactsStore.getState().init();
    expect(onRuntimeEventSpy).toHaveBeenCalledTimes(1);

    // Simulate the removed anti-pattern: force the latch open again while
    // the first listener from `first` above is still live and un-cleaned-up.
    useSessionRuntimeFactsStore.setState({ listening: false });
    const second = useSessionRuntimeFactsStore.getState().init();

    // Two listeners now installed — this is the bug, not the fix. The
    // correct call pattern (no external reset) is covered by the "is a
    // latch" test above, which asserts exactly one call.
    expect(onRuntimeEventSpy).toHaveBeenCalledTimes(2);

    first();
    second();
  });

  // Build spec 2026-08-14 (partial messages), 片 2: `set()`'s callback must
  // return `state` itself (not a fresh object) when `reduceSessionRuntimeFacts`
  // produced no change, so zustand's `Object.is` equality check short-circuits
  // `setState` and skips notifying subscribers — an unrelated event must not
  // wake up every `useSessionRuntimeFactsStore` consumer in the tree.
  it('notification short-circuit: an event the reducer does not recognize triggers zero subscriber calls', () => {
    const unsubscribe = useSessionRuntimeFactsStore.getState().init();
    expect(captured).not.toBeNull();

    const listener = vi.fn();
    const unsubscribeListener = useSessionRuntimeFactsStore.subscribe(listener);

    // `message.delta` is not one of reduceSessionRuntimeFacts's recognized
    // types (session.created / session.resumed / session.stderr) — the
    // reducer returns `prev` (the SAME object reference), so `next ===
    // state.factsBySession` and `set()` returns `state` itself.
    captured?.({
      type: 'message.delta',
      seq: 1,
      sessionId: 's1',
      timestamp: 1,
      payload: {},
    } as unknown as RuntimeEvent);

    expect(listener).not.toHaveBeenCalled();

    unsubscribeListener();
    unsubscribe();
  });

  it('notification positive control: an event the reducer actually folds still notifies subscribers', () => {
    const unsubscribe = useSessionRuntimeFactsStore.getState().init();
    expect(captured).not.toBeNull();

    const listener = vi.fn();
    const unsubscribeListener = useSessionRuntimeFactsStore.subscribe(listener);

    captured?.(permissionModeEvent('s1', 'acceptEdits'));

    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribeListener();
    unsubscribe();
  });
});
