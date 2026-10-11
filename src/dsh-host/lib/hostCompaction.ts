/**
 * Decision 177: each model's automatic compaction, handed to DSH's
 * `compaction-basic` row as its `modelPolicies` (dsh-compaction-basic
 * 0.1.7-rc.2: one exact provider/model override per entry).
 *
 * The policies come from the model plan Main sent (`configure`), sized the way
 * `llm-pi-ai` is (`llmPiAiProviders`), through the shared rules
 * (src/shared/dshAutoCompaction.ts) the settings show. host.ts adds them to the
 * row's config as every layer before the launch overlays left it: an id patch
 * replaces a row's whole config, so the keys a layer set are carried over
 * (the probe bundle's `auto` switch), and a layer that tunes the thresholds
 * itself keeps the row as it is. The plan is fixed at boot and a new plan
 * restarts the host (decisions 033, 159), so this runs once per revision.
 *
 * Bundled into host.js with host.ts (scripts/build-dsh-host.mjs).
 */

import {
  type AutoCompactionOverride,
  type AutoCompactionPolicy,
  autoCompactionOverride,
  autoCompactionPolicy,
} from '../../shared/dshAutoCompaction.ts';
import { type HostModelPlan, llmPiAiProviders } from './hostModelPlan.ts';

/** dsh-base's row id for the compaction backend. */
export const COMPACTION_ROW = 'compaction-basic';

/** One `modelPolicies` entry. */
export interface CompactionModelPolicy extends AutoCompactionOverride {
  provider: string;
  model: string;
}

/** One routed model and its policy (undefined: sizes no rule applies to). */
export interface PlannedCompaction {
  provider: string;
  model: string;
  policy: AutoCompactionPolicy | undefined;
}

/** Every model of the plan, in route and model order, with its policy. */
export function planAutoCompaction(plan: Pick<HostModelPlan, 'routes'>): PlannedCompaction[] {
  const planned: PlannedCompaction[] = [];
  for (const [provider, route] of Object.entries(llmPiAiProviders(plan))) {
    for (const model of route.models) {
      planned.push({
        provider,
        model: model.id,
        policy:
          model.contextWindow === undefined || model.maxTokens === undefined
            ? undefined
            : autoCompactionPolicy({
                contextWindow: model.contextWindow,
                maxTokens: model.maxTokens,
              }),
      });
    }
  }
  return planned;
}

/** The row's `modelPolicies`: only the models DSH's own defaults do not already serve. */
export function compactionModelPolicies(
  planned: readonly PlannedCompaction[]
): CompactionModelPolicy[] {
  return planned.flatMap(({ provider, model, policy }) => {
    const override = policy && autoCompactionOverride(policy);
    return override ? [{ provider, model, ...override }] : [];
  });
}

/**
 * Keys of the row's config these policies keep and leave alone: none of them
 * moves a threshold or a summary cap. Any other key means a layer tunes the
 * row itself, and then the row is left as that layer composed it.
 */
const KEPT_KEYS: ReadonlySet<string> = new Set([
  'auto',
  'summarizationProvider',
  'summarizationModel',
  'compactionRetries',
  'maxOverflowRetries',
]);

export interface ComposedRow {
  id?: unknown;
  disabled?: unknown;
  config?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A row of a composed entry list by id, group children (`config.initial`) included. */
export function findComposedRow(entries: readonly unknown[], id: string): ComposedRow | undefined {
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    if (entry.id === id) return entry;
    const nested = isRecord(entry.config) ? entry.config.initial : undefined;
    if (Array.isArray(nested)) {
      const found = findComposedRow(nested, id);
      if (found) return found;
    }
  }
  return undefined;
}

export type CompactionOverlay =
  | {
      kind: 'overlay';
      overlay: { id: string; config: Record<string, unknown> };
      /** How many `modelPolicies` entries it carries. */
      policies: number;
    }
  /** Every model is served by DSH's own defaults: nothing to add. */
  | { kind: 'none' }
  | { kind: 'skipped'; reason: string };

