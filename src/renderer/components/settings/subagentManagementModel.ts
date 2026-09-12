/**
 * P5-2-5 / SA17 — the management page's logic, with no React in it.
 *
 * The page itself is a list, a search box, a form and six buttons; none of that
 * is where a management surface goes wrong. What goes wrong is quieter:
 *
 * - a save that drops the field the form has no control for,
 * - a failed switch that leaves the row showing the state it never reached,
 * - a refresh that blanks a list the user is reading,
 * - a "clear the model pin" that saves the pin it was supposed to clear.
 *
 * All four are decided here, as pure functions over plain data, so they are
 * asserted directly instead of through a rendered tree.
 */

import {
  DEFAULT_SUBAGENT_TOOLS,
  MAX_SUBAGENT_MAX_TURNS,
  normalizeSubagentName,
  SUBAGENT_ASSIGNABLE_TOOLS,
  type SubagentPermission,
  type SubagentThinkingLevel,
} from '@shared/subagentDefinition';
import type {
  SubagentCatalogView,
  SubagentRow,
  SubagentSaveRequest,
} from '@shared/types/subagentManagement';

/** What the form edits. Everything else travels on {@link SubagentDraft.carried}. */
export interface SubagentDraft {
  /** The name this document had when the form opened; absent for a new one. */
  previousName?: string;
  name: string;
  description: string;
  tools: string[];
  prompt: string;
  /** `provider/model`, exactly as a document spells it. Empty means no pin. */
  modelPin: string;
  thinkingLevel: SubagentThinkingLevel | '';
  permission: SubagentPermission | '';
  /** Empty means unlimited turns, which is also what the document's absence means. */
  maxTurns: string;
}

/**
 * An empty form.
 *
 * Seeded with the parser's own read-only default rather than an empty tool set,
 * because a definition with no tools is one that cannot do anything, and the
 * form should open on the safe useful state rather than the useless one.
 */
export function emptySubagentDraft(): SubagentDraft {
  return {
    name: '',
    description: '',
    tools: [...DEFAULT_SUBAGENT_TOOLS],
    prompt: '',
    modelPin: '',
    thinkingLevel: '',
    permission: '',
    maxTurns: '',
  };
}

/** Open the form on an existing row. */
export function draftFromRow(row: SubagentRow): SubagentDraft {
  return {
    previousName: row.name,
    name: row.name,
    description: row.description,
    tools: [...row.tools],
    prompt: row.prompt,
    modelPin: row.model ? `${row.model.provider}/${row.model.modelId}` : '',
    thinkingLevel: row.thinkingLevel ?? '',
    permission: row.permission ?? '',
    maxTurns: row.maxTurns === undefined ? '' : String(row.maxTurns),
  };
}

/**
 * Open the form on a BUILTIN.
 *
 * The builtin is never written to. Editing one produces a user document of the
 * same name, which the runtime's merge already prefers — so `previousName` is
 * deliberately absent: there is no old file to remove, and setting it would
 * make the save look like a rename of something we ship.
 */
export function draftFromBuiltin(row: SubagentRow): SubagentDraft {
  const draft = draftFromRow(row);
  delete draft.previousName;
  return draft;
}

export interface DraftProblem {
  field: keyof SubagentDraft;
  message: string;
}

/**
 * What is wrong with this draft, before anything is sent.
 *
 * Mirrors the parser's requirements rather than inventing its own: name,
 * description and body are what make a document load, so a form that accepted
 * a draft missing one of them would only be moving the error later.
 */
export function validateSubagentDraft(
  draft: SubagentDraft,
  existingNames: readonly string[] = []
): DraftProblem[] {
  const problems: DraftProblem[] = [];
  const name = normalizeSubagentName(draft.name);
  if (!name) {
    problems.push({ field: 'name', message: 'Give this subagent a name' });
  } else if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(name)) {
    problems.push({
      field: 'name',
      message: 'Use lowercase letters, digits and dashes (up to 40 characters)',
    });
  } else if (name !== draft.previousName && existingNames.includes(name)) {
    problems.push({ field: 'name', message: `A subagent named "${name}" already exists` });
  }
  if (!draft.description.trim()) {
    problems.push({
      field: 'description',
      message: 'Describe when to delegate here — the model reads this to choose',
    });
  }
  if (!draft.prompt.trim()) {
    problems.push({ field: 'prompt', message: 'Write the instructions this subagent runs on' });
  }
  if (draft.tools.length === 0) {
    problems.push({ field: 'tools', message: 'Pick at least one tool' });
  } else if (draft.tools.some((tool) => !SUBAGENT_ASSIGNABLE_TOOLS.includes(tool as never))) {
    problems.push({ field: 'tools', message: 'Unknown tool' });
  }
  if (draft.modelPin.trim()) {
    const slash = draft.modelPin.indexOf('/');
    if (slash <= 0 || slash === draft.modelPin.trim().length - 1) {
      problems.push({ field: 'modelPin', message: 'Write a pin as provider/model' });
    }
  }
  if (draft.maxTurns.trim()) {
    const parsed = Number(draft.maxTurns);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_SUBAGENT_MAX_TURNS) {
      problems.push({
        field: 'maxTurns',
        message: `A turn cap is 1 to ${MAX_SUBAGENT_MAX_TURNS}, or empty for unlimited`,
      });
    }
  }
  return problems;
}

