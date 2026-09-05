/**
 * T-14: pure data layer for the Context surface — three definition-list
 * groups (Workspace / Runtime / Session) built from real, already-wired
 * sources only (no mock content, no hardcoded fallback text beyond the two
 * spec-blessed honest strings: effort's `null` → 'Default' and permission
 * policy's unknown → 'Permission policy not reported'). A field with nothing
 * real to say is omitted — never padded with a placeholder — and a group
 * left with zero rows is dropped entirely (R6 in the surface spec).
 *
 * `ContextSurfaceView.tsx` owns wiring the live sources (chatSessions store,
 * useHostStatus, useMessageMetadata, useSessionEffort, sessionRuntimeFacts,
 * turnSendStatus) into the input shapes below; everything here stays free of
 * React/electronAPI so it runs under the repo's node-env vitest.
 */

import { type PiUsagePayload, readPiUsagePayload } from '@shared/piUsage';
import type { SessionRetryInfo, SessionRuntimeStatus } from '@shared/types/runtimeEvents';
import { EFFORT_DEFAULT_ID, effortLabel } from '@/components/chat/efforts';
import { parseMentionChips } from '@/components/chat/fileMention';
import type { ChatMessage } from '@/stores/chatSessions';

// ---------------------------------------------------------------------------
// Definition-list shape
// ---------------------------------------------------------------------------

export interface ContextRow {
  id: string;
  /** English source string = i18n key (see src/shared/i18n.ts). */
  label: string;
  value: string;
  /** Full-value tooltip; the view falls back to `value` when this is unset. */
  title?: string;
  copyable?: boolean;
}

export type ContextGroupId = 'workspace' | 'runtime' | 'session' | 'stderr';

export interface ContextGroup {
  id: ContextGroupId;
  /** English source string = i18n key. */
  label: string;
  rows: ContextRow[];
}

// ---------------------------------------------------------------------------
// deriveContextGroups
// ---------------------------------------------------------------------------

export interface ContextWorkspaceFacts {
  path: string | null;
  kind: string | null;
  /** Absent branch never falls back to a guessed name — see field table §4. */
  branch: string | null;
  /** Tri-state: `true` is the only value that unlocks the branch row. */
  gitEnabled: boolean | null | undefined;
}

export interface ContextHostFacts {
  /** `useHostStatus`'s own state — shown even when `'stopped'` (real value). */
  state: string;
  pid: number | null | undefined;
  driver: string | null | undefined;
  version: string | null | undefined;
  /** Local Electron app build version (`window.electronAPI.env.appVersion`) — independent of Host/session state, always known once the renderer has loaded. `null`/undefined omits the row. */
  appVersion?: string | null;
  /** Precedence-resolved credential type in effect for the Host env (claudeSettings.ts). `null`/undefined (incl. an old, not-yet-restarted Host build that never reported it) omits the row — never guessed. */
  authTokenType?: 'ANTHROPIC_AUTH_TOKEN' | 'ANTHROPIC_API_KEY' | 'none' | null;
  /** Bare gateway host (never the full URL — deliberate host-only projection, see claudeSettings.ts `baseHost`). `null`/undefined omits the row. */
  baseHost?: string | null;
}

export interface ContextRuntimeFacts {
  /** `null` = no active session, omit every model row. */
  configuredModel: string | null;
  /**
   * Real echoed model for the session's last assistant turn; `null` = none
   * yet. A06: the caller (`ContextSurfaceView`) MUST wire this from
   * `MessageMetadata.reportedModel`, never `.model` — the latter silently
   * falls back to the session's configured selection when the Host reports
   * nothing, which would make this field lie about being "actual".
   */
  actualModel: string | null;
  /**
   * `getSessionEffort` result. `undefined` = no active session (omit row);
   * `null` = session exists but no override is stored — 'Default' is the
   * true semantics of that state, not a placeholder (spec §4).
   */
  effortSelection: string | null | undefined;
  host: ContextHostFacts;
}

