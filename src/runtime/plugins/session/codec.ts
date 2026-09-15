import {
  type AgentMessage,
  buildSessionContext,
  type Entry,
  type JsonlV4Header,
} from '@earendil-works/pi-agent-core';
import { RuntimeHostError } from '../../host/errors.ts';

/**
 * session-12 — the one byte budget every session path reads and writes under.
 *
 * It bounds four different decisions (how much of a file we open, how large a
 * converted copy may be, how much of an existing native copy we re-read, and
 * the store's own running total), and they only stay consistent while they name
 * the same number: a file that opens but cannot be converted, or converts but
 * cannot be reopened, is the shape the divergence takes. It lives here because
 * both `store.ts` and `legacy.ts` already depend on this module, and neither
 * may depend on the other.
 */
export const SESSION_MAX_BYTES = 32 * 1024 * 1024;

/**
 * session-02 — one row of the file that no reader could parse.
 *
 * A diagnostic, not the data: the row is gone from the rewritten file, and the
 * preview is a clamped head of it so "what did this session lose?" has an
 * answer without the dropped bytes being carried around in full.
 */
export interface SessionSkippedRow {
  /** 1-based line number, counted in the file as it was read. */
  line: number;
  /** Clamped head of the dropped row. */
  preview: string;
}

/** How much of a dropped row is worth keeping to identify it later. */
const SKIPPED_PREVIEW_CHARS = 120;

/**
 * How many unparseable rows still read as damage rather than as another file.
 *
 * A bound, not a policy: decision 006 is about the row a crash left behind, and
 * a handful of those is the whole realistic range. Without a ceiling, a file
 * whose header happens to parse and whose body is not JSONL at all would be
 * "repaired" one line at a time — millions of previews held in memory on a
 * machine with 3 GB of it, and a `seq` allowance grown so wide the sequence
 * check stops meaning anything. Past this many, the file is refused and left
 * untouched, which is the answer a human needs to see.
 */
const MAX_SKIPPED_ROWS = 64;

export interface SessionDocument {
  header: JsonlV4Header;
  entries: Entry[];
  leafId: string | null;
  seq: number;
  name?: string;
  labels?: Record<string, string>;
  /** Valid prefix, only used while holding the writer lock to repair a torn tail. */
  repair?: string;
  /**
   * session-02 — rows dropped to make this file readable, in file order.
   *
   * Set only when `repair` also drops them, so a caller that rewrites the file
   * and one that does not never disagree about what the file contains. Survives
   * the rewrite (unlike `repair`, which is consumed) because it is the only
   * evidence anywhere that the session was healed.
   */
  skipped?: SessionSkippedRow[];
}

/**
 * H/20 — one file, two formats.
 *
 * `pi --session <file>` parses with pi-coding-agent's SessionManager, whose
 * format (v3) is a different package's format, not an older version of ours:
 * it requires the first row to be `{"type":"session",...}` and reports
 * `Session file is not a valid pi session` for anything else. Our header keeps
 * every v4 field and adds the two v3 ones, so ONE file satisfies both readers.
 * Two files was the alternative and it is strictly worse: two writers, two
 * divergent transcripts, and whichever one the user sees depends on the door
 * they came in through.
 *
 * `version: 4` is deliberately left as is. The CLI only migrates (and rewrites)
 * a file whose header version is BELOW its own 3, so declaring 4 is what keeps
 * it from reformatting our rows out of existence.
 */
export interface SessionFileHeader extends JsonlV4Header {
  /** v3 discriminator. Without it the CLI refuses the file outright. */
  type: 'session';
  /** v3 header time (ISO). The session list reads this one, not `createdAt`. */
  timestamp: string;
}

export function interopHeader(header: JsonlV4Header): SessionFileHeader {
  return {
    ...header,
    type: 'session',
    timestamp: new Date(header.createdAt).toISOString(),
  };
}

