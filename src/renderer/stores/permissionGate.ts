/**
 * Which permission system each session's worker actually came up on.
 *
 * The tiers (`readonly` / `pragmatic` / `handsoff` / `fullopen`) are implemented
 * as a link in the permission plugin's `authorizerChain`, and that line lives in
 * the `config.json` we ship next to our BUNDLED copy of the plugin. When the
 * user's own agentDir already declares `@gotgenes/pi-permission-system`, the
 * worker deliberately does not inject our copy (writing to the user's `~/.pi` is
 * a standing red line) — so their config is the one in force, it has no
 * `authorizerChain: ['aiclient-session-tier']`, and our link is registered but
 * never consulted. Every tier then behaves exactly like their own policy.
 *
 * That failure is invisible: the picker still lists four tiers and still lets
 * you pick one. This store exists so the picker can stop making a promise the
 * runtime is not keeping (D10 — explicit degradation).
 *
 * A separate store rather than a field on `ChatSession`: `chatSessions.ts` is a
 * red-line file, and nothing here needs to be in it — this is read by exactly
 * one control, and it is derived from the runtime, not from user intent.
 */

import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import { create } from 'zustand';
import { subscribeRuntimeEvent } from './runtimeEventBus';

export type PermissionGate = 'bundled' | 'user_configured';

export interface PermissionGateState {
  /**
   * Keyed by sessionId. Absent means "no worker has reported yet" — which is
   * NOT the same as `bundled`, and the UI must not render a verdict for it.
   */
  gates: Record<string, PermissionGate>;
  noteGate: (sessionId: string, gate: PermissionGate) => void;
  forgetSession: (sessionId: string) => void;
}

export const usePermissionGateStore = create<PermissionGateState>()((set) => ({
  gates: {},

  noteGate: (sessionId, gate) =>
    set((state) => {
      if (state.gates[sessionId] === gate) return state;
      return { gates: { ...state.gates, [sessionId]: gate } };
    }),

  forgetSession: (sessionId) =>
    set((state) => {
      if (!(sessionId in state.gates)) return state;
      const { [sessionId]: _dropped, ...rest } = state.gates;
      return { gates: rest };
    }),
}));

/** True only when a worker has reported, and reported the degraded gate. */
export function isTierControlDegraded(
  gates: Record<string, PermissionGate>,
  sessionId: string
): boolean {
  return gates[sessionId] === 'user_configured';
}

/**
 * Fold one runtime event into the store. Exported for tests; app code installs
 * the subscription through `startPermissionGateWatch`.
 */
export function applyRuntimeEventToGates(event: RuntimeEvent): void {
  if (event.type !== 'session.created' && event.type !== 'session.resumed') return;
  const gate = event.payload?.permissionGate;
  if (gate !== 'bundled' && gate !== 'user_configured') return;
  if (!event.sessionId) return;
  usePermissionGateStore.getState().noteGate(event.sessionId, gate);
}

let stop: (() => void) | null = null;

/**
 * Subscribe once, for the life of the window. Idempotent: a second call returns
 * the same teardown rather than installing a second listener, which would make
 * every event apply twice.
 */
export function startPermissionGateWatch(): () => void {
  if (!stop) {
    const unsubscribe = subscribeRuntimeEvent((event) => applyRuntimeEventToGates(event));
    stop = () => {
      unsubscribe();
      stop = null;
    };
  }
  return stop;
}

/** Test seam — drops the subscription without touching the bus's own teardown. */
export function resetPermissionGateWatchForTests(): void {
  stop = null;
  usePermissionGateStore.setState({ gates: {} });
}
