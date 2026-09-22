import { englishTranslate, type Translate } from '@shared/i18n';
import { reviewFromToolResult } from '@shared/sessionFileChange';
import { readStreamingToolArgs } from '@shared/streamingToolArgs';
import { cn } from '@/lib/utils';
import type { ChatBlock, ChatMessage } from '@/stores/chatSessions';
import { isQuietPermissionActivity } from './permissionActivityRow';
import { MCP_TOOL_PREFIX, mcpToolLabel, PI_TOOL_NAMES, RUNTIME_TOOL_NAMES } from './piToolNames';
import { derivePermissionAutoNote, derivePermissionVerb } from './questionCardModel';
import { deriveToolDiff, type ToolDiff } from './toolDiff';
import { formatThoughtRow } from './turnTiming';

// Re-exported so the pi tool vocabulary keeps ONE public entry point even
// though the constant itself had to move out to break an import cycle.
export { MCP_TOOL_PREFIX, mcpToolLabel, PI_TOOL_NAMES, RUNTIME_TOOL_NAMES } from './piToolNames';

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
  result?: unknown;
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
      ...(result?.toolOutput && typeof result.toolOutput === 'object'
        ? { result: result.toolOutput }
        : {}),
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
  if (typeof output === 'object') {
    if ('content' in output) return normalizeRawOutput(output.content);
    return JSON.stringify(output, null, 2);
  }
  return String(output);
}

// ---------------------------------------------------------------------------
// 2. Grouping layer
// ---------------------------------------------------------------------------

export type TimelineItem =
  | { kind: 'text'; block: ChatBlock; blockIndex: number }
  | { kind: 'question'; block: ChatBlock; blockIndex: number }
  | { kind: 'permission'; block: ChatBlock; blockIndex: number }
  /**
   * T08-b: one or more RESOLVED gates, in block order. Several because one tool
   * call runs several gates, and a row apiece would bury the tool it gated.
   * Never answerable — see `ChatBlockType`'s `permission_activity`.
   */
  | { kind: 'permissionActivity'; blocks: ChatBlock[]; blockIndex: number }
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
      case 'permission_activity': {
        if (isQuietPermissionActivity(block.permissionActivity)) break;
        // Coalesced with the immediately preceding activity item rather than
        // pushed as its own: the gate fires once per surface, so a bash call
        // with a path check produces two records back to back and two rows
        // would read as two separate approvals.
        const last = items.at(-1);
        if (last?.kind === 'permissionActivity' && currentGroup.length === 0) {
          last.blocks.push(block);
          break;
        }
        flush();
        items.push({ kind: 'permissionActivity', blocks: [block], blockIndex });
        break;
      }
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
  /**
   * The row's leading word, as a TRANSLATION KEY — always one of the closed
   * vocabularies (`TOOL_VERBS`, the thought verbs, the permission decision
   * words), never free text.
   *
   * Splitting it this way is what keeps one `t()` call able to cover every row
   * shape: `ToolRows.tsx` translates `verb` at the single place a row reaches
   * paint, so no builder in this module has to hold a translator just to name
   * an operation. `arg` is the opposite — it interpolates paths and counts, so
   * it arrives here already finished.
   *
   * T108 aggregates carry a count, translated by a literal key at paint.
   */
  verb: string;
  /** Number of calls in an aggregate; single-tool rows leave this unset. */
  toolCallCount?: number;
  /** Finished text, already translated by whoever built it. Never a catalog key. */
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
  /**
   * The row is still in flight: present-tense verb, and a live body where the
   * row has one.
   *
   * A07 `:2331` also said a running row never shows a chevron. That half is
   * RETIRED for thought rows (user decision 2026-09-19) — see
   * `buildThoughtRow` — and for the aggregate row (T105) — see
   * `deriveAggregateRow` — and was already a registered deviation for the live
   * subagent panel (`subagentActivityModel.ts`). It still holds for a
   * STANDALONE tool call, whose own output does not exist until it settles.
   */
  running: boolean;
  failed: boolean;
  /** Only a row with a body can expand. */
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
  /**
   * T12-b slice 2: a file change rendered as a diff instead of as raw
   * argument JSON. Present only for `edit`/`write`-shaped calls that have
   * settled; mutually exclusive with `input` by construction (see
   * `deriveToolRowView`) because the two would show the same bytes twice.
   */
  diff?: ToolDiff;
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
   *
   * A translation key, like `verb`, and compared as one (`=== 'Allowed'` in
   * `ToolRows.tsx`) — which is the reason it stays untranslated until paint.
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
   * T-34: initial open state for the row's Collapsible, evaluated at mount and
   * outranked by a remembered user choice (`resolveToolRowOpen`).
   *
   * `deriveToolRowView` never sets it — a tool call opens only when the user
   * asks (2026-08-25). Exactly two producers do: the subagent panel's LIVE
   * header row (T-34) and a thought that is still streaming (2026-09-19). Both
   * are rows whose content is the only thing happening at that moment.
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
  /**
   * The locale-aware translator, passed down from whichever component is
   * building these rows. Only the ARG needs it — an arg interpolates counts and
   * names, so it has to be finished text by the time it leaves this module.
   * Defaults to English at each use, so an un-threaded caller keeps its old
   * bytes (see `englishTranslate`).
   */
  t?: Translate;
}

