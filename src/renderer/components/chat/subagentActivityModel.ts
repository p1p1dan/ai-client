import { englishTranslate, type Translate } from '@shared/i18n';
import type { SubagentReport, SubagentRunStatus, SubagentUsage } from '@shared/types/runtimeEvents';
import { toolDisplayName } from './piToolNames';
import { deriveToolRowView, type ToolRowView } from './toolCard';
import { THOUGHT_VERB } from './turnTiming';

/**
 * T-34: pure model for the live subagent panel under a delegation
 * (`Agent`/`Task`) tool row. Three parts, all React/store-free so the whole
 * surface is assertable under the node-env vitest:
 *
 *  1. `reduceSubagentActivity` — folds `subagent.activity` runtime events
 *     (plus `permission.requested/resolved` and session terminals) into lanes
 *     keyed FLAT by the parent tool_use id. `toolu_*` ids are globally
 *     unique, so a sessionId level would only add lookups and force
 *     `sessionId` down the hottest render path (`ChatTurn → ToolGroupItem →
 *     ToolRow`) as a prop — the arbitration explicitly rejected that.
 *     `sessionId` lives INSIDE the lane for the session-terminal sweep.
 *  2. `deriveSubagentPanelRows` — lane → the panel's rows: ONE header
 *     `ToolRowView` (body `'detail'`) whose children are the subagent's own
 *     tool/text/thinking rows, so folding reuses `ToolRow`'s existing
 *     Collapsible wholesale (zero new DOM patterns).
 *  3. `derivePermissionOrigin` — the "from subagent" chip on a permission
 *     card; null means render nothing (old Host / main-agent request).
 *
 * Capacity discipline (T-35 precedent, resized for this data): lanes are
 * small (rows carry no output bodies — the Host strips them), so 24 lanes ×
 * 40 rows bounds worst-case at ~960 small objects. Ring drops prefer settled
 * rows (a running child tool must not vanish mid-flight — Codex guardrail)
 * and are surfaced via `droppedRows`, never silent.
 */

export const SUBAGENT_LANES_MAX = 24;
export const SUBAGENT_LANE_ROWS_MAX = 40;
export const SUBAGENT_PERMISSION_ORIGINS_MAX = 32;

export type SubagentLaneRow =
  | {
      kind: 'tool';
      toolCallId: string;
      name: string;
      input?: Record<string, string | number>;
      status: 'running' | 'ok' | 'failed';
      errorText?: string;
    }
  | { kind: 'text' | 'thinking'; id: string; text: string };

export interface SubagentProgress {
  description: string | null;
  lastToolName: string | null;
}

export interface SubagentLane {
  parentToolCallId: string;
  sessionId: string;
  agentId: string | null;
  agentType: string | null;
  description: string | null;
  /** null until a `started`/terminal arrives — the panel then falls back to the parent row's running state. */
  status: SubagentRunStatus | null;
  rows: readonly SubagentLaneRow[];
  /** Ring overflow count — the header arg reports "+N earlier" instead of silently forgetting. */
  droppedRows: number;
  /** `task_progress` snapshot — replaced, never appended (heartbeats are not a log). */
  progress: SubagentProgress | null;
  /** Field-wise merged counters from progress/status events (newer non-missing wins). */
  usage: SubagentUsage | null;
  report: SubagentReport | null;
  pendingPermission: { toolName: string } | null;
  capped: boolean;
  /** Creation order — LRU eviction key. */
  ordinal: number;
}

export interface SubagentPermissionOrigin {
  /**
   * Null when the request outran the lane's `started` (Codex round 1, m5):
   * `agentId` alone already proves subagent origin, so the chip must not be
   * forfeited just because the agentIndex entry does not exist yet — only
   * the lane-side "Awaiting permission" marker needs the resolution.
   */
  parentToolCallId: string | null;
  agentType: string | null;
  description: string | null;
}

export interface SubagentActivityState {
  lanes: Readonly<Record<string, SubagentLane>>;
  /** agentId → parentToolCallId; the only join `permission.requested` has. */
  agentIndex: Readonly<Record<string, string>>;
  /** permissionId → origin; deleted on `permission.resolved` (bounded either way). */
  permissionOrigin: Readonly<Record<string, SubagentPermissionOrigin>>;
  nextOrdinal: number;
}

