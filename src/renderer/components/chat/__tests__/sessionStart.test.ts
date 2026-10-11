import { describe, expect, it, vi } from 'vitest';
import type { ChatSession, ChatWorkspace } from '@/stores/chatSessions';
import { LEGACY_MIGRATION_OPERATION_FAILED } from '../sessionIndex/legacyMigration';
import {
  isSessionNotRunningError,
  runWithSessionStarted,
  SESSION_START_BUSY,
  SESSION_START_FAILED,
  SESSION_START_NO_TRANSCRIPT,
  SESSION_START_NO_WORKSPACE,
  SESSION_START_RESTARTING,
  type SessionStartDeps,
  type SessionStartOutcome,
  sessionStartFailureKey,
  startSessionAsSendDoes,
} from '../sessionStart';

/**
 * dsh-rebase decision 176 — the pure half of "start the conversation the way a
 * send does, then run": which conversations are started and with what, what a
 * failed start leaves behind (the card, not the composer's raw box), and the
 * order of start, run and the one retry when the window's belief was stale.
 */

const STUB = '/dsh-home/aiclient-sessions/aiclient-s1.dsh.json';

function session(extra: Partial<ChatSession> = {}): ChatSession {
  return {
    id: 's1',
    projectId: 'p1',
    workspaceId: 'w1',
    title: 'S1',
    status: 'idle',
    updatedAt: 1,
    runtimeIdentity: STUB,
    ...extra,
  } as ChatSession;
}

const WORKSPACE = {
  id: 'w1',
  projectId: 'p1',
  name: 'Main',
  kind: 'main',
  path: '/repo',
  branch: 'main',
  gitEnabled: true,
} as ChatWorkspace;

function deps(
  over: Partial<SessionStartDeps> & {
    running?: boolean;
    chat?: ChatSession;
    workspace?: ChatWorkspace;
  } = {}
) {
  const calls: string[] = [];
  const base: SessionStartDeps = {
    snapshot: () => ({
      running: over.running ?? false,
      session: 'chat' in over ? over.chat : session(),
      workspace: 'workspace' in over ? over.workspace : WORKSPACE,
    }),
    preferences: () => ({
      model: 'glm/glm-5',
      effort: 'high',
      permissions: { mode: 'agent', gear: 'auto' },
    }),
    ensureHost: vi.fn(async () => void calls.push('ensureHost')),
    resume: vi.fn(async () => void calls.push('resume')),
    markRunning: vi.fn((_id: string, running: boolean) => void calls.push(`running:${running}`)),
    fileFailure: vi.fn((_id: string, encoded: string) => void calls.push(`card:${encoded}`)),
    ensureScratchDirectory: vi.fn(async (sessionId: string) => {
      calls.push('scratch');
      return `/tmp/scratch/${sessionId}`;
    }),
  };
  return { deps: { ...base, ...over }, calls };
}

