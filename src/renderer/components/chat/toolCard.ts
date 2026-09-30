import { isDshBuiltinTool, type ToolCallPresentation } from '@shared/dshToolPresentation';
import { englishTranslate, type Translate } from '@shared/i18n';
import { reviewFromToolResult } from '@shared/sessionFileChange';
import { readStreamingToolArgs } from '@shared/streamingToolArgs';
import type { DshTodoItem, ToolOutcomeDetails } from '@shared/types/runtimeEvents';
import { cn } from '@/lib/utils';
import type { ChatBlock, ChatMessage } from '@/stores/chatSessions';
import { isQuietPermissionActivity } from './permissionActivityRow';
import {
  DSH_TOOL_NAMES,
  MCP_TOOL_PREFIX,
  mcpToolLabel,
  OFFICE_READ_TOOL_NAMES,
  OFFICE_WRITE_TOOL_NAMES,
  PI_TOOL_NAMES,
  RUNTIME_TOOL_NAMES,
} from './piToolNames';
import { derivePermissionAutoNote, derivePermissionVerb } from './questionCardModel';
import { deriveToolDiff, type ToolDiff } from './toolDiff';
import { dshShellOutputHead, isDshAbortedText, startAtLine } from './toolOutputHead';
import { formatThoughtRow } from './turnTiming';

// Re-exported so the pi tool vocabulary keeps ONE public entry point even
// though the constant itself had to move out to break an import cycle.
export {
  DSH_TOOL_NAMES,
  MCP_TOOL_PREFIX,
  mcpToolLabel,
  OFFICE_READ_TOOL_NAMES,
  OFFICE_WRITE_TOOL_NAMES,
  PI_TOOL_NAMES,
  RUNTIME_TOOL_NAMES,
} from './piToolNames';

/**
 * T-05 tool-row pure view model (A07 screen 5, groups A-F). Three layers:
 *
 *  1. pairing   — `pairToolBlocks` matches `tool_call`/`tool_result` blocks
 *     by `toolCallId` (results are never assumed adjacent: parallel tool use
 *     lands as call A, call B, result A, result B; `historyReader.ts` replay
 *     keeps them adjacent, but this function does not rely on either shape).
 *  2. grouping  — `groupTimeline` folds one assistant message's blocks into
 *     an ordered list of text / question / permission / toolGroup items.
 *  3. rows      — `deriveToolRowView` / `deriveToolGroupRows` turn a tool
 *     group into the rows `ToolRows.tsx`
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
   * T146 — epoch ms `bash` handed the command to `runtimeExec.run`, off the
   * block's `toolExecStartedAt` (a live `tool.updated` field; see
   * `stores/chatSessions.ts`). Undefined for every non-bash call and for a
   * call replayed from history, neither of which ever carries the stamp —
   * `deriveToolRowView` falls back to the `tool.started` origin for those.
   */
  execStartedAtMs?: number;
  /**
   * dsh-rebase decision 131: the title a plugin tool declared for this call
   * (`presentCall`), off the block's `toolPresentation`. The row prefers it
   * over the vocabulary for any tool that is not one of DSH's own.
   */
  presentation?: ToolCallPresentation;
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
      ...(typeof block.toolExecStartedAt === 'number'
        ? { execStartedAtMs: block.toolExecStartedAt }
        : {}),
      ...(block.toolPresentation ? { presentation: block.toolPresentation } : {}),
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

export type ToolRowBody = 'output' | 'detail' | 'thinking' | 'stats' | 'todos';

/**
 * dsh-rebase P1-7c: an argument that names a handle — a background job
 * (`job_output`, `job_kill`) or a subagent (`send_message`,
 * `interrupt_agent`) — whose human label lives in a store, not in the call.
 * The row derivation stays store-free: it carries the handle and a fallback
 * text (`ToolRowView.arg`), and the leaf that paints the argument looks the
 * label up (`composeRefArg` decides the wording either way).
 *
 * - `id-label`: `bash-3 · npm test` (the id is what the model wrote)
 * - `to-label`: `→ 调研 goal 投影` (a message is addressed to someone)
 * - `label`: the subagent's own label, else its id
 */
