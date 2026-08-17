/**
 * D48 S2 §4.3 — per-session model / effort persistence, re-keyed by the
 * (session, agent) PAIR.
 *
 * ## Why the pair and not just the session
 *
 * Before D48 a session had one model, because a session had one runtime. It now
 * has two possible runtimes with disjoint catalogs, and a zero-turn draft can be
 * switched between them freely. Keeping one scalar per session means the map
 * only remembers the LAST axis touched: Claude → Codex → Claude loses the first
 * Claude pick and silently falls back to the agent template, which is the same
 * class of silent swap R11 exists to prevent — and the pre-existing B12 wording
 * ("no cross-agent selection exists") is satisfied by both designs, which is why
 * that case is now asserted explicitly ("switch away and back, the original
 * choice is still there").
 *
 * ## Storage layout, and what a legacy blob looks like
 *
 * The two pre-D48 keys are kept (§4.3 says so), and each holds the same shape:
 *
 *   { "<sessionId>": { "<agent>": "<value>" } }      // D48 S2 onwards
 *   { "<sessionId>": "<value>" }                     // pre-D48, still readable
 *
 * A legacy scalar is READ, never rewritten on read (`sessionIndex.ts:19-27`
 * states the rule this follows: normalising on load turns a compatible read into
 * an irreversible write migration). It is attributed to every agent it could
 * legally belong to — for models that is `isModelAllowedForAgent`, the SAME
 * three-valued ownership rule Main's dispatch guard uses (§4.8-B18), so a
 * `sonnet` left over from a Claude session can never surface as a Codex draft's
 * model; for efforts it is every agent, since the five levels are one shared
 * vocabulary on both axes [实测 调查 04 探测 E/G].
 *
 * The upgrade to the nested shape happens on the next WRITE, and it is
 * behaviour-preserving by construction: the legacy scalar is fanned out to
 * exactly the agents that were already reading it, then the new value is laid on
 * top. That is §4.4-4's "the migration is completed by the user's next click",
 * expressed in the storage layer.
 *
 * Pure (no React, no store) so all of the above is unit-testable under the
 * repo's node-env vitest — the reason `sessionEffortStore.ts` was split out of
 * its hook in T-20, now generalised to both selections.
 */

import { isModelAllowedForAgent } from '@shared/models/familyWhitelist';
import { AGENT_WIRE_NAMES, type AgentWireName } from '@shared/types/agentWire';
import { isEffortSelection } from './efforts';

export const SESSION_MODEL_STORAGE_KEY = 'aiclient:chat:session-models';
export const SESSION_EFFORT_STORAGE_KEY = 'aiclient:chat:session-efforts';

/** One session's row: the nested per-agent form, or a pre-D48 scalar. */
type SessionEntry = string | Partial<Record<AgentWireName, string>>;
type PreferenceMap = Record<string, SessionEntry>;

function loadMap(storageKey: string): PreferenceMap {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as PreferenceMap;
    }
    return {};
  } catch {
    // Corrupt blob or storage unavailable (private mode / quota) — treat as unset.
    return {};
  }
}

function saveMap(storageKey: string, map: PreferenceMap): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(map));
  } catch {
    // Storage may be unavailable; the selection stays in memory only.
  }
}

/** Which agents a pre-D48 scalar was already answering for. */
type LegacyOwnership = (agent: AgentWireName, value: string) => boolean;

const anyAgentOwnsIt: LegacyOwnership = () => true;

function readEntry(
  storageKey: string,
  sessionId: string,
  agent: AgentWireName,
  ownedBy: LegacyOwnership
): string | null {
  const entry = loadMap(storageKey)[sessionId];
  if (typeof entry === 'string') {
    return ownedBy(agent, entry) ? entry : null;
  }
  if (entry && typeof entry === 'object') {
    const value = entry[agent];
    return typeof value === 'string' ? value : null;
  }
  return null;
}

/** Legacy scalar → the nested row that reads identically. */
function expandEntry(entry: SessionEntry | undefined, ownedBy: LegacyOwnership) {
  const expanded: Partial<Record<AgentWireName, string>> = {};
  if (typeof entry === 'string') {
    for (const agent of AGENT_WIRE_NAMES) {
      if (ownedBy(agent, entry)) expanded[agent] = entry;
    }
    return expanded;
  }
  if (entry && typeof entry === 'object') {
    for (const agent of AGENT_WIRE_NAMES) {
      const value = entry[agent];
      if (typeof value === 'string') expanded[agent] = value;
    }
  }
  return expanded;
}

