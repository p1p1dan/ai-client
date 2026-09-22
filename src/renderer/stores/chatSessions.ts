import type { AgentWireName } from '@shared/types/agentWire';
import type {
  PermissionAutoReason,
  PermissionDecisionId,
  PermissionDetail,
  PermissionGrantScope,
  PermissionRequestAction,
  PermissionRequestKind,
  QuestionItem,
  RuntimeEvent,
  SessionRecoveryNote,
  SessionRetryInfo,
  SessionRuntimeStatus,
} from '@shared/types/runtimeEvents';
import {
  HISTORY_MESSAGE_ID_PREFIX,
  type HistoryAttachment,
  type HistoryMessage,
  type HistoryNotice,
} from '@shared/types/sessionHistory';
import { create } from 'zustand';
// Leaf module (no imports of its own): the permission-activity record shape and
// its merge rule, shared with the row that renders it so the store cannot fold
// a decision the view would describe differently.
import {
  mergePermissionActivity,
  type PermissionActivityRecord,
} from '@/components/chat/permissionActivityRow';
// Leaf module (no imports of its own) on purpose: importing the hook module
// `sessionIndex/useSessionIndex.ts` here would close a cycle back onto this
// store. Read by the `sendMessage` ghost-session guard below.
import { isSessionDismissed } from '@/components/chat/sessionIndex/dismissedSessions';
import { uniqueId } from '@/lib/uniqueId';
// Leaf module as well (shared-types import only) — see its header for the
// replay-coverage rules the `session.history` reducer delegates to, and for
// the resume snapshot registry that bounds which messages a replay may fold.
import {
  hasMatchingResumeSnapshot,
  mergeReplayedHistory,
  snapshotResumeCandidates,
  takeResumeSnapshot,
} from './historyReplayMerge';
import { usePendingUserMessagesStore } from './pendingUserMessages';
// Refcounted fan-out over preload's single `chat:runtimeEvent` IPC listener —
// see its header for why every renderer subscriber shares one.
import { subscribeRuntimeEvent } from './runtimeEventBus';
import { isRecoveryEvent, nextSessionActivity, type SessionActivity } from './sessionActivity';
import { isSessionRetired } from './sessionRetirement';

export type WorkspaceKind = 'main' | 'worktree' | 'remote' | 'temp';

/**
 * Attachment accepted by sendMessage (C-13 protocol; T-18 Composer paste).
 * kind=image: data is base64; kind=text: data is the raw text content.
 */
export interface ChatSendAttachment {
  kind: 'image' | 'text';
  mediaType: string;
  data: string;
  name?: string;
}

export type ChatBlockType =
  | 'text'
  | 'thinking'
  | 'tool_call'
  | 'tool_result'
  | 'permission_request'
  /**
   * T08-b: a gate the pi permission plugin RESOLVED, as opposed to one it is
   * asking about. Never answerable — the plugin asks through the Extension UI
   * modal and broadcasts these purely so the transcript can record what was
   * decided, including the `policy_allow` decisions nobody was asked about.
   */
  | 'permission_activity'
  | 'question';

export interface ChatProject {
  id: string;
  name: string;
}

export interface ChatWorkspace {
  id: string;
  projectId: string;
  name: string;
  kind: WorkspaceKind;
  path: string;
  /**
   * Actual git branch checked out at `path` when known (T-26 / D21-A: the
   * sidebar branch chip shows the real branch for main worktrees too, so
   * "Main" as a display name is not enough). Absent for temp/remote
   * workspaces, detached HEAD, and while the worktree list is loading —
   * consumers must hide the chip instead of guessing a branch name.
   */
  branch?: string;
  /**
   * True when `worktree.list` succeeded for this repo (T-27) — gates the
   * Composer target bar's branch/worktree dropdown (`shouldShowBranchSelect`).
   * Absent means unknown or non-git; only `=== true` shows the branch UI.
   */
  gitEnabled?: boolean;
}

export interface ChatSession {
  id: string;
  projectId: string;
  workspaceId: string;
  title: string;
  status: SessionRuntimeStatus;
  updatedAt: number;
  /**
   * The agent's own resume handle when known — a Claude Code session id, a
   * Codex threadId, or whatever the next runtime issues. Opaque: only
   * interpretable together with `agent`, and never dispatched on by shape.
   */
  runtimeIdentity?: string;
  /**
   * S2 (b): which runtime this session is bound to. A session is bound for
   * life — switching agents means forking a new session, because the two sides
   * share neither reader, id space, nor runtimeIdentity semantics.
   *
   * Genuinely optional, and it stays that way. `mergeSessionIndex` is the ONE
   * place a missing value becomes a binding, but it only materializes rows it
   * builds FROM the index: a live-only session (created in this run, never
   * sent, so it has no index entry at all) is pushed through its safety net
   * untouched and keeps `agent: undefined` for as long as it stays unsent.
   * Materializing there too would be a second default and would rebuild every
   * live row's object on every index refresh, for a value `sessionAgent()`
   * already answers.
   *
   * So: NEVER read this field directly. Every consumer goes through
   * `sessionAgent(session)`, which is the single place that knows what an
   * unset binding means — writing `session.agent ?? '…'` at a call site
   * creates exactly the second default this arrangement exists to prevent.
   */
  agent?: AgentWireName;
  /**
   * U13 (D04, optional-field addition): this chat has no project folder — it
   * runs in the isolated scratch directory named here, which Main allocated
   * for it (U05). Set from the index row's `unbound` marker, by
   * `mergeSessionIndex` (the restart path) and by
   * `materializeIndexedPiChatSession` (session-index-02: forking an unbound
   * chat produces such a row mid-run, and it has no workspace to attach to
   * either); a live unbound chat created in this run has no index row yet and
   * is recognized the way it always was (`resolveActiveTarget().cwd` is null).
   *
   * The path travels with the session because it is the one thing no other
   * renderer state can supply after a restart: a scratch directory is
   * deliberately not a `ChatWorkspace`, so resume — which needs an exact
   * `workspacePath`, checked against the index by Main — would otherwise have
   * nothing to send.
   */
  unbound?: { workspacePath: string };
  /**
   * a1 (2026-07-30 net-visibility batch, optional-field addition): the CLI's
   * own transport-retry loop, when session.status last carried one. Cleared
   * (set back to undefined) on every session.status WITHOUT a retry payload
   * and on every terminal event — see upsertSessionStatus.
   */
  retry?: SessionRetryInfo;
  /**
   * T034 (session-02, optional-field addition): the session file was repaired
   * when this session was opened, and these lines were dropped from it.
   *
   * Sticky, which is exactly where it differs from `retry`: `retry` describes
   * the turn happening right now and is cleared by the next status without one,
   * while this describes damage the file already took. Clearing it on the next
   * status would blank it within milliseconds of the first send.
   */
  recovery?: SessionRecoveryNote;
  activity?: SessionActivity;
  runtimeError?: string;
  /**
   * The machine-readable half of `runtimeError`, straight off
   * `SessionTerminalEvent.payload.errorCode` (T066).
   *
   * Added 2026-09-21 for the failed-card's reason line: the sentence alone
   * tells a reader what the provider said, and the user's report is that this
   * is not enough to know WHY the turn stopped — 「tool loop exceeded 64
   * assistant turns」 and 「terminated」 are a self-explanatory ceiling and a
   * cut connection respectively, and nothing on screen said which was which.
   *
   * Carried BESIDE `runtimeError` rather than folded into it because the two
   * have different jobs: the sentence is evidence for the user to read and
   * forward (`sessionFailure.ts` still prints it verbatim), the code is what
   * this app branches on. A single prefixed string would have made the card
   * parse text again, which is the mistake `modelMissingError.ts` documents.
   *
   * Absent on the paths that write `runtimeError` without a code — an IPC-level
   * catch, or a runtime that predates the field. The card then falls back to
   * its "unknown reason" wording, which offers Continue.
   */
  runtimeErrorCode?: string;
}

