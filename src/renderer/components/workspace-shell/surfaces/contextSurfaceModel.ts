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

import { CLAUDE_CODE_AGENT, CODEX_AGENT } from '@shared/types/agentWire';
import type {
  CodexApprovalPolicy,
  CodexSandboxMode,
  SessionPermissionMode,
  SessionPermissionPolicy,
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
  /**
   * `undefined` = no active session (omit row); `null` = session exists but
   * the Host never reported a mode — renders the honest
   * 'Permission policy not reported' string, never a silently-assumed
   * 'default'.
   */
  permissionMode: SessionPermissionMode | null | undefined;
  /**
   * D48 S3 §5.2 — the per-agent posture, which is what a Codex session reports
   * (it has no `permissionMode` at all, so before this field its whole
   * Permission policy row simply vanished).
   *
   * Kept ALONGSIDE `permissionMode` rather than replacing it, because the wire
   * itself keeps both: `SessionCreatedEvent.payload` still carries the historic
   * `permissionMode` and a Host that predates the policy field sends only that
   * one. Same tri-state as the field above — `undefined` omits, `null` means
   * "session exists, nothing reported". When both are present this one wins
   * (`runtimeEvents.ts`'s own rule for the pair).
   */
  permissionPolicy?: SessionPermissionPolicy | null;
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

/**
 * D48 S3 §5.2 — codex's own vocabulary, kept VERBATIM on purpose.
 *
 * The Claude table above turns wire tokens into prose because `acceptEdits`
 * is not a phrase anyone says. These are the opposite case: `on-request` and
 * `danger-full-access` are the exact strings the user sees in codex's own docs
 * and config file, and "Full access" would read as a milder thing than the word
 * `danger` the vendor deliberately put in the token. The tables exist for the
 * exhaustiveness (a new enum member fails to compile until it is listed here,
 * which is also what makes them the validity sets below), not for translation.
 */
const CODEX_APPROVAL_LABELS: Record<CodexApprovalPolicy, string> = {
  untrusted: 'untrusted',
  'on-request': 'on-request',
  never: 'never',
};

const CODEX_SANDBOX_LABELS: Record<CodexSandboxMode, string> = {
  'read-only': 'read-only',
  'workspace-write': 'workspace-write',
  'danger-full-access': 'danger-full-access',
};

/** `null` = Host never reported a mode for this session — the ONLY honest string, never a guessed 'default'. */
function permissionPolicyLabel(mode: SessionPermissionMode | null): string {
  if (!mode) return 'Permission policy not reported';
  return PERMISSION_MODE_LABELS[mode] ?? mode;
}

/**
 * One row per agent shape, and codex's three dimensions stay three.
 *
 * Folding `approval × sandbox × network` down into a Claude `permissionMode`
 * would need a mapping nobody can write honestly: `never` + `read-only` is not
 * `dontAsk` (nothing is being skipped, everything is being refused) and
 * `on-request` + `danger-full-access` is not `default`. A summary line reports
 * all three, so the panel never claims a posture the runtime is not in.
 *
 * The narrowing is by KEY rather than by comparing `policy.agent` to the
 * exported constants: those are typed as the wide `AgentWireName` and cannot
 * narrow a discriminated union (same spelling as the shared guards).
 */
function permissionPolicyValue(policy: SessionPermissionPolicy): string {
  if ('permissionMode' in policy) {
    // Claude's arm renders through the SAME table as the legacy field, so a
    // policy-reporting Host and an old one produce byte-identical rows (C3).
    return permissionPolicyLabel(policy.permissionMode);
  }
  const approval = CODEX_APPROVAL_LABELS[policy.approvalPolicy] ?? policy.approvalPolicy;
  const sandbox = CODEX_SANDBOX_LABELS[policy.sandboxMode] ?? policy.sandboxMode;
  // Three states, not two. `networkAccess` is the one dimension the Host never
  // requests — it is read off the `thread/start` echo and is simply absent on a
  // resumed thread, whose result never carries the key [实测]. Rendering an
  // absent value as `off` is the same class of lie as guessing `default` for a
  // missing permission mode, and it is worse on `danger-full-access`, a tier
  // that has no network limit at all.
  const network =
    policy.networkAccess === undefined ? 'not reported' : policy.networkAccess ? 'on' : 'off';
  return `Approval: ${approval} · Sandbox: ${sandbox} · Network: ${network}`;
}

/**
 * The pair's precedence, in one place: a reported POLICY beats the historic
 * `permissionMode`, per `SessionCreatedEvent.payload.permissionPolicy`'s own
 * wire note ("absent = fall back to the permissionMode row"). Reversing these
 * two lines is what mutation ② tests.
 */
function permissionRowValue(
  policy: SessionPermissionPolicy | null,
  mode: SessionPermissionMode | null
): string {
  if (policy) return permissionPolicyValue(policy);
  return permissionPolicyLabel(mode);
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
  // Either carrier being present means this session has something to say about
  // its posture; only "no active session at all" (both `undefined`) omits the
  // row. A Codex session reports the policy alone, an old Host the mode alone.
  if (facts.permissionPolicy !== undefined || facts.permissionMode !== undefined) {
    rows.push({
      id: 'permission-policy',
      label: 'Permission policy',
      value: permissionRowValue(facts.permissionPolicy ?? null, facts.permissionMode ?? null),
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
 * limit. Eviction strips ONLY the `stderr` field of the oldest carrier —
 * `permissionMode` and `permissionPolicy` are different facts with their own
 * invariants and must not be collateral.
 */
export const STDERR_SESSIONS_MAX = 12;

export interface SessionRuntimeFacts {
  permissionMode?: SessionPermissionMode;
  /**
   * D48 S3 §5.2 — the per-agent posture echoed on `session.created` /
   * `session.resumed`. Independent of `permissionMode` above: a Claude session
   * may carry both, a Codex session only this one, and a Host that predates the
   * field only the other. Neither ever overwrites the other.
   */
  permissionPolicy?: SessionPermissionPolicy;
  /** T-35: absent until the first `session.stderr` event arrives. */
  stderr?: SessionStderrFacts;
  /**
   * D33: the Host's live, ESTIMATED output-token count for the turn
   * currently in flight (`usage.updated` events with `payload.interim ===
   * true`, `eventNormalizer.ts`'s `emitInterimUsage`). `undefined` = no
   * interim tick has landed for this session yet; `null` = a tick landed
   * earlier this session but the turn it belonged to is no longer in flight
   * (cleared on `session.status` idle/failed or on `message.completed` —
   * see `clearTurnTokensDisplay`). Both render the same way (no ↓ suffix);
   * the distinction only matters to this reducer's own idempotence checks.
   */
  turnTokensDisplay?: number | null;
}

/** sessionId -> facts. */
export type SessionRuntimeFactsState = Record<string, SessionRuntimeFacts>;

export const initialSessionRuntimeFacts: SessionRuntimeFactsState = {};

const VALID_PERMISSION_MODES = new Set<string>(Object.keys(PERMISSION_MODE_LABELS));
const VALID_CODEX_APPROVALS = new Set<string>(Object.keys(CODEX_APPROVAL_LABELS));
const VALID_CODEX_SANDBOXES = new Set<string>(Object.keys(CODEX_SANDBOX_LABELS));

function isSessionPermissionMode(value: unknown): value is SessionPermissionMode {
  return typeof value === 'string' && VALID_PERMISSION_MODES.has(value);
}

/**
 * D48 S3 §5.2 — the strict guard for the policy half of the pair.
 *
 * Strict means: the discriminant must be one of the two agents this build
 * knows, EVERY field of that arm must be present and inside its vocabulary, and
 * the other arm's fields must be absent. A widened `string` is refused for the
 * same reason `isSessionPermissionMode` refuses one — this value arrives as raw
 * JSON from the Host, and half-reading a posture is worse than reporting none:
 * the panel would state a constraint the session is not actually under.
 *
 * Lives here, next to its only consumer, on the same "guards follow consumers"
 * rule as `isSessionPermissionMode` directly above.
 */
function isSessionPermissionPolicy(value: unknown): value is SessionPermissionPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  if (raw.agent === CLAUDE_CODE_AGENT) {
    return (
      isSessionPermissionMode(raw.permissionMode) &&
      !('approvalPolicy' in raw) &&
      !('sandboxMode' in raw)
    );
  }
  if (raw.agent === CODEX_AGENT) {
    return (
      typeof raw.approvalPolicy === 'string' &&
      VALID_CODEX_APPROVALS.has(raw.approvalPolicy) &&
      typeof raw.sandboxMode === 'string' &&
      VALID_CODEX_SANDBOXES.has(raw.sandboxMode) &&
      // OPTIONAL, and only here: a Host that could not learn the dimension
      // omits the key (every resumed thread does), and refusing that payload
      // would throw away the two dimensions it DID verify. A key that is
      // present must still be a boolean — a widened `'false'` string would
      // render as `on`.
      (!('networkAccess' in raw) || typeof raw.networkAccess === 'boolean') &&
      !('permissionMode' in raw)
    );
  }
  return false;
}

/** Field-by-field, because the reducer's no-change identity check needs it. */
function samePermissionPolicy(
  a: SessionPermissionPolicy | undefined,
  b: SessionPermissionPolicy | undefined
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if ('permissionMode' in a) {
    return 'permissionMode' in b && a.permissionMode === b.permissionMode;
  }
  return (
    !('permissionMode' in b) &&
    a.approvalPolicy === b.approvalPolicy &&
    a.sandboxMode === b.sandboxMode &&
    a.networkAccess === b.networkAccess
  );
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
 *
 * D48 S3 adds `permissionPolicy` under both invariants, and one more of its
 * own: the two fields never overwrite each other. See the N4 note at the read
 * site below for the ordering this depends on.
 */
export function reduceSessionRuntimeFacts(
  prev: SessionRuntimeFactsState,
  event: SessionRuntimeFactsEvent
): SessionRuntimeFactsState {
  if (event.type === 'session.stderr') {
    return foldStderrLine(prev, event);
  }
  // D33: the live token estimate is written and cleared on three distinct
  // event types, none of which are `session.created`/`session.resumed` — so
  // these three checks must run BEFORE the narrowing guard below, or every
  // one of them would silently no-op through the `return prev` two lines down.
  if (event.type === 'usage.updated') {
    return foldInterimTokensDisplay(prev, event);
  }
  if (event.type === 'session.status' || event.type === 'message.completed') {
    return clearTurnTokensDisplay(prev, event);
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
  // ⚠️ N4 (承重, same shape as the D33 incident recorded ~20 lines above):
  // the policy MUST be read BEFORE the `permissionMode` guard below. A Codex
  // payload carries no `permissionMode` key at all, so it fails that guard and
  // returns — any policy handling placed after it is a silent no-op for the
  // one agent it exists to serve. The ordering is pinned by an assertion of its
  // own (C2), not by this comment.
  const permissionPolicy = isSessionPermissionPolicy(payload?.permissionPolicy)
    ? payload.permissionPolicy
    : undefined;
  const rawMode = payload?.permissionMode;
  const permissionMode = isSessionPermissionMode(rawMode) ? rawMode : undefined;
  // Nothing valid on either carrier: an old Host, a resume that dropped the
  // fields, or a garbage value. Keep whatever this session already reported —
  // erasing a known truth is the failure, not the missing update.
  if (!permissionPolicy && !permissionMode) {
    return prev;
  }

  const existing = prev[sessionId];
  const nextPolicy = permissionPolicy ?? existing?.permissionPolicy;
  const nextMode = permissionMode ?? existing?.permissionMode;
  if (
    existing &&
    samePermissionPolicy(existing.permissionPolicy, nextPolicy) &&
    existing.permissionMode === nextMode
  ) {
    return prev;
  }
  return {
    ...prev,
    [sessionId]: {
      ...existing,
      ...(nextPolicy ? { permissionPolicy: nextPolicy } : {}),
      ...(nextMode ? { permissionMode: nextMode } : {}),
    },
  };
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
 * D33: write the live token estimate off an interim `usage.updated` tick.
 * Anything else on this event type is a no-op — a missing sessionId, a
 * non-interim/settled result (the `messageMetadata.ts` guard exists for that
 * one, this reducer never even looks at it here), or a malformed payload
 * all leave `prev` untouched, reference-identical.
 */
function foldInterimTokensDisplay(
  prev: SessionRuntimeFactsState,
  event: SessionRuntimeFactsEvent
): SessionRuntimeFactsState {
  const sessionId = event.sessionId;
  if (!sessionId) return prev;
  const payload =
    event.payload && typeof event.payload === 'object'
      ? (event.payload as Record<string, unknown>)
      : undefined;
  if (payload?.interim !== true) return prev;
  const display = payload.turn_output_tokens_display;
  if (typeof display !== 'number') return prev;

  const existing = prev[sessionId];
  if (existing?.turnTokensDisplay === display) return prev;
  return { ...prev, [sessionId]: { ...existing, turnTokensDisplay: display } };
}

/**
 * D33: clear the live token estimate once the turn it described is no
 * longer in flight. Two triggers, either sufficient on its own:
 *  - `session.status` settling on `idle` or `failed` (any other status,
 *    e.g. `running`/`waiting_permission`, is a no-op);
 *  - `message.completed` — the Host's own control-flow comment
 *    (`eventNormalizer.ts` `emitInterimUsage`) documents the terminal order
 *    as `…message.completed → usage.updated(final) → session.completed →
 *    session.status`, so this fires before the settled `usage.updated` even
 *    arrives, and before a next turn's `running` status could strand a
 *    stale number on screen.
 * A session with no entry, or one whose `turnTokensDisplay` is already
 * `null`/unset, returns `prev` untouched — this must stay a true no-op or
 * every idle tick in a session with nothing to clear would re-notify
 * zustand subscribers for free.
 */
function clearTurnTokensDisplay(
  prev: SessionRuntimeFactsState,
  event: SessionRuntimeFactsEvent
): SessionRuntimeFactsState {
  const sessionId = event.sessionId;
  if (!sessionId) return prev;
  if (event.type === 'session.status') {
    const payload =
      event.payload && typeof event.payload === 'object'
        ? (event.payload as Record<string, unknown>)
        : undefined;
    const status = payload?.status;
    if (status !== 'idle' && status !== 'failed') return prev;
  }
  const existing = prev[sessionId];
  if (existing?.turnTokensDisplay == null) return prev;
  return { ...prev, [sessionId]: { ...existing, turnTokensDisplay: null } };
}
