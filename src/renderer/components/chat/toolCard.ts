import { cn } from '@/lib/utils';
import type { ChatBlock, ChatMessage } from '@/stores/chatSessions';
import { derivePermissionAutoNote, derivePermissionVerb } from './questionCardModel';
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
  /**
   * FB7: the RESOLVED `permission_request` block whose decision settled this
   * call, attached by `joinResolvedPermissions` (never by `pairToolBlocks` --
   * the pairing layer only ever sees one message, and the join's search domain
   * is the whole turn). Absent when the call needed no approval, when the
   * approval is still pending, or when it could not be paired and kept its own
   * timeline item instead (spec §6.3).
   */
  permission?: ChatBlock;
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
 *    (A07 :2515 — 10px gap between body copy and a tool group). A RESOLVED
 *    permission is stitched back into the group it broke one layer up, by
 *    `joinResolvedPermissions` — which runs per turn, not per message, and so
 *    cannot live in this function (FB7, spec §6.3-a).
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
// 2b. Permission join layer (FB7)
// ---------------------------------------------------------------------------

/** The `toolGroup` arm of `TimelineItem`, named so the join can talk about it. */
type ToolGroupItem = Extract<TimelineItem, { kind: 'toolGroup' }>;
/** The `permission` arm of `TimelineItem`. */
type PermissionItem = Extract<TimelineItem, { kind: 'permission' }>;

/**
 * What `joinResolvedPermissions` accepts: everything `groupTimeline` produces,
 * plus an open `notice` arm so a caller that flattens a whole TURN can hand its
 * list straight through. `chatTurn.ts` also stamps `messageId` on every item;
 * the join preserves whatever the caller added, because it only ever rebuilds
 * the two fields it touches.
 */
export type PermissionJoinable = TimelineItem | { kind: 'notice' };

/**
 * FB7: fold each resolved `permission_request` into the tool row it settled,
 * so one authorization round-trip renders as ONE line instead of two
 * ("Edited x.txt" + "Allowed Write — x.txt").
 *
 * The key is free: `agent-host/permissionBridge.ts:38-42` returns the SDK's
 * `toolUseID` verbatim as the permission id when it has one, and that is the
 * same string `tool.started` already used for the `tool_call` block — an
 * equality that once caused a P0 (the store's dedupe guard swallowed the
 * permission block) and is still pinned by `chatSessionsCore.test.ts`'s
 * Round-2 group. Codex synthesises `codex:<session>:<rpcId>` instead, which
 * matches no tool_call and therefore always falls back.
 *
 * Three rules, in order of how much damage getting them wrong does:
 *
 *  1. An UNRESOLVED card never joins. `MessageTimeline.tsx`'s `case
 *     'permission'` is the only Allow/Deny surface in the app, so folding a
 *     pending card into a grey tool row would leave the turn waiting forever
 *     on an answer the user has no way to give. `derivePermissionRowView` has
 *     always drawn the same line (`if (block.resolved !== true) return null`).
 *  2. An unpaired permission is NEVER dropped — it keeps its own item, which
 *     is today's shape, so the fallback path is the one already in production
 *     rather than a new degraded one. Authorization records are an audit
 *     surface (`defaultTurnProcessOpen` and `hasUnresolvedPermission` both
 *     assume they stay visible).
 *  3. One tool_call claims at most one permission; a second permission
 *     pointing at the same call falls back instead of overwriting the first.
 *
 * The search domain is the TURN, not one message: `tool_call` blocks land on
 * the message the event names while `permission_request` blocks land on "the
 * last non-history assistant message" (`stores/chatSessions.ts:702-713` vs
 * `:747-754`). The two coincide in the common ordering but nothing structural
 * makes them, so a message-scoped join would silently stop merging as soon as
 * a new assistant message opened between the call and its approval.
 *
 * The join only ADDS a record. It never touches `run.status`, so a denied
 * call is red because its `tool_result` said `toolOk === false`, not because
 * it was denied — keeping "allowed but failed" and "denied" distinguishable
 * by whether the row carries a decision at all (spec §6.5-a).
 */
