/**
 * Decision 208, terminal style: how one step reads as Claude Code's CLI draws
 * it — a bullet coloured by how the call went, the tool's own English name,
 * and a `⎿` line with what came of it.
 *
 * Pure: a `ToolRowView` (or a turn item) in, words and states out. The React
 * leaves (`ToolRows.tsx`, `MessageTimeline.tsx`) only paint what this says.
 */

import type { RunStatus } from '@/components/ui/status-icon';
import type { TurnItem } from './chatTurn';
import { dshCompactCommandRowView } from './dshTimelineRowModel';
import { MCP_TOOL_PREFIX } from './piToolNames';
import {
  deriveQuestionCardState,
  PERMISSION_DENIED,
  PERMISSION_DENIED_STOPPED,
} from './questionCardModel';
import { isDelegationTool, type ToolRowView } from './toolCard';
import { meaningfulLines, SPILLED } from './turnSteps';

type Translate = (key: string, params?: Record<string, string | number>) => string;

/**
 * User ruling 2026-11-03: a step says which tool ran in the tool's own English
 * name, as the CLI does, never translated — and never one word when it ran and
 * another when it was refused (shell rows used to read 「终端」 done but 「运行」
 * refused). Names the CLI shows differently from the API name use the CLI's,
 * except edits: they read `Edit`, the tool's own name (user, 2026-11-03), where
 * the CLI says `Update`.
 */
const STEP_LABELS: Readonly<Record<string, string>> = {
  Bash: 'Bash',
  bash: 'Bash',
  PowerShell: 'PowerShell',
  powershell: 'PowerShell',
  pwsh: 'PowerShell',
  Read: 'Read',
  read: 'Read',
  NotebookRead: 'Read',
  read_image: 'Read',
  Grep: 'Search',
  grep: 'Search',
  Glob: 'Search',
  glob: 'Search',
  find: 'Search',
  ls: 'List',
  Edit: 'Edit',
  MultiEdit: 'Edit',
  NotebookEdit: 'Edit',
  edit: 'Edit',
  Write: 'Write',
  write: 'Write',
  WebFetch: 'Fetch',
  web_fetch: 'Fetch',
  WebSearch: 'Web Search',
  web_search: 'Web Search',
  TodoWrite: 'Update Todos',
  todo_write: 'Update Todos',
};

/** For a tool the table does not name: what its kind says it does. */
const KIND_LABELS: Readonly<Partial<Record<NonNullable<ToolRowView['iconKind']>, string>>> = {
  read: 'Read',
  search: 'Search',
  list: 'List',
  edit: 'Edit',
  web: 'Fetch',
  mcp: 'MCP',
};

/**
 * The bold word a step leads with. A merged step or a plugin's own title is
 * printed as it is (the title already says what happened); otherwise the
 * table, then the kind, then the tool's raw name.
 */
export function stepLabel(view: ToolRowView): string {
  if (view.title !== undefined) return view.title;
  const name = view.toolName ?? '';
  if (Object.hasOwn(STEP_LABELS, name)) return STEP_LABELS[name] as string;
  if (name.startsWith(MCP_TOOL_PREFIX)) return 'MCP';
  const byKind = view.iconKind ? KIND_LABELS[view.iconKind] : undefined;
  return byKind ?? (name || 'Tool');
}

/** Refused by the card the user answered, by the safety review, or by the runtime. */
export function isRefusedStep(view: ToolRowView): boolean {
  return (
    view.outcome === 'refused' ||
    view.reviewDenied === true ||
    view.permissionVerb === PERMISSION_DENIED ||
    view.permissionVerb === PERMISSION_DENIED_STOPPED
  );
}

/**
 * The bullet's state. The user ruled refusals red like failures (「不要五颜六色」),
 * and the CLI paints a non-zero exit red too; a call that never ran or was cut
 * short is the stopped grey.
 */
export function stepBulletStatus(view: ToolRowView): RunStatus {
  if (view.running) return 'running';
  if (view.failed || isRefusedStep(view)) return 'failed';
  if (typeof view.exitCode === 'number' && view.exitCode !== 0) return 'failed';
  if (view.outcome) return 'stopped';
  return 'success';
}

/** A delegation draws its own lane (`SubagentActivity`), keyed by the call id. */
export function isDelegationRow(view: ToolRowView): boolean {
  return Boolean(view.toolName && isDelegationTool(view.toolName) && view.toolCallId);
}

/**
 * Rows that keep their own drawing in every style: review findings, a
 * delegation's lane, a todo list. They sit in the text column with no bullet.
 */
