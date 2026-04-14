export interface ClaudeProject {
  /** Directory name under `~/.claude/projects/`. */
  id: string;
  /** Decoded real project path. */
  path: string;
  sessionCount: number;
  /** Unix timestamp (seconds). */
  lastActivityAt: number;
}

export interface ClaudeSessionMeta {
  /** Session id (jsonl filename without `.jsonl`). */
  id: string;
  projectId: string;
  /** First user message preview (truncated). */
  firstMessage: string | null;
  /** Unix timestamp (seconds). */
  createdAt: number;
  /** Unix timestamp (seconds). */
  lastMessageAt: number | null;
  /** Model name, e.g. `claude-sonnet-4.6`. */
  model: string | null;
}
