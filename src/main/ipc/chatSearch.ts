/**
 * Chat search IPC (docs/plantree/plans/chat-search): `chatSearch:query`.
 *
 * The index is built lazily: nothing is opened or read until the first query,
 * and turn ends feed it only from then on (`ChatSearchIndex.handleRuntimeEvent`,
 * on the same `workerManager` event path `SessionIndexService` listens to).
 */

import path from 'node:path';
import { IPC_CHANNELS } from '@shared/types';
import type { ChatSearchQuery, ChatSearchResult, ChatSearchScope } from '@shared/types/chatSearch';
import { app, ipcMain } from 'electron';
import { CLAUDE_SDK_HOME_DIR_NAME } from '../services/agent-host/claudeSdkEngine';
import { dshHostSupervisor } from '../services/agent-host/DshHostSupervisor';
import { workerManager } from '../services/agent-host/WorkerManager';
import { getAppStateRoot } from '../services/appStatePaths';
import { sessionIndexService } from '../services/chat/SessionIndexService';
import { readSessionReplayPage } from '../services/chat/SessionReplayReader';
import { ChatSearchIndex } from '../services/chatSearch/ChatSearchIndex';
import { ChatSearchStore } from '../services/chatSearch/ChatSearchStore';
import { readSessionMessages } from '../services/chatSearch/sessionReader';
import { readFileTsdSafeBounded } from '../utils/tsdSafeRead';

export const CHAT_SEARCH_DB_FILENAME = 'chat-search.db';
/** Largest Claude transcript read for the index (it is parsed on Main's thread). */
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;

const EMPTY_RESULT: ChatSearchResult = { sessions: [], truncated: false, indexing: null };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The renderer's payload, read defensively: a bad scope searches everything. */
export function sanitizeChatSearchQuery(payload: unknown): ChatSearchQuery | null {
  const input = record(payload);
  if (!input) return null;
  const rawScope = record(input.scope);
  const scope: ChatSearchScope =
    rawScope?.kind === 'workspace' &&
    typeof rawScope.workspacePath === 'string' &&
    rawScope.workspacePath.trim()
      ? { kind: 'workspace', workspacePath: rawScope.workspacePath }
      : { kind: 'all' };
  return {
    text: typeof input.text === 'string' ? input.text : '',
    scope,
    ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
  };
}

/** One query against `index`; never rejects for a bad payload. */
export async function handleChatSearchQuery(
  index: Pick<ChatSearchIndex, 'query'>,
  payload: unknown
): Promise<ChatSearchResult> {
  const query = sanitizeChatSearchQuery(payload);
  if (!query) return EMPTY_RESULT;
  return index.query(query);
}

let chatSearchIndex: ChatSearchIndex | null = null;

function createChatSearchIndex(): ChatSearchIndex {
  const claudeConfigDir = path.join(getAppStateRoot(), CLAUDE_SDK_HOME_DIR_NAME);
  return new ChatSearchIndex({
    store: new ChatSearchStore({
      dbPath: path.join(app.getPath('userData'), CHAT_SEARCH_DB_FILENAME),
    }),
    listSessions: () => sessionIndexService.listForDisplay(),
    getSession: (sessionId) => sessionIndexService.get(sessionId),
    readMessages: (row) =>
      readSessionMessages(row, {
        readDshPage: (request) => dshHostSupervisor.readPage(request),
        readLegacyPage: (request) => readSessionReplayPage(request),
        readFile: (file) => readFileTsdSafeBounded(file, MAX_TRANSCRIPT_BYTES),
        claudeConfigDir,
      }),
    hostBusy: () => {
      const status = dshHostSupervisor.status();
      if (status.state === 'starting' || status.state === 'restarting') return true;
      return status.lastPong?.channels.some((channel) => channel.busy) ?? false;
    },
  });
}

function getChatSearchIndex(): ChatSearchIndex {
  chatSearchIndex ??= createChatSearchIndex();
  return chatSearchIndex;
}

export function registerChatSearchHandlers(): void {
  workerManager.onEvent((event) => chatSearchIndex?.handleRuntimeEvent(event));
  ipcMain.handle(IPC_CHANNELS.CHAT_SEARCH_QUERY, (_event, payload: unknown) =>
    handleChatSearchQuery(getChatSearchIndex(), payload)
  );
}
