import type { ChatBlock, ChatMessage } from '@/stores/chatSessions';
import { formatThoughtRow } from './turnTiming';

/**
 * T-05 tool-row pure view model (A07 screen 5, groups A-F). Three layers:
 *
 *  1. pairing   — `pairToolBlocks` matches `tool_call`/`tool_result` blocks
 *     by `toolCallId` (results are never assumed adjacent: parallel tool use
 *     lands as call A, call B, result A, result B; `historyReader.ts` replay
 *     keeps them adjacent, but this function does not rely on either shape).
 *  2. grouping  — `groupTimeline` folds one assistant message's blocks into
 *     an ordered list of text / question / permission / toolGroup items.
 *  3. rows      — `deriveToolRowView` / `deriveAggregateRow` /
 *     `deriveToolGroupRows` turn a tool group into the rows `ToolRows.tsx`
 *     (T-05 batch 2) renders.
 *
 * No React, no `window` — every decision here is unit-tested directly.
 */

// ---------------------------------------------------------------------------
// 1. Pairing layer
// ---------------------------------------------------------------------------

export type ToolRunStatus = 'running' | 'ok' | 'failed';

export interface ToolRun {
  toolCallId: string;
  /** Index of the `tool_call` block within `message.blocks` — grouping/order anchor. */
  blockIndex: number;
  blockId: string;
  toolName: string;
  input: unknown;
  status: ToolRunStatus;
  /** Normalized `tool_result` output text; undefined when there is no result yet or no body. */
  output?: string;
  /** Error text for a failed run (store carries it on `tool_result.text`). */
  errorText?: string;
}

/**
 * Pair `tool_call` / `tool_result` blocks by `toolCallId`.
 *  - No result yet -> 'running'; `toolOk === false` -> 'failed'; else 'ok'.
 *  - An orphan `tool_result` (no matching call) is dropped, not turned into a row.
 *  - Preserves `tool_call` appearance order.
 */
export function pairToolBlocks(blocks: readonly ChatBlock[]): ToolRun[] {
  const resultsByCallId = new Map<string, ChatBlock>();
  for (const block of blocks) {
    if (
      block.type === 'tool_result' &&
      block.toolCallId &&
      !resultsByCallId.has(block.toolCallId)
    ) {
      resultsByCallId.set(block.toolCallId, block);
    }
  }

  const runs: ToolRun[] = [];
  blocks.forEach((block, blockIndex) => {
    if (block.type !== 'tool_call' || !block.toolCallId) return;
    const result = resultsByCallId.get(block.toolCallId);
    const failed = result ? result.toolOk === false : false;
    runs.push({
      toolCallId: block.toolCallId,
      blockIndex,
      blockId: block.id,
      toolName: block.toolName ?? '',
      input: block.toolInput,
      status: !result ? 'running' : failed ? 'failed' : 'ok',
      output: result ? normalizeToolOutput(result.toolOutput, result.text) : undefined,
      errorText: failed ? result?.text : undefined,
    });
  });
  return runs;
}

/**
 * Normalize a `tool_result.toolOutput` payload to display text: string
 * passes through; `[{type:'text',text}]` joins with `\n`; any other object
 * is `JSON.stringify(_, null, 2)`; an empty result falls back to the error
 * text; both empty yields undefined.
 */
export function normalizeToolOutput(output: unknown, fallbackText?: string): string | undefined {
  const normalized = normalizeRawOutput(output);
  if (normalized) return normalized;
  return fallbackText && fallbackText.length > 0 ? fallbackText : undefined;
}

function normalizeRawOutput(output: unknown): string | undefined {
  if (output == null) return undefined;
  if (typeof output === 'string') return output.length > 0 ? output : undefined;
  if (Array.isArray(output)) {
    const texts = output
      .map((item) => {
        if (item && typeof item === 'object') {
          const part = item as { type?: unknown; text?: unknown };
          if (part.type === 'text' && typeof part.text === 'string') return part.text;
        }
        return undefined;
      })
      .filter((text): text is string => text !== undefined);
    if (texts.length > 0) return texts.join('\n');
    return JSON.stringify(output, null, 2);
  }
  if (typeof output === 'object') return JSON.stringify(output, null, 2);
  return String(output);
}

// ---------------------------------------------------------------------------
// 2. Grouping layer
// ---------------------------------------------------------------------------

