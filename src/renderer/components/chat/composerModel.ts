/**
 * T-30b2: pure layer for the merged model + reasoning-effort control.
 *
 * The Composer used to carry two separate `Select`s side by side (`Sonnet ⌄`
 * and `Default ⌄`). They are now one trigger reading `Sonnet High ⌄` backed by
 * a single menu with two radio sections. This module only decides how those two
 * independent selections are presented as one label and one list.
 *
 * D48 S2 moved the model catalog out from under it: `options` now arrives from
 * the proxy by way of `models.ts`'s `modelOptionsFor`, so the list is whatever
 * the gateway offers after family filtering plus the `Automatic` row, instead of
 * three hard-coded short names. The effort catalog still comes from `efforts.ts`
 * (one shared five-level vocabulary on both axes), and nothing here knows which
 * agent is running — everything agent-shaped is resolved before it gets here.
 *
 * Kept free of React so it is testable under the repo's node-env vitest.
 */

import {
  CHAT_EFFORTS,
  type ChatEffort,
  EFFORT_DEFAULT_ID,
  effortLabel,
  isEffortLevel,
} from './efforts';
import type { ChatModel } from './models';

// ---- Trigger label ----

export interface ComposerModelLabelParts {
  /** The model name — always rendered. */
  base: string;
  /** The effort suffix, or null when there is nothing to append. */
  suffix: string | null;
}

/**
 * Split the merged trigger's label into its two differently-styled halves.
 *
 * `default` produces no suffix at all, and that is the point rather than a
 * cosmetic choice: the sentinel means "send no `effort` field", so the model's
 * own default applies. A trigger reading `Sonnet Default` would claim a level
 * was pinned when the wire carries none — showing just `Sonnet` is the visual
 * form of that protocol semantics (`toWireEffort` returns `undefined` for the
 * same input).
 *
 * A level this build does not know is echoed back verbatim instead of being
 * flattened to `Default` by `effortLabel`'s fallback. Two things can produce
 * one: a newer Host, or a stored selection from a future build. Both are cases
 * where "show what is actually set" beats "show a level that is not set".
 */
export function composerModelLabelParts(input: {
  modelLabel: string;
  effort?: string | null;
}): ComposerModelLabelParts {
  const base = input.modelLabel;
  const effort = input.effort;
  if (!effort || effort === EFFORT_DEFAULT_ID) {
    return { base, suffix: null };
  }
  if (isEffortLevel(effort)) {
    return { base, suffix: effortLabel(effort) };
  }
  return { base, suffix: effort };
}

// ---- Menu view model ----

export interface ComposerMenuItem {
  id: string;
  label: string;
  /** Tooltip text, present only for effort levels that ship one. */
  hint?: string;
  selected: boolean;
  /**
   * D48 S2 §4.4: `false` on a row this build could not corroborate against the
   * live catalog — a legacy short name, or a stored full name the family
   * whitelist filters out. Absent on ordinary rows and on `Automatic`.
   *
   * It changes NOTHING about how the row behaves: it is still selectable, still
   * checked, and still leaves the composer on the wire byte-for-byte. The flag
   * is what lets the label say so.
   */
  verified?: boolean;
  tags?: string[];
  reasoning?: boolean;
  thinkingLevelMap?: ChatModel['thinkingLevelMap'];
}

export interface ComposerMenuSection {
  id: 'model' | 'effort';
  label: string;
  items: ComposerMenuItem[];
}

export interface ComposerModelMenuViewModel {
  sections: ComposerMenuSection[];
}

/**
 * Build the merged menu: one radio section per catalog, model first.
 *
 * Section order is fixed rather than configurable — the trigger reads
 * "{model} {effort}", so a menu that listed effort first would put the two in
 * opposite orders on the same control.
 *
 * The effort section leads with the `default` sentinel and then the five real
 * levels — six rows, seven when a stored level this build does not know has to
 * be carried in front of them (see below). It is not filtered per model:
 * the SDK degrades a level a model does not support rather than erroring, and
 * the Host drops values it does not recognise, so a per-model filter here
 * would be this renderer guessing at availability it cannot observe.
 *
 * Deliberately NOT modelled, each because the capability behind it does not
 * exist here (a control for a capability we do not have is a lie about the
 * product, not a UI detail):
 *  - a search field — the family-filtered catalog is a handful of entries
 *    (§4.3-5 pins that: no search, no virtualisation). A search box would imply
 *    a larger catalog exists.
 *  - an `Auto` routing toggle — there is no automatic model routing.
 *  - a per-row effort suffix — effort is per SESSION here, not per model, so
 *    annotating each row would claim per-model memory that does not exist.
 *  - `Thinking` / `Context` sub-panels — thinking is a Host capability gate
 *    rather than a user switch, and there is no context-window field in the
 *    protocol.
 */