export interface ContextSessionAttachmentFact {
  kind: 'image' | 'text';
  mediaType: string;
  name?: string;
}

export interface ContextSessionFacts {
  /** `session.status` — 9-state passthrough, never relabeled (spec: "原样"). */
  status: SessionRuntimeStatus;
  retryLabel: string | null;
  turnSendLabel: string | null;
  pendingPermissionsCount: number;
  attachments: readonly ContextSessionAttachmentFact[];
  mentions: readonly string[];
  runtimeIdentity: string | null;
}

export interface ContextGroupsInput {
  /** `null` = no resolvable workspace (no session, or session's workspace missing). */
  workspace: ContextWorkspaceFacts | null;
  runtime: ContextRuntimeFacts;
  /** `null` = no active session — the whole Session group is dropped. */
  session: ContextSessionFacts | null;
  /** T-35: `null`/empty = no stderr this session — the whole group is dropped (zero noise on a healthy turn). */
  stderr: SessionStderrFacts | null;
}

function buildWorkspaceRows(facts: ContextWorkspaceFacts | null): ContextRow[] {
  if (!facts) return [];
  const rows: ContextRow[] = [];
  if (facts.path) {
    rows.push({ id: 'path', label: 'Path', value: facts.path, title: facts.path, copyable: true });
  }
  if (facts.kind) {
    rows.push({ id: 'kind', label: 'Kind', value: facts.kind });
  }
  // Branch requires BOTH a known branch AND a confirmed git-enabled workspace
  // (T-27's own `=== true` gate, composerTarget.ts's `shouldShowBranchSelect`)
  // — `gitEnabled` unknown/false must not show a stale/irrelevant branch name.
  if (facts.gitEnabled === true && facts.branch) {
    rows.push({ id: 'branch', label: 'Branch', value: facts.branch });
  }
  return rows;
}

/**
 * Display priority actual > configured (spec §4): when the real echoed model
 * is known it is what actually answered, so it leads. The two are shown
 * side by side, each labeled with its source, ONLY when they diverge —
 * otherwise a single 'Model' row is enough and a second row would just be
 * noise repeating the same value.
 */
function buildModelRows(configuredModel: string | null, actualModel: string | null): ContextRow[] {
  if (actualModel && configuredModel && actualModel !== configuredModel) {
    return [
      { id: 'model-actual', label: 'Model (actual)', value: actualModel },
      { id: 'model-configured', label: 'Model (configured)', value: configuredModel },
    ];
  }
  const value = actualModel ?? configuredModel;
  if (!value) return [];
  return [{ id: 'model', label: 'Model', value }];
}

/** `null` selection is real "unset" semantics, not a missing field — see `ContextRuntimeFacts.effortSelection`. */
function effortDisplayLabel(selection: string | null): string {
  return effortLabel(selection ?? EFFORT_DEFAULT_ID);
}

function buildHostRows(host: ContextHostFacts): ContextRow[] {
  // `state` always renders — 'stopped' is a real, honest value (spec: "stopped 也照显"), not a placeholder.
  const rows: ContextRow[] = [{ id: 'host-state', label: 'Host status', value: host.state }];
  if (typeof host.pid === 'number') {
    rows.push({ id: 'host-pid', label: 'Process ID', value: String(host.pid) });
  }
  if (host.driver) {
    rows.push({ id: 'host-driver', label: 'Driver', value: host.driver });
  }
  if (host.version) {
    rows.push({ id: 'host-version', label: 'Version', value: host.version });
  }
  if (host.appVersion) {
    rows.push({ id: 'host-app-version', label: 'App', value: host.appVersion });
  }
  if (host.authTokenType) {
    rows.push({
      id: 'host-auth',
      label: 'Auth',
      value: host.authTokenType === 'none' ? 'OAuth / subscription login' : host.authTokenType,
    });
  }
  if (host.baseHost) {
    rows.push({ id: 'host-gateway', label: 'Gateway', value: host.baseHost });
  }
  return rows;
}