export type TimelineItem =
  | { kind: 'text'; block: ChatBlock; blockIndex: number }
  | { kind: 'question'; block: ChatBlock; blockIndex: number }
  | { kind: 'permission'; block: ChatBlock; blockIndex: number }
  /** A contiguous tool/thinking stream (A07's `.ct` group). */
  | { kind: 'toolGroup'; entries: ToolGroupEntry[]; blockIndex: number };

export type ToolGroupEntry =
  | { kind: 'run'; run: ToolRun }
  | { kind: 'thinking'; block: ChatBlock; blockIndex: number };

/**
 * Fold one assistant message's blocks into timeline items.
 *  - `tool_result` blocks never become their own item (absorbed by `pairToolBlocks`).
 *  - `text` / `question` / `permission_request` break the current tool group
 *    (A07 :2515 — 10px gap between body copy and a tool group).
 *  - `thinking` never breaks a group; it joins as a stream entry (A07 :2370:
 *    "a Thought briefly line can sit inside the detail stream"). A group made
 *    of only `thinking` entries still becomes its own `toolGroup` item so it
 *    can render as a standalone Thought row.
 */
export function groupTimeline(message: ChatMessage): TimelineItem[] {
  const blocks = message.blocks;
  if (blocks.length === 0) return [];

  const runs = pairToolBlocks(blocks);
  const runByBlockId = new Map(runs.map((run) => [run.blockId, run]));

  const items: TimelineItem[] = [];
  let currentGroup: ToolGroupEntry[] = [];
  let currentGroupBlockIndex: number | null = null;

  const flush = () => {
    if (currentGroup.length > 0 && currentGroupBlockIndex !== null) {
      items.push({ kind: 'toolGroup', entries: currentGroup, blockIndex: currentGroupBlockIndex });
    }
    currentGroup = [];
    currentGroupBlockIndex = null;
  };

  blocks.forEach((block, blockIndex) => {
    switch (block.type) {
      case 'text':
        flush();
        items.push({ kind: 'text', block, blockIndex });
        break;
      case 'question':
        flush();
        items.push({ kind: 'question', block, blockIndex });
        break;
      case 'permission_request':
        flush();
        items.push({ kind: 'permission', block, blockIndex });
        break;
      case 'thinking':
        if (currentGroupBlockIndex === null) currentGroupBlockIndex = blockIndex;
        currentGroup.push({ kind: 'thinking', block, blockIndex });
        break;
      case 'tool_call': {
        const run = runByBlockId.get(block.id);
        if (!run) break;
        if (currentGroupBlockIndex === null) currentGroupBlockIndex = blockIndex;
        currentGroup.push({ kind: 'run', run });
        break;
      }
      default:
        break;
    }
  });

  flush();
  return items;
}

// ---------------------------------------------------------------------------
// 3. Row/view layer
// ---------------------------------------------------------------------------

export type ToolRowBody = 'output' | 'detail' | 'thinking' | 'stats';

export interface ToolRowView {
  /** React key: block id (aggregate rows use `${firstBlockId}~agg`). */
  key: string;
  verb: string;
  arg?: string;
  /** Running rows use the present-tense verb and never show a chevron (A07 :2331). */
  running: boolean;
  failed: boolean;
  /** Only a row with a body can expand; always false while running. */
  expandable: boolean;
  body?: ToolRowBody;
  /** Body text when `body === 'output'`. */
  output?: string;
  /** Scroll-window class when `body === 'output'` (legacy sign-off values). */
  outputMaxHeightClass?: string;
  /**
   * Structured input text, rendered above the output body when present
   * (T-05 adversarial-review fix #3) — only set when the raw `toolInput` has
   * fields the one-line `arg` summary doesn't already show.
   */
  input?: string;
  /** Scroll-window class for `input` — always 240px, independent of tool. */
  inputMaxHeightClass?: string;
  /** Detail rows when `body === 'detail'` — flat, never indented further. */
  detail?: ToolRowView[];
  /** Read row's clickable file target (A07 F①). */
  link?: FileLinkTarget;
  /** Grep/Glob row's raw output for the hit-list popover (A07 F②); parsing is `toolHits.parseHitList`'s job. */
  hitSource?: string;
  toolName?: string;
  toolCallId?: string;
}

export interface FileLinkTarget {
  path: string;
  line?: number;
  endLine?: number;
}

export interface ToolCardOptions {
  /** Repo name tail ("… in ai-client"). Basename of `workspace.path`; omit to skip the tail. */
  repoName?: string | null;
}

