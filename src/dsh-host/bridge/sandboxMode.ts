/**
 * The one point where a session's permission posture maps onto DSH's sandbox
 * (dsh-rebase decision 044; P1-6c leaves the hook, P1-6e fills it in).
 *
 * Today the product bundle pins `sandbox-policy` to `danger-full-access` on
 * every platform (decisions 044, 045) and the bridge is given no
 * `applySandboxMode`, so nothing is ever written and the gate is the only
 * approval a call meets. The table below is the overlay decision 044 rule 2
 * describes for when the switch exists; P1-6e supplies the writer (a
 * `sandbox/mode` event on the session) behind a setting that is off by
 * default.
 */

import type { RuntimePermissionSettings } from '../../shared/types/runtimePermission.ts';

/** DSH's sandbox modes (`@deepseek-ai/dsh-sandbox-policy`). */
export type DshSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

/** Writes one session's sandbox mode; the bridge calls it after every posture change. */
export type ApplySandboxMode = (dshSessionId: string, mode: DshSandboxMode) => void;

/**
 * Decision 044 rule 2: plan reads only; bypass asks for nothing, so the
 * sandbox asks for nothing either; every other gear writes the workspace.
 */
export function dshSandboxModeFor(settings: RuntimePermissionSettings): DshSandboxMode {
  if (settings.mode === 'plan') return 'read-only';
  return settings.gear === 'bypass' ? 'danger-full-access' : 'workspace-write';
}
