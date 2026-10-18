/**
 * dsh-rebase decision 194 Q2 (user, 2026-10-18): `/model` and `/effort` are this window's
 * commands, run through the composer's own model menu — never the engine's — so what the
 * window shows is what the next send carries. On the Claude Agent SDK engine the CLI's
 * own `/model` and `/effort` would switch behind the menu's back (and past the same-route
 * limit of S-6 feedback 3).
 *
 * - No argument: the menu opens.
 * - A name the menu offers: it is picked, as a click on its row would pick it.
 * - A model this chat cannot switch to (another route of an SDK chat): the menu's own
 *   hint, nothing changes.
 * - Anything else: the menu opens with the argument in its search box (models), or opens
 *   with a hint (effort levels).
 *
 * Pure, no React; `ComposerModelTrigger` acts on the answer.
 */

import type { ChatAgentPreference } from '@shared/models/chatAgentDefaults';
import { EFFORT_DEFAULT_ID } from './efforts';
import { AUTOMATIC_MODEL_ID } from './models';

export type SlashMenuResolution =
  | { kind: 'open' }
  | { kind: 'pick'; id: string }
  | { kind: 'locked'; id: string }
  | { kind: 'unknown'; query: string };

interface MenuRow {
  id: string;
  label: string;
  locked?: boolean;
}

const fold = (value: string) => value.trim().toLocaleLowerCase();

/** The one row `query` names: by id, by label, by the id after its provider, or by a unique part. */
function findRow<T extends MenuRow>(rows: readonly T[], query: string): T[] {
  const needle = fold(query);
  const exact = rows.filter(
    (row) =>
      fold(row.id) === needle ||
      fold(row.label) === needle ||
      fold(row.id.slice(row.id.lastIndexOf('/') + 1)) === needle
  );
  if (exact.length > 0) return exact;
  return rows.filter((row) => fold(row.id).includes(needle) || fold(row.label).includes(needle));
}

/**
 * `/model <query>` against the menu's rows (`modelMenuOptionsFor`). `Automatic` is
 * offered by the menu but not by name here: typing a model means wanting that model.
 */
export function resolveModelCommand(query: string, rows: readonly MenuRow[]): SlashMenuResolution {
  if (!query.trim()) return { kind: 'open' };
  const found = findRow(
    rows.filter((row) => row.id !== AUTOMATIC_MODEL_ID),
    query
  );
  if (found.length !== 1) return { kind: 'unknown', query: query.trim() };
  const [row] = found as [MenuRow];
  return row.locked ? { kind: 'locked', id: row.id } : { kind: 'pick', id: row.id };
}

/** The CLI's words for "let the model decide" (`/effort auto`), and the menu's. */
const DEFAULT_EFFORT_WORDS = new Set(['auto', 'default', EFFORT_DEFAULT_ID]);

/**
 * `/effort <level>` against the levels the selected model offers (`effortsForModel`),
 * by id or by label in English or in the UI language (`translate`).
 */
export function resolveEffortCommand(
  query: string,
  efforts: readonly MenuRow[],
  translate: (key: string) => string = (key) => key
): SlashMenuResolution {
  const needle = fold(query);
  if (!needle) return { kind: 'open' };
  if (DEFAULT_EFFORT_WORDS.has(needle)) return { kind: 'pick', id: EFFORT_DEFAULT_ID };
  const match = efforts.find(
    (effort) =>
      fold(effort.id) === needle ||
      fold(effort.label) === needle ||
      fold(translate(effort.label)) === needle ||
      fold(effort.label).replace(/[^a-z]/g, '') === needle.replace(/[^a-z]/g, '')
  );
  return match ? { kind: 'pick', id: match.id } : { kind: 'unknown', query: query.trim() };
}

/**
 * What `/new` and `/clear` typed in a conversation carry to the home page: its own model
 * and effort, as the template's patch (`withAgentPreference`). `Automatic` and the
 * default effort clear the template's value; nothing stored carries nothing.
 */
export function carriedGenerationPreferences(
  model: string | null | undefined,
  effort: string | null | undefined
): ChatAgentPreference | null {
  const patch: ChatAgentPreference = {};
  if (model) patch.model = model === AUTOMATIC_MODEL_ID ? undefined : model;
  if (effort) patch.effort = effort === EFFORT_DEFAULT_ID ? undefined : effort;
  return 'model' in patch || 'effort' in patch ? patch : null;
}