export const initialSubagentActivity: SubagentActivityState = {
  lanes: {},
  agentIndex: {},
  permissionOrigin: {},
  nextOrdinal: 0,
};

/**
 * T093: name the delegate behind a `delegationId`, for the retry banner.
 *
 * The join is the one `permission.requested` already uses — `agentIndex` to a
 * lane — and the label is the one the lane header already prints
 * (`agentType`, falling back to the task description). Returning a STRING (or
 * null) rather than the lane keeps it usable as a zustand selector: a lane
 * update that does not change the name cannot then re-render the timeline.
 *
 * `null` for an unknown delegation is not a degradation to paper over: a retry
 * can arrive before the delegate's first event, and lanes are evicted under
 * pressure. The caller words that case as a nameless subagent.
 */
export function delegateDisplayName(
  state: SubagentActivityState,
  delegationId: string | null | undefined
): string | null {
  if (!delegationId) return null;
  const parentToolCallId = state.agentIndex[delegationId];
  const lane = parentToolCallId ? state.lanes[parentToolCallId] : undefined;
  return lane?.agentType ?? lane?.description ?? null;
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

interface RuntimeEventLike {
  type?: string;
  sessionId?: string;
  payload?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Statuses a lane can end on. Widened with P5-2-4's `stopped`/`truncated`. */
const TERMINAL_STATUSES: ReadonlySet<SubagentRunStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
  'stopped',
  'truncated',
]);

/** Statuses that mean "this did not finish its work", for no-downgrade. */
const UNSUCCESSFUL_STATUSES: ReadonlySet<SubagentRunStatus> = new Set([
  'failed',
  'cancelled',
  'stopped',
  'truncated',
]);

const KNOWN_STATUSES: ReadonlySet<SubagentRunStatus> = new Set(['running', ...TERMINAL_STATUSES]);

function isTerminal(status: SubagentRunStatus | null): boolean {
  return status !== null && TERMINAL_STATUSES.has(status);
}

function readUsage(value: unknown): SubagentUsage | null {
  const rec = asRecord(value);
  if (!rec) return null;
  const usage: SubagentUsage = {};
  const totalTokens = asFiniteNumber(rec.totalTokens);
  const toolUses = asFiniteNumber(rec.toolUses);
  const durationMs = asFiniteNumber(rec.durationMs);
  if (totalTokens !== undefined) usage.totalTokens = totalTokens;
  if (toolUses !== undefined) usage.toolUses = toolUses;
  if (durationMs !== undefined) usage.durationMs = durationMs;
  return Object.keys(usage).length > 0 ? usage : null;
}

/** Field-wise merge — a later event missing a counter must not erase it. */
function mergeUsage(prev: SubagentUsage | null, next: SubagentUsage | null): SubagentUsage | null {
  if (!next) return prev;
  if (!prev) return next;
  return {
    totalTokens: next.totalTokens ?? prev.totalTokens,
    toolUses: next.toolUses ?? prev.toolUses,
    durationMs: next.durationMs ?? prev.durationMs,
  };
}

/**
 * Append with the settled-first ring: past the cap, the oldest NON-running
 * row is dropped (a running child tool keeps its slot); only when every slot
 * is a running tool does the plain oldest go.
 */
function appendRow(
  rows: readonly SubagentLaneRow[],
  row: SubagentLaneRow
): { rows: SubagentLaneRow[]; dropped: number } {
  if (rows.length < SUBAGENT_LANE_ROWS_MAX) {
    return { rows: [...rows, row], dropped: 0 };
  }
  let dropIndex = rows.findIndex((r) => r.kind !== 'tool' || r.status !== 'running');
  if (dropIndex === -1) dropIndex = 0;
  const next = rows.filter((_, i) => i !== dropIndex);
  next.push(row);
  return { rows: next, dropped: 1 };
}

