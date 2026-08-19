import {
  PERMISSION_DIFF_MAX_BYTES,
  PERMISSION_DIFF_MAX_FILES,
  type PermissionDetail,
  type PermissionFileChange,
} from '../shared/types/runtimeEvents.ts';
import type { HistoryBlock } from '../shared/types/sessionHistory.ts';

/**
 * Codex `ThreadItem` -> AiClient block projection. PURE, zero IO, zero state.
 *
 * ## Why a pure function and not a method on the normalizer
 *
 * S2 §3 (slice 5b) says the history replay path and the live path must share
 * ONE item mapper. A live-only projection would be re-implemented by
 * `codexHistoryReader`, and the two copies would drift exactly where it is most
 * expensive: a resumed session rendering the same turn differently from the way
 * the user watched it happen. Everything stateful (message envelopes, block
 * ordering, streaming deltas) lives in `codexNormalizer.ts`; everything that is
 * a function of one item lives here.
 *
 * The output block union is `HistoryBlock` VERBATIM (aliased as `CodexBlock`),
 * so slice 5b can put these straight into a `HistoryMessage.blocks` and the live
 * path can fan the same blocks out into runtime events. One shape, two readers.
 *
 * ## The 18-variant rule
 *
 * `CODEX_ITEM_RULES` must have exactly the key set of `threadItemTypes` in
 * `__tests__/fixtures/codex/codex-method-contract.json` — the inventory the
 * codex binary generates for itself. `codexItemMapper.test.ts` asserts the two
 * key sets are equal, which is the single most important assertion in this
 * file: when a codex upgrade adds a 19th item type, that test goes red instead
 * of the item being silently dropped on the floor of a `default:` branch. Every
 * variant is therefore either projected or explicitly declared unrendered with
 * a reason — "not handled yet" is a value here, never an omission.
 *
 * ## Evidence discipline
 *
 * Item TYPE names are all [实测] from the generated contract. Item FIELD names
 * are a different evidence class — the contract snapshot lists types, not their
 * schemas — so every field read below is annotated: [实测] means a recorded
 * frame in `__tests__/fixtures/codex/` contains it, [推测] means it is a
 * best-effort read with a safe fallback and no wire consequence (nothing here
 * is ever sent back to codex, so a wrong guess degrades a label, it cannot
 * break the protocol).
 */

export type CodexBlock = HistoryBlock;

/** What the timeline does with an item. `not_rendered` is a decision, not a gap. */
export type CodexItemMode =
  | 'user_message'
  | 'agent_message'
  | 'reasoning'
  | 'tool'
  | 'not_rendered';

/**
 * Why an item produces no blocks this round.
 *
 * `subagent_axis`  — the fact belongs to the T-34 `subagent.activity` event,
 *                    whose payload is a 9-kind discriminated union modelled on
 *                    CLAUDE's delegation wire. Codex's shape is different, and
 *                    S1 measured that faking it costs ~385 lines. Rendering a
 *                    collaborator's work on the main agent's row is the exact
 *                    misattribution defect T-34 was written to fix, so dropping
 *                    is the honest degrade, not a shortcut.
 * `no_surface`     — no member of `HistoryBlock` / `RuntimeEventType` can carry
 *                    it (images, plans, injected hook prompts).
 * `lifecycle_only` — a state fact about the session, not transcript content.
 */
export type CodexItemSkipReason = 'subagent_axis' | 'no_surface' | 'lifecycle_only';

export interface CodexItemRule {
  readonly mode: CodexItemMode;
  /** Set iff `mode === 'not_rendered'`. */
  readonly skipReason?: CodexItemSkipReason;
  /** One line, surfaced in logs so a dropped item is diagnosable from a log tail. */
  readonly note: string;
}

/**
 * All 18 `threadItemTypes`, in the contract's own order.
 *
 * Pinned key-set-for-key-set against the generated contract by the test file.
 */
