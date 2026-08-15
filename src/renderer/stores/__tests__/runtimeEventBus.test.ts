import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createRuntimeEventBus,
  type RuntimeEventListener,
  resetRuntimeEventBus,
  subscribeRuntimeEvent,
} from '../runtimeEventBus';

/**
 * Incident 2026-08-15: the renderer holds 11-13 concurrent `chat:runtimeEvent`
 * subscriptions and preload installs one bare `ipcRenderer.on` per call, which
 * trips Node's default 10-listener warning. These are the invariants that keep
 * the fan-out honest: exactly ONE upstream listener while anyone is
 * subscribed, zero when nobody is.
 */
describe('createRuntimeEventBus', () => {
  let captured: RuntimeEventListener | null = null;
  let detachSpy: ReturnType<typeof vi.fn>;
  let upstreamSpy: ReturnType<typeof vi.fn>;

  function event(seq: number): RuntimeEvent {
    return {
      type: 'session.status',
      seq,
      sessionId: 's1',
      timestamp: seq,
      payload: { status: 'idle' },
    } as unknown as RuntimeEvent;
  }

  beforeEach(() => {
    captured = null;
    detachSpy = vi.fn();
    upstreamSpy = vi.fn((listener: RuntimeEventListener) => {
      captured = listener;
      return detachSpy;
    });
  });

  it('attaches upstream exactly once no matter how many subscribers pile on', () => {
    const bus = createRuntimeEventBus(upstreamSpy);
    const unsubs = Array.from({ length: 13 }, () => bus.subscribe(vi.fn()));

    expect(upstreamSpy).toHaveBeenCalledTimes(1);

    for (const unsub of unsubs) unsub();
  });

  it('broadcasts one upstream event to every subscriber', () => {
    const bus = createRuntimeEventBus(upstreamSpy);
    const listeners = [vi.fn(), vi.fn(), vi.fn()];
    const unsubs = listeners.map((listener) => bus.subscribe(listener));

    captured?.(event(1));

    for (const listener of listeners) {
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(event(1));
    }

    for (const unsub of unsubs) unsub();
  });

  it('detaches upstream only when the LAST subscriber leaves', () => {
    const bus = createRuntimeEventBus(upstreamSpy);
    const first = bus.subscribe(vi.fn());
    const second = bus.subscribe(vi.fn());

    first();
    expect(detachSpy).not.toHaveBeenCalled();

    second();
    expect(detachSpy).toHaveBeenCalledTimes(1);
  });

  it('stops delivering to a listener that unsubscribed while its neighbour stays live', () => {
    const bus = createRuntimeEventBus(upstreamSpy);
    const gone = vi.fn();
    const stays = vi.fn();
    const unsubGone = bus.subscribe(gone);
    const unsubStays = bus.subscribe(stays);

    unsubGone();
    captured?.(event(1));

    expect(gone).not.toHaveBeenCalled();
    expect(stays).toHaveBeenCalledTimes(1);

    unsubStays();
  });

  it('re-attaches upstream after a full teardown (StrictMode remount)', () => {
    const bus = createRuntimeEventBus(upstreamSpy);
    bus.subscribe(vi.fn())();
    expect(detachSpy).toHaveBeenCalledTimes(1);

    const again = bus.subscribe(vi.fn());
    expect(upstreamSpy).toHaveBeenCalledTimes(2);

    again();
    expect(detachSpy).toHaveBeenCalledTimes(2);
  });

  it('unsubscribe is idempotent — a second call cannot tear down a live upstream', () => {
    const bus = createRuntimeEventBus(upstreamSpy);
    const unsubFirst = bus.subscribe(vi.fn());
    const stays = vi.fn();
    const unsubStays = bus.subscribe(stays);

    unsubFirst();
    unsubFirst();
    unsubFirst();

    expect(detachSpy).not.toHaveBeenCalled();

    captured?.(event(1));
    expect(stays).toHaveBeenCalledTimes(1);

    unsubStays();
    expect(detachSpy).toHaveBeenCalledTimes(1);
  });

  // The per-subscription `disposed` latch is what makes this safe: without it,
  // a stale handle called after the SAME listener re-subscribed (ChatComposer's
  // `finally` cleanup plus a StrictMode remount makes this reachable) deletes
  // the live Set entry — the refcount hits zero and the shared upstream is torn
  // down under the live subscriber.
  it('a stale handle called after the same listener re-subscribed stays a no-op', () => {
    const bus = createRuntimeEventBus(upstreamSpy);
    const listener = vi.fn();
    const stale = bus.subscribe(listener);
    stale();
    expect(detachSpy).toHaveBeenCalledTimes(1);

    const live = bus.subscribe(listener);
    stale();

    captured?.(event(1));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(detachSpy).toHaveBeenCalledTimes(1);

    live();
    expect(detachSpy).toHaveBeenCalledTimes(2);
  });

  it('unsubscribe after the bus already tore down does not detach twice', () => {
    const bus = createRuntimeEventBus(upstreamSpy);
    const unsub = bus.subscribe(vi.fn());

    unsub();
    unsub();

    expect(detachSpy).toHaveBeenCalledTimes(1);
  });

  it('a throwing listener does not block its neighbours', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bus = createRuntimeEventBus(upstreamSpy);
    const before = vi.fn();
    const thrower = vi.fn(() => {
      throw new Error('boom');
    });
    const after = vi.fn();
    const unsubs = [bus.subscribe(before), bus.subscribe(thrower), bus.subscribe(after)];

    expect(() => captured?.(event(1))).not.toThrow();

    expect(before).toHaveBeenCalledTimes(1);
    expect(thrower).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);

    // Still healthy for the next event.
    captured?.(event(2));
    expect(after).toHaveBeenCalledTimes(2);

    for (const unsub of unsubs) unsub();
    errorSpy.mockRestore();
  });

  it('a listener unsubscribing itself mid-dispatch does not skip the next one', () => {
    const bus = createRuntimeEventBus(upstreamSpy);
    const last = vi.fn();
    let unsubSelf: (() => void) | null = null;
    const selfRemoving = vi.fn(() => unsubSelf?.());
    unsubSelf = bus.subscribe(selfRemoving);
    const unsubLast = bus.subscribe(last);

    captured?.(event(1));

    expect(last).toHaveBeenCalledTimes(1);

    unsubLast();
  });
});

