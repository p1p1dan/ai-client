/**
 * Decision 177 — the one sentence a model's automatic compaction is told in,
 * the same in the custom service's model settings panel and in the settings'
 * model list. The policy itself is the shared rule the DSH host configures
 * `compaction-basic` with (`@shared/dshAutoCompaction`).
 */

import { type AutoCompactionPolicy, autoCompactionPolicy } from '@shared/dshAutoCompaction';
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  plannedMaxTokens,
} from '@shared/dshModelPlan/tables';
import type { Translate } from '@shared/i18n';
import type { UserModelMeta } from '@shared/userProviders';

export interface AutoCompactionNote {
  tone: 'muted' | 'warning';
  text: string;
}

/**
 * `54k`, `1.2M`: the threshold is the engine's own estimate of a request, so
 * it is said round, as an approximation.
 */
export function formatApproxTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (tokens >= 10_000) return `${Math.round(tokens / 1_000)}k`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(tokens);
}

/**
 * The model settings panel's draft as the plan will size it: the route's
 * defaults for what is left empty, decision 146's cap on the output limit.
 */
export function draftAutoCompaction(
  meta: Pick<UserModelMeta, 'contextWindow' | 'maxTokens'>
): AutoCompactionPolicy | undefined {
  return autoCompactionPolicy({
    contextWindow: meta.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: plannedMaxTokens(meta.contextWindow, meta.maxTokens) ?? DEFAULT_MAX_TOKENS,
  });
}

/**
 * The sentence for one model. `contextWindowDefaulted`: the configuration
 * left the window out, so the figures are worked out on the default one.
 */
export function autoCompactionNote(
  policy: AutoCompactionPolicy,
  contextWindowDefaulted: boolean,
  t: Translate
): AutoCompactionNote {
  if (policy.auto) {
    const tokens = formatApproxTokens(policy.thresholdTokens);
    return {
      tone: 'muted',
      text: contextWindowDefaulted
        ? t(
            'Automatic compaction: starts at about {{tokens}} tokens (worked out on the default context window, {{window}}).',
            { tokens, window: policy.contextWindow }
          )
        : t('Automatic compaction: starts at about {{tokens}} tokens.', { tokens }),
    };
  }
  if (policy.reason === 'window_too_small') {
    return {
      tone: 'warning',
      text: t(
        'No automatic compaction for this model: its context window ({{window}}) is too small to leave room for it. A conversation that outgrows the window is still compacted and retried; for long tasks, pick a model with a larger window.',
        { window: policy.contextWindow }
      ),
    };
  }
  const params = {
    output: policy.maxTokens,
    window: policy.contextWindow,
    max: policy.maxOutputForAuto ?? 0,
  };
  return {
    tone: 'warning',
    text: contextWindowDefaulted
      ? t(
          'No automatic compaction for this model: the output limit ({{output}}) takes up too much of the default context window ({{window}}). Fill in the real context window, or set the output limit to {{max}} or less.',
          params
        )
      : t(
          'No automatic compaction for this model: the output limit ({{output}}) takes up too much of the context window ({{window}}). Set the output limit to {{max}} or less to turn it on.',
          params
        ),
  };
}
