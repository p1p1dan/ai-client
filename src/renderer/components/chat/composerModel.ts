/**
 * View-model for the merged model+effort composer control (T-30b2 拍板 ①,
 * round-4 addendum §3.2.2). Pure — the component (`ComposerModelTrigger.tsx`)
 * only assembles Base UI Menu primitives around what these two functions
 * return; model/effort persistence stays in `useSessionModel` /
 * `useSessionEffort`, untouched.
 *
 * Deliberately absent (addendum §2.2 pruning verdicts, F-A16c): no search
 * field (the catalog is 3–4 rows, a search box would imply a bigger one), no
 * Auto toggle (no routing capability), no per-row effort suffixes (effort is
 * per-SESSION here, not per-model — a suffix would claim a memory that does
 * not exist), no Options sub-panel (Thinking is a host capability gate, not a
 * user switch; Context has no protocol field; only Effort remains, inlined as
 * the second group).
 */

import { CHAT_EFFORTS, EFFORT_DEFAULT_ID, effortLabel, isEffortLevel } from './efforts';
import type { ChatModel } from './models';

export interface ComposerModelLabelParts {
  base: string;
  /** null when effort = Default — the trigger renders no suffix segment at all. */
  suffix: string | null;
}

/**
 * Split the trigger label into its dual-polarity parts: `Sonnet High ⌄` =
 * muted base + foreground/medium suffix. Default means "send no effort
 * field" on the wire, so it gets no visual suffix either — the absence IS
 * the semantics. Unknown effort strings fall back to themselves (never
 * throw, never collapse to "Default" — that would misreport the wire
 * behavior, F-A19).
 */
export function composerModelLabelParts(input: {
  modelLabel: string;
  effort: string;
}): ComposerModelLabelParts {
  if (input.effort === EFFORT_DEFAULT_ID) {
    return { base: input.modelLabel, suffix: null };
  }
  return {
    base: input.modelLabel,
    suffix: isEffortLevel(input.effort) ? effortLabel(input.effort) : input.effort,
  };
}

export interface ComposerModelMenuItem {
  id: string;
  label: string;
  /** Effort rows only — passed through to `title` for the tooltip. */
  hint?: string;
  selected: boolean;
}

export interface ComposerModelMenuSection {
  id: 'model' | 'effort';
  label: string;
  items: ComposerModelMenuItem[];
}

/**
 * The two fixed menu sections: Model (3–4 rows, from `ensureModelOptions` —
 * a host-foreign default is prepended by the caller and must survive,
 * F-A16b) then Reasoning effort (always 6: Default + the 5 levels). Section
 * order is hard-coded (F-A16). A garbage stored effort marks Default
 * selected so the radio group is never checkless.
 */
export function composerModelMenuModel(input: {
  options: readonly ChatModel[];
  selectedModel: string;
  selectedEffort: string;
}): { sections: ComposerModelMenuSection[] } {
  const effortIsLevel = isEffortLevel(input.selectedEffort);
  return {
    sections: [
      {
        id: 'model',
        label: 'Model',
        items: input.options.map((option) => ({
          id: option.id,
          label: option.label,
          selected: option.id === input.selectedModel,
        })),
      },
      {
        id: 'effort',
        label: 'Reasoning effort',
        items: [
          {
            id: EFFORT_DEFAULT_ID,
            label: 'Default',
            selected: !effortIsLevel,
          },
          ...CHAT_EFFORTS.map((effort) => ({
            id: effort.id,
            label: effort.label,
            hint: effort.hint,
            selected: effortIsLevel && effort.id === input.selectedEffort,
          })),
        ],
      },
    ],
  };
}
