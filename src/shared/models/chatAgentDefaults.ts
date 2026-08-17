/**
 * D48 S2 §4.3 — `ChatAgentDefaults`: the per-AGENT template layer, and the
 * cross-session `lastAgent` memory.
 *
 * ## Two layers, and why neither can do the other's job
 *
 * per-SESSION storage (`sessionPreferenceStore.ts`) answers "what did this chat
 * pick"; this record answers "what does a NEW draft on this agent start from".
 * Collapsing them either makes every session share one model (two Claude chats
 * could not differ) or makes a new draft start from nothing (the user re-picks
 * their model every time). §4.3's priority chain is therefore
 * session → `byAgent[agent]` → `Automatic`, and this module owns the middle rung.
 *
 * ## `lastAgent` must be intersected, never adopted
 *
 * The stored agent is a memory of a past Host, not a claim about this one. If it
 * is adopted verbatim on a build where the Codex flag is off, every new draft is
 * bound to an agent the Host cannot run and the first send comes back
 * `agent_unsupported` — after the draft has been consumed and the picker locked.
 * So `resolveInitialDraftAgent` intersects with `capabilities.agents` and falls
 * back to the legacy binding, with `undefined` (an old Host that predates the
 * capability) treated as "cannot confirm anything", not as "everything".
 *
 * ## Hydration is a real state, not a formality
 *
 * App settings persist through an ASYNC IPC round trip (`settings/storage.ts`:
 * `getItem`/`setItem` are both `await window.electronAPI.settings.read/write`),
 * so there is a window on every launch where the store holds `defaults.ts`
 * values that nobody chose. Reading `lastAgent` in that window yields "unset";
 * WRITING in it persists the empty default over the user's real one. Both halves
 * are gated on the same flag, and both arms are asserted (B15).
 *
 * Pure (no React, no store, no IPC) so the whole truth table runs under the
 * node-env vitest.
 */

import {
  type AgentWireName,
  CLAUDE_CODE_AGENT,
  CODEX_AGENT,
  isAgentWireName,
  sessionAgent,
} from '../types/agentWire';
import {
  readSessionPermissionPreference,
  type SessionPermissionPreference,
} from '../types/runtimeEvents';

/**
 * The two agent names, handed to the shared preference guard. They travel as an
 * argument because `runtimeEvents.ts` may neither re-home the binding literal
 * nor take a value import (see that module's guard header); this record is the
 * renderer-side caller that supplies them.
 */
const PREFERENCE_AGENTS = { claudeCode: CLAUDE_CODE_AGENT, codex: CODEX_AGENT } as const;

function permissionPreferenceFor(
  value: unknown,
  agent: AgentWireName
): SessionPermissionPreference | undefined {
  const parsed = readSessionPermissionPreference(value, PREFERENCE_AGENTS);
  // Keyed BY agent while the value carries its own discriminant: a blob where
  // the two disagree would hand `session.create` one agent's posture for the
  // other agent's session — the mismatch the Host refuses at dispatch (C10).
  return parsed && parsed.agent === agent ? parsed : undefined;
}

/** One agent's default generation settings. `model` absent = `Automatic` (§4.3). */
export interface ChatAgentPreference {
  model?: string;
  effort?: string;
  /**
   * D48 S3 §5.4 — the TEMPLATE layer of the permission posture: the tier a NEW
   * draft on this agent starts from. Absent = the runtime's own safe constant,
   * which is what a fresh install has and what every fallback below returns.
   *
   * Never the live posture of an existing session: that one is captured into
   * the session snapshot at first send and replayed on resume (§5.5-2), so
   * editing this record cannot retroactively change a chat that already ran.
   */
  permission?: SessionPermissionPreference;
}

export interface ChatAgentDefaults {
  /** The agent a NEW draft starts on. Only ever consulted through `resolveInitialDraftAgent`. */
  lastAgent?: AgentWireName;
  byAgent?: Partial<Record<AgentWireName, ChatAgentPreference>>;
}

