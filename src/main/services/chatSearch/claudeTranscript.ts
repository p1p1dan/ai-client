/**
 * Chat search: the searchable messages of a Claude Agent SDK chat, read in
 * Main from the CLI's own transcript
 * (`<sdkConfigDir>/projects/<cwd dir>/<ccSessionId>.jsonl`).
 *
 * Main never runs the SDK (the host is not bundled into it), and an SDK chat's
 * history otherwise reaches the renderer only through a resume
 * (`ClaudeSdkSessionRuntime.history` → `readTranscript`,
 * `src/claude-sdk-host/sdkSessionRuntime.ts`). So this file re-reads the
 * transcript the way that path does, far enough to name each message as the
 * timeline will:
 *
 * 1. The active conversation chain, as the SDK's `getSessionMessages` builds
 *    it (0.3.300): the newest main-chain leaf, walked back by `parentUuid`,
 *    with a compaction's preserved messages relinked; a mid-turn message
 *    (`queued_command` attachment) read as the user message it was; meta,
 *    sidechain and team rows left out.
 * 2. `readTranscript`'s projection: a user row is `h:<uuid>`; the rows of one
 *    API message are one assistant message named after the first,
 *    `h:<uuid>`; tool results, the CLI's own marker rows, local command
 *    output, engine-started turn heads and compaction summaries carry no
 *    prose and are skipped.
 *
 * Simplified from the SDK on purpose, and so possibly off for rare shapes: no
 * delivery dedup of mid-turn messages, no queued messages trailing the leaf,
 * no tool-result relinking (which never carries prose). A key that misses
 * only means the renderer cannot scroll to that hit.
 */

import { clampBody, type IndexedMessage } from './extract';

/** `sdkSessionRuntime.ts` CLI_MARKER_TEXT: bookkeeping user rows (pinned by a test). */
export const CLI_MARKER_TEXT = /^(\[Request interrupted by user|<local-command-caveat>)/;
/** `sdkSessionRuntime.ts` COMPACT_SUMMARY_PREFIX (pinned by a test). */
export const COMPACT_SUMMARY_PREFIX =
  'This session is being continued from a previous conversation';
/** `slashCommands.ts` SDK_WINDOW_OWNED_COMMANDS: commands with a row of their own. */
const WINDOW_OWNED_COMMANDS: ReadonlySet<string> = new Set(['compact']);

const COMMAND_NAME = /<command-name>\s*([^<]*?)\s*<\/command-name>/;
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;
const LOCAL_OUTPUT = /^<local-command-(stdout|stderr)>([\s\S]*?)<\/local-command-\1>\s*$/;

/** `slashCommands.ts` commandRowLine, verbatim (pinned by a test). */
export function commandRowLine(text: string): { name: string; line: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('<command-name>') && !trimmed.startsWith('<command-message>')) {
    return null;
  }
  const named = COMMAND_NAME.exec(trimmed)?.[1]?.trim();
  if (!named) return null;
  const line = named.startsWith('/') ? named : `/${named}`;
  const args = COMMAND_ARGS.exec(trimmed)?.[1]?.trim() ?? '';
  return { name: line.slice(1), line: args ? `${line} ${args}` : line };
}

/** `slashCommands.ts` localCommandOutput, verbatim (pinned by a test). */
export function localCommandOutput(text: string): string | null {
  const match = LOCAL_OUTPUT.exec(text.trim());
  if (!match) return null;
  const body = (match[2] ?? '').trim();
  return body.length > 0 ? body : null;
}

type Obj = Record<string, unknown>;

export interface TranscriptRow {
  type: string;
  uuid: string;
  parentUuid?: string | null;
  isSidechain?: boolean;
  teamName?: unknown;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  timestamp?: string;
  message?: unknown;
  attachment?: unknown;
  subtype?: unknown;
  compactMetadata?: unknown;
  origin?: unknown;
  turnOrigin?: unknown;
}

function obj(value: unknown): Obj | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : null;
}

const KEPT_TYPES = new Set(['user', 'assistant', 'progress', 'system', 'attachment']);