/** Pick the eviction victim: oldest non-running lane, else oldest outright. */
function pickEvictionVictim(lanes: Readonly<Record<string, SubagentLane>>): string | null {
  let victim: SubagentLane | null = null;
  let victimRunning = true;
  for (const lane of Object.values(lanes)) {
    const running = lane.status === 'running';
    const beats =
      victim === null ||
      (victimRunning && !running) ||
      (victimRunning === running && lane.ordinal < victim.ordinal);
    if (beats) {
      victim = lane;
      victimRunning = running;
    }
  }
  return victim ? victim.parentToolCallId : null;
}

function withLane(state: SubagentActivityState, lane: SubagentLane): SubagentActivityState {
  return { ...state, lanes: { ...state.lanes, [lane.parentToolCallId]: lane } };
}

export function reduceSubagentActivity(
  prev: SubagentActivityState,
  event: RuntimeEventLike
): SubagentActivityState {
  switch (event.type) {
    case 'subagent.activity':
      return reduceActivity(prev, event);
    case 'permission.requested':
      return reducePermissionRequested(prev, event);
    case 'permission.resolved':
      return reducePermissionResolved(prev, event);
    case 'session.history':
      return reduceSessionHistory(prev, event);
    case 'session.completed':
    case 'session.failed':
    case 'session.stopped':
      return reduceSessionTerminal(prev, event);
    default:
      return prev;
  }
}

