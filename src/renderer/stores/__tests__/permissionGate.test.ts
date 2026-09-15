import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

/**
 * T025 / T026 — the store's note and the wire field's note must say one thing.
 *
 * The behaviour above is unchanged and correct; what went stale is the reason
 * it exists. The module used to explain that a worker "deliberately does not
 * inject ours" when the agent directory already declared
 * `@gotgenes/pi-permission-system`, leaving the user's own policy in force.
 * Nothing has injected a pi permission extension since P6-5, and the native
 * runtime reports `bundled` unconditionally, so a reader who took that note at
 * face value would go looking for a handover that cannot happen.
 *
 * T025 rewrote the shared-type half and T026 the renderer half; these checks
 * are what stop the two from drifting apart again, and what pins the producer
 * claim they both rest on.
 */
describe('permission gate notes and their producer', () => {
  const read = (...parts: string[]) =>
    readFileSync(join(__dirname, '..', '..', '..', ...parts), 'utf8');
  // Only the module docblock — everything before the first import. An import
  // line names the other module too, and an assertion a bare `import` already
  // satisfies would pass however the prose drifts.
  const note = (source: string) => source.slice(0, source.indexOf('\nimport '));
  const store = note(read('renderer', 'stores', 'permissionGate.ts'));
  const wire = read('shared', 'types', 'runtimeEvents.ts');
  const native = read('runtime', 'worker', 'nativeWorkerRuntime.ts');

  it('the native runtime is the producer, and it only ever says bundled', () => {
    expect(native).toContain("permissionGate: 'bundled'");
    expect(native).not.toContain('user_configured');
  });

  it('each note points at the other, so neither can be updated alone', () => {
    expect(store).toContain('@shared/types/runtimeEvents');
    expect(wire).toContain('stores/permissionGate.ts');
  });

  it('neither still describes the injection handover in the present tense', () => {
    // Recounting the history is fine and useful; the sentence that has to be
    // gone is the one that said it is what happens now.
    for (const source of [store, wire]) {
      expect(source).not.toContain('the worker deliberately does not inject ours');
      expect(source).not.toContain('Their config is then the one in force');
    }
  });

  it('the renderer note says where an installed permission extension does reach', () => {
    expect(store).toMatch(/built-in Pi TERMINAL|built-in terminal/);
  });
});
