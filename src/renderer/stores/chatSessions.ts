import { type AgentWireName, sessionAgent } from '@shared/types/agentWire';
import type {
  PermissionAutoReason,
  PermissionDecisionId,
  PermissionDetail,
  PermissionRequestKind,
  QuestionItem,
  RuntimeEvent,
  SessionRetryInfo,
  SessionRuntimeStatus,
} from '@shared/types/runtimeEvents';
import { HISTORY_MESSAGE_ID_PREFIX, type HistoryMessage } from '@shared/types/sessionHistory';
import { create } from 'zustand';
// Leaf module (no imports of its own) on purpose: importing the hook module
// `sessionIndex/useSessionIndex.ts` here would close a cycle back onto this
// store. Read by the `sendMessage` ghost-session guard below.
import { isSessionDismissed } from '@/components/chat/sessionIndex/dismissedSessions';
// Leaf module as well (shared-types import only) — see its header for the
// replay-coverage rules the `session.history` reducer delegates to, and for
// the resume snapshot registry that bounds which messages a replay may fold.
import {
  mergeReplayedHistory,
  snapshotResumeCandidates,
  takeResumeSnapshot,
} from './historyReplayMerge';

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
   * a1 (2026-07-30 net-visibility batch, optional-field addition): the CLI's
   * own transport-retry loop, when session.status last carried one. Cleared
   * (set back to undefined) on every session.status WITHOUT a retry payload
   * and on every terminal event — see upsertSessionStatus.
   */
  retry?: SessionRetryInfo;
}

export interface ChatBlock {
  id: string;
  type: ChatBlockType;
  text?: string;
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
  /** S2 (c): exec command / file-change diffs rendered in the card body. */
  permissionDetail?: PermissionDetail;
  /** S2 (c): buttons offered. undefined = the historical Allow / Deny pair. */
  permissionDecisions?: PermissionDecisionId[];
  /** S2 (c): which button settled it, when richer than the `allowed` boolean. */
  permissionDecision?: PermissionDecisionId;
  /** S2 (c): set when the client answered without asking anyone. */
  permissionAutoReason?: PermissionAutoReason;
  /** S2 (c): offered decisions this build could not model and dropped. */
  omittedDecisionCount?: number;
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
  /**
   * Round-2 P0 (optional-field addition, red-line discipline): user turn's
   * attachment metadata, when the turn carried any. Set once at
   * `message.started`, never mutated after.
   */
  attachments?: ChatMessageAttachment[];
}

interface PendingPermission {
  sessionId: string;
  permissionId: string;
  messageId: string;
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
  pendingQuestion: PendingQuestion | null;
  /** Sessions already registered with Agent Host. */
  hostBoundSessionIds: string[];
  runtimeReady: boolean;
  lastError: string | null;
  /** Non-fatal per-session history read errors, keyed by sessionId. Formatted `${code}: ${message}`. */
  historyErrors: Record<string, string>;

  selectSession: (sessionId: string) => void;
  sendMessage: (text: string, attachments?: ChatSendAttachment[]) => Promise<void>;
  stopActiveSession: () => Promise<void>;
  /**
   * Answer one specific parked prompt. permissionId is required: several may
   * be parked at once, and the store must never guess which card the user
   * clicked.
   * Resolves `false` (without touching `lastError`) when the id is no longer
   * parked — a stale click, not a failure — and `false` with `lastError` set
   * when the IPC call throws, so the card can unlock its submitting state
   * (T-05 fix #4).
   */
  respondPermission: (permissionId: string, allow: boolean) => Promise<boolean>;
  respondQuestion: (input: {
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
      return { id: block.id, type: 'text', text: block.text };
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
        toolOutput: block.output,
        text: block.error,
      };
    default:
      return null;
  }
}

