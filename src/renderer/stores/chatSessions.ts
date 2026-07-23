import type { RuntimeEvent, SessionRuntimeStatus } from '@shared/types/runtimeEvents';
import { create } from 'zustand';

export type WorkspaceKind = 'main' | 'worktree' | 'remote' | 'temp';

export type ChatBlockType = 'text' | 'tool_call' | 'tool_result' | 'permission_request';

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

interface ChatSessionsState {
  projects: ChatProject[];
  workspaces: ChatWorkspace[];
  sessions: ChatSession[];
  messages: ChatMessage[];
  activeSessionId: string | null;
  recentSessionIds: string[];
  pendingPermission: PendingPermission | null;
  /** Sessions already registered with Agent Host. */
  hostBoundSessionIds: string[];
  runtimeReady: boolean;
  lastError: string | null;

  selectSession: (sessionId: string) => void;
  sendMessage: (text: string) => Promise<void>;
  stopActiveSession: () => Promise<void>;
  respondPermission: (allow: boolean) => void;
  /** Subscribe to Host Runtime Events; returns unsubscribe. */
  initRuntime: () => () => void;
}

const DEMO_PROJECT: ChatProject = { id: 'project-demo', name: 'demo' };

const DEMO_WORKSPACES: ChatWorkspace[] = [
  {
    id: 'ws-main',
    projectId: DEMO_PROJECT.id,
    name: 'Main',
    kind: 'main',
    path: 'D:/Code/projects/ai-client',
  },
  {
    id: 'ws-worktree',
    projectId: DEMO_PROJECT.id,
    name: 'feat/openchamber-chat-refactor',
    kind: 'worktree',
    path: 'D:/Code/projects/ai-client',
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

const INITIAL_MESSAGES: ChatMessage[] = [
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
];

function upsertSessionStatus(
  sessions: ChatSession[],
  sessionId: string,
  status: SessionRuntimeStatus
): ChatSession[] {
  return sessions.map((session) =>
    session.id === sessionId ? { ...session, status, updatedAt: Date.now() } : session
  );
}

function upsertMessage(messages: ChatMessage[], message: ChatMessage): ChatMessage[] {
  const index = messages.findIndex((item) => item.id === message.id);
  if (index === -1) {
    return [...messages, message];
  }
  const next = [...messages];
  next[index] = message;
  return next;
}

function appendTextBlock(message: ChatMessage, blockId: string, text: string): ChatMessage {
  const blocks = [...message.blocks];
  const blockIndex = blocks.findIndex((block) => block.id === blockId);

  if (blockIndex === -1) {
    blocks.push({ id: blockId, type: 'text', text });
  } else {
    const block = blocks[blockIndex];
    blocks[blockIndex] = {
      ...block,
      text: `${block.text ?? ''}${text}`,
    };
  }

  return { ...message, blocks };
}

function applyRuntimeEvent(
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
      return { messages: upsertMessage(state.messages, message) };
    }

    case 'message.delta': {
      const existing = state.messages.find((item) => item.id === event.payload.messageId);
      if (!existing) {
        return {};
      }
      const updated = appendTextBlock(existing, event.payload.blockId, event.payload.text);
      return { messages: upsertMessage(state.messages, updated) };
    }

    case 'tool.started': {
      const existing = state.messages.find((item) => item.id === event.payload.messageId);
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
      return { messages: upsertMessage(state.messages, updated) };
    }

    case 'tool.completed': {
      const existing = state.messages.find((item) => item.id === event.payload.messageId);
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
      return { messages: upsertMessage(state.messages, updated) };
    }

    case 'permission.requested': {
      const existing = [...state.messages]
        .reverse()
        .find((item) => item.sessionId === sessionId && item.role === 'assistant');
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
        messages: upsertMessage(state.messages, updated),
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
      if (!permissionId) {
        return { pendingPermission: null };
      }

      const messages = state.messages.map((message) => {
        if (message.sessionId !== sessionId) {
          return message;
        }
        return {
          ...message,
          blocks: message.blocks.map((block) =>
            block.permissionId === permissionId
              ? { ...block, resolved: true, allowed: allow }
              : block
          ),
        };
      });

      return { messages, pendingPermission: null };
    }

    default:
      return {};
  }
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
  pendingPermission: null,
  hostBoundSessionIds: [],
  runtimeReady: false,
  lastError: null,

  selectSession: (sessionId) => {
    set({ activeSessionId: sessionId });
  },

  sendMessage: async (text) => {
    const trimmed = text.trim();
    const state = get();
    const { activeSessionId } = state;
    if (!trimmed || !activeSessionId) {
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
      });
      set({ lastError: null });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({
        lastError: message,
        sessions: upsertSessionStatus(get().sessions, activeSessionId, 'failed'),
        messages: [
          ...get().messages,
          {
            id: `msg-error-${Date.now()}`,
            sessionId: activeSessionId,
            role: 'error',
            blocks: [{ id: `err-${Date.now()}`, type: 'text', text: message }],
          },
        ],
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

  initRuntime: () => {
    if (get().runtimeReady) {
      return () => {};
    }

    set({ runtimeReady: true });
    const unsubscribe = window.electronAPI.chat.onRuntimeEvent((event) => {
      set((state) => ({
        ...applyRuntimeEvent(state, event),
      }));
    });

    void window.electronAPI.chat.ensureHost().catch((err: unknown) => {
      set({
        lastError: err instanceof Error ? err.message : String(err),
      });
    });

    return unsubscribe;
  },
}));