/** The transcript's rows, in file order; torn and foreign lines dropped. */
export function parseTranscriptRows(raw: string): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const row = obj(parsed);
    if (!row || typeof row.uuid !== 'string' || typeof row.type !== 'string') continue;
    if (!KEPT_TYPES.has(row.type)) continue;
    rows.push(row as unknown as TranscriptRow);
  }
  return rows;
}

/** The SDK's `kA`: a meta row from one of these origins is still shown. */
function shownMetaOrigin(origin: unknown): boolean {
  const kind = obj(origin)?.kind;
  return (
    kind === 'channel' ||
    kind === 'observer' ||
    kind === 'observer-activity' ||
    kind === 'slack-ping' ||
    kind === 'peer'
  );
}

function apiIdOf(row: TranscriptRow): string | undefined {
  if (row.type !== 'assistant') return undefined;
  const id = obj(row.message)?.id;
  return typeof id === 'string' ? id : undefined;
}

function isToolResultRow(row: TranscriptRow): boolean {
  if (row.type !== 'user' || !row.parentUuid) return false;
  const content = obj(row.message)?.content;
  return Array.isArray(content) && content.some((block) => obj(block)?.type === 'tool_result');
}

/** A compaction's preserved messages, relinked under their anchor as the SDK does. */
function relinkPreserved(byUuid: Map<string, TranscriptRow>): void {
  for (const row of [...byUuid.values()]) {
    if (row.type !== 'system' || row.subtype !== 'compact_boundary') continue;
    const meta = obj(row.compactMetadata);
    const preserved = obj(meta?.preservedMessages);
    const segment = obj(meta?.preservedSegment);
    if (preserved) {
      const uuids = Array.isArray(preserved.uuids)
        ? preserved.uuids.filter((u): u is string => typeof u === 'string')
        : [];
      if (uuids.length === 0 || uuids.some((u) => !byUuid.has(u))) continue;
      const anchor = typeof preserved.anchorUuid === 'string' ? preserved.anchorUuid : null;
      let parent = anchor;
      for (const uuid of uuids) {
        byUuid.set(uuid, { ...(byUuid.get(uuid) as TranscriptRow), parentUuid: parent });
        parent = uuid;
      }
      const first = uuids[0];
      const last = uuids[uuids.length - 1];
      for (const [uuid, entry] of byUuid) {
        if (entry.parentUuid === anchor && uuid !== first) {
          byUuid.set(uuid, { ...entry, parentUuid: last });
        }
      }
    } else if (segment) {
      const head = typeof segment.headUuid === 'string' ? segment.headUuid : undefined;
      const anchor = typeof segment.anchorUuid === 'string' ? segment.anchorUuid : null;
      const tail = typeof segment.tailUuid === 'string' ? segment.tailUuid : null;
      const headRow = head ? byUuid.get(head) : undefined;
      if (head && headRow) byUuid.set(head, { ...headRow, parentUuid: anchor });
      for (const [uuid, entry] of byUuid) {
        if (entry.parentUuid === anchor && uuid !== head) {
          byUuid.set(uuid, { ...entry, parentUuid: tail });
        }
      }
    }
  }
}