function mapHistoryMessageToChatMessage(
  sessionId: string,
  historyMessage: HistoryMessage
): ChatMessage {
  const blocks = historyMessage.blocks
    .map(mapHistoryBlock)
    .filter((block): block is ChatBlock => block !== null);
  return {
    id: historyMessage.id,
    sessionId,
    role: historyMessage.role,
    blocks,
  };
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

export function applyRuntimeEvent(
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
      const messages = withBucket(
        state,
        sessionId,
        mergeReplayedHistory(bucket, historyMessages, {
          historyReadFailed: payload.error != null,
          // requestId-matched snapshot from this replay's own resume; null
          // (stale replay / no resume seen) disables folding entirely.
          snapshot: takeResumeSnapshot(sessionId, event.requestId),
        })
      );

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

      return { messages, sessions, historyErrors };
    }

    case 'session.status': {
      const recentSessionIds = [
        sessionId,
        ...state.recentSessionIds.filter((id) => id !== sessionId),
      ].slice(0, 8);
      return {
        sessions: upsertSessionStatus(
          state.sessions,
          sessionId,
          event.payload.status,
          event.payload.retry
        ),
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
        ...withoutSessionPermissions(state, sessionId),
      };
    }

    case 'session.failed': {
      return {
        sessions: upsertSessionStatus(state.sessions, sessionId, 'failed'),
        lastError: event.payload?.error ?? 'Session failed',
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
                toolDescription: event.payload.description,
                toolInput: event.payload.input,
                resolved: false,
              },
            ],
          };

      return {
        messages: withBucket(state, sessionId, upsertMessage(bucket, updated)),
        pendingPermissions: queueAlreadyHasEntry
          ? state.pendingPermissions
          : [
              ...state.pendingPermissions,
              { sessionId, permissionId: event.payload.permissionId, messageId },
            ],
        sessions: upsertSessionStatus(state.sessions, sessionId, 'waiting_permission'),
      };
    }

    case 'permission.resolved': {
      const { permissionId, allow } = event.payload;
      if (!permissionId) return {};

      const cleared = withoutPermission(state, sessionId, permissionId);
      const bucket = state.messages[sessionId];
      if (!bucket) return cleared;

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
          return { ...block, resolved: true, allowed: allow };
        });
        if (!messageChanged) return message;
        matched = true;
        return { ...message, blocks: nextBlocks };
      });
      if (!matched) return cleared;

      return { messages: withBucket(state, sessionId, nextBucket), ...cleared };
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

      const updated: ChatMessage = {
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
        pendingQuestion: {
          sessionId,
          questionId,
          messageId,
        },
        sessions: upsertSessionStatus(state.sessions, sessionId, 'waiting_question'),
      };
    }

    case 'question.resolved': {
      const { questionId, outcome, answers, response } = event.payload;
      const bucket = state.messages[sessionId];
      // The dock holds ONE question. Clearing it unconditionally means any
      // resolution — including one for a different session, or one the Host
      // emits for a request that never produced a card — takes whatever is
      // currently docked off screen, leaving a live card unanswerable while
      // `waiting_question` keeps its session busy. Clear only what this event
      // actually addresses.
      const clearsDock =
        state.pendingQuestion !== null &&
        state.pendingQuestion.sessionId === sessionId &&
        state.pendingQuestion.questionId === questionId;
      const dock = clearsDock ? { pendingQuestion: null } : {};
      if (!questionId || !bucket) {
        return dock;
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

      return { messages: withBucket(state, sessionId, nextBucket), ...dock };
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
  pendingQuestion: null,
  hostBoundSessionIds: [],
  runtimeReady: false,
  lastError: null,
  historyErrors: {},

  selectSession: (sessionId) => {
    set({ activeSessionId: sessionId });
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
          // S2 (b): the binding is decided renderer-side and stated on every
          // create — never left for the Host to assume. `sessionAgent` is the
          // one reader that knows what an unset binding means.
          agent: sessionAgent(session),
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
              id: `msg-error-${Date.now()}`,
              sessionId: activeSessionId,
              role: 'error',
              blocks: [{ id: `err-${Date.now()}`, type: 'text', text: message }],
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

  respondPermission: async (permissionId, allow) => {
    // Find the entry's own sessionId — never activeSessionId — to preserve
    // existing cross-session behavior; a stale click (id no longer parked)
    // is not a failure, so it returns false without an IPC call or lastError.
    const entry = get().pendingPermissions.find((item) => item.permissionId === permissionId);
    if (!entry) {
      return false;
    }

    try {
      await window.electronAPI.chat.respondPermission({
        sessionId: entry.sessionId,
        permissionId: entry.permissionId,
        allow,
      });
      return true;
    } catch (err) {
      set({
        lastError: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  },

  respondQuestion: async (input) => {
    const { pendingQuestion } = get();
    if (!pendingQuestion) {
      return false;
    }

    try {
      await window.electronAPI.chat.respondQuestion({
        sessionId: pendingQuestion.sessionId,
        questionId: pendingQuestion.questionId,
        ...input,
      });
      return true;
    } catch (err) {
      set({
        lastError: err instanceof Error ? err.message : String(err),
      });
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
      const batch = queue;
      queue = [];
      set((state) => ({ ...applyRuntimeEvents(state, batch) }));
    };

    const unsubscribe = window.electronAPI.chat.onRuntimeEvent((event) => {
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
