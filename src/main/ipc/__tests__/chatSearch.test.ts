import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IPC_CHANNELS } from '@shared/types';
import type { ChatSearchQuery } from '@shared/types/chatSearch';
import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import type { SessionIndexEntry } from '@shared/types/sessionIndex';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `chatSearch:query`: the payload is read defensively, the handler answers
 * from a lazily built index, and turn ends reach the index over the same
 * `workerManager` event path the session index uses.
 */

type Handler = (...args: unknown[]) => unknown;
const handlers = new Map<string, Handler>();
const eventListeners: Array<(event: RuntimeEvent) => void> = [];
let userData = '/tmp';
let sessions: SessionIndexEntry[] = [];
const readPage = vi.fn();

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: vi.fn(() => userData) },
  ipcMain: {
    handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)),
  },
}));
vi.mock('../../services/agent-host/claudeSdkEngine', () => ({
  CLAUDE_SDK_HOME_DIR_NAME: 'claude',
}));
vi.mock('../../services/appStatePaths', () => ({ getAppStateRoot: () => userData }));
vi.mock('../../services/agent-host/DshHostSupervisor', () => ({
  dshHostSupervisor: {
    readPage: (request: unknown) => readPage(request),
    status: () => ({ state: 'ready', channels: 0 }),
  },
}));
vi.mock('../../services/agent-host/WorkerManager', () => ({
  workerManager: {
    onEvent: vi.fn((listener: (event: RuntimeEvent) => void) => {
      eventListeners.push(listener);
      return () => undefined;
    }),
  },
}));
vi.mock('../../services/chat/SessionIndexService', () => ({
  sessionIndexService: {
    listForDisplay: vi.fn(async () => sessions),
    get: vi.fn(async (id: string) => sessions.find((s) => s.sessionId === id)),
  },
}));
vi.mock('../../services/chat/SessionReplayReader', () => ({
  readSessionReplayPage: vi.fn(async () => {
    throw new Error('no legacy sessions here');
  }),
}));

const { handleChatSearchQuery, registerChatSearchHandlers, sanitizeChatSearchQuery } = await import(
  '../chatSearch'
);

beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), 'chat-search-ipc-'));
});
afterEach(async () => {
  await rm(userData, { recursive: true, force: true });
});

describe('sanitizeChatSearchQuery', () => {
  it('reads a well-formed payload as is', () => {
    expect(
      sanitizeChatSearchQuery({
        text: 'abc',
        scope: { kind: 'workspace', workspacePath: '/repo' },
        limit: 10,
      })
    ).toEqual({ text: 'abc', scope: { kind: 'workspace', workspacePath: '/repo' }, limit: 10 });
  });

  it('turns a bad scope into all and a bad text into empty', () => {
    expect(sanitizeChatSearchQuery({ text: 3, scope: { kind: 'workspace' } })).toEqual({
      text: '',
      scope: { kind: 'all' },
    });
    expect(sanitizeChatSearchQuery(null)).toBeNull();
    expect(sanitizeChatSearchQuery('abc')).toBeNull();
  });
});

describe('handleChatSearchQuery', () => {
  it('passes a sanitized query and answers a bad payload with an empty result', async () => {
    const query = vi.fn(async (_q: ChatSearchQuery) => ({
      sessions: [],
      truncated: false,
      indexing: null,
    }));
    await handleChatSearchQuery({ query }, { text: 'x', scope: { kind: 'nope' } });
    expect(query).toHaveBeenCalledWith({ text: 'x', scope: { kind: 'all' } });
    expect(await handleChatSearchQuery({ query }, undefined)).toEqual({
      sessions: [],
      truncated: false,
      indexing: null,
    });
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe('registerChatSearchHandlers', () => {
  it('answers chatSearch:query from the DSH host pages and re-reads after a turn ends', async () => {
    sessions = [
      {
        sessionId: 's1',
        agent: 'dsh',
        runtimeIdentity: '/dsh/aiclient-sessions/s1.dsh.json',
        workspacePath: '/repo',
        title: 'Lot review',
        updatedAt: 10,
        archived: false,
      },
    ];
    readPage.mockResolvedValue({
      messages: [
        {
          id: 'h:m1',
          role: 'user',
          blocks: [{ type: 'text', id: 'm1:t', text: 'Where is 8GE21E15?' }],
        },
      ],
      offset: 0,
      limit: 500,
      totalCount: 1,
      hasMore: false,
    });
    registerChatSearchHandlers();
    const handler = handlers.get(IPC_CHANNELS.CHAT_SEARCH_QUERY);
    expect(handler).toBeTypeOf('function');
    expect(eventListeners).toHaveLength(1);

    const ask = (text: string) =>
      handler?.({}, { text, scope: { kind: 'all' } }) as Promise<{
        sessions: Array<{ sessionId: string; messageKeys: string[] }>;
        indexing: unknown;
      }>;
    await ask('');
    await vi.waitFor(async () => {
      const result = await ask('8ge21e15');
      expect(result.indexing).toBeNull();
      expect(result.sessions.map((s) => [s.sessionId, s.messageKeys])).toEqual([['s1', ['h:m1']]]);
    });
    expect(readPage).toHaveBeenCalledWith({
      stubFile: '/dsh/aiclient-sessions/s1.dsh.json',
      logicalSessionId: 's1',
      offset: 0,
      limit: 500,
    });

    readPage.mockClear();
    (sessions[0] as SessionIndexEntry).updatedAt = 11;
    eventListeners[0]?.({ type: 'session.completed', sessionId: 's1' } as RuntimeEvent);
    await vi.waitFor(() => expect(readPage).toHaveBeenCalledTimes(1), { timeout: 5000 });
  });
});
