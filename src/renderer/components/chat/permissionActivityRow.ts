/**
 * T08-b — the permission plugin's decisions, as a timeline row.
 *
 * ## Why this is in the transcript at all
 *
 * The approval modal answers one question and then disappears. Two things it
 * cannot tell anyone:
 *
 *  - **What was decided, after the fact.** Scrolling back through a turn should
 *    say which tool call was approved and how, not just that a tool ran.
 *  - **The decisions nobody was asked about.** `policy_allow` resolves with no
 *    prompt. Without a row for it there is no evidence anywhere that the call
 *    was gated rather than simply unchecked — and "the permission system is
 *    silently not running" looks exactly the same as "nothing needed approval".
 *
 * ## Discipline
 *
 * Pure, and every string here is DATA that came off a third-party plugin's
 * broadcast. It is returned as plain text for React to escape; nothing in this
 * file or its component may put it into markup directly.
 */

/** One gate, as the plugin described it. Mirrors `PermissionActivityEvent.payload`. */
export interface PermissionActivityRecord {
  requestId: string;
  /**
   * Which broadcast last touched this row. Declared because the store folds the
   * payload verbatim, and an undeclared field that travels anyway is one nobody
   * can find. The row's own wording keys off `result`, not this: a `decision`
   * that somehow carried no result is still an unresolved gate.
   */
  phase?: 'prompt' | 'decision';
  /** e.g. `bash`, `read`, `mcp`, `skill`, `external_directory`. */
  surface?: string;
  /** The command / path / tool name that was evaluated. */
  value?: string;
  agentName?: string;
  result?: 'allow' | 'deny';
  /** The plugin's own vocabulary — `user_approved`, `policy_allow`, `gate_error`, … */
  resolution?: string;
  origin?: string;
  matchedPattern?: string;
  forwarded?: boolean;
  requesterAgentName?: string;
}

/**
 * How loudly to draw the row.
 *
 * `auto` exists so a policy allow can be recorded without shouting: it is an
 * audit line, not a thing the user did, and drawing it like a decision they made
 * would train them to ignore the ones they did make.
 */
export type PermissionActivityTone = 'pending' | 'allowed' | 'denied' | 'auto';

export interface PermissionActivityRowView {
  requestId: string;
  tone: PermissionActivityTone;
  /** Short verb + surface, e.g. `Allowed bash`. */
  label: string;
  /** The command or path, verbatim. Absent when the plugin sent none. */
  detail?: string;
  /** Where the decision came from, when it is worth saying. */
  note?: string;
}

/** `policy_allow` → `policy allow`. Unknown values pass through unchanged. */
function humanizeResolution(resolution: string): string {
  return resolution.replace(/_/g, ' ');
}

/**
 * A resolution the USER produced, as opposed to one a rule produced.
 *
 * Deliberately a small allow-list rather than a test for "policy" in the string:
 * this is a third-party enum, and a resolution this build has never seen must
 * fall on the quiet side. Mislabelling an automatic allow as a user decision is
 * the worse error of the two — it would put words in the user's mouth.
 */
const USER_RESOLUTIONS = new Set(['user_approved', 'user_denied', 'user_denied_with_reason']);

export function derivePermissionActivityRow(
  record: PermissionActivityRecord
): PermissionActivityRowView {
  const surface = record.surface?.trim() || 'request';
  const notes: string[] = [];

  if (record.forwarded) {
    const requester = record.requesterAgentName?.trim();
    // Approving a subagent's request is not the same act as approving one's
    // own, and the two are otherwise indistinguishable in the transcript.
    notes.push(requester ? `for subagent ${requester}` : 'for a subagent');
  }

  if (!record.result) {
    return {
      requestId: record.requestId,
      tone: 'pending',
      label: `Awaiting approval — ${surface}`,
      ...(record.value ? { detail: record.value } : {}),
      ...(notes.length > 0 ? { note: notes.join(' · ') } : {}),
    };
  }

  const byUser = record.resolution ? USER_RESOLUTIONS.has(record.resolution) : false;
  const tone: PermissionActivityTone =
    record.result === 'deny' ? 'denied' : byUser ? 'allowed' : 'auto';

  if (record.resolution && !byUser) notes.push(humanizeResolution(record.resolution));
  if (record.matchedPattern) notes.push(`matched ${record.matchedPattern}`);
  if (record.origin) notes.push(`from ${record.origin}`);

  return {
    requestId: record.requestId,
    tone,
    label: `${record.result === 'deny' ? 'Denied' : 'Allowed'} ${surface}`,
    ...(record.value ? { detail: record.value } : {}),
    ...(notes.length > 0 ? { note: notes.join(' · ') } : {}),
  };
}

/**
 * Merge a newly arrived record onto the one already on screen for the same
 * `requestId`.
 *
 * The plugin broadcasts `prompt` first and `decision` after, and the decision
 * carries the outcome but not always the descriptive fields the prompt carried.
 * Overwriting wholesale would blank the command the user is looking at, so this
 * keeps the earlier value for any key the newer record does not fill.
 *
 * Returns the SAME object when nothing changed — the store folds on reference
 * equality, and a redelivered event must not rebuild the message.
 */
export function mergePermissionActivity(
  previous: PermissionActivityRecord,
  next: PermissionActivityRecord
): PermissionActivityRecord {
  const merged: PermissionActivityRecord = { ...previous };
  let changed = false;
  for (const [key, value] of Object.entries(next) as Array<
    [keyof PermissionActivityRecord, unknown]
  >) {
    if (value === undefined) continue;
    if (merged[key] === value) continue;
    Object.assign(merged, { [key]: value });
    changed = true;
  }
  return changed ? merged : previous;
}
