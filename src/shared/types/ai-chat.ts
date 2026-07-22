/**
 * AI chat streaming protocol types for the local middleware engine.
 * These types define the contract between the Electron main process (AIService)
 * and the renderer process (aiChat store + bubble UI components).
 */

import type { ModelId } from './ai';

/** Request payload for starting a new conversation turn. */
export interface AIChatStartRequest {
  /** Session identifier: crypto.randomUUID() for new sessions, or existing JSONL filename (without extension) for resumed sessions. */
  sessionId: string;
  /** Worktree absolute path, used as the working directory for tool execution. */
  projectPath: string;
  /** The user's input text for this turn. */
  userMessage: string;
  /** Optional absolute paths to image files attached by the user. */
  images?: string[];
  /** Claude model to use for this turn. */
  model: ModelId;
  /** If true, main process will load history from the JSONL file before starting; if false/undefined, starts fresh. */
  resumeFromHistory?: boolean;
}

/** Request payload for stopping an active conversation. */
export interface AIChatStopRequest {
  sessionId: string;
}

/** Request payload for loading session history. */
export interface AISessionLoadRequest {
  sessionId: string;
  projectPath: string;
}

/** A single content block within a chat message. */
export type ChatContentBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | {
      kind: 'tool_use';
      toolUseId: string;
      toolName: string;
      input: unknown;
      status: 'streaming' | 'running' | 'done' | 'error';
      result?: string;
      isError?: boolean;
    };

/** A single message in the conversation (user or assistant). */
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  blocks: ChatContentBlock[];
  createdAt: number;
}

/** Token usage statistics for a completed message. */
export interface AIChatUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Streaming events emitted by the main process AIService to the renderer. */
export type AIChatEvent =
  | { type: 'message_start'; sessionId: string; messageId: string; role: 'assistant' }
  | { type: 'text_delta'; sessionId: string; messageId: string; delta: string }
  | { type: 'thinking_delta'; sessionId: string; messageId: string; delta: string }
  | {
      type: 'tool_use_start';
      sessionId: string;
      messageId: string;
      toolUseId: string;
      toolName: string;
    }
  | { type: 'tool_use_input_delta'; sessionId: string; toolUseId: string; partialJson: string }
  | { type: 'tool_use_input_complete'; sessionId: string; toolUseId: string; input: unknown }
  | {
      type: 'tool_result';
      sessionId: string;
      toolUseId: string;
      content: string;
      isError: boolean;
    }
  | {
      type: 'message_complete';
      sessionId: string;
      messageId: string;
      stopReason: string;
      usage: AIChatUsage;
    }
  | { type: 'conversation_complete'; sessionId: string }
  | { type: 'error'; sessionId: string; error: string; recoverable: boolean };

/** Response payload for loading session history. */
export interface AISessionLoadResponse {
  sessionId: string;
  messages: ChatMessage[];
}

/** Session metadata for the session list sidebar. */
export interface AISessionMeta {
  sessionId: string;
  projectPath: string;
  firstUserMessage: string;
  messageCount: number;
  createdAt: number;
  lastActivityAt: number;
}
