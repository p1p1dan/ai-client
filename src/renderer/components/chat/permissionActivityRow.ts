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
 *
 * ## Language
 *
 * The words this file adds AROUND that data are copy, and a Chinese UI must not
 * show them in English. They go through the `t` the component passes in
 * (defaulting to English, which is what the `en` locale wants anyway). The
 * gate's own values — `value`, `origin`, `matchedPattern` — are passed through
 * untouched: they are identifiers from another program, and translating one
 * would invent a name that program never used.
 *
 * Two exceptions, both chat-event-07 / chat-tool-06: `resolution` is a closed
 * enum this app maps onto its own vocabulary (`activity.ts`), so it is looked
 * up in the catalog rather than printed, and `surface` is run through the same
 * display-name function every other surface uses, so an MCP tool is not read as
 * `mcp__server__tool` here and as `server · tool` one row above.
 */
import { englishTranslate, type Translate } from '@shared/i18n';
import { toolDisplayName } from './piToolNames';

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
  /**
   * What the gate was raised over, in whatever vocabulary its producer uses.
   *
   * chat-tool-06: this comment used to promise a POLICY surface (`bash`, `read`,
   * `mcp`, `skill`, `external_directory`) and the self-owned gate does not send
   * one — it sends `request.tool`, i.e. the specific tool name, and for an MCP
   * call that is the wire id `mcp__<server>__<tool>`. The row labels it for
   * reading rather than reprinting the identifier; nothing here matches policy,
   * so the specific name is the more useful of the two anyway.
   */
  surface?: string;
  /**
   * The command / path / skill that was evaluated, as the gate matched it —
   * `policyValue` when the tool's policy vocabulary differs from its path
   * (MCP matches `server:tool`, a skill matches its NAME), else the command or
   * the path.
   */
  value?: string;
  /**
   * The subagent delegation this gate was raised for, when one was. Declared
   * because the store folds the payload verbatim; it is attribution only and
   * says nothing about how widely the decision applies.
   *
   * This is what the native runtime's gate (`activity.ts`) sends for
   * attribution — the legacy `forwarded` / `requesterAgentName` pair below is
   * never set by it. `derivePermissionActivityRow` treats both pairs as the
   * same fact (MODEL-20, 2026-09-19).
   */
  delegationId?: string;
  agentName?: string;
  result?: 'allow' | 'deny';
  /** The plugin's own vocabulary — `user_approved`, `policy_allow`, `gate_error`, … */
  resolution?: string;
  origin?: string;
  matchedPattern?: string;
  /** Legacy backend's attribution pair — see `delegationId` / `agentName` above. */
  forwarded?: boolean;
  requesterAgentName?: string;
}

export function isQuietPermissionActivity(record: PermissionActivityRecord | undefined): boolean {
  return record?.result === 'allow' && !record.resolution?.includes('error');
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

/**
 * `policy_allow` → `policy allow`, then through the catalog.
 *
 * The de-underscored form is the translation KEY, so a resolution this build
 * has a word for reads as that word and one it has never seen still prints
 * something — the plugin's own vocabulary, spaced out — rather than nothing.
 */
function humanizeResolution(resolution: string, t: Translate): string {
  return t(resolution.replace(/_/g, ' '));
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
  record: PermissionActivityRecord,
  t: Translate = englishTranslate
): PermissionActivityRowView {
  // chat-tool-06 — the same label the timeline row and the delegation panel use
  // for the same call. An MCP tool arrives here as `mcp__<server>__<tool>`, and
  // a line a person is meant to read must not be a protocol identifier.
  const raw = record.surface?.trim();
  const surface = raw ? toolDisplayName(raw) : t('request');
  const notes: string[] = [];

  // MODEL-20 (2026-09-19): the legacy backend's plugin set `forwarded` +
  // `requesterAgentName`; the native runtime's gate (activity.ts) sets
  // `delegationId` + `agentName` instead and never touches the legacy pair.
  // A non-empty `delegationId` means the same thing `forwarded` used to mean —
  // this gate was raised for a subagent's call — so both are read here.
  const requesterName = record.requesterAgentName?.trim() || record.agentName?.trim();
  if (record.forwarded || record.delegationId?.trim()) {
    // Approving a subagent's request is not the same act as approving one's
    // own, and the two are otherwise indistinguishable in the transcript.
    notes.push(
      requesterName ? t('for subagent {{name}}', { name: requesterName }) : t('for a subagent')
    );
  }

  if (record.resolution?.includes('error')) {
    return {
      requestId: record.requestId,
      tone: 'denied',
      label: t('Permission check failed — {{surface}}', { surface }),
      detail: record.value,
      // chat-event-07 — through the catalog like every other resolution. This
      // branch returned the raw enum, so the row read `gate_error` and the
      // catalog's own entry for it was unreachable code.
      note: humanizeResolution(record.resolution, t),
    };
  }
  if (!record.result) {
    return {
      requestId: record.requestId,
      tone: 'pending',
      label: t('Awaiting approval — {{surface}}', { surface }),
      ...(record.value ? { detail: record.value } : {}),
      ...(notes.length > 0 ? { note: notes.join(' · ') } : {}),
    };
  }

  const byUser = record.resolution ? USER_RESOLUTIONS.has(record.resolution) : false;
  const tone: PermissionActivityTone =
    record.result === 'deny' ? 'denied' : byUser ? 'allowed' : 'auto';

  if (record.resolution && !byUser) notes.push(humanizeResolution(record.resolution, t));
  if (record.matchedPattern)
    notes.push(t('matched {{pattern}}', { pattern: record.matchedPattern }));
  if (record.origin) notes.push(t('from {{origin}}', { origin: record.origin }));

  return {
    requestId: record.requestId,
    tone,
    label:
      record.result === 'deny'
        ? t('Denied {{surface}}', { surface })
        : t('Allowed {{surface}}', { surface }),
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