export interface ChatBlock {
  id: string;
  type: ChatBlockType;
  text?: string;
  /**
   * T023: set only when `text` is copy THIS APP wrote into the transcript.
   *
   * `text` stays the English rendering and is what every existing surface
   * paints; a surface that wants the user's language runs `notice.key` through
   * `t()` with `notice.params` instead. Model output never carries it.
   */
  notice?: HistoryNotice;
  toolCallId?: string;
  toolName?: string;
  toolInput?: unknown;
  toolOk?: boolean;
  toolOutput?: unknown;
  permissionId?: string;
  toolDescription?: string;
  resolved?: boolean;
  allowed?: boolean;
  /** S2 (c): what the permission card asks about. undefined = a plain tool call. */
  permissionKind?: PermissionRequestKind;
  /**
   * T023: which everyday action the gate is about, as an id the card words.
   *
   * Separate from `toolDescription` on purpose — that one carries prose the
   * AGENT wrote and is shown verbatim, this one is our own copy and is
   * translated. One field for both is how Chinese reached English installs.
   */
  permissionAction?: PermissionRequestAction;
  /** S2 (c): exec command / file-change diffs rendered in the card body. */
  permissionDetail?: PermissionDetail;
  /** S2 (c): buttons offered. undefined = the historical Allow / Deny pair. */
  permissionDecisions?: PermissionDecisionId[];
  /**
   * What "Allow for session" on this card would remember — a directory with its
   * subdirectories, or a command prefix. Absent when the grant is still the
   * exact call, or when the backend does not report it.
   */
  permissionGrantScope?: PermissionGrantScope;
  /** S2 (c): which button settled it, when richer than the `allowed` boolean. */
  permissionDecision?: PermissionDecisionId;
  /** S2 (c): set when the client answered without asking anyone. */
  permissionAutoReason?: PermissionAutoReason;
  /** S2 (c): offered decisions this build could not model and dropped. */
  omittedDecisionCount?: number;
  /**
   * Wall-clock ms after which the asker stops waiting and the gate denies.
   *
   * Absolute rather than a duration: the card re-renders on every tick and a
   * duration would have to be re-based against an arrival time nobody kept.
   * Derived once here from the event's own timestamp, so a replayed history
   * shows a deadline in the past rather than a fresh two minutes.
   */
  permissionExpiresAt?: number;
  /** T08-b: set on `permission_activity` blocks only — the gate and its outcome. */
  permissionActivity?: PermissionActivityRecord;
  questionId?: string;
  questions?: QuestionItem[];
  questionOutcome?: 'answered' | 'cancelled' | 'rejected';
  /**
   * Opaque key -> answer. S2 (C8): mixed key space — Claude rows are keyed by
   * question text, Codex rows by `QuestionItem.id`. Replay must not look a
   * question up by its text.
   */
  questionAnswers?: Record<string, string>;
  questionResponse?: string;
}

/** Read-only attachment metadata echoed on a user message (round-2 P0). Mirrors
 * `MessageAttachmentMeta` — no `data`, this is display-only. */
export interface ChatMessageAttachment {
  kind: 'image' | 'text';
  mediaType: string;
  name?: string;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system' | 'error';
  blocks: ChatBlock[];
  /** Pi history leaf ended before a complete assistant response was saved. */
  incomplete?: boolean;
  stopReason?: string;
  /** Exact Pi session entry id. Present only on persisted Pi history rows. */
  entryId?: string;
  /**
   * Round-2 P0 (optional-field addition, red-line discipline): user turn's
   * attachment metadata, when the turn carried any. Set once at
   * `message.started`, never mutated after.
   */
  attachments?: ChatMessageAttachment[];
  /**
   * Epoch ms this message was DATED BY THE HISTORY FILE — present only on
   * replayed rows, never on a live echo (same optional-field discipline as
   * `attachments` above).
   *
   * It exists because the live timing registry (`useMessageMetadata`) is
   * in-memory and per-mount: it holds the turns this window watched run and
   * nothing else, so every replayed turn had no clock at all. That was
   * invisible until decision 034 made the process fold head report the clock
   * and nothing else, at which point replayed turns rendered a head with no
   * text (2026-09-22 field report 「现在折叠头和尾栏都没了」).
   *
   * ⚠️ This is a COARSER instrument than the metadata registry and must not be
   * mistaken for it. Pi dates an entry when it writes it, so on an assistant
   * row this is a completion instant and there is no matching start — which is
   * why `turnTiming.ts` feeds it in as `completedAt` only and takes the turn's
   * ORIGIN from the user row's own stamp. A replayed turn therefore reports
   * prompt→reply wall clock, not the assistant message's own span.
   */
  timestamp?: number;
}

interface PendingPermission {
  sessionId: string;
  permissionId: string;
  messageId: string;
  /**
   * Gate progress, carried by `permission.requested` and kept ON THE QUEUE
   * ENTRY rather than on the `permission_request` block.
   *
   * The distinction is the point: a block is transcript — it is re-read every
   * time the conversation is reopened — while "the 2nd of 5 cards the gate
   * currently knows about" is true for as long as the gate is open and
   * meaningless afterwards. Written into the block it would freeze into
   * history and label a settled request with a count nothing can explain.
   *
   * Both are optional because the producer is: a backend that does not
   * serialize (the legacy one) and an older worker send neither, and the dock
   * then shows no progress instead of inventing one.
   */
  queuePosition?: number;
  /**
   * How many requests the gate knew about when this card was raised — this one
   * plus the ones still queued behind it. NOT a promise: the queue is fed while
   * the user reads, so the next card may report a larger depth. See
   * `PermissionRequestedEvent.payload.queueDepth`.
   */
  queueDepth?: number;
}

interface PendingQuestion {
  sessionId: string;
  questionId: string;
  messageId: string;
}

export interface ChatSessionsState {
  projects: ChatProject[];
  workspaces: ChatWorkspace[];
  sessions: ChatSession[];
  /** Timeline messages bucketed by sessionId (C-08b): delta application and
   *  consumer selectors touch one bucket, never the whole message set. */
  messages: Record<string, ChatMessage[]>;
  activeSessionId: string | null;
  recentSessionIds: string[];
  /**
   * All permission prompts the Host still has parked, in arrival order.
   * Concurrent tool calls park several at once (SDK canUseTool is
   * concurrent), so this must never collapse to a single slot: whoever
   * answers card N must not clear card M's ability to answer, and must not
   * send M's id.
   */
  pendingPermissions: PendingPermission[];
  /**
   * Every question the worker still has parked, in arrival order — same shape,
   * and the same rule, as `pendingPermissions` above.
   *
   * chat-event-01: this used to be ONE slot that `question.requested`
   * overwrote. Tool calls in a turn run in parallel and the worker's own
   * question map is keyed by id, so a second `ask` took the first card off
   * screen: the dock renders only what is parked here, the timeline draws
   * nothing for an unresolved question, and the displaced promise then had
   * nothing left to settle it short of the turn's own abort — the turn hung
   * with no card anywhere and the user's only way out was Stop.
   */
  pendingQuestions: PendingQuestion[];
  /** Sessions already registered with Agent Host. */
  hostBoundSessionIds: string[];
  /**
   * H/18 S3: sessions whose LAST TURN ENDED while the user was looking at some
   * other session — the sidebar's "there is something here you have not seen".
   *
   * Only terminal-by-itself events add to this (`session.completed`,
   * `session.failed`). `session.stopped` deliberately does not: the user
   * pressed stop, so they already know how it ended.
   *
   * Read means ACTIVATED, not rendered: `selectSession` is the single place an
   * id leaves this list, so a row cannot clear itself just by scrolling past.
   * The active session is never added in the first place, which is why there is
   * no "mark read on arrival" path to keep in step with it.
   */
  unreadSessionIds: string[];
  runtimeReady: boolean;
  lastError: string | null;
  /** Non-fatal per-session history read errors, keyed by sessionId. Formatted `${code}: ${message}`. */
  historyErrors: Record<string, string>;
  historyPagination?: Record<
    string,
    { nextOffset: number; hydratedCount: number; totalCount: number; hasMore: boolean }
  >;
  /** Latest Main-owned active-branch generation observed for each Pi session. */
  historyBranchRevisions?: Record<string, number>;