function reduceActivity(
  prev: SubagentActivityState,
  event: RuntimeEventLike
): SubagentActivityState {
  const payload = asRecord(event.payload);
  const sessionId = asString(event.sessionId);
  const parentToolCallId = payload ? asString(payload.parentToolCallId) : null;
  const kind = payload ? asString(payload.kind) : null;
  if (!payload || !sessionId || !parentToolCallId || !kind) return prev;

  let state = prev;
  let lane = state.lanes[parentToolCallId];
  if (!lane) {
    let lanes = state.lanes;
    let agentIndex = state.agentIndex;
    if (Object.keys(lanes).length >= SUBAGENT_LANES_MAX) {
      const victimId = pickEvictionVictim(lanes);
      if (victimId) {
        const victim = lanes[victimId];
        const nextLanes = { ...lanes };
        delete nextLanes[victimId];
        lanes = nextLanes;
        if (victim.agentId && agentIndex[victim.agentId] === victimId) {
          const nextIndex = { ...agentIndex };
          delete nextIndex[victim.agentId];
          agentIndex = nextIndex;
        }
      }
    }
    lane = {
      parentToolCallId,
      sessionId,
      agentId: null,
      agentType: null,
      description: null,
      status: null,
      rows: [],
      droppedRows: 0,
      progress: null,
      usage: null,
      report: null,
      pendingPermission: null,
      capped: false,
      ordinal: state.nextOrdinal,
    };
    state = {
      ...state,
      lanes: { ...lanes, [parentToolCallId]: lane },
      agentIndex,
      nextOrdinal: state.nextOrdinal + 1,
    };
  }

  const agentId = asString(payload.agentId);
  if (agentId && lane.agentId === null) {
    lane = { ...lane, agentId };
    state = {
      ...withLane(state, lane),
      agentIndex: { ...state.agentIndex, [agentId]: parentToolCallId },
    };
  }

  switch (kind) {
    case 'started': {
      const next: SubagentLane = {
        ...lane,
        agentType: asString(payload.agentType) ?? lane.agentType,
        description: asString(payload.description) ?? lane.description,
        // A `started` racing in after a terminal must not resurrect the lane.
        status: isTerminal(lane.status) ? lane.status : 'running',
      };
      return withLane(state, next);
    }
    case 'text':
    case 'thinking': {
      const id = asString(payload.id);
      const text = asString(payload.text);
      if (!id || !text) return state === prev ? prev : state;
      // Idempotency (Codex round 1, m4): a redelivered id must not re-enter
      // the ring — it would burn a slot and mint a fresh state reference.
      if (lane.rows.some((r) => r.kind === kind && r.id === id)) {
        return state === prev ? prev : state;
      }
      const { rows, dropped } = appendRow(lane.rows, { kind, id, text });
      return withLane(state, { ...lane, rows, droppedRows: lane.droppedRows + dropped });
    }
    case 'tool.started': {
      const toolCallId = asString(payload.toolCallId);
      const name = asString(payload.name);
      if (!toolCallId || !name) return state === prev ? prev : state;
      // Idempotency (Codex round 1, m4): a duplicate started for a known id
      // is dropped whole — appending would leave a twin the completion can
      // never settle (only the first match updates), i.e. a forever-spinner.
      if (lane.rows.some((r) => r.kind === 'tool' && r.toolCallId === toolCallId)) {
        return state === prev ? prev : state;
      }
      const input = asRecord(payload.input) as Record<string, string | number> | null;
      const { rows, dropped } = appendRow(lane.rows, {
        kind: 'tool',
        toolCallId,
        name,
        ...(input ? { input } : {}),
        status: 'running',
      });
      return withLane(state, { ...lane, rows, droppedRows: lane.droppedRows + dropped });
    }
    case 'tool.completed': {
      const toolCallId = asString(payload.toolCallId);
      if (!toolCallId) return state === prev ? prev : state;
      const ok = payload.ok === true;
      const errorText = asString(payload.errorText) ?? undefined;
      const index = lane.rows.findIndex((r) => r.kind === 'tool' && r.toolCallId === toolCallId);
      if (index >= 0) {
        const row = lane.rows[index] as Extract<SubagentLaneRow, { kind: 'tool' }>;
        const rows = [...lane.rows];
        rows[index] = {
          ...row,
          status: ok ? 'ok' : 'failed',
          ...(errorText ? { errorText } : {}),
        };
        return withLane(state, { ...lane, rows });
      }
      // Out-of-order or ring-evicted start — record a settled row instead of
      // dropping the completion on the floor.
      const { rows, dropped } = appendRow(lane.rows, {
        kind: 'tool',
        toolCallId,
        name: 'unknown',
        status: ok ? 'ok' : 'failed',
        ...(errorText ? { errorText } : {}),
      });
      return withLane(state, { ...lane, rows, droppedRows: lane.droppedRows + dropped });
    }
    case 'progress': {
      const progress: SubagentProgress = {
        description: asString(payload.description),
        lastToolName: asString(payload.lastToolName),
      };
      return withLane(state, {
        ...lane,
        progress,
        usage: mergeUsage(lane.usage, readUsage(payload.usage)),
      });
    }
    case 'status': {
      const status = asString(payload.status) as SubagentRunStatus | null;
      if (status === null || !KNOWN_STATUSES.has(status)) {
        return state === prev ? prev : state;
      }
      // Terminal no-downgrade (Codex guardrails, rounds 1+2): a late generic
      // `completed` must not overwrite an observed unsuccessful terminal, and
      // NO terminal may be resurrected to `running` by a straggling heartbeat.
      const finalStatus =
        (isTerminal(lane.status) && status === 'running') ||
        (lane.status !== null && UNSUCCESSFUL_STATUSES.has(lane.status) && status === 'completed')
          ? lane.status
          : status;
      return withLane(state, {
        ...lane,
        status: finalStatus,
        usage: mergeUsage(lane.usage, readUsage(payload.usage)),
        pendingPermission: isTerminal(finalStatus) ? null : lane.pendingPermission,
      });
    }
    case 'report': {
      const report = asRecord(payload.report) as SubagentReport | null;
      if (!report) return state === prev ? prev : state;
      // Host-normalized status; `running` is real (async delegation whose
      // report lands early) and must keep the lane live, not mark success.
      // Unknown/absent reads as completed — the report IS the terminal
      // artifact in every synchronous run.
      const fromReport: SubagentRunStatus =
        report.status && report.status !== 'completed' && KNOWN_STATUSES.has(report.status)
          ? report.status
          : 'completed';
      const finalStatus =
        (isTerminal(lane.status) && fromReport === 'running') ||
        (lane.status !== null && UNSUCCESSFUL_STATUSES.has(lane.status))
          ? lane.status
          : fromReport;
      return withLane(state, {
        ...lane,
        report,
        status: finalStatus,
        pendingPermission: isTerminal(finalStatus) ? null : lane.pendingPermission,
      });
    }
    case 'capped':
      return withLane(state, { ...lane, capped: true });
    default:
      return state === prev ? prev : state;
  }
}

