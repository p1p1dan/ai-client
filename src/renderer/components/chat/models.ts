/**
 * D48 S2 §4.3/§4.4 — model SELECTION for the Composer, now that the catalog
 * itself comes from the proxy (`chat:listAgentModels`) instead of from here.
 *
 * ## What this module stopped being
 *
 * Until D48 S2 this file WAS the catalog: three hard-coded short names
 * (`sonnet`/`haiku`/`opus`), a hard default, and `ensureModelOptions`, whose
 * rule was "a Host-reported default we do not recognise is prepended and is
 * therefore legal". All three are gone (§4.3-3):
 *
 *  - the short-name table, because the gateway rejects short names outright
 *    [实测 调查 04 探测 B] and the real catalog is now family-filtered live data;
 *  - `DEFAULT_CHAT_MODEL_ID`, because a new session's default is `Automatic`
 *    (omit the field, let the runtime decide) rather than a model this repo
 *    picked once and never revisited (改判 #10);
 *  - `ensureModelOptions`, because "unrecognised ⇒ prepend ⇒ legal" is exactly
 *    the reasoning that must NOT survive: what a Host reports as its default is
 *    not evidence that the gateway will route it.
 *
 * `resolveResumeModel` survives, with a different diet: it eats a resolved
 * per-(session, agent) selection rather than resolving one itself.
 *
 * ## The two things a selection can be, and why `null` is not one of them
 *
 * A selection is either `AUTOMATIC_MODEL_ID` (send NO model field) or a model
 * id string. The sentinel exists for the same reason `EFFORT_DEFAULT_ID` does:
 * a radio group needs a value for "nothing pinned", and "nothing pinned" is a
 * real, distinct product state — it is what lets the runtime's own default
 * serve the turn instead of a value this app invented.
 *
 * ## Unverified is a label, never a filter
 *
 * A stored id outside the current catalog (a legacy short name, or a full name
 * the family whitelist filters out such as `gpt-5.5`) stays selected, stays on
 * the wire byte-for-byte, and is merely LABELLED unverified (§4.4-1/§4.4-6).
 * Resetting it to `Automatic` would be a silent model swap — R11's failure mode
 * arriving through a different door — and the old value would be unrecoverable,
 * because the write that replaced it is the only copy.
 *
 * Kept free of React and of stores so the whole decision surface is truth-
 * tabled under the repo's node-env vitest (`pureModuleImports.test.ts`).
 */

import type { AgentModelOption } from '@shared/types/agentCatalog';
import type { AgentWireName } from '@shared/types/agentWire';

export interface ChatModel {
  id: string;
  label: string;
  tags?: string[];
  reasoning?: boolean;
  thinkingLevelMap?: AgentModelOption['thinkingLevelMap'];
  /**
   * `true` for a row the live catalog actually listed. Absent on `Automatic`
   * (which is not a model) and on a prepended leftover (which is the whole
   * point of the flag).
   */
  verified?: boolean;
}

/**
 * "Send no `model` field", the model-side twin of `EFFORT_DEFAULT_ID`.
 *
 * Deliberately NOT the catalog's first entry (A 稿's original proposal, vetoed
 * by B U1): the order `/v1/models` answers in carries no documented meaning, so
 * "first" would be this app reading semantics into a list that has none. Omitting
 * the field asks the runtime — which does know — instead of guessing.
 */
export const AUTOMATIC_MODEL_ID = 'automatic';

export const AUTOMATIC_MODEL_LABEL = 'Automatic';

export function unverifiedModelLabel(_agent: AgentWireName, modelId: string): string {
  return `${modelId} · unverified`;
}

export const PI_MODEL_SCOPE_HINT = 'applies to the next turn';

export function modelScopeHint(_agent?: AgentWireName): string {
  return PI_MODEL_SCOPE_HINT;
}

/** The rows the menu offers: `Automatic` first, then the live catalog verbatim. */
export function modelOptionsFor(catalog: readonly AgentModelOption[]): ChatModel[] {
  return [
    { id: AUTOMATIC_MODEL_ID, label: AUTOMATIC_MODEL_LABEL },
    ...catalog.map((option) => ({
      id: option.id,
      label: option.label,
      verified: true,
      ...(option.tags ? { tags: [...option.tags] } : {}),
      ...(option.reasoning !== undefined ? { reasoning: option.reasoning } : {}),
      ...(option.thinkingLevelMap ? { thinkingLevelMap: { ...option.thinkingLevelMap } } : {}),
    })),
  ];
}

