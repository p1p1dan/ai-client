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

import type {
  SessionPermissionMode,
  SessionRetryInfo,
  SessionRuntimeStatus,
} from '@shared/types/runtimeEvents';
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
  /**
   * `undefined` = no active session (omit row); `null` = session exists but
   * the Host never reported a mode — renders the honest
   * 'Permission policy not reported' string, never a silently-assumed
   * 'default'.
   */
  permissionMode: SessionPermissionMode | null | undefined;
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

const PERMISSION_MODE_LABELS: Record<SessionPermissionMode, string> = {
  default: 'Default',
  acceptEdits: 'Accept edits',
  dontAsk: "Don't ask",
  bypassPermissions: 'Bypass permissions',
  plan: 'Plan',
};

/** `null` = Host never reported a mode for this session — the ONLY honest string, never a guessed 'default'. */
function permissionPolicyLabel(mode: SessionPermissionMode | null): string {
  if (!mode) return 'Permission policy not reported';
  return PERMISSION_MODE_LABELS[mode] ?? mode;
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
  if (facts.permissionMode !== undefined) {
    rows.push({
      id: 'permission-policy',
      label: 'Permission policy',
      value: permissionPolicyLabel(facts.permissionMode),
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

export interface SessionRuntimeFacts {
  permissionMode?: SessionPermissionMode;
  /** T-35: absent until the first `session.stderr` event arrives. */
  stderr?: SessionStderrFacts;
}

/** sessionId -> facts. */
export type SessionRuntimeFactsState = Record<string, SessionRuntimeFacts>;

export const initialSessionRuntimeFacts: SessionRuntimeFactsState = {};

const VALID_PERMISSION_MODES = new Set<string>(Object.keys(PERMISSION_MODE_LABELS));

function isSessionPermissionMode(value: unknown): value is SessionPermissionMode {
  return typeof value === 'string' && VALID_PERMISSION_MODES.has(value);
}

interface SessionRuntimeFactsEvent {
  type: string;
  sessionId?: string;
  payload?: unknown;
}

/**
 * Folds `session.created`/`session.resumed` events' `permissionMode` and
 * `session.stderr` lines into the per-session facts map. Every other event
 * type is a no-op — this is a narrow adjacent reducer, not a general Runtime
 * Event sink (mirrors `messageMetadata.ts`'s `reduceMessageMetadata` shape).
 *
 * Two invariants the T-14 assertion surface pins:
 *  - a payload missing (or invalid) `permissionMode` never overwrites an
 *    already-known value for that session (an old Host / a resume that
 *    dropped the field must not erase a previously-reported truth);
 *  - sessions are isolated — folding an event for session A never touches
 *    session B's entry.
 */
export function reduceSessionRuntimeFacts(
  prev: SessionRuntimeFactsState,
  event: SessionRuntimeFactsEvent
): SessionRuntimeFactsState {
  if (event.type === 'session.stderr') {
    return foldStderrLine(prev, event);
  }
  if (event.type !== 'session.created' && event.type !== 'session.resumed') {
    return prev;
  }
  const sessionId = event.sessionId;
  if (!sessionId) return prev;

  const payload =
    event.payload && typeof event.payload === 'object'
      ? (event.payload as Record<string, unknown>)
      : undefined;
  const permissionMode = payload?.permissionMode;
  if (!isSessionPermissionMode(permissionMode)) {
    return prev;
  }

  const existing = prev[sessionId];
  if (existing?.permissionMode === permissionMode) {
    return prev;
  }
  return { ...prev, [sessionId]: { ...existing, permissionMode } };
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
  return { ...prev, [sessionId]: { ...existing, stderr } };
}