export interface ToolArgRef {
  kind: 'job' | 'subagent';
  id: string;
  format: 'id-label' | 'to-label' | 'label';
}

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
   */
  verb: string;
  /**
   * dsh-rebase decision 131: a plugin tool's own title for the call
   * (`Create report.docx`), painted verbatim in place of the verb and the
   * argument — the title already says both, in the plugin's words, which are
   * never translated (decision 073 rule 1). `verb` still names the operation
   * for every reader that words the row itself (the turn's live clause).
   * Absent on every other row, including a plugin command's (`terminal`
   * card), which reads as a shell row: 「终端」 + its command.
   */
  title?: string;
  /**
   * Which icon leads the row (decision 034). Optional: a view built outside
   * `deriveToolRowView` — the delegation panel's own rows — falls back to the
   * generic tool mark rather than claiming a type it did not classify.
   */
  iconKind?: ToolIconKind;
  /** Finished text, already translated by whoever built it. Never a catalog key. */
  arg?: string;
  /**
   * Font-domain classifier for `arg` (D25 §2.4/§2.5): 'ident' renders mono
   * (paths, URLs, raw commands -- copy-target content the user reads
   * char-by-char); 'prose' renders sans (human-written descriptions,
   * thought/worked-for durations). Mandatory semantics
   * whenever `arg` is set for a branch D25's arg-kind table covers; branches
   * it does not cover (Grep/Glob/WebSearch/Task/TodoWrite/unknown-tool
   * fallback) leave this undefined, which `toolRowArgClass` treats the same
   * as 'prose' -- the safe default direction (D25 §2.5: fail toward sans).
   */
  argKind?: 'ident' | 'prose';
  /**
   * dsh-rebase P1-7e (problem 18, decision 142): `arg` is a search pattern
   * (grep, glob, find), shown as written. A path-shaped arg has its file name
   * moved in front of its directory; `**\/*` is not a path, and splitting it
   * drew 「*（workspace） **\/」.
   */
  argPattern?: true;
  /**
   * The row is still in flight: present-tense verb, and a live body where the
   * row has one.
   *
   * A07 `:2331` also said a running row never shows a chevron. Decision 034
   * retired the chevron itself (the whole row is the affordance now), and the
   * half of that rule which survives is about the BODY: since 2026-09-23 a
   * standalone call DOES disclose its live input (the user could not see a
   * long-running bash command at all), while its output still only exists once
   * the call settles.
   */
  running: boolean;
  failed: boolean;
  /**
   * N5 (devbox 2026-09-24): the call never did its work — the runtime refused
   * it, or the run ended before it started. Such a row reads as the operation
   * that was asked for (the `refused` verb form) plus this word, never as a
   * completed one; see `toolRunOutcome` for how it is decided. T130 adds
   * `stopped`: the call ran and Stop cut it short, so it keeps the done-form
   * verb and its partial output. Absent on every call that ran to its end,
   * whatever came back.
   */
  outcome?: ToolRunOutcome;
  /**
   * The `tool.started` stamp of a running row (2026-09-23), for its live
   * elapsed tail. Only the START is derived here; the elapsed is computed at
   * paint (`runningElapsedMs`) by the one leaf that reads the ticking clock,
   * so a tick never re-derives a row. Undefined when no stamp is known —
   * omitted, never zero (the A07 :2399 rule).
   */
  runningStartedAtMs?: number;
  /**
   * The timeout the runtime will apply to a running row, when the input
   * names one. Bash-family only; read from `timeoutSeconds`/`timeoutMs` with
   * the runtime's own 120s default. dsh-rebase P1-7c: DSH does not kill a
   * command at its timeout, it moves it to the background (capped at 600s),
   * so the tail reads 「12s · 2m 后转后台」 rather than "elapsed / limit".
   */
  runningTimeoutMs?: number;
  /**
   * dsh-rebase P1-7c: the background job the call left behind — `promoted`
   * when its timeout moved a foreground command there (「已转后台 · bash-3」),
   * else a `run_in_background` call (「后台 · bash-2」). `id` is live only (the
   * bridge reads it off DSH's execution-local value); a replayed
   * `run_in_background` row knows it went to the background from its input
   * and says so without an id.
   */
  backgroundJob?: { id?: string; promoted: boolean };
  /**
   * dsh-rebase P1-7c: a shell command's non-zero exit code, read off DSH's
   * own `[exit code: N]` marker (`dsh-shell` `parseExitStatus`). A neutral
   * 「退出码 N」 tail, never red: whether a non-zero exit is a failure is the
   * model's call, as it was in 1.0.x.
   */
  exitCode?: number;
  /** dsh-rebase P1-7c: `todo_write`'s list, for the `todos` body (the todo card's `TodoList`). */
  todos?: readonly DshTodoItem[];
  /** dsh-rebase P1-7c: a handle argument whose label the painting leaf looks up. */
  argRef?: ToolArgRef;
  /** Only a row with a body can expand. */
  expandable: boolean;
  body?: ToolRowBody;
  /** Body text when `body === 'output'`. */
  output?: string;
  /**
   * dsh-rebase P1-7e (problem 21, decision 140): the output shown lost its
   * start — DSH kept only the tail of the command's stdout, or the row shows
   * the last live tail of a stopped call. The body opens on its first whole
   * line and says so above it: 「已省略前 x KB」 with `bytes`, and without them
   * (DSH's record does not say how much it dropped) 「已省略前面的输出」.
   */
  outputHeadOmitted?: { bytes?: number };
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
   * asks (2026-08-25). The one remaining producer is the subagent panel's LIVE
   * header row (T-34); the streaming thought's `defaultOpen` was retired with
   * the 2026-09-23 collapsed-by-default decision (see `buildThoughtRow`).
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
  /**
   * 2026-09-23 (user report: a 1800s command could neither be expanded nor
   * show any progress): the start stamp behind a running row's live elapsed
   * readout. Lookup into the turn-timing registry, keyed by `toolCallId`; the
   * value is the `tool.started` event timestamp. Omit it (or return nothing)
   * for a turn that is not running, and the row shows no clock.
   */
  toolStartedAtMs?: (toolCallId: string) => number | null | undefined;
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
  const outcome = toolRunOutcome(run) ?? undefined;
  const running = run.status === 'running';
  // A call that never ran did not FAIL: nothing was attempted. Its row says
  // what happened instead (`outcome`), in the row's ordinary tone — a
  // loop-guard cut used to paint 47 red rows for calls none of which executed.
  const failed = run.status === 'failed' && !outcome;
  // A refused call never ran, so it must not be described in the past tense —
  // the collapsed row is the only thing most readers see (§6.4, G-9). The same
  // holds for a call the runtime refused or never started (N5). A stopped one
  // did run (T130), so it keeps the done form: "Ran sleep 30 · Stopped".
  const neverRan = outcome === 'refused' || outcome === 'notStarted';
  const verbState: ToolVerbState =
    toolRunWasRefused(run) || neverRan ? 'refused' : running ? 'running' : 'done';
  // Decision 131: a plugin call that declared its own title reads by it.
  const presentation = pluginToolPresentation(run);
  const verb =
    presentation?.card === 'terminal'
      ? PRESENTED_COMMAND_VERBS[verbState]
      : toolVerb(run.toolName, verbState, run.input);
  const argDetail = presentation
    ? presentedArgDetail(presentation)
    : formatToolArgDetail(run, options);
  const argRef = presentation ? undefined : deriveToolArgRef(run);
  const link = deriveFileLink(run) ?? undefined;
  const hitSource = isHitListTool(run.toolName) && !outcome ? run.output : undefined;
  // P1-7e (problem 20): a call Stop cut short has no output of its own on
  // record, only DSH's `Error: tool call aborted`, which the outcome word
  // (「已停止」) already says in the reader's language. What the command printed
  // before the stop, when this window still holds it, is laid in by the row
  // (`withStoppedOutput`).
  const recordedOutput =
    outcome === 'stopped' && isDshAbortedText(run.output) ? undefined : run.output;

  // dsh-rebase P1-7c (decision 118's handoff): a `todo_write` row opens onto
  // the list it wrote, drawn by the todo card's own component — never the
  // argument JSON, and not DSH's one-line acknowledgement either. A failed
  // write keeps its error body instead.
  const todos = run.toolName === DSH_TOOL_NAMES.todoWrite ? todoItemsOf(run.input) : undefined;
  const showTodos = Boolean(todos && todos.length > 0) && !failed;

  // A never-started call has no output of its own — only the runtime's English
  // note, which `outcome` already says in the reader's language; so has one
  // whose outcome the engine never recorded (decision 032). A refusal keeps
  // its body: the runtime's reason is the only account of why.
  const showOutputBody =
    !showTodos &&
    !running &&
    outcome !== 'notStarted' &&
    outcome !== 'outcomeUnknown' &&
    (failed || Boolean(recordedOutput));
  // P1-7e (problem 21): a long command's record keeps the tail of its stdout;
  // the body starts on a whole line and says the start is missing.
  const outputHead =
    showOutputBody && recordedOutput && SHELL_EXIT_TOOL_NAMES.has(run.toolName)
      ? dshShellOutputHead(recordedOutput)
      : null;
  // P1-7c: how a settled call that ran to its end left things — a background
  // job, a shell's non-zero exit. Neither is a failure, and neither is said
  // over an outcome word (a stopped command's exit is Stop's, not its own).
  const settledClean = !running && !failed && !outcome;
  const backgroundJob = settledClean ? toolRunBackgroundJob(run) : undefined;
  const exitCode =
    settledClean && !backgroundJob && SHELL_EXIT_TOOL_NAMES.has(run.toolName)
      ? shellExitCode(run.output)
      : undefined;
  // 2026-09-23 (user report: a running command could not be expanded and its
  // full text was nowhere to be seen): a running call's input is now
  // expandable as a live preview. `tool.updated` rewrites
  // `toolInput` in the store, so the preview follows the input the same way the
  // settled body does — the old T-05 rule (input hidden until the call settles)
  // made the one command a reader most wants to watch, a long-running bash,
  // unreachable for its entire run.
  const recordedChange = reviewFromToolResult(run.result);
  const inputBody = recordedChange ? undefined : deriveToolInputBody(run);
  // Running Edit/Write arguments are explicitly labelled as a preview;
  // successful Edit results prefer the SDK patch once the call settles.
  const diff = recordedChange ? null : deriveToolDiff(run);
  const expandable = showTodos || showOutputBody || Boolean(inputBody) || Boolean(diff);

  // The live clock's origin. `tool.started` is stamped when the call is
  // issued, so the elapsed includes any approval wait that preceded execution
  // — that is the honest "how long has this row been on screen" number, and
  // the alternative (measuring from the exec start) has no event to read.
  // Keyed by `toolCallId`, the registry's own key. Undefined whenever no stamp
  // is on record, so a turn that is not running (the caller passes no lookup)
  // and un-timestamped history simply omit the readout.
  const startedAtMs = running ? options.toolStartedAtMs?.(run.toolCallId) : undefined;
  // T146 — `run.execStartedAtMs` is the instant `bash` actually handed the
  // command to `runtimeExec.run`, i.e. the runtime's own timeout origin.
  // Prefer it once known: showing "elapsed / limit" against the earlier
  // `tool.started` origin is exactly the "3m55s/2m" illusion this fixes,
  // because that origin includes arg streaming, the approval wait and the
  // path re-check, none of which the limit ever counted against. Only `bash`
  // ever sets `execStartedAtMs` (see `pairToolBlocks`), so every other tool
  // — and a bash call still waiting on approval, or replayed from history —
  // keeps the `tool.started` origin it always had.
  const execStartedAtMs = running ? run.execStartedAtMs : undefined;
  const runningStartedAtMs =
    typeof execStartedAtMs === 'number'
      ? execStartedAtMs
      : typeof startedAtMs === 'number'
        ? startedAtMs
        : undefined;
  // The "/ limit" tail is withheld until `execStartedAtMs` is known: before
  // that, the row is still streaming its arguments, waiting on approval, or
  // being path-checked, none of which the timeout is counting against yet —
  // showing the limit there is what read as "already past it" in the field
  // report. It reappears the moment exec really starts, measured from that
  // same instant, so elapsed and limit always share one origin.
  const runningTimeoutMs =
    running && typeof execStartedAtMs === 'number' ? bashTimeoutMsFromInput(run) : undefined;

  return {
    key: run.blockId,
    verb,
    ...(presentation && presentation.card !== 'terminal' ? { title: presentation.title } : {}),
    iconKind: presentation
      ? presentedIconKind(presentation, run.toolName)
      : toolIconKind(run.toolName),
    arg: argDetail?.text,
    argKind: argDetail?.kind,
    ...(argDetail?.pattern ? { argPattern: true } : {}),
    ...(argRef ? { argRef } : {}),
    running,
    failed,
    ...(outcome ? { outcome } : {}),
    ...(backgroundJob ? { backgroundJob } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    runningStartedAtMs,
    runningTimeoutMs,
    expandable,
    ...(showTodos ? { todos } : {}),
    body: showTodos ? 'todos' : showOutputBody ? 'output' : undefined,
    output: showOutputBody ? (outputHead ? outputHead.text : recordedOutput) : undefined,
    ...(outputHead?.headCut ? { outputHeadOmitted: {} } : {}),
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
  // dsh-rebase P1-7b: DSH's own delegation tools (decision 090: no custom
  // ones). The row says the description; the brief (`prompt`) is the body.
  subagent: ['description'],
  subagent_fork: ['description'],
  // subagent-data-06 — our own registry. `Glob` (capital) was already here and
  // `glob` was not, so every one of our glob rows also grew a full input body
  // under a summary that already said everything it had.
  // dsh-rebase P1-7c: DSH names the file `file_path`; the bridge adds a `path`
  // alias (`toolRowInput`) and nothing removes the original, so both are
  // covered — listing `path` alone grew a JSON body on every DSH read row.
  [RUNTIME_TOOL_NAMES.read]: ['file_path', 'path', 'offset', 'limit'],
  [RUNTIME_TOOL_NAMES.write]: ['file_path', 'path'],
  [RUNTIME_TOOL_NAMES.edit]: ['file_path', 'path'],
  [RUNTIME_TOOL_NAMES.glob]: ['pattern'],
  [RUNTIME_TOOL_NAMES.grep]: ['pattern'],
  // Decision 033 D6, applied to the pi-native spelling on 2026-09-23: the
  // one-line summary HARD-TRUNCATES the command at 40 characters
  // (`COMMAND_SUMMARY_MAX_CHARS`), so listing `command` as covered made every
  // character past the cut permanently unreachable — the input body was never
  // built, running or settled, and a long command could not be read in full at
  // any point in its life. That is what the report of an over-long command
  // the user could learn nothing about came down to. `description` stays
  // covered: it is what the summary prints.
  [RUNTIME_TOOL_NAMES.bash]: ['description'],
  [RUNTIME_TOOL_NAMES.browserPreview]: ['path'],
  // Empty on purpose, and declared rather than left to the default: the arg is
  // the FIRST question only, so the body is where the rest of them live.
  [RUNTIME_TOOL_NAMES.ask]: [],
  [RUNTIME_TOOL_NAMES.skill]: ['name'],
  [RUNTIME_TOOL_NAMES.newContext]: [],
  [RUNTIME_TOOL_NAMES.taskWait]: ['delegationIds'],
  [RUNTIME_TOOL_NAMES.taskStop]: ['delegationIds'],
  [RUNTIME_TOOL_NAMES.taskList]: [],
  // dsh-rebase P1-7c: DSH's own tools (plan P1-7 shard 04 §2, §3). `bash` and
  // `pwsh` build their body their own way (`deriveShellInputBody`), and
  // `exit_plan_mode`'s body is its plan (`deriveToolInputBody`).
  [DSH_TOOL_NAMES.readImage]: ['file_path', 'path'],
  [DSH_TOOL_NAMES.pwsh]: ['description'],
  [DSH_TOOL_NAMES.jobOutput]: ['job_id', 'wait', 'timeout_ms'],
  [DSH_TOOL_NAMES.jobList]: [],
  // The reason, when the model gave one, is the body.
  [DSH_TOOL_NAMES.jobKill]: ['job_id'],
  // The message is the body; the row names who it went to.
  [DSH_TOOL_NAMES.sendMessage]: ['agent_id'],
  [DSH_TOOL_NAMES.interruptAgent]: ['agent_id'],
  [DSH_TOOL_NAMES.listAgents]: ['scope'],
  // The list is drawn as the todo card draws it, never as JSON.
  [DSH_TOOL_NAMES.todoWrite]: ['todos'],
  [DSH_TOOL_NAMES.getGoal]: [],
  [DSH_TOOL_NAMES.createGoal]: ['objective'],
  // The handles the model had to copy from `get_goal` say nothing to a reader.
  [DSH_TOOL_NAMES.updateGoal]: ['goal_id', 'revision', 'action', 'objective', 'blocked_reason'],
  [DSH_TOOL_NAMES.exitPlanMode]: ['plan'],
  // The script and its declared phases are the body.
  [DSH_TOOL_NAMES.workflow]: [],
  [DSH_TOOL_NAMES.listMcpResources]: ['server', 'cursor'],
  [DSH_TOOL_NAMES.listMcpResourceTemplates]: ['server', 'cursor'],
  [DSH_TOOL_NAMES.readMcpResource]: ['server', 'uri'],
  // `ask`'s rule: the arg is the first question, the rest are the body.
  [DSH_TOOL_NAMES.askUserQuestion]: [],
  [DSH_TOOL_NAMES.webSearch]: ['queries'],
  [DSH_TOOL_NAMES.webFetch]: ['url'],
  [DSH_TOOL_NAMES.present]: [],
  [DSH_TOOL_NAMES.runCode]: ['description'],
  [DSH_TOOL_NAMES.listSubagentModels]: [],
  // The office plugin (decision 115): a read names its file and nothing else;
  // a write's content is the body, as `write`'s preview is on its card.
  ...Object.fromEntries(OFFICE_READ_TOOL_NAMES.map((name) => [name, ['path']])),
  ...Object.fromEntries(OFFICE_WRITE_TOOL_NAMES.map((name) => [name, ['path']])),
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
  // T101: while the marker is present the long fields are withheld and the
  // "body" would be the size summary printed back at the user as JSON — the
  // raw-argument body stays closed until the final `tool.updated` lands. This
  // now also guards the 2026-09-23 running-input preview, not just the settled
  // body it was written for.
  if (readStreamingToolArgs(run.input)) return undefined;
  if (SHELL_BODY_TOOL_NAMES.has(run.toolName)) return deriveShellInputBody(rec);
  // dsh-rebase P1-7c (shard 04 §2): the plan itself, as Markdown text rather
  // than as an escaped JSON string.
  if (run.toolName === DSH_TOOL_NAMES.exitPlanMode) return stringField(rec, 'plan');
  const covered = new Set(ARG_COVERED_FIELDS[run.toolName] ?? []);
  const hasExtra = keys.some((key) => !covered.has(key));
  if (!hasExtra) return undefined;
  return normalizeRawOutput(run.input);
}

/** The shells whose expanded input is the command itself (`deriveShellInputBody`). */
const SHELL_BODY_TOOL_NAMES: ReadonlySet<string> = new Set([
  RUNTIME_TOOL_NAMES.bash,
  DSH_TOOL_NAMES.pwsh,
]);

/**
 * dsh-rebase P1-7c (shard 04 §4, decision 073 rule 2): a shell call's expanded
 * input — the model's `description` on the first line, then the command
 * exactly as it ran, then any other argument (`workdir`, `timeoutMs`, …).
 *
 * The row itself keeps the command summary (the 2026-09-22 ruling), so this is
 * where DSH's "shown in the UI" description goes. Every line that is not the
 * command is a `#` comment, which both bash and PowerShell read as one: the
 * body stays safe to copy and run as a whole, the copy-and-rerun path
 * decision 033 D6 made this body for. Nothing is re-quoted or escaped — the
 * JSON body it replaces printed a multi-line command as `\n` escapes.
 */
function deriveShellInputBody(rec: Record<string, unknown>): string | undefined {
  const command = stringField(rec, 'command');
  if (!command) return normalizeRawOutput(rec);
  const oneLine = (text: string) => text.replace(/[\r\n]+/g, ' ');
  const description = stringField(rec, 'description');
  const rest = Object.entries(rec).filter(([key]) => key !== 'command' && key !== 'description');
  return [
    ...(description ? [`# ${oneLine(description)}`] : []),
    command,
    ...rest.map(
      ([key, value]) =>
        `# ${key}: ${typeof value === 'string' ? oneLine(value) : JSON.stringify(value)}`
    ),
  ].join('\n');
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
 * Mirrors the runtime's own default (`plugins/tools` DEFAULT_BASH_TIMEOUT_MS),
 * which is also DSH's (`dsh-bash-local` / `dsh-pwsh-local` `timeoutMs`).
 */
const DEFAULT_BASH_TIMEOUT_MS = 120_000;

/**
 * dsh-rebase P1-7c: DSH caps a per-call override at 600s (`maxTimeoutMs` of
 * `dsh-bash-local` / `dsh-pwsh-local`), so a longer ask moves to the
 * background at the cap, not at the number the model wrote.
 */
const MAX_SHELL_TIMEOUT_MS = 600_000;

const BASH_TIMEOUT_TOOL_NAMES = new Set(['Bash', RUNTIME_TOOL_NAMES.bash, DSH_TOOL_NAMES.pwsh]);

/**
 * The timeout a running bash-family call asked for, as the runtime will apply
 * it: `timeoutSeconds` wins over `timeoutMs` (the interface a model reaches
 * for), and neither present means the 120s default. Non-bash tools have no
 * deadline this side can name, so they return undefined and the row shows a
 * bare elapsed.
 *
 * dsh-rebase P1-7c: DSH's `timeoutMs` is capped at 600s, and a
 * `run_in_background` call has no timeout at all (it returns at once).
 */
function bashTimeoutMsFromInput(run: ToolRun): number | undefined {
  if (!BASH_TIMEOUT_TOOL_NAMES.has(run.toolName)) return undefined;
  const rec = asRecord(run.input);
  if (!rec) return DEFAULT_BASH_TIMEOUT_MS;
  if (rec.run_in_background === true) return undefined;
  const seconds = rec.timeoutSeconds;
  if (typeof seconds === 'number' && seconds > 0)
    return Math.min(seconds * 1000, MAX_SHELL_TIMEOUT_MS);
  const ms = rec.timeoutMs;
  if (typeof ms === 'number' && ms > 0) return Math.min(ms, MAX_SHELL_TIMEOUT_MS);
  return DEFAULT_BASH_TIMEOUT_MS;
}

/** The shells whose settled output ends in DSH's exit marker (`dsh-shell` `parseExitStatus`). */
const SHELL_EXIT_TOOL_NAMES: ReadonlySet<string> = new Set([
  RUNTIME_TOOL_NAMES.bash,
  DSH_TOOL_NAMES.pwsh,
]);

/**
 * dsh-rebase P1-7c (shard 04 §4): a shell command's non-zero exit code, off
 * the `[exit code: N]` marker DSH's shell tools append as the output's last
 * line — the same contract `dsh-shell`'s `parseExitStatus` reads, with its
 * rule that the marker must follow a newline and end the text, so output that
 * merely mentions one does not count. Undefined for exit 0 (no marker) and for
 * a signal kill (DSH writes `[killed by signal: X]` instead).
 */
export function shellExitCode(output: string | undefined): number | undefined {
  if (!output) return undefined;
  const match = /\n\[exit code: (\d+)\]$/.exec(output);
  if (!match?.[1]) return undefined;
  const code = Number(match[1]);
  return Number.isSafeInteger(code) && code !== 0 ? code : undefined;
}

/**
 * dsh-rebase P1-7c (shard 04 §4): the background job a settled call left
 * behind. The job id is the bridge's (`details.backgroundJob`, live only — DSH
 * never logs the value it comes from); a replayed call that asked for
 * `run_in_background` still says it went there, without an id. A promoted
 * command in history reads as an ordinary finished call: its result text is
 * DSH's own account, and matching that prose is what this module never does.
 */
export function toolRunBackgroundJob(
  run: Pick<ToolRun, 'result' | 'input'>
): { id?: string; promoted: boolean } | undefined {
  const details = asRecord(asRecord(run.result)?.details);
  const job = asRecord(details?.backgroundJob);
  const id = stringField(job, 'id');
  if (id) return { id, promoted: job?.promoted === true };
  return asRecord(run.input)?.run_in_background === true ? { promoted: false } : undefined;
}

/** `todo_write`'s list, when the input carries a well-formed one. */
function todoItemsOf(input: unknown): DshTodoItem[] | undefined {
  const todos = asRecord(input)?.todos;
  if (!Array.isArray(todos)) return undefined;
  const items: DshTodoItem[] = [];
  for (const todo of todos) {
    const rec = asRecord(todo);
    const content = stringField(rec, 'content');
    const status = rec?.status;
    if (!content) continue;
    items.push({
      content,
      status: status === 'in_progress' || status === 'completed' ? status : 'pending',
    });
  }
  return items;
}

/**
 * The goal a goal tool's result names. DSH renders every goal tool's value as
 * its JSON (`dsh-tool-goal` `GOAL_OUTPUT`): `{goal: {objective, …} | null}`.
 * `null` is "there is no goal"; undefined is "nothing to read" (no result yet,
 * or not that shape).
 */
function goalObjectiveOf(output: string | undefined): string | null | undefined {
  if (!output) return undefined;
  try {
    const value = asRecord(JSON.parse(output));
    if (!value || !('goal' in value)) return undefined;
    if (value.goal === null) return null;
    return stringField(asRecord(value.goal), 'objective');
  } catch {
    return undefined;
  }
}

/**
 * dsh-rebase P1-7c: the handle a job or subagent tool names, for the leaf
 * that paints its argument to look the label up (`ToolArgRef`).
 */
function deriveToolArgRef(run: ToolRun): ToolArgRef | undefined {
  const rec = asRecord(run.input);
  switch (run.toolName) {
    case DSH_TOOL_NAMES.jobOutput:
    case DSH_TOOL_NAMES.jobKill: {
      const id = stringField(rec, 'job_id');
      return id ? { kind: 'job', id, format: 'id-label' } : undefined;
    }
    case DSH_TOOL_NAMES.sendMessage: {
      const id = stringField(rec, 'agent_id');
      return id ? { kind: 'subagent', id, format: 'to-label' } : undefined;
    }
    case DSH_TOOL_NAMES.interruptAgent: {
      const id = stringField(rec, 'agent_id');
      return id ? { kind: 'subagent', id, format: 'label' } : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * The argument a handle row shows once its label is (or is not) known:
 * `bash-3 · npm test`, `→ 调研 goal 投影`, or the subagent's label. Without a
 * label every format keeps the row's own fallback text — the id for a job or
 * an interrupt, the message itself for a `send_message`.
 */
export function composeRefArg(
  view: Pick<ToolRowView, 'arg' | 'argKind'>,
  ref: ToolArgRef,
  label: string | undefined
): { text: string | undefined; kind: ToolArgKind | undefined } {
  const known = label?.replace(/[\r\n]+/g, ' ').trim();
  if (!known) return { text: view.arg, kind: view.argKind };
  switch (ref.format) {
    case 'id-label':
      return { text: `${ref.id} · ${known}`, kind: 'ident' };
    case 'to-label':
      return { text: `→ ${known}`, kind: 'prose' };
    case 'label':
      return { text: known, kind: 'prose' };
  }
}

/**
 * A running row's live elapsed, computed at paint from its
 * `runningStartedAtMs` and the timeline's one-second clock. Undefined when
 * either is missing, or when the clock reads earlier than the stamp — that is
 * unknown time, not negative time.
 */
export function runningElapsedMs(
  startedAtMs: number | undefined,
  nowMs: number | null | undefined
): number | undefined {
  if (typeof startedAtMs !== 'number' || typeof nowMs !== 'number') return undefined;
  return nowMs >= startedAtMs ? nowMs - startedAtMs : undefined;
}

/**
 * One tool group -> its top-level rows. One row per entry, in order.
 *
 * A run becomes a tool row (`deriveToolRowView`); a thinking entry becomes a
 * Thought row (`turnTiming.formatThoughtRow`). Nothing is grouped, counted or
 * summarised here any more — see the note inside for why T105's segmentation
 * and decision 031's aggregate row were retired together on 2026-09-22.
 *
 * ## What the FB7 red line turned into
 *
 * A run carrying a `permission` record used to be a SEPARATOR, so that a
 * decision the user had been asked to make could never be summarised as
 * 「12 次工具调用」 behind two clicks. With no aggregate row left, every run is
 * its own row and the property holds by construction — the rule did not lose
 * its reason, it lost the thing it was defending against.
 */
export function deriveToolGroupRows(
  entries: readonly ToolGroupEntry[],
  options: ToolCardOptions & ThinkingRowOptions = {}
): ToolRowView[] {
  // Only the two thinking-only fields are split off. Everything else —
  // `toolStartedAtMs` included — stays on `cardOptions` for the tool rows: an
  // earlier cut destructured the clock inputs out here and then dropped them,
  // so no running row in the timeline ever showed its elapsed.
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
  // 2026-09-22 (decision 034, user decision): ONE ROW PER ENTRY. The
  // segmentation that used to live here — group adjacent calls, collapse two or
  // more into an aggregate row, break the run on a separator — is retired whole.
  //
  // It was decision 031's answer to 「过程条目太碎」, and it did reduce the row
  // COUNT. What the user reported after living with it is that it did not
  // reduce the NOISE, because it paid for every folded run with a third
  // disclosure level: a turn had a process head, an aggregate row inside it,
  // and a chevron on every row inside that. Compared against zcode — 「为什么
  // 它的看起来这么简洁清爽呢」 — the difference was never how much is hidden;
  // zcode hides nothing at this level and reads cleaner because each row is
  // short, dim and has no control on it.
  //
  // So the density fix moved down a layer (icon + two-character type label, a
  // capped argument, no chevron) and this layer went flat. `turnProcessFold`'s
  // per-turn head is the one disclosure left, which is also what zcode's
  // 「已工作 6 分 41 秒 ⌄」 is.
  for (const entry of entries) pushStandaloneRow(entry);
  return rows;
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
  // ## A thought is collapsed by default (2026-09-23, user decision)
  //
  // It used to start OPEN — first as bare live text, then (2026-09-19) as an
  // ordinary expandable row with `defaultOpen: true`, on the argument that a
  // 12-20s think must not look like a frozen window. What the user reported
  // after living with that is that the open-by-default preview (200 chars +
  // an inline expand/collapse button) was itself the noise: they asked for the
  // thought to start collapsed, open to its full text on a click, and lose the
  // preview button. The frozen-window worry is now carried elsewhere — the
  // turn head's live "thinking N s" clause still shows that thinking is
  // happening — so the row starts closed, one click opens the full text, and
  // `resolveToolRowOpen` keeps that choice across the settle.
  return {
    key: block.id,
    verb,
    iconKind: 'thinking',
    arg,
    argKind,
    running: streaming,
    failed: false,
    expandable: showBody,
    body: showBody ? 'thinking' : undefined,
    output: showBody ? block.text : undefined,
  };
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
  // dsh-rebase P1-7b: DSH's delegation tools carry the same lane (plan P1-7
  // shard 04 §2); the fork says so in its argument (「分叉 · …」, P1-7c).
  [DSH_TOOL_NAMES.subagent]: { done: 'Delegated', running: 'Delegating', refused: 'Delegate' },
  [DSH_TOOL_NAMES.subagentFork]: { done: 'Delegated', running: 'Delegating', refused: 'Delegate' },
  // ── dsh-rebase P1-7c: the rest of DSH's tools (plan P1-7 shard 04 §2, §3).
  // `read` / `write` / `edit` / `grep` / `bash` / `skill` share the keys above
  // (one name, one row), `glob` too. `ralph`, `structured_output` and
  // `plugin_manager` read as the unknown-tool fallback on purpose
  // (`dshToolVocabulary.test.ts` lists them).
  [DSH_TOOL_NAMES.readImage]: {
    done: 'Viewed image',
    running: 'Viewing image',
    refused: 'View image',
  },
  // Windows' shell: the same row as bash (decision 073 rule 3).
  [DSH_TOOL_NAMES.pwsh]: { done: 'Ran', running: 'Running', refused: 'Run' },
  [DSH_TOOL_NAMES.jobOutput]: {
    done: 'Read job output',
    running: 'Reading job output',
    refused: 'Read job output',
  },
  [DSH_TOOL_NAMES.jobList]: { done: 'Listed jobs', running: 'Listing jobs', refused: 'List jobs' },
  [DSH_TOOL_NAMES.jobKill]: { done: 'Stopped job', running: 'Stopping job', refused: 'Stop job' },
  [DSH_TOOL_NAMES.sendMessage]: {
    done: 'Messaged subagent',
    running: 'Messaging subagent',
    refused: 'Message subagent',
  },
  [DSH_TOOL_NAMES.interruptAgent]: {
    done: 'Interrupted subagent',
    running: 'Interrupting subagent',
    refused: 'Interrupt subagent',
  },
  // The words our own `TaskList` already had.
  [DSH_TOOL_NAMES.listAgents]: {
    done: 'Listed subagents',
    running: 'Listing subagents',
    refused: 'List subagents',
  },
  [DSH_TOOL_NAMES.todoWrite]: { done: 'Planned', running: 'Planning', refused: 'Plan' },
  [DSH_TOOL_NAMES.getGoal]: {
    done: 'Checked goal',
    running: 'Checking goal',
    refused: 'Check goal',
  },
  [DSH_TOOL_NAMES.createGoal]: { done: 'Set goal', running: 'Setting goal', refused: 'Set goal' },
  // The fallback for an action this build does not know; each known action
  // has its own words (`UPDATE_GOAL_VERBS`).
  [DSH_TOOL_NAMES.updateGoal]: {
    done: 'Updated goal',
    running: 'Updating goal',
    refused: 'Update goal',
  },
  [DSH_TOOL_NAMES.exitPlanMode]: { done: 'Planned', running: 'Planning', refused: 'Plan' },
  [DSH_TOOL_NAMES.workflow]: {
    done: 'Ran workflow',
    running: 'Running workflow',
    refused: 'Run workflow',
  },
  [DSH_TOOL_NAMES.listMcpResources]: {
    done: 'Listed resources',
    running: 'Listing resources',
    refused: 'List resources',
  },
  [DSH_TOOL_NAMES.listMcpResourceTemplates]: {
    done: 'Listed resources',
    running: 'Listing resources',
    refused: 'List resources',
  },
  [DSH_TOOL_NAMES.readMcpResource]: { done: 'Read', running: 'Reading', refused: 'Read' },
  // Decisions 098 / 114: DSH's question tool reads as our `ask` did.
  [DSH_TOOL_NAMES.askUserQuestion]: { done: 'Asked', running: 'Asking', refused: 'Ask' },
  [DSH_TOOL_NAMES.webSearch]: { done: 'Searched', running: 'Searching', refused: 'Search' },
  [DSH_TOOL_NAMES.webFetch]: { done: 'Fetched', running: 'Fetching', refused: 'Fetch' },
  [DSH_TOOL_NAMES.present]: { done: 'Presented', running: 'Presenting', refused: 'Present' },
  [DSH_TOOL_NAMES.runCode]: { done: 'Ran code', running: 'Running code', refused: 'Run code' },
  [DSH_TOOL_NAMES.listSubagentModels]: {
    done: 'Listed models',
    running: 'Listing models',
    refused: 'List models',
  },
  // Decision 115: the office plugin's reads read a file, its writes write one
  // — the words `read` and `write` already have, so the row says what the
  // gate classified (the file name carries the format).
  ...Object.fromEntries(
    OFFICE_READ_TOOL_NAMES.map((name) => [
      name,
      { done: 'Read', running: 'Reading', refused: 'Read' },
    ])
  ),
  ...Object.fromEntries(
    OFFICE_WRITE_TOOL_NAMES.map((name) => [
      name,
      { done: 'Edited', running: 'Editing', refused: 'Edit' },
    ])
  ),
};

/**
 * dsh-rebase P1-7c (shard 04 §2): `update_goal` says which update it is — the
 * verb follows the call's `action`. Keys are `dsh-tool-goal`'s own action
 * enum; `edit` shares 「编辑目标」 with the goal bar's own menu item.
 */
export const UPDATE_GOAL_VERBS: Readonly<Record<string, ToolVerbs>> = {
  complete: { done: 'Completed goal', running: 'Completing goal', refused: 'Complete goal' },
  blocked: {
    done: 'Marked goal blocked',
    running: 'Marking goal blocked',
    refused: 'Mark goal blocked',
  },
  pause: { done: 'Paused goal', running: 'Pausing goal', refused: 'Pause goal' },
  resume: { done: 'Resumed goal', running: 'Resuming goal', refused: 'Resume goal' },
  edit: { done: 'Edited goal', running: 'Editing goal', refused: 'Edit goal' },
};

/**
 * dsh-rebase P1-7c (shard 04 §2): a running `job_output` that waits for its
 * job (`wait: true`) is waiting, not reading — it can sit there for minutes.
 */
export const JOB_OUTPUT_WAIT_VERB = 'Waiting for job';

/**
 * The fallback for a tool no table names — a plugin tool without its own
 * entry, or a DSH tool added after this build (decision 073 rule 1). It used
 * to be `Ran`, whose Chinese is 「终端」, so a plugin's row claimed it had run
 * a shell command; 「工具」 claims nothing. The row's argument starts with
 * the tool's own name (`formatToolArgDetail`'s `default:`).
 */
export const UNKNOWN_TOOL_VERB: ToolVerbs = {
  done: 'Used tool',
  running: 'Using tool',
  refused: 'Use tool',
};

/**
 * subagent-data-06 — every MCP-bridged tool, which no table can enumerate.
 *
 * The name is `mcp__<server>__<tool>`, composed at runtime, so these can only
 * be matched by prefix. "Called" rather than "Ran": an MCP tool is a request to
 * another process, and the row already names which one in its argument.
 */
export const MCP_TOOL_VERB: ToolVerbs = { done: 'Called', running: 'Calling', refused: 'Call' };

/**
 * dsh-rebase decision 131 (decision 073 rule 1, decision 120 item 27): the
 * title a plugin tool declared for a call, when the row should read by it —
 * never for one of DSH's own tools, whose rows are P1-7c's vocabulary even if
 * something handed them a presentation.
 *
 * It outranks the vocabulary for a tool that has an entry too (the office
 * plugin's 「读取」 / 「编辑」, decision 120 rule 10): the user asked for the
 * plugin's own title (decision 130), and the entry stays as the reading of a
 * call that carries none — a session read by a host with the plugin switched
 * off, or one from before decision 131.
 */
export function pluginToolPresentation(
  run: Pick<ToolRun, 'toolName' | 'presentation'>
): ToolCallPresentation | undefined {
  const presentation = run.presentation;
  if (!presentation || isDshBuiltinTool(run.toolName)) return undefined;
  return typeof presentation.title === 'string' && presentation.title.trim() !== ''
    ? presentation
    : undefined;
}

/** A plugin's command (a `terminal` card) reads as a shell row: 「终端」 + the command. */
const PRESENTED_COMMAND_VERBS: ToolVerbs = { done: 'Ran', running: 'Running', refused: 'Run' };

/**
 * Decision 131: which icon a presented call wears — its card, then its
 * category (DSH's `ToolCallKind`, "used by a UI to pick an icon"). A category
 * that says nothing (`other`, or none) keeps the tool's own icon.
 */
export function presentedIconKind(
  presentation: ToolCallPresentation,
  toolName: string
): ToolIconKind {
  if (presentation.card === 'terminal') return 'terminal';
  if (presentation.card === 'diff') return 'edit';
  switch (presentation.kind) {
    case 'read':
      return 'read';
    case 'edit':
    case 'delete':
    case 'move':
      return 'edit';
    case 'search':
      return 'search';
    case 'execute':
      return 'terminal';
    case 'fetch':
      return 'web';
    default:
      return toolIconKind(toolName);
  }
}

/** A presented command's argument is its summary, as a shell row's is; a titled row has none. */
function presentedArgDetail(presentation: ToolCallPresentation): ToolArgDetail | undefined {
  if (presentation.card !== 'terminal') return undefined;
  return { text: commandSummary(presentation.title), kind: 'ident' };
}

/**
 * The row's verb key. `input` is optional and read by two DSH tools only:
 * `update_goal` (its `action`) and a waiting `job_output`.
 */
export function toolVerb(toolName: string, state: ToolVerbState, input?: unknown): string {
  const rec = asRecord(input);
  if (toolName === DSH_TOOL_NAMES.updateGoal) {
    const action = stringField(rec, 'action');
    const byAction =
      action && Object.hasOwn(UPDATE_GOAL_VERBS, action) ? UPDATE_GOAL_VERBS[action] : undefined;
    if (byAction) return byAction[state];
  }
  if (toolName === DSH_TOOL_NAMES.jobOutput && state === 'running' && rec?.wait === true) {
    return JOB_OUTPUT_WAIT_VERB;
  }
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
 * N5: why a call that has a result never did its work, or `null` when it did.
 *
 * - `refused` — the runtime answered it with a refusal instead of acting (the
 *   subagent plugin's repeated idle `TaskWait` / `TaskStop` / `TaskList`).
 * - `notStarted` — the run ended after the model wrote the call and before the
 *   runtime executed it (Stop, a loop-guard cut, a provider error).
 * - `stopped` (T130) — the call DID run and Stop cut it short (a `bash` whose
 *   command was aborted). Unlike the two above it keeps the done-form verb —
 *   the command really ran — and its partial output.
 * - `outcomeUnknown` (dsh-rebase decision 032) — the call started and the
 *   engine died before its result was recorded: it may or may not have done
 *   its work. Done-form verb, since it did start; no body, since the only
 *   text is the engine's note to the model.
 *
 * Read ONLY off the structured `details` the result carries
 * (`ToolOutcomeDetails`: the projector copies `refused` / `stopped` from the
 * tool's own result and stamps `notStarted` on the calls it settles; the
 * history projection does the same on replay). Never off the text: "Refused:"
 * and "The run ended before this call started." are prose for the model and
 * for logs, and a row that matched them would change meaning with a reworded
 * sentence.
 *
 * A call refused by its AUTHORIZATION is `toolRunWasRefused`'s case, not this
 * one: it carries a decision word of its own.
 */
export type ToolRunOutcome = 'refused' | 'notStarted' | 'stopped' | 'outcomeUnknown';

export function toolRunOutcome(run: Pick<ToolRun, 'result'>): ToolRunOutcome | null {
  const result = run.result;
  if (!result || typeof result !== 'object' || !('details' in result)) return null;
  const details = (result as { details?: unknown }).details;
  if (!details || typeof details !== 'object') return null;
  const flags = details as ToolOutcomeDetails;
  if (flags.notStarted === true) return 'notStarted';
  if (flags.outcomeUnknown === true) return 'outcomeUnknown';
  if (flags.refused === true) return 'refused';
  if (flags.stopped === true) return 'stopped';
  return null;
}

/**
 * The word an outcome row ends with, as a catalog KEY (translated at the
 * render site, like `verb`).
 */
export const TOOL_RUN_OUTCOME_LABEL: Readonly<Record<ToolRunOutcome, string>> = {
  refused: 'Refused',
  notStarted: 'Not run',
  stopped: 'Stopped',
  outcomeUnknown: 'Outcome unknown',
};

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
export const DELEGATION_TOOL_NAMES: ReadonlySet<string> = new Set([
  'Task',
  'Agent',
  // dsh-rebase P1-7b: DSH's `subagent` (continuable, in the background by
  // default) and `subagent_fork` (one-shot) — their children's activity is a
  // lane under the row, like 1.0.x's (decisions 072 rule 7, 119).
  'subagent',
  'subagent_fork',
]);

export function isDelegationTool(toolName: string): boolean {
  return DELEGATION_TOOL_NAMES.has(toolName);
}

// `ls` counts as a SEARCH, not a read: the aggregate row phrases reads as
// "N files" and dedupes them by path, and a directory listing is neither a file
// nor something you read twice by accident. "N searches" is the honest bucket.
const READ_TOOL_NAMES = new Set<string>([
  'Read',
  'NotebookRead',
  PI_TOOL_NAMES.read,
  // dsh-rebase P1-7c: an image and an office document are files read too.
  DSH_TOOL_NAMES.readImage,
  ...OFFICE_READ_TOOL_NAMES,
]);
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

/**
 * Which ICON a row wears (decision 034, 2026-09-22).
 *
 * A kind, not a component: this module is React-free by contract (see the file
 * header — "No React, no `window`"), so the mapping to a Lucide element lives
 * in `ToolRows.tsx` and only the decision lives here, where it is unit-testable
 * next to the verb tables it has to agree with.
 *
 * Finer than `classifyTool`, and deliberately so. That function answers "which
 * bucket does this COUNT into", and `terminal` / `edit` / `delegate` are all
 * one bucket (`action`) to it — a distinction that does not matter for a count
 * and is the entire point of an icon. Reusing it would have put a hammer on a
 * `git grep`.
 *
 * ⚠️ The icon and the verb are two statements about the same row, and they are
 * kept in lockstep by test rather than by structure: a tool whose verb says
 * 「编辑」 and whose icon is a terminal is not a type error. If you add a tool
 * to `TOOL_VERBS`, add it here too.
 */
export type ToolIconKind =
  | 'terminal'
  | 'edit'
  | 'read'
  | 'search'
  | 'list'
  | 'web'
  | 'delegate'
  | 'plan'
  | 'thinking'
  | 'tool'
  // dsh-rebase P1-7c (plan P1-7 shard 04 §1): DSH's own kinds of work.
  | 'image'
  | 'todo'
  | 'goal'
  | 'job'
  | 'workflow'
  | 'mcp'
  | 'deliver';

const TERMINAL_TOOL_NAMES = new Set<string>([
  'Bash',
  'BashOutput',
  'KillShell',
  PI_TOOL_NAMES.bash,
  PI_TOOL_NAMES.powershell,
  RUNTIME_TOOL_NAMES.bash,
  // dsh-rebase P1-7c (decision 073 rule 3): Windows' shell, and DSH's PTC program.
  DSH_TOOL_NAMES.pwsh,
  DSH_TOOL_NAMES.runCode,
]);
const EDIT_TOOL_NAMES = new Set<string>([
  'Edit',
  'MultiEdit',
  'Write',
  'NotebookEdit',
  PI_TOOL_NAMES.edit,
  PI_TOOL_NAMES.write,
  ...OFFICE_WRITE_TOOL_NAMES,
]);
const WEB_TOOL_NAMES = new Set<string>([
  'WebFetch',
  'WebSearch',
  RUNTIME_TOOL_NAMES.browserPreview,
  DSH_TOOL_NAMES.webSearch,
  DSH_TOOL_NAMES.webFetch,
]);
const PLAN_TOOL_NAMES = new Set<string>(['TodoWrite', 'ExitPlanMode', DSH_TOOL_NAMES.exitPlanMode]);

/**
 * dsh-rebase P1-7c: DSH tools whose icon is a kind of its own (shard 04 §1).
 * The subagent handles beyond the two lanes (`send_message`,
 * `interrupt_agent`, `list_agents`, `list_subagent_models`) share the
 * delegation mark without being delegations: they open no lane.
 */
const DSH_ICON_KINDS: Readonly<Record<string, ToolIconKind>> = {
  [DSH_TOOL_NAMES.readImage]: 'image',
  [DSH_TOOL_NAMES.todoWrite]: 'todo',
  [DSH_TOOL_NAMES.getGoal]: 'goal',
  [DSH_TOOL_NAMES.createGoal]: 'goal',
  [DSH_TOOL_NAMES.updateGoal]: 'goal',
  [DSH_TOOL_NAMES.jobOutput]: 'job',
  [DSH_TOOL_NAMES.jobList]: 'job',
  [DSH_TOOL_NAMES.jobKill]: 'job',
  [DSH_TOOL_NAMES.workflow]: 'workflow',
  [DSH_TOOL_NAMES.listMcpResources]: 'mcp',
  [DSH_TOOL_NAMES.listMcpResourceTemplates]: 'mcp',
  [DSH_TOOL_NAMES.readMcpResource]: 'mcp',
  [DSH_TOOL_NAMES.present]: 'deliver',
  [DSH_TOOL_NAMES.sendMessage]: 'delegate',
  [DSH_TOOL_NAMES.interruptAgent]: 'delegate',
  [DSH_TOOL_NAMES.listAgents]: 'delegate',
  [DSH_TOOL_NAMES.listSubagentModels]: 'delegate',
};

export function toolIconKind(toolName: string): ToolIconKind {
  if (Object.hasOwn(DSH_ICON_KINDS, toolName)) return DSH_ICON_KINDS[toolName] as ToolIconKind;
  // Order matters where the sets overlap: `WebSearch` is a SEARCH to
  // `classifyTool` (it counts as one) but a globe to the reader, and a reader
  // who sees a magnifier expects local hits.
  if (WEB_TOOL_NAMES.has(toolName)) return 'web';
  if (TERMINAL_TOOL_NAMES.has(toolName)) return 'terminal';
  if (EDIT_TOOL_NAMES.has(toolName)) return 'edit';
  if (PLAN_TOOL_NAMES.has(toolName)) return 'plan';
  if (isDelegationTool(toolName)) return 'delegate';
  // Shard 04 §3: an MCP-bridged tool wears the plug its resource tools wear.
  if (toolName.startsWith(MCP_TOOL_PREFIX)) return 'mcp';
  // `ls` splits off from the search bucket here: its verb is 「列目录」 and a
  // magnifier would be the wrong promise for a listing.
  if (toolName === PI_TOOL_NAMES.ls) return 'list';
  const bucket = classifyTool(toolName);
  if (bucket === 'read') return 'read';
  if (bucket === 'search') return 'search';
  return 'tool';
}

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

/**
 * dsh-rebase P1-7c (plan P1-7 shard 04 §4): PowerShell's directory changes, in
 * every spelling a model writes them — `cd`, `Set-Location` (with or without
 * `-Path` / `-LiteralPath`), `Push-Location`, `pushd` — ended by `;` or by
 * pwsh 7's `&&`. Case-insensitive, as PowerShell is. The path may be quoted
 * or a bare Windows path (`C:\repo`); `;`, `&`, `|` and whitespace end it.
 *
 * The quotes are spelled `\x27` / `\x22`: the static scans in `__tests__`
 * (`fontDomainScan`) pair quote characters across a whole file, and a regex
 * literal carrying an odd number of them sends that scan into exponential
 * backtracking over every backslash after it.
 */
const PWSH_LOCATION_PREFIX_PATTERN =
  /^\s*(?:cd|set-location|push-location|pushd)\s+(?:-(?:literal)?path\s+)?(?:\x27[^\x27]*\x27|\x22[^\x22]*\x22|[^\s;|&()]+)\s*(?:;|&&)\s*/i;

/** Which shell's directory prefixes a summary strips. */
export type CommandDialect = 'bash' | 'pwsh';

function commandSummary(command: string, dialect: CommandDialect = 'bash'): string {
  const prefix = dialect === 'pwsh' ? PWSH_LOCATION_PREFIX_PATTERN : CD_PREFIX_PATTERN;
  let rest = command;
  // A loop, not a single replace: `cd a && cd b && cmd` is rare but real, and
  // stripping one level would leave the row looking like it starts at `cd`.
  while (prefix.test(rest)) {
    const next = rest.replace(prefix, '');
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

/** The first non-blank line of a text, trimmed. */
function firstLineOf(text: string): string | undefined {
  return (
    text
      .split(/\r\n|\n|\r/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? undefined
  );
}

/**
 * A Markdown text's first heading, else its first line — the title
 * `dsh-plan-mode` gives an `exit_plan_mode` card (`firstHeading(plan) ?? 'Plan'`),
 * with the first line instead of DSH's English word.
 */
function firstHeadingOf(markdown: string): string | undefined {
  for (const line of markdown.split(/\r\n|\n|\r/)) {
    const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading?.[1]) return heading[1];
  }
  return firstLineOf(markdown);
}

interface ToolArgDetail {
  text: string;
  kind?: ToolArgKind;
  /** A search pattern (`ToolRowView.argPattern`): never split like a path. */
  pattern?: true;
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
  let isPattern = false;
  switch (run.toolName) {
    // ─── pi built-ins (T12-b). Argument names per the SDK schemas; see
    // `PI_TOOL_NAMES`. Without these every pi call fell to `default:`, whose
    // probe order is `command ?? description ?? path ?? … ?? pattern` — so a
    // `grep` showed its PATH ("src") instead of what was searched for
    // ("TODO"), and every path rendered proportional instead of mono.
    case PI_TOOL_NAMES.read: {
      // dsh-rebase P1-7c: DSH's own name first; `path` is the bridge's alias
      // and what pi and our retired runtime sent.
      const path = stringField(rec, 'file_path') ?? stringField(rec, 'path');
      if (path) {
        // P1-7e (problem 12): an attached file by the name it was attached under.
        const attached = attachmentFileName(path);
        const shown = attached ? t('Attachment · {{name}}', { name: attached }) : shortPath(path);
        const offset = numberField(rec, 'offset');
        if (offset != null) {
          const limit = numberField(rec, 'limit');
          const endLine = limit != null ? offset + limit - 1 : offset;
          raw = `${shown} L${offset}-${endLine}`;
        } else {
          raw = shown;
        }
        kind = attached ? 'prose' : 'ident';
      }
      break;
    }
    case PI_TOOL_NAMES.edit:
    case PI_TOOL_NAMES.write: {
      raw = fileArgWithProgress(
        stringField(rec, 'file_path') ?? stringField(rec, 'path'),
        run.input,
        t
      );
      if (raw) kind = 'ident';
      break;
    }
    // ─── dsh-rebase P1-7c: DSH's own tools (plan P1-7 shard 04 §2, §3) ───
    case DSH_TOOL_NAMES.readImage: {
      const path = stringField(rec, 'file_path') ?? stringField(rec, 'path');
      const attached = path ? attachmentFileName(path) : undefined;
      raw = attached
        ? t('Attachment · {{name}}', { name: attached })
        : path
          ? shortPath(path)
          : undefined;
      if (raw) kind = attached ? 'prose' : 'ident';
      break;
    }
    case DSH_TOOL_NAMES.pwsh: {
      const command = stringField(rec, 'command');
      raw = command ? commandSummary(command, 'pwsh') : command;
      if (raw) kind = 'ident';
      break;
    }
    // The job id is the fallback; the painting leaf adds the job's label
    // when the jobs window knows it (`argRef`).
    case DSH_TOOL_NAMES.jobOutput:
    case DSH_TOOL_NAMES.jobKill:
      raw = stringField(rec, 'job_id');
      if (raw) kind = 'ident';
      break;
    case DSH_TOOL_NAMES.jobList:
      raw = t('all background jobs');
      break;
    // Addressed to a subagent the leaf names when it can; until then the
    // message itself says more than the child's session id would.
    case DSH_TOOL_NAMES.sendMessage:
      raw = stringField(rec, 'message');
      break;
    case DSH_TOOL_NAMES.interruptAgent:
      raw = stringField(rec, 'agent_id');
      if (raw) kind = 'ident';
      break;
    case DSH_TOOL_NAMES.listAgents:
      raw =
        stringField(rec, 'scope') === 'descendants' ? t('all descendants') : t('direct subagents');
      break;
    case DSH_TOOL_NAMES.todoWrite: {
      const todos = todoItemsOf(run.input);
      if (todos && todos.length > 0) {
        const done = todos.filter((todo) => todo.status === 'completed').length;
        raw = t('{{done}}/{{total}} done', { done, total: todos.length });
      }
      break;
    }
    // `get_goal` takes nothing: the goal it read is in its result.
    case DSH_TOOL_NAMES.getGoal: {
      const objective = goalObjectiveOf(run.output);
      raw = objective === null ? t('no goal') : objective;
      break;
    }
    case DSH_TOOL_NAMES.createGoal:
      raw = stringField(rec, 'objective');
      break;
    case DSH_TOOL_NAMES.updateGoal: {
      const action = stringField(rec, 'action');
      // What the update says, else the goal its result names.
      const said =
        action === 'blocked'
          ? stringField(rec, 'blocked_reason')
          : action === 'edit'
            ? stringField(rec, 'objective')
            : undefined;
      raw = said ?? goalObjectiveOf(run.output) ?? undefined;
      break;
    }
    // DSH's own card title for it: the plan's first heading (dsh-plan-mode).
    case DSH_TOOL_NAMES.exitPlanMode: {
      const plan = stringField(rec, 'plan');
      raw = plan ? firstHeadingOf(plan) : undefined;
      break;
    }
    case DSH_TOOL_NAMES.workflow:
      raw = stringField(asRecord(rec?.meta), 'name');
      if (raw) kind = 'ident';
      break;
    case DSH_TOOL_NAMES.listMcpResources:
    case DSH_TOOL_NAMES.listMcpResourceTemplates:
      raw = stringField(rec, 'server');
      if (raw) kind = 'ident';
      break;
    case DSH_TOOL_NAMES.readMcpResource: {
      const server = stringField(rec, 'server');
      const uri = stringField(rec, 'uri');
      raw = server && uri ? `${server} · ${uri}` : (uri ?? server);
      if (raw) kind = 'ident';
      break;
    }
    case DSH_TOOL_NAMES.webSearch: {
      const queries = Array.isArray(rec?.queries)
        ? rec.queries.filter((query): query is string => typeof query === 'string' && query !== '')
        : [];
      raw = queries.length > 0 ? queries.join(' · ') : undefined;
      break;
    }
    case DSH_TOOL_NAMES.webFetch:
      raw = stringField(rec, 'url');
      if (raw) kind = 'ident';
      break;
    case DSH_TOOL_NAMES.present: {
      const files = Array.isArray(rec?.files)
        ? rec.files
            .map((file) => stringField(asRecord(file), 'path'))
            .filter((path): path is string => Boolean(path))
            .map((path) => shortPath(path, 1))
        : [];
      raw = files.length > 0 ? files.join(', ') : undefined;
      if (raw) kind = 'ident';
      break;
    }
    case DSH_TOOL_NAMES.runCode: {
      const description = stringField(rec, 'description');
      const code = stringField(rec, 'code');
      raw = description ?? (code ? firstLineOf(code) : undefined);
      if (!description && raw) kind = 'ident';
      break;
    }
    case DSH_TOOL_NAMES.listSubagentModels:
      // No argument: the verb 「列模型」 is the whole row.
      raw = undefined;
      break;
    case DSH_TOOL_NAMES.askUserQuestion: {
      // `ask`'s rule: the first question stands for the call.
      const questions = rec?.questions;
      const first = Array.isArray(questions) ? asRecord(questions[0]) : undefined;
      raw = stringField(first, 'question') ?? stringField(first, 'header');
      break;
    }
    case PI_TOOL_NAMES.grep:
    case PI_TOOL_NAMES.find:
    // subagent-data-06: our own `glob`, which the SDK calls `find`. Same
    // treatment — the pattern is what the call is about, and without this case
    // the `default:` branch showed the `path` it was narrowed to instead.
    case RUNTIME_TOOL_NAMES.glob: {
      // The pattern is the point of the call; `path`/`glob` only narrow it.
      const searched = stringField(rec, 'pattern');
      raw = searched ? inRepo(searched) : searched;
      isPattern = Boolean(searched);
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
      // Singular and plural are separate keys:
      // `N delegation(s)` cannot be translated at all — Chinese has no plural
      // and the parenthesis is not a word in either language.
      //
      // No ids is described as what the CALL said, not as what the runtime
      // found: "all running" read as the tool reporting live subagents, which
      // is exactly the wrong impression when a model loops on these calls
      // after every delegate has finished.
      raw =
        count > 0
          ? count === 1
            ? t('{{count}} delegation', { count })
            : t('{{count}} delegations', { count })
          : t('no delegation named');
      break;
    }
    case RUNTIME_TOOL_NAMES.taskList:
      // Neutral for the same reason: the list covers every delegation in the
      // session, finished ones included.
      raw = t('all delegations');
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
      const searched = stringField(rec, 'pattern');
      raw = searched ? inRepo(searched) : searched;
      isPattern = Boolean(searched);
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
    case DSH_TOOL_NAMES.subagent:
      // subagent-data-06 — `agent` is what OUR `Task` tool takes; the two CLI
      // spellings stay because a replayed Claude-era transcript still has them,
      // and a row falling through to `default:` here would print the whole
      // delegated brief (`prompt`) on one line.
      raw =
        stringField(rec, 'description') ??
        stringField(rec, 'agent') ??
        stringField(rec, 'subagent_type');
      break;
    case DSH_TOOL_NAMES.subagentFork: {
      // dsh-rebase P1-7c (the prototype's 「已委派 分叉 · 复核方案」): a fork
      // carries the parent's whole context, so it says it is one. No agent
      // name: DSH's subagents have none (decision 090).
      const description = stringField(rec, 'description');
      raw = description ? `${t('Fork')} · ${description}` : t('Fork');
      break;
    }
    default: {
      // dsh-rebase P1-7c: the office plugin names its file in `path`.
      if (
        OFFICE_READ_TOOL_NAMES.includes(run.toolName) ||
        OFFICE_WRITE_TOOL_NAMES.includes(run.toolName)
      ) {
        const path = stringField(rec, 'path');
        raw = path ? shortPath(path) : undefined;
        if (raw) kind = 'ident';
        break;
      }
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
      if (mcp) {
        raw = probed ?? mcp;
        if (!probed) kind = 'ident';
        break;
      }
      // dsh-rebase P1-7c (decision 073 rule 1): a tool no table names — a
      // plugin's, or one DSH added after this build — says WHICH tool it is
      // first, since its verb (「工具」) no longer can; what it was about follows.
      raw = probed ? `${run.toolName} · ${probed}` : run.toolName;
      if (!probed) kind = 'ident';
      break;
    }
  }

  if (raw == null) return undefined;
  return { text: raw.replace(/[\r\n]+/g, ' '), kind, ...(isPattern ? { pattern: true } : {}) };
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
      // dsh-rebase P1-7c (shard 04 §2): the editor previews an image it opens.
      DSH_TOOL_NAMES.readImage,
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
/**
 * dsh-rebase P1-7e (problem 12, decision 142): where DSH keeps a file the
 * user attached — `DSH_HOME/attachments/v1/files/<sha[0..2]>/<sha256>/<name>`
 * (`dsh-attachment-local`'s layout). The model reads it by that path, which
 * says nothing to the user; the name they attached it under does.
 */
const DSH_ATTACHMENT_FILE =
  /[\\/]attachments[\\/]v1[\\/]files[\\/][0-9a-f]{2}[\\/][0-9a-f]{64}[\\/]([^\\/]+)$/i;

/** The attached file's own name when `path` is one of DSH's attachment copies. */
export function attachmentFileName(path: string): string | undefined {
  return DSH_ATTACHMENT_FILE.exec(path)?.[1];
}

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
const BASH_TOOL_NAMES = new Set<string>([
  'Bash',
  'BashOutput',
  'KillShell',
  PI_TOOL_NAMES.bash,
  PI_TOOL_NAMES.powershell,
  // dsh-rebase P1-7c: Windows' shell, and a background job's output.
  DSH_TOOL_NAMES.pwsh,
  DSH_TOOL_NAMES.jobOutput,
]);

/**
 * dsh-rebase P1-7e (problem 20, decision 140): a stopped call's row with what
 * the command printed before Stop, when this window still holds its last live
 * tail (`toolLiveOutputModel`'s `stopped`). The record of such a call is only
 * DSH's sentence about the stop, which `deriveToolRowView` leaves out; a row
 * whose record does carry output keeps it. A tail read from a byte offset
 * starts on its first whole line, and the row says how much came before.
 */
export function withStoppedOutput(
  view: ToolRowView,
  kept: { text: string; omittedBytes: number } | undefined
): ToolRowView {
  if (!kept?.text || view.outcome !== 'stopped' || view.output) return view;
  const head = startAtLine(kept.text, kept.omittedBytes);
  return {
    ...view,
    expandable: true,
    body: 'output',
    output: head.text,
    outputMaxHeightClass: view.outputMaxHeightClass ?? outputMaxHeightClass(view.toolName ?? ''),
    ...(head.omittedBytes > 0 ? { outputHeadOmitted: { bytes: head.omittedBytes } } : {}),
  };
}

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

/**
 * dsh-rebase decision 131: a plugin's title stands where the verb and the
 * argument would — the verb's tone (it leads the row), the argument's
 * truncation (a plugin wrote it, and a path inside it can be long).
 */
export function toolRowTitleClass(view: Pick<ToolRowView, 'failed'>): string {
  return cn('min-w-0 truncate', !view.failed && 'group-hover/row:text-foreground');
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