export interface ChatModelGroup {
  id: string;
  label: string;
  items: ChatModel[];
}

/** Match label/id and every tag; secondary tags are search-only, never groups. */
export function filterChatModels<T extends ChatModel>(models: readonly T[], query: string): T[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...models];
  return models.filter((model) =>
    [model.label, model.id, ...(model.tags ?? [])].some((value) =>
      value.toLocaleLowerCase().includes(needle)
    )
  );
}

/**
 * T25: a model appears in exactly one group — its first configured tag. Group
 * order is stable first appearance, so the management site's model/tag order
 * survives to the menu. Untagged models share one deterministic fallback.
 */
export function groupChatModels(
  models: readonly ChatModel[],
  fallbackLabel = 'Other models'
): { direct: ChatModel[]; groups: ChatModelGroup[] } {
  const direct: ChatModel[] = [];
  const groups: ChatModelGroup[] = [];
  const byLabel = new Map<string, ChatModelGroup>();
  for (const model of models) {
    if (model.id === AUTOMATIC_MODEL_ID || model.verified === false) {
      direct.push(model);
      continue;
    }
    const primary = model.tags?.find((tag) => tag.trim().length > 0)?.trim() || fallbackLabel;
    let group = byLabel.get(primary);
    if (!group) {
      group = { id: primary, label: primary, items: [] };
      byLabel.set(primary, group);
      groups.push(group);
    }
    group.items.push(model);
  }
  return { direct, groups };
}

/** `undefined` (i.e. omit the key) for `Automatic`, blank, or nothing stored. */
export function toWireModel(selection: string | null | undefined): string | undefined {
  if (typeof selection !== 'string') return undefined;
  const trimmed = selection.trim();
  if (trimmed.length === 0 || trimmed === AUTOMATIC_MODEL_ID) return undefined;
  return trimmed;
}

function catalogHas(catalog: readonly AgentModelOption[], modelId: string): boolean {
  return catalog.some((option) => option.id === modelId);
}

/**
 * A candidate only counts if it could actually run on this agent.
 *
 * Same three-valued rule as Main's dispatch guard (`isModelAllowedForAgent`,
 * §4.8-B18) rather than a second one: reject only what demonstrably belongs to
 * the OTHER runtime, let anything unclassifiable through. Applied here as well
 * as in Main because a `sonnet` reaching a Codex draft should be corrected where
 * the user can see it, not surfaced as an IPC rejection at send time.
 */
function usableFor(_agent: AgentWireName, candidate: string | null | undefined): string | null {
  if (typeof candidate !== 'string') return null;
  const trimmed = candidate.trim();
  if (trimmed.length === 0 || trimmed === AUTOMATIC_MODEL_ID) return null;
  return trimmed;
}

export interface ModelSelectionInput {
  agent: AgentWireName;
  /** This (session, agent) pair's own stored choice — the highest priority (§4.3). */
  storedModel: string | null | undefined;
  /** `ChatAgentDefaults.byAgent[agent].model` — "what a new draft on this agent restores". */
  agentDefaultModel?: string | null;
  /** Already family-filtered by Main. Empty is legal and means "no catalog". */
  catalog: readonly AgentModelOption[];
  /**
   * The Host's own reported default (`host.ready.settings.model`), DEMOTED in
   * §4.3-3 from "initial value + prepended catalog row" to one more source of an
   * unverified pre-existing value — consulted only when there is no catalog at
   * all and the session has chosen nothing. It never widens the catalog and it
   * never outranks a stored choice.
   */
  hostDefaultModel?: string | null;
}

/**
 * The selection to display (and therefore to send) for one (session, agent).
 *
 * Priority is §4.3's, verbatim: this session's own choice for THIS agent, then
 * the agent's default template, then `Automatic` — with the Host default
 * squeezed in ahead of `Automatic` only while the catalog is empty, because
 * offering nothing but `Automatic` when the Host has actually named a model
 * throws away the one fact available.
 */
export function resolveModelSelection(input: ModelSelectionInput): string {
  const { agent, catalog } = input;
  const stored = usableFor(agent, input.storedModel);
  if (stored) return stored;
  const agentDefault = usableFor(agent, input.agentDefaultModel);
  if (agentDefault) return agentDefault;
  if (catalog.length === 0) {
    const hostDefault = usableFor(agent, input.hostDefaultModel);
    if (hostDefault) return hostDefault;
  }
  return AUTOMATIC_MODEL_ID;
}