function buildRuntimeRows(facts: ContextRuntimeFacts): ContextRow[] {
  const rows: ContextRow[] = [...buildModelRows(facts.configuredModel, facts.actualModel)];
  if (facts.effortSelection !== undefined) {
    rows.push({
      id: 'effort',
      label: 'Reasoning effort',
      value: effortDisplayLabel(facts.effortSelection),
    });
  }
  rows.push(...buildHostRows(facts.host));
  return rows;
}

function formatAttachmentsValue(attachments: readonly ContextSessionAttachmentFact[]): string {
  // "不去重不显 data" (spec §4): every sent attachment listed once, in order,
  // never the raw bytes — ContextSessionAttachmentFact structurally cannot
  // carry `data` (mirrors ChatMessageAttachment).
  return attachments.map((item) => `${item.kind}:${item.name ?? item.mediaType}`).join(', ');
}

function buildSessionRows(facts: ContextSessionFacts | null): ContextRow[] {
  if (!facts) return [];
  const rows: ContextRow[] = [{ id: 'status', label: 'Status', value: facts.status }];
  if (facts.retryLabel) {
    rows.push({ id: 'retry', label: 'Retry', value: facts.retryLabel });
  }
  if (facts.turnSendLabel) {
    rows.push({ id: 'turn', label: 'Turn', value: facts.turnSendLabel });
  }
  // Always shown, including 0 — a real count, not a fake state (mirrors
  // surfaceRegistry.ts's own `countChangedFiles` → 0 convention).
  rows.push({
    id: 'pending-permissions',
    label: 'Pending permissions',
    value: String(facts.pendingPermissionsCount),
  });
  if (facts.attachments.length > 0) {
    rows.push({
      id: 'attachments',
      label: 'Sent attachments',
      value: formatAttachmentsValue(facts.attachments),
    });
  }
  if (facts.mentions.length > 0) {
    rows.push({ id: 'mentions', label: 'Mentions', value: facts.mentions.join(', ') });
  }
  if (facts.runtimeIdentity) {
    rows.push({
      id: 'runtime-identity',
      label: 'Runtime identity',
      value: facts.runtimeIdentity,
      title: facts.runtimeIdentity,
    });
  }
  return rows;
}

/**
 * T-35: one row per forwarded stderr line, ordinal-labeled. Ordinals count
 * from `total`, not from the ring — after eviction `#31…#50` says plainly
 * that 30 earlier lines exist and live in the Host log only.
 */
function buildStderrRows(stderr: SessionStderrFacts | null): ContextRow[] {
  if (!stderr || stderr.lines.length === 0) return [];
  const firstOrdinal = stderr.total - stderr.lines.length + 1;
  return stderr.lines.map((line, index) => ({
    id: `stderr-${firstOrdinal + index}`,
    label: `#${firstOrdinal + index}`,
    value: line,
    title: line,
    copyable: true,
  }));
}

/** Builds the four groups and drops any that end up with zero rows (R6: no group ever fakes content). */
export function deriveContextGroups(input: ContextGroupsInput): ContextGroup[] {
  const groups: ContextGroup[] = [
    { id: 'workspace', label: 'Workspace', rows: buildWorkspaceRows(input.workspace) },
    { id: 'runtime', label: 'Runtime', rows: buildRuntimeRows(input.runtime) },
    { id: 'session', label: 'Session', rows: buildSessionRows(input.session) },
    { id: 'stderr', label: 'Host stderr', rows: buildStderrRows(input.stderr) },
  ];
  return groups.filter((group) => group.rows.length > 0);
}

// ---------------------------------------------------------------------------
// deriveRunState
// ---------------------------------------------------------------------------

export interface RunStateTurnSend {
  phase: string;
  elapsedSeconds: number;
}