/** The active conversation chain, root first (the SDK's `Bu` plus its sibling pass). */
export function activeChain(rows: readonly TranscriptRow[]): TranscriptRow[] {
  const byUuid = new Map<string, TranscriptRow>();
  for (const row of rows) byUuid.set(row.uuid, row);
  relinkPreserved(byUuid);
  const fileIndex = new Map<string, number>();
  for (const [index, row] of rows.entries()) fileIndex.set(row.uuid, index);
  const position = (row: TranscriptRow) => fileIndex.get(row.uuid) ?? -1;

  const mainChain = (row: TranscriptRow) =>
    !row.isSidechain &&
    !row.teamName &&
    row.type !== 'progress' &&
    !(row.type === 'attachment' && obj(row.attachment)?.type === 'fork_briefing');
  const mainParents = new Set<string>();
  for (const row of byUuid.values()) {
    if (row.parentUuid && mainChain(row)) mainParents.add(row.parentUuid);
  }
  const leaves = [...byUuid.values()]
    .filter((row) => mainChain(row) && !mainParents.has(row.uuid))
    .sort((a, b) => position(b) - position(a));

  let leaf: TranscriptRow | undefined;
  const seen = new Set<string>();
  for (const candidate of leaves) {
    const walked: string[] = [];
    const here = new Set<string>();
    let cursor: TranscriptRow | undefined = candidate;
    while (cursor && !seen.has(cursor.uuid) && !here.has(cursor.uuid)) {
      if (cursor.type === 'user' || cursor.type === 'assistant') {
        leaf = cursor;
        break;
      }
      here.add(cursor.uuid);
      walked.push(cursor.uuid);
      cursor = cursor.parentUuid ? byUuid.get(cursor.parentUuid) : undefined;
    }
    if (leaf) break;
    for (const uuid of walked) seen.add(uuid);
  }
  if (!leaf) {
    // No main-chain leaf: the newest user/assistant row any terminal reaches.
    const parents = new Set<string>();
    for (const row of byUuid.values()) if (row.parentUuid) parents.add(row.parentUuid);
    const reached: TranscriptRow[] = [];
    for (const terminal of byUuid.values()) {
      if (parents.has(terminal.uuid)) continue;
      const visited = new Set<string>();
      let cursor: TranscriptRow | undefined = terminal;
      while (cursor && !visited.has(cursor.uuid)) {
        visited.add(cursor.uuid);
        if (cursor.type === 'user' || cursor.type === 'assistant') {
          reached.push(cursor);
          break;
        }
        cursor = cursor.parentUuid ? byUuid.get(cursor.parentUuid) : undefined;
      }
    }
    if (reached.length === 0) return [];
    const plain = reached.filter((row) => !row.isSidechain && !row.teamName && !row.isMeta);
    const pool = plain.length > 0 ? plain : reached;
    leaf = pool.reduce((best, row) => (position(row) > position(best) ? row : best));
  }

  const chain: TranscriptRow[] = [];
  const inChain = new Set<string>();
  let cursor: TranscriptRow | undefined = byUuid.get(leaf.uuid);
  while (cursor && !inChain.has(cursor.uuid)) {
    inChain.add(cursor.uuid);
    chain.push(cursor);
    cursor = cursor.parentUuid ? byUuid.get(cursor.parentUuid) : undefined;
  }
  chain.reverse();

  // Parallel tool calls split one API message over sibling rows the walk does
  // not pass: put them back after the last chain row of their API message.
  const lastOfApi = new Map<string, string>();
  for (const row of chain) {
    const apiId = apiIdOf(row);
    if (apiId) lastOfApi.set(apiId, row.uuid);
  }
  if (lastOfApi.size === 0) return chain;
  const siblings = new Map<string, TranscriptRow[]>();
  for (const row of byUuid.values()) {
    const apiId = apiIdOf(row);
    if (!apiId || inChain.has(row.uuid)) continue;
    const anchor = lastOfApi.get(apiId);
    if (!anchor) continue;
    const list = siblings.get(anchor) ?? [];
    list.push(row);
    siblings.set(anchor, list);
  }
  if (siblings.size === 0) return chain;
  const out: TranscriptRow[] = [];
  for (const row of chain) {
    out.push(row);
    const extra = siblings.get(row.uuid);
    if (extra) {
      extra.sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''));
      out.push(...extra);
    }
  }
  return out;
}