export function isInteropHeader(header: JsonlV4Header): header is SessionFileHeader {
  const row = header as unknown as Record<string, unknown>;
  return row.type === 'session' && typeof row.timestamp === 'string';
}

/**
 * v3 fields on the rows that are NOT entries (`lane` / `fact`).
 *
 * The CLI keeps every JSON row it can parse and walks `parentId` from the last
 * one, so a bookkeeping row at the tail with no chain would make it fall back
 * to that row alone — an empty conversation where a full one exists. Giving the
 * row an id, a parent and an inert `custom` type puts it IN the chain instead:
 * the CLI renders nothing for it (custom entries carry no context) and any
 * later CLI entry hangs off it, which `chainTarget` maps back to the real entry
 * when we read the file again.
 */
export const CLI_BOOKKEEPING_TYPE = 'aiclient.v4';

export function cliBookkeeping(id: string, parentId: string | null, timestamp: number) {
  return { type: 'custom', customType: CLI_BOOKKEEPING_TYPE, id, parentId, timestamp } as const;
}

function invalid(message: string): never {
  throw new RuntimeHostError('session_invalid', message);
}

/**
 * session-02 — a write cut short, as opposed to a complete row that is invalid.
 *
 * The tail repair used to key off "the file does not end in a newline", which
 * stopped being a reliable signal once `pi --session` shares the file: the CLI
 * appends the missing newline itself the first time it opens a torn file
 * (`session-manager.js` `loadEntriesFromFile`), turning a fragment we could
 * still truncate into a "complete" line we refused forever. Shape answers the
 * same question without depending on the byte after it: every row either side
 * writes ends in `}`, so a line that does not is an interrupted append.
 *
 * Deliberately one-directional. A fragment that happens to break after a nested
 * `}` reads as complete and is still refused — a loud failure on a file we might
 * have salvaged, which is the safe way round for a check that deletes a line.
 */
function tornRow(line: string): boolean {
  return !line.trimEnd().endsWith('}');
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('expected JSON object');
  return value as Record<string, unknown>;
}

function message(value: unknown): void {
  const m = object(value);
  if (typeof m.timestamp !== 'number') invalid('invalid message timestamp');
  switch (m.role) {
    case 'user':
    case 'assistant':
    case 'toolResult':
    case 'custom':
      if (typeof m.content !== 'string' && !Array.isArray(m.content))
        invalid('invalid message content');
      if (m.role === 'assistant' && (!Array.isArray(m.content) || typeof m.stopReason !== 'string'))
        invalid('invalid assistant message');
      if (
        m.role === 'toolResult' &&
        (typeof m.toolCallId !== 'string' || typeof m.toolName !== 'string')
      )
        invalid('invalid tool result');
      if (m.role === 'custom' && typeof m.customType !== 'string')
        invalid('invalid custom message');
      break;
    case 'compactionSummary':
    case 'branchSummary':
      if (typeof m.summary !== 'string') invalid('invalid summary message');
      break;
    case 'bashExecution':
      if (typeof m.command !== 'string' || typeof m.output !== 'string')
        invalid('invalid bash message');
      break;
    default:
      invalid(`unsupported message role: ${String(m.role)}`);
  }
}

function entry(value: Record<string, unknown>): Entry {
  if (
    typeof value.id !== 'string' ||
    !value.id ||
    (value.parentId !== null && typeof value.parentId !== 'string') ||
    !Number.isSafeInteger(value.timestamp)
  )
    invalid('invalid entry identity');
  switch (value.type) {
    case 'message':
      message(value.message);
      break;
    case 'compaction':
      if (
        typeof value.summary !== 'string' ||
        typeof value.tokensBefore !== 'number' ||
        !Array.isArray(value.retainedTail)
      )
        invalid('invalid compaction');
      value.retainedTail.forEach(message);
      break;
    case 'branch_summary':
      if (typeof value.summary !== 'string' || typeof value.fromId !== 'string')
        invalid('invalid branch summary');
      break;
    case 'model_change':
      if (typeof value.provider !== 'string' || typeof value.modelId !== 'string')
        invalid('invalid model change');
      break;
    case 'thinking_level_change':
      if (typeof value.thinkingLevel !== 'string') invalid('invalid thinking level');
      break;
    case 'active_tools_change':
      if (
        !Array.isArray(value.activeToolNames) ||
        !value.activeToolNames.every((name) => typeof name === 'string')
      )
        invalid('invalid tools');
      break;
    case 'custom':
      if (typeof value.customType !== 'string') invalid('invalid custom entry');
      break;
    default:
      invalid(`unsupported entry type: ${String(value.type)}`);
  }
  const { kind: _kind, lane: _lane, ...fields } = value;
  return fields as unknown as Entry;
}

