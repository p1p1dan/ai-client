import { tmpdir } from 'node:os';
import type { SessionIndexEntry } from '@shared/types/sessionIndex';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * D48 S2 §4.8-B18 — the cross-agent model guard runs in MAIN, before dispatch.
 *
 * Two halves have to hold together, and only one of them is about rejection:
 *
 *  1. A model that provably belongs to the other runtime never reaches the Agent
 *     Host, so no `turn/start` frame carrying it is ever written.
 *  2. A model that is merely absent from the filtered catalog — the §4.4-6
 *     "stored selection · unverified" case — goes through untouched. A guard that
 *     also rejected those would reset the user to `Automatic` behind their back,
 *     which is the silent model swap the whole feature is trying to avoid.
 *
 * The harness is `chatSpawnGate.test.ts`'s: `electron` mocked so the handler map
 * can be captured, and the two services stubbed so a refusal is observable as
 * "the Host was never called".
 */

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const indexRows = new Map<string, SessionIndexEntry>();

const hostCalls = {
  create: [] as unknown[],
  resume: [] as unknown[],
  send: [] as unknown[],
};

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: vi.fn(() => tmpdir()) },
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
    createSession: vi.fn(async (payload: unknown) => {
      hostCalls.create.push(payload);
      return 'req-create';
    }),
    resumeSession: vi.fn(async (payload: unknown) => {
      hostCalls.resume.push(payload);
      return 'req-resume';
    }),
    sendMessage: vi.fn(async (payload: unknown) => {
      hostCalls.send.push(payload);
      return 'req-send';
    }),
    getStatus: vi.fn(),
  },
}));

vi.mock('../../services/chat/SessionIndexService', () => ({
  sessionIndexService: {
    recordCreated: vi.fn(async () => {}),
    recordResumed: vi.fn(async () => {}),
    handleRuntimeEvent: vi.fn(),
    get: vi.fn(async (sessionId: string) => indexRows.get(sessionId)),
  },
}));

const originalFlag = process.env.AICLIENT_MANAGED_CREDENTIALS;

beforeEach(async () => {
  vi.resetModules();
  handlers.clear();
  indexRows.clear();
  hostCalls.create.length = 0;
  hostCalls.resume.length = 0;
  hostCalls.send.length = 0;
  // The spawn gate is a different gate with its own suite; off keeps it a no-op
  // so a red here can only be the model guard.
  process.env.AICLIENT_MANAGED_CREDENTIALS = '0';
  const { registerChatHandlers } = await import('../chat');
  registerChatHandlers();
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalFlag === undefined) delete process.env.AICLIENT_MANAGED_CREDENTIALS;
  else process.env.AICLIENT_MANAGED_CREDENTIALS = originalFlag;
});

function row(sessionId: string, agent?: string): SessionIndexEntry {
  return {
    sessionId,
    workspacePath: '/repo',
    title: '',
    updatedAt: 1,
    archived: false,
    ...(agent ? { agent } : {}),
  } as SessionIndexEntry;
}

function invoke(channel: string, payload: unknown): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`no handler registered for ${channel}`);
  return Promise.resolve(handler({}, payload));
}

