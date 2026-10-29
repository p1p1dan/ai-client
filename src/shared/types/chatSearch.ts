/**
 * Chat search (docs/plantree/plans/chat-search): find a conversation by what
 * was said in it, then jump to the message.
 *
 * The contract between Main's index (`src/main/services/chatSearch/`) and the
 * renderer's 「对话」 tab and jump. Main answers one query per call; the
 * renderer lists recent chats itself when the query is empty.
 */

/** Which sessions a query looks at. Archived sessions are never searched. */
export type ChatSearchScope = { kind: 'all' } | { kind: 'workspace'; workspacePath: string };

export interface ChatSearchQuery {
  /** Matched as a case-insensitive substring; leading and trailing space is ignored. */
  text: string;
  scope: ChatSearchScope;
  /** Most sessions to return; Main caps it. */
  limit?: number;
}

export type ChatSearchRole = 'user' | 'assistant';

/** The first hit of a session, cut around the match for one result row. */
export interface ChatSearchSnippet {
  role: ChatSearchRole;
  /** A window of the message text around the match, with `…` where it was cut. */
  text: string;
  /** Offset of the match inside `text`, in UTF-16 code units. */
  matchStart: number;
  matchLength: number;
}

export interface ChatSearchSessionResult {
  sessionId: string;
  title: string;
  /** The session's workspace, or null for a chat bound to none. */
  workspacePath: string | null;
  /** Epoch milliseconds, as in the session index. */
  updatedAt: number;
  titleMatch: boolean;
  /** Null when only the title matched. */
  snippet: ChatSearchSnippet | null;
  /** Messages in this session that match. */
  hitCount: number;
  /**
   * Every matching message, oldest first. Each key equals the
   * `HistoryMessage.id` the chat timeline renders for that message, so the
   * renderer can find it after loading the session's history.
   */
  messageKeys: string[];
}

export interface ChatSearchProgress {
  /** Sessions indexed so far in the current build. */
  done: number;
  total: number;
}

export interface ChatSearchResult {
  /** Title matches first, then most recently updated. */
  sessions: ChatSearchSessionResult[];
  /** More sessions matched than `limit`. */
  truncated: boolean;
  /**
   * Non-null while the index is still being built: the results so far are
   * partial, and the renderer asks again until this is null.
   */
  indexing: ChatSearchProgress | null;
}