  /**
   * D08 — type-only widening to `string | null` on this red-line store. No new
   * field and no behaviour change: `activeSessionId` has always been nullable
   * and `set` already accepted null at runtime; the parameter simply refused to
   * say so. Closing the last session tab needs to land back on the welcome
   * state, and the alternative — leaving a session active with no tab — renders
   * a conversation the tab strip does not admit exists.
   */
  selectSession: (sessionId: string | null) => void;
  /**
   * D48 S1 — approved ADDITIVE change to this red-line store (no new state
   * field: `ChatSession.agent` has existed since S2 (b)).
   *
   * The zero-turn agent picker's only write. It sets a DRAFT binding on a
   * session that has not been materialized yet, and refuses on anything that
   * has — switching the agent of a session that already owns a resume handle
   * would hand that handle to a runtime which never issued it.
   *
   * `sendAttempted` is an explicit argument rather than something read from
   * here because no store holds it: it is `ChatWorkspace`'s own sticky
   * `useState` latch, set the instant `runSend` commits and several awaits
   * before `hostBoundSessionIds` or `runtimeIdentity` catch up. Without it the
   * "you cannot repoint a session whose create IPC is in flight" rule would
   * live entirely in the composer's `disabled` prop.
   *
   * Returns FALSE ONLY WHEN REFUSED — no such session, or the binding is
   * already settled. True covers both a write and a re-selection of the value
   * already held; the two are deliberately not distinguished. `sessions` stays
   * referentially identical in every case except an actual change.
   *
   * This does NOT materialize anything: `mergeSessionIndex` remains the one
   * place a missing binding becomes a persisted one. A user's explicit choice
   * is not a default, and an unsent live-only session has no index entry for
   * it to become a second default in.
   */
  sendMessage: (text: string, attachments?: ChatSendAttachment[]) => Promise<void>;
  stopActiveSession: () => Promise<void>;
  /**
   * F5 — answer one parked question.
   *
   * `questionId` names WHICH one. It is optional only for the caller that has
   * no card in hand (fall back to the oldest parked question); anything drawing
   * a card passes the id it drew, because `pendingQuestions` can hold several
   * at once (chat-event-01) and answering by position would send the answer to
   * the wrong question the moment one of them settles out of order. The session
   * id is never an argument — it comes from the parked entry — so no caller can
   * answer into a session the user is not looking at.
   *
   * Resolves `false` (without touching `lastError`) when nothing is parked
   * under that id or the worker says it has already settled — a stale click,
   * not a failure — and `false` with `lastError` set when the IPC call throws,
   * so the card can unlock its submitting state instead of staying submitted
   * forever.
   *
   * `cancel` is the card's Skip. It is NOT a refusal: the tool tells the model
   * to pick a default and say which one, so the turn continues either way.
   */
  respondQuestion: (payload: {
    questionId?: string;
    answers?: Record<string, string>;
    response?: string;
    cancel?: boolean;
  }) => Promise<boolean>;
  /** Subscribe to Host Runtime Events; returns unsubscribe. */
  initRuntime: () => () => void;
}

const DEMO_PROJECT: ChatProject = { id: 'project-demo', name: 'demo' };

// Empty path on purpose: the demo tree is a UI placeholder until the T-01
// sync bridge (useSyncChatWorkspaceTree) delivers real repositories. It used
// to carry a developer-machine literal ('D:/Code/projects/ai-client'), which
// silently became the agent cwd on any machine where the bridge had no repo
// data — every send then died in spawn with "cli.js exists but failed to
// launch". Composer/resume refuse to run against an empty path instead.
const DEMO_WORKSPACES: ChatWorkspace[] = [
  {
    id: 'ws-main',
    projectId: DEMO_PROJECT.id,
    name: 'Main',
    kind: 'main',
    path: '',
  },
  {
    id: 'ws-worktree',
    projectId: DEMO_PROJECT.id,
    name: 'feat/openchamber-chat-refactor',
    kind: 'worktree',
    path: '',
  },
];

const DEMO_SESSIONS: ChatSession[] = [
  {
    id: 'session-live',
    projectId: DEMO_PROJECT.id,
    workspaceId: 'ws-main',
    title: 'Live Agent Host',
    status: 'idle',
    updatedAt: Date.now(),
  },
  {
    id: 'session-welcome',
    projectId: DEMO_PROJECT.id,
    workspaceId: 'ws-main',
    title: 'Welcome',
    status: 'idle',
    updatedAt: Date.now() - 86_400_000,
  },
];

const INITIAL_MESSAGES: Record<string, ChatMessage[]> = {
  'session-welcome': [
    {
      id: 'msg-seed-1',
      sessionId: 'session-welcome',
      role: 'assistant',
      blocks: [
        {
          id: 'block-seed-1',
          type: 'text',
          text: 'OpenChamber Workspace Shell is wired to the real Agent Host. Select “Live Agent Host” and send a message.',
        },
      ],
    },
  ],
};

function upsertSessionStatus(
  sessions: ChatSession[],
  sessionId: string,
  status: SessionRuntimeStatus,
  // a1: every call site except the 'session.status' case below omits this,
  // which explicitly clears any previously stored retry — correct, since
  // every one of those call sites (waiting_permission/question, completed,
  // failed, stopped) is itself proof the CLI's retry loop is no longer the
  // session's current state.
  retry?: SessionRetryInfo
): ChatSession[] {
  return sessions.map((session) =>
    session.id === sessionId ? { ...session, status, retry, updatedAt: Date.now() } : session
  );
}

function upsertMessage(bucket: ChatMessage[], message: ChatMessage): ChatMessage[] {
  const index = bucket.findIndex((item) => item.id === message.id);
  if (index === -1) {
    return [...bucket, message];
  }
  const next = [...bucket];
  next[index] = message;
  return next;
}

/**
 * Drop one parked prompt; returns an empty patch when nothing matched, so
 * unrelated events never hand consumers a fresh array identity (perf: keeps
 * `session.completed`, which fires every turn, from forcing a full timeline
 * re-render when nothing was pending).
 */
function withoutPermission(
  state: ChatSessionsState,
  sessionId: string,
  permissionId: string
): Pick<ChatSessionsState, 'pendingPermissions'> | Record<string, never> {
  const next = state.pendingPermissions.filter(
    (item) => !(item.sessionId === sessionId && item.permissionId === permissionId)
  );
  if (next.length === state.pendingPermissions.length) return {};
  return { pendingPermissions: next };
}

/**
 * H/18 S3 — add one session to `unreadSessionIds`, or return the list
 * untouched.
 *
 * Same array-identity rule as {@link withoutPermission}: a turn ending on the
 * session the user is already reading must not hand every subscriber a fresh
 * array, or `session.completed` — which fires every single turn — would
 * re-render the whole sidebar for a fact that did not change.
 */
function markSessionUnread(state: ChatSessionsState, sessionId: string): string[] {
  if (state.activeSessionId === sessionId || state.unreadSessionIds.includes(sessionId)) {
    return state.unreadSessionIds;
  }
  return [...state.unreadSessionIds, sessionId];
}

/**
 * Drop one parked question. Same empty-patch identity rule as
 * {@link withoutPermission}, and the same keying: an answer retires exactly the
 * card it names, so answering the second question first leaves the first one
 * parked and answerable instead of clearing the whole dock.
 */
function withoutQuestion(
  state: ChatSessionsState,
  sessionId: string,
  questionId: string
): Pick<ChatSessionsState, 'pendingQuestions'> | Record<string, never> {
  const next = state.pendingQuestions.filter(
    (item) => !(item.sessionId === sessionId && item.questionId === questionId)
  );
  if (next.length === state.pendingQuestions.length) return {};
  return { pendingQuestions: next };
}

/**
 * chat-event-02 — bring a session back out of `waiting_permission` /
 * `waiting_question` once the gate that parked it has opened.
 *
 * Those two statuses are pushed by this reducer alone, and nothing on the
 * producer side ever takes them back: the projector emits `session.status`
 * only at start / retry / recovery / finish. So from the moment the user
 * clicked Allow, the Run panel kept reading "Waiting for approval" — and, worse
 * than the stale wording, it stops deriving any tool/thinking detail while the
 * status is a waiting one, for the entire rest of the turn.
 *
 * `running` is the only honest answer here, and it is reachable only FROM a
 * waiting status: a turn that already ended is `idle` / `failed` by now, and
 * this leaves those alone rather than resurrecting them. When this session is
 * still parked on something else — the other queue, or a second card in the
 * same one — that remaining wait keeps the status instead.
 *
 * `settled` names the id this event is retiring, because the queues are read
 * pre-clear: whichever branch calls this has not applied its own patch yet.
 */
