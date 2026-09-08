/**
 * P2-3 — the compaction strategy: when a conversation must be compacted, how
 * much of it survives, and when the model is warned that it is running out.
 *
 * Provenance (AGENTS.md requires stating it): **ported as-is** from
 * PI-Desktop's `packages/agent-runtime/src/runtime.ts` — the constants at
 * `runtime.ts:340-360`, `contextBudget` at `runtime.ts:3931`,
 * `automaticCompactionNeeded` at `runtime.ts:3970`,
 * `retainedUserMessageBudget` at `runtime.ts:3984`, and the two-tier reminder
 * at `runtime.ts:4166`. ARD §4.2 says to carry the strategy over unchanged
 * first and tune later, so the arithmetic here is theirs; only the shape
 * changed (see "Why this is pure" below).
 *
 * ## Why every threshold is derived, not configured
 *
 * PI-Desktop's note is worth keeping verbatim in spirit: no single configured
 * token count fits both a 32K and a 1M window. A "compact at 100k tokens"
 * setting is either never reached on a large model or permanently tripped on a
 * small one, so every number below is a fraction of the active model's own
 * window, clamped by floors and ceilings that keep small and large windows both
 * usable.
 *
 * ## Why this is pure
 *
 * The caller passes the model's window and a token estimate; nothing here
 * reads a file, calls a provider, or touches pi-agent-core. That is deliberate:
 * ARD D11 routes runtime file access through `runtimeHostIo` (P1-0) and the
 * actual compaction call needs the session store (P2-4 / P3), so keeping the
 * decision layer free of both is what lets P2-3 land and be tested before
 * either exists. `tokens` comes from pi-agent-core's `estimateContextTokens`
 * at the call site.
 */

/**
 * Tokens held back from the window for the summary prompt and the model's own
 * output. PI-Desktop's floor reproduces the reserve that used to be its default
 * setting, so the hard safety boundary is unchanged by the move to derivation.
 */
export const COMPACTION_RESERVE_FLOOR_TOKENS = 16_384;

/**
 * Retained-tail target as a share of the safe budget, bounded so a 32K window
 * still keeps a usable tail and a 1M window does not carry the whole session
 * forward.
 */
export const COMPACTION_KEEP_RECENT_RATIO = 0.2;
export const COMPACTION_MIN_KEEP_RECENT_TOKENS = 8_000;
export const COMPACTION_MAX_KEEP_RECENT_TOKENS = 64_000;

/**
 * Cap on the user message carried across a compaction boundary. Codex uses a
 * flat 20k (`COMPACT_USER_MESSAGE_MAX_TOKENS`); the clamp against the safe
 * budget keeps a small window from being filled by retention alone, which would
 * leave the summary no room.
 */
export const COMPACTION_RETAINED_USER_MESSAGE_MAX_TOKENS = 20_000;

/** Two-tier budget reminder, matching Codex's `TokenBudgetReminder`. */
export const CONTEXT_REMINDER_MIN_TOKENS = 8_000;
export const CONTEXT_REMINDER_MAX_TOKENS = 32_000;
export const CONTEXT_REMINDER_RATIO = 0.15;
/** Close enough to the boundary that the next turn is likely to cross it. */
export const CONTEXT_FALLBACK_REMINDER_TOKENS = 2_000;

/** Used when a catalog entry declares no window. Same defaults PI-Desktop falls back to. */
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_TOKENS = 8_192;

export interface ModelWindow {
  /** Total context window of the active model, in tokens. */
  contextWindow?: number;
  /** Largest completion the model will produce, in tokens. */
  maxTokens?: number;
}

export interface ContextBudget {
  /** Estimated tokens in the reconstructed model context. */
  tokens: number;
  /** Point at which an uncompacted provider request is no longer allowed. */
  hardLimit: number;
  /** Tokens reserved for the request's own prompt and output. */
  requestHeadroom: number;
  /** Approximate recent-context tokens a checkpoint should retain. */
  keepRecentTokens: number;
}

/**
 * Derive the thresholds for one request.
 *
 * `hardLimit` is a safety boundary, not a suggestion: PI-Desktop compacts
 * inline at that point rather than scheduling it, because a request issued at
 * or above the limit is the one that fails with a context overflow.
 */
export function contextBudget(model: ModelWindow, tokens: number): ContextBudget {
  const contextWindow = Math.max(1, Math.round(model.contextWindow || DEFAULT_CONTEXT_WINDOW));
  const modelOutputBudget = Math.min(
    Math.max(1, Math.round(model.maxTokens || DEFAULT_MAX_TOKENS)),
    Math.max(1, Math.floor(contextWindow * 0.25))
  );
  const reserveFloor = Math.min(
    COMPACTION_RESERVE_FLOOR_TOKENS,
    Math.max(1, Math.floor(contextWindow * 0.5))
  );
  const requestHeadroom = Math.min(
    contextWindow - 1,
    Math.max(reserveFloor, modelOutputBudget, Math.ceil(contextWindow * 0.05))
  );
  const hardLimit = Math.max(1, contextWindow - requestHeadroom);
  const keepRecentTokens = Math.min(
    Math.max(
      COMPACTION_MIN_KEEP_RECENT_TOKENS,
      Math.min(
        COMPACTION_MAX_KEEP_RECENT_TOKENS,
        Math.floor(hardLimit * COMPACTION_KEEP_RECENT_RATIO)
      )
    ),
    Math.max(1, Math.floor(hardLimit * 0.5))
  );
  return { tokens: Math.max(0, tokens), hardLimit, requestHeadroom, keepRecentTokens };
}

