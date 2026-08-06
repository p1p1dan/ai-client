import type { SubagentReport, SubagentRunStatus, SubagentUsage } from '@shared/types/runtimeEvents';
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
  parentToolCallId: string;
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

function isTerminal(status: SubagentRunStatus | null): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
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
      const { rows, dropped } = appendRow(lane.rows, { kind, id, text });
      return withLane(state, { ...lane, rows, droppedRows: lane.droppedRows + dropped });
    }
    case 'tool.started': {
      const toolCallId = asString(payload.toolCallId);
      const name = asString(payload.name);
      if (!toolCallId || !name) return state === prev ? prev : state;
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
      if (
        status !== 'running' &&
        status !== 'completed' &&
        status !== 'failed' &&
        status !== 'cancelled'
      ) {
        return state === prev ? prev : state;
      }
      // Terminal no-downgrade (Codex guardrail): a late generic `completed`
      // must not overwrite an observed failed/cancelled.
      const finalStatus =
        (lane.status === 'failed' || lane.status === 'cancelled') && status === 'completed'
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
      const fromReport: SubagentRunStatus = report.status === 'failed' ? 'failed' : 'completed';
      const finalStatus =
        lane.status === 'failed' || lane.status === 'cancelled' ? lane.status : fromReport;
      return withLane(state, {
        ...lane,
        report,
        status: finalStatus,
        pendingPermission: null,
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
  const parentToolCallId = prev.agentIndex[agentId];
  const lane = parentToolCallId ? prev.lanes[parentToolCallId] : undefined;
  if (!lane) return prev;

  let permissionOrigin: Record<string, SubagentPermissionOrigin> = {
    ...prev.permissionOrigin,
    [permissionId]: {
      parentToolCallId: lane.parentToolCallId,
      agentType: lane.agentType,
      description: lane.description,
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
    lanes: {
      ...prev.lanes,
      [lane.parentToolCallId]: { ...lane, pendingPermission: { toolName } },
    },
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
  const lane = prev.lanes[origin.parentToolCallId];
  return {
    ...prev,
    permissionOrigin,
    lanes:
      lane?.pendingPermission != null
        ? {
            ...prev.lanes,
            [origin.parentToolCallId]: { ...lane, pendingPermission: null },
          }
        : prev.lanes,
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

function statsArg(lane: SubagentLane): string | undefined {
  const report = lane.report;
  const toolUses = report?.totalToolUseCount ?? lane.usage?.toolUses;
  const tokens = report?.totalTokens ?? lane.usage?.totalTokens;
  const durationMs = report?.totalDurationMs ?? lane.usage?.durationMs;
  const segments: string[] = [];
  const label = lane.agentType ?? lane.description;
  if (label) segments.push(label);
  if (toolUses !== undefined) segments.push(`${toolUses} tool${toolUses === 1 ? '' : 's'}`);
  if (tokens !== undefined) segments.push(`${tokens.toLocaleString('en-US')} tokens`);
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

  const live = lane.status === null ? options.parentRunning : lane.status === 'running';

  // Report present ⇒ the subagent's last text IS the Agent row's own output
  // body — drop it here instead of rendering the answer twice (positional
  // rule; the protocol deliberately never carries the report body).
  let skipRowIndex = -1;
  if (lane.report) {
    for (let i = lane.rows.length - 1; i >= 0; i -= 1) {
      if (lane.rows[i].kind === 'text') {
        skipRowIndex = i;
        break;
      }
    }
  }

  const children: ToolRowView[] = [];
  lane.rows.forEach((row, index) => {
    if (index === skipRowIndex) return;
    if (row.kind === 'tool') {
      children.push(
        deriveToolRowView({
          toolCallId: row.toolCallId,
          blockIndex: 0,
          blockId: `sub-${row.toolCallId}`,
          toolName: row.name,
          input: row.input,
          status: row.status,
          output: row.status === 'failed' ? row.errorText : undefined,
          errorText: row.status === 'failed' ? row.errorText : undefined,
        })
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
      arg: 'activity feed capped — remaining live updates dropped',
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
  if (lane.pendingPermission) {
    arg = `Awaiting permission · ${lane.pendingPermission.toolName}`;
  } else if (live) {
    arg =
      lane.progress?.description ??
      lane.progress?.lastToolName ??
      lane.agentType ??
      lane.description ??
      undefined;
  } else {
    arg = statsArg(lane);
  }
  if (lane.droppedRows > 0) {
    const suffix = `+${lane.droppedRows} earlier`;
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
  origin: SubagentPermissionOrigin | null | undefined
): PermissionOriginView | null {
  if (!origin) return null;
  const detail = origin.description ?? origin.agentType;
  return { label: detail ? `From subagent · ${detail}` : 'From subagent' };
}
