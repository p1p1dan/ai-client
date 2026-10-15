/**
 * Tool names differ between the clients (`Read` / `read`, `Bash` / `pwsh`);
 * categories make them comparable. `summarizeEvents` folds a normalized
 * trace into the record's counters, the same rule for both clients.
 */

import type { RunMetrics, ToolCategory, ToolEvent, ToolTally, TraceEvent } from './types.ts';

const CATEGORY_BY_NAME: Record<string, ToolCategory> = {
  read: 'read',
  read_image: 'read',
  notebookread: 'read',
  edit: 'edit',
  multiedit: 'edit',
  notebookedit: 'edit',
  str_replace_editor: 'edit',
  write: 'write',
  bash: 'shell',
  pwsh: 'shell',
  powershell: 'shell',
  bashoutput: 'shell',
  killshell: 'shell',
  killbash: 'shell',
  job_output: 'shell',
  job_kill: 'shell',
  job_list: 'shell',
  grep: 'search',
  glob: 'search',
  ls: 'search',
  webfetch: 'web',
  websearch: 'web',
  web_fetch: 'web',
  web_search: 'web',
  task: 'subagent',
  agent: 'subagent',
  subagent: 'subagent',
  subagent_fork: 'subagent',
  send_message: 'subagent',
  sendmessage: 'subagent',
  list_agents: 'subagent',
  listagents: 'subagent',
  interrupt_agent: 'subagent',
  taskstop: 'subagent',
  todowrite: 'todo',
  todo_write: 'todo',
  taskcreate: 'todo',
  taskupdate: 'todo',
  tasklist: 'todo',
  taskget: 'todo',
  exitplanmode: 'plan',
  exit_plan_mode: 'plan',
  enterplanmode: 'plan',
};

export function toolCategory(name: string): ToolCategory {
  return CATEGORY_BY_NAME[name.toLowerCase()] ?? 'other';
}

/** Shell tools, whose non-zero exits are counted apart from errors. */
export function isShellTool(name: string): boolean {
  return ['bash', 'pwsh', 'powershell'].includes(name.toLowerCase());
}

function tally(): ToolTally {
  return { calls: 0, errors: 0, unknown: 0, nonZeroExits: 0 };
}

function add(target: ToolTally, event: ToolEvent): void {
  target.calls += 1;
  if (event.unknown) target.unknown += 1;
  else if (event.error) target.errors += 1;
  if (!event.error && event.exitCode !== null && event.exitCode !== 0) target.nonZeroExits += 1;
}

type EventMetrics = Omit<
  RunMetrics,
  'durationMs' | 'wallMs' | 'tokens' | 'tokensSource' | 'changes'
>;

/** The main agent's counters; subagent calls are counted apart. */
export function summarizeEvents(events: readonly TraceEvent[]): EventMetrics {
  const tools: EventMetrics['tools'] = {};
  const categories: EventMetrics['categories'] = {};
  const totals = tally();
  let steps = 0;
  let pending = 0;
  let subagentToolCalls = 0;
  for (const event of events) {
    if (event.kind === 'llm') {
      if (!event.subagent) steps += 1;
      continue;
    }
    if (event.subagent) {
      subagentToolCalls += 1;
      continue;
    }
    if (event.pending) pending += 1;
    const byName = tools[event.name] ?? { ...tally(), category: event.category };
    tools[event.name] = byName;
    const byCategory = categories[event.category] ?? tally();
    categories[event.category] = byCategory;
    add(byName, event);
    add(byCategory, event);
    add(totals, event);
  }
  return {
    steps,
    toolCalls: totals.calls,
    toolErrors: totals.errors,
    unknownToolCalls: totals.unknown,
    nonZeroExits: totals.nonZeroExits,
    pendingToolCalls: pending,
    subagentToolCalls,
    tools,
    categories,
  };
}

/** A short, single-line excerpt for traces and logs. */
export function excerpt(text: string, max = 400): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** A tool input with every long string clipped, for the trace. */
export function clipInput(input: unknown, max = 600): unknown {
  if (typeof input === 'string') return input.length > max ? `${input.slice(0, max)}…` : input;
  if (Array.isArray(input)) return input.map((item) => clipInput(item, max));
  if (input && typeof input === 'object') {
    return Object.fromEntries(
      Object.entries(input as Record<string, unknown>).map(([key, value]) => [
        key,
        clipInput(value, max),
      ])
    );
  }
  return input;
}