/** Injected thinking-duration lookup, shared by the group/aggregate row builders. */
interface ThinkingRowOptions {
  thinkingDurationMs?: (blockId: string) => number | null | undefined;
  isStreamingBlockId?: string | null;
}

/** Single call row. A failed run always forces `body: 'output'` (sign-off ②: failures auto-expand). */
export function deriveToolRowView(run: ToolRun, options: ToolCardOptions = {}): ToolRowView {
  const running = run.status === 'running';
  const failed = run.status === 'failed';
  const verb = toolVerb(run.toolName, running);
  const arg = formatToolArg(run, options);
  const link = deriveFileLink(run) ?? undefined;
  const hitSource = isHitListTool(run.toolName) ? run.output : undefined;

  const showOutputBody = !running && (failed || Boolean(run.output));
  // A running call's input can still change before it settles, so the input
  // segment only appears once the call is done (T-05 adversarial fix #3).
  const inputBody = running ? undefined : deriveToolInputBody(run);
  const expandable = showOutputBody || Boolean(inputBody);

  return {
    key: run.blockId,
    verb,
    arg,
    running,
    failed,
    expandable,
    body: showOutputBody ? 'output' : undefined,
    output: showOutputBody ? run.output : undefined,
    outputMaxHeightClass: showOutputBody ? outputMaxHeightClass(run.toolName) : undefined,
    input: inputBody,
    inputMaxHeightClass: inputBody ? INPUT_MAX_HEIGHT_CLASS : undefined,
    link,
    hitSource,
    toolName: run.toolName,
    toolCallId: run.toolCallId,
  };
}

/**
 * Fields already surfaced in the one-line `arg` summary per tool — anything
 * beyond this list means the raw input carries more than the summary shows
 * (Edit's old_string/new_string, TodoWrite's todo list, Task's prompt, …), so
 * the row also gets a full input body. An unrecognized tool name defaults to
 * an empty list: we can't know what its `arg` format covers, so its input is
 * always shown in full once it has any field at all.
 */
const ARG_COVERED_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Read: ['file_path', 'offset', 'limit'],
  NotebookRead: ['file_path', 'offset', 'limit'],
  Grep: ['pattern'],
  Glob: ['pattern'],
  WebSearch: ['query'],
  WebFetch: ['url'],
  Edit: ['file_path'],
  MultiEdit: ['file_path'],
  Write: ['file_path'],
  NotebookEdit: ['file_path'],
  Bash: ['description', 'command'],
  BashOutput: ['description', 'command'],
  KillShell: ['description', 'command'],
  Task: ['description', 'subagent_type'],
};

/**
 * Full structured input body (T-05 adversarial-review fix #3) — only
 * generated when the raw `toolInput` is a non-empty structured value whose
 * fields aren't already fully covered by the `arg` summary. Serialized the
 * same way as tool output (`normalizeRawOutput`).
 */
function deriveToolInputBody(run: ToolRun): string | undefined {
  const rec = asRecord(run.input);
  if (!rec) return undefined;
  const keys = Object.keys(rec);
  if (keys.length === 0) return undefined;
  const covered = new Set(ARG_COVERED_FIELDS[run.toolName] ?? []);
  const hasExtra = keys.some((key) => !covered.has(key));
  if (!hasExtra) return undefined;
  return normalizeRawOutput(run.input);
}

function isHitListTool(toolName: string): boolean {
  return toolName === 'Grep' || toolName === 'Glob';
}

export const AGGREGATE_VERB: VerbPair = { done: 'Explored', running: 'Exploring' };

/**
 * Aggregate row for a run of `explore`-class calls. Only meant to be called
 * once the caller (`deriveToolGroupRows`) has already decided the segment
 * qualifies (>= 2 explore runs) — this function does not re-check that.
 * `deriveToolGroupRows` (T-05 adversarial fix #1) now only ever passes a
 * *completed* prefix (no running call), so `running` here is a defensive
 * fallback rather than the normal path — a running call always renders as
 * its own standalone row instead of joining the aggregate.
 *  - N = Read/NotebookRead run count, deduped by `file_path`.
 *  - M = Grep/Glob/WebSearch run count.
 *  - A zero segment is omitted; singular/plural follow the count.
 *  - `failed` is true when any child call's `toolOk === false` (T-05
 *    adversarial fix #2) — `ToolRows.tsx`'s existing `defaultOpen={view.failed}`
 *    chain then auto-expands the row, same as a single failed call.
 *  - `detail` mirrors the entries' original order (thinking included, un-timed
 *    here — `deriveToolGroupRows` re-stamps thinking rows with real duration).
 */