export function composerModelMenuModel(input: {
  options: readonly ChatModel[];
  selectedModel: string | null;
  selectedEffort: string | null;
  /**
   * D48 S2 §4.4-1/§4.4-6: what to call the prepended row when the selection is
   * not in `options`. Defaults to the raw id, which is what the pre-D48 build
   * did and what an unknown EFFORT level still does one section down.
   *
   * It is passed in rather than computed here because the two spellings the
   * spec asks for (`Sonnet (legacy alias)` vs `gpt-5.5 · unverified`) depend on
   * which agent is running the session, and this module deliberately knows
   * nothing about agents.
   */
  unknownModelLabel?: string;
  /** T25 model-declared levels; defaults to the legacy shared catalog. */
  efforts?: readonly ChatEffort[];
}): ComposerModelMenuViewModel {
  const { options } = input;
  const efforts = input.efforts ?? CHAT_EFFORTS;

  // A stored selection outside the catalog is PREPENDED as its own row rather
  // than redirecting the check mark to `options[0]`. D48 S2 made this the ONLY
  // mechanism that carries such a value: the pre-D48 sibling that prepended an
  // unrecognised Host default was deleted along with its "unrecognised therefore
  // legal" rule, and the family whitelist now filters the catalog down to a
  // handful of ids, so legacy short names and superseded full names land here in
  // ordinary use rather than as a curiosity. The old fallback marked a row the
  // session is not actually on:
  // the trigger label and every send/resume call read the raw stored value, so
  // the menu was the only surface claiming a different model — a menu that
  // lies about the current selection is worse than a menu with nothing marked,
  // because the user's next click "confirms" a value they never chose. The
  // rule the fallback protected ("exactly one row is always marked") still
  // holds; it is now satisfied by widening the list instead of moving the mark.
  const selectedModel = input.selectedModel;
  const modelInCatalog = options.some((option) => option.id === selectedModel);
  // `null` is the one case with nothing to prepend — it means no selection is
  // stored at all, not that an unrecognised one is, so the first option keeps
  // the mark and no phantom row is invented.
  const unknownModel = selectedModel && !modelInCatalog ? selectedModel : null;
  const effectiveModel =
    unknownModel ?? (modelInCatalog ? selectedModel : (options[0]?.id ?? null));

  const selectedEffort = input.selectedEffort;
  const capabilityScoped = input.efforts !== undefined;
  const selectedEffortSupported =
    isEffortLevel(selectedEffort) && efforts.some((effort) => effort.id === selectedEffort);
  const unknownEffort =
    !capabilityScoped &&
    selectedEffort &&
    selectedEffort !== EFFORT_DEFAULT_ID &&
    !isEffortLevel(selectedEffort)
      ? selectedEffort
      : null;
  const effectiveEffort = selectedEffortSupported
    ? selectedEffort
    : (unknownEffort ?? EFFORT_DEFAULT_ID);

  const modelItems: ComposerMenuItem[] = [
    ...(unknownModel
      ? [
          {
            id: unknownModel,
            label: input.unknownModelLabel ?? unknownModel,
            selected: true,
            verified: false,
          },
        ]
      : []),
    ...options.map((option) => ({
      id: option.id,
      label: option.label,
      selected: option.id === effectiveModel,
      ...(option.verified === undefined ? {} : { verified: option.verified }),
      ...(option.tags ? { tags: [...option.tags] } : {}),
      ...(option.reasoning !== undefined ? { reasoning: option.reasoning } : {}),
      ...(option.thinkingLevelMap ? { thinkingLevelMap: { ...option.thinkingLevelMap } } : {}),
    })),
  ];

  const effortItems: ComposerMenuItem[] = [
    // Same treatment, same reason. The label is the raw stored value, which is
    // exactly what `composerModelLabelParts` puts in the trigger's suffix for
    // an unknown level — so the menu row and the trigger read identically,
    // instead of the trigger showing `ultra` while the menu ticks `Default`.
    ...(unknownEffort ? [{ id: unknownEffort, label: unknownEffort, selected: true }] : []),
    {
      id: EFFORT_DEFAULT_ID,
      label: 'Default',
      selected: effectiveEffort === EFFORT_DEFAULT_ID,
    },
    ...efforts.map((effort) => ({
      id: effort.id as string,
      label: effort.label,
      hint: effort.hint,
      selected: effort.id === effectiveEffort,
    })),
  ];

  return {
    sections: [
      { id: 'model', label: 'Model', items: modelItems },
      { id: 'effort', label: 'Reasoning effort', items: effortItems },
    ],
  };
}