describe('B18 — a cross-agent model is refused before the Host is called', () => {
  it('chat:send — a Claude id on a Codex session is rejected, and nothing is dispatched', async () => {
    indexRows.set('s1', row('s1', 'codex'));

    await expect(
      invoke('chat:send', { sessionId: 's1', text: 'hi', model: 'claude-opus-5' })
    ).rejects.toThrow(/model_agent_mismatch/);
    // The load-bearing half: no frame exists to be wrong about.
    expect(hostCalls.send).toEqual([]);
  });

  it('chat:send — a Codex id on a Claude session is rejected too (both directions)', async () => {
    indexRows.set('s1', row('s1', 'claude-code'));

    await expect(
      invoke('chat:send', { sessionId: 's1', text: 'hi', model: 'gpt-5.6-sol' })
    ).rejects.toThrow(/model_agent_mismatch/);
    expect(hostCalls.send).toEqual([]);
  });

  it('chat:send — a legacy short name is a Claude id, so Codex refuses it', async () => {
    indexRows.set('s1', row('s1', 'codex'));

    await expect(
      invoke('chat:send', { sessionId: 's1', text: 'hi', model: 'sonnet' })
    ).rejects.toThrow(/model_agent_mismatch/);
  });

  it('chat:createSession — refused before the index row is written', async () => {
    const { sessionIndexService } = await import('../../services/chat/SessionIndexService');

    await expect(
      invoke('chat:createSession', {
        sessionId: 's2',
        workspacePath: '/repo',
        agent: 'codex',
        model: 'claude-sonnet-5',
      })
    ).rejects.toThrow(/model_agent_mismatch/);
    // Order matters: a row recorded first would outlive the refusal and claim a
    // model this session could never have run.
    expect(sessionIndexService.recordCreated).not.toHaveBeenCalled();
    expect(hostCalls.create).toEqual([]);
  });

  it('chat:resumeSession — reads the binding off the payload, which pairs with runtimeIdentity', async () => {
    await expect(
      invoke('chat:resumeSession', {
        sessionId: 's3',
        runtimeIdentity: 'thr-1',
        workspacePath: '/repo',
        agent: 'codex',
        model: 'claude-opus-5',
      })
    ).rejects.toThrow(/model_agent_mismatch/);
    expect(hostCalls.resume).toEqual([]);
  });

  it('a create with no agent field is a Claude Code session, and is guarded as one', async () => {
    // "Absent = Claude Code" is the protocol's own reading; the guard must use
    // the same one or it stops applying to every pre-D48 renderer.
    await expect(
      invoke('chat:createSession', {
        sessionId: 's4',
        workspacePath: '/repo',
        model: 'gpt-5.6-sol',
      })
    ).rejects.toThrow(/model_agent_mismatch/);
  });
});

describe('B18 — everything else goes through untouched', () => {
  it('an out-of-catalog id of the RIGHT agent is dispatched verbatim (§4.4-6 unverified)', async () => {
    indexRows.set('s1', row('s1', 'codex'));

    await expect(
      invoke('chat:send', { sessionId: 's1', text: 'hi', model: 'gpt-5.5' })
    ).resolves.toEqual({ requestId: 'req-send' });
    // Verbatim: not normalised, not replaced with a catalog entry.
    expect(hostCalls.send).toEqual([{ sessionId: 's1', text: 'hi', model: 'gpt-5.5' }]);
  });

  it('a legacy Claude short name still reaches the Claude runtime', async () => {
    indexRows.set('s1', row('s1', 'claude-code'));

    await expect(
      invoke('chat:send', { sessionId: 's1', text: 'hi', model: 'sonnet' })
    ).resolves.toEqual({ requestId: 'req-send' });
  });

  it('a model nobody owns is allowed on either agent', async () => {
    indexRows.set('s1', row('s1', 'codex'));
    indexRows.set('s2', row('s2', 'claude-code'));

    await invoke('chat:send', { sessionId: 's1', text: 'hi', model: 'private-deployment-a' });
    await invoke('chat:send', { sessionId: 's2', text: 'hi', model: 'private-deployment-a' });
    expect(hostCalls.send).toHaveLength(2);
  });

  it('a send with no model is never blocked', async () => {
    indexRows.set('s1', row('s1', 'codex'));

    await expect(invoke('chat:send', { sessionId: 's1', text: 'hi' })).resolves.toEqual({
      requestId: 'req-send',
    });
  });

  it('an unknown session stands down rather than guessing a binding', async () => {
    // No row at all (a live-only session, or a row this build cannot read). The
    // guard cannot prove a mismatch, so refusing would be a coin flip that
    // breaks a legitimate Codex send.
    await expect(
      invoke('chat:send', { sessionId: 'never-seen', text: 'hi', model: 'gpt-5.6-sol' })
    ).resolves.toEqual({ requestId: 'req-send' });
  });

  it('a row written by a NEWER build (unknown agent slug) also stands down', async () => {
    indexRows.set('s9', row('s9', 'some-future-agent'));

    await expect(
      invoke('chat:send', { sessionId: 's9', text: 'hi', model: 'gpt-5.6-sol' })
    ).resolves.toEqual({ requestId: 'req-send' });
  });

  it('a row with no agent field is Claude Code, and Claude ids pass', async () => {
    indexRows.set('s5', row('s5'));

    await expect(
      invoke('chat:send', { sessionId: 's5', text: 'hi', model: 'claude-opus-5' })
    ).resolves.toEqual({ requestId: 'req-send' });
    await expect(
      invoke('chat:send', { sessionId: 's5', text: 'hi', model: 'gpt-5.6-sol' })
    ).rejects.toThrow(/model_agent_mismatch/);
  });
});