/** The value a fresh install carries: no memory, no templates. */
export const EMPTY_CHAT_AGENT_DEFAULTS: ChatAgentDefaults = {};

function sanitizePreference(value: unknown, agent: AgentWireName): ChatAgentPreference | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as { model?: unknown; effort?: unknown; permission?: unknown };
  const preference: ChatAgentPreference = {};
  if (typeof raw.model === 'string' && raw.model.trim().length > 0) {
    preference.model = raw.model.trim();
  }
  if (typeof raw.effort === 'string' && raw.effort.trim().length > 0) {
    preference.effort = raw.effort.trim();
  }
  // Refused here too, not only at dispatch: a mis-addressed tier cannot even be
  // stored, so no later read has to remember to re-check it.
  const permission = permissionPreferenceFor(raw.permission, agent);
  if (permission) preference.permission = permission;
  return Object.keys(preference).length > 0 ? preference : null;
}

/**
 * Persisted blob → a value this build can reason about.
 *
 * Unknown agent slugs are DROPPED rather than kept: this record is read by code
 * that switches on the binding, and a slug from a newer build would flow into
 * `resolveInitialDraftAgent` as a binding no runtime here can serve. The blob on
 * disk is untouched — a downgrade/upgrade round trip loses only what this build
 * could not have used anyway.
 */
export function sanitizeChatAgentDefaults(value: unknown): ChatAgentDefaults {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return EMPTY_CHAT_AGENT_DEFAULTS;
  }
  const raw = value as { lastAgent?: unknown; byAgent?: unknown };
  const next: ChatAgentDefaults = {};
  if (isAgentWireName(raw.lastAgent)) {
    next.lastAgent = raw.lastAgent;
  }
  if (raw.byAgent && typeof raw.byAgent === 'object' && !Array.isArray(raw.byAgent)) {
    const byAgent: Partial<Record<AgentWireName, ChatAgentPreference>> = {};
    for (const [key, entry] of Object.entries(raw.byAgent as Record<string, unknown>)) {
      if (!isAgentWireName(key)) continue;
      const preference = sanitizePreference(entry, key);
      if (preference) byAgent[key] = preference;
    }
    if (Object.keys(byAgent).length > 0) next.byAgent = byAgent;
  }
  return next;
}

/** This agent's default model, or `undefined` for `Automatic`. */
export function agentDefaultModel(
  defaults: ChatAgentDefaults | undefined,
  agent: AgentWireName
): string | undefined {
  return defaults?.byAgent?.[agent]?.model;
}

/** This agent's default effort selection, or `undefined` for `Default`. */
export function agentDefaultEffort(
  defaults: ChatAgentDefaults | undefined,
  agent: AgentWireName
): string | undefined {
  return defaults?.byAgent?.[agent]?.effort;
}

/**
 * This agent's template permission tier, or `undefined` for "the runtime's own
 * safe constant".
 *
 * `undefined` is the ONLY fallback this module produces. It is not a value the
 * caller has to interpret: an absent `permissionPreference` on the wire means
 * `CHAT_PERMISSION_MODE` / `CODEX_PERMISSION_DEFAULT`, both of which are
 * asserted non-dangerous (§5.7-C13). Returning a synthesized "safe default"
 * object here instead would put a second copy of those constants in the
 * renderer, where it could drift from what the Host actually sends.
 */
export function agentDefaultPermission(
  defaults: ChatAgentDefaults | undefined,
  agent: AgentWireName
): SessionPermissionPreference | undefined {
  // Re-checked on READ, not just on write: this record round-trips through
  // app settings on disk, which a user (or an older/newer build) can edit.
  return permissionPreferenceFor(defaults?.byAgent?.[agent]?.permission, agent);
}