export function joinResolvedPermissions<T extends PermissionJoinable>(items: readonly T[]): T[] {
  const runsByBlockId = new Map<string, ToolRun>();
  for (const item of items) {
    if (item.kind !== 'toolGroup') continue;
    for (const entry of (item as ToolGroupItem).entries) {
      if (entry.kind === 'run') runsByBlockId.set(entry.run.blockId, entry.run);
    }
  }
  if (runsByBlockId.size === 0) return [...items];

  /** tool_call block id -> the permission block that claimed it. */
  const claims = new Map<string, ChatBlock>();
  /** ids of permission blocks that were absorbed and must not also stay standalone. */
  const absorbed = new Set<string>();
  for (const item of items) {
    if (item.kind !== 'permission') continue;
    const block = (item as PermissionItem).block;
    if (block.resolved !== true) continue;
    const target = block.permissionId;
    if (!target || !runsByBlockId.has(target) || claims.has(target)) continue;
    claims.set(target, block);
    absorbed.add(block.id);
  }
  if (absorbed.size === 0) return [...items];

  const attach = (item: T): T => {
    const group = item as T & ToolGroupItem;
    if (!group.entries.some((entry) => entry.kind === 'run' && claims.has(entry.run.blockId))) {
      return item;
    }
    const entries = group.entries.map((entry) => {
      if (entry.kind !== 'run') return entry;
      const permission = claims.get(entry.run.blockId);
      return permission ? { ...entry, run: { ...entry.run, permission } } : entry;
    });
    return { ...group, entries } as T;
  };

  const joined: T[] = [];
  // `groupTimeline` flushes the open tool group when it meets a permission, so
  // removing an absorbed one leaves the two halves of what was ONE contiguous
  // tool stream sitting next to each other. Stitching them back is what makes
  // [tool, permission, tool] render as a single group rather than two — and it
  // is scoped to exactly that: two tool groups that were already adjacent (one
  // assistant message ending in tools, the next starting with them) are left
  // apart, because nothing was removed from between them.
  let removedPermission = false;
  for (const item of items) {
    if (item.kind === 'permission') {
      if (absorbed.has((item as PermissionItem).block.id)) {
        removedPermission = true;
        continue;
      }
      joined.push(item);
      removedPermission = false;
      continue;
    }
    if (item.kind !== 'toolGroup') {
      joined.push(item);
      removedPermission = false;
      continue;
    }
    const rebuilt = attach(item);
    const previous = joined[joined.length - 1];
    if (removedPermission && previous && previous.kind === 'toolGroup') {
      const head = previous as T & ToolGroupItem;
      const tail = rebuilt as T & ToolGroupItem;
      joined[joined.length - 1] = { ...head, entries: [...head.entries, ...tail.entries] } as T;
    } else {
      joined.push(rebuilt);
    }
    removedPermission = false;
  }
  return joined;
}

