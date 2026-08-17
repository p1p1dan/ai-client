import { tmpdir } from 'node:os';
import { CLAUDE_CODE_AGENT, CODEX_AGENT } from '@shared/types/agentWire';
import type { SessionPermissionPreference } from '@shared/types/runtimeEvents';
import type { SessionIndexEntry } from '@shared/types/sessionIndex';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * D48 S3 §5.7 — the Main-side dispatch rules for `permissionPreference`:
 * C9 (resume replays the SNAPSHOT, never the current template), C10 (a
 * mis-addressed or malformed posture is refused before the row exists) and
 * C14 (an old renderer that sends nothing behaves exactly as it did).
 *
 * Main is the only process that holds both the session snapshot and the
 * incoming request, so it is the only place these can be decided. The harness
 * is `chatModelAgentGuard.test.ts`'s, for the same reason: a refusal is only
 * meaningful if it is observable as "the Host was never called".
 */

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const indexRows = new Map<string, SessionIndexEntry>();

const hostCalls = {
  create: [] as Array<Record<string, unknown>>,
  resume: [] as Array<Record<string, unknown>>,
};
const recorded = {
  created: [] as Array<Record<string, unknown>>,
  resumed: [] as Array<Record<string, unknown>>,
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
    createSession: vi.fn(async (payload: Record<string, unknown>) => {
      hostCalls.create.push(payload);
      return 'req-create';
    }),
    resumeSession: vi.fn(async (payload: Record<string, unknown>) => {
      hostCalls.resume.push(payload);
      return 'req-resume';
    }),
    sendMessage: vi.fn(async () => 'req-send'),
    getStatus: vi.fn(),
  },
}));

vi.mock('../../services/chat/SessionIndexService', () => ({
  sessionIndexService: {
    recordCreated: vi.fn(async (payload: Record<string, unknown>) => {
      recorded.created.push(payload);
    }),
    recordResumed: vi.fn(async (payload: Record<string, unknown>) => {
      recorded.resumed.push(payload);
    }),
    handleRuntimeEvent: vi.fn(),
    get: vi.fn(async (sessionId: string) => indexRows.get(sessionId)),
  },
}));

const originalFlag = process.env.AICLIENT_MANAGED_CREDENTIALS;

// `as` for the same reason the shared guards need one: the exported agent
// constants are typed as the wide `AgentWireName` and cannot narrow a union.
const PLAN = {
  agent: CLAUDE_CODE_AGENT,
  permissionMode: 'plan',
} as SessionPermissionPreference;
const BYPASS = {
  agent: CLAUDE_CODE_AGENT,
  permissionMode: 'bypassPermissions',
} as SessionPermissionPreference;
const CODEX_STRICT = {
  agent: CODEX_AGENT,
  approvalPolicy: 'untrusted',
  sandboxMode: 'read-only',
} as SessionPermissionPreference;

beforeEach(async () => {
  vi.resetModules();
  handlers.clear();
  indexRows.clear();
  hostCalls.create.length = 0;
  hostCalls.resume.length = 0;
  recorded.created.length = 0;
  recorded.resumed.length = 0;
  // A different gate with its own suite; off keeps it a no-op so a red here can
  // only be the posture guard.
  process.env.AICLIENT_MANAGED_CREDENTIALS = '0';
  const { registerChatHandlers } = await import('../chat');
  registerChatHandlers();
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalFlag === undefined) delete process.env.AICLIENT_MANAGED_CREDENTIALS;
  else process.env.AICLIENT_MANAGED_CREDENTIALS = originalFlag;
});

function row(sessionId: string, extra: Partial<SessionIndexEntry> = {}): SessionIndexEntry {
  return {
    sessionId,
    workspacePath: '/repo',
    title: '',
    updatedAt: 1,
    archived: false,
    ...extra,
  } as SessionIndexEntry;
}

