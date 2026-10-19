/**
 * Decision 203: which running rows offer 「转到后台」. The Claude engine's CLI
 * moves one foreground call to the background on request (its Ctrl+B, the
 * `background_tasks` control): a shell command or a subagent. DSH has no such
 * hand-over (a command moves only when its timeout expires), so its rows never
 * offer it.
 */

import type { ToolRowView } from './toolCard';

/** The Claude Code tools whose running call the CLI registers as a task. */
const BACKGROUNDABLE_TOOLS: ReadonlySet<string> = new Set(['Bash', 'PowerShell', 'Agent', 'Task']);

export function canMoveToBackground(
  view: Pick<ToolRowView, 'running' | 'toolName' | 'toolCallId' | 'backgroundJob'>,
  engine: string | undefined
): boolean {
  return (
    engine === 'claude-sdk' &&
    view.running &&
    view.backgroundJob === undefined &&
    typeof view.toolCallId === 'string' &&
    view.toolCallId.length > 0 &&
    BACKGROUNDABLE_TOOLS.has(view.toolName ?? '')
  );
}