export function deriveAggregateRow(
  entries: readonly ToolGroupEntry[],
  options: ToolCardOptions = {}
): ToolRowView {
  const runEntries = entries.filter(
    (entry): entry is Extract<ToolGroupEntry, { kind: 'run' }> => entry.kind === 'run'
  );
  const readEntries = runEntries.filter((entry) => classifyTool(entry.run.toolName) === 'read');
  const searchEntries = runEntries.filter((entry) => classifyTool(entry.run.toolName) === 'search');

  const uniqueFiles = new Set<string>();
  for (const entry of readEntries) {
    const path = stringField(asRecord(entry.run.input), 'file_path');
    uniqueFiles.add(path ?? entry.run.toolCallId);
  }
  const fileCount = uniqueFiles.size;
  const searchCount = searchEntries.length;
  const running = runEntries.some((entry) => entry.run.status === 'running');
  const failed = runEntries.some((entry) => entry.run.status === 'failed');

  const segments: string[] = [];
  if (fileCount > 0) segments.push(`${fileCount} file${fileCount === 1 ? '' : 's'}`);
  if (searchCount > 0) segments.push(`${searchCount} search${searchCount === 1 ? '' : 'es'}`);

  const firstEntry = entries[0];
  const firstBlockId = firstEntry
    ? firstEntry.kind === 'run'
      ? firstEntry.run.blockId
      : firstEntry.block.id
    : 'empty';

  return {
    key: `${firstBlockId}~agg`,
    verb: running ? AGGREGATE_VERB.running : AGGREGATE_VERB.done,
    arg: segments.length > 0 ? segments.join(', ') : undefined,
    running,
    failed,
    expandable: !running,
    body: running ? undefined : 'detail',
    detail: running ? undefined : entries.map((entry) => buildEntryRow(entry, options)),
  };
}

/**
 * One tool group -> its top-level rows.
 *  - Split entries into contiguous "explore" segments (thinking may sit in
 *    the middle without breaking the segment) and standalone action items,
 *    in original order.
 *  - Only the segment's *completed* leading prefix (thinking allowed inside
 *    it, but no running call — a running call has no paired result yet, so
 *    it always ends the prefix) can aggregate; >= 2 completed runs in that
 *    prefix becomes one aggregate row + detail, exactly 1 does not aggregate
 *    (sign-off ②/A07 :2348) and renders as its own row. Anything from the
 *    first running call onward (T-05 adversarial fix #1) renders as
 *    standalone rows in original order instead — a running call keeps its
 *    present-tense verb / no-chevron shape (batch 1) instead of being
 *    swallowed into a row that hasn't actually finished.
 *  - action-class runs (Edit/Write/Bash/TodoWrite/unknown/…) are always
 *    their own row (A07 :1769-1772).
 *  - A standalone thinking run (no adjacent explore run) becomes its own
 *    Thought row via `turnTiming.formatThoughtRow`.
 */
export function deriveToolGroupRows(
  entries: readonly ToolGroupEntry[],
  options: ToolCardOptions & ThinkingRowOptions = {}
): ToolRowView[] {
  const { thinkingDurationMs, isStreamingBlockId, ...cardOptions } = options;
  const thinkingOptions: ThinkingRowOptions = { thinkingDurationMs, isStreamingBlockId };

  const rows: ToolRowView[] = [];
  const pushStandaloneRow = (item: ToolGroupEntry) => {
    rows.push(
      item.kind === 'run'
        ? deriveToolRowView(item.run, cardOptions)
        : buildThoughtRow(item.block, thinkingOptions)
    );
  };

  let i = 0;
  while (i < entries.length) {
    const entry = entries[i];
    if (entry.kind === 'run' && classifyTool(entry.run.toolName) === 'action') {
      rows.push(deriveToolRowView(entry.run, cardOptions));
      i += 1;
      continue;
    }

    let j = i;
    const segment: ToolGroupEntry[] = [];
    while (j < entries.length) {
      const candidate = entries[j];
      const isExploreRun =
        candidate.kind === 'run' && classifyTool(candidate.run.toolName) !== 'action';
      if (candidate.kind === 'thinking' || isExploreRun) {
        segment.push(candidate);
        j += 1;
      } else {
        break;
      }
    }

    // A running call (no paired result) always stops the aggregatable
    // prefix — everything from that point on renders standalone below.
    let prefixEnd = 0;
    while (prefixEnd < segment.length) {
      const candidate = segment[prefixEnd];
      if (candidate.kind === 'run' && candidate.run.status === 'running') break;
      prefixEnd += 1;
    }
    const completedPrefix = segment.slice(0, prefixEnd);
    const remainder = segment.slice(prefixEnd);

    const completedRunCount = completedPrefix.filter((item) => item.kind === 'run').length;
    if (completedRunCount >= 2) {
      const aggregate = deriveAggregateRow(completedPrefix, cardOptions);
      rows.push(applyThinkingDurations(aggregate, completedPrefix, thinkingOptions));
    } else {
      completedPrefix.forEach(pushStandaloneRow);
    }
    remainder.forEach(pushStandaloneRow);

    i = j;
  }
  return rows;
}