function afterGateResolved(
  state: ChatSessionsState,
  sessionId: string,
  settled: { permissionId?: string; questionId?: string }
): Pick<ChatSessionsState, 'sessions'> | Record<string, never> {
  const session = state.sessions.find((item) => item.id === sessionId);
  if (!session) return {};
  if (session.status !== 'waiting_permission' && session.status !== 'waiting_question') return {};

  const stillPermission = state.pendingPermissions.some(
    (item) => item.sessionId === sessionId && item.permissionId !== settled.permissionId
  );
  const stillQuestion = state.pendingQuestions.some(
    (item) => item.sessionId === sessionId && item.questionId !== settled.questionId
  );
  // Same identity rule as the queue helpers: no change, no patch, so a session
  // row that did not move does not re-render every subscriber.
  if (session.status === 'waiting_permission' ? stillPermission : stillQuestion) return {};

  const status: SessionRuntimeStatus = stillQuestion
    ? 'waiting_question'
    : stillPermission
      ? 'waiting_permission'
      : 'running';
  return { sessions: upsertSessionStatus(state.sessions, sessionId, status) };
}

/** Drop every parked prompt of one session (terminal events). Same identity rule as {@link withoutPermission}. */
function withoutSessionPermissions(
  state: ChatSessionsState,
  sessionId: string
): Pick<ChatSessionsState, 'pendingPermissions'> | Record<string, never> {
  const next = state.pendingPermissions.filter((item) => item.sessionId !== sessionId);
  if (next.length === state.pendingPermissions.length) return {};
  return { pendingPermissions: next };
}

function withBucket(
  state: ChatSessionsState,
  sessionId: string,
  bucket: ChatMessage[]
): Record<string, ChatMessage[]> {
  return { ...state.messages, [sessionId]: bucket };
}

/**
 * Maps one HistoryBlock to a ChatBlock using the same field usage as the live
 * runtime branches (tool.started / tool.completed / thinking.delta).
 */
function mapHistoryBlock(block: HistoryMessage['blocks'][number]): ChatBlock | null {
  switch (block.type) {
    case 'text':
      return {
        id: block.id,
        type: 'text',
        text: block.text,
        // T023: carried, not resolved. `text` already holds the English
        // rendering, so a block whose notice nobody reads still paints a whole
        // sentence; the notice only lets the surface swap in the user's
        // language. Absent on every block a model produced, which is the
        // point — that text is content and must never go near a dictionary.
        ...(block.notice ? { notice: block.notice } : {}),
      };
    case 'thinking':
      return { id: block.id, type: 'thinking', text: block.text };
    case 'tool_call':
      return {
        id: block.id,
        type: 'tool_call',
        toolCallId: block.toolCallId,
        toolName: block.name,
        toolInput: block.input,
      };
    case 'tool_result':
      return {
        id: block.id,
        type: 'tool_result',
        toolCallId: block.toolCallId,
        toolOk: block.ok,
        toolOutput:
          block.patch || block.review
            ? {
                content: [{ type: 'text', text: block.output ?? '' }],
                details: {
                  ...(block.patch ? { patch: block.patch } : {}),
                  ...(block.review ? { review: block.review } : {}),
                },
              }
            : block.output,
        text: block.error,
      };
    default:
      return null;
  }
}

/**
 * 2026-08-10: rebuilt-history attachment metadata -> the same
 * `ChatMessageAttachment` the live `message.started` path produces, so the
 * timeline renders one chip branch for both. Fields are copied explicitly
 * rather than spread: the wire shape must not leak unknown keys into store
 * state just because a newer Host added some.
 */
function mapHistoryAttachment(attachment: HistoryAttachment): ChatMessageAttachment {
  return {
    kind: attachment.kind,
    mediaType: attachment.mediaType,
    ...(attachment.name ? { name: attachment.name } : {}),
  };
}

function mapHistoryMessageToChatMessage(
  sessionId: string,
  historyMessage: HistoryMessage
): ChatMessage {
  const blocks = historyMessage.blocks
    .map(mapHistoryBlock)
    .filter((block): block is ChatBlock => block !== null);
  if (historyMessage.incomplete && blocks.length === 0) {
    blocks.push({
      id: `${historyMessage.id}:interrupted`,
      type: 'text',
      text: 'Response interrupted before any assistant content was saved.',
    });
  }
  return {
    id: historyMessage.id,
    sessionId,
    role: historyMessage.role,
    blocks,
    ...(historyMessage.incomplete ? { incomplete: true } : {}),
    ...(historyMessage.stopReason ? { stopReason: historyMessage.stopReason } : {}),
    ...(historyMessage.entryId ? { entryId: historyMessage.entryId } : {}),
    // Absent unless the history actually carried attachments — keeps exact-shape
    // assertions on attachment-free messages untouched (same rule as
    // `message.started`).
    ...(historyMessage.attachments?.length
      ? { attachments: historyMessage.attachments.map(mapHistoryAttachment) }
      : {}),
    // Absent when Pi could not date the entry, for the same reason as above:
    // an exact-shape assertion on an undated row must stay untouched, and a
    // fabricated stamp is exactly what A07 :2399 forbids.
    ...(typeof historyMessage.timestamp === 'number'
      ? { timestamp: historyMessage.timestamp }
      : {}),
  };
}

function mergeOlderHistoryPage(
  current: readonly ChatMessage[],
  older: readonly ChatMessage[]
): ChatMessage[] {
  const existingIds = new Set(current.map((message) => message.id));
  const prepend = older.filter((message) => !existingIds.has(message.id));
  return prepend.length === 0 ? [...current] : [...prepend, ...current];
}

function appendTextBlock(
  message: ChatMessage,
  blockId: string,
  text: string,
  blockType: 'text' | 'thinking' = 'text'
): ChatMessage {
  const blocks = [...message.blocks];
  const blockIndex = blocks.findIndex((block) => block.id === blockId);

  if (blockIndex === -1) {
    blocks.push({ id: blockId, type: blockType, text });
  } else {
    const block = blocks[blockIndex];
    blocks[blockIndex] = {
      ...block,
      text: `${block.text ?? ''}${text}`,
    };
  }

  return { ...message, blocks };
}

/**
 * T101 — "would rewriting `toolInput` with this change anything?"
 *
 * Reference equality used to be the whole test, which was right while the only
 * producer was `tool_execution_update` re-sending the very same `args` object.
 * The streaming pass builds a FRESH summary object per event, so every one of
 * them compared unequal and re-rendered the timeline to move a byte counter
 * that had not moved. One level of field comparison is enough for both
 * producers: a summary is flat scalars, and a settled argument set arrives once.
 *
 * Deliberately shallow. A deep compare here would walk an 8 MiB `content`
 * string on every frame, which is the cost this function exists to avoid.
 */
function sameToolInput(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (
    typeof left !== 'object' ||
    typeof right !== 'object' ||
    left === null ||
    right === null ||
    Array.isArray(left) ||
    Array.isArray(right)
  ) {
    return false;
  }
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => Object.is(a[key], b[key]));
}

export function applyRuntimeEvent(
  state: ChatSessionsState,
  event: RuntimeEvent
): Partial<ChatSessionsState> {
  const patch = applyRuntimeEventCore(state, event);
  const current = state.sessions.find((session) => session.id === event.sessionId);
  if (!current) return patch;
  const needsMessage = [
    'message.delta',
    'thinking.delta',
    'thinking.started',
    'tool.started',
    'tool.completed',
    'question.requested',
  ].includes(event.type);
  const accepted = !needsMessage || patch.messages !== undefined;
  const activity = accepted ? nextSessionActivity(current.activity, event) : current.activity;
  const recovered = accepted && isRecoveryEvent(event);
  const runtimeError =
    event.type === 'session.failed'
      ? (event.payload?.error ?? 'Session failed')
      : recovered
        ? undefined
        : current.runtimeError;
  // Cleared together with `runtimeError` for the same reason: a code with no
  // sentence beside it would describe a failure the user can no longer read,
  // and a later recovery is what makes both stale at once.
  const runtimeErrorCode =
    event.type === 'session.failed'
      ? event.payload?.errorCode
      : recovered
        ? undefined
        : current.runtimeErrorCode;
  if (
    activity !== current.activity ||
    runtimeError !== current.runtimeError ||
    runtimeErrorCode !== current.runtimeErrorCode ||
    (recovered && current.retry)
  ) {
    patch.sessions = (patch.sessions ?? state.sessions).map((session) =>
      session.id === event.sessionId
        ? {
            ...session,
            activity,
            runtimeError,
            runtimeErrorCode,
            ...(recovered ? { retry: undefined } : {}),
          }
        : session
    );
  }
  if (
    event.type === 'session.failed' &&
    state.activeSessionId &&
    state.activeSessionId !== event.sessionId
  ) {
    delete patch.lastError;
  }
  if (recovered && state.activeSessionId === event.sessionId && state.lastError)
    patch.lastError = null;
  return patch;
}