export const CODEX_ITEM_RULES: Readonly<Record<string, CodexItemRule>> = {
  userMessage: {
    mode: 'user_message',
    note: 'user turn echo; content[].text [实测]',
  },
  hookPrompt: {
    mode: 'not_rendered',
    skipReason: 'no_surface',
    note: 'context injected by a codex hook, not something the user typed or the agent said',
  },
  agentMessage: {
    mode: 'agent_message',
    note: 'assistant text; item.text [实测], streamed by item/agentMessage/delta',
  },
  plan: {
    mode: 'not_rendered',
    skipReason: 'no_surface',
    note: 'no plan surface in RuntimeEventType; rendering it as assistant text would fake a message',
  },
  reasoning: {
    mode: 'reasoning',
    note: 'thinking block; summary[] [实测], streamed by item/reasoning/*',
  },
  commandExecution: {
    mode: 'tool',
    note: 'tool row; command/cwd/aggregatedOutput/exitCode/status [实测]',
  },
  fileChange: {
    mode: 'tool',
    note: 'tool row; changes[].{path,kind,diff} [实测] — same diff the approval card needs',
  },
  mcpToolCall: {
    mode: 'tool',
    note: 'tool row; no recorded frame, so name/output are read defensively',
  },
  dynamicToolCall: {
    mode: 'tool',
    note: 'tool row; no recorded frame, so name/output are read defensively',
  },
  collabAgentToolCall: {
    mode: 'not_rendered',
    skipReason: 'subagent_axis',
    note: 'a collaborator agent acted, not the main one — main-row rendering would misattribute it',
  },
  subAgentActivity: {
    mode: 'not_rendered',
    skipReason: 'subagent_axis',
    note: 'T-34 subagent.activity is Claude-shaped (9-kind union); codex degrades honestly instead',
  },
  webSearch: {
    mode: 'tool',
    note: 'tool row; query/results read defensively (no recorded frame)',
  },
  imageView: {
    mode: 'not_rendered',
    skipReason: 'no_surface',
    note: 'HistoryBlock has no image member; a path-only text block would misrepresent it',
  },
  sleep: {
    mode: 'not_rendered',
    skipReason: 'lifecycle_only',
    note: 'the agent waited; nothing was produced for the transcript',
  },
  imageGeneration: {
    mode: 'not_rendered',
    skipReason: 'no_surface',
    note: 'HistoryBlock has no image member',
  },
  enteredReviewMode: {
    mode: 'not_rendered',
    skipReason: 'lifecycle_only',
    note: 'codex-side UI mode change; AiClient has no review mode to enter',
  },
  exitedReviewMode: {
    mode: 'not_rendered',
    skipReason: 'lifecycle_only',
    note: 'codex-side UI mode change; AiClient has no review mode to exit',
  },
  contextCompaction: {
    mode: 'not_rendered',
    skipReason: 'lifecycle_only',
    note: 'context was compacted; a transcript row would state a fact about the model, not the work',
  },
};

/** The 18 keys, as an array — handy for exhaustiveness tests and log copy. */
export const CODEX_ITEM_TYPES: readonly string[] = Object.keys(CODEX_ITEM_RULES);

/**
 * Display labels for tool rows.
 *
 * These are OUR labels keyed off the item type, not names read off the wire and
 * never sent back to it, so they carry none of the "guessed method name" risk
 * that `CODEX_METHOD` does. `mcpToolCall` / `dynamicToolCall` prefer a name read
 * off the item and fall back to these.
 */
export const CODEX_TOOL_LABEL: Readonly<Record<string, string>> = {
  commandExecution: 'shell',
  fileChange: 'apply_patch',
  webSearch: 'web_search',
  mcpToolCall: 'mcp_tool',
  dynamicToolCall: 'tool',
};

/**
 * Ceiling on one tool output crossing IPC.
 *
 * `aggregatedOutput` is whatever the command printed — a `cat` of a build log is
 * a plausible tens-of-megabytes payload, and the renderer keeps it in message
 * state for the life of the session. Clamped with the `truncated` flag the block
 * union already carries, so the UI can say so rather than silently lying.
 */
export const CODEX_TOOL_OUTPUT_MAX_CHARS = 16 * 1024;

/** `status` values that mean the item is still running, so it has no result yet. */
const IN_FLIGHT_STATUS = new Set(['inProgress', 'pending', 'queued']);

/** The one status that means success. Everything else (declined/failed/…) is not ok. */
const OK_STATUS = 'completed';