function buildEntryRow(entry: ToolGroupEntry, options: ToolCardOptions): ToolRowView {
  if (entry.kind === 'run') return deriveToolRowView(entry.run, options);
  return buildThoughtRow(entry.block, {});
}

function buildThoughtRow(block: ChatBlock, options: ThinkingRowOptions): ToolRowView {
  const streaming = options.isStreamingBlockId != null && options.isStreamingBlockId === block.id;
  const durationMs = options.thinkingDurationMs ? options.thinkingDurationMs(block.id) : undefined;
  const { verb, arg } = formatThoughtRow({ durationMs, streaming });
  const hasText = Boolean(block.text && block.text.length > 0);
  const showBody = !streaming && hasText;
  // An empty (no-text) block renders as a bare, non-expandable row — no
  // chevron, nothing to open. This is a deliberate behavior change from an
  // earlier expandable-but-empty placeholder shell: the bare row is the
  // honest Cursor form and was approved & registered in the T-05 ledger
  // (see `deriveToolGroupRows` empty-block test below for the locked case).
  return {
    key: block.id,
    verb,
    arg,
    running: streaming,
    failed: false,
    expandable: showBody,
    body: showBody ? 'thinking' : undefined,
    output: showBody ? block.text : undefined,
  };
}

/** Re-stamp an aggregate row's detail thinking entries with real duration/streaming info. */
function applyThinkingDurations(
  row: ToolRowView,
  entries: readonly ToolGroupEntry[],
  options: ThinkingRowOptions
): ToolRowView {
  if (!row.detail) return row;
  const detail = row.detail.map((detailRow, index) => {
    const entry = entries[index];
    return entry?.kind === 'thinking' ? buildThoughtRow(entry.block, options) : detailRow;
  });
  return { ...row, detail };
}

// ---------------------------------------------------------------------------
// 4. Verb / argument formatting
// ---------------------------------------------------------------------------

export interface VerbPair {
  done: string;
  running: string;
}

/** A07 :2539 verb table, plus our own `Edited` (A07-endorsed) / `Delegated` / `Fetched` additions. */
export const TOOL_VERBS: Readonly<Record<string, VerbPair>> = {
  Read: { done: 'Read', running: 'Reading' },
  NotebookRead: { done: 'Read', running: 'Reading' },
  Grep: { done: 'Grepped', running: 'Grepping' },
  Glob: { done: 'Searched files', running: 'Searching files' },
  WebSearch: { done: 'Searched', running: 'Searching' },
  WebFetch: { done: 'Fetched', running: 'Fetching' },
  Edit: { done: 'Edited', running: 'Editing' },
  MultiEdit: { done: 'Edited', running: 'Editing' },
  Write: { done: 'Edited', running: 'Editing' },
  NotebookEdit: { done: 'Edited', running: 'Editing' },
  Bash: { done: 'Ran', running: 'Running' },
  BashOutput: { done: 'Ran', running: 'Running' },
  KillShell: { done: 'Ran', running: 'Running' },
  TodoWrite: { done: 'Planned', running: 'Planning' },
  ExitPlanMode: { done: 'Planned', running: 'Planning' },
  Task: { done: 'Delegated', running: 'Delegating' },
};

export const UNKNOWN_TOOL_VERB: VerbPair = { done: 'Ran', running: 'Running' };

export function toolVerb(toolName: string, running: boolean): string {
  const pair = TOOL_VERBS[toolName] ?? UNKNOWN_TOOL_VERB;
  return running ? pair.running : pair.done;
}

export type ToolClass = 'read' | 'search' | 'action';

const READ_TOOL_NAMES = new Set(['Read', 'NotebookRead']);
const SEARCH_TOOL_NAMES = new Set(['Grep', 'Glob', 'WebSearch']);

