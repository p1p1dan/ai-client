/**
 * Decision 212 (user, 2026-11-09): a subagent is ONE step in the transcript,
 * drawn like every other step — its name, what it was asked to do, and one
 * `⎿` line of how it is doing — never the icons and the long list of its own
 * steps it used to open into. The session rail's 「子代理」 card and the
 * subagent's own conversation are where those live; a click on the line opens
 * the conversation.
 *
 * The words are Claude Code's (2.1.273, `n1e` / `vsr` / `Lrn`):
 *
 *   Explore(Map the calib code)          the type names the step; general-purpose is `Agent`
 *     ⎿ Initializing…                   before its first tool call
 *     ⎿ Read(src/a.ts) · 12 tool uses   working: its newest call (the CLI lists the
 *                                        last three; one line here, the user's ruling)
 *     ⎿ Done (12 tool uses · 45.2k tokens · 1m 3s)
 *
 * Pure: the call's row and its lane in, the words out.
 */

import { stepLabel } from './stepPresentation';
import type { SubagentLane } from './subagentActivityModel';
import { deriveToolRowView, type ToolRowView } from './toolCard';
import { formatWorkedForDuration } from './turnTiming';

type Translate = (key: string, params?: Record<string, string | number>) => string;

type LaneToolRow = Extract<SubagentLane['rows'][number], { kind: 'tool' }>;

export type DelegationResultTone = 'muted' | 'bad';

export interface DelegationLine {
  /** The step's name: the subagent's type (`Explore`), `Agent` for a general-purpose one. */
  name: string;
  /** What it was asked to do: the call's description. */
  description: string | null;
  /** The one `⎿` line. */
  result: { text: string; tone: DelegationResultTone };
  /** The child whose conversation a click opens; null until the engine names it. */
  childId: string | null;
  /** Still working after its call settled (decision 202): it does not hold the turn. */
  background: boolean;
}

/** The CLI's default agent type, which it names `Agent` rather than by type. */
const GENERAL_PURPOSE = 'general-purpose';

/** `Explore`, or `Agent` for a general-purpose subagent or one of no known type (CLI `Lrn`). */
export function delegationName(agentType: string | null | undefined): string {
  return agentType && agentType !== GENERAL_PURPOSE ? agentType : 'Agent';
}

/** `45.2k` / `1.2M`, the CLI's compact count (`us`); `812` under a thousand. */
export function compactTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(tokens);
}

/** A lane's tool call as the transcript writes a step: `Read(src/a.ts)`. */
function stepWordsOf(row: LaneToolRow, t: Translate): string {
  const view = deriveToolRowView(
    {
      toolCallId: row.toolCallId,
      blockIndex: 0,
      blockId: `lane-${row.toolCallId}`,
      toolName: row.name,
      input: row.input,
      status: row.status === 'stopped' ? 'failed' : row.status,
    },
    { t }
  );
  const label = stepLabel(view);
  return view.arg && view.title === undefined ? `${label}(${view.arg})` : label;
}

function laneTools(lane: SubagentLane | null): LaneToolRow[] {
  return (lane?.rows ?? []).filter((row): row is LaneToolRow => row.kind === 'tool');
}

/** `1 tool use` / `12 tool uses`. */
function toolUsesWords(count: number): string {
  return count === 1 ? '1 tool use' : `${count} tool uses`;
}

/** How many calls it made: the engine's own count once it reports one, else the ones seen. */
function toolUseCount(lane: SubagentLane | null): number {
  const seen = laneTools(lane).length + (lane?.droppedRows ?? 0);
  return lane?.report?.totalToolUseCount ?? lane?.usage?.toolUses ?? seen;
}

/** Working: its running call (else its newest), and how many it has made. */
function workingWords(lane: SubagentLane | null, t: Translate): string {
  const tools = laneTools(lane);
  const row = [...tools].reverse().find((item) => item.status === 'running') ?? tools.at(-1);
  const now = row ? stepWordsOf(row, t) : (lane?.progress?.description ?? null);
  if (!now) return 'Initializing…';
  const count = toolUseCount(lane);
  return count > 1 ? `${now} · ${toolUsesWords(count)}` : now;
}

/** `Done (12 tool uses · 45.2k tokens · 1m 3s)`; the parts nothing measured are left out. */
function doneWords(lane: SubagentLane | null): string {
  const toolUses = toolUseCount(lane);
  const tokens = lane?.report?.totalTokens ?? lane?.usage?.totalTokens;
  const durationMs =
    lane?.report?.totalDurationMs ??
    lane?.usage?.durationMs ??
    (lane?.startedAt != null && lane.endedAt != null ? lane.endedAt - lane.startedAt : undefined);
  const parts: string[] = [];
  if (toolUses > 0) parts.push(toolUsesWords(toolUses));
  if (tokens !== undefined && tokens > 0) parts.push(`${compactTokens(tokens)} tokens`);
  if (durationMs !== undefined && durationMs >= 0) parts.push(formatWorkedForDuration(durationMs));
  return parts.length > 0 ? `Done (${parts.join(' · ')})` : 'Done';
}

/** The first line of what came back, for a call that failed. */
function firstLine(text: string | undefined): string | null {
  return (
    text
      ?.split(/\r\n|\n|\r/)
      .map((part) => part.trim())
      .find(Boolean) ?? null
  );
}

export function deriveDelegationLine(
  view: ToolRowView,
  lane: SubagentLane | null,
  t: Translate
): DelegationLine {
  const live = view.running || lane?.status === 'running';
  const background = Boolean(view.backgroundRunning) || (!view.running && live);
  let result: DelegationLine['result'];
  if (live && lane?.pendingPermission) {
    result = {
      text: t('Waiting for your approval: {{tool}}', {
        tool: stepWordsOf(
          {
            kind: 'tool',
            toolCallId: 'pending',
            name: lane.pendingPermission.toolName,
            status: 'running',
          },
          t
        ),
      }),
      tone: 'muted',
    };
  } else if (live) {
    result = { text: workingWords(lane, t), tone: 'muted' };
  } else if (view.failed || lane?.status === 'failed' || lane?.status === 'truncated') {
    result = { text: firstLine(view.output) ?? 'Failed', tone: 'bad' };
  } else if (lane?.status === 'cancelled' || lane?.status === 'stopped' || view.outcome) {
    result = { text: 'Interrupted', tone: 'muted' };
  } else {
    result = { text: doneWords(lane), tone: 'muted' };
  }
  return {
    name: delegationName(lane?.agentType),
    description: view.arg ?? lane?.description ?? null,
    result,
    childId: lane?.agentId ?? null,
    background,
  };
}
