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

import type { AgentModelOption } from '@shared/types/agentCatalog';
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
 * True for anything the effort selector may legitimately hold: one of the five
 * measured levels, or the `Default` sentinel.
 *
 * This is the vocabulary the STORAGE layer enforces (B10). It is derived from
 * `CHAT_EFFORTS` rather than spelled out again, because a second copy of the
 * five words is exactly how a layer ends up accepting a level the wire will
 * later drop — the divergence B10 counts layers to prevent.
 */
export function isEffortSelection(value: unknown): value is EffortSelection {
  return value === EFFORT_DEFAULT_ID || isEffortLevel(value);
}

/**
 * The effort selection for one (session, agent): this pair's own choice, then
 * this agent's template, then nothing chosen at all.
 *
 * D48 S2 §4.3's priority chain, model-side twin `resolveModelSelection`. It is
 * a function rather than three inline `??` chains because it had already drifted
 * into two different answers: the send path and the trigger both fell back to
 * the agent template while the Context surface read only the session's own
 * value, so a session running on a template `high` reported "no effort
 * configured" on the mirror while the wire carried `effort:'high'` — the same
 * mirror≠wire split A06 pins for the model row.
 *
 * Returns `null`, not the sentinel: "nothing chosen" and an explicit `Default`
 * are the same thing on the wire but not in a UI, and the caller decides which
 * of the two it is showing.
 */
export function resolveEffortSelection(
  storedEffort: string | null | undefined,
  agentTemplateEffort: string | null | undefined
): string | null {
  for (const candidate of [storedEffort, agentTemplateEffort]) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate;
  }
  return null;
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

/**
 * T25 model capability projection. Legacy/non-Pi options have no metadata and
 * retain the existing five-level behavior. Pi may explicitly disable reasoning
 * or provide a thinkingLevelMap; when the map is present, only non-null mapped
 * levels are declared supported.
 */
export function effortsForModel(
  model: Pick<AgentModelOption, 'reasoning' | 'thinkingLevelMap'> | undefined
): ChatEffort[] {
  if (!model || (model.reasoning === undefined && !model.thinkingLevelMap)) {
    return CHAT_EFFORTS;
  }
  if (model.reasoning === false) return [];
  if (!model.thinkingLevelMap) return CHAT_EFFORTS;
  return CHAT_EFFORTS.filter((effort) => model.thinkingLevelMap?.[effort.id] != null);
}

export function reconcileEffortForModel(
  selection: string | null | undefined,
  model: Pick<AgentModelOption, 'reasoning' | 'thinkingLevelMap'> | undefined
): EffortSelection {
  if (!selection || selection === EFFORT_DEFAULT_ID) return EFFORT_DEFAULT_ID;
  return effortsForModel(model).some((effort) => effort.id === selection)
    ? (selection as SessionEffortLevel)
    : EFFORT_DEFAULT_ID;
}