/** True when the next request must not be issued without compacting first. */
export function compactionNeeded(budget: ContextBudget, enabled = true): boolean {
  return enabled && budget.tokens >= budget.hardLimit;
}

/** Cap on the active user message a checkpoint carries forward. */
export function retainedUserMessageBudget(budget: ContextBudget): number {
  return Math.max(
    1,
    Math.min(COMPACTION_RETAINED_USER_MESSAGE_MAX_TOKENS, Math.floor(budget.hardLimit * 0.5))
  );
}

/** Tokens left before the hard limit. Never negative — past the limit reads as 0. */
export function remainingTokens(budget: ContextBudget): number {
  return Math.max(0, budget.hardLimit - budget.tokens);
}

/** Where the first-tier warning fires, derived from the same limit the guard uses. */
export function reminderThreshold(budget: ContextBudget): number {
  return Math.min(
    CONTEXT_REMINDER_MAX_TOKENS,
    Math.max(CONTEXT_REMINDER_MIN_TOKENS, Math.floor(budget.hardLimit * CONTEXT_REMINDER_RATIO))
  );
}

export type ReminderTier = 'approaching' | 'at-limit';

/**
 * Which reminders have already been sent in this session.
 *
 * Held by the caller rather than in module state: PI-Desktop keeps two booleans
 * on the runtime instance, and a module-level flag would leak between two
 * sessions running in the same worker — which is exactly the topology ARD D10
 * puts subagents into.
 */
export interface ReminderState {
  approachingClaimed: boolean;
  atLimitClaimed: boolean;
}

export const NO_REMINDERS_CLAIMED: ReminderState = {
  approachingClaimed: false,
  atLimitClaimed: false,
};

export interface ReminderDecision {
  tier: ReminderTier;
  text: string;
  /** Caller stores this as the new state; each tier fires at most once. */
  state: ReminderState;
}

/**
 * Decide whether this request carries a budget warning.
 *
 * Each tier fires once per session, and reaching the second tier marks the
 * first as spent — a "you have room to wrap up" notice after "you are out of
 * room" would be noise.
 */
export function selectReminder(
  budget: ContextBudget,
  state: ReminderState = NO_REMINDERS_CLAIMED
): ReminderDecision | undefined {
  const remaining = remainingTokens(budget);
  if (remaining <= CONTEXT_FALLBACK_REMINDER_TOKENS && !state.atLimitClaimed) {
    return {
      tier: 'at-limit',
      text: AT_LIMIT_REMINDER,
      // The first tier is pointless once the second has fired.
      state: { approachingClaimed: true, atLimitClaimed: true },
    };
  }
  if (remaining > reminderThreshold(budget) || state.approachingClaimed) return undefined;
  return {
    tier: 'approaching',
    text: approachingReminder(remaining),
    state: { ...state, approachingClaimed: true },
  };
}

/**
 * Reminder wording.
 *
 * PI-Desktop tells the model it may call a `new_context` tool to start the new
 * window itself. That tool is not ported here: it is a real tool registration,
 * which belongs to P1's registry, and naming a tool the model cannot call is
 * the failure the prompt slot table already refuses (`plugins/prompt/
 * segments.ts`). The wording below therefore stops at "start closing out".
 *
 * ## Placement, and why it is not decided here
 *
 * PI-Desktop appends the reminder to `context.systemPrompt`
 * (`runtime.ts:4160`). That is the one placement that invalidates the whole
 * cached prefix for the request, because the system prompt is the prefix. It
 * costs PI-Desktop at most two cache misses per session (each tier fires once),
 * so it is not a bug there — but ARD D9 makes our hit rate a gate, and
 * appending the same text as a trailing message instead would keep the prefix
 * byte-identical. The caller chooses; this module only says what to say.
 */
export function approachingReminder(remaining: number): string {
  return [
    '<context_budget>',
    `About ${remaining.toLocaleString('en-US')} tokens of working context remain before this conversation is compacted.`,
    'Start closing out: write anything durable to files, and prefer targeted reads over broad exploration.',
    '</context_budget>',
  ].join('\n');
}

export const AT_LIMIT_REMINDER = [
  '<context_budget>',
  'The working context is at its limit: the next request compacts this conversation automatically.',
  'Write down now, in this turn, whatever must survive — file paths, decisions, and the exact next step — because unsummarized detail will not be available afterwards.',
  '</context_budget>',
].join('\n');
