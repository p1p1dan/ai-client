import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetManagedFileWriterQueuesForTests } from '../../services/auth/managedFileWriter';

/**
 * D47 S2a trust call matrix entries ①② — `CHAT_CREATE_SESSION` and
 * `CHAT_RESUME_SESSION` must await `ensureWorkspaceTrusted` BEFORE
 * `recordCreated`/`createSession` (or the resume equivalents). Drives the
 * REAL production handler registered by `registerChatHandlers` (captured via
 * a mocked `ipcMain.handle`), not a rule copy — same discipline as S1's
 * `createVerifyAndRegisterHandler` test (B-track 1.2).
 */

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const recordCreatedMock = vi.fn().mockResolvedValue(undefined);
const recordResumedMock = vi.fn().mockResolvedValue(undefined);
const createSessionMock = vi.fn().mockResolvedValue('req-create');
const resumeSessionMock = vi.fn().mockResolvedValue('req-resume');

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => globalThis.__testUserDataDir as string) },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
}));

vi.mock('../../services/agent-host/AgentHostManager', () => ({
  agentHostManager: {
    onEvent: vi.fn(),
    createSession: createSessionMock,
    resumeSession: resumeSessionMock,
    getStatus: vi.fn(),
  },
}));

vi.mock('../../services/chat/SessionIndexService', () => ({
  sessionIndexService: {
    recordCreated: recordCreatedMock,
    recordResumed: recordResumedMock,
    handleRuntimeEvent: vi.fn(),
    // D48 S3: create/resume now read the row for this session's captured
    // permission posture. No row here — this suite is about the trust call
    // matrix, and an empty index is the not-yet-captured arm.
    get: vi.fn(async () => undefined),
  },
}));

declare global {
  // eslint-disable-next-line no-var
  var __testUserDataDir: string;
}

describe('chat.ts trust call matrix entries ①② (D47 S2a)', () => {
  const originalFlag = process.env.AICLIENT_MANAGED_CREDENTIALS;
  const originalSkip = process.env.AICLIENT_SKIP_AUTH_GATE;
  let userDataDir: string;

  beforeEach(async () => {
    vi.resetModules();
    handlers.clear();
    recordCreatedMock.mockClear();
    recordResumedMock.mockClear();
    createSessionMock.mockClear();
    resumeSessionMock.mockClear();
    userDataDir = mkdtempSync(join(tmpdir(), 'chat-trust-'));
    globalThis.__testUserDataDir = userDataDir;
    resetManagedFileWriterQueuesForTests();
    // D47 S5 §3 — this suite is about the trust-write ordering, not the spawn
    // gate (covered by `chatSpawnGate.test.ts`); the escape hatch keeps these
    // flag-on cases from tripping over an unauthenticated AuthStateService
    // default.
    process.env.AICLIENT_SKIP_AUTH_GATE = '1';

    const { registerChatHandlers } = await import('../chat');
    registerChatHandlers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(userDataDir, { recursive: true, force: true });
    if (originalFlag === undefined) delete process.env.AICLIENT_MANAGED_CREDENTIALS;
    else process.env.AICLIENT_MANAGED_CREDENTIALS = originalFlag;
    if (originalSkip === undefined) delete process.env.AICLIENT_SKIP_AUTH_GATE;
    else process.env.AICLIENT_SKIP_AUTH_GATE = originalSkip;
  });

  function claudeJsonPath(): string {
    return join(userDataDir, 'claude-home', '.claude.json');
  }

  it('CHAT_CREATE_SESSION: trust write lands before recordCreated/createSession are called (fake helper before fake spawn)', async () => {
    process.env.AICLIENT_MANAGED_CREDENTIALS = '1';
    const callOrder: string[] = [];
    recordCreatedMock.mockImplementation(async () => {
      callOrder.push('recordCreated');
    });
    createSessionMock.mockImplementation(async () => {
      callOrder.push('createSession');
      return 'req-create';
    });

    const handler = handlers.get('chat:createSession');
    expect(handler).toBeDefined();

    await handler?.({}, { sessionId: 's1', workspacePath: '/repo/local' });

    const doc = JSON.parse(readFileSync(claudeJsonPath(), 'utf-8')) as {
      projects: Record<string, unknown>;
    };
    expect(doc.projects['/repo/local']).toBeDefined();
    expect(callOrder).toEqual(['recordCreated', 'createSession']);
  });

  it('CHAT_RESUME_SESSION: trust write lands before recordResumed/resumeSession', async () => {
    process.env.AICLIENT_MANAGED_CREDENTIALS = '1';
    const callOrder: string[] = [];
    recordResumedMock.mockImplementation(async () => {
      callOrder.push('recordResumed');
    });
    resumeSessionMock.mockImplementation(async () => {
      callOrder.push('resumeSession');
      return 'req-resume';
    });

    const handler = handlers.get('chat:resumeSession');
    await handler?.({}, { sessionId: 's1', runtimeIdentity: 'r1', workspacePath: '/repo/local' });

    const doc = JSON.parse(readFileSync(claudeJsonPath(), 'utf-8')) as {
      projects: Record<string, unknown>;
    };
    expect(doc.projects['/repo/local']).toBeDefined();
    expect(callOrder).toEqual(['recordResumed', 'resumeSession']);
  });

  it('flag off: no .claude.json write', async () => {
    process.env.AICLIENT_MANAGED_CREDENTIALS = '0';
    const handler = handlers.get('chat:createSession');
    await handler?.({}, { sessionId: 's1', workspacePath: '/repo/local' });

    const { existsSync } = await import('node:fs');
    expect(existsSync(claudeJsonPath())).toBe(false);
  });

  it('flag on + remote virtual workspacePath: no-op (I8)', async () => {
    process.env.AICLIENT_MANAGED_CREDENTIALS = '1';
    const handler = handlers.get('chat:createSession');
    await handler?.(
      {},
      { sessionId: 's1', workspacePath: '/__aiclient_remote__/conn-1/remote/path' }
    );

    const { existsSync } = await import('node:fs');
    expect(existsSync(claudeJsonPath())).toBe(false);
  });
});
