import type { RuntimeEvent, SessionRuntimeStatus } from '@shared/types/runtimeEvents';
import { create } from 'zustand';
import {
  continueMockAfterPermission,
  runMockConversation,
  subscribeMockRuntime,
} from '@/lib/mockRuntime';

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
  mockRuntimeReady: boolean;

  selectSession: (sessionId: string) => void;
  sendMessage: (text: string) => void;
  respondPermission: (allow: boolean) => void;
  initMockRuntime: () => () => void;
}

const MOCK_PROJECT: ChatProject = { id: 'project-demo', name: 'demo' };

const MOCK_WORKSPACES: ChatWorkspace[] = [
  {
    id: 'ws-main',
    projectId: MOCK_PROJECT.id,
    name: 'Main',
    kind: 'main',
    path: 'D:/Code/projects/ai-client',
  },
  {
    id: 'ws-worktree',
    projectId: MOCK_PROJECT.id,
    name: 'feat/openchamber-chat-refactor',
    kind: 'worktree',
    path: 'D:/Code/projects/ai-client/.worktrees/feat-openchamber',
  },
];

const MOCK_SESSIONS: ChatSession[] = [
  {
    id: 'session-welcome',
    projectId: MOCK_PROJECT.id,
    workspaceId: 'ws-main',
    title: 'Welcome',
    status: 'idle',
    updatedAt: Date.now() - 86_400_000,
  },
  {
    id: 'session-refactor',
    projectId: MOCK_PROJECT.id,
    workspaceId: 'ws-worktree',
    title: 'OpenChamber shell refactor',
    status: 'completed',
    updatedAt: Date.now() - 3_600_000,
  },
  {
    id: 'session-mock-run',
    projectId: MOCK_PROJECT.id,
    workspaceId: 'ws-main',
    title: 'Mock runtime demo',
    status: 'idle',
    updatedAt: Date.now(),
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
        text: 'Welcome to the OpenChamber-style workspace shell. Send a message in Mock runtime demo to watch events flow.',
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
    case 'session.status': {
      if (event.type !== 'session.status') {
        return {};
      }
      const recentSessionIds = [
        sessionId,
        ...state.recentSessionIds.filter((id) => id !== sessionId),
      ].slice(0, 8);
      return {
        sessions: upsertSessionStatus(state.sessions, sessionId, event.payload.status),
        recentSessionIds,
      };
    }

    case 'message.started': {
      if (event.type !== 'message.started') {
        return {};
      }
      const message: ChatMessage = {
        id: event.payload.messageId,
        sessionId,
        role: event.payload.role,
        blocks: [],
      };
      return { messages: upsertMessage(state.messages, message) };
    }

    case 'message.delta': {
      if (event.type !== 'message.delta') {
        return {};
      }
      const existing = state.messages.find((item) => item.id === event.payload.messageId);
      if (!existing) {
        return {};
      }
      const updated = appendTextBlock(existing, event.payload.blockId, event.payload.text);
      return { messages: upsertMessage(state.messages, updated) };
    }

    case 'tool.started': {
      if (event.type !== 'tool.started') {
        return {};
      }
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
      if (event.type !== 'tool.completed') {
        return {};
      }
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
      if (event.type !== 'permission.requested') {
        return {};
      }
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
      };
    }

    case 'permission.resolved': {
      if (event.type !== 'permission.resolved') {
        return {};
      }
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

export const useChatSessionsStore = create<ChatSessionsState>()((set, get) => ({
  projects: [MOCK_PROJECT],
  workspaces: MOCK_WORKSPACES,
  sessions: MOCK_SESSIONS,
  messages: INITIAL_MESSAGES,
  activeSessionId: 'session-mock-run',
  recentSessionIds: ['session-mock-run', 'session-refactor', 'session-welcome'],
  pendingPermission: null,
  mockRuntimeReady: false,

  selectSession: (sessionId) => {
    set({ activeSessionId: sessionId });
  },

  sendMessage: (text) => {
    const trimmed = text.trim();
    const { activeSessionId } = get();
    if (!trimmed || !activeSessionId) {
      return;
    }

    void runMockConversation(activeSessionId, trimmed);
  },

  respondPermission: (allow) => {
    const { pendingPermission } = get();
    if (!pendingPermission) {
      return;
    }

    void continueMockAfterPermission(
      pendingPermission.sessionId,
      pendingPermission.messageId,
      allow,
      pendingPermission.permissionId
    );
  },

  initMockRuntime: () => {
    if (get().mockRuntimeReady) {
      return () => {};
    }

    set({ mockRuntimeReady: true });
    return subscribeMockRuntime((event) => {
      set((state) => ({
        ...applyRuntimeEvent(state, event),
      }));
    });
  },
}));
