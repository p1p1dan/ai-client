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

    useExtensionUiStore.setState({
      pending: [],
      sending: [],
      sendErrors: {},
      listening: false,
    });
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
     * A failed send means the Host never heard us — so its dialog is STILL
     * PARKED and still answerable. Closing ours would leave nothing on screen
     * and an extension waiting forever, which is a turn that never ends with no
     * way for the user to tell. Keep it up, say why, allow a retry.
     */
    it('keeps the dialog and reports the failure when the send fails', async () => {
      respondSpy.mockRejectedValueOnce(new Error('ipc down'));
      await expect(useExtensionUiStore.getState().answer('q1', 'a')).resolves.toBeUndefined();

      const state = useExtensionUiStore.getState();
      expect(state.pending.map((p) => p.uiRequestId)).toEqual(['q1']);
      expect(state.sendErrors.q1).toContain('ipc down');
      // The guard is released, or the retry would be refused as a double-click.
      expect(state.sending).toEqual([]);
    });

    it('lets the user retry after a failed send, and closes on success', async () => {
      respondSpy.mockRejectedValueOnce(new Error('ipc down'));
      await useExtensionUiStore.getState().answer('q1', 'a');
      await useExtensionUiStore.getState().answer('q1', 'a');

      expect(respondSpy).toHaveBeenCalledTimes(2);
      const state = useExtensionUiStore.getState();
      expect(state.pending).toEqual([]);
      expect(state.sendErrors).toEqual({});
    });

    /** A Host that already tore the dialog down cancels it; ours must follow. */
    it('drops a dialog the Host cancelled while a send was in flight', async () => {
      let release: (() => void) | undefined;
      respondSpy.mockImplementationOnce(
        () =>
          new Promise<{ requestId: string }>((resolve) => {
            release = () => resolve({ requestId: 'r' });
          })
      );
      const inFlight = useExtensionUiStore.getState().answer('q1', 'a');
      expect(useExtensionUiStore.getState().sending).toEqual(['q1']);

      captured?.({
        type: 'extensionUi.cancelled',
        seq: 9,
        timestamp: 2,
        sessionId: 's1',
        payload: { runtimeId: 'rt-9', uiRequestIds: ['q1'], reason: 'host_shutdown' },
      });
      expect(useExtensionUiStore.getState().pending).toEqual([]);
      expect(useExtensionUiStore.getState().sending).toEqual([]);

      release?.();
      await inFlight;
      expect(useExtensionUiStore.getState().pending).toEqual([]);
    });
  });

  /**
   * T08-b — the permission approval loop, end to end through this store.
   *
   * The four options are verbatim what `@gotgenes/pi-permission-system` emits:
   * captured by running its own `requestPermissionDecisionFromUi` against a
   * recording `ui`, not transcribed from its docs. If the plugin ever renames
   * one, this test still passes (the store is agnostic) — what it pins is that
   * the answer travels back UNCHANGED, because the plugin matches the returned
   * string against its option list and anything else is read as a denial.
   */
  describe('permission approval loop', () => {
    const OPTIONS = ['Yes', 'Yes, for this session', 'No', 'No, provide reason'];

    function permissionPrompt(uiRequestId: string): RuntimeEvent {
      return {
        type: 'extensionUi.request',
        seq: 1,
        timestamp: 1,
        sessionId: 's1',
        payload: {
          runtimeId: 'rt-1',
          uiRequestId,
          method: 'select',
          args: {
            title: 'Allow bash?\nTool: bash\nCommand: rm -rf /tmp/build',
            options: OPTIONS,
          },
        },
      } as RuntimeEvent;
    }

    it('sends the chosen option back verbatim', async () => {
      useExtensionUiStore.getState().init();
      captured?.(permissionPrompt('p1'));
      await useExtensionUiStore.getState().answer('p1', 'Yes, for this session');
      expect(lastPayload()).toMatchObject({ ok: true, value: 'Yes, for this session' });
    });

    /**
     * Fail-closed, and the reason it is safe: a dismissal sends NO value, the
     * Host substitutes `undefined` for a select, and the plugin's own
     * `requestPermissionDecisionFromUi` falls through an unmatched selection to
     * `createDeniedPermissionDecision()`. Closing the box denies the tool call.
     */
    it('turns a dismissal into a no-value response, which the plugin reads as deny', async () => {
      useExtensionUiStore.getState().init();
      captured?.(permissionPrompt('p2'));
      await useExtensionUiStore.getState().dismiss('p2');
      const payload = lastPayload();
      expect(payload.ok).toBe(false);
      expect('value' in payload).toBe(false);
    });

    /** The scope follow-up is a second select on the same path — nothing special. */
    it('handles the session-scope follow-up as an ordinary second dialog', async () => {
      useExtensionUiStore.getState().init();
      captured?.(permissionPrompt('p3'));
      await useExtensionUiStore.getState().answer('p3', 'Yes, for this session');
      captured?.({
        type: 'extensionUi.request',
        seq: 2,
        timestamp: 2,
        sessionId: 's1',
        payload: {
          runtimeId: 'rt-1',
          uiRequestId: 'p3-scope',
          method: 'select',
          args: {
            title: 'Allow bash?\nApply this session grant to:',
            options: ['This subagent only', 'The whole session'],
          },
        },
      } as RuntimeEvent);
      expect(useExtensionUiStore.getState().pending.map((p) => p.uiRequestId)).toEqual([
        'p3-scope',
      ]);
      await useExtensionUiStore.getState().answer('p3-scope', 'This subagent only');
      expect(lastPayload()).toMatchObject({ value: 'This subagent only' });
    });

    /** "No, provide reason" opens an input whose text is the denial reason. */
    it('carries the denial reason from the follow-up input', async () => {
      useExtensionUiStore.getState().init();
      captured?.({
        type: 'extensionUi.request',
        seq: 3,
        timestamp: 3,
        sessionId: 's1',
        payload: {
          runtimeId: 'rt-1',
          uiRequestId: 'p4-reason',
          method: 'input',
          args: {
            title: 'Allow bash?\nShare why this request was denied (optional).',
            placeholder: 'Reason shown back to the agent',
          },
        },
      } as RuntimeEvent);
      await useExtensionUiStore.getState().answer('p4-reason', 'Too destructive');
      expect(lastPayload()).toMatchObject({ ok: true, value: 'Too destructive' });
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
