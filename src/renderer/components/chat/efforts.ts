/**
 * Reasoning-effort catalog for the Composer effort selector (T-20).
 *
 * Levels mirror the Agent SDK `EffortLevel` union, which #8 verified is a
 * TOP-LEVEL `query()` option (`Options.effort`) rather than
 * `output_config.effort` — see `spikes/c16-thinking-shape-probe.ts` scenario D.
 *
 * Availability is model-dependent and the SDK degrades rather than erroring:
 * `xhigh` needs Opus 4.7+/Sonnet 5/Fable 5 and silently falls back to `high`
 * elsewhere; `max` is select-models-only. So the catalog is not filtered per
 * model — a level that does not apply is downgraded by the SDK, and the Host
 * additionally drops any value it does not recognize (normalizeEffort).
 */

import type { SessionEffortLevel } from '@shared/types/agentHost';

export interface ChatEffort {
  id: SessionEffortLevel;
  label: string;
  /** Shown as the option's tooltip. */
  hint: string;
}

export const CHAT_EFFORTS: ChatEffort[] = [
  { id: 'low', label: 'Low', hint: 'Minimal thinking, fastest responses' },
  { id: 'medium', label: 'Medium', hint: 'Moderate thinking' },
  { id: 'high', label: 'High', hint: 'Deep reasoning (model default)' },
  { id: 'xhigh', label: 'X-High', hint: 'Deeper than High; needs Opus 4.7+ / Sonnet 5' },
  { id: 'max', label: 'Max', hint: 'Maximum effort; select models only' },
];

/**
 * Sentinel for "send no `effort` at all" so the model default applies.
 *
 * This is deliberately distinct from picking `high`: omitting the option lets
 * the model/CLI decide (and keeps behavior identical to pre-T-20 builds), while
 * an explicit `high` pins it. The Select needs a non-empty string value, hence
 * a sentinel rather than `null`.
 */
export const EFFORT_DEFAULT_ID = 'default';

export type EffortSelection = SessionEffortLevel | typeof EFFORT_DEFAULT_ID;

const EFFORT_IDS = new Set<string>(CHAT_EFFORTS.map((effort) => effort.id));

/** True when `value` is a level the SDK declares (excludes the sentinel). */
export function isEffortLevel(value: unknown): value is SessionEffortLevel {
  return typeof value === 'string' && EFFORT_IDS.has(value);
}

/**
 * Map a stored selection to the value to put on the wire: a real level, or
 * `undefined` to omit the field entirely.
 */
export function toWireEffort(selection: string | null | undefined): SessionEffortLevel | undefined {
  return isEffortLevel(selection) ? selection : undefined;
}

/** Label for a selection, including the sentinel. */
export function effortLabel(selection: string): string {
  return CHAT_EFFORTS.find((effort) => effort.id === selection)?.label ?? 'Default';
}