/**
 * Turn a draft into a save.
 *
 * The empty-string cases are the point of this function: an empty model pin, an
 * empty thinking level and an empty turn cap are all CLEARS, and each has to
 * come out as an absent field rather than as an empty one — otherwise "remove
 * the pin" would save `model: ''` and the document would stop loading.
 */
export function saveRequestFromDraft(draft: SubagentDraft): SubagentSaveRequest {
  const pin = draft.modelPin.trim();
  const slash = pin.indexOf('/');
  const turns = draft.maxTurns.trim();
  return {
    name: normalizeSubagentName(draft.name),
    ...(draft.previousName ? { previousName: draft.previousName } : {}),
    description: draft.description.trim(),
    tools: [...draft.tools],
    ...(pin && slash > 0
      ? { model: { provider: pin.slice(0, slash), modelId: pin.slice(slash + 1) } }
      : {}),
    ...(draft.thinkingLevel ? { thinkingLevel: draft.thinkingLevel } : {}),
    // `inherit` is the default and the document says nothing for it. Sending it
    // explicitly would be harmless, but a form that has no permission control
    // yet must not start writing one either way.
    ...(draft.permission && draft.permission !== 'inherit' ? { permission: draft.permission } : {}),
    ...(turns ? { maxTurns: Number(turns) } : {}),
    prompt: draft.prompt.trim(),
  };
}

/**
 * Rows matching the search box.
 *
 * Name, description and tool names, case-insensitively. Not the prompt body: a
 * search that matched inside 30 KiB of instructions would return almost
 * everything for almost every word, and the list would stop narrowing.
 */
export function filterSubagentRows(
  rows: readonly SubagentRow[],
  query: string
): readonly SubagentRow[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((row) =>
    [row.name, row.description, ...row.tools].some((field) => field.toLowerCase().includes(needle))
  );
}

/**
 * Flip a row's switch before the answer comes back.
 *
 * Returned as a whole view so the caller can hold ONE piece of state; the
 * rollback is then "put the old view back", which cannot half-apply.
 */
export function withOptimisticEnabled(
  view: SubagentCatalogView,
  name: string,
  enabled: boolean
): SubagentCatalogView {
  return {
    ...view,
    rows: view.rows.map((row) => (row.name === name ? { ...row, enabled } : row)),
  };
}

/**
 * Whether a refresh should replace what is on screen.
 *
 * A failed read answers `null`, and a list already on screen stays. The
 * contract calls this "已加载列表刷新不闪空": the user reading a list must not
 * watch it blank out because a background refresh lost a race, and an empty
 * list is a real state that only a SUCCESSFUL read can report.
 */
export function adoptCatalog(
  previous: SubagentCatalogView | null,
  next: SubagentCatalogView | null
): SubagentCatalogView | null {
  return next ?? previous;
}

/** Row order: user definitions first, then builtins, each alphabetically. */
export function sortSubagentRows(rows: readonly SubagentRow[]): SubagentRow[] {
  return [...rows].sort((left, right) => {
    if (left.source !== right.source) return left.source === 'user' ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
}

/** One line summarising a row's model, gear and turn cap for the list. */
export function subagentRowSummary(row: SubagentRow): string {
  const parts: string[] = [row.tools.join(', ')];
  if (row.model) parts.push(`${row.model.provider}/${row.model.modelId}`);
  if (row.thinkingLevel) parts.push(`thinking: ${row.thinkingLevel}`);
  if (row.permission && row.permission !== 'inherit') parts.push(row.permission);
  parts.push(row.maxTurns === undefined ? 'unlimited turns' : `${row.maxTurns} turns`);
  return parts.filter(Boolean).join(' · ');
}
