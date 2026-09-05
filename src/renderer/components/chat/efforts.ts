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
 * file: `effortsForModel` offers the three levels every reasoning endpoint
 * accepts and requires the model to declare the four extremes in its
 * `thinkingLevelMap`.
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
 * The levels a reasoning model is assumed to accept without declaring anything.
 *
 * Everything outside this set — `off`, `minimal`, `xhigh`, `max` — is an
 * extreme that a given endpoint may simply not implement, so it has to be named
 * in the model's `thinkingLevelMap` before the selector offers it.
 *
 * This is deliberately stricter than Pi's own `getSupportedThinkingLevels`,
 * which assumes `off`/`minimal` work everywhere and only gates `xhigh`/`max`.
 * Measured counter-example (2026-09-05): a `reasoning: true` model with no map
 * at all, picked at `Minimal`, came back `502 host_call_failed: level "minimal"
 * not supported, valid levels: low, medium, high, xhigh, max` — and because Pi
 * considers `minimal` supported it never clamped, so the turn just retried the
 * same permanent error three times. A level nobody declared is a guess, and the
 * cost of guessing wrong is a failed turn.
 */
const ASSUMED_EFFORT_IDS = new Set<SessionEffortLevel>(['low', 'medium', 'high']);

/**
 * T25 model capability projection, tightened by the `minimal` 502 above.
 *
 * Three outcomes:
 *   - `reasoning === false` — no levels at all; the selector hides itself.
 *   - a level mapped to `null` — explicitly unsupported, dropped even if it is
 *     one of the assumed three.
 *   - anything else — offered when it is assumed, or when the map names it.
 *
 * A model with no metadata whatsoever (legacy/non-Pi) lands on the same rule
 * and shows the assumed three. It used to show all seven, which is how `off`
 * and `minimal` reached endpoints that reject them: our real catalog entries
 * carry `reasoning: true` and no map, so the "no map → whole list" branch was
 * the common case rather than the exception it reads as.
 */
export function effortsForModel(
  model: Pick<AgentModelOption, 'reasoning' | 'thinkingLevelMap'> | undefined
): ChatEffort[] {
  if (model?.reasoning === false) return [];
  const map = model?.thinkingLevelMap;
  return CHAT_EFFORTS.filter((effort) => {
    const mapped = map?.[effort.id];
    if (mapped === null) return false;
    return mapped !== undefined || ASSUMED_EFFORT_IDS.has(effort.id);
  });
}

/**
 * Fold a stored selection back onto what the model actually offers.
 *
 * `undefined` model means "no catalog entry" — the catalog has not loaded yet,
 * or this is a model the user typed that we cannot verify. That is not evidence
 * the level is wrong, and the caller writes the result straight back to the
 * session and agent-template stores, so treating unknown as unsupported would
 * quietly erase a legitimate `xhigh` during the frames before the catalog
 * arrives. Unknown keeps the selection; only a model we can read may drop it.
 */
export function reconcileEffortForModel(
  selection: string | null | undefined,
  model: Pick<AgentModelOption, 'reasoning' | 'thinkingLevelMap'> | undefined
): EffortSelection {
  if (!selection || selection === EFFORT_DEFAULT_ID) return EFFORT_DEFAULT_ID;
  if (!model) return isEffortLevel(selection) ? selection : EFFORT_DEFAULT_ID;
  return effortsForModel(model).some((effort) => effort.id === selection)
    ? (selection as SessionEffortLevel)
    : EFFORT_DEFAULT_ID;
}