function applyRuntimeEventCore(
  state: ChatSessionsState,
  event: RuntimeEvent
): Partial<ChatSessionsState> {
  const sessionId = event.sessionId;
  if (!sessionId) {
    return {};
  }

  switch (event.type) {
    case 'session.created':
    case 'session.resumed': {
      // Watermark for the replay-coverage merge (round-6 Bug B v2): only
      // messages that already exist NOW may be folded by this resume's
      // `session.history`; anything echoed after this point is a new turn
      // the replay cannot know about. Resume only — a created session has
      // no replay coming.
      if (event.type === 'session.resumed' && event.requestId) {
        snapshotResumeCandidates(
          sessionId,
          event.requestId,
          (state.messages[sessionId] ?? []).map((message) => message.id)
        );
      }
      const runtimeIdentity = event.payload?.runtimeIdentity;
      // S2 (b): the running agent, straight from the runtime that reported it.
      // Not a materialization — an absent value keeps whatever the row already
      // had (an old Host never sends it), and turning undefined into a default
      // remains `mergeSessionIndex`'s job alone.
      const agent = event.payload?.agent;
      const hostBoundSessionIds = state.hostBoundSessionIds.includes(sessionId)
        ? state.hostBoundSessionIds
        : [...state.hostBoundSessionIds, sessionId];
      return {
        hostBoundSessionIds,
        sessions: state.sessions.map((session) =>
          session.id === sessionId
            ? {
                ...session,
                runtimeIdentity: runtimeIdentity ?? session.runtimeIdentity,
                agent: agent ?? session.agent,
                updatedAt: Date.now(),
              }
            : session
        ),
      };
    }

    case 'session.updated': {
      const { runtimeIdentity } = event.payload;
      return {
        sessions: state.sessions.map((session) =>
          session.id === sessionId ? { ...session, runtimeIdentity } : session
        ),
      };
    }

    case 'session.history': {
      const { payload } = event;
      if (
        (payload.mode === 'initial' || payload.mode === 'refresh') &&
        !hasMatchingResumeSnapshot(sessionId, event.requestId)
      ) {
        // A newer resume already replaced this hydration generation. Reject
        // the whole stale event, including its error and runtime identity.
        return {};
      }
      if (payload.mode === 'older') {
        const pagination = state.historyPagination?.[sessionId];
        if (!pagination || payload.offset !== pagination.nextOffset) {
          // Duplicate, out-of-order, or pre-refresh page. Page coverage—not
          // rendered h:* row count—is the authority for the next offset.
          return {};
        }
      }

      // Replay-coverage merge (round-6 Bug B): a resume replays the whole
      // JSONL, so runtime echoes of turns the replay already contains must be
      // reconciled away — keeping every runtime message rendered each
      // recovered turn twice (history copy + retained live echo). The walk
      // and its fail-open rules live in the historyReplayMerge leaf; on read
      // failure it degrades to the old prefix-replace and never drops a
      // runtime message.
      const bucket = state.messages[sessionId] ?? [];
      const historyMessages = payload.messages.map((historyMessage) =>
        mapHistoryMessageToChatMessage(sessionId, historyMessage)
      );
      let mergedBucket: ChatMessage[];
      if (payload.mode === 'older') {
        mergedBucket = mergeOlderHistoryPage(bucket, historyMessages);
      } else if (payload.mode === 'branch') {
        mergedBucket = historyMessages;
      } else {
        mergedBucket = mergeReplayedHistory(bucket, historyMessages, {
          historyReadFailed: payload.error != null,
          snapshot: takeResumeSnapshot(sessionId, event.requestId),
        });
      }
      const messages = withBucket(state, sessionId, mergedBucket);

      // Row creation is T-02's responsibility; only enrich an existing row.
      // updatedAt takes the last history message's timestamp — never Date.now(),
      // otherwise merely viewing history would bump the session to the top.
      const lastMessage = payload.messages[payload.messages.length - 1];
      const sessions = state.sessions.map((session) =>
        session.id === sessionId
          ? {
              ...session,
              runtimeIdentity: payload.runtimeIdentity,
              updatedAt: lastMessage?.timestamp ?? session.updatedAt,
            }
          : session
      );

      const historyErrors = { ...state.historyErrors };
      if (payload.error) {
        historyErrors[sessionId] = `${payload.error.code}: ${payload.error.message}`;
      } else {
        delete historyErrors[sessionId];
      }

      const hydratedCount = mergedBucket.filter((message) =>
        message.id.startsWith(HISTORY_MESSAGE_ID_PREFIX)
      ).length;
      const historyPagination = {
        ...state.historyPagination,
        [sessionId]: {
          nextOffset: Math.max(0, payload.offset ?? 0) + payload.messages.length,
          hydratedCount,
          totalCount: payload.totalCount ?? hydratedCount,
          hasMore: payload.hasMore ?? false,
        },
      };

      const historyBranchRevisions =
        payload.branchRevision === undefined
          ? state.historyBranchRevisions
          : {
              ...state.historyBranchRevisions,
              [sessionId]: payload.branchRevision,
            };

      return {
        messages,
        sessions,
        historyErrors,
        historyPagination,
        historyBranchRevisions,
      };
    }

    case 'session.status': {
      const recentSessionIds = [
        sessionId,
        ...state.recentSessionIds.filter((id) => id !== sessionId),
      ].slice(0, 8);
      // D12 (U24): the pool reclaimed this session's idle worker to make room.
      // Dropping the host binding is the load-bearing half — left in place, the
      // next send would skip `createSession` and address a worker that no
      // longer exists. `messages` is deliberately KEPT: unlike ending a
      // conversation on purpose, the user did not ask for this, and the
      // transcript they were reading must not blank out under them. It costs a
      // resume on the next send, which is exactly what reclamation trades away.
      const hostBoundSessionIds =
        event.payload.disconnectReason === 'capacity_reclaimed'
          ? state.hostBoundSessionIds.filter((id) => id !== sessionId)
          : state.hostBoundSessionIds;
      const status = upsertSessionStatus(
        state.sessions,
        sessionId,
        event.payload.status,
        event.payload.retry
      );
      // T034 (session-02): the file this session was opened from had to be
      // repaired. Applied as a second pass rather than as another
      // `upsertSessionStatus` argument precisely so it is NOT cleared when the
      // next status carries none — see the field's own comment.
      const recovery = event.payload.recovery;
      return {
        sessions: recovery
          ? status.map((session) => (session.id === sessionId ? { ...session, recovery } : session))
          : status,
        hostBoundSessionIds,
        recentSessionIds,
      };
    }

    case 'session.completed': {
      // Terminal event bailout: a turn can never complete while canUseTool
      // still has this session parked, so any leftover entries here are
      // stale (Host crash / dropped event) — clear them so no ghost card
      // stays clickable forever (see withoutSessionPermissions).
      return {
        sessions: upsertSessionStatus(state.sessions, sessionId, 'idle'),
        unreadSessionIds: markSessionUnread(state, sessionId),
        ...withoutSessionPermissions(state, sessionId),
      };
    }

    case 'session.failed': {
      return {
        sessions: upsertSessionStatus(state.sessions, sessionId, 'failed'),
        lastError: event.payload?.error ?? 'Session failed',
        unreadSessionIds: markSessionUnread(state, sessionId),
        ...withoutSessionPermissions(state, sessionId),
      };
    }

    case 'session.stopped': {
      return {
        sessions: upsertSessionStatus(state.sessions, sessionId, 'idle'),
        ...withoutSessionPermissions(state, sessionId),
      };
    }

    case 'message.started': {
      const message: ChatMessage = {
        id: event.payload.messageId,
        sessionId,
        role: event.payload.role,
        blocks: [],
        // Round-2 P0 (optional-field addition): absent unless the event
        // actually carries it, so existing exact-shape assertions elsewhere
        // are unaffected. F11 (round-2 review fix): `event.payload.model` is
        // deliberately NOT copied onto the message here — it has zero
        // renderer consumers (the timeline's model display reads the event's
        // `model` straight off the wire via `messageMetadata.ts`'s own
        // registry, never this store) — see that file's `reduceMessageMetadata`.
        ...(event.payload.attachments ? { attachments: event.payload.attachments } : {}),
      };
      const bucket = state.messages[sessionId] ?? [];
      return { messages: withBucket(state, sessionId, upsertMessage(bucket, message)) };
    }

    case 'message.delta': {
      const bucket = state.messages[sessionId] ?? [];
      const existing = bucket.find((item) => item.id === event.payload.messageId);
      if (!existing) {
        return {};
      }
      const updated = appendTextBlock(existing, event.payload.blockId, event.payload.text);
      return { messages: withBucket(state, sessionId, upsertMessage(bucket, updated)) };
    }

    case 'thinking.started': {
      const bucket = state.messages[sessionId] ?? [];
      const existing = bucket.find((item) => item.id === event.payload.messageId);
      if (!existing || existing.blocks.some((block) => block.id === event.payload.blockId)) {
        return {};
      }
      const updated: ChatMessage = {
        ...existing,
        blocks: [...existing.blocks, { id: event.payload.blockId, type: 'thinking', text: '' }],
      };
      return { messages: withBucket(state, sessionId, upsertMessage(bucket, updated)) };
    }

    case 'thinking.delta': {
      const bucket = state.messages[sessionId] ?? [];
      const existing = bucket.find((item) => item.id === event.payload.messageId);
      if (!existing) {
        return {};
      }
      const updated = appendTextBlock(
        existing,
        event.payload.blockId,
        event.payload.text,
        'thinking'
      );
      return { messages: withBucket(state, sessionId, upsertMessage(bucket, updated)) };
    }

    case 'tool.started': {
      const bucket = state.messages[sessionId] ?? [];
      const existing = bucket.find((item) => item.id === event.payload.messageId);
      if (!existing) {
        return {};
      }
      // T101 — one row per call, whoever opened it. The projector makes
      // `tool_execution_start` idempotent for a row the streaming pass already
      // announced, and this is the same rule held on the reading side: a
      // second `tool.started` for a call already on screen must not append a
      // second block, because the two would then be indistinguishable to
      // `pairToolBlocks` and only one of them could ever be given a result.
      if (
        existing.blocks.some(
          (block) => block.type === 'tool_call' && block.toolCallId === event.payload.toolCallId
        )
      ) {
        return {};
      }
      const updated: ChatMessage = {
        ...existing,
        blocks: [
          ...existing.blocks,
          {
            id: event.payload.toolCallId,
            type: 'tool_call',
            toolCallId: event.payload.toolCallId,
            toolName: event.payload.name,
            toolInput: event.payload.input,
          },
        ],
      };
      return { messages: withBucket(state, sessionId, upsertMessage(bucket, updated)) };
    }

    case 'tool.updated': {
      if (event.payload.input === undefined) return {};
      const bucket = state.messages[sessionId] ?? [];
      const existing = bucket.find((item) => item.id === event.payload.messageId);
      if (!existing) return {};
      const blockIndex = existing.blocks.findIndex(
        (block) => block.type === 'tool_call' && block.toolCallId === event.payload.toolCallId
      );
      if (blockIndex < 0) return {};
      const current = existing.blocks[blockIndex];
      if (!current || sameToolInput(current.toolInput, event.payload.input)) return {};
      const blocks = [...existing.blocks];
      blocks[blockIndex] = { ...current, toolInput: event.payload.input };
      return {
        messages: withBucket(state, sessionId, upsertMessage(bucket, { ...existing, blocks })),
      };
    }

    case 'tool.completed': {
      const bucket = state.messages[sessionId] ?? [];
      const existing = bucket.find((item) => item.id === event.payload.messageId);
      if (!existing) {
        return {};
      }
      const updated: ChatMessage = {
        ...existing,
        blocks: [
          ...existing.blocks,
          {
            id: `${event.payload.toolCallId}-result`,
            type: 'tool_result',
            toolCallId: event.payload.toolCallId,
            toolOk: event.payload.ok,
            toolOutput: event.payload.output,
            text: event.payload.error,
          },
        ],
      };
      return { messages: withBucket(state, sessionId, upsertMessage(bucket, updated)) };
    }

    case 'custom.message':
    case 'custom.entry': {
      const content = event.payload.content
        ? `${event.payload.customType}\n${event.payload.content}`
        : event.payload.customType;
      const message: ChatMessage = {
        id: event.payload.messageId,
        sessionId,
        role: 'system',
        blocks: [{ id: `${event.payload.messageId}-text`, type: 'text', text: content }],
      };
      const bucket = state.messages[sessionId] ?? [];
      return { messages: withBucket(state, sessionId, upsertMessage(bucket, message)) };
    }

    /**
     * T08-b — record what the permission plugin decided.
     *
     * ONE block per `requestId`, not one per broadcast: the plugin emits a
     * `prompt` and then a `decision` for the same gate, and appending both would
     * put every approval in the transcript twice. The prompt opens the row, the
     * decision fills it in — which is also what makes the outcome survive the
     * modal closing.
     *
     * Attached to the turn's latest assistant message, in block order, so the
     * row sits next to the tool call it gated. An event for a session with no
     * messages yet (or one already closed) is dropped: `withBucket` would
     * materialize a bucket for a session the user cannot see.
     */
    case 'permission.activity': {
      const bucket = state.messages[sessionId];
      if (!bucket || bucket.length === 0) return {};
      const target = [...bucket]
        .reverse()
        .find(
          (item) => item.role === 'assistant' && !item.id.startsWith(HISTORY_MESSAGE_ID_PREFIX)
        );
      if (!target) return {};

      const incoming: PermissionActivityRecord = { ...event.payload };
      const blockId = `perm-activity-${event.payload.requestId}`;
      const existingIndex = target.blocks.findIndex(
        (block) =>
          block.type === 'permission_activity' &&
          block.permissionActivity?.requestId === event.payload.requestId
      );

      if (existingIndex >= 0) {
        const existing = target.blocks[existingIndex];
        const previous = existing?.permissionActivity;
        if (!existing || !previous) return {};
        const merged = mergePermissionActivity(previous, incoming);
        // Redelivery of an event that changes nothing must not rebuild the
        // message — the timeline re-renders off reference equality.
        if (merged === previous) return {};
        const blocks = [...target.blocks];
        blocks[existingIndex] = { ...existing, permissionActivity: merged };
        return {
          messages: withBucket(state, sessionId, upsertMessage(bucket, { ...target, blocks })),
        };
      }

      const updated: ChatMessage = {
        ...target,
        blocks: [
          ...target.blocks,
          { id: blockId, type: 'permission_activity', permissionActivity: incoming },
        ],
      };
      return { messages: withBucket(state, sessionId, upsertMessage(bucket, updated)) };
    }

    case 'permission.requested': {
      const bucket = state.messages[sessionId] ?? [];
      const existing = [...bucket]
        .reverse()
        .find(
          (item) => item.role === 'assistant' && !item.id.startsWith(HISTORY_MESSAGE_ID_PREFIX)
        );
      const messageId = existing?.id ?? `msg-perm-${event.payload.permissionId}`;
      const baseMessage =
        existing ??
        ({
          id: messageId,
          sessionId,
          role: 'assistant',
          blocks: [],
        } satisfies ChatMessage);

      // Idempotent guard: a redelivered event must not duplicate the block
      // or the queue entry. Round-2 P0 fix: scoped to permission_request
      // blocks only — the Host uses the SDK toolUseID as the permissionId,
      // which is the SAME id `tool.started` already used for that turn's
      // tool_call block, so comparing against every block id (as introduced
      // by 4019fed) made this guard true for every real permission request
      // and suppressed the permission_request block entirely.
      const blockAlreadyPresent = baseMessage.blocks.some(
        (block) =>
          block.type === 'permission_request' && block.permissionId === event.payload.permissionId
      );
      const queueAlreadyHasEntry = state.pendingPermissions.some(
        (item) => item.sessionId === sessionId && item.permissionId === event.payload.permissionId
      );

      const updated: ChatMessage = blockAlreadyPresent
        ? baseMessage
        : {
            ...baseMessage,
            blocks: [
              ...baseMessage.blocks,
              {
                id: event.payload.permissionId,
                type: 'permission_request',
                permissionId: event.payload.permissionId,
                toolName: event.payload.toolName,
                // Two keys, one field: `reason` is the protocol's own name for
                // the agent's justification (Codex writes it), `description`
                // is the historical Claude key. Reading only one loses every
                // justification the other agent sends, silently.
                toolDescription: event.payload.reason ?? event.payload.description,
                // T023: the runtime's own summary travels as an id and is
                // worded by `PERMISSION_ACTION_LABELS`, not copied as text.
                permissionAction: event.payload.action,
                toolInput: event.payload.input,
                resolved: false,
                permissionKind: event.payload.kind,
                permissionDetail: event.payload.detail,
                permissionDecisions: event.payload.decisions,
                // Spread rather than assigned: an absent scope must stay absent
                // so "this build reports no reach" and "this request has none"
                // read the same to the card.
                ...(event.payload.sessionGrantScope
                  ? { permissionGrantScope: event.payload.sessionGrantScope }
                  : {}),
                ...(event.payload.timeoutMs !== undefined
                  ? { permissionExpiresAt: event.timestamp + event.payload.timeoutMs }
                  : {}),
                omittedDecisionCount: event.payload.omittedDecisionCount,
              },
            ],
          };

      return {
        messages: withBucket(state, sessionId, upsertMessage(bucket, updated)),
        pendingPermissions: queueAlreadyHasEntry
          ? state.pendingPermissions
          : [
              ...state.pendingPermissions,
              {
                sessionId,
                permissionId: event.payload.permissionId,
                messageId,
                // Spread conditionally, like `permissionExpiresAt` above: an
                // absent field must stay absent rather than become an explicit
                // `undefined`, so "this worker does not report progress" and
                // "this worker reported nothing" read the same downstream.
                ...(event.payload.queuePosition !== undefined
                  ? { queuePosition: event.payload.queuePosition }
                  : {}),
                ...(event.payload.queueDepth !== undefined
                  ? { queueDepth: event.payload.queueDepth }
                  : {}),
              },
            ],
        sessions: upsertSessionStatus(state.sessions, sessionId, 'waiting_permission'),
      };
    }

    case 'permission.resolved': {
      const { permissionId, allow, decision, autoReason } = event.payload;
      if (!permissionId) return {};

      const cleared = withoutPermission(state, sessionId, permissionId);
      // chat-event-02: the gate is open, so the session stops claiming it is
      // waiting on one. Computed against the pre-clear queues (see the helper)
      // and spread onto every return path below, including the two early ones —
      // a resolution that found no block here still settled a real card.
      const gate = afterGateResolved(state, sessionId, { permissionId });
      const bucket = state.messages[sessionId];
      if (!bucket) return { ...cleared, ...gate };

      // R13 (round-2 iteration-2 review, RED-LINE approved): identity-
      // preserving early return when no block in this bucket matches — the
      // Host's compensating `permission.resolved` (claudeRuntime.ts
      // respondPermission's `!ok` branch) now fires for ids that were never
      // in THIS bucket too (a desynced/Host-restart redelivery), which used
      // to unconditionally reallocate every message + blocks array for a
      // no-op event.
      let matched = false;
      const nextBucket = bucket.map((message) => {
        let messageChanged = false;
        const nextBlocks = message.blocks.map((block) => {
          if (block.permissionId !== permissionId) return block;
          // R12 (round-2 iteration-2 review, RED-LINE approved): first
          // resolution wins — an already-resolved block must not be
          // overwritten by a later resolved event. Fixes the Stop-race
          // where an authoritative deny (`rejectSession`) settles the card
          // first, then a stale/compensating `allow:true` redelivery would
          // otherwise flip it back to "Allowed" after the Host already told
          // the CLI no.
          if (block.resolved) return block;
          messageChanged = true;
          // The two S2 (c) additions ride the SAME first-resolution-wins
          // branch: a decision or an auto-reason that arrived on a losing
          // redelivery would otherwise relabel a card the Host already
          // settled, which is the flip R12 exists to refuse.
          return {
            ...block,
            resolved: true,
            allowed: allow,
            permissionDecision: decision,
            permissionAutoReason: autoReason,
          };
        });
        if (!messageChanged) return message;
        matched = true;
        return { ...message, blocks: nextBlocks };
      });
      if (!matched) return { ...cleared, ...gate };

      return { messages: withBucket(state, sessionId, nextBucket), ...cleared, ...gate };
    }

    case 'question.requested': {
      const { questionId } = event.payload;
      if (!questionId) {
        return {};
      }

      const bucket = state.messages[sessionId] ?? [];
      const existing = [...bucket]
        .reverse()
        .find(
          (item) => item.role === 'assistant' && !item.id.startsWith(HISTORY_MESSAGE_ID_PREFIX)
        );
      const messageId = existing?.id ?? `msg-question-${questionId}`;
      const baseMessage =
        existing ??
        ({
          id: messageId,
          sessionId,
          role: 'assistant',
          blocks: [],
        } satisfies ChatMessage);

      // Idempotent on the question id, same guard as `permission.requested`
      // one branch up: a redelivered request must not draw the card twice nor
      // park a second queue entry that no answer would ever retire.
      const blockAlreadyPresent = baseMessage.blocks.some(
        (block) => block.type === 'question' && block.questionId === questionId
      );
      const queueAlreadyHasEntry = state.pendingQuestions.some(
        (item) => item.sessionId === sessionId && item.questionId === questionId
      );

      const updated: ChatMessage = blockAlreadyPresent
        ? baseMessage
        : {
            ...baseMessage,
            blocks: [
              ...baseMessage.blocks,
              {
                id: questionId,
                type: 'question',
                questionId,
                questions: event.payload.questions,
                resolved: false,
              },
            ],
          };

      return {
        messages: withBucket(state, sessionId, upsertMessage(bucket, updated)),
        // chat-event-01: APPEND. This used to overwrite a single slot, which
        // made the second `ask` of a turn hide the first one's card and strand
        // its promise.
        pendingQuestions: queueAlreadyHasEntry
          ? state.pendingQuestions
          : [...state.pendingQuestions, { sessionId, questionId, messageId }],
        sessions: upsertSessionStatus(state.sessions, sessionId, 'waiting_question'),
      };
    }

    case 'question.resolved': {
      const { questionId, outcome, answers, response } = event.payload;
      const bucket = state.messages[sessionId];
      // Retire only the entry this event names. A resolution for another
      // session, or one the worker emits for a request that never produced a
      // card, must not take a live question out of the queue: that card would
      // be left on screen with no way to answer it while `waiting_question`
      // keeps its session busy.
      const dequeued = questionId ? withoutQuestion(state, sessionId, questionId) : {};
      // chat-event-02, question half — see `afterGateResolved`.
      const gate = questionId ? afterGateResolved(state, sessionId, { questionId }) : {};
      if (!questionId || !bucket) {
        return { ...dequeued, ...gate };
      }

      const nextBucket = bucket.map((message) => ({
        ...message,
        blocks: message.blocks.map((block) =>
          block.questionId === questionId
            ? {
                ...block,
                resolved: true,
                questionOutcome: outcome,
                ...(answers ? { questionAnswers: answers } : {}),
                ...(response ? { questionResponse: response } : {}),
              }
            : block
        ),
      }));

      return { messages: withBucket(state, sessionId, nextBucket), ...dequeued, ...gate };
    }

    default:
      return {};
  }
}

