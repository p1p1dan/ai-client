import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CLAUDE_CODE_AGENT, CODEX_AGENT } from '@shared/types/agentWire';
import type {
  SessionPermissionPreference,
  SessionPermissionUpdatedEvent,
} from '@shared/types/runtimeEvents';
import type { SessionIndexEntry } from '@shared/types/sessionIndex';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * D48 S4 §6.3 — Main's half of a mid-session permission change.
 *
 * Main is the only process holding BOTH the session snapshot and the incoming
 * request, so three decisions can only be made here and each has a failure that
 * outlives the moment:
 *
 *  · D10 — the snapshot may only move when the change actually landed. A
 *    snapshot written ahead of the Host would make the next resume replay a
 *    posture the session never ran under, and resume trusts the snapshot over
 *    everything else (C9).
 *  · D11 — the change must not touch the `ChatAgentDefaults` template. One
 *    temporary escalation becoming the default for every future chat is the
 *    silent-privilege-expansion path R18 names.
 *  · R18 — a dangerous tier without an explicit confirmation is refused BEFORE
 *    the Host is contacted. The renderer's dialog is a UX affordance; this is
 *    the boundary.
 *
 * Harness is `chatPermissionPreferenceGuard.test.ts`'s, for the same reason: a
 * refusal only means something if it is observable as "the Host was never
 * called and the row never moved".
 */

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const indexRows = new Map<string, SessionIndexEntry>();

const hostCalls = {
  update: [] as Array<Record<string, unknown>>,
};
const snapshotWrites: Array<{ sessionId: string; preference: SessionPermissionPreference }> = [];

/** What the Host answers next. Swapped per test to drive the failure arms. */
const hostReply: {
  event?: SessionPermissionUpdatedEvent;
  error?: Error;
} = {};

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
    createSession: vi.fn(async () => 'req-create'),
    resumeSession: vi.fn(async () => 'req-resume'),
    sendMessage: vi.fn(async () => 'req-send'),
    updateSessionPermission: vi.fn(async (payload: Record<string, unknown>) => {
      hostCalls.update.push(payload);
      if (hostReply.error) throw hostReply.error;
      return hostReply.event;
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
    setPermissionPreference: vi.fn(
      async (sessionId: string, preference: SessionPermissionPreference) => {
        snapshotWrites.push({ sessionId, preference });
        const row = indexRows.get(sessionId);
        if (!row) return false;
        indexRows.set(sessionId, { ...row, permissionPreference: preference });
        return true;
      }
    ),
  },
}));

const originalFlag = process.env.AICLIENT_MANAGED_CREDENTIALS;

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
const CODEX_DANGER = {
  agent: CODEX_AGENT,
  approvalPolicy: 'never',
  sandboxMode: 'danger-full-access',
} as SessionPermissionPreference;

function ack(
  preference: SessionPermissionPreference,
  effective: 'immediately' | 'next_turn' = 'next_turn'
): SessionPermissionUpdatedEvent {
  return {
    type: 'session.permissionUpdated',
    seq: 1,
    timestamp: 1,
    sessionId: 's1',
    requestId: 'perm-update-1',
    payload: { preference, effective },
  };
}