function writeEntry(
  storageKey: string,
  sessionId: string,
  agent: AgentWireName,
  value: string,
  ownedBy: LegacyOwnership
): void {
  const map = loadMap(storageKey);
  const next = expandEntry(map[sessionId], ownedBy);
  next[agent] = value;
  map[sessionId] = next;
  saveMap(storageKey, map);
}

function clearEntry(
  storageKey: string,
  sessionId: string,
  agent: AgentWireName,
  ownedBy: LegacyOwnership
): void {
  const map = loadMap(storageKey);
  if (!(sessionId in map)) return;
  const next = expandEntry(map[sessionId], ownedBy);
  delete next[agent];
  if (Object.keys(next).length === 0) {
    delete map[sessionId];
  } else {
    map[sessionId] = next;
  }
  saveMap(storageKey, map);
}

// ---- Model ----

/**
 * A pre-D48 model scalar belongs to whichever agent could run it.
 *
 * `isModelAllowedForAgent` is three-valued and permissive by design: a value it
 * cannot classify stays available on both axes rather than being deleted from
 * one. Sharing that symbol with Main's guard is the point — two different
 * answers to "may this agent carry this model" is how a selection ends up
 * displayed on one side and refused on the other.
 */
const modelOwnership: LegacyOwnership = (agent, value) => isModelAllowedForAgent(agent, value);

/** The stored model id for one (session, agent), or null when unset. */
export function readSessionModel(sessionId: string, agent: AgentWireName): string | null {
  return readEntry(SESSION_MODEL_STORAGE_KEY, sessionId, agent, modelOwnership);
}

/** Bind a model id to one (session, agent) and persist. Never throws. */
export function writeSessionModel(sessionId: string, agent: AgentWireName, modelId: string): void {
  writeEntry(SESSION_MODEL_STORAGE_KEY, sessionId, agent, modelId, modelOwnership);
}

/**
 * Drop this (session, agent)'s model — which is how `Automatic` is stored.
 *
 * `Automatic` is deliberately an ABSENCE rather than a persisted sentinel: the
 * effort sentinel has to be stored (an explicit `Default` differs from "never
 * chosen" only in the store), whereas for models the two collapse — both mean
 * "omit the field", and both must keep following the agent template if one is
 * later set. Storing a sentinel would freeze the session against that template.
 */
export function removeSessionModel(sessionId: string, agent: AgentWireName): void {
  clearEntry(SESSION_MODEL_STORAGE_KEY, sessionId, agent, modelOwnership);
}

// ---- Reasoning effort ----

/** The stored effort selection for one (session, agent), or null when unset. */
export function readSessionEffort(sessionId: string, agent: AgentWireName): string | null {
  return readEntry(SESSION_EFFORT_STORAGE_KEY, sessionId, agent, anyAgentOwnsIt);
}

/**
 * Bind an effort selection (a level or the Default sentinel) and persist.
 * Never throws.
 *
 * B10 counts the layers that refuse a word like `ultra`, and this is the
 * storage one: a value outside the vocabulary is NOT written, so it can never
 * become the thing a later read hands back to the trigger and the send path.
 * Rejecting on the way in rather than discarding on the way out is deliberate —
 * discarding on read would leave the bad value on disk, re-decided on every
 * read, and `sessionIndex.ts:19-27`'s rule forbids the obvious fix (rewriting
 * it during a read turns a compatible read into an irreversible migration).
 *
 * Silent rather than throwing, for the same reason nothing else here throws:
 * the Composer calls this from a click handler, and the only caller that could
 * produce an illegal value is a bug in a menu that offers exactly five levels
 * plus the sentinel.
 */
export function writeSessionEffort(
  sessionId: string,
  agent: AgentWireName,
  selection: string
): void {
  if (!isEffortSelection(selection)) return;
  writeEntry(SESSION_EFFORT_STORAGE_KEY, sessionId, agent, selection, anyAgentOwnsIt);
}

/** Drop this (session, agent)'s effort selection (no-op when unset). Never throws. */
export function removeSessionEffort(sessionId: string, agent: AgentWireName): void {
  clearEntry(SESSION_EFFORT_STORAGE_KEY, sessionId, agent, anyAgentOwnsIt);
}