export interface CodexItemMapping {
  /** Wire `item.type`, or `null` when the frame did not carry a usable one. */
  itemType: string | null;
  /** Wire `item.id`, or `null`. Doubles as the toolCallId for tool rows. */
  itemId: string | null;
  outcome: 'rendered' | 'skipped' | 'unknown' | 'malformed';
  mode: CodexItemMode | null;
  /** Which row the blocks belong to; `null` when nothing is rendered. */
  role: 'user' | 'assistant' | null;
  blocks: CodexBlock[];
  skipReason: CodexItemSkipReason | null;
  /**
   * `agentMessage.phase` from the wire. Non-null only for `agent_message` items;
   * null for everything else. Known values: `'final_answer'`, `'commentary'`,
   * `null` (Codex fallback for untagged providers). Unknown values are passed
   * through verbatim so the caller can log without this function throwing.
   */
  phase: string | null;
  /** Always populated — a dropped item must be explainable from one log line. */
  note: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** `item.type` when it is a usable string. */
export function readCodexItemType(item: unknown): string | null {
  return isRecord(item) ? str(item.type) : null;
}

/** `item.id` when it is a usable string. */
export function readCodexItemId(item: unknown): string | null {
  return isRecord(item) ? str(item.id) : null;
}

/** Flatten `content` — a bare string, or the `[{type:'text', text}]` array [实测]. */
function extractContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push(part);
      continue;
    }
    if (!isRecord(part)) continue;
    const type = part.type;
    if ((type === undefined || type === 'text') && typeof part.text === 'string') {
      parts.push(part.text);
    }
  }
  return parts.join('');
}

/**
 * Reasoning text: `summary[]` first, then `content[]`.
 *
 * Both are arrays in every recorded frame; `summary` is the human-readable
 * headline ("**Implementing apply_patch execution**" [实测]) and `content` was
 * empty in all of them, so it is read the same defensive way rather than
 * assumed to have a shape.
 */
function extractReasoningText(item: Record<string, unknown>): string {
  const chunks: string[] = [];
  const summary = extractContentText(item.summary);
  if (summary) chunks.push(summary);
  const content = extractContentText(item.content);
  if (content) chunks.push(content);
  return chunks.join('\n\n');
}

function clampText(text: string): { text: string; truncated: boolean } {
  if (text.length <= CODEX_TOOL_OUTPUT_MAX_CHARS) return { text, truncated: false };
  return { text: text.slice(0, CODEX_TOOL_OUTPUT_MAX_CHARS), truncated: true };
}

/**
 * `changes[].kind.type` -> our four-wide change vocabulary.
 *
 * Only `add` has a recorded frame [实测]; the other three spellings are [推测]
 * and are matched leniently. An unrecognised kind falls back to `update`
 * (rather than being dropped) so the path still appears on the approval card —
 * a file the user cannot see is worse than a file whose verb is imprecise, and
 * the diff travels alongside either way.
 */
function readChangeKind(kind: unknown): PermissionFileChange['change'] {
  const raw = isRecord(kind) ? str(kind.type) : str(kind);
  switch (raw) {
    case 'add':
    case 'create':
      return 'add';
    case 'delete':
    case 'remove':
      return 'delete';
    case 'rename':
    case 'move':
      return 'rename';
    default:
      return 'update';
  }
}

/**
 * Project a `fileChange` item's `changes[]` into the shared permission body.
 *
 * This is the function that makes slice 4's correlator possible: the approval
 * request (`item/fileChange/requestApproval`) is extremely thin — threadId /
 * turnId / itemId / startedAtMs / reason / grantRoot and nothing else [实测] —
 * while the DIFF arrives one millisecond EARLIER on the `item/started` frame
 * that shares the same itemId (11235ms vs 11236ms [实测],
 * `codex-filechange-approval-turn.jsonl` lines 8 and 10). Without this
 * projection cached by itemId there is no patch to render on the card.
 *
 * Returns `null` when the item carries no usable change list — never a partial
 * object, so a caller cannot mistake "no diff yet" for "empty diff".
 */