function reducePermissionRequested(
  prev: SubagentActivityState,
  event: RuntimeEventLike
): SubagentActivityState {
  const payload = asRecord(event.payload);
  const permissionId = payload ? asString(payload.permissionId) : null;
  const toolName = payload ? asString(payload.toolName) : null;
  const agentId = payload ? asString(payload.agentId) : null;
  if (!payload || !permissionId || !toolName || !agentId) return prev;
  // `agentId` present already proves this came from a subagent — the origin
  // (and so the chip) is recorded unconditionally; only the lane's own
  // "Awaiting permission" marker needs the agentIndex to resolve.
  const parentToolCallId = prev.agentIndex[agentId];
  const lane = parentToolCallId ? prev.lanes[parentToolCallId] : undefined;

  let permissionOrigin: Record<string, SubagentPermissionOrigin> = {
    ...prev.permissionOrigin,
    [permissionId]: {
      parentToolCallId: lane?.parentToolCallId ?? null,
      // P5-2-6: the request's own `agentName` first. The native runtime knows
      // which delegate is asking at the gate, so the card can name it even when
      // the request outran the lane's `started` — which is precisely the race
      // the null-parent case below exists for.
      agentType: asString(payload.agentName) ?? lane?.agentType ?? null,
      description: lane?.description ?? null,
    },
  };
  const originKeys = Object.keys(permissionOrigin);
  if (originKeys.length > SUBAGENT_PERMISSION_ORIGINS_MAX) {
    // Insertion order = arrival order; drop the oldest.
    const next = { ...permissionOrigin };
    delete next[originKeys[0]];
    permissionOrigin = next;
  }

  return {
    ...prev,
    lanes: lane
      ? {
          ...prev.lanes,
          [lane.parentToolCallId]: { ...lane, pendingPermission: { toolName } },
        }
      : prev.lanes,
    permissionOrigin,
  };
}

function reducePermissionResolved(
  prev: SubagentActivityState,
  event: RuntimeEventLike
): SubagentActivityState {
  const payload = asRecord(event.payload);
  const permissionId = payload ? asString(payload.permissionId) : null;
  if (!permissionId) return prev;
  const origin = prev.permissionOrigin[permissionId];
  if (!origin) return prev;

  const permissionOrigin = { ...prev.permissionOrigin };
  delete permissionOrigin[permissionId];
  const lane = origin.parentToolCallId ? prev.lanes[origin.parentToolCallId] : undefined;
  return {
    ...prev,
    permissionOrigin,
    lanes:
      lane?.pendingPermission != null && origin.parentToolCallId
        ? {
            ...prev.lanes,
            [origin.parentToolCallId]: { ...lane, pendingPermission: null },
          }
        : prev.lanes,
  };
}

/**
 * How a recorded delegation's status reads on screen.
 *
 * `interrupted` is the one that needs translating: a hard exit leaves a
 * delegation that started and never settled, and the honest reading is
 * `cancelled` — it is over, and the process that was running it is gone. The
 * one thing it must NOT read as is `running`, which would be a reopened
 * session claiming work is still in flight.
 */
function historyStatus(status: string): SubagentRunStatus {
  switch (status) {
    case 'completed':
    case 'failed':
    case 'stopped':
    case 'truncated':
    case 'running':
      return status;
    case 'aborted':
    case 'interrupted':
      return 'cancelled';
    default:
      // `timed_out` and anything a newer runtime invents: it ended, and it did
      // not end well. Better than dropping the delegation entirely.
      return 'failed';
  }
}