/** Milliseconds from either spelling: v4 writes an integer, the CLI an ISO string. */
function millis(value: unknown): number {
  const time =
    typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(time)) invalid('invalid entry identity');
  return Math.trunc(time);
}

interface CliContext {
  document: SessionDocument;
  ids: Set<string>;
  /** Bookkeeping row id -> the real entry it stands for, so CLI parents resolve. */
  alias: Map<string, string | null>;
}

/** Follow bookkeeping rows back to the entry a v3 parent pointer really means. */
function chainTarget(alias: Map<string, string | null>, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !value) invalid('invalid entry identity');
  let id: string | null = value;
  const seen = new Set<string>();
  while (id !== null && alias.has(id)) {
    if (seen.has(id)) invalid('cyclic session bookkeeping reference');
    seen.add(id);
    id = alias.get(id) ?? null;
  }
  return id;
}

/**
 * v3 states a compaction by anchor id; v4 stores the kept messages themselves.
 *
 * Rebuilt from the branch the CLI compacted, and deliberately degraded to an
 * empty tail when that cannot be done: a summary with no retained tail still
 * opens and still reads correctly, whereas refusing the file would cost the
 * user the whole conversation over a detail the CLI itself treats as optional.
 */
function cliRetainedTail(
  row: Record<string, unknown>,
  context: CliContext,
  parentId: string | null
): AgentMessage[] {
  const anchor = row.firstKeptEntryId ?? row.firstKeptMessageId;
  if (typeof anchor !== 'string') return [];
  try {
    const path = branchEntries(context.document, parentId);
    const index = path.findIndex((item) => item.id === anchor);
    if (index < 0) return [];
    const messages = buildSessionContext(path.slice(index)).messages;
    messages.forEach(message);
    return messages;
  } catch {
    return [];
  }
}

/**
 * One row the CLI appended, expressed in v4 — in memory only.
 *
 * What the two formats share passes through untouched. The v3-only shapes are
 * translated (`custom_message` is v4's custom-role message; `session_info` and
 * `label` are v4 facts, which are not entries — so the row also stays in the
 * chain as an inert entry, because the CLI's next row hangs off its id).
 * Anything unrecognized is kept as an inert entry for the same reason: dropping
 * it would break every row after it.
 */