/** How many authorization records a joined item list carries — `[FB7-4]`'s conservation law. */
export function countPermissionRecords(items: readonly PermissionJoinable[]): number {
  let count = 0;
  for (const item of items) {
    if (item.kind === 'permission') {
      count += 1;
      continue;
    }
    if (item.kind !== 'toolGroup') continue;
    for (const entry of (item as ToolGroupItem).entries) {
      if (entry.kind === 'run' && entry.run.permission) count += 1;
    }
  }
  return count;
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
  /**
   * Font-domain classifier for `arg` (D25 §2.4/§2.5): 'ident' renders mono
   * (paths, URLs, raw commands -- copy-target content the user reads
   * char-by-char); 'prose' renders sans (human-written descriptions,
   * aggregate summaries, thought/worked-for durations). Mandatory semantics
   * whenever `arg` is set for a branch D25's arg-kind table covers; branches
   * it does not cover (Grep/Glob/WebSearch/Task/TodoWrite/unknown-tool
   * fallback) leave this undefined, which `toolRowArgClass` treats the same
   * as 'prose' -- the safe default direction (D25 §2.5: fail toward sans).
   */
  argKind?: 'ident' | 'prose';
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
  /**
   * FB7: the decision word this row's own authorization settled on
   * ("Allowed" / "Denied, turn stopped" / …), present only on a row that
   * absorbed a resolved permission. Its ABSENCE is load-bearing: it is what
   * tells a red row that was DENIED apart from a red row whose tool simply
   * failed.
   */
  permissionVerb?: string;
  /**
   * FB7: `auto: <reason>` when the Host answered the approval on the user's
   * behalf. Kept as its own field rather than folded into `permissionVerb`
   * because the two have different width behaviour (closed set vs free text)
   * — and because a merged row that loses it re-creates the exact ambiguity
   * `derivePermissionAutoNote` exists to remove: a drained approval drawn as
   * a plain "Denied", indistinguishable from a real refusal.
   */
  permissionAutoNote?: string;
  /**
   * T-34: initial open state for the row's Collapsible, evaluated at mount.
   * `deriveToolRowView` never sets it, and since 2026-08-25 nothing else opens
   * a row either — `ToolRows.tsx` renders `view.defaultOpen ?? false`, so the
   * subagent panel's LIVE header row is the only thing that starts open.
   */
  defaultOpen?: boolean;
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
  // A refused call never ran, so it must not be described in the past tense —
  // the collapsed row is the only thing most readers see (§6.4, G-9).
  const verb = toolVerb(
    run.toolName,
    toolRunWasRefused(run) ? 'refused' : running ? 'running' : 'done'
  );
  const argDetail = formatToolArgDetail(run, options);
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
    arg: argDetail?.text,
    argKind: argDetail?.kind,
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
    // Both read through the shared derivations rather than re-deriving the
    // words here: the decision vocabulary has exactly one definition
    // (`questionCardModel.ts`), and the settled QA card renders from the same
    // two functions.
    permissionVerb: run.permission ? derivePermissionVerb(run.permission) : undefined,
    permissionAutoNote: run.permission
      ? (derivePermissionAutoNote(run.permission) ?? undefined)
      : undefined,
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
  // T-34 probe: cometix 2.1.212 names the delegation tool `Agent`; older
  // CLIs said `Task`. Both spellings share one treatment everywhere.
  Task: ['description', 'subagent_type'],
  Agent: ['description', 'subagent_type'],
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

/**
 * The aggregate row has no `refused` state: a run carrying an authorization
 * record never aggregates in the first place (`[FB7-10]`), so the roll-up can
 * only ever describe calls that actually ran.
 */
export const AGGREGATE_VERB: Pick<ToolVerbs, 'done' | 'running'> = {
  done: 'Explored',
  running: 'Exploring',
};

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
 *    adversarial fix #2), which colours the row; it no longer auto-expands it
 *    (see `ToolRowView.defaultOpen`).
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
  // A third "ran N command(s)" counting segment was withdrawn per T-31 review:
  // unreachable while Bash stays standalone per A07; revisit needs baseline
  // revision.

  const firstEntry = entries[0];
  const firstBlockId = firstEntry
    ? firstEntry.kind === 'run'
      ? firstEntry.run.blockId
      : firstEntry.block.id
    : 'empty';

  const arg = segments.length > 0 ? segments.join(', ') : undefined;
  return {
    key: `${firstBlockId}~agg`,
    verb: running ? AGGREGATE_VERB.running : AGGREGATE_VERB.done,
    arg,
    // D25 §2.4: "N files, M searches" is a number+prose summary, not an
    // identifier -- sans, same as the row's verb.
    argKind: arg ? 'prose' : undefined,
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
    // A run carrying its own authorization record never aggregates: folding it
    // into "Explored 3 files, 2 searches" would leave the decision visible only
    // after expanding the detail body, which is the collapsed-away-authorization
    // shape the permission red line exists to prevent (FB7).
    if (
      entry.kind === 'run' &&
      (classifyTool(entry.run.toolName) === 'action' || entry.run.permission)
    ) {
      rows.push(deriveToolRowView(entry.run, cardOptions));
      i += 1;
      continue;
    }

    let j = i;
    const segment: ToolGroupEntry[] = [];
    while (j < entries.length) {
      const candidate = entries[j];
      const isExploreRun =
        candidate.kind === 'run' &&
        classifyTool(candidate.run.toolName) !== 'action' &&
        !candidate.run.permission;
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
  const { verb, arg, argKind } = formatThoughtRow({ durationMs, streaming });
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
    argKind,
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

/**
 * Three states, not two.
 *
 * `done` and `running` were the whole table until a real deny was observed on a
 * live turn: a refused call still gets a `tool_call` block and a `tool_result`,
 * so it rendered with the COMPLETED verb — `Edited tmp/x.txt` for a write that
 * was refused and never happened. Colour and an expanded body carried the
 * truth; the collapsed row, which is what a user reads, said the opposite.
 *
 * `refused` is the plain infinitive, so the row reads as a label for the
 * operation that was blocked rather than a claim about the past: "Edit
 * tmp/x.txt · Denied". It is spelled out per tool rather than derived, because
 * there is no derivation — `Ran`→`Run`, `Grepped`→`Grep`, `Searched files`→
 * `Search files`, `Read`→`Read` share no rule, and a wrong guess here writes
 * bad English into the transcript.
 */
export interface ToolVerbs {
  done: string;
  running: string;
  /** The operation that was asked for and refused — it never ran. */
  refused: string;
}

export type ToolVerbState = 'done' | 'running' | 'refused';

/** A07 :2539 verb table, plus our own `Edited` (A07-endorsed) / `Delegated` / `Fetched` additions. */
export const TOOL_VERBS: Readonly<Record<string, ToolVerbs>> = {
  Read: { done: 'Read', running: 'Reading', refused: 'Read' },
  NotebookRead: { done: 'Read', running: 'Reading', refused: 'Read' },
  Grep: { done: 'Grepped', running: 'Grepping', refused: 'Grep' },
  Glob: { done: 'Searched files', running: 'Searching files', refused: 'Search files' },
  WebSearch: { done: 'Searched', running: 'Searching', refused: 'Search' },
  WebFetch: { done: 'Fetched', running: 'Fetching', refused: 'Fetch' },
  Edit: { done: 'Edited', running: 'Editing', refused: 'Edit' },
  MultiEdit: { done: 'Edited', running: 'Editing', refused: 'Edit' },
  Write: { done: 'Edited', running: 'Editing', refused: 'Edit' },
  NotebookEdit: { done: 'Edited', running: 'Editing', refused: 'Edit' },
  Bash: { done: 'Ran', running: 'Running', refused: 'Run' },
  BashOutput: { done: 'Ran', running: 'Running', refused: 'Run' },
  KillShell: { done: 'Ran', running: 'Running', refused: 'Run' },
  TodoWrite: { done: 'Planned', running: 'Planning', refused: 'Plan' },
  ExitPlanMode: { done: 'Planned', running: 'Planning', refused: 'Plan' },
  Task: { done: 'Delegated', running: 'Delegating', refused: 'Delegate' },
  Agent: { done: 'Delegated', running: 'Delegating', refused: 'Delegate' },
};

export const UNKNOWN_TOOL_VERB: ToolVerbs = { done: 'Ran', running: 'Running', refused: 'Run' };

export function toolVerb(toolName: string, state: ToolVerbState): string {
  return (TOOL_VERBS[toolName] ?? UNKNOWN_TOOL_VERB)[state];
}

/**
 * Was this call's own authorization refused — i.e. did the tool never run?
 *
 * `allowed === false` is the canonical test, not a decision-name list:
 * `derivePermissionRowView` states the rule ("`allow_session` is an allow and
 * `cancel` is a deny, and the Host derives this same boolean from the same
 * decision"), and a second reading of the decision vocabulary here could
 * disagree with the Host's.
 *
 * An UNRESOLVED permission is not a refusal — the user has not answered yet.
 */
export function toolRunWasRefused(run: Pick<ToolRun, 'permission'>): boolean {
  const permission = run.permission;
  return permission?.resolved === true && permission.allowed === false;
}

/**
 * The `tool_call` block ids in this list whose authorization was refused.
 *
 * Lives here, next to `joinResolvedPermissions`, because this is the one module
 * that knows `permissionId` and a `tool_call` block id are the same string on
 * the Claude path. The turn-head counter needs the same fact but sees only raw
 * blocks, and a second correlation written over there is a second place to get
 * the key wrong.
 */
export function refusedToolCallIds(blocks: readonly ChatBlock[]): Set<string> {
  const refused = new Set<string>();
  for (const block of blocks) {
    if (block.type !== 'permission_request') continue;
    if (block.resolved !== true || block.allowed !== false) continue;
    if (block.permissionId) refused.add(block.permissionId);
  }
  return refused;
}

export type ToolClass = 'read' | 'search' | 'action';

/**
 * T-34: the single source of truth for "is this a delegation tool". The name
 * is CLI-version-dependent (`Agent` on cometix 2.1.212, `Task` historically);
 * every consumer (verbs, arg tables, the subagent-panel mount gate) must go
 * through this predicate — a third spelling would otherwise fork the lists.
 * `classifyTool(name) === 'action'` is NOT a substitute: Bash/Edit/unknown
 * tools are 'action' too.
 */
export const DELEGATION_TOOL_NAMES: ReadonlySet<string> = new Set(['Task', 'Agent']);

export function isDelegationTool(toolName: string): boolean {
  return DELEGATION_TOOL_NAMES.has(toolName);
}

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

/** D25 §2.4 arg font-domain classifier -- see `ToolRowView.argKind` doc comment. */
export type ToolArgKind = 'ident' | 'prose';

interface ToolArgDetail {
  text: string;
  kind?: ToolArgKind;
}

/**
 * Argument text + D25 font-domain kind, one switch shared by `formatToolArg`
 * and `formatToolArgKind`. Text never contains a literal newline (truncation
 * is CSS's job, not this function's).
 *
 * `kind` is only assigned for the branches D25 §2.4's arg-kind table
 * actually covers (Read/Edit/Write/NotebookRead/NotebookEdit/WebFetch paths
 * and URLs -> 'ident'; Bash description -> 'prose', command fallback ->
 * 'ident'). Grep/Glob/WebSearch/Task/TodoWrite/the unknown-tool fallback are
 * out of that table and left `undefined` on purpose -- `toolRowArgClass`
 * treats `undefined` the same as 'prose' (sans), which is D25 §2.5's safe
 * default direction, so an uncovered branch degrades to a proportional arg
 * instead of a silently-wrong mono one.
 */
function formatToolArgDetail(
  run: ToolRun,
  options: ToolCardOptions = {}
): ToolArgDetail | undefined {
  const rec = asRecord(run.input);
  const repoName = options.repoName;

  let raw: string | undefined;
  let kind: ToolArgKind | undefined;
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
        kind = 'ident';
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
      if (raw) kind = 'ident';
      break;
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit': {
      const path = stringField(rec, 'file_path');
      raw = path ? shortPath(path) : undefined;
      if (raw) kind = 'ident';
      break;
    }
    case 'Bash':
    case 'BashOutput':
    case 'KillShell': {
      const description = stringField(rec, 'description');
      if (description) {
        raw = description;
        kind = 'prose';
      } else {
        raw = stringField(rec, 'command');
        if (raw) kind = 'ident';
      }
      break;
    }
    case 'TodoWrite':
    case 'ExitPlanMode':
      raw = 'next moves';
      break;
    case 'Task':
    case 'Agent':
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
  return { text: raw.replace(/[\r\n]+/g, ' '), kind };
}

/** Argument text. Never contains a literal newline (truncation is CSS's job, not this function's). */
export function formatToolArg(run: ToolRun, options: ToolCardOptions = {}): string | undefined {
  return formatToolArgDetail(run, options)?.text;
}

/** D25 §2.4 arg font-domain kind for `run` -- see `formatToolArgDetail`'s doc comment for coverage. */
export function formatToolArgKind(
  run: ToolRun,
  options: ToolCardOptions = {}
): ToolArgKind | undefined {
  return formatToolArgDetail(run, options)?.kind;
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

// ---------------------------------------------------------------------------
// 5. Font domain (D25 §2.4/§2.5)
// ---------------------------------------------------------------------------

/**
 * Class string for the `.ct-a` arg cell (ToolRows.tsx's `ToolRowArg`).
 * `argKind === 'ident'` gets the D25 mono primitive (paths/URLs/commands,
 * light-optical-compensation text-code + tracking-normal so mono columns
 * still line up); 'prose' (or missing `argKind`) adds no font-family class
 * and inherits the row's sans `text-markdown`. The failed-state color is
 * unaffected by `argKind` -- font domain and status color are orthogonal
 * (D25 §2.4 technical note 4).
 *
 * The mono suffix is appended by plain string concatenation, not folded
 * into the same `cn()` call as the color class: tailwind-merge classifies
 * an unrecognised `text-<name>` (which `text-code` is, same as `text-tool-arg`
 * / the destructive `text-[color-mix(...)]`) as a text-COLOR utility, so
 * merging both through `cn()` in one pass drops whichever comes first --
 * exactly the documented gotcha in `middleColumnLayout.ts` ("`text-ui` must
 * never be merged through `cn()` in the same argument list as a `text-*`
 * COLOR class"). Resolving the color first, then concatenating the already-
 * merged result with the mono suffix as a separate string, sidesteps a
 * second twMerge pass over both together.
 *
 * D25 §5.4: the 'prose' branch renders content like "Worked for 1s" /
 * "2 files, 3 searches" -- numbers that refresh in place while a turn is
 * running. `tabular-nums` there stops the digits from jittering the row
 * width on every refresh; the 'ident' branch doesn't need it (paths/URLs/
 * commands aren't refreshed numeric counters).
 */
/**
 * FB7 decision badge (`Allowed` / `Denied, turn stopped` / …).
 *
 * Deliberately carries NO colour token. The badge inherits the row's colour,
 * so it is `--muted-foreground` on an allowed row and `--destructive` on a
 * denied one — the failed branch in `ToolRows.tsx` already decides what colour
 * a refused row is, and a second definition here would be one more thing to
 * drift. Hard-coding either token instead would put a grey badge inside a red
 * row (or a red word inside a grey one), which is why the class is bare rather
 * than "the same in both arms by accident".
 *
 * `shrink-0` because the four decision words are a closed set: the row's arg
 * stays the only thing that gives way when width runs out (D24 / spec §6.5).
 * No `bg-`, no `border`, no icon — the tool-row line stays a verb-first, plain
 * text line.
 */
export function toolRowPermissionClass(): string {
  return 'shrink-0';
}

/**
 * FB7 `auto: <reason>` tail. Free text, not a closed set, so unlike the
 * decision badge it truncates and gives way alongside the row's arg — a
 * verbose Host reason must never squeeze the file path out of the row.
 * Colourless for the same reason as `toolRowPermissionClass`.
 */
export function toolRowPermissionNoteClass(): string {
  return 'min-w-0 truncate';
}

export function toolRowArgClass(view: Pick<ToolRowView, 'failed' | 'argKind'>): string {
  const colorClass = cn(
    'min-w-0 truncate',
    view.failed
      ? 'text-[color-mix(in_oklab,var(--destructive)_70%,var(--background))]'
      : 'text-tool-arg'
  );
  return view.argKind === 'ident'
    ? `${colorClass} font-mono text-code tracking-normal`
    : `${colorClass} tabular-nums`;
}