export function toPermissionFileChanges(item: unknown): PermissionDetail | null {
  if (!isRecord(item)) return null;
  const changes = item.changes;
  if (!Array.isArray(changes) || changes.length === 0) return null;

  const kept: PermissionFileChange[] = [];
  for (const raw of changes.slice(0, PERMISSION_DIFF_MAX_FILES)) {
    if (!isRecord(raw)) continue;
    const path = str(raw.path);
    if (!path) continue;
    const entry: PermissionFileChange = { path, change: readChangeKind(raw.kind) };
    const diff = typeof raw.diff === 'string' ? raw.diff : null;
    if (diff !== null) {
      if (Buffer.byteLength(diff, 'utf8') > PERMISSION_DIFF_MAX_BYTES) {
        // Byte-clamped, not char-clamped: the cap exists to bound what crosses
        // IPC. `slice` on the byte length is safe for the UI because the diff is
        // already flagged truncated.
        entry.diff = Buffer.from(diff, 'utf8').subarray(0, PERMISSION_DIFF_MAX_BYTES).toString();
        entry.truncated = true;
      } else {
        entry.diff = diff;
      }
    }
    kept.push(entry);
  }
  if (kept.length === 0) return null;

  const omitted = changes.length - kept.length;
  const detail: PermissionDetail = { kind: 'file_change', changes: kept };
  // Only when files were dropped: a `0` would read as a deliberate statement
  // that something was omitted.
  if (omitted > 0) detail.omittedFileCount = omitted;
  return detail;
}

/**
 * Tool row name.
 *
 * MCP and dynamic tool calls are the only two variants whose useful name lives
 * in the payload, and neither has a recorded frame — hence the candidate list
 * plus an unconditional fallback to our own label. Worst case the row is titled
 * `mcp_tool` instead of `github.create_issue`; nothing breaks.
 */
function readToolName(itemType: string, item: Record<string, unknown>): string {
  const label = CODEX_TOOL_LABEL[itemType] ?? itemType;
  if (itemType !== 'mcpToolCall' && itemType !== 'dynamicToolCall') return label;
  // [推测] field spellings — safe by construction, see the doc comment.
  const tool = str(item.tool) ?? str(item.name) ?? str(item.toolName);
  if (!tool) return label;
  const server = str(item.server) ?? str(item.serverName);
  return server ? `${server}.${tool}` : tool;
}

/** Keys that are envelope, not input: they are already carried on the block. */
const TOOL_INPUT_OMIT = new Set(['type', 'id', 'status']);

/**
 * Tool row input.
 *
 * Verbatim projection minus the envelope keys, rather than a per-variant
 * whitelist: four of the five tool variants have no recorded frame, so a
 * whitelist would be a list of guesses that silently drops the real fields.
 * `fileChange` is the one exception — its `changes[]` goes through the clamped
 * permission projection instead, so an enormous diff cannot ride into message
 * state twice at full size.
 */
function projectToolInput(
  itemType: string,
  item: Record<string, unknown>
): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item)) {
    if (TOOL_INPUT_OMIT.has(key)) continue;
    if (itemType === 'fileChange' && key === 'changes') continue;
    input[key] = value;
  }
  if (itemType === 'fileChange') {
    const detail = toPermissionFileChanges(item);
    if (detail && detail.kind === 'file_change') {
      input.changes = detail.changes;
      if (detail.omittedFileCount !== undefined) input.omittedFileCount = detail.omittedFileCount;
    }
  }
  return input;
}

/**
 * Tool result body.
 *
 * `commandExecution.aggregatedOutput` is [实测]; the rest is a candidate list
 * with an empty-string fallback, for the same reason `readToolName` has one.
 * `fileChange` deliberately produces a one-line summary instead of re-emitting
 * the patch: the diff is already on the call block's input, and duplicating it
 * would double the memory a large patch occupies in the renderer.
 */
function readToolOutput(itemType: string, item: Record<string, unknown>): string {
  if (itemType === 'fileChange') {
    const changes = Array.isArray(item.changes) ? item.changes.length : 0;
    return changes > 0 ? `${changes} file(s) changed` : '';
  }
  const direct =
    typeof item.aggregatedOutput === 'string'
      ? item.aggregatedOutput
      : (str(item.output) ?? str(item.result) ?? str(item.text));
  return direct ?? '';
}

/** Human-readable failure line for a non-`completed` terminal status. */
function readToolError(itemType: string, item: Record<string, unknown>, status: string): string {
  const exitCode = item.exitCode;
  if (itemType === 'commandExecution' && typeof exitCode === 'number' && exitCode !== 0) {
    return `${status} (exit code ${exitCode})`;
  }
  return status;
}