export interface ModelReconcileInput extends ModelSelectionInput {
  /** What the trigger is displaying right now. */
  current: string;
  /**
   * `false` while the first catalog answer for this agent is still in flight.
   * The whole point of the flag: a not-yet-loaded catalog must never be read as
   * "the catalog says this model does not exist" (§4.3-6).
   */
  catalogLoaded: boolean;
  /**
   * `true` when the (session, agent) pair under the trigger is not the pair the
   * displayed value was resolved for. Required rather than optional: defaulting
   * it to `false` is precisely the hole this field exists to close, and a call
   * site that forgets it should not compile.
   */
  pairChanged: boolean;
}

/**
 * B17 — what the displayed selection becomes. §4.3-6 names TWO triggers, and
 * they are not the same decision:
 *
 *  - **the pair moved** (`sessionId` or `agent` changed) ⇒ re-resolve from that
 *    pair's own storage, unconditionally. A keep-arm here is a display≠send
 *    split (R11/A11): the send path resolves the new pair off storage every
 *    time (`resolveResumeModel`), so a trigger that kept the previous session's
 *    model would show Opus while the turn went out on Haiku. There is no
 *    "conservative" reading of this arm — the previous value belongs to another
 *    session, and keeping it is never right.
 *  - **the catalog arrived** for an unchanged pair ⇒ the conservative arms
 *    below, because a late list must not overwrite a choice.
 *
 * For the second trigger, three keep-arms and one rewrite-arm, and the
 * keep-arms are the load-bearing half:
 *
 *  1. catalog not loaded yet ⇒ KEEP. This is "show the last value, not a
 *     spinner and not an empty menu" expressed as a rule rather than as a
 *     rendering trick.
 *  2. current is `Automatic`, or is in the catalog ⇒ KEEP.
 *  3. current is this session's own stored (legacy/unverified) value ⇒ KEEP,
 *     even though the catalog does not list it. §4.4-6: a stored selection the
 *     whitelist filtered out belongs to the session that chose it.
 *
 * All three are gated on the value being carryable by THIS agent: a value
 * belonging to the other runtime is rewritten before any keep-arm is consulted,
 * so it can never ride out the not-yet-loaded window (which lasts forever while
 * the Host is not ready) and surface as a `claude-opus-5 · unverified` row on a
 * Codex draft — B12's 「不存在跨 agent selection」 read at the UI.
 *
 * Everything else — in practice a value adopted from the Host default that the
 * freshly-arrived catalog contradicts — is re-derived from
 * `resolveModelSelection`. Which is the only case where a rewrite is not a
 * silent swap: nobody chose it, this build inferred it.
 */
export function reconcileModelSelection(input: ModelReconcileInput): string {
  const { agent, catalog, catalogLoaded, current, pairChanged } = input;
  if (pairChanged) return resolveModelSelection(input);
  if (current !== AUTOMATIC_MODEL_ID && usableFor(agent, current) === null) {
    return resolveModelSelection(input);
  }
  if (!catalogLoaded) return current;
  if (current === AUTOMATIC_MODEL_ID) return current;
  if (catalogHas(catalog, current)) return current;
  const stored = usableFor(agent, input.storedModel);
  if (stored && stored === current) return current;
  return resolveModelSelection(input);
}

/**
 * F9 (round-2 review fix), rewritten for D48 S2: the model a RESUME call or a
 * direct send should pin, resolved the same way `ComposerModelTrigger` resolves
 * what it displays — so the two can never disagree.
 *
 * It returns `string | undefined` now rather than always a string: `undefined`
 * IS the answer for `Automatic`, and the call sites spread it conditionally
 * (`...(model ? { model } : {})`) so the key leaves the payload entirely (B11).
 * The old form's `?? defaultModelId(null)` tail is precisely what this batch
 * deletes — it hard-pinned `sonnet` onto every session the user never touched.
 *
 * `agent` is required and is never defaulted: which models exist is a function
 * of which runtime runs the session, so a resume that guessed the agent would
 * be resolving against the wrong storage bucket.
 */
export function resolveResumeModel(
  getSessionModel: (sessionId: string, agent: AgentWireName) => string | null,
  sessionId: string,
  agent: AgentWireName,
  agentDefaultModel?: string | null
): string | undefined {
  const selection = resolveModelSelection({
    agent,
    storedModel: getSessionModel(sessionId, agent),
    agentDefaultModel,
    // Resume/send call sites hold no catalog — and must not need one. The
    // catalog only ever decides LABELS and the Host-default rung, both of which
    // are display concerns; what goes on the wire is the stored choice or
    // nothing at all.
    catalog: [],
  });
  return toWireModel(selection);
}