export interface RunStateInput {
  status: SessionRuntimeStatus;
  retry?: SessionRetryInfo | null;
  turnSend?: RunStateTurnSend | null;
}

export interface RunStateView {
  /** Raw passthrough — one of the 9 `SessionRuntimeStatus` values, unmapped. */
  status: SessionRuntimeStatus;
  retryLabel: string | null;
  turnSendLabel: string | null;
}

function formatRetryLabel(retry: SessionRetryInfo): string {
  const statusSuffix = retry.errorStatus ? ` ${retry.errorStatus}` : '';
  return `Attempt ${retry.attempt}/${retry.maxRetries} · retry in ${retry.delayMs}ms · ${retry.error}${statusSuffix}`;
}

function formatTurnSendLabel(turnSend: RunStateTurnSend): string {
  return `${turnSend.phase} · ${turnSend.elapsedSeconds}s`;
}

/** Folds session.status (all 9 states, verbatim) + the optional retry/turnSend details into display strings. */
export function deriveRunState(input: RunStateInput): RunStateView {
  return {
    status: input.status,
    retryLabel: input.retry ? formatRetryLabel(input.retry) : null,
    turnSendLabel: input.turnSend ? formatTurnSendLabel(input.turnSend) : null,
  };
}

// ---------------------------------------------------------------------------
// deriveSessionReferences
// ---------------------------------------------------------------------------

export interface SessionReferencesInput {
  sessionId: string;
  messages: readonly ChatMessage[];
  /** Only `sessionId` is read — accepts `chatSessions`'s `pendingPermissions` as-is. */
  pendingPermissions: readonly { sessionId: string }[];
}

export interface SessionReferencesView {
  pendingPermissionsCount: number;
  attachments: ContextSessionAttachmentFact[];
  mentions: string[];
}

/**
 * Session-scoped list facts: pending permission count filtered by session,
 * and every USER message's attachments + `@path` mentions flattened in
 * chronological order. Assistant/system/error messages never contribute —
 * "sent" means the user sent it (spec §4).
 */
export function deriveSessionReferences(input: SessionReferencesInput): SessionReferencesView {
  const pendingPermissionsCount = input.pendingPermissions.filter(
    (item) => item.sessionId === input.sessionId
  ).length;

  const attachments: ContextSessionAttachmentFact[] = [];
  const mentions: string[] = [];

  for (const message of input.messages) {
    if (message.role !== 'user') continue;
    for (const attachment of message.attachments ?? []) {
      attachments.push({
        kind: attachment.kind,
        mediaType: attachment.mediaType,
        ...(attachment.name ? { name: attachment.name } : {}),
      });
    }
    for (const block of message.blocks) {
      if (block.type !== 'text' || !block.text) continue;
      for (const chip of parseMentionChips(block.text)) {
        mentions.push(chip.path);
      }
    }
  }

  return { pendingPermissionsCount, attachments, mentions };
}

// ---------------------------------------------------------------------------
// reduceSessionRuntimeFacts (backs stores/sessionRuntimeFacts.ts)
// ---------------------------------------------------------------------------

/**
 * T-35: the Context panel's stderr excerpt. A ring, not a transcript — the
 * Host log keeps every line; this keeps the last `STDERR_CONTEXT_KEEP_LINES`
 * plus the running total so row ordinals stay honest after eviction.
 */
export interface SessionStderrFacts {
  /** Last N sanitized lines, oldest first. */
  lines: readonly string[];
  /** Lines seen this session (>= lines.length). */
  total: number;
}

/** Context-panel ring size for forwarded stderr lines. */
export const STDERR_CONTEXT_KEEP_LINES = 20;

/**
 * Bound on how many sessions may carry an stderr ring at once (review F6):
 * the per-session ring bounds lines, but nothing else ever removes a session
 * entry, so a long-running app accumulating sessions would grow without
 * limit. Eviction strips ONLY the `stderr` field of the oldest carrier.
 */