/** Mid-turn messages (`queued_command` attachments) that were answered, as the user rows they were. */
function withQueuedCommands(chain: readonly TranscriptRow[]): TranscriptRow[] {
  const answered: boolean[] = [];
  let next: 'reply' | 'prompt' | undefined;
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const row = chain[i] as TranscriptRow;
    answered[i] = next === 'reply';
    if (row.type === 'assistant' || isToolResultRow(row)) next = 'reply';
    else if (row.type === 'user' && !row.isMeta && !row.isCompactSummary) next = 'prompt';
  }
  const taken = new Set(chain.map((row) => row.uuid));
  return chain.map((row, i) => {
    if (!answered[i] || row.type !== 'attachment') return row;
    const attachment = obj(row.attachment);
    if (!attachment || attachment.type !== 'queued_command') return row;
    const prompt = attachment.prompt;
    if (typeof prompt !== 'string' && !Array.isArray(prompt)) return row;
    if (attachment.isMeta && !shownMetaOrigin(attachment.origin)) return row;
    const source =
      typeof attachment.source_uuid === 'string' && attachment.source_uuid
        ? attachment.source_uuid
        : row.uuid;
    if (source !== row.uuid && taken.has(source)) return row;
    taken.add(source);
    return {
      type: 'user',
      uuid: source,
      parentUuid: row.parentUuid ?? null,
      ...(row.timestamp ? { timestamp: row.timestamp } : {}),
      message: { role: 'user', content: prompt },
      isMeta: Boolean(attachment.isMeta),
      ...(attachment.origin !== undefined ? { origin: attachment.origin } : {}),
    };
  });
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      const text = obj(block)?.text;
      return typeof text === 'string' ? text : '';
    })
    .filter(Boolean)
    .join('\n');
}

function timestampOf(row: TranscriptRow): number | undefined {
  if (typeof row.timestamp !== 'string') return undefined;
  const ms = Date.parse(row.timestamp);
  return Number.isFinite(ms) ? ms : undefined;
}

/** The rows `getSessionMessages` answers for this transcript, in order. */
export function conversationRows(rows: readonly TranscriptRow[]): TranscriptRow[] {
  return withQueuedCommands(activeChain(rows)).filter(
    (row) =>
      (row.type === 'user' || row.type === 'assistant') &&
      !(row.isMeta && !shownMetaOrigin(row.origin)) &&
      !row.isSidechain &&
      !row.teamName
  );
}

/** The searchable messages of one transcript, keyed as `readTranscript` names them. */
export function claudeTranscriptMessages(raw: string): IndexedMessage[] {
  const rows = parseTranscriptRows(raw);
  // S-6: rows the CLI wrote for a schedule that came due are turn heads, not prose.
  const scheduled = new Set(rows.filter((r) => r.turnOrigin === 'scheduled').map((r) => r.uuid));
  const shown = conversationRows(rows);

  const out: IndexedMessage[] = [];
  const assistantByApiId = new Map<string, { message: IndexedMessage; parts: string[] }>();
  for (const row of shown) {
    const content = obj(row.message)?.content;
    if (row.type === 'user') {
      if (Array.isArray(content) && content.some((b) => obj(b)?.type === 'tool_result')) continue;
      const trimmed = textOf(content).trim();
      const command = commandRowLine(trimmed);
      if (command) {
        if (WINDOW_OWNED_COMMANDS.has(command.name)) continue;
        out.push({ key: `h:${row.uuid}`, role: 'user', text: clampBody(command.line) });
        continue;
      }
      if (localCommandOutput(trimmed)) continue;
      if (!trimmed || CLI_MARKER_TEXT.test(trimmed)) continue;
      if (scheduled.has(row.uuid) || trimmed.startsWith('<task-notification>')) continue;
      if (row.isCompactSummary || trimmed.startsWith(COMPACT_SUMMARY_PREFIX)) continue;
      const timestamp = timestampOf(row);
      out.push({
        key: `h:${row.uuid}`,
        role: 'user',
        text: clampBody(trimmed),
        ...(timestamp !== undefined ? { timestamp } : {}),
      });
      continue;
    }
    const apiId = apiIdOf(row) ?? row.uuid;
    let target = assistantByApiId.get(apiId);
    if (!target) {
      const timestamp = timestampOf(row);
      target = {
        message: {
          key: `h:${row.uuid}`,
          role: 'assistant',
          text: '',
          ...(timestamp !== undefined ? { timestamp } : {}),
        },
        parts: [],
      };
      assistantByApiId.set(apiId, target);
      out.push(target.message);
    }
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const b = obj(block);
      if (b?.type === 'text' && typeof b.text === 'string') target.parts.push(b.text);
    }
  }
  for (const { message, parts } of assistantByApiId.values()) {
    message.text = clampBody(parts.join('\n').trim());
  }
  return out.filter((message) => message.text.length > 0);
}