/**
 * P5-2-6 — rebuild delegation lanes from a history read.
 *
 * A reopened session gets no `subagent.activity` events: those are live, and
 * the conversation being restored already happened. The summaries come off the
 * session file, so a `Task` row from last week gets its panel back with the
 * status, the counters and the report that were recorded at the time.
 *
 * What it rebuilds is deliberately less than a live lane: one text row holding
 * the report, plus the terminal status and counters. The delegate's individual
 * tool calls stay in the session file and are read on demand — the live lane
 * caps at 40 rows anyway, so replaying a transcript here would be paying a
 * reload cost for rows the ring would drop.
 *
 * An existing lane WINS. A history refresh that arrived while a delegation was
 * running must not overwrite the live one with its own stale snapshot.
 */
function reduceSessionHistory(
  prev: SubagentActivityState,
  event: RuntimeEventLike
): SubagentActivityState {
  const payload = asRecord(event.payload);
  const sessionId = asString(event.sessionId);
  const summaries = payload?.subagents;
  if (!payload || !sessionId || !Array.isArray(summaries) || summaries.length === 0) return prev;

  let lanes: Record<string, SubagentLane> | null = null;
  let ordinal = prev.nextOrdinal;
  let agentIndex: Record<string, string> | null = null;

  // Newest first within the lane budget: a long session can hold more
  // delegations than the store keeps lanes for, and the ones worth rebuilding
  // are the recent ones the user is scrolled near — not the oldest, which is
  // what taking the head would have given.
  const budget = Math.max(0, SUBAGENT_LANES_MAX - Object.keys(prev.lanes).length);
  for (const entry of summaries.slice(-budget)) {
    const summary = asRecord(entry);
    const parentToolCallId = summary ? asString(summary.parentToolCallId) : null;
    if (!summary || !parentToolCallId) continue;
    if (prev.lanes[parentToolCallId]) continue;

    const report = asString(summary.report);
    const rows: SubagentLaneRow[] = report
      ? [{ kind: 'text', id: `history-${parentToolCallId}`, text: report }]
      : [];
    const usage: SubagentUsage = {};
    const totalTokens = asFiniteNumber(summary.totalTokens);
    const toolCalls = asFiniteNumber(summary.toolCalls);
    const startedAt = asFiniteNumber(summary.startedAt);
    const completedAt = asFiniteNumber(summary.completedAt);
    if (totalTokens !== undefined) usage.totalTokens = totalTokens;
    if (toolCalls !== undefined) usage.toolUses = toolCalls;
    if (startedAt !== undefined && completedAt !== undefined) {
      usage.durationMs = Math.max(0, completedAt - startedAt);
    }

    const agentId = asString(summary.delegationId);
    const agentType = asString(summary.agentName);
    const status = historyStatus(String(summary.status ?? ''));
    if (!lanes) lanes = { ...prev.lanes };
    lanes[parentToolCallId] = {
      parentToolCallId,
      sessionId,
      agentId,
      agentType,
      description: asString(summary.label),
      status,
      rows,
      droppedRows: 0,
      progress: null,
      usage: Object.keys(usage).length > 0 ? usage : null,
      // A report object, so the header renders the finished-run stats line
      // rather than the live one.
      report: {
        status,
        ...(agentType ? { agentType } : {}),
        ...(asString(summary.model) ? { resolvedModel: asString(summary.model) as string } : {}),
        ...(usage.durationMs !== undefined ? { totalDurationMs: usage.durationMs } : {}),
        ...(totalTokens !== undefined ? { totalTokens } : {}),
        ...(toolCalls !== undefined ? { totalToolUseCount: toolCalls } : {}),
      },
      pendingPermission: null,
      capped: false,
      ordinal: ordinal++,
    };
    if (agentId) {
      if (!agentIndex) agentIndex = { ...prev.agentIndex };
      agentIndex[agentId] = parentToolCallId;
    }
  }

  if (!lanes) return prev;
  return {
    ...prev,
    lanes,
    ...(agentIndex ? { agentIndex } : {}),
    nextOrdinal: ordinal,
  };
}

/**
 * A turn-terminal for the session sweeps every lane still `running` (or never
 * classified) to `cancelled` — this closes the "Stop clicked, spinner forever"
 * hole: no further subagent events are coming for those lanes.
 */
