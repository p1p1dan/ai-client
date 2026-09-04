/**
 * Thinking-level catalog for the Composer effort selector (T-20, widened by
 * U08-2).
 *
 * Levels are Pi's `ThinkingLevel` union in Pi's own ascending order, sourced
 * from `SESSION_EFFORT_LEVELS` rather than restated — a second list of the
 * words is how `off`/`minimal` stayed invisible in the UI while the config
 * layer had supported them all along.
 *
 * Availability is model-dependent and comes from the catalog, not from this
 * file: `effortsForModel` keeps only levels the model's `thinkingLevelMap`
 * maps to something non-null. A model with no metadata (legacy/non-Pi) shows
 * the full list, and the worker drops any value it cannot apply.
 *
 * Hints are deliberately provider-neutral. The pre-U08-2 copy named Claude
 * model families as the gate for `xhigh`, which is wrong under Pi: the gate is
 * whatever the model's `thinkingLevelMap` declares, for any provider.
 */

import type { AgentModelOption } from '@shared/types/agentCatalog';
import { SESSION_EFFORT_LEVELS, type SessionEffortLevel } from '@shared/types/agentHost';

export interface ChatEffort {
  id: SessionEffortLevel;
  label: string;
  /** Shown as the option's tooltip. */
  hint: string;
}

/**
 * UI copy per level, keyed by the wire vocabulary so the compiler rejects a
 * level that has no label — the catalog below cannot silently omit one.
 */
const EFFORT_COPY: Record<SessionEffortLevel, { label: string; hint: string }> = {
  off: { label: 'Off', hint: 'No reasoning at all' },
  minimal: { label: 'Minimal', hint: 'Barely any reasoning; fastest responses' },
  low: { label: 'Low', hint: 'Light reasoning' },
  medium: { label: 'Medium', hint: 'Moderate reasoning; Pi applies this by default' },
  high: { label: 'High', hint: 'Deep reasoning' },
  xhigh: { label: 'X-High', hint: 'Deeper than High; only on models that declare it' },
  max: { label: 'Max', hint: 'Maximum reasoning; only on models that declare it' },
};

/** Order and membership come from the wire union, never from a second list. */
export const CHAT_EFFORTS: ChatEffort[] = SESSION_EFFORT_LEVELS.map((id) => ({
  id,
  ...EFFORT_COPY[id],
}));

/**
 * Sentinel for "send no `effort` at all" so the model default applies.
 *
 * This is deliberately distinct from picking `high`: omitting the option lets
 * the model/CLI decide (and keeps behavior identical to pre-T-20 builds), while
 * an explicit `high` pins it. The Select needs a non-empty string value, hence
 * a sentinel rather than `null`.
 *
 * U08-2 added a level this must NOT be confused with: `off` is a real Pi
 * `ThinkingLevel` that pins reasoning off, and it travels on the wire like any
 * other level. `default` sends nothing and lets Pi apply its own default
 * (currently `medium`) — so the two produce opposite behavior, and only one of
 * them is a member of `CHAT_EFFORTS`.
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
 *
 * `off` goes on the wire as `'off'` — it is a level. Only the `default`
 * sentinel, an empty selection, and values this build does not recognize
 * produce `undefined`. Both callers spread the result (`...(effort ? {...})`),
 * and every level word is truthy, so a level can never be dropped by the
 * spread the way an empty string would be.
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
 * see the whole catalog. Pi may explicitly disable reasoning or provide a
 * thinkingLevelMap; when the map is present, only non-null mapped levels are
 * declared supported — including `off` and `minimal`, which the map has always
 * been able to express even while the UI catalog stopped at five (U08-2).
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