function invoke(channel: string, payload: unknown): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`no handler registered for ${channel}`);
  return Promise.resolve(handler({}, payload));
}

describe('C10 — a posture for the wrong agent never reaches the Host or the index', () => {
  it('a Codex posture on a Claude create is refused, and nothing is written', async () => {
    await expect(
      invoke('chat:createSession', {
        sessionId: 's1',
        workspacePath: '/repo',
        agent: CLAUDE_CODE_AGENT,
        permissionPreference: CODEX_STRICT,
      })
    ).rejects.toThrow(/permission_agent_mismatch/);
    expect(hostCalls.create).toEqual([]);
    expect(recorded.created).toEqual([]);
  });

  it('a Claude posture on a Codex create is refused too (both directions)', async () => {
    await expect(
      invoke('chat:createSession', {
        sessionId: 's1',
        workspacePath: '/repo',
        agent: CODEX_AGENT,
        permissionPreference: PLAN,
      })
    ).rejects.toThrow(/permission_agent_mismatch/);
    expect(hostCalls.create).toEqual([]);
  });

  it('a malformed posture is refused rather than dropped — a caller that asked for a limit must not be told nothing', async () => {
    await expect(
      invoke('chat:createSession', {
        sessionId: 's1',
        workspacePath: '/repo',
        agent: CLAUDE_CODE_AGENT,
        permissionPreference: { agent: CLAUDE_CODE_AGENT, permissionMode: 'yolo' },
      })
    ).rejects.toThrow(/invalid_permission_preference/);
    expect(hostCalls.create).toEqual([]);
  });

  it('C8 — a forged networkAccess claim is refused, not silently stripped', async () => {
    await expect(
      invoke('chat:createSession', {
        sessionId: 's1',
        workspacePath: '/repo',
        agent: CODEX_AGENT,
        permissionPreference: { ...CODEX_STRICT, networkAccess: true },
      })
    ).rejects.toThrow(/invalid_permission_preference/);
    expect(hostCalls.create).toEqual([]);
  });
});

