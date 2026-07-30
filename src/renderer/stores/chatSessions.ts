import type { QuestionItem, RuntimeEvent, SessionRuntimeStatus } from '@shared/types/runtimeEvents';
import { HISTORY_MESSAGE_ID_PREFIX, type HistoryMessage } from '@shared/types/sessionHistory';
import { create } from 'zustand';

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
  /** Claude runtime / resume identity when known. */
  runtimeIdentity?: string;
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
  questionId?: string;
  questions?: QuestionItem[];
  questionOutcome?: 'answered' | 'cancelled' | 'rejected';
  questionAnswers?: Record<string, string>;
  questionResponse?: string;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system' | 'error';
  blocks: ChatBlock[];
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
  pendingPermission: PendingPermission | null;
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
  respondPermission: (allow: boolean) => void;
  respondQuestion: (input: {
    answers?: Record<string, string>;
    response?: string;
    cancel?: boolean;
  }) => void;
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
  status: SessionRuntimeStatus
): ChatSession[] {
  return sessions.map((session) =>
    session.id === sessionId ? { ...session, status, updatedAt: Date.now() } : session
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
      const runtimeIdentity = event.payload?.runtimeIdentity;
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

      // Idempotent prefix replace: drop this session's previously hydrated
      // `h:*` messages; runtime messages (user-*/asst-*/error) are untouched
      // and history always precedes them in the bucket.
      const bucket = state.messages[sessionId] ?? [];
      const withoutOldHistory = bucket.filter(
        (message) => !message.id.startsWith(HISTORY_MESSAGE_ID_PREFIX)
      );
      const historyMessages = payload.messages.map((historyMessage) =>
        mapHistoryMessageToChatMessage(sessionId, historyMessage)
      );
      const messages = withBucket(state, sessionId, [...historyMessages, ...withoutOldHistory]);

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
        sessions: upsertSessionStatus(state.sessions, sessionId, event.payload.status),
        recentSessionIds,
      };
    }

    case 'session.completed': {
      return {
        sessions: upsertSessionStatus(state.sessions, sessionId, 'idle'),
      };
    }

    case 'session.failed': {
      return {
        sessions: upsertSessionStatus(state.sessions, sessionId, 'failed'),
        lastError: event.payload?.error ?? 'Session failed',
      };
    }

    case 'session.stopped': {
      return {
        sessions: upsertSessionStatus(state.sessions, sessionId, 'idle'),
      };
    }

    case 'message.started': {
      const message: ChatMessage = {
        id: event.payload.messageId,
        sessionId,
        role: event.payload.role,
        blocks: [],
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

      const updated: ChatMessage = {
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
        pendingPermission: {
          sessionId,
          permissionId: event.payload.permissionId,
          messageId,
        },
        sessions: upsertSessionStatus(state.sessions, sessionId, 'waiting_permission'),
      };
    }

    case 'permission.resolved': {
      const { permissionId, allow } = event.payload;
      const bucket = state.messages[sessionId];
      if (!permissionId || !bucket) {
        return { pendingPermission: null };
      }

      const nextBucket = bucket.map((message) => ({
        ...message,
        blocks: message.blocks.map((block) =>
          block.permissionId === permissionId ? { ...block, resolved: true, allowed: allow } : block
        ),
      }));

      return { messages: withBucket(state, sessionId, nextBucket), pendingPermission: null };
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
      if (!questionId || !bucket) {
        return { pendingQuestion: null };
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

      return { messages: withBucket(state, sessionId, nextBucket), pendingQuestion: null };
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
  pendingPermission: null,
  pendingQuestion: null,
  hostBoundSessionIds: [],
  runtimeReady: false,
  lastError: null,
  historyErrors: {},

  selectSession: (sessionId) => {
    set({ activeSessionId: sessionId });
  },

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

      if (!get().hostBoundSessionIds.includes(activeSessionId)) {
        await window.electronAPI.chat.createSession({
          sessionId: activeSessionId,
          workspacePath: workspace.path,
        });
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

  respondPermission: (allow) => {
    const { pendingPermission } = get();
    if (!pendingPermission) {
      return;
    }

    void window.electronAPI.chat
      .respondPermission({
        sessionId: pendingPermission.sessionId,
        permissionId: pendingPermission.permissionId,
        allow,
      })
      .catch((err: unknown) => {
        set({
          lastError: err instanceof Error ? err.message : String(err),
        });
      });
  },

  respondQuestion: (input) => {
    const { pendingQuestion } = get();
    if (!pendingQuestion) {
      return;
    }

    void window.electronAPI.chat
      .respondQuestion({
        sessionId: pendingQuestion.sessionId,
        questionId: pendingQuestion.questionId,
        ...input,
      })
      .catch((err: unknown) => {
        set({
          lastError: err instanceof Error ? err.message : String(err),
        });
      });
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
