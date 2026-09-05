import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyRuntimeEventToGates,
  isTierControlDegraded,
  resetPermissionGateWatchForTests,
  usePermissionGateStore,
} from '../permissionGate';

/**
 * D10 explicit degradation.
 *
 * The distinction the whole feature rests on is three-valued, not boolean:
 * reported-bundled, reported-user_configured, and NOT REPORTED. Collapsing the
 * third into either of the first two is the bug — one direction claims the
 * tiers work before any worker has said so, the other cries degradation on
 * every session that has not started yet.
 */

const event = (over: Partial<RuntimeEvent> = {}): RuntimeEvent =>
  ({
    type: 'session.created',
    seq: 1,
    timestamp: 0,
    sessionId: 's1',
    payload: { permissionGate: 'user_configured' },
    ...over,
  }) as RuntimeEvent;

beforeEach(() => {
  resetPermissionGateWatchForTests();
});

describe('applyRuntimeEventToGates', () => {
  it('records the gate a session.created event reports', () => {
    applyRuntimeEventToGates(event());
    expect(usePermissionGateStore.getState().gates.s1).toBe('user_configured');
  });

  it('records it from session.resumed too — a restored session is the common case', () => {
    applyRuntimeEventToGates(event({ type: 'session.resumed' }));
    expect(usePermissionGateStore.getState().gates.s1).toBe('user_configured');
  });

  it('ignores events that carry no gate, leaving the session unknown', () => {
    applyRuntimeEventToGates(event({ payload: { runtimeIdentity: '/x.jsonl' } }));
    expect(usePermissionGateStore.getState().gates.s1).toBeUndefined();
  });

  it('ignores a gate value this build does not recognise', () => {
    applyRuntimeEventToGates(event({ payload: { permissionGate: 'something-new' } } as never));
    expect(usePermissionGateStore.getState().gates.s1).toBeUndefined();
  });

  it('ignores unrelated event types', () => {
    applyRuntimeEventToGates(event({ type: 'session.status' }));
    expect(usePermissionGateStore.getState().gates.s1).toBeUndefined();
  });

  it('keeps sessions apart', () => {
    applyRuntimeEventToGates(event());
    applyRuntimeEventToGates(event({ sessionId: 's2', payload: { permissionGate: 'bundled' } }));
    expect(usePermissionGateStore.getState().gates).toEqual({
      s1: 'user_configured',
      s2: 'bundled',
    });
  });

  it('lets a rebuilt worker correct an earlier verdict', () => {
    applyRuntimeEventToGates(event({ payload: { permissionGate: 'bundled' } }));
    applyRuntimeEventToGates(event({ payload: { permissionGate: 'user_configured' } }));
    expect(usePermissionGateStore.getState().gates.s1).toBe('user_configured');
  });
});

describe('isTierControlDegraded', () => {
  it('is true only for a reported user_configured gate', () => {
    expect(isTierControlDegraded({ s1: 'user_configured' }, 's1')).toBe(true);
  });

  it('is false for bundled and — critically — for not yet reported', () => {
    expect(isTierControlDegraded({ s1: 'bundled' }, 's1')).toBe(false);
    expect(isTierControlDegraded({}, 's1')).toBe(false);
    expect(isTierControlDegraded({ other: 'user_configured' }, 's1')).toBe(false);
  });
});

describe('forgetSession', () => {
  it('drops one session without disturbing the rest', () => {
    applyRuntimeEventToGates(event());
    applyRuntimeEventToGates(event({ sessionId: 's2', payload: { permissionGate: 'bundled' } }));
    usePermissionGateStore.getState().forgetSession('s1');
    expect(usePermissionGateStore.getState().gates).toEqual({ s2: 'bundled' });
  });
});
