/**
 * Which permission system each session's worker actually came up on.
 *
 * Reads `session.created` / `session.resumed`'s `permissionGate`, and says the
 * same thing that field's own note in `@shared/types/runtimeEvents` says.
 *
 * ## What it used to mean, and what it means now
 *
 * The tiers were once a link in a pi permission extension's `authorizerChain`,
 * shipped in the `config.json` next to our bundled copy. An agent dir that
 * already declared `@gotgenes/pi-permission-system` made the worker skip
 * injecting ours (two live copies = two prompts per tool call), which left the
 * picker offering four tiers that all behaved like the user's own policy — an
 * invisible failure, and the reason this store exists (D10 — explicit
 * degradation).
 *
 * T025 / T026: that arrangement is gone. Nothing has injected a pi permission
 * extension since P6-5; every decision is made by
 * `src/runtime/plugins/permissions/` whatever the user has installed, and the
 * native runtime reports `bundled` unconditionally. A pi permission extension
 * a user installs now reaches the built-in Pi TERMINAL only — which the plugins
 * page states in words (`PiPluginsSettings`) rather than through this gate. So
 * `user_configured` has no producer left, and the degraded branch this store
 * feeds is unreachable by construction rather than merely unlikely.
 *
 * Kept, not deleted, because the wire field is optional and cross-version: a
 * Host that does send `user_configured` must still be reported honestly rather
 * than read as `bundled`.
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
  sessionId: string | null
): boolean {
  // U29: `null` is "no chat yet", and a gate is a fact a running worker
  // reported. Nothing has reported, so nothing is degraded — the control shows
  // the ordinary tiers, which is also what the chat it is about to create will
  // get unless that chat's own bootstrap says otherwise.
  if (!sessionId) return false;
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