beforeEach(async () => {
  vi.resetModules();
  handlers.clear();
  indexRows.clear();
  hostCalls.update.length = 0;
  snapshotWrites.length = 0;
  hostReply.event = ack(PLAN);
  hostReply.error = undefined;
  // A different gate with its own suite; off keeps it a no-op so a red here can
  // only be the update path.
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

describe('the binding comes off the row, and an unresolvable one stands the change down', () => {
  it('forwards a matching posture and reports when it applies', async () => {
    indexRows.set('s1', row('s1', { agent: CODEX_AGENT }));
    hostReply.event = ack(CODEX_STRICT, 'immediately');

    const result = await invoke('chat:updatePermission', {
      sessionId: 's1',
      permissionPreference: CODEX_STRICT,
    });

    expect(hostCalls.update).toEqual([{ sessionId: 's1', permissionPreference: CODEX_STRICT }]);
    // `effective` is the Host's answer, not a guess made from the agent name.
    expect(result).toEqual({
      requestId: 'perm-update-1',
      preference: CODEX_STRICT,
      effective: 'immediately',
    });
  });

  it('refuses a session with no indexed binding, before the Host is contacted', async () => {
    // `chat:send` stands down when the binding is unknown and lets the Host
    // route the message. This command cannot: it would have to pick which half
    // of the preference union to validate, and picking wrong validates nothing.
    await expect(
      invoke('chat:updatePermission', { sessionId: 'ghost', permissionPreference: PLAN })
    ).rejects.toThrow(/session_binding_unknown/);
    expect(hostCalls.update).toEqual([]);
    expect(snapshotWrites).toEqual([]);
  });

  it('refuses a posture addressed to the other agent, in both directions', async () => {
    indexRows.set('s1', row('s1', { agent: CLAUDE_CODE_AGENT }));
    await expect(
      invoke('chat:updatePermission', { sessionId: 's1', permissionPreference: CODEX_STRICT })
    ).rejects.toThrow(/permission_agent_mismatch/);

    indexRows.set('s2', row('s2', { agent: CODEX_AGENT }));
    await expect(
      invoke('chat:updatePermission', { sessionId: 's2', permissionPreference: PLAN })
    ).rejects.toThrow(/permission_agent_mismatch/);

    expect(hostCalls.update).toEqual([]);
    expect(snapshotWrites).toEqual([]);
  });

  it('refuses a malformed posture and a forged networkAccess claim', async () => {
    indexRows.set('s1', row('s1', { agent: CODEX_AGENT }));
    for (const bad of [
      undefined,
      {},
      'never',
      { agent: CODEX_AGENT, approvalPolicy: 'yolo', sandboxMode: 'read-only' },
      // The one dimension the runtime REPORTS and nothing requests: accepting
      // the claim would let a caller believe it configured what nothing does.
      {
        agent: CODEX_AGENT,
        approvalPolicy: 'never',
        sandboxMode: 'read-only',
        networkAccess: true,
      },
    ]) {
      await expect(
        invoke('chat:updatePermission', { sessionId: 's1', permissionPreference: bad })
      ).rejects.toThrow(/invalid_permission_preference/);
    }
    expect(hostCalls.update).toEqual([]);
  });
});

describe('R18 — a dangerous tier is refused unless the confirmation is stated', () => {
  it('holds both dangerous tiers, and the Host is never called', async () => {
    indexRows.set('s1', row('s1', { agent: CLAUDE_CODE_AGENT }));
    indexRows.set('s2', row('s2', { agent: CODEX_AGENT }));

    await expect(
      invoke('chat:updatePermission', { sessionId: 's1', permissionPreference: BYPASS })
    ).rejects.toThrow(/dangerous_tier_unconfirmed/);
    await expect(
      invoke('chat:updatePermission', { sessionId: 's2', permissionPreference: CODEX_DANGER })
    ).rejects.toThrow(/dangerous_tier_unconfirmed/);
    // Not "the dialog was skipped so we asked anyway": nothing leaves Main.
    expect(hostCalls.update).toEqual([]);
    expect(snapshotWrites).toEqual([]);
  });

  it('a false confirmation is the same as none (the flag is read, not merely present)', async () => {
    indexRows.set('s1', row('s1', { agent: CLAUDE_CODE_AGENT }));
    await expect(
      invoke('chat:updatePermission', {
        sessionId: 's1',
        permissionPreference: BYPASS,
        dangerousConfirmed: false,
      })
    ).rejects.toThrow(/dangerous_tier_unconfirmed/);
    expect(hostCalls.update).toEqual([]);
  });

  it('a confirmed dangerous tier is applied, and the flag travels with it', async () => {
    indexRows.set('s1', row('s1', { agent: CLAUDE_CODE_AGENT }));
    hostReply.event = ack(BYPASS);

    await invoke('chat:updatePermission', {
      sessionId: 's1',
      permissionPreference: BYPASS,
      dangerousConfirmed: true,
    });

    // Forwarded so the Host can refuse it a second time — the same two-wall
    // shape the create/resume posture check uses.
    expect(hostCalls.update).toEqual([
      { sessionId: 's1', permissionPreference: BYPASS, dangerousConfirmed: true },
    ]);
  });

  it('the confirmation flag grants nothing on a safe tier (negative half)', async () => {
    indexRows.set('s1', row('s1', { agent: CLAUDE_CODE_AGENT }));
    await invoke('chat:updatePermission', {
      sessionId: 's1',
      permissionPreference: PLAN,
      dangerousConfirmed: true,
    });
    // Present in the payload because the caller sent it, and it changed nothing
    // about which tier was applied.
    expect(hostCalls.update[0].permissionPreference).toEqual(PLAN);
  });
});

describe('D10 — the session snapshot moves only when the change landed', () => {
  it('writes the snapshot from the Host ECHO, after the Host confirmed', async () => {
    indexRows.set('s1', row('s1', { agent: CLAUDE_CODE_AGENT, permissionPreference: PLAN }));
    const applied = {
      agent: CLAUDE_CODE_AGENT,
      permissionMode: 'acceptEdits',
    } as SessionPermissionPreference;
    hostReply.event = ack(applied);

    await invoke('chat:updatePermission', { sessionId: 's1', permissionPreference: applied });

    expect(snapshotWrites).toEqual([{ sessionId: 's1', preference: applied }]);
    expect(indexRows.get('s1')?.permissionPreference).toEqual(applied);
  });

  it('leaves the row byte-identical when the Host refuses', async () => {
    const before = row('s1', { agent: CODEX_AGENT, permissionPreference: CODEX_STRICT });
    indexRows.set('s1', before);
    hostReply.error = new Error('session_busy: a turn is running');

    await expect(
      invoke('chat:updatePermission', {
        sessionId: 's1',
        permissionPreference: {
          agent: CODEX_AGENT,
          approvalPolicy: 'never',
          sandboxMode: 'workspace-write',
        },
      })
    ).rejects.toThrow(/session_busy/);

    expect(snapshotWrites).toEqual([]);
    // Byte-identical, not merely "still a posture": a resume replays this value.
    expect(indexRows.get('s1')).toBe(before);
  });

  it('an old Host answering not_implemented is a failure, not a silent success', async () => {
    // `capabilities.permissionPolicy` keeps the control off an old Host (D15);
    // this is the backstop for anything that got past that.
    indexRows.set('s1', row('s1', { agent: CLAUDE_CODE_AGENT }));
    hostReply.error = new Error('not_implemented: Unknown command: session.updatePermission');

    await expect(
      invoke('chat:updatePermission', { sessionId: 's1', permissionPreference: PLAN })
    ).rejects.toThrow(/not_implemented/);
    expect(snapshotWrites).toEqual([]);
    expect(indexRows.get('s1')?.permissionPreference).toBeUndefined();
  });

  it('the snapshot it writes is the one a later resume replays (C9 chain)', async () => {
    indexRows.set('s1', row('s1', { agent: CODEX_AGENT }));
    hostReply.event = ack(CODEX_STRICT, 'immediately');
    await invoke('chat:updatePermission', { sessionId: 's1', permissionPreference: CODEX_STRICT });

    // Resume passes NO candidate; it reads the row. So the value written above
    // is exactly what the next resume hands the Host.
    const { agentHostManager } = (await import(
      '../../services/agent-host/AgentHostManager'
    )) as unknown as { agentHostManager: { resumeSession: ReturnType<typeof vi.fn> } };
    agentHostManager.resumeSession.mockClear();
    await invoke('chat:resumeSession', {
      sessionId: 's1',
      runtimeIdentity: 'thread-1',
      workspacePath: '/repo',
      agent: CODEX_AGENT,
    });
    expect(agentHostManager.resumeSession.mock.calls[0][0]).toMatchObject({
      permissionPreference: CODEX_STRICT,
    });
  });
});

describe('D11 — a mid-session change never reaches the global template', () => {
  const source = readFileSync(path.resolve(import.meta.dirname, '..', 'chat.ts'), 'utf8');

  it('the Main chat IPC module cannot reach app settings at all', () => {
    // A static scan, because the runtime assertion ("the template did not
    // change") can only be made where the template lives — the renderer. This
    // one proves the Main half has no door: every import here is a Host, index,
    // auth or shared-types module.
    for (const forbidden of ['chatAgentDefaults', 'settings/', 'useSettingsStore']) {
      expect(source).not.toContain(`from '${forbidden}`);
      expect(source).not.toContain(`from '@shared/models/${forbidden}`);
    }
  });

  it('the update handler writes exactly one thing, and it is the session row', async () => {
    indexRows.set('s1', row('s1', { agent: CLAUDE_CODE_AGENT }));
    const { sessionIndexService } = (await import(
      '../../services/chat/SessionIndexService'
    )) as unknown as { sessionIndexService: Record<string, ReturnType<typeof vi.fn>> };
    sessionIndexService.recordCreated.mockClear();
    sessionIndexService.recordResumed.mockClear();

    await invoke('chat:updatePermission', { sessionId: 's1', permissionPreference: PLAN });

    expect(snapshotWrites).toHaveLength(1);
    // Not through the capture paths: those are first-write-wins and would drop
    // the change on the floor, which is how "the change appeared to work and
    // did not survive a restart" happens.
    expect(sessionIndexService.recordCreated).not.toHaveBeenCalled();
    expect(sessionIndexService.recordResumed).not.toHaveBeenCalled();
  });
});