/** Decides whether a tool participates in aggregation, and which bucket it counts into. */
export function classifyTool(toolName: string): ToolClass {
  if (READ_TOOL_NAMES.has(toolName)) return 'read';
  if (SEARCH_TOOL_NAMES.has(toolName)) return 'search';
  return 'action';
}

function asRecord(input: unknown): Record<string, unknown> | undefined {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return undefined;
}

function stringField(rec: Record<string, unknown> | undefined, field: string): string | undefined {
  const value = rec?.[field];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberField(rec: Record<string, unknown> | undefined, field: string): number | undefined {
  const value = rec?.[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Argument text. Never contains a literal newline (truncation is CSS's job, not this function's). */
export function formatToolArg(run: ToolRun, options: ToolCardOptions = {}): string | undefined {
  const rec = asRecord(run.input);
  const repoName = options.repoName;

  let raw: string | undefined;
  switch (run.toolName) {
    case 'Read':
    case 'NotebookRead': {
      const path = stringField(rec, 'file_path');
      if (path) {
        const offset = numberField(rec, 'offset');
        if (offset != null) {
          const limit = numberField(rec, 'limit');
          const endLine = limit != null ? offset + limit - 1 : offset;
          raw = `${shortPath(path)} L${offset}-${endLine}`;
        } else {
          raw = shortPath(path);
        }
      }
      break;
    }
    case 'Grep':
    case 'Glob': {
      const pattern = stringField(rec, 'pattern');
      raw = pattern && repoName ? `${pattern} in ${repoName}` : pattern;
      break;
    }
    case 'WebSearch':
      raw = stringField(rec, 'query');
      break;
    case 'WebFetch':
      raw = stringField(rec, 'url');
      break;
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit': {
      const path = stringField(rec, 'file_path');
      raw = path ? shortPath(path) : undefined;
      break;
    }
    case 'Bash':
    case 'BashOutput':
    case 'KillShell':
      raw = stringField(rec, 'description') ?? stringField(rec, 'command');
      break;
    case 'TodoWrite':
    case 'ExitPlanMode':
      raw = 'next moves';
      break;
    case 'Task':
      raw = stringField(rec, 'description') ?? stringField(rec, 'subagent_type');
      break;
    default:
      raw =
        stringField(rec, 'command') ??
        stringField(rec, 'description') ??
        stringField(rec, 'path') ??
        stringField(rec, 'file_path') ??
        stringField(rec, 'pattern') ??
        stringField(rec, 'query') ??
        stringField(rec, 'prompt') ??
        run.toolName;
  }

  if (raw == null) return undefined;
  return raw.replace(/[\r\n]+/g, ' ');
}

/** Read row's clickable target: `{file_path, offset, limit}` -> `{path, line, endLine}`. */
export function deriveFileLink(run: ToolRun): FileLinkTarget | null {
  if (run.toolName !== 'Read' && run.toolName !== 'NotebookRead') return null;
  const rec = asRecord(run.input);
  const path = stringField(rec, 'file_path');
  if (!path) return null;

  const target: FileLinkTarget = { path };
  const offset = numberField(rec, 'offset');
  if (offset != null) {
    const limit = numberField(rec, 'limit');
    target.line = offset;
    target.endLine = limit != null ? offset + limit - 1 : offset;
  }
  return target;
}

/** Short path: keep the last `segments` path components (default 2). */
export function shortPath(path: string, segments: number = 2): string {
  if (!path) return path;
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length <= segments) return parts.join('/');
  return parts.slice(-segments).join('/');
}

/** `workspace.path` -> repo name (basename, trailing slash / Windows backslash tolerant). */
export function deriveRepoName(workspacePath: string | null | undefined): string | null {
  if (!workspacePath) return null;
  const normalized = workspacePath.replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = normalized.split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : null;
}

const BASH_TOOL_NAMES = new Set(['Bash', 'BashOutput', 'KillShell']);

/** Output body scroll window (legacy sign-off ② values): Bash-family 46vh, everything else 60vh. */
export function outputMaxHeightClass(toolName: string): string {
  return BASH_TOOL_NAMES.has(toolName) ? 'max-h-[46vh]' : 'max-h-[60vh]';
}

/** Input body scroll window (T-05 adversarial-review fix #3) — a fixed 240px tier, independent of tool. */
export const INPUT_MAX_HEIGHT_CLASS = 'max-h-[240px]';

export function inputMaxHeightClass(): string {
  return INPUT_MAX_HEIGHT_CLASS;
}
