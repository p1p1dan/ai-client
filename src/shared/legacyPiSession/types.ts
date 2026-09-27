// New in dsh-rebase P1-9a: structural stand-ins for the pi-agent-core and pi-ai types a session file stores.

/**
 * The shapes the decode chain reads, spelled out here so this library needs no
 * pi package at runtime or at type-check time.
 *
 * They follow @earendil-works/pi-agent-core 0.84.4 (`harness/session/types`,
 * `harness/session/jsonl/types`, `harness/messages`) and @earendil-works/pi-ai
 * 0.84.4 (`types`), widened where pi narrows a string to a union (`api`,
 * `provider`, `stopReason`): a reader takes what an older or newer writer put
 * in the file, not what today's union allows. pi's own types stay assignable
 * to these, which is what lets the 1.0.x runtime pass its values in unchanged.
 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface TextContent {
  type: 'text';
  text: string;
  textSignature?: string;
}

export interface ThinkingContent {
  type: 'thinking';
  thinking: string;
  thinkingSignature?: string;
  redacted?: boolean;
}

export interface ImageContent {
  type: 'image';
  data: string;
  mimeType: string;
}

export interface ToolCall {
  type: 'toolCall';
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  thoughtSignature?: string;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export interface UserMessage {
  role: 'user';
  content: string | (TextContent | ImageContent)[];
  timestamp: number;
}

export interface AssistantMessage {
  role: 'assistant';
  content: (TextContent | ThinkingContent | ToolCall)[];
  api: string;
  provider: string;
  model: string;
  responseId?: string;
  usage: Usage;
  stopReason: string;
  errorMessage?: string;
  timestamp: number;
}

export interface ToolResultMessage {
  role: 'toolResult';
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: unknown;
  isError: boolean;
  timestamp: number;
}

export interface BashExecutionMessage {
  role: 'bashExecution';
  command: string;
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath?: string;
  timestamp: number;
  excludeFromContext?: boolean;
}

export interface CustomMessage {
  role: 'custom';
  customType: string;
  content: string | (TextContent | ImageContent)[];
  display: boolean;
  details?: unknown;
  timestamp: number;
}

export interface BranchSummaryMessage {
  role: 'branchSummary';
  summary: string;
  fromId: string;
  timestamp: number;
}

export interface CompactionSummaryMessage {
  role: 'compactionSummary';
  summary: string;
  tokensBefore: number;
  timestamp: number;
}

export type AgentMessage =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | BashExecutionMessage
  | CustomMessage
  | BranchSummaryMessage
  | CompactionSummaryMessage;

export interface EntryBase {
  type: string;
  id: string;
  seq: number;
  parentId: string | null;
  timestamp: number;
}

export interface MessageEntry extends EntryBase {
  type: 'message';
  message: AgentMessage;
  terminate?: true;
}

export interface ModelChangeEntry extends EntryBase {
  type: 'model_change';
  provider: string;
  modelId: string;
}

export interface ThinkingLevelEntry extends EntryBase {
  type: 'thinking_level_change';
  thinkingLevel: string;
}

export interface ActiveToolsEntry extends EntryBase {
  type: 'active_tools_change';
  activeToolNames: string[];
}

export interface CompactionEntry extends EntryBase {
  type: 'compaction';
  summary: string;
  retainedTail: AgentMessage[];
  tokensBefore: number;
  details?: unknown;
  usage?: Usage;
}

export interface BranchSummaryEntry extends EntryBase {
  type: 'branch_summary';
  fromId: string;
  summary: string;
  details?: unknown;
  usage?: Usage;
}

export interface CustomEntry extends EntryBase {
  type: 'custom';
  customType: string;
  data?: unknown;
}

export type Entry =
  | MessageEntry
  | ModelChangeEntry
  | ThinkingLevelEntry
  | ActiveToolsEntry
  | CompactionEntry
  | BranchSummaryEntry
  | CustomEntry;

export interface JsonlV4Header {
  kind: 'header';
  version: 4;
  id: string;
  createdAt: number;
  cwd: string;
  parentSessionId?: string;
  /** Preserved only when a v3 parent path could not be resolved to a session id. */
  legacyParentSessionPath?: string;
  metadata?: Record<string, JsonValue>;
}