export const STDERR_SESSIONS_MAX = 12;

export interface SessionRuntimeFacts {
  /** T-35: absent until the first `session.stderr` event arrives. */
  stderr?: SessionStderrFacts;
  /**
   * U06-b: the last settled `usage.updated` for this session — one turn's
   * tokens/cost plus the session's context occupancy. `undefined` until the
   * first turn settles, which is also true after resuming an old session: Pi
   * reports occupancy on `turn_end`, so a reopened conversation has no
   * denominator to show until it next replies. That is a blank, never a zero.
   */
  usage?: PiUsagePayload;
  /**
   * T38-c: the running tool's own latest progress line, keyed by the call it
   * belongs to so a status can never outlive its tool. Absent means the tool
   * reported no text — which the Run surface renders as the tool name alone,
   * not as a blank second line.
   */
  activeToolStatus?: { toolCallId: string; status: string };
}

/** sessionId -> facts. */
export type SessionRuntimeFactsState = Record<string, SessionRuntimeFacts>;

export const initialSessionRuntimeFacts: SessionRuntimeFactsState = {};

interface SessionRuntimeFactsEvent {
  type: string;
  sessionId?: string;
  payload?: unknown;
}

/** Folds only live token estimates and stderr facts used by the Context surface. */
export function reduceSessionRuntimeFacts(
  prev: SessionRuntimeFactsState,
  event: SessionRuntimeFactsEvent
): SessionRuntimeFactsState {
  if (event.type === 'session.stderr') {
    return foldStderrLine(prev, event);
  }
  if (event.type === 'usage.updated') {
    return foldSettledUsage(prev, event);
  }
  if (event.type === 'tool.updated') {
    return foldActiveToolStatus(prev, event);
  }
  if (event.type === 'tool.completed') {
    return clearActiveToolStatus(prev, event);
  }
  if (event.type === 'session.status' || event.type === 'message.completed') {
    // A terminal status ends whatever tool was running, so both events retire
    // the tool's progress line.
    return clearActiveToolStatus(prev, event);
  }
  return prev;
}

/**
 * T38-c: keep the newest progress line the running tool published.
 *
 * Keyed by `toolCallId` so `clearActiveToolStatus` can refuse to clear a line
 * that belongs to a DIFFERENT call — tools run one after another inside a turn,
 * and a late `tool.completed` for the previous one would otherwise wipe the
 * line the current one just wrote.
 */
function foldActiveToolStatus(
  prev: SessionRuntimeFactsState,
  event: SessionRuntimeFactsEvent
): SessionRuntimeFactsState {
  const sessionId = event.sessionId;
  if (!sessionId) return prev;
  const payload =
    event.payload && typeof event.payload === 'object'
      ? (event.payload as Record<string, unknown>)
      : undefined;
  const status = payload?.status;
  const toolCallId = payload?.toolCallId;
  // An update carrying only `input` is not a status update; leaving the current
  // line alone is right, because the tool has not said anything new.
  if (typeof status !== 'string' || !status || typeof toolCallId !== 'string') return prev;
  const existing = prev[sessionId];
  if (
    existing?.activeToolStatus?.toolCallId === toolCallId &&
    existing.activeToolStatus.status === status
  ) {
    return prev;
  }
  return { ...prev, [sessionId]: { ...existing, activeToolStatus: { toolCallId, status } } };
}

/**
 * Drop the progress line once its tool is done. On `tool.completed` only for
 * the matching call; on a terminal `session.status`/`message.completed` for
 * whatever is left, since nothing is running any more.
 */