/**
 * Fold a batch of runtime events into one combined state patch (C-08a).
 * Each event sees the effects of earlier events in the batch; the returned
 * partial is equivalent to applying the events one set() at a time.
 */
export function filterRetiredRuntimeEvents(
  events: readonly RuntimeEvent[],
  retired: (sessionId: string | null | undefined) => boolean = isSessionRetired
): RuntimeEvent[] {
  return events.filter((event) => !retired(event.sessionId));
}

export function applyRuntimeEvents(
  state: ChatSessionsState,
  events: RuntimeEvent[]
): Partial<ChatSessionsState> {
  const patch: Partial<ChatSessionsState> = {};
  let working = state;
  for (const event of events) {
    const step = applyRuntimeEvent(working, event);
    working = { ...working, ...step };
    Object.assign(patch, step);
  }
  return patch;
}

/** Streaming bursts arrive as one IPC macrotask per event; coalesce per frame. */
const RUNTIME_EVENT_FLUSH_MS = 16;
/** Hidden-window timer throttling can delay the flush; cap the backlog. */
const RUNTIME_EVENT_MAX_QUEUE = 256;

/**
 * R5 round-2 (A5): TOCTOU check for `sendMessage`'s post-await guards. Both
 * halves matter — the row can be gone from `sessions` (Close / Archive removed
 * it) and a row that a concurrent index refresh re-added is still dismissed for
 * the rest of this run. Must be called with a FRESH `get()`, never a snapshot
 * taken before the await.
 */