describe('C9 — the snapshot outranks the template', () => {
  it('a create carrying the template captures it, on the wire and in the row, as one value', async () => {
    await invoke('chat:createSession', {
      sessionId: 's1',
      workspacePath: '/repo',
      agent: CLAUDE_CODE_AGENT,
      permissionPreference: PLAN,
    });
    expect(hostCalls.create[0].permissionPreference).toEqual(PLAN);
    expect(recorded.created[0].permissionPreference).toEqual(PLAN);
  });

  it('a re-create after a Settings edit still runs under the captured tier', async () => {
    indexRows.set('s1', row('s1', { agent: CLAUDE_CODE_AGENT, permissionPreference: PLAN }));
    await invoke('chat:createSession', {
      sessionId: 's1',
      workspacePath: '/repo',
      agent: CLAUDE_CODE_AGENT,
      // The user has since switched the global template to the dangerous tier.
      permissionPreference: BYPASS,
    });
    expect(hostCalls.create[0].permissionPreference).toEqual(PLAN);
    expect(recorded.created[0].permissionPreference).toEqual(PLAN);
  });

  it('resume takes the tier off the row and offers the renderer no way to supply one', async () => {
    indexRows.set('s1', row('s1', { agent: CLAUDE_CODE_AGENT, permissionPreference: PLAN }));
    await invoke('chat:resumeSession', {
      sessionId: 's1',
      workspacePath: '/repo',
      runtimeIdentity: 'sdk-1',
      agent: CLAUDE_CODE_AGENT,
      // Even if a renderer sent one, the handler never reads it.
      permissionPreference: BYPASS,
    });
    expect(hostCalls.resume[0].permissionPreference).toEqual(PLAN);
  });

  it('§5.5-5 — a row that never captured a posture DOES take today’s template, dangerous tier included', async () => {
    // The branch the §5.4 copy does not describe, written down here rather than
    // left to be discovered: a pre-D48 row, or one whose first send happened
    // before settings had hydrated (C15), has no posture to keep — and the next
    // `chat:createSession` captures whatever the template says now, which may
    // be the tier the user confirmed for NEW sessions.
    //
    // It is not fixable by "refuse the candidate whenever a row exists":
    // `chat:registerSession` (R5 D2) writes a row for every chat the moment it
    // appears in the sidebar, long before its first send, so that rule would
    // refuse the template for every session and delete the write side. The
    // exposure is therefore bounded and pinned, not closed.
    indexRows.set('s1', row('s1', { agent: CLAUDE_CODE_AGENT, model: 'sonnet' }));
    await invoke('chat:createSession', {
      sessionId: 's1',
      workspacePath: '/repo',
      agent: CLAUDE_CODE_AGENT,
      permissionPreference: BYPASS,
    });
    expect(hostCalls.create[0].permissionPreference).toEqual(BYPASS);
    expect(recorded.created[0].permissionPreference).toEqual(BYPASS);
  });

  it('§5.5-5 — and once that row HAS a posture, the same second create cannot move it', async () => {
    // The pair to the case above, and the one that bounds it: capture happens
    // at most once. The row below is the previous test's row after its capture.
    indexRows.set('s1', row('s1', { agent: CLAUDE_CODE_AGENT, permissionPreference: BYPASS }));
    await invoke('chat:createSession', {
      sessionId: 's1',
      workspacePath: '/repo',
      agent: CLAUDE_CODE_AGENT,
      // The user has since walked the template back to the safest tier. That is
      // a template edit, and template edits do not reach existing sessions —
      // in either direction (§5.5-2 is symmetric, deliberately: a rule that
      // only holds when it makes things safer is not a rule, it is a habit).
      permissionPreference: PLAN,
    });
    expect(hostCalls.create[0].permissionPreference).toEqual(BYPASS);
  });

  it('a snapshot that no longer matches its own row degrades to the runtime constant, not to today’s template', async () => {
    indexRows.set('s1', row('s1', { agent: CODEX_AGENT, permissionPreference: PLAN }));
    await invoke('chat:resumeSession', {
      sessionId: 's1',
      workspacePath: '/repo',
      runtimeIdentity: 'thread-1',
      agent: CODEX_AGENT,
    });
    expect(hostCalls.resume[0].permissionPreference).toBeUndefined();
  });
});

describe('C14 — a sender that knows nothing about postures is unchanged', () => {
  it('create: no key in, no key out', async () => {
    await invoke('chat:createSession', {
      sessionId: 's1',
      workspacePath: '/repo',
      agent: CLAUDE_CODE_AGENT,
    });
    expect(hostCalls.create[0].permissionPreference).toBeUndefined();
    expect(recorded.created[0].permissionPreference).toBeUndefined();
  });

  it('resume of a row with no snapshot sends nothing rather than inventing one', async () => {
    indexRows.set('s1', row('s1', { agent: CLAUDE_CODE_AGENT }));
    await invoke('chat:resumeSession', {
      sessionId: 's1',
      workspacePath: '/repo',
      runtimeIdentity: 'sdk-1',
      agent: CLAUDE_CODE_AGENT,
    });
    expect(hostCalls.resume[0].permissionPreference).toBeUndefined();
  });

  it('an explicit null is treated as absent, not as a malformed value', async () => {
    await invoke('chat:createSession', {
      sessionId: 's1',
      workspacePath: '/repo',
      agent: CLAUDE_CODE_AGENT,
      permissionPreference: null,
    });
    expect(hostCalls.create[0].permissionPreference).toBeUndefined();
  });

  it('a create with no `agent` (legacy caller) still accepts a Claude posture', async () => {
    await invoke('chat:createSession', {
      sessionId: 's1',
      workspacePath: '/repo',
      permissionPreference: PLAN,
    });
    expect(hostCalls.create[0].permissionPreference).toEqual(PLAN);
  });
});