function clearActiveToolStatus(
  prev: SessionRuntimeFactsState,
  event: SessionRuntimeFactsEvent
): SessionRuntimeFactsState {
  const sessionId = event.sessionId;
  if (!sessionId) return prev;
  const existing = prev[sessionId];
  if (!existing?.activeToolStatus) return prev;
  if (event.type === 'tool.completed') {
    const payload =
      event.payload && typeof event.payload === 'object'
        ? (event.payload as Record<string, unknown>)
        : undefined;
    if (payload?.toolCallId !== existing.activeToolStatus.toolCallId) return prev;
  } else if (event.type === 'session.status') {
    const payload =
      event.payload && typeof event.payload === 'object'
        ? (event.payload as Record<string, unknown>)
        : undefined;
    const status = payload?.status;
    if (status !== 'idle' && status !== 'failed') return prev;
  }
  const { activeToolStatus: _cleared, ...rest } = existing;
  return { ...prev, [sessionId]: rest };
}

/**
 * T-35: append one forwarded stderr line, ring-capped. An empty or non-string
 * `line` is dropped whole — a blank row would be noise pretending to be a
 * fact. `total` keeps counting past the ring so `buildStderrRows`'s ordinals
 * stay truthful about eviction.
 */
function foldStderrLine(
  prev: SessionRuntimeFactsState,
  event: SessionRuntimeFactsEvent
): SessionRuntimeFactsState {
  const sessionId = event.sessionId;
  if (!sessionId) return prev;
  const payload =
    event.payload && typeof event.payload === 'object'
      ? (event.payload as Record<string, unknown>)
      : undefined;
  const line = payload?.line;
  if (typeof line !== 'string' || line === '') return prev;

  const existing = prev[sessionId];
  const previous = existing?.stderr;
  const lines = [...(previous?.lines ?? []), line].slice(-STDERR_CONTEXT_KEEP_LINES);
  const stderr: SessionStderrFacts = { lines, total: (previous?.total ?? 0) + 1 };
  if (previous) {
    // Existing carrier: in-place update, key position (= first-arrival order,
    // see below) unchanged, never any eviction churn.
    return { ...prev, [sessionId]: { ...existing, stderr } };
  }

  // NEW carrier: re-insert the entry at the END of the map, so that among
  // carriers, key order IS first-stderr-arrival order (review F6, round 2 —
  // plain insertion order is entry-CREATION order, and a `session.created`
  // long before the first stderr line put carriers out of order, evicting
  // the wrong one). Non-carrier entries interleave harmlessly — the filter
  // below never looks at them.
  const reordered: SessionRuntimeFactsState = { ...prev };
  delete reordered[sessionId];
  const next: SessionRuntimeFactsState = { ...reordered, [sessionId]: { ...existing, stderr } };

  // Enforce the carrier cap: the front of this list is the oldest carrier;
  // strip until the others fit beside the current one.
  const carriers = Object.keys(next).filter((id) => id !== sessionId && next[id].stderr);
  if (carriers.length <= STDERR_SESSIONS_MAX - 1) return next;
  for (const id of carriers.slice(0, carriers.length - (STDERR_SESSIONS_MAX - 1))) {
    const { stderr: _evicted, ...rest } = next[id];
    if (Object.keys(rest).length === 0) {
      delete next[id];
    } else {
      next[id] = rest;
    }
  }
  return next;
}

/**
 * U06-b: keep the last settled `usage.updated` for a session.
 *
 * Last, not accumulated: a Pi turn's usage is that turn's own bill, and a run
 * that calls tools settles several. Summing them would produce a number no
 * provider ever charged; the panel labels what it shows as the last turn.
 *
 * Anything that is not a settled Pi payload leaves `prev` untouched and
 * reference-identical — `readPiUsagePayload` owns that judgement.
 */
function foldSettledUsage(
  prev: SessionRuntimeFactsState,
  event: SessionRuntimeFactsEvent
): SessionRuntimeFactsState {
  const sessionId = event.sessionId;
  if (!sessionId) return prev;
  const usage = readPiUsagePayload(event.payload);
  if (!usage) return prev;
  return { ...prev, [sessionId]: { ...prev[sessionId], usage } };
}
