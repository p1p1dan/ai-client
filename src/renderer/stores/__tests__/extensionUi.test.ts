import type { ExtensionUiResponse, RuntimeEvent } from '@shared/types/runtimeEvents';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useExtensionUiStore } from '../extensionUi';
import { resetRuntimeEventBus } from '../runtimeEventBus';

/**
 * T11/T08 — the store shell: subscription lifecycle plus the send path.
 *
 * The fold itself is covered exhaustively by `extensionUiModel.test.ts`. What
 * only lives here is what goes ON THE WIRE, and the rule it must not break: a
 * dismissal says `ok: false` and carries NO value. The Host substitutes the
 * fallback recorded when the dialog opened — `false` for a confirm — so a value
 * riding along on a dismissal is how "the user closed the box" turns into "the
 * user approved it".
 */
describe('useExtensionUiStore', () => {
  let captured: ((event: RuntimeEvent) => void) | null = null;
  let unsubSpy: ReturnType<typeof vi.fn>;
  let onRuntimeEventSpy: ReturnType<typeof vi.fn>;
  let respondSpy: ReturnType<typeof vi.fn>;

  function requestEvent(uiRequestId: string, runtimeId = 'rt-1'): RuntimeEvent {
    return {
      type: 'extensionUi.request',
      seq: 1,
      timestamp: 1,
      sessionId: 's1',
      payload: {
        runtimeId,
        uiRequestId,
        method: 'select',
        args: { title: 'Pick', options: ['a', 'b'] },
      },
    } as RuntimeEvent;
  }

  const lastPayload = (): ExtensionUiResponse =>
    respondSpy.mock.calls.at(-1)?.[0] as ExtensionUiResponse;

  beforeEach(() => {
    // `init()` subscribes through the shared bus, whose singleton outlives a
    // test file — drop it so the bus attaches to THIS test's mock.
    resetRuntimeEventBus();
    captured = null;
    unsubSpy = vi.fn();
    onRuntimeEventSpy = vi.fn((callback: (event: RuntimeEvent) => void) => {
      captured = callback;
      return unsubSpy;
    });
    respondSpy = vi.fn(async () => ({ requestId: 'r1' }));

    (globalThis as { window?: unknown }).window = {
      electronAPI: {
        chat: { onRuntimeEvent: onRuntimeEventSpy, respondExtensionUi: respondSpy },
      },
    } as unknown as typeof globalThis.window;

    useExtensionUiStore.setState({ pending: [], listening: false });
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'window');
  });

  describe('subscription lifecycle', () => {
    it('subscribes exactly once across repeated init()', () => {
      const stop = useExtensionUiStore.getState().init();
      useExtensionUiStore.getState().init();
      expect(onRuntimeEventSpy).toHaveBeenCalledTimes(1);
      expect(useExtensionUiStore.getState().listening).toBe(true);
      stop();
      expect(unsubSpy).toHaveBeenCalledTimes(1);
      expect(useExtensionUiStore.getState().listening).toBe(false);
    });

    it('queues a dialog from a runtime event', () => {
      useExtensionUiStore.getState().init();
      captured?.(requestEvent('q1'));
      expect(useExtensionUiStore.getState().pending.map((p) => p.uiRequestId)).toEqual(['q1']);
    });
  });

  describe('answering', () => {
    beforeEach(() => {
      useExtensionUiStore.getState().init();
      captured?.(requestEvent('q1', 'rt-9'));
    });

    it('sends the answer with the asking bridge id and closes the dialog', async () => {
      await useExtensionUiStore.getState().answer('q1', 'a');
      expect(lastPayload()).toEqual({
        runtimeId: 'rt-9',
        uiRequestId: 'q1',
        ok: true,
        value: 'a',
      });
      expect(useExtensionUiStore.getState().pending).toEqual([]);
    });

    /** The whole point of the `ok` flag — see this file's header. */
    it('sends a dismissal with no value at all', async () => {
      await useExtensionUiStore.getState().dismiss('q1');
      const payload = lastPayload();
      expect(payload).toEqual({ runtimeId: 'rt-9', uiRequestId: 'q1', ok: false });
      expect('value' in payload).toBe(false);
    });

    it('preserves an explicit undefined answer as an answer', async () => {
      await useExtensionUiStore.getState().answer('q1', undefined);
      const payload = lastPayload();
      expect(payload.ok).toBe(true);
      expect('value' in payload).toBe(true);
    });

    it('sends nothing for a dialog it is not showing', async () => {
      await useExtensionUiStore.getState().answer('never-queued', 'a');
      expect(respondSpy).not.toHaveBeenCalled();
    });

    /** A re-mounted component can fire twice; the second must not reach the Host. */
    it('sends only once when answered twice', async () => {
      await useExtensionUiStore.getState().answer('q1', 'a');
      await useExtensionUiStore.getState().answer('q1', 'b');
      expect(respondSpy).toHaveBeenCalledTimes(1);
    });

    /**
     * A failed send means the Host never heard us, and the bridge's own timeout
     * or teardown will settle the extension. Keeping the modal up instead would
     * trap the user in a dialog whose buttons no longer do anything.
     */
    it('still closes the dialog when the send fails', async () => {
      respondSpy.mockRejectedValueOnce(new Error('ipc down'));
      await expect(useExtensionUiStore.getState().answer('q1', 'a')).resolves.toBeUndefined();
      expect(useExtensionUiStore.getState().pending).toEqual([]);
    });
  });

  describe('cancellation from the Host', () => {
    it('drops a dialog the bridge already settled', () => {
      useExtensionUiStore.getState().init();
      captured?.(requestEvent('q1'));
      captured?.({
        type: 'extensionUi.cancelled',
        seq: 2,
        timestamp: 2,
        payload: { runtimeId: 'rt-1', uiRequestIds: ['q1'], reason: 'timed_out' },
      } as RuntimeEvent);
      expect(useExtensionUiStore.getState().pending).toEqual([]);
    });

    it('does not send an answer for a cancelled dialog', async () => {
      useExtensionUiStore.getState().init();
      captured?.(requestEvent('q1'));
      captured?.({
        type: 'extensionUi.cancelled',
        seq: 2,
        timestamp: 2,
        payload: { runtimeId: 'rt-1', uiRequestIds: ['q1'], reason: 'session_replaced' },
      } as RuntimeEvent);
      await useExtensionUiStore.getState().answer('q1', 'a');
      expect(respondSpy).not.toHaveBeenCalled();
    });
  });
});