function mapped(partial: Partial<CodexItemMapping> & { note: string }): CodexItemMapping {
  return {
    itemType: null,
    itemId: null,
    outcome: 'rendered',
    mode: null,
    role: null,
    blocks: [],
    skipReason: null,
    phase: null,
    ...partial,
  };
}

/**
 * Project ONE `ThreadItem` into blocks.
 *
 * Never throws and never returns "nothing happened": an item outside the
 * contract comes back as `outcome:'unknown'` with its type verbatim, and a
 * frame that is not an item at all comes back as `'malformed'`. The caller
 * counts both — a silently dropped item is the failure this whole file exists
 * to make impossible.
 *
 * An item still in flight (`status:'inProgress'` [实测]) yields the call block
 * WITHOUT a result block, so the same function serves `item/started` (tool row
 * appears while it runs) and `item/completed` (row settles).
 */
export function mapCodexItem(item: unknown): CodexItemMapping {
  if (!isRecord(item)) {
    return mapped({ outcome: 'malformed', note: 'item frame was not an object' });
  }
  const itemType = str(item.type);
  const itemId = str(item.id);
  if (!itemType) {
    return mapped({ itemId, outcome: 'malformed', note: 'item carried no `type`' });
  }

  const rule = Object.hasOwn(CODEX_ITEM_RULES, itemType) ? CODEX_ITEM_RULES[itemType] : undefined;
  if (!rule) {
    return mapped({
      itemType,
      itemId,
      outcome: 'unknown',
      note: `item type outside the pinned contract: ${itemType}`,
    });
  }

  if (rule.mode === 'not_rendered') {
    return mapped({
      itemType,
      itemId,
      outcome: 'skipped',
      mode: rule.mode,
      skipReason: rule.skipReason ?? 'no_surface',
      note: rule.note,
    });
  }

  // Blocks are keyed off the item id so the live stream and a later replay of
  // the same turn produce identical ids. A missing id (never observed) degrades
  // to the type name rather than to `undefined`, which would collide across
  // items and make two blocks overwrite each other.
  const base = itemId ?? `codex-${itemType}`;

  switch (rule.mode) {
    case 'user_message': {
      const { text, truncated } = clampText(extractContentText(item.content));
      const block: CodexBlock = { type: 'text', id: `${base}:text`, text };
      if (truncated) block.truncated = true;
      return mapped({
        itemType,
        itemId,
        mode: rule.mode,
        role: 'user',
        blocks: [block],
        note: rule.note,
      });
    }
    case 'agent_message': {
      const { text, truncated } = clampText(typeof item.text === 'string' ? item.text : '');
      const phase =
        item.phase === undefined || item.phase === null
          ? null
          : typeof item.phase === 'string'
            ? item.phase
            : null;
      const block: CodexBlock = { type: 'text', id: `${base}:text`, text };
      if (truncated) block.truncated = true;
      return mapped({
        itemType,
        itemId,
        mode: rule.mode,
        role: 'assistant',
        blocks: [block],
        phase,
        note: rule.note,
      });
    }
    case 'reasoning': {
      const { text, truncated } = clampText(extractReasoningText(item));
      const block: CodexBlock = { type: 'thinking', id: `${base}:reasoning`, text };
      if (truncated) block.truncated = true;
      return mapped({
        itemType,
        itemId,
        mode: rule.mode,
        role: 'assistant',
        blocks: [block],
        note: rule.note,
      });
    }
    case 'tool': {
      const blocks: CodexBlock[] = [
        {
          type: 'tool_call',
          id: `${base}:call`,
          toolCallId: base,
          name: readToolName(itemType, item),
          input: projectToolInput(itemType, item),
        },
      ];
      const status = str(item.status);
      if (status !== null && !IN_FLIGHT_STATUS.has(status)) {
        const ok = status === OK_STATUS;
        const { text, truncated } = clampText(readToolOutput(itemType, item));
        const result: CodexBlock = {
          type: 'tool_result',
          id: `${base}:result`,
          toolCallId: base,
          ok,
          output: text,
        };
        if (!ok) result.error = readToolError(itemType, item, status);
        if (truncated) result.truncated = true;
        blocks.push(result);
      }
      return mapped({
        itemType,
        itemId,
        mode: rule.mode,
        role: 'assistant',
        blocks,
        note: rule.note,
      });
    }
  }
}