function cliEntry(row: Record<string, unknown>, context: CliContext): Record<string, unknown> {
  const timestamp = millis(row.timestamp);
  const base = { id: row.id, parentId: chainTarget(context.alias, row.parentId), timestamp };
  const inert = (type: string) => ({
    ...base,
    type: 'custom',
    customType: `pi-cli:${type}`,
    data: row,
  });
  switch (row.type) {
    case 'message': {
      const carried = object(row.message);
      return {
        ...base,
        type: 'message',
        message: { ...carried, timestamp: millis(carried.timestamp ?? timestamp) },
      };
    }
    case 'custom_message':
      return {
        ...base,
        type: 'message',
        message: {
          role: 'custom',
          customType: String(row.customType ?? 'custom'),
          content: row.content ?? [],
          display: row.display !== false,
          ...(row.details === undefined ? {} : { details: row.details }),
          timestamp,
        },
      };
    case 'compaction':
      return {
        ...row,
        ...base,
        type: 'compaction',
        summary: String(row.summary ?? ''),
        tokensBefore: typeof row.tokensBefore === 'number' ? row.tokensBefore : 0,
        retainedTail: cliRetainedTail(row, context, base.parentId),
      };
    case 'session_info': {
      if (row.name !== undefined && typeof row.name !== 'string') invalid('invalid session name');
      context.document.name = row.name as string | undefined;
      return inert('session_info');
    }
    case 'label': {
      if (typeof row.targetId === 'string' && context.ids.has(row.targetId)) {
        context.document.labels ??= {};
        if (row.label === undefined) delete context.document.labels[row.targetId];
        else if (typeof row.label === 'string') context.document.labels[row.targetId] = row.label;
      }
      return inert('label');
    }
    case 'branch_summary':
    case 'model_change':
    case 'thinking_level_change':
    case 'custom':
      return { ...row, ...base };
    default:
      return inert(String(row.type));
  }
}