/** The launch overlay for the row as the layers composed it, or why there is none. */
export function autoCompactionOverlay(
  row: ComposedRow | undefined,
  policies: readonly CompactionModelPolicy[]
): CompactionOverlay {
  if (policies.length === 0) return { kind: 'none' };
  if (!row) return { kind: 'skipped', reason: `the composition has no ${COMPACTION_ROW} row` };
  if (row.disabled === true) return { kind: 'skipped', reason: `the ${COMPACTION_ROW} row is off` };
  const config = row.config ?? {};
  if (!isRecord(config) || '__jsExpr' in config) {
    return { kind: 'skipped', reason: `the ${COMPACTION_ROW} config is an expression` };
  }
  const tuned = Object.keys(config).filter((key) => !KEPT_KEYS.has(key));
  if (tuned.length > 0) {
    return { kind: 'skipped', reason: `a layer already sets ${tuned.sort().join(', ')}` };
  }
  return {
    kind: 'overlay',
    overlay: {
      id: COMPACTION_ROW,
      config: { ...config, modelPolicies: policies.map((policy) => ({ ...policy })) },
    },
    policies: policies.length,
  };
}

const OFF_WORDS: Record<string, string> = {
  window_too_small: 'window too small',
  output_too_large: 'output limit too large',
};

/** One model as the log names it: sizes, then the threshold or why there is none. */
function describeModel({ provider, model, policy }: PlannedCompaction): string {
  const name = `${provider}/${model}`;
  if (!policy) return `${name} unsized`;
  const sizes = `${policy.contextWindow}/${policy.maxTokens}`;
  const summary =
    autoCompactionOverride(policy)?.maxTokens === undefined
      ? ''
      : ` summary ${policy.summaryMaxTokens}`;
  if (!policy.auto) {
    const fix =
      policy.maxOutputForAuto === undefined ? '' : `; on with output <= ${policy.maxOutputForAuto}`;
    return `${name} ${sizes} off (${OFF_WORDS[policy.reason] ?? policy.reason}${fix})${summary}`;
  }
  const headroom = policy.headroomLowered ? ` headroom ${policy.headroomTokens}` : '';
  return `${name} ${sizes} at ${policy.thresholdTokens}${headroom}${summary}`;
}

/** Room for one line of the host's stderr, which Main cuts at 2000 characters. */
const LINE_BUDGET = 1600;

/**
 * The log line(s) for this plan: every model's sizes and threshold (or why
 * none), what is not DSH's default, and how the overlay went. Split into
 * numbered lines only when one would not fit.
 */
export function describeAutoCompaction(
  revision: string,
  planned: readonly PlannedCompaction[],
  outcome: CompactionOverlay
): string[] {
  const off = planned.filter(({ policy }) => policy && !policy.auto).length;
  const lowered = planned.filter(({ policy }) => policy?.auto && policy.headroomLowered).length;
  const applied =
    outcome.kind === 'overlay'
      ? `${outcome.policies} model policies`
      : outcome.kind === 'none'
        ? "DSH's defaults"
        : `not applied: ${outcome.reason}`;
  const head = `auto compaction, plan ${revision.slice(0, 12)} (${planned.length} models, ${lowered} headroom lowered, ${off} off; ${applied})`;
  const items = planned.map(describeModel);
  if (items.length === 0) return [`${head}: no model`];
  const chunks: string[][] = [[]];
  let length = 0;
  for (const item of items) {
    const current = chunks[chunks.length - 1] as string[];
    if (current.length > 0 && length + item.length + 2 > LINE_BUDGET) {
      chunks.push([item]);
      length = item.length;
    } else {
      current.push(item);
      length += item.length + 2;
    }
  }
  return chunks.map((chunk, index) =>
    chunks.length === 1
      ? `${head}: ${chunk.join('; ')}`
      : `${head} [${index + 1}/${chunks.length}]: ${chunk.join('; ')}`
  );
}