describe('startSessionAsSendDoes', () => {
  it('[SS-01] a running conversation is left alone', async () => {
    const { deps: d, calls } = deps({ running: true });
    await expect(startSessionAsSendDoes('s1', d)).resolves.toEqual({ kind: 'running' });
    expect(calls).toEqual([]);
  });

  it('[SS-02] the send path’s start: ensureHost, then its resume with its model, effort and permissions', async () => {
    const { deps: d, calls } = deps();
    await expect(startSessionAsSendDoes('s1', d)).resolves.toEqual({ kind: 'started' });
    expect(calls).toEqual(['ensureHost', 'resume', 'running:true']);
    expect(d.resume).toHaveBeenCalledWith({
      sessionId: 's1',
      runtimeIdentity: STUB,
      workspacePath: '/repo',
      model: 'glm/glm-5',
      effort: 'high',
      permissions: { mode: 'agent', gear: 'auto' },
    });
  });

  it('[SS-03] a temporary chat reopened after a restart resumes into the scratch directory recorded on it', async () => {
    const { deps: d } = deps({
      chat: session({
        projectId: '',
        workspaceId: '',
        unbound: { workspacePath: '/tmp/scratch/recorded' },
      }),
      // What the store answers for `workspaceId: ''`.
      workspace: undefined,
    });
    await startSessionAsSendDoes('s1', d);
    expect(d.resume).toHaveBeenCalledWith(
      expect.objectContaining({ workspacePath: '/tmp/scratch/recorded' })
    );
    // Recorded: nothing to ask Main for.
    expect(d.ensureScratchDirectory).not.toHaveBeenCalled();
  });

  it('[SS-03b] a temporary chat made in this run (no record, no folder): the send path’s scratch directory, then its resume', async () => {
    // GUI point-check 2026-10-11: such a chat carries no `unbound` until a
    // restart, and the start refused it 「这个对话没有可以运行的文件夹」 while a
    // send in the same chat went through. It asks what the send asks.
    const { deps: d, calls } = deps({
      chat: session({ projectId: '', workspaceId: '' }),
      workspace: undefined,
    });
    await expect(startSessionAsSendDoes('s1', d)).resolves.toEqual({ kind: 'started' });
    expect(d.ensureScratchDirectory).toHaveBeenCalledWith('s1');
    expect(calls).toEqual(['scratch', 'ensureHost', 'resume', 'running:true']);
    expect(d.resume).toHaveBeenCalledWith({
      sessionId: 's1',
      runtimeIdentity: STUB,
      workspacePath: '/tmp/scratch/s1',
      model: 'glm/glm-5',
      effort: 'high',
      permissions: { mode: 'agent', gear: 'auto' },
    });
  });

  it('[SS-03c] a folder this window cannot run in is no folder, as the send path reads it', async () => {
    // The send path's own rule (`cwd`, then the record, then the scratch
    // directory): an empty path is not a folder to run in.
    const { deps: d } = deps({ workspace: { ...WORKSPACE, path: '  ' } });
    await startSessionAsSendDoes('s1', d);
    expect(d.ensureScratchDirectory).toHaveBeenCalledWith('s1');
    expect(d.resume).toHaveBeenCalledWith(
      expect.objectContaining({ workspacePath: '/tmp/scratch/s1' })
    );
  });

  it('[SS-04] what it does not start: no row, never ran, no folder to be had, a turn already running', async () => {
    const refused = async (over: Parameters<typeof deps>[0]) => {
      const { deps: d } = deps(over);
      const outcome = await startSessionAsSendDoes('s1', d);
      expect(d.ensureHost).not.toHaveBeenCalled();
      expect(d.resume).not.toHaveBeenCalled();
      return { outcome, d };
    };
    await expect(refused({ chat: undefined }).then((r) => r.outcome)).resolves.toEqual({
      kind: 'refused',
      reason: 'no-session',
    });
    // A send would create it; an operation has nothing to act on in it.
    await expect(
      refused({ chat: session({ runtimeIdentity: undefined }) }).then((r) => r.outcome)
    ).resolves.toEqual({ kind: 'refused', reason: 'no-transcript' });
    // No folder, and Main gave it no scratch directory either.
    const noFolder = await refused({
      chat: session({ projectId: '', workspaceId: '' }),
      workspace: undefined,
      ensureScratchDirectory: vi.fn(async () => {
        throw new Error('chat:ensureScratchWorkspace returned no path');
      }),
    });
    expect(noFolder.outcome).toEqual({ kind: 'refused', reason: 'no-workspace' });
    expect(noFolder.d.fileFailure).not.toHaveBeenCalled();
    await expect(
      refused({ chat: session({ status: 'running' }) }).then((r) => r.outcome)
    ).resolves.toEqual({ kind: 'refused', reason: 'busy' });
    // A temporary chat mid-turn is refused before a directory is asked for.
    const busyTemporary = await refused({
      chat: session({ projectId: '', workspaceId: '', status: 'running' }),
      workspace: undefined,
    });
    expect(busyTemporary.outcome).toEqual({ kind: 'refused', reason: 'busy' });
    expect(busyTemporary.d.ensureScratchDirectory).not.toHaveBeenCalled();
  });

  it('[SS-05] a failed start is filed on the card, as a send’s is — and nothing is said raw elsewhere', async () => {
    const { deps: d, calls } = deps({
      resume: vi.fn(async () => {
        throw new Error(
          "Error invoking remote method 'chat:resumeSession': Error: pi_session_workspace_mismatch: Indexed workspace does not match the resume request"
        );
      }),
    });
    await expect(startSessionAsSendDoes('s1', d)).resolves.toEqual({
      kind: 'failed',
      code: 'session_cwd_mismatch',
    });
    expect(calls).toEqual([
      'ensureHost',
      'running:false',
      "card:session_cwd_mismatch: Error invoking remote method 'chat:resumeSession': Error: pi_session_workspace_mismatch: Indexed workspace does not match the resume request",
    ]);
  });

  it('[SS-06] Main reopening it after an engine restart, or a turn Main knows of: refused, no card', async () => {
    for (const [text, reason] of [
      ['Error: session_not_ready: Pi WorkerSlot for s1 is restarting', 'restarting'],
      ['Error: session_busy: Session s1 cannot resume while active', 'busy'],
    ] as const) {
      const { deps: d } = deps({
        resume: vi.fn(async () => {
          throw new Error(`Error invoking remote method 'chat:resumeSession': ${text}`);
        }),
      });
      await expect(startSessionAsSendDoes('s1', d)).resolves.toEqual({ kind: 'refused', reason });
      expect(d.fileFailure).not.toHaveBeenCalled();
    }
  });

  it('[SS-07] a host that cannot start is a failure too, filed as the engine card', async () => {
    const { deps: d } = deps({
      ensureHost: vi.fn(async () => {
        throw new Error('Error: dsh_host_unavailable: DSH_HOST_START_FAILED: refused');
      }),
    });
    await expect(startSessionAsSendDoes('s1', d)).resolves.toEqual({
      kind: 'failed',
      code: 'engine_unavailable',
    });
    expect(d.resume).not.toHaveBeenCalled();
  });
});