/** Immutable update of one agent's template — `undefined` clears that field. */
export function withAgentPreference(
  defaults: ChatAgentDefaults | undefined,
  agent: AgentWireName,
  patch: ChatAgentPreference
): ChatAgentDefaults {
  const base = defaults ?? EMPTY_CHAT_AGENT_DEFAULTS;
  const current = base.byAgent?.[agent] ?? {};
  const merged: ChatAgentPreference = { ...current };
  if ('model' in patch) {
    if (patch.model === undefined) delete merged.model;
    else merged.model = patch.model;
  }
  if ('effort' in patch) {
    if (patch.effort === undefined) delete merged.effort;
    else merged.effort = patch.effort;
  }
  if ('permission' in patch) {
    // `undefined` clears (back to the runtime constant); a preference for a
    // DIFFERENT agent is dropped rather than filed under this key — see
    // `sanitizePreference`. Dangerous tiers are accepted here on purpose: this
    // is the user's explicit choice arriving after the second confirmation, and
    // the never-a-default rule is about defaults and fallbacks, not about what
    // the user may pick (§5.4-3/4).
    if (patch.permission === undefined) delete merged.permission;
    else if (patch.permission.agent === agent) merged.permission = patch.permission;
  }
  const byAgent = { ...(base.byAgent ?? {}) };
  if (Object.keys(merged).length === 0) delete byAgent[agent];
  else byAgent[agent] = merged;
  return { ...base, byAgent };
}

export interface InitialDraftAgentInput {
  lastAgent: AgentWireName | undefined;
  /** `hostStatus.capabilities?.agents`. `undefined` ≠ `[]` — see the header. */
  capabilitiesAgents: readonly AgentWireName[] | undefined;
  /** `false` until app settings finish their async rehydrate. */
  settingsHydrated: boolean;
}

/**
 * B15 — which agent a brand-new draft starts on.
 *
 * `sessionAgent({})` is the fallback rather than a literal, so this file adds no
 * second home for the legacy binding value (`agentWireStatic.test.ts` bans one).
 */
export function resolveInitialDraftAgent(input: InitialDraftAgentInput): AgentWireName {
  const legacy = sessionAgent({});
  if (!input.settingsHydrated) return legacy;
  const { lastAgent, capabilitiesAgents } = input;
  if (!lastAgent) return legacy;
  if (capabilitiesAgents === undefined) return legacy;
  return capabilitiesAgents.includes(lastAgent) ? lastAgent : legacy;
}

/**
 * Whether an agent pick may be written to `lastAgent` yet.
 *
 * Split out from the resolver so the two hydration arms are separately asserted:
 * a build that only gated the READ would still overwrite a real stored value
 * with the empty default the first time the user touched the picker, and the
 * read-side truth table would stay green while it did.
 */
export function canPersistLastAgent(settingsHydrated: boolean): boolean {
  return settingsHydrated;
}

export interface DraftPermissionInput {
  defaults: ChatAgentDefaults | undefined;
  agent: AgentWireName;
  /** `false` until app settings finish their async rehydrate. */
  settingsHydrated: boolean;
}

/**
 * §5.5-3 / C15 — the posture a first send may materialise into the session
 * snapshot, or `undefined` for "send nothing and let the runtime constant
 * apply".
 *
 * The hydration gate is the load-bearing half. App settings arrive over an
 * async IPC round trip (`stores/settings/storage.ts`), so a cold-start send can
 * land while the store still holds `defaults.ts` factory values that nobody
 * chose. Materialising THOSE would pin a posture the user never picked into the
 * session snapshot permanently — resume reads the snapshot by design and never
 * revisits the template, so nothing would ever correct it. Emitting nothing
 * instead degrades to exactly the pre-D48 path (runtime constant), which is
 * both safe and already covered by every old-Host test.
 *
 * Note what this function can NEVER return: a dangerous tier that the user did
 * not explicitly store. Every arm here is either the stored value or
 * `undefined` — there is no synthesized fallback to get wrong (§5.7-C13).
 */
export function resolveDraftPermissionPreference(
  input: DraftPermissionInput
): SessionPermissionPreference | undefined {
  if (!input.settingsHydrated) return undefined;
  return agentDefaultPermission(input.defaults, input.agent);
}