export function isSpecialStepRow(view: ToolRowView): boolean {
  return Boolean(view.findings) || isDelegationRow(view) || view.iconKind === 'todo';
}

export type TerminalResultTone = 'muted' | 'bad' | 'unknown';

export interface TerminalStepResult {
  lines: string[];
  tone: TerminalResultTone;
  /** Lines the preview leaves out; `… +N lines` opens the whole output. */
  hidden: number;
}

/** The CLI's preview depth: three lines under a step. */
export const TERMINAL_RESULT_LINES = 3;
/** A soft cap so one minified line cannot fill the screen. */
const TERMINAL_LINE_MAX_CHARS = 400;

function clipLine(line: string): string {
  return line.length > TERMINAL_LINE_MAX_CHARS
    ? `${line.slice(0, TERMINAL_LINE_MAX_CHARS - 1)}…`
    : line;
}

/**
 * The `⎿` lines under a step, or `null` for none.
 *
 *  - refused: one line, the decision word and why;
 *  - outcome unknown: the warning the step model already words;
 *  - not run / stopped: none (the row's own word says it);
 *  - failed: the first lines of what it said;
 *  - a settled command: its LAST lines — a build's or a test run's verdict is
 *    at the end (the 2026-10-30 rule `deriveStepResult` follows), up to three.
 */
export function deriveTerminalStepResult(
  view: ToolRowView,
  t: Translate
): TerminalStepResult | null {
  if (view.running) return null;
  if (isRefusedStep(view)) {
    const word = t(
      view.permissionVerb === PERMISSION_DENIED || view.permissionVerb === PERMISSION_DENIED_STOPPED
        ? view.permissionVerb
        : 'Refused'
    );
    const reason =
      view.permissionAutoNote ?? view.reviewNote ?? meaningfulLines(view.output)[0] ?? '';
    return { lines: [reason ? `${word} · ${clipLine(reason)}` : word], tone: 'bad', hidden: 0 };
  }
  if (view.outcome === 'outcomeUnknown') {
    return {
      lines: [
        t(
          'Outcome unknown: the engine stopped before this finished. Check whether it took effect before running it again.'
        ),
      ],
      tone: 'unknown',
      hidden: 0,
    };
  }
  if (view.outcome) return null;
  const all = meaningfulLines(view.output);
  if (view.failed) {
    if (all.length === 0) return null;
    const shown = all.slice(0, TERMINAL_RESULT_LINES).map(clipLine);
    return { lines: shown, tone: 'bad', hidden: all.length - shown.length };
  }
  if (view.iconKind !== 'terminal' || all.length === 0) return null;
  if (all.every((line) => SPILLED.test(line))) {
    return { lines: [t('Large output, open the step to see it')], tone: 'muted', hidden: 0 };
  }
  const shown = all.slice(-TERMINAL_RESULT_LINES).map(clipLine);
  return {
    lines: shown,
    tone: typeof view.exitCode === 'number' && view.exitCode !== 0 ? 'bad' : 'muted',
    hidden: all.length - shown.length,
  };
}

/** The step line's trailing words that the `⎿` line already says. */
export interface SuppressedTails {
  permission: boolean;
  outcome: boolean;
  review: boolean;
}

export function terminalSuppressedTails(view: ToolRowView): SuppressedTails {
  const refused = !view.running && isRefusedStep(view);
  return {
    permission: refused,
    outcome: refused || view.outcome === 'outcomeUnknown',
    review: refused && view.reviewDenied === true,
  };
}

/**
 * Which bullet a turn item gets in the terminal style: `text` (the prose dot),
 * `blank` (an empty bullet column, so the item lines up with the text), or
 * `null` — no wrapper at all, either because the item draws its own column
 * (a tool group's rows) or because it renders nothing here (a live card, a
 * covered end note) and a wrapper would leave an empty gap.
 */
export function terminalItemGutter(
  item: TurnItem,
  options: { endNoteCovered?: boolean } = {}
): 'text' | 'blank' | null {
  switch (item.kind) {
    case 'text':
      return 'text';
    case 'toolGroup':
      return null;
    case 'permission':
      return item.block.resolved === true ? 'blank' : null;
    case 'question':
      return deriveQuestionCardState(item.block) === 'pending' ? null : 'blank';
    case 'notice':
      if (item.message.turnEnd && options.endNoteCovered) return null;
      // Decision 180: a `/compact` command is drawn as the user's own line.
      if (dshCompactCommandRowView(item.message)) return null;
      return 'blank';
    default:
      return 'blank';
  }
}