describe('runWithSessionStarted', () => {
  function effects(outcome: SessionStartOutcome = { kind: 'started' }, running = false) {
    const order: string[] = [];
    return {
      order,
      start: vi.fn(async () => {
        order.push('start');
        return outcome;
      }),
      isRunning: vi.fn(() => running),
      forgetRunning: vi.fn(() => void order.push('forget')),
      onPhase: vi.fn((phase: string) => void order.push(`phase:${phase}`)),
    };
  }

  it('[RS-01] not running: start, then run', async () => {
    const e = effects();
    const operation = vi.fn(async () => {
      e.order.push('operation');
      return 'tree';
    });
    await expect(runWithSessionStarted({ sessionId: 's1', operation, ...e })).resolves.toEqual({
      kind: 'done',
      value: 'tree',
      started: true,
    });
    expect(e.order).toEqual(['phase:starting', 'start', 'phase:running', 'operation']);
  });

  it('[RS-02] running: run, no start', async () => {
    const e = effects({ kind: 'started' }, true);
    const operation = vi.fn(async () => 'tree');
    await expect(runWithSessionStarted({ sessionId: 's1', operation, ...e })).resolves.toEqual({
      kind: 'done',
      value: 'tree',
      started: false,
    });
    expect(e.start).not.toHaveBeenCalled();
    expect(e.order).toEqual(['phase:running']);
  });

  it('[RS-03] a start that did not happen runs nothing', async () => {
    const e = effects({ kind: 'failed', code: 'session_cwd_mismatch' });
    const operation = vi.fn(async () => 'tree');
    await expect(runWithSessionStarted({ sessionId: 's1', operation, ...e })).resolves.toEqual({
      kind: 'not-started',
      start: { kind: 'failed', code: 'session_cwd_mismatch' },
    });
    expect(operation).not.toHaveBeenCalled();
  });

  it('[RS-04] the window believed it running and Main had no slot: forget, start, run once more', async () => {
    const e = effects({ kind: 'started' }, true);
    const operation = vi
      .fn()
      .mockRejectedValueOnce(
        new Error(
          "Error invoking remote method 'chat:compactSession': Error: session_not_found: Session s1 is not running on the DSH host"
        )
      )
      .mockResolvedValueOnce('compacted');
    await expect(runWithSessionStarted({ sessionId: 's1', operation, ...e })).resolves.toEqual({
      kind: 'done',
      value: 'compacted',
      started: true,
    });
    expect(e.order).toEqual([
      'phase:running',
      'forget',
      'phase:starting',
      'start',
      'phase:running',
    ]);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('[RS-05] gone again right after this call started it: not tried a third time', async () => {
    const e = effects();
    const gone = new Error('session_not_found: Session s1 is not running on the DSH host');
    const operation = vi.fn(async () => {
      throw gone;
    });
    await expect(runWithSessionStarted({ sessionId: 's1', operation, ...e })).rejects.toBe(gone);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(e.start).toHaveBeenCalledTimes(1);
  });

  it('[RS-06] any other failure is the operation’s own, and goes out as it came', async () => {
    const e = effects({ kind: 'started' }, true);
    const other = new Error('WORKER_FORK_FAILED: stop here');
    const operation = vi.fn(async () => {
      throw other;
    });
    await expect(runWithSessionStarted({ sessionId: 's1', operation, ...e })).rejects.toBe(other);
    expect(e.start).not.toHaveBeenCalled();
  });

  it('[RS-07] ended while it was being started: the operation is not run on what is left', async () => {
    const e = effects();
    const operation = vi.fn(async () => 'compacted');
    await expect(
      runWithSessionStarted({ sessionId: 's1', operation, ...e, cancelled: () => true })
    ).resolves.toEqual({ kind: 'cancelled' });
    expect(operation).not.toHaveBeenCalled();
  });

  it('[RS-08] a 1.0.x chat Main refuses as not moved yet is started (which moves it) and asked again', async () => {
    const e = effects({ kind: 'started' }, true);
    const operation = vi
      .fn()
      .mockRejectedValueOnce(
        new Error('legacy_migration_required: Session s1 was written by the previous chat engine')
      )
      .mockResolvedValueOnce('tree');
    await expect(
      runWithSessionStarted({ sessionId: 's1', operation, ...e })
    ).resolves.toMatchObject({
      kind: 'done',
      value: 'tree',
    });
  });
});

describe('the words for a start that did not happen', () => {
  it('[SK-01] one key per reason; a 1.0.x chat that could not be moved keeps its own', () => {
    expect(sessionStartFailureKey({ kind: 'failed', code: 'session_cwd_mismatch' })).toBe(
      SESSION_START_FAILED
    );
    expect(sessionStartFailureKey({ kind: 'failed', code: 'legacy_migration_failed' })).toBe(
      LEGACY_MIGRATION_OPERATION_FAILED
    );
    expect(sessionStartFailureKey({ kind: 'refused', reason: 'restarting' })).toBe(
      SESSION_START_RESTARTING
    );
    expect(sessionStartFailureKey({ kind: 'refused', reason: 'busy' })).toBe(SESSION_START_BUSY);
    expect(sessionStartFailureKey({ kind: 'refused', reason: 'no-transcript' })).toBe(
      SESSION_START_NO_TRANSCRIPT
    );
    expect(sessionStartFailureKey({ kind: 'refused', reason: 'no-workspace' })).toBe(
      SESSION_START_NO_WORKSPACE
    );
  });

  it('[SK-02] not running is read off its code, never off pi_session_not_found', () => {
    expect(isSessionNotRunningError(new Error('session_not_found: gone'))).toBe(true);
    expect(isSessionNotRunningError('legacy_migration_required: move it')).toBe(true);
    expect(isSessionNotRunningError(new Error('pi_session_not_found: No indexed session'))).toBe(
      false
    );
    expect(isSessionNotRunningError(new Error('session_busy: busy'))).toBe(false);
  });
});
