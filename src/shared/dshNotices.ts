// New in dsh-rebase P1-4d1

/**
 * How the timeline shows a DSH `user/message` nobody typed: a background
 * job's or a subagent's account, a goal round, the engine's own reminders
 * (dsh-rebase decisions 072 rules 3-4, 081, 099 rules 7-8; plan P1-7 shard 03
 * §6). The bridge's live events and the history projection both read this
 * table, so a row replays the way it streamed.
 *
 * A message whose `source.kind` is not `user` ends up as one of three things:
 *   - the head of a turn the engine started by itself (`dshTurnOrigin`): the
 *     first such message the turn took in, when nothing a person typed came
 *     in with it;
 *   - a one-line notice (`dshNoticeText`), anywhere else;
 *   - nothing: model context (instructions, catalogs, snapshots, reminders)
 *     and accounts the app already shows some other way.
 *
 * No value imports on purpose: the bridge (Node type stripping), the
 * projection library and the renderer all load it.
 */

import type { TurnOrigin } from './types/sessionHistory.ts';

/** `MessageSource.kind` of a goal continuation round (`dsh-goal-round-driver`). */
export const DSH_SOURCE_GOAL = 'goal';
/** `MessageSource.kind` of a background job's completion notice (`dsh-tool-jobs`). */
export const DSH_SOURCE_TOOL_JOBS = 'tool-jobs';
/** `MessageSource.kind` of a continuable subagent's settlement account (`dsh-subagent`). */
export const DSH_SOURCE_SUBAGENT_SETTLED = 'subagent-settled';
/** `MessageSource.kind` of a message another agent addressed to this one (`dsh-subagent`). */
export const DSH_SOURCE_AGENT_MESSAGE = 'agent-message';
/** `ContextForm` of a one-off account of something that happened (`dsh-llm`). */
const NOTICE_FORM = 'notice';

/** `custom.message.customType` of a live notice: `dsh:<source kind>` (decision 099 rule 7). */
export const DSH_NOTICE_CUSTOM_TYPE_PREFIX = 'dsh:';

/**
 * Notice-form sources the timeline never shows (plan P1-7 shard 03 §6.2):
 * the goal bar already says what `tool-goal`'s wrap-up says; every reply's
 * metadata line names its model (`model-selection`, "[model changed]");
 * `repeat-tool-reminder` and `plan-mode` are nudges for the model; and ours —
 * the step ceiling's wrap-up instruction (decision 081) and the hidden retry
 * continuation (decision 028).
 */
const HIDDEN_NOTICE_SOURCES: ReadonlySet<string> = new Set([
  'tool-goal',
  'model-selection',
  'repeat-tool-reminder',
  'plan-mode',
  'aiclient-loop-guard',
  'aiclient-retry',
]);

type Row = Record<string, unknown>;

function recordOf(value: unknown): Row | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Row)
    : undefined;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      const row = recordOf(block);
      return row?.type === 'text' && typeof row.text === 'string' ? row.text : '';
    })
    .join('');
}

/** A message's `source.kind`, or undefined when it has none. */
export function dshSourceKind(source: unknown): string | undefined {
  return nonEmpty(recordOf(source)?.kind);
}

/**
 * What a turn headed by this message was started by, or undefined when the
 * source cannot open a turn by itself. `maxRounds` is the goal's budget as
 * the log last recorded it (`goal/change`), when the caller knows it.
 */
export function dshTurnOrigin(source: unknown, maxRounds?: number): TurnOrigin | undefined {
  const row = recordOf(source);
  const childSessionId = nonEmpty(row?.senderSessionId);
  switch (row?.kind) {
    case DSH_SOURCE_GOAL: {
      const round = typeof row.round === 'number' && Number.isFinite(row.round) ? row.round : 0;
      return {
        kind: 'goal',
        round,
        ...(typeof maxRounds === 'number' && Number.isFinite(maxRounds) ? { maxRounds } : {}),
      };
    }
    case DSH_SOURCE_TOOL_JOBS:
      return { kind: 'job' };
    case DSH_SOURCE_SUBAGENT_SETTLED:
      return { kind: 'subagent', ...(childSessionId ? { childSessionId } : {}) };
    case DSH_SOURCE_AGENT_MESSAGE:
      return { kind: 'agent-message', ...(childSessionId ? { childSessionId } : {}) };
    default:
      return undefined;
  }
}

/**
 * The text of a turn head: DSH's one-line account when the source keeps one,
 * the relayed message itself for `agent-message`, nothing for a goal round
 * (its body is the model's continuation prompt, not something to read).
 */
export function dshTurnHeadText(source: unknown, content: unknown): string {
  const row = recordOf(source);
  if (row?.kind === DSH_SOURCE_GOAL) return '';
  if (row?.kind === DSH_SOURCE_AGENT_MESSAGE) return textOf(content);
  return nonEmpty(row?.summary) ?? textOf(content);
}

/**
 * The one line a message shows as a notice in the middle of a turn, or
 * undefined when the timeline does not show it at all. A relayed message is
 * shown whole; a notice-form source by its summary; unknown notice-form
 * sources are shown too (a later DSH's accounts should not vanish), every
 * other source is model context.
 */
export function dshNoticeText(source: unknown, content: unknown): string | undefined {
  const row = recordOf(source);
  const kind = nonEmpty(row?.kind);
  if (!kind || kind === 'user' || kind === DSH_SOURCE_GOAL || HIDDEN_NOTICE_SOURCES.has(kind))
    return undefined;
  if (kind === DSH_SOURCE_AGENT_MESSAGE) return nonEmpty(textOf(content));
  if (row?.form !== NOTICE_FORM) return undefined;
  return nonEmpty(row.summary) ?? nonEmpty(textOf(content));
}