// Adapt pi 0.84.4's v4 codec and state invariants; IO remains entirely ours.
export function decodeSession(content: string): SessionDocument {
  const lines = content.split('\n');
  if (lines.at(-1) === '') lines.pop();
  let headerValue: Record<string, unknown>;
  try {
    headerValue = object(JSON.parse(lines[0] ?? ''));
  } catch {
    invalid('missing or invalid session header');
  }
  if (headerValue.kind !== 'header' || headerValue.version !== 4) {
    throw new RuntimeHostError(
      'session_format_unsupported',
      'expected Pi JSONL v4; convert legacy sessions before opening'
    );
  }
  if (
    typeof headerValue.id !== 'string' ||
    typeof headerValue.cwd !== 'string' ||
    !Number.isSafeInteger(headerValue.createdAt)
  )
    invalid('invalid session header');
  const result: SessionDocument = {
    header: headerValue as unknown as JsonlV4Header,
    entries: [],
    leafId: null,
    seq: 0,
  };
  const ids = new Set<string>();
  const recordIds = new Set<string>();
  const openOperations = new Set<string>();
  const lanes = new Map<string, string | null>([['main', null]]);
  const alias = new Map<string, string | null>();
  const context: CliContext = { document: result, ids, alias };
  // Last line carrying data: trailing blank lines are separators, not rows.
  let lastRow = lines.length - 1;
  while (lastRow > 0 && lines[lastRow].trim() === '') lastRow--;
  // session-01 — CLI rows a WRITER BEFORE US may have counted into `seq`.
  // See the seq check below for why the allowance exists and why it shrinks.
  let cliRows = 0;
  /** Whether the CLI, not us, put the current row at the tip of the main lane. */
  let cliTip = false;
  /** Line indexes the rewrite must leave out, and what to say about them. */
  const dropped = new Set<number>();
  const skipped: SessionSkippedRow[] = [];
  /** Where the torn tail begins, if there is one; everything from here is cut. */
  let truncateAt: number | undefined;
  /**
   * session-02 — name the dropped lines on any failure a drop could have caused.
   *
   * A row that points at a parent we no longer have is not itself corrupt, so a
   * bare `missing parent` sends the reader looking at the wrong line.
   */
  const afterSkip = (message: string) =>
    skipped.length
      ? `${message}; line ${skipped.map((row) => row.line).join(', ')} was skipped as unparseable`
      : message;
  for (let index = 1; index < lines.length; index++) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[index]);
    } catch {
      // The LAST data row keeps the rule it has had since T003: an interrupted
      // append is truncated, a complete row that is merely invalid is refused,
      // because at the tail we are the only writer who can still be mid-write.
      if (index >= lastRow) {
        if (!content.endsWith('\n') || tornRow(lines[index])) {
          truncateAt = index;
          break;
        }
        invalid(`invalid JSON at line ${index + 1}`);
      }
      // session-02 — a row in the MIDDLE is past saving and refusing it costs
      // the whole conversation, so it is dropped and the file rewritten without
      // it (decision 006). This is also the only way the two readers can agree:
      // `pi --session` already skips exactly these rows (`parseSessionEntryLine`
      // returns null on a JSON error), so refusing them meant the CLI could open
      // a file the GUI called invalid forever.
      //
      // Scope is deliberately JSON.parse failures only. A row that parses but
      // fails the structure checks below is still refused: the CLI KEEPS such a
      // row, so dropping it would make the two readers disagree about a line
      // that is completely present on disk — the opposite of what this is for.
      //
      // Blank lines carry nothing and both readers ignore them, so they are
      // passed over without being reported or rewritten away.
      if (lines[index].trim()) {
        if (skipped.length >= MAX_SKIPPED_ROWS)
          invalid(
            `more than ${MAX_SKIPPED_ROWS} unparseable rows, first at line ${skipped[0].line}`
          );
        dropped.add(index);
        skipped.push({ line: index + 1, preview: lines[index].slice(0, SKIPPED_PREVIEW_CHARS) });
        // A dropped row of ours may have spent a `seq` number. The allowance the
        // check below already keeps for rows we cannot account for is exactly
        // the right budget, so the gap it leaves is forgiven once, not forever.
        cliRows++;
      }
      continue;
    }
    const row = object(parsed);
    if (row.kind === undefined && row.seq === undefined) {
      // H/20 — a row the CLI appended. It carries neither `kind` nor `seq`
      // (both are v4's), so the position in the file IS the sequence. Tolerated
      // in memory: the file keeps the rows exactly as the CLI wrote them.
      cliRows++;
      const item = entry(cliEntry(row, context));
      if (
        ids.has(item.id) ||
        recordIds.has(item.id) ||
        (item.parentId !== null && !ids.has(item.parentId))
      )
        invalid(afterSkip('duplicate id or missing parent'));
      ids.add(item.id);
      result.entries.push(item);
      // The CLI has no lanes; it always appends to the conversation's tip.
      lanes.set('main', item.id);
      cliTip = true;
      continue;
    }
    // session-01 — `seq` numbers OUR rows, not positions in the file.
    //
    // It used to count every line, CLI rows included, so a worker that had the
    // session open while a terminal appended to it wrote its next row with a
    // number the file could no longer justify — and from then on the file threw
    // `session_invalid` on every open, for good. Counting only our own rows is
    // what makes the two writers independent.
    //
    // The allowance covers files already written under the old rule: those rows
    // are ahead by exactly the CLI rows before them, so a jump is accepted up to
    // that many and the allowance is spent as it is used. A larger jump is still
    // a row that went missing, and still refused.
    const skew = Number.isSafeInteger(row.seq) ? (row.seq as number) - (result.seq + 1) : -1;
    if (skew < 0 || skew > cliRows) invalid(afterSkip(`non-consecutive seq at line ${index + 1}`));
    cliRows -= skew;
    result.seq = row.seq as number;
    switch (row.kind) {
      case 'entry': {
        const item = entry(row);
        if (
          ids.has(item.id) ||
          recordIds.has(item.id) ||
          (item.parentId !== null && !ids.has(item.parentId))
        )
          invalid(afterSkip('duplicate id or missing parent'));
        if (row.lane !== undefined) {
          if (typeof row.lane !== 'string' || !lanes.has(row.lane))
            invalid(afterSkip('entry does not chain to lane'));
          // session-01 — the same interleaving the seq check allows for, seen
          // from the branch side. The CLI knows nothing about lanes and always
          // appends to the tip, so a row our writer produced while holding the
          // pre-CLI leaf hangs off that leaf instead of the CLI's last row. It
          // is a branch, not corruption: every id involved is in the file, and
          // the CLI reads the file the same way (it walks back from the last
          // row). Only the one row that follows the CLI's is forgiven; from
          // there on the lane is ours again and the check is strict.
          if (lanes.get(row.lane) !== item.parentId && !(row.lane === 'main' && cliTip))
            invalid(afterSkip('entry does not chain to lane'));
          cliTip = false;
          lanes.set(row.lane, item.id);
        }
        ids.add(item.id);
        result.entries.push(item);
        break;
      }
      case 'lane':
        if (
          typeof row.lane !== 'string' ||
          (row.leafId !== null && (typeof row.leafId !== 'string' || !ids.has(row.leafId)))
        )
          invalid(afterSkip('invalid lane pointer'));
        lanes.set(row.lane, row.leafId as string | null);
        // An explicit tip; whatever the CLI left is no longer what "main" means.
        if (row.lane === 'main') cliTip = false;
        if (typeof row.id === 'string' && row.id) alias.set(row.id, row.leafId as string | null);
        break;
      case 'record':
        if (
          typeof row.id !== 'string' ||
          ids.has(row.id) ||
          recordIds.has(row.id) ||
          typeof row.lane !== 'string' ||
          !lanes.has(row.lane) ||
          !Number.isSafeInteger(row.timestamp)
        )
          invalid('invalid record identity or lane');
        if (
          ![
            'operation_started',
            'abort_requested',
            'operation_finished',
            'step_attempt',
            'tool_started',
            'queue_enqueued',
            'queue_cancelled',
            'write_deferred',
            'usage',
          ].includes(String(row.type))
        )
          invalid('unsupported record type');
        recordIds.add(row.id);
        alias.set(row.id, lanes.get(String(row.lane)) ?? null);
        if (row.type === 'operation_started') openOperations.add(row.id);
        if (row.type === 'operation_finished') {
          if (typeof row.runId !== 'string') invalid('missing finished operation id');
          openOperations.delete(row.runId);
        }
        break;
      case 'fact':
        if (row.fact === 'name') {
          if (row.name !== undefined && typeof row.name !== 'string')
            invalid('invalid session name');
          result.name = row.name as string | undefined;
        } else if (row.fact === 'label') {
          if (
            typeof row.targetId !== 'string' ||
            !ids.has(row.targetId) ||
            (row.label !== undefined && typeof row.label !== 'string')
          )
            invalid('invalid session label');
          result.labels ??= {};
          if (row.label === undefined) delete result.labels[row.targetId as string];
          else result.labels[row.targetId as string] = row.label as string;
        } else invalid('unsupported fact');
        if (typeof row.id === 'string' && row.id) alias.set(row.id, lanes.get('main') ?? null);
        break;
      default:
        invalid(`unsupported JSONL kind: ${String(row.kind)}`);
    }
  }
  result.leafId = lanes.get('main') ?? null;
  if (openOperations.size)
    throw new RuntimeHostError(
      'session_operation_unfinished',
      'unfinished SDK operations require explicit recovery before native resume'
    );
  // One rewrite covers both cuts: the torn tail and every dropped middle row.
  // Built from the surviving lines rather than by splicing the original text so
  // the file on disk is exactly what this decode just read back.
  if (truncateAt !== undefined || dropped.size) {
    const kept = (truncateAt === undefined ? lines : lines.slice(0, truncateAt)).filter(
      (_, index) => !dropped.has(index)
    );
    result.repair = `${kept.join('\n')}\n`;
  }
  if (skipped.length) result.skipped = skipped;
  if (!result.repair && !content.endsWith('\n')) result.repair = `${content}\n`;
  return result;
}

export function branchEntries(document: SessionDocument, leafId = document.leafId): Entry[] {
  const byId = new Map(document.entries.map((item) => [item.id, item]));
  const path: Entry[] = [];
  for (let id = leafId; id !== null; ) {
    const item = byId.get(id);
    if (!item) invalid('missing branch entry');
    path.push(item);
    id = item.parentId;
  }
  return path.reverse();
}

export function isSuccessfulMessage(m: AgentMessage): boolean {
  return m.role !== 'assistant' || !['error', 'aborted', 'deferred'].includes(m.stopReason);
}