function isSessionStillLive(state: ChatSessionsState, sessionId: string): boolean {
  return state.sessions.some((item) => item.id === sessionId) && !isSessionDismissed(sessionId);
}

function isBusyStatus(status: SessionRuntimeStatus): boolean {
  return (
    status === 'starting' ||
    status === 'running' ||
    status === 'stopping' ||
    status === 'waiting_permission' ||
    status === 'waiting_question'
  );
}

export const useChatSessionsStore = create<ChatSessionsState>()((set, get) => ({
  projects: [DEMO_PROJECT],
  workspaces: DEMO_WORKSPACES,
  sessions: DEMO_SESSIONS,
  messages: INITIAL_MESSAGES,
  activeSessionId: 'session-live',
  recentSessionIds: ['session-live', 'session-welcome'],
  pendingPermissions: [],
  pendingQuestions: [],
  hostBoundSessionIds: [],
  unreadSessionIds: [],
  runtimeReady: false,
  lastError: null,
  historyErrors: {},
  historyPagination: {},
  historyBranchRevisions: {},

  selectSession: (sessionId) => {
    // H/18 S3: opening a conversation IS reading it. Done here rather than in
    // the sidebar so every entry point counts — the center tab strip and the
    // folder-header activation reach this same action.
    set((state) => ({
      activeSessionId: sessionId,
      lastError: null,
      unreadSessionIds:
        sessionId && state.unreadSessionIds.includes(sessionId)
          ? state.unreadSessionIds.filter((id) => id !== sessionId)
          : state.unreadSessionIds,
    }));
  },

  /**
   * R5 round-2 (A5) — approved additive change to this red-line store.
   *
   * Ghost session: `sendMessage` crosses two awaits (`ensureHost`,
   * `createSession`) before it sends. The user can Close or Archive the active
   * session inside that window — the row and every per-session leftover are
   * gone from the store, but this closure still holds `activeSessionId` from
   * before the await and happily asks the Host to create and drive it. The
   * result is a live runtime with no row to reach or stop it, plus an error
   * message written into a deleted session's bucket.
   *
   * The fix is guard clauses only: after each await, re-read the store and
   * confirm the session still exists and was not dismissed this run. Every
   * existing path keeps its exact semantics; the guards can only fire in a
   * state that had no defined behaviour before. If `createSession` already
   * went out, the runtime is reaped fire-and-forget so nothing is left running.
   */
  sendMessage: async (text, attachments) => {
    const trimmed = text.trim();
    const state = get();
    const { activeSessionId } = state;
    if ((!trimmed && !attachments?.length) || !activeSessionId) {
      return;
    }

    const session = state.sessions.find((item) => item.id === activeSessionId);
    const workspace = state.workspaces.find((item) => item.id === session?.workspaceId);
    if (!session || !workspace) {
      set({ lastError: 'Active session has no workspace' });
      return;
    }

    if (isBusyStatus(session.status)) {
      set({ lastError: 'Session is busy — stop it first or wait for idle' });
      return;
    }

    try {
      await window.electronAPI.chat.ensureHost();
      // A5 guard 1: nothing has been created Host-side yet, so a silent abort
      // is the whole remedy. No `lastError`: the user removed this session on
      // purpose and there is no longer a Composer bound to it to show it in.
      if (!isSessionStillLive(get(), activeSessionId)) {
        return;
      }

      if (!get().hostBoundSessionIds.includes(activeSessionId)) {
        await window.electronAPI.chat.createSession({
          sessionId: activeSessionId,
          workspacePath: workspace.path,
        });
        // A5 guard 2: the session went away while `createSession` was in
        // flight. The Host now holds a runtime the UI can never reach — reap
        // it fire-and-forget (best effort; a failed close is not worse than
        // the leak it tries to avoid) and never record the binding.
        if (!isSessionStillLive(get(), activeSessionId)) {
          void Promise.resolve(
            window.electronAPI.chat.closeSession({ sessionId: activeSessionId })
          ).catch(() => {});
          return;
        }
        set((prev) => ({
          hostBoundSessionIds: prev.hostBoundSessionIds.includes(activeSessionId)
            ? prev.hostBoundSessionIds
            : [...prev.hostBoundSessionIds, activeSessionId],
          lastError: null,
        }));
      }

      await window.electronAPI.chat.send({
        sessionId: activeSessionId,
        attemptId: uniqueId('send-attempt'),
        text: trimmed,
        ...(attachments?.length ? { attachments } : {}),
      });
      set({ lastError: null });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({
        lastError: message,
        sessions: upsertSessionStatus(get().sessions, activeSessionId, 'failed'),
        messages: {
          ...get().messages,
          [activeSessionId]: [
            ...(get().messages[activeSessionId] ?? []),
            {
              id: uniqueId('msg-error'),
              sessionId: activeSessionId,
              role: 'error',
              blocks: [{ id: uniqueId('err'), type: 'text', text: message }],
            },
          ],
        },
      });
    }
  },

  stopActiveSession: async () => {
    const { activeSessionId } = get();
    if (!activeSessionId) {
      return;
    }
    try {
      await window.electronAPI.chat.stop({ sessionId: activeSessionId });
      set({ lastError: null });
    } catch (err) {
      set({
        lastError: err instanceof Error ? err.message : String(err),
      });
    }
  },

  respondQuestion: async ({ questionId, answers, response, cancel }) => {
    const parked = get().pendingQuestions;
    // Named id first; the oldest parked question is the fallback for a caller
    // that has no card of its own (e.g. the send path's auto-skip).
    const pending = questionId ? parked.find((item) => item.questionId === questionId) : parked[0];
    if (!pending) return false;
    try {
      const result = await window.electronAPI.chat.respondQuestion({
        sessionId: pending.sessionId,
        questionId: pending.questionId,
        ...(answers ? { answers } : {}),
        ...(response ? { response } : {}),
        ...(cancel ? { cancel: true } : {}),
      });
      // The dock is NOT cleared here. `question.resolved` is what retires it,
      // and it is the worker that emits it — so a question answered in one
      // window disappears in every other view of the same session too.
      set({ lastError: null });
      return result.handled;
    } catch (err) {
      set({ lastError: err instanceof Error ? err.message : String(err) });
      return false;
    }
  },

  initRuntime: () => {
    if (get().runtimeReady) {
      return () => {};
    }

    set({ runtimeReady: true });

    let queue: RuntimeEvent[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    const flush = () => {
      flushTimer = null;
      if (queue.length === 0) {
        return;
      }
      const batch = filterRetiredRuntimeEvents(queue);
      queue = [];
      set((state) => ({ ...applyRuntimeEvents(state, batch) }));

      // T24: wire admission and authoritative store insertion are two stages.
      // Once the exact message id acknowledged above has reached its bucket,
      // retire the display-only pending bubble — for every session, not only
      // whichever timeline happens to be mounted.
      const nextState = get();
      const pendingStore = usePendingUserMessagesStore.getState();
      for (const pendingMessages of Object.values(pendingStore.bySession)) {
        for (const pending of pendingMessages) {
          if (
            pending.authoritativeMessageId != null &&
            (nextState.messages[pending.sessionId] ?? []).some(
              (message) => message.id === pending.authoritativeMessageId
            )
          ) {
            pendingStore.clear(pending.attemptId);
          }
        }
      }
    };

    const unsubscribe = subscribeRuntimeEvent((event) => {
      // Drop frames that arrive after repository/session removal. The queue is
      // filtered again at flush time to close the inverse race: a frame queued
      // while the row existed, followed by removal before the 16ms batch lands.
      if (isSessionRetired(event.sessionId)) return;
      if (
        event.type === 'message.started' &&
        event.sessionId &&
        event.payload.role === 'user' &&
        event.payload.attemptId
      ) {
        usePendingUserMessagesStore
          .getState()
          .acknowledgeAttempt(event.sessionId, event.payload.attemptId, event.payload.messageId);
      }
      queue.push(event);
      if (queue.length >= RUNTIME_EVENT_MAX_QUEUE) {
        if (flushTimer !== null) {
          clearTimeout(flushTimer);
        }
        flush();
        return;
      }
      if (flushTimer === null) {
        flushTimer = setTimeout(flush, RUNTIME_EVENT_FLUSH_MS);
      }
    });

    void window.electronAPI.chat.ensureHost().catch((err: unknown) => {
      set({
        lastError: err instanceof Error ? err.message : String(err),
      });
    });

    return () => {
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
      }
      // Drain rather than drop: late events must still land in the store.
      flush();
      unsubscribe();
    };
  },
}));