function reduceSessionTerminal(
  prev: SubagentActivityState,
  event: RuntimeEventLike
): SubagentActivityState {
  const sessionId = asString(event.sessionId);
  if (!sessionId) return prev;
  // A Ctrl+Enter completion ends the parent run and deliberately leaves its
  // delegates running; their own terminal `status` payload settles each lane.
  if (event.type === 'session.completed' && asRecord(event.payload)?.stopCause === 'interjected')
    return prev;
  let lanes: Record<string, SubagentLane> | null = null;
  for (const [key, lane] of Object.entries(prev.lanes)) {
    if (lane.sessionId !== sessionId) continue;
    const needsStatus = lane.status === 'running' || lane.status === null;
    if (!needsStatus && lane.pendingPermission === null) continue;
    if (!lanes) lanes = { ...prev.lanes };
    lanes[key] = {
      ...lane,
      status: needsStatus ? 'cancelled' : lane.status,
      pendingPermission: null,
    };
  }
  return lanes ? { ...prev, lanes } : prev;
}

// ---------------------------------------------------------------------------
// Panel derivation
// ---------------------------------------------------------------------------

export interface SubagentPanelOptions {
  /** The parent delegation row's own running state — the fallback liveness signal. */
  parentRunning: boolean;
  /** Locale-aware translator for the ARG text; verbs stay keys (`ToolRowView.verb`). */
  t?: Translate;
}

const HEADER_VERB = 'Subagent';
const TEXT_ROW_VERB = 'Said';
const FIRST_LINE_MAX = 120;

function firstLineOf(text: string): { line: string; hasMore: boolean } {
  const newline = text.indexOf('\n');
  const raw = newline === -1 ? text : text.slice(0, newline);
  const line = raw.length > FIRST_LINE_MAX ? `${raw.slice(0, FIRST_LINE_MAX)}…` : raw;
  return { line, hasMore: line !== text };
}

function proseRow(key: string, verb: string, text: string): ToolRowView {
  const { line, hasMore } = firstLineOf(text);
  return {
    key,
    verb,
    arg: line,
    argKind: 'prose',
    running: false,
    failed: false,
    expandable: hasMore,
    ...(hasMore ? { body: 'thinking' as const, output: text } : {}),
  };
}

function statsArg(lane: SubagentLane, t: Translate): string | undefined {
  const report = lane.report;
  const toolUses = report?.totalToolUseCount ?? lane.usage?.toolUses;
  const tokens = report?.totalTokens ?? lane.usage?.totalTokens;
  const durationMs = report?.totalDurationMs ?? lane.usage?.durationMs;
  const segments: string[] = [];
  const label = lane.agentType ?? lane.description;
  if (label) segments.push(label);
  if (toolUses !== undefined) {
    segments.push(
      toolUses === 1
        ? t('{{count}} tool', { count: toolUses })
        : t('{{count}} tools', { count: toolUses })
    );
  }
  // The thousands separator stays `en-US` on purpose: this is a machine count
  // rendered next to other machine counts, and grouping is the same in both
  // locales here.
  if (tokens !== undefined) {
    segments.push(t('{{count}} tokens', { count: tokens.toLocaleString('en-US') }));
  }
  if (durationMs !== undefined) segments.push(`${(durationMs / 1000).toFixed(1)}s`);
  return segments.length > 0 ? segments.join(' · ') : undefined;
}

/**
 * Lane → panel rows. The whole panel is ONE header `ToolRowView` with
 * `body: 'detail'` — folding rides `ToolRow`'s existing Collapsible.
 * Returns `[]` for a content-free lane so the mount renders nothing (no
 * orphan border line — the layout-invisible-defects lesson).
 */
