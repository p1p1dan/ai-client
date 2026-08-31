import type { ExtensionUiMethod, RuntimeEvent } from '@shared/types/runtimeEvents';
import { describe, expect, it } from 'vitest';
import {
  clearExtensionUiRuntime,
  extensionUiNotificationDelivery,
  initialExtensionUiDisplay,
  pruneExtensionUiDisplayState,
  reduceExtensionUiDisplay,
  removeExtensionUiNotification,
} from '../extensionUiDisplayModel';

let seq = 0;
function request(
  method: ExtensionUiMethod,
  args: unknown,
  overrides: { sessionId?: string; runtimeId?: string; uiRequestId?: string } = {}
): RuntimeEvent {
  seq += 1;
  return {
    type: 'extensionUi.request',
    seq,
    timestamp: 1_000 + seq,
    sessionId: overrides.sessionId ?? 's1',
    payload: {
      runtimeId: overrides.runtimeId ?? 'r1',
      uiRequestId: overrides.uiRequestId ?? `u${seq}`,
      method,
      args,
    },
  };
}

function reset(sessionId = 's1', runtimeId = 'r1'): RuntimeEvent {
  seq += 1;
  return {
    type: 'extensionUi.reset',
    seq,
    timestamp: 2_000 + seq,
    sessionId,
    payload: { runtimeId, reason: 'session_replaced' },
  };
}

const fold = (events: RuntimeEvent[]) =>
  events.reduce(reduceExtensionUiDisplay, initialExtensionUiDisplay);

describe('extension UI display state', () => {
  it('upserts and deletes status by session, runtime and key', () => {
    const state = fold([
      request('setStatus', { key: 'lint', text: 'running' }),
      request('setStatus', { key: 'lint', text: 'done' }),
      request('setStatus', { key: 'lint', text: 'other session' }, { sessionId: 's2' }),
    ]);
    expect(
      Object.values(state.statuses)
        .map((entry) => entry.text)
        .sort()
    ).toEqual(['done', 'other session']);

    const deleted = reduceExtensionUiDisplay(state, request('setStatus', { key: 'lint' }));
    expect(Object.values(deleted.statuses).map((entry) => entry.text)).toEqual(['other session']);
  });

  it('accepts only string widgets and preserves above/below placement', () => {
    const state = fold([
      request('setWidget', { key: 'a', content: ['one', 'two'] }),
      request('setWidget', {
        key: 'b',
        content: ['below'],
        options: { placement: 'belowEditor' },
      }),
      request('setWidget', { key: 'bad', content: [{ text: 'component' }] }),
    ]);
    expect(Object.values(state.widgets).map((entry) => [entry.key, entry.placement])).toEqual([
      ['a', 'aboveEditor'],
      ['b', 'belowEditor'],
    ]);
  });

  it('bounds widget lines, status text and per-runtime key counts', () => {
    const events: RuntimeEvent[] = [
      request('setStatus', { key: 'long', text: 'x'.repeat(2_000) }),
      request('setWidget', {
        key: 'long',
        content: Array.from({ length: 40 }, () => 'y'.repeat(800)),
      }),
    ];
    for (let index = 0; index < 20; index += 1) {
      events.push(request('setStatus', { key: `status-${index}`, text: String(index) }));
      events.push(request('setWidget', { key: `widget-${index}`, content: [String(index)] }));
    }
    const state = fold(events);
    expect(Object.values(state.statuses).every((entry) => entry.text.length < 2_000)).toBe(true);
    expect(Object.values(state.statuses)).toHaveLength(8);
    expect(Object.values(state.widgets)).toHaveLength(6);
    expect(Object.values(state.widgets).every((entry) => entry.lines.length <= 12)).toBe(true);
    expect(
      Object.values(state.widgets).every((entry) => entry.lines.every((line) => line.length <= 512))
    ).toBe(true);
  });

  it('aggregates unsupported methods inside one runtime and isolates another runtime', () => {
    const state = fold([
      request('unsupported', { method: 'setFooter' }),
      request('unsupported', { method: 'setFooter' }),
      request('unsupported', { method: 'setFooter' }, { runtimeId: 'r2' }),
    ]);
    expect(
      Object.values(state.unsupported)
        .map((entry) => entry.count)
        .sort()
    ).toEqual([1, 2]);
  });

  it('queues notifications once per wire request and lets the consumer acknowledge them', () => {
    const event = request(
      'notify',
      { message: 'Heads up', type: 'warning' },
      { uiRequestId: 'n1' }
    );
    const once = reduceExtensionUiDisplay(initialExtensionUiDisplay, event);
    const twice = reduceExtensionUiDisplay(once, event);
    expect(twice).toBe(once);
    expect(once.notifications[0]).toMatchObject({ message: 'Heads up', kind: 'warning' });
    expect(removeExtensionUiNotification(once, once.notifications[0]?.id ?? '')).toEqual({
      ...once,
      notifications: [],
    });
  });

  it('filters the permission plugin legacy extension-path migration warning', () => {
    const state = fold([
      request('notify', {
        message: "Legacy extension config found at '/bundled/config.json'. Move it elsewhere.",
        type: 'warning',
      }),
    ]);
    expect(state.notifications).toEqual([]);
  });

  it('delivers focused notifications as toast and only escalates background warnings/errors', () => {
    expect(extensionUiNotificationDelivery('info', true)).toBe('toast');
    expect(extensionUiNotificationDelivery('warning', true)).toBe('toast');
    expect(extensionUiNotificationDelivery('info', false)).toBe('wait');
    expect(extensionUiNotificationDelivery('warning', false)).toBe('os');
    expect(extensionUiNotificationDelivery('error', false)).toBe('os');
  });

  it('clears only the runtime named by an explicit reset', () => {
    const state = fold([
      request('setStatus', { key: 'a', text: 'old' }),
      request('setStatus', { key: 'a', text: 'new' }, { runtimeId: 'r2' }),
      request('unsupported', { method: 'setFooter' }),
    ]);
    const next = reduceExtensionUiDisplay(state, reset());
    expect(Object.values(next.statuses).map((entry) => entry.text)).toEqual(['new']);
    expect(next.unsupported).toEqual({});
    expect(clearExtensionUiRuntime(next, 's1', 'missing')).toBe(next);
  });

  it('prunes every display bucket when a session leaves the live tree', () => {
    const state = fold([
      request('setStatus', { key: 'a', text: 'keep' }, { sessionId: 'keep' }),
      request('setWidget', { key: 'b', content: ['drop'] }, { sessionId: 'drop' }),
      request('unsupported', { method: 'setFooter' }, { sessionId: 'drop' }),
      request('notify', { message: 'drop' }, { sessionId: 'drop' }),
    ]);
    const next = pruneExtensionUiDisplayState(state, ['keep']);
    expect(Object.values(next.statuses).map((entry) => entry.sessionId)).toEqual(['keep']);
    expect(next.widgets).toEqual({});
    expect(next.unsupported).toEqual({});
    expect(next.notifications).toEqual([]);
  });

  it('returns the same state for dialogs and unrelated events', () => {
    expect(
      reduceExtensionUiDisplay(
        initialExtensionUiDisplay,
        request('select', { title: 'x', options: ['a'] })
      )
    ).toBe(initialExtensionUiDisplay);
  });
});