/** Injected thinking-duration lookup, shared by the group/aggregate row builders. */
interface ThinkingRowOptions {
  thinkingDurationMs?: (blockId: string) => number | null | undefined;
  isStreamingBlockId?: string | null;
  /** Same translator `ToolCardOptions.t` carries — a thought row has an arg too. */
  t?: Translate;
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
  const recordedChange = reviewFromToolResult(run.result);
  const inputBody = running || recordedChange ? undefined : deriveToolInputBody(run);
  // Running Edit/Write arguments are explicitly labelled as a preview;
  // successful Edit results prefer the SDK patch once the call settles.
  const diff = recordedChange ? null : deriveToolDiff(run);
  const expandable = showOutputBody || Boolean(inputBody) || Boolean(diff);

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
    // The diff SUPERSEDES the raw argument body rather than sitting next to
    // it: they carry the same information, and showing both would put an
    // escaped `oldText` blob directly under the readable rendering of itself.
    input: diff ? undefined : inputBody,
    inputMaxHeightClass: !diff && inputBody ? INPUT_MAX_HEIGHT_CLASS : undefined,
    diff: diff ?? undefined,
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
      ? (derivePermissionAutoNote(run.permission, options.t ?? englishTranslate) ?? undefined)
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
export const ARG_COVERED_FIELDS: Readonly<Record<string, readonly string[]>> = {
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
  // Decision 033 D6 (2026-09-22): `command` used to be listed here on the
  // ground that the one-line summary already covered it — true only when no
  // `description` was supplied, in which case the summary falls back to the
  // command (see the `Bash` branch of the arg builder). When a description WAS
  // supplied the summary printed the description and `deriveToolInputBody` saw
  // every field as covered, so no input body was generated and the command
  // became permanently unreachable — expanding the row showed nothing. The
  // user's report was 「指令太长了，没有办法看全」; this is not truncation, it is a
  // field that never reached the DOM.
  //
  // `description` stays covered: it is what the summary prints, so keeping it
  // out of the body avoids saying the same sentence twice.
  Bash: ['description'],
  // NOT changed with Bash, deliberately: the Claude-era `BashOutput` and
  // `KillShell` take a `shell_id`/`bash_id` — they never carried a `command`,
  // so nothing was hidden by the entry and removing it would only mint an input
  // body for a tool whose whole input is already on screen.
  BashOutput: ['description', 'command'],
  KillShell: ['description', 'command'],
  // T-34 probe: cometix 2.1.212 names the delegation tool `Agent`; older
  // CLIs said `Task`. Both spellings share one treatment everywhere.
  Task: ['description', 'subagent_type', 'agent'],
  Agent: ['description', 'subagent_type'],
  // subagent-data-06 — our own registry. `Glob` (capital) was already here and
  // `glob` was not, so every one of our glob rows also grew a full input body
  // under a summary that already said everything it had.
  [RUNTIME_TOOL_NAMES.read]: ['path', 'offset', 'limit'],
  [RUNTIME_TOOL_NAMES.write]: ['path'],
  [RUNTIME_TOOL_NAMES.edit]: ['path'],
  [RUNTIME_TOOL_NAMES.glob]: ['pattern'],
  [RUNTIME_TOOL_NAMES.grep]: ['pattern'],
  [RUNTIME_TOOL_NAMES.bash]: ['command'],
  [RUNTIME_TOOL_NAMES.browserPreview]: ['path'],
  // Empty on purpose, and declared rather than left to the default: the arg is
  // the FIRST question only, so the body is where the rest of them live.
  [RUNTIME_TOOL_NAMES.ask]: [],
  [RUNTIME_TOOL_NAMES.skill]: ['name'],
  [RUNTIME_TOOL_NAMES.newContext]: [],
  [RUNTIME_TOOL_NAMES.taskWait]: ['delegationIds'],
  [RUNTIME_TOOL_NAMES.taskStop]: ['delegationIds'],
  [RUNTIME_TOOL_NAMES.taskList]: [],
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

/**
 * chat-tool-01 — a search row's output IS the hit list, whoever ran the search.
 *
 * This used to be a second two-entry table naming Claude's capitalised `Grep`
 * and `Glob`, so on the native backend — which registers lowercase `grep` and
 * `glob` — `hitSource` was undefined for every search the agent ever ran, and
 * `ToolRows.tsx`'s popover branch was unreachable. The one classification the
 * module already keeps decides it instead, so a search tool cannot be added to
 * one list and forgotten in the other.
 *
 * Membership is not a promise that the output parses: `parseHitList` is
 * best-effort and returns null for anything that does not look like hits, which
 * the row already degrades to a plain expandable body.
 */
function isHitListTool(toolName: string): boolean {
  return classifyTool(toolName) === 'search';
}

/**
 * Aggregate row for a run of consecutive tool calls (T105).
 *
 * Only meant to be called once the caller (`deriveToolGroupRows`) has already
 * decided the segment qualifies (>= 2 runs) — this function does not re-check
 * that, and it no longer looks at WHICH KIND of call each run is: the user's
 * aggregation ruling is 不分类型 (D3), so a Read between two Greps and a Bash
 * between two Reads count the same.
 *
 *  - N = the segment's RUN count. Deliberately not "files touched": a
 *    `file_path`-deduped count reports 1 for four sequential reads of one file,
 *    which is the opposite of 「过程条目太碎」's complaint.
 *  - T108 narrows the former count + last-action clause to the COUNT alone.
 *    Arguments remain in the expandable detail rows, not in the summary.
 *  - A `permission`-carrying run never reaches here — `deriveToolGroupRows`
 *    keeps it as a separator row of its own, so the decision stays visible
 *    without opening anything (`[FB7-10]`).
 *  - `failed` is true when any child call's `toolOk === false` (T-05
 *    adversarial fix #2), which colours the row; it no longer auto-expands it
 *    (see `ToolRowView.defaultOpen`).
 *  - `detail` mirrors the entries' original order (thinking included, un-timed
 *    here — `deriveToolGroupRows` re-stamps thinking rows with real duration).
 *
 * ## Running rows ARE expandable now (2026-09-19 deviation from A07)
 *
 * A07 `:2331` said a running row never offers a chevron. That half was already
 * retired once for streaming thought rows (T098, user decision 2026-09-19, see
 * `buildThoughtRow`), and the aggregate row follows it here for the same
 * reason: the segment's earlier calls have SETTLED, so their output exists and
 * is worth opening while the last one still runs. The `running` flag still
 * carries the present-tense verb; only the "no chevron" half is gone.
 */
export function deriveAggregateRow(
  entries: readonly ToolGroupEntry[],
  options: ToolCardOptions = {}
): ToolRowView {
  const runEntries = entries.filter(
    (entry): entry is Extract<ToolGroupEntry, { kind: 'run' }> => entry.kind === 'run'
  );
  const running = runEntries.some((entry) => entry.run.status === 'running');
  const failed = runEntries.some((entry) => entry.run.status === 'failed');
  const firstEntry = entries[0];
  const firstBlockId = firstEntry
    ? firstEntry.kind === 'run'
      ? firstEntry.run.blockId
      : firstEntry.block.id
    : 'empty';

  return {
    key: `${firstBlockId}~agg`,
    verb: runEntries.length === 1 ? '{{count}} tool call' : '{{count}} tool calls',
    toolCallCount: runEntries.length,
    running,
    failed,
    expandable: true,
    body: 'detail',
    detail: entries.map((detailEntry) => buildEntryRow(detailEntry, options)),
  };
}

/**
 * One tool group -> its top-level rows (T105 rewrote the segmentation).
 *
 *  - SEPARATOR: a run carrying a `permission` record. It renders standalone,
 *    in place, and breaks the run of calls around it. A `thinking` entry used
 *    to be one too; it is a MEMBER since 2026-09-22 (see `breaksSegment`).
 *  - A maximal run of adjacent separator-free entries, counted by its TOOL
 *    CALLS: >= 2 becomes ONE aggregate row plus its detail body (thinking
 *    included, in place); exactly 1 does not aggregate (sign-off ②/A07 :2348)
 *    and its entries render as their own rows, thought included.
 *  - `failed` and `running` no longer affect the segmentation at all: a running
 *    call joins the segment like any other, and the aggregate row reports
 *    itself as running.
 *
 * ## Why the permission run is a separator and not a member (FB7 red line)
 *
 * It is a deliberate deviation from D3's 不分类型, and the reason is this
 * batch's own second half. With the work group ALWAYS collapsed, a decision
 * buried inside an aggregate's detail body takes TWO clicks to reach (open the
 * group, then open the row) — while the thing the user was just asked to allow
 * is summarised as 「12 次工具调用」. Standing alone, one click shows it.
 *
 * ## What replaced "an action-class call is always its own row"
 *
 * A07 `:1769-1772` kept Edit/Write/Bash out of the aggregate. The user's D3
 * ruling retires that: 「不分类型（读取/搜索/运行/编辑/写入）合并成一条」, so a
 * turn that reads four files and edits one of them now reads as five steps
 * rather than "4 + 1". The old text here and in `deriveAggregateRow` said
 * otherwise; both were replaced by the rule rather than left beside it.
 *
 *  - A thinking entry that never reaches an aggregate — because its segment
 *    holds fewer than two calls — becomes its own Thought row via
 *    `turnTiming.formatThoughtRow`, exactly as before.
 */
export function deriveToolGroupRows(
  entries: readonly ToolGroupEntry[],
  options: ToolCardOptions & ThinkingRowOptions = {}
): ToolRowView[] {
  const { thinkingDurationMs, isStreamingBlockId, ...cardOptions } = options;
  // `t` belongs to both halves: the rest-spread keeps it on `cardOptions` for
  // the tool rows, and it is named again here so thought rows get it too.
  const thinkingOptions: ThinkingRowOptions = {
    thinkingDurationMs,
    isStreamingBlockId,
    t: options.t,
  };

  const rows: ToolRowView[] = [];
  const pushStandaloneRow = (item: ToolGroupEntry) => {
    rows.push(
      item.kind === 'run'
        ? deriveToolRowView(item.run, cardOptions)
        : buildThoughtRow(item.block, thinkingOptions)
    );
  };
  // Decision 033 D7 revised (2026-09-22, user decision): a thinking entry no
  // longer breaks the run it sits in. D7 had ruled the break 「已是正确行为」 on
  // the argument that prose or thought genuinely ends one stretch of work — but
  // the model emits a thought before nearly EVERY call, so the break fired on
  // nearly every call and the aggregate almost never formed. The user's report
  // on the result was 「每句输出之间还是一团乱麻，太多东西了」: 12 rows between two
  // paragraphs where the rule was supposed to produce one.
  //
  // An authorization record still breaks it, and that is the FB7 red line below
  // — a decision the user was asked to make must never be summarised as
  // 「12 次工具调用」 behind two clicks.
  const breaksSegment = (entry: ToolGroupEntry) =>
    entry.kind === 'run' && entry.run.permission != null;

  let i = 0;
  while (i < entries.length) {
    if (breaksSegment(entries[i])) {
      pushStandaloneRow(entries[i]);
      i += 1;
      continue;
    }

    let j = i;
    const segment: ToolGroupEntry[] = [];
    while (j < entries.length && !breaksSegment(entries[j])) {
      segment.push(entries[j]);
      j += 1;
    }

    // Counts RUNS, not entries: thinking entries now travel INSIDE a segment,
    // and counting them would make 「2 次工具调用」 out of one call with a thought
    // beside it — a row whose own detail body contradicts its count.
    const runCount = segment.filter((item) => item.kind === 'run').length;
    if (runCount >= 2) {
      rows.push(
        applyThinkingDurations(deriveAggregateRow(segment, cardOptions), segment, thinkingOptions)
      );
    } else {
      segment.forEach(pushStandaloneRow);
    }

    i = j;
  }
  return rows;
}

function buildEntryRow(entry: ToolGroupEntry, options: ToolCardOptions): ToolRowView {
  if (entry.kind === 'run') return deriveToolRowView(entry.run, options);
  return buildThoughtRow(entry.block, { t: options.t });
}

function buildThoughtRow(block: ChatBlock, options: ThinkingRowOptions): ToolRowView {
  const streaming = options.isStreamingBlockId != null && options.isStreamingBlockId === block.id;
  const durationMs = options.thinkingDurationMs ? options.thinkingDurationMs(block.id) : undefined;
  const { verb, arg, argKind } = formatThoughtRow({ durationMs, streaming }, options.t);
  const hasText = Boolean(block.text && block.text.length > 0);
  const showBody = hasText;
  // An empty (no-text) block renders as a bare, non-expandable row — no
  // chevron, nothing to open. This is a deliberate behavior change from an
  // earlier expandable-but-empty placeholder shell: the bare row is the
  // honest Cursor form and was approved & registered in the T-05 ledger
  // (see `deriveToolGroupRows` empty-block test below for the locked case).
  //
  // ## The streaming thought is an ordinary expandable row (2026-09-19)
  //
  // It used to be two shapes: a settled thought went behind a chevron, and a
  // thought in flight painted its text with NO control at all (`liveText`),
  // on the argument that "a row whose content is still arriving must not offer
  // a toggle whose state is meaningless a second later".
  //
  // That argument was half right. It correctly refused to HIDE a thought in
  // flight — hiding it is what made a 12-20s think look like a frozen window —
  // but it also took away the only way to get a long think out of the way
  // while it happens, which is what the user then asked for. Both halves are
  // satisfied by one row: expandable, and `defaultOpen` so it starts visible
  // without a click. Folding it back is now a choice the reader can make at
  // any time, and `resolveToolRowOpen` keeps that choice across the moment the
  // thought settles.
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
    // Only while streaming. A settled thought is reference material once the
    // answer exists, so it goes back to starting closed — which is also what
    // folds an untouched thought away by itself the moment it ends, since
    // `ToolRows.tsx` re-seeds the row at that transition.
    ...(streaming ? { defaultOpen: true } : {}),
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

/**
 * A07 :2539 verb table, plus our own `Edited` (A07-endorsed) / `Delegated` /
 * `Fetched` additions, plus pi's lowercase built-ins (T12-b).
 *
 * pi's verbs deliberately reuse the existing English rather than inventing a
 * second dialect: `grep` gets `Grepped` like `Grep`, `find` gets
 * `Searched files` like `Glob` (both are "find files by glob pattern"), and
 * `write` gets `Edited` like `Write`. `ls` is the one pi tool with no Claude
 * counterpart, hence the only new verb triple in this batch.
 */
export const TOOL_VERBS: Readonly<Record<string, ToolVerbs>> = {
  [PI_TOOL_NAMES.read]: { done: 'Read', running: 'Reading', refused: 'Read' },
  [PI_TOOL_NAMES.edit]: { done: 'Edited', running: 'Editing', refused: 'Edit' },
  [PI_TOOL_NAMES.write]: { done: 'Edited', running: 'Editing', refused: 'Edit' },
  [PI_TOOL_NAMES.bash]: { done: 'Ran', running: 'Running', refused: 'Run' },
  [PI_TOOL_NAMES.powershell]: { done: 'Ran', running: 'Running', refused: 'Run' },
  [PI_TOOL_NAMES.grep]: { done: 'Grepped', running: 'Grepping', refused: 'Grep' },
  [PI_TOOL_NAMES.find]: {
    done: 'Searched files',
    running: 'Searching files',
    refused: 'Search files',
  },
  [PI_TOOL_NAMES.ls]: { done: 'Listed', running: 'Listing', refused: 'List' },
  // subagent-data-06 — this app's own registry, which is NOT pi's built-in set.
  // `glob` gets `Glob`'s words because it is the same job under another name;
  // the rest had no entry at all and read as the unknown-tool fallback "Ran",
  // in the delegation panel and in the main timeline alike.
  [RUNTIME_TOOL_NAMES.glob]: {
    done: 'Searched files',
    running: 'Searching files',
    refused: 'Search files',
  },
  [RUNTIME_TOOL_NAMES.browserPreview]: {
    done: 'Previewed',
    running: 'Previewing',
    refused: 'Preview',
  },
  [RUNTIME_TOOL_NAMES.ask]: { done: 'Asked', running: 'Asking', refused: 'Ask' },
  [RUNTIME_TOOL_NAMES.skill]: {
    done: 'Loaded skill',
    running: 'Loading skill',
    refused: 'Load skill',
  },
  [RUNTIME_TOOL_NAMES.newContext]: {
    done: 'Started a new context',
    running: 'Starting a new context',
    refused: 'Start a new context',
  },
  [RUNTIME_TOOL_NAMES.taskWait]: {
    done: 'Waited for subagents',
    running: 'Waiting for subagents',
    refused: 'Wait for subagents',
  },
  [RUNTIME_TOOL_NAMES.taskList]: {
    done: 'Listed subagents',
    running: 'Listing subagents',
    refused: 'List subagents',
  },
  [RUNTIME_TOOL_NAMES.taskStop]: {
    done: 'Stopped subagents',
    running: 'Stopping subagents',
    refused: 'Stop subagents',
  },
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

/**
 * subagent-data-06 — every MCP-bridged tool, which no table can enumerate.
 *
 * The name is `mcp__<server>__<tool>`, composed at runtime, so these can only
 * be matched by prefix. "Called" rather than "Ran": an MCP tool is a request to
 * another process, and the row already names which one in its argument.
 */
export const MCP_TOOL_VERB: ToolVerbs = { done: 'Called', running: 'Calling', refused: 'Call' };

export function toolVerb(toolName: string, state: ToolVerbState): string {
  const verbs =
    TOOL_VERBS[toolName] ??
    (toolName.startsWith(MCP_TOOL_PREFIX) ? MCP_TOOL_VERB : UNKNOWN_TOOL_VERB);
  return verbs[state];
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

// `ls` counts as a SEARCH, not a read: the aggregate row phrases reads as
// "N files" and dedupes them by path, and a directory listing is neither a file
// nor something you read twice by accident. "N searches" is the honest bucket.
const READ_TOOL_NAMES = new Set(['Read', 'NotebookRead', PI_TOOL_NAMES.read]);
const SEARCH_TOOL_NAMES = new Set([
  'Grep',
  'Glob',
  'WebSearch',
  PI_TOOL_NAMES.grep,
  PI_TOOL_NAMES.find,
  PI_TOOL_NAMES.ls,
  // subagent-data-06: without this our own glob never joined an aggregate row,
  // so a burst of searches stayed as N separate "Ran" lines.
  RUNTIME_TOOL_NAMES.glob,
]);

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

/**
 * A shell command as the ROW summarises it: the `cd <path> &&` prefix removed,
 * and what is left cut to a fixed number of characters.
 *
 * ## Two rulings, one function (user, 2026-09-22)
 *
 * The first report was 「已运行那一行，总是特别长，而且我也看不全指令」 and the
 * prefix is half of it: an agent puts the same repository path in front of
 * nearly every call, so the forty characters a row had room for were spent
 * before the command said anything.
 *
 * Stripping it was not enough — 「不想显示那么长，直接限制个长度显示调用了什么
 * 工具，具体的指令内容在展开栏目里显示」. So the row no longer tries to carry the
 * command at all: it carries enough of it to tell one call from the next
 * (`sed -n '452,500p' src/rend…`), and the command itself lives one click away.
 *
 * ⚠️ The cap is in CHARACTERS, and `toolRowArgClass()`'s `truncate` still
 * applies on top. They answer different questions: the class stops a row from
 * overflowing a narrow window, this stops a row from filling a wide one. A
 * width-only rule leaves the 900px case as long as it ever was, which is what
 * the ruling above is about.
 *
 * ⚠️ DISPLAY ONLY. `deriveToolInputBody` keeps the raw input, so the expanded
 * row still shows the command exactly as it ran, `cd` included — which is the
 * copy-and-rerun path and must not be rewritten. Decision 033 D6 is what made
 * that body exist for Bash in the first place; both halves here lean on it, and
 * neither is safe to apply to a tool whose input has nowhere else to appear.
 *
 * Quoted and unquoted paths both match, and a bare `cd /somewhere` with nothing
 * after it is left alone: stripping it would leave an empty row for a call that
 * really did only change directory.
 */
const CD_PREFIX_PATTERN = /^\s*cd\s+(?:'[^']*'|"[^"]*"|[^\s;|&()]+)\s*&&\s*/;

/**
 * Chosen against the row, not against the string: 40 characters is about where
 * a second call's summary stops being distinguishable from the first at this
 * font size, and it leaves the chevron and any aggregate count a stable column
 * to sit in. Cutting mid-token is deliberate — a word-boundary cut makes the
 * length vary per row, and a ragged right edge is the thing being fixed.
 */
const COMMAND_SUMMARY_MAX_CHARS = 40;

function commandSummary(command: string): string {
  let rest = command;
  // A loop, not a single replace: `cd a && cd b && cmd` is rare but real, and
  // stripping one level would leave the row looking like it starts at `cd`.
  while (CD_PREFIX_PATTERN.test(rest)) {
    const next = rest.replace(CD_PREFIX_PATTERN, '');
    if (!next.trim()) break;
    rest = next;
  }
  const stripped = rest.trim() || command.trim();
  return stripped.length > COMMAND_SUMMARY_MAX_CHARS
    ? `${stripped.slice(0, COMMAND_SUMMARY_MAX_CHARS)}…`
    : stripped;
}

/**
 * T101 — the argument text for a Write/Edit row, whether or not its arguments
 * have finished arriving.
 *
 * A settled call reads exactly as it always did: the shortened path. A call
 * still being dictated shows that path AND how much of the file has landed,
 * because the path is typed in the first few tokens and then does not change
 * for however long the body takes — which for a whole-file `write` is minutes,
 * and a row that never moves is indistinguishable from a wedged one.
 *
 * With no path yet the row gets NO argument rather than a placeholder: the
 * model has not said which file it means, and "0 lines" names nothing. The row
 * falls back to its verb alone, which is true and short.
 */
function fileArgWithProgress(
  path: string | undefined,
  input: unknown,
  t: Translate
): string | undefined {
  const streaming = readStreamingToolArgs(input);
  if (!path) return undefined;
  if (!streaming || streaming.lines <= 0) return shortPath(path);
  return `${shortPath(path)} · ${t('{{count}} lines so far', { count: streaming.lines })}`;
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
  const t = options.t ?? englishTranslate;
  /** "TODO in ai-client" — the one place a search arg names its repo. */
  const inRepo = (pattern: string) =>
    repoName ? t('{{pattern}} in {{repo}}', { pattern, repo: repoName }) : pattern;

  let raw: string | undefined;
  let kind: ToolArgKind | undefined;
  switch (run.toolName) {
    // ─── pi built-ins (T12-b). Argument names per the SDK schemas; see
    // `PI_TOOL_NAMES`. Without these every pi call fell to `default:`, whose
    // probe order is `command ?? description ?? path ?? … ?? pattern` — so a
    // `grep` showed its PATH ("src") instead of what was searched for
    // ("TODO"), and every path rendered proportional instead of mono.
    case PI_TOOL_NAMES.read: {
      const path = stringField(rec, 'path');
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
    case PI_TOOL_NAMES.edit:
    case PI_TOOL_NAMES.write: {
      raw = fileArgWithProgress(stringField(rec, 'path'), run.input, t);
      if (raw) kind = 'ident';
      break;
    }
    case PI_TOOL_NAMES.grep:
    case PI_TOOL_NAMES.find:
    // subagent-data-06: our own `glob`, which the SDK calls `find`. Same
    // treatment — the pattern is what the call is about, and without this case
    // the `default:` branch showed the `path` it was narrowed to instead.
    case RUNTIME_TOOL_NAMES.glob: {
      // The pattern is the point of the call; `path`/`glob` only narrow it.
      const pattern = stringField(rec, 'pattern');
      raw = pattern ? inRepo(pattern) : pattern;
      break;
    }
    case RUNTIME_TOOL_NAMES.browserPreview: {
      const path = stringField(rec, 'path');
      raw = path ? shortPath(path) : undefined;
      if (raw) kind = 'ident';
      break;
    }
    case RUNTIME_TOOL_NAMES.skill: {
      raw = stringField(rec, 'name');
      if (raw) kind = 'ident';
      break;
    }
    case RUNTIME_TOOL_NAMES.newContext:
      // The tool takes no arguments at all, so there is nothing to show but
      // what it does; a bare verb with no argument reads as a truncated row.
      // chat-tool-03: finished text, like every other arg — `ToolRows.tsx`
      // translates the VERB and prints the arg as-is, so an arg that skips `t`
      // reaches a Chinese window in English.
      raw = t('a fresh window');
      break;
    case RUNTIME_TOOL_NAMES.ask: {
      // The first question stands for the call. `questions` is an array of
      // objects, and the row is one line.
      const questions = rec?.questions;
      const first = Array.isArray(questions) ? asRecord(questions[0]) : undefined;
      raw = stringField(first, 'question') ?? stringField(first, 'header');
      break;
    }
    case RUNTIME_TOOL_NAMES.taskWait:
    case RUNTIME_TOOL_NAMES.taskStop: {
      const ids = rec?.delegationIds;
      const count = Array.isArray(ids) ? ids.length : 0;
      // Singular and plural are separate keys, as in `deriveAggregateRow`:
      // `N delegation(s)` cannot be translated at all — Chinese has no plural
      // and the parenthesis is not a word in either language.
      raw =
        count > 0
          ? count === 1
            ? t('{{count}} delegation', { count })
            : t('{{count}} delegations', { count })
          : t('all running');
      break;
    }
    case RUNTIME_TOOL_NAMES.taskList:
      raw = t('running subagents');
      break;
    case PI_TOOL_NAMES.ls: {
      // `path` is OPTIONAL on pi's `ls` — an argument-less call lists the
      // working directory, so say that rather than rendering a bare verb.
      const path = stringField(rec, 'path');
      raw = path ? shortPath(path) : t('working directory');
      kind = path ? 'ident' : 'prose';
      break;
    }
    case PI_TOOL_NAMES.bash:
    case PI_TOOL_NAMES.powershell: {
      // pi's bash schema has `command` and `timeout` only — no `description`
      // sibling, so unlike Claude's Bash there is no prose alternative here.
      // Which is exactly why the `cd` prefix has to go: with no description to
      // fall back on, the command IS the summary.
      const command = stringField(rec, 'command');
      raw = command ? commandSummary(command) : command;
      if (raw) kind = 'ident';
      break;
    }
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
      raw = pattern ? inRepo(pattern) : pattern;
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
      raw = fileArgWithProgress(stringField(rec, 'file_path'), run.input, t);
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
        const command = stringField(rec, 'command');
        raw = command ? commandSummary(command) : command;
        if (raw) kind = 'ident';
      }
      break;
    }
    case 'TodoWrite':
    case 'ExitPlanMode':
      raw = t('next moves');
      break;
    case 'Task':
    case 'Agent':
      // subagent-data-06 — `agent` is what OUR `Task` tool takes; the two CLI
      // spellings stay because a replayed Claude-era transcript still has them,
      // and a row falling through to `default:` here would print the whole
      // delegated brief (`prompt`) on one line.
      raw =
        stringField(rec, 'description') ??
        stringField(rec, 'agent') ??
        stringField(rec, 'subagent_type');
      break;
    default: {
      const probed =
        stringField(rec, 'command') ??
        stringField(rec, 'description') ??
        stringField(rec, 'path') ??
        stringField(rec, 'file_path') ??
        stringField(rec, 'pattern') ??
        stringField(rec, 'query') ??
        stringField(rec, 'prompt');
      // subagent-data-06 — an MCP tool is named `mcp__<server>__<tool>`, which
      // no table can enumerate. It stays LAST: a server that describes its own
      // call says more than its address does, and the label only replaces the
      // wire identifier this branch would otherwise print verbatim.
      const mcp = mcpToolLabel(run.toolName);
      raw = probed ?? mcp ?? run.toolName;
      if (!probed && mcp) kind = 'ident';
      break;
    }
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
  if (
    ![
      'Read',
      'NotebookRead',
      'Edit',
      'Write',
      'MultiEdit',
      PI_TOOL_NAMES.read,
      PI_TOOL_NAMES.edit,
      PI_TOOL_NAMES.write,
    ].includes(run.toolName)
  )
    return null;
  const rec = asRecord(run.input);
  const path = stringField(rec, 'path') ?? stringField(rec, 'file_path');
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

// chat-tool-08 — keyed on the tool name like every other table here, so it
// needed our own lowercase `bash` (and pi's `powershell` sibling) as well as
// Claude's capitalised spellings; without them a native shell call got the
// 60vh window meant for file output.
const BASH_TOOL_NAMES = new Set([
  'Bash',
  'BashOutput',
  'KillShell',
  PI_TOOL_NAMES.bash,
  PI_TOOL_NAMES.powershell,
]);

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
  // Decision 033 D6: only an IDENT truncates. Prose arg is a command line
  // (Bash's fallback summary), and truncating it made the call unreadable with
  // no way to recover — a `title` is unreachable by touch and keyboard, which is
  // why the fix is wrapping rather than a tooltip. Paths, URLs and shell words
  // keep their single line: they are copy-target content read char by char, and
  // a wrapped path is harder to scan than a truncated one.
  //
  // `min-w-0` stays on both: without it a long unbroken token refuses to shrink
  // and pushes the row's own verb and icon off a narrow row (the flexbox rule
  // in `renderer/AGENTS.md`).
  const colorClass = cn(
    'min-w-0',
    view.argKind === 'ident' ? 'truncate' : 'line-clamp-3',
    view.failed
      ? 'text-[color-mix(in_oklab,var(--destructive)_70%,var(--background))]'
      : 'text-tool-arg'
  );
  return view.argKind === 'ident'
    ? `${colorClass} font-mono text-code tracking-normal`
    : `${colorClass} tabular-nums`;
}