export function deriveSubagentPanelRows(
  lane: SubagentLane | null | undefined,
  options: SubagentPanelOptions
): ToolRowView[] {
  if (!lane) return [];

  const t = options.t ?? englishTranslate;
  const live = lane.status === null ? options.parentRunning : lane.status === 'running';

  // P5-2-6 removed a positional rule that used to live here: when a report
  // arrived, the lane's LAST text row was dropped, because under the T-34 host
  // the delegation's tool row carried the subagent's final answer as its own
  // output and rendering it twice was the defect.
  //
  // The native runtime does not work that way. `Task` returns an ack — "the
  // explorer subagent is working in the background" — and the report reaches
  // the model either through a later `TaskWait` result or through an internal
  // resume with no bubble at all. So the rule was dropping the ONE copy of the
  // delegate's answer the user could see: "report once" had become "report
  // never" for every delegation the model did not explicitly wait on.
  //
  // If a producer ever again puts the report body on the parent row, that
  // producer must say so on the payload. A renderer guessing from row position
  // is how this went wrong the first time.
  const children: ToolRowView[] = [];
  lane.rows.forEach((row) => {
    if (row.kind === 'tool') {
      children.push(
        deriveToolRowView(
          {
            toolCallId: row.toolCallId,
            blockIndex: 0,
            blockId: `sub-${row.toolCallId}`,
            toolName: row.name,
            input: row.input,
            status: row.status,
            output: row.status === 'failed' ? row.errorText : undefined,
            errorText: row.status === 'failed' ? row.errorText : undefined,
          },
          { t }
        )
      );
    } else if (row.kind === 'text') {
      children.push(proseRow(`sub-text-${row.id}`, TEXT_ROW_VERB, row.text));
    } else {
      children.push(proseRow(`sub-think-${row.id}`, THOUGHT_VERB, row.text));
    }
  });

  if (lane.capped) {
    children.push({
      key: `sub-${lane.parentToolCallId}~capped`,
      verb: 'Capped',
      arg: t('activity feed capped — remaining live updates dropped'),
      argKind: 'prose',
      running: false,
      failed: false,
      expandable: false,
    });
  }

  const contentFree =
    children.length === 0 &&
    lane.progress === null &&
    lane.report === null &&
    lane.status === null &&
    lane.pendingPermission === null;
  if (contentFree) return [];

  let arg: string | undefined;
  // chat-tool-05 — both branches carry a tool name straight off the wire, and
  // an MCP one is `mcp__<server>__<tool>`. The child rows below this header go
  // through `deriveToolRowView`, which labels it; without the same call here the
  // same action was named twice on one screen, once as a protocol identifier.
  if (lane.pendingPermission) {
    arg = t('Awaiting permission · {{tool}}', {
      tool: toolDisplayName(lane.pendingPermission.toolName),
    });
  } else if (live) {
    const lastTool = lane.progress?.lastToolName;
    arg =
      lane.progress?.description ??
      (lastTool ? toolDisplayName(lastTool) : undefined) ??
      lane.agentType ??
      lane.description ??
      undefined;
  } else {
    arg = statsArg(lane, t);
  }
  if (lane.droppedRows > 0) {
    const suffix = t('+{{count}} earlier', { count: lane.droppedRows });
    arg = arg ? `${arg} · ${suffix}` : suffix;
  }

  const expandable = children.length > 0;
  return [
    {
      key: `sub-${lane.parentToolCallId}~panel`,
      verb: HEADER_VERB,
      arg,
      // Numbers refresh in place while live — tabular-nums via the prose branch.
      argKind: 'prose',
      // Deliberately NOT `running: live` (registered deviation from A07's
      // "running rows have no chevron"): the panel's content exists WHILE
      // running, so the chevron must too.
      running: false,
      failed: lane.status === 'failed',
      expandable,
      ...(expandable ? { body: 'detail' as const, detail: children } : {}),
      // Live panels open by default; otherwise leave it to the renderer's
      // `defaultOpen ?? failed` fallback so a failed lane still auto-opens.
      ...(live ? { defaultOpen: true } : {}),
    },
  ];
}

// ---------------------------------------------------------------------------
// Permission-origin chip
// ---------------------------------------------------------------------------

export interface PermissionOriginView {
  label: string;
}

/** Null in, null out — the chip renders nothing for main-agent requests. */
export function derivePermissionOrigin(
  origin: SubagentPermissionOrigin | null | undefined,
  t: Translate = englishTranslate
): PermissionOriginView | null {
  if (!origin) return null;
  const detail = origin.description ?? origin.agentType;
  return {
    label: detail ? t('From subagent · {{detail}}', { detail }) : t('From subagent'),
  };
}