describe('subscribeRuntimeEvent (singleton)', () => {
  let captured: RuntimeEventListener | null = null;
  let detachSpy: ReturnType<typeof vi.fn>;
  let onRuntimeEventSpy: ReturnType<typeof vi.fn>;

  function readyEvent(): RuntimeEvent {
    return { type: 'host.ready', seq: 1, timestamp: 1, payload: {} } as unknown as RuntimeEvent;
  }

  beforeEach(() => {
    resetRuntimeEventBus();
    captured = null;
    detachSpy = vi.fn();
    onRuntimeEventSpy = vi.fn((listener: RuntimeEventListener) => {
      captured = listener;
      return detachSpy;
    });

    (globalThis as { window?: unknown }).window = {
      electronAPI: { chat: { onRuntimeEvent: onRuntimeEventSpy } },
    } as unknown as typeof globalThis.window;
  });

  afterEach(() => {
    resetRuntimeEventBus();
    Reflect.deleteProperty(globalThis, 'window');
  });

  // The module itself imported fine with no `window` in scope (node env, this
  // file's import list has nothing else in it) — the preload lookup must stay
  // inside the upstream callback, never at module scope.
  it('reads window.electronAPI lazily — nothing touched until the first subscribe', () => {
    expect(onRuntimeEventSpy).not.toHaveBeenCalled();

    const listener = vi.fn();
    const unsubscribe = subscribeRuntimeEvent(listener);

    expect(onRuntimeEventSpy).toHaveBeenCalledTimes(1);
    captured?.(readyEvent());
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    expect(detachSpy).toHaveBeenCalledTimes(1);
  });

  it('shares ONE preload listener across independent call sites', () => {
    const a = vi.fn();
    const b = vi.fn();
    const unsubA = subscribeRuntimeEvent(a);
    const unsubB = subscribeRuntimeEvent(b);

    expect(onRuntimeEventSpy).toHaveBeenCalledTimes(1);

    captured?.(readyEvent());
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);

    unsubA();
    expect(detachSpy).not.toHaveBeenCalled();
    unsubB();
    expect(detachSpy).toHaveBeenCalledTimes(1);
  });
});
