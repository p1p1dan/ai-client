import { zhTranslations } from '@shared/i18n';
import { PI_AGENT } from '@shared/types/agentWire';
import { LEGACY_FORK_TITLE_KEY, type LegacyMigrationSummary } from '@shared/types/legacyMigration';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatSessionsStore } from '@/stores/chatSessions';
import { selectIsMigrating, useLegacyMigrationStore } from '@/stores/legacyMigration';
import {
  SESSION_MODEL_STORAGE_KEY,
  SESSION_PERMISSIONS_STORAGE_KEY,
} from '../../sessionPreferenceStore';
import {
  applyLegacyMigrationSummary,
  isLegacyMigrationRequiredError,
  LEGACY_MIGRATION_OPERATION_FAILED,
  LEGACY_MIGRATION_PROGRESS_DETAIL,
  LEGACY_MIGRATION_PROGRESS_TITLE,
  type MigratingResumeDeps,
  noteForkTitleInStore,
  type ResumeSessionAnswer,
  type ResumeSessionArgs,
  resumeSessionWithMigration,
  runAfterLegacyMigration,
} from '../legacyMigration';

/**
 * dsh-rebase P1-9e (decisions 050, 051, 121, 122, 123) — the renderer's half of
 * moving a 1.0.x chat to the current engine: "migrating" while the resume that
 * moves it is in flight, the answer's summary applied (preferences copied to
 * the legacy row's new key, the posture Main fell back to written where the
 * chip reads it), and an engine operation refused as `legacy_migration_required`
 * re-run after a resume.
 */

const ARGS: ResumeSessionArgs = {
  sessionId: 's1',
  runtimeIdentity: '/profile/pi-agent/sessions/s1.jsonl',
  workspacePath: '/repo',
};

function summary(over: Partial<LegacyMigrationSummary> = {}): LegacyMigrationSummary {
  return {
    legacySessionId: 's1_pi',
    reused: false,
    converted: 'source',
    images: { admitted: 0, refused: 0 },
    grants: 0,
    legacyPermissions: null,
    legacyPermissionsApplied: false,
    ...over,
  };
}

function deps(over: Partial<MigratingResumeDeps> = {}) {
  const calls: string[] = [];
  const base: MigratingResumeDeps = {
    invoke: vi.fn(async () => ({ requestId: 'r1' }) as ResumeSessionAnswer),
    migrates: vi.fn(() => true),
    begin: vi.fn((id: string) => void calls.push(`begin:${id}`)),
    end: vi.fn((id: string) => void calls.push(`end:${id}`)),
    applySummary: vi.fn(),
  };
  return { deps: { ...base, ...over }, calls };
}

beforeEach(() => {
  useLegacyMigrationStore.setState({ migrating: {}, postureRevisions: {} });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resumeSessionWithMigration', () => {
  it('marks the chat as migrating for exactly as long as the resume that moves it', async () => {
    let settle: (answer: ResumeSessionAnswer) => void = () => undefined;
    const { deps: d, calls } = deps({
      invoke: vi.fn(
        () =>
          new Promise<ResumeSessionAnswer>((resolve) => {
            settle = resolve;
          })
      ),
    });
    const pending = resumeSessionWithMigration(ARGS, d);
    expect(calls).toEqual(['begin:s1']);
    settle({ requestId: 'r1', migration: summary() });
    await expect(pending).resolves.toEqual({ requestId: 'r1', migration: summary() });
    expect(calls).toEqual(['begin:s1', 'end:s1']);
    expect(d.applySummary).toHaveBeenCalledWith('s1', summary());
  });

  it('ends the mark on a failed move too, and rejects exactly as the call did', async () => {
    const failure = new Error(
      'legacy_migration_failed:read/source_busy: Session s1 could not be moved to the current chat engine (retryable)'
    );
    const { deps: d, calls } = deps({ invoke: vi.fn(async () => Promise.reject(failure)) });
    await expect(resumeSessionWithMigration(ARGS, d)).rejects.toBe(failure);
    expect(calls).toEqual(['begin:s1', 'end:s1']);
    expect(d.applySummary).not.toHaveBeenCalled();
  });

  it('marks nothing for a chat that will not move, and applies no summary it did not get', async () => {
    const { deps: d, calls } = deps({ migrates: vi.fn(() => false) });
    await expect(resumeSessionWithMigration(ARGS, d)).resolves.toEqual({ requestId: 'r1' });
    expect(calls).toEqual([]);
    expect(d.applySummary).not.toHaveBeenCalled();
    expect(d.invoke).toHaveBeenCalledWith(ARGS);
  });

  it('a summary that cannot be applied does not undo a resume that succeeded', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { deps: d } = deps({
      invoke: vi.fn(async () => ({ requestId: 'r1', migration: summary() })),
      applySummary: vi.fn(() => {
        throw new Error('storage full');
      }),
    });
    await expect(resumeSessionWithMigration(ARGS, d)).resolves.toMatchObject({ requestId: 'r1' });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('by default, reads the prediction off the store and reaches Main through the preload', async () => {
    let settle: (answer: ResumeSessionAnswer) => void = () => undefined;
    const resumeSession = vi.fn(
      () =>
        new Promise<ResumeSessionAnswer>((resolve) => {
          settle = resolve;
        })
    );
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    vi.stubGlobal('window', { electronAPI: { chat: { resumeSession } } });
    useChatSessionsStore.setState({
      sessions: [
        {
          id: 's1',
          projectId: 'p1',
          workspaceId: 'w1',
          title: 'Legacy',
          status: 'idle',
          updatedAt: 1,
          agent: PI_AGENT,
          runtimeIdentity: ARGS.runtimeIdentity,
        },
      ],
    });
    storage.set(SESSION_MODEL_STORAGE_KEY, JSON.stringify({ s1: 'glm/glm-5' }));

    const pending = resumeSessionWithMigration(ARGS);
    expect(selectIsMigrating(useLegacyMigrationStore.getState(), 's1')).toBe(true);
    settle({
      requestId: 'r1',
      migration: summary({
        legacyPermissions: { mode: 'plan', gear: 'ask' },
        legacyPermissionsApplied: true,
      }),
    });
    await pending;

    expect(resumeSession).toHaveBeenCalledWith(ARGS);
    expect(selectIsMigrating(useLegacyMigrationStore.getState(), 's1')).toBe(false);
    expect(JSON.parse(storage.get(SESSION_MODEL_STORAGE_KEY) ?? '{}')).toEqual({
      s1: 'glm/glm-5',
      s1_pi: 'glm/glm-5',
    });
    expect(JSON.parse(storage.get(SESSION_PERMISSIONS_STORAGE_KEY) ?? '{}')).toEqual({
      s1: { mode: 'plan', gear: 'ask' },
    });
    expect(useLegacyMigrationStore.getState().postureRevisions.s1).toBe(1);
  });
});

describe('applyLegacyMigrationSummary', () => {
  const effects = () => ({
    copyPreferences: vi.fn(),
    writePermissions: vi.fn(),
    notePostureSynced: vi.fn(),
    noteForkTitle: vi.fn(),
  });

  it('copies the chat’s preferences to the key its legacy row now lives under', () => {
    const e = effects();
    applyLegacyMigrationSummary('s1', summary({ reused: true }), e);
    expect(e.copyPreferences).toHaveBeenCalledWith('s1', 's1_pi');
    expect(e.writePermissions).not.toHaveBeenCalled();
    expect(e.notePostureSynced).not.toHaveBeenCalled();
  });

  it('writes the posture Main fell back to, after the copy, and tells the chip', () => {
    const order: string[] = [];
    const e = {
      copyPreferences: vi.fn(() => void order.push('copy')),
      writePermissions: vi.fn(() => void order.push('write')),
      notePostureSynced: vi.fn(() => void order.push('note')),
      noteForkTitle: vi.fn(() => void order.push('fork')),
    };
    applyLegacyMigrationSummary(
      's1',
      summary({
        legacyPermissions: { mode: 'agent', gear: 'accept-edits' },
        legacyPermissionsApplied: true,
      }),
      e
    );
    expect(order).toEqual(['copy', 'write', 'note']);
    expect(e.writePermissions).toHaveBeenCalledWith('s1', { mode: 'agent', gear: 'accept-edits' });
    expect(e.notePostureSynced).toHaveBeenCalledWith('s1');
  });

  it('reverse: a posture the renderer named, or one that is not a posture, is left alone', () => {
    for (const over of [
      { legacyPermissions: { mode: 'agent', gear: 'ask' }, legacyPermissionsApplied: false },
      { legacyPermissions: null, legacyPermissionsApplied: true },
      {
        legacyPermissions: { mode: 'goal', gear: 'ask' } as never,
        legacyPermissionsApplied: true,
      },
    ] as const) {
      const e = effects();
      applyLegacyMigrationSummary('s1', summary(over), e);
      expect(e.writePermissions, JSON.stringify(over)).not.toHaveBeenCalled();
      expect(e.notePostureSynced).not.toHaveBeenCalled();
    }
  });

  it('[D131-FORK-1] a chat moved over from a 1.0.x continuation takes the interim title Main gave it', () => {
    const e = effects();
    applyLegacyMigrationSummary('s1_pi', summary({ fork: { title: 'Notes（1.0.x 分支）' } }), e);
    expect(e.noteForkTitle).toHaveBeenCalledWith('s1_pi', 'Notes（1.0.x 分支）');
    // Reverse: an ordinary migration renames nothing.
    const plain = effects();
    applyLegacyMigrationSummary('s1', summary(), plain);
    expect(plain.noteForkTitle).not.toHaveBeenCalled();
  });
});

describe('noteForkTitleInStore (decision 131)', () => {
  afterEach(() => {
    useChatSessionsStore.setState({ sessions: [] });
  });

  it('[D131-FORK-2] the live row reads the interim title and waits for its first message', () => {
    useChatSessionsStore.setState({
      sessions: [
        {
          id: 's1',
          projectId: 'p',
          workspaceId: 'w',
          title: 'Notes',
          status: 'idle',
          updatedAt: 1,
        },
        {
          id: 's1_pi',
          projectId: 'p',
          workspaceId: 'w',
          title: 'Notes',
          status: 'idle',
          updatedAt: 1,
        },
      ],
    });
    noteForkTitleInStore('s1_pi', 'Notes (1.0.x branch)');
    const [original, fork] = useChatSessionsStore.getState().sessions;
    expect(original).toMatchObject({ title: 'Notes' });
    expect(original?.forkTitlePending).toBeUndefined();
    expect(fork).toMatchObject({ title: 'Notes (1.0.x branch)', forkTitlePending: true });
  });

  it('[D131-FORK-3] reverse: an untitled chat keeps its placeholder, and still waits', () => {
    useChatSessionsStore.setState({
      sessions: [
        {
          id: 'x_pi',
          projectId: 'p',
          workspaceId: 'w',
          title: 'Session x_pi',
          status: 'idle',
          updatedAt: 1,
        },
      ],
    });
    noteForkTitleInStore('x_pi', '');
    expect(useChatSessionsStore.getState().sessions[0]).toMatchObject({
      title: 'Session x_pi',
      forkTitlePending: true,
    });
  });

  it('[D131-FORK-4] the suffix has both languages, keyed by the constant Main words it with', () => {
    expect(LEGACY_FORK_TITLE_KEY).toBe('{{title}} (1.0.x branch)');
    expect(zhTranslations[LEGACY_FORK_TITLE_KEY]).toBe('{{title}}（1.0.x 分支）');
  });
});

describe('runAfterLegacyMigration', () => {
  const REQUIRED = new Error(
    "Error invoking remote method 'chat:getSessionTree': Error: legacy_migration_required: Session s1 was written by the previous chat engine; resume it first, which moves it to the current engine"
  );

  it('recognises the refusal inside Electron’s wrapper, and only it', () => {
    expect(isLegacyMigrationRequiredError(REQUIRED)).toBe(true);
    expect(isLegacyMigrationRequiredError('legacy_migration_required: x')).toBe(true);
    for (const other of [
      new Error('legacy_migration_failed:read/source_missing: x'),
      new Error('xlegacy_migration_required: x'),
      new Error('legacy_migration_required_soon: x'),
      null,
      undefined,
    ]) {
      expect(isLegacyMigrationRequiredError(other), String(other)).toBe(false);
    }
  });

  it('runs the operation alone when the chat is already on the current engine', async () => {
    const resume = vi.fn(async () => true);
    await expect(runAfterLegacyMigration('s1', async () => 'tree', resume)).resolves.toBe('tree');
    expect(resume).not.toHaveBeenCalled();
  });

  it('resumes a chat not moved yet, then asks once more', async () => {
    const operation = vi.fn().mockRejectedValueOnce(REQUIRED).mockResolvedValueOnce('tree');
    const resume = vi.fn(async () => true);
    await expect(runAfterLegacyMigration('s1', operation, resume)).resolves.toBe('tree');
    expect(resume).toHaveBeenCalledWith('s1');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('a move that failed rethrows the refusal, and asks nothing again', async () => {
    const operation = vi.fn().mockRejectedValue(REQUIRED);
    const resume = vi.fn(async () => false);
    await expect(runAfterLegacyMigration('s1', operation, resume)).rejects.toBe(REQUIRED);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('any other failure passes through without a resume', async () => {
    const other = new Error('WORKER_REWIND_JOBS_RUNNING: a job runs');
    const resume = vi.fn(async () => true);
    await expect(runAfterLegacyMigration('s1', () => Promise.reject(other), resume)).rejects.toBe(
      other
    );
    expect(resume).not.toHaveBeenCalled();
  });
});

describe('useLegacyMigrationStore', () => {
  it('counts overlapping resumes of one chat, so the first to settle does not clear the other', () => {
    const store = useLegacyMigrationStore.getState();
    store.begin('s1');
    store.begin('s1');
    store.begin('s2');
    store.end('s1');
    expect(selectIsMigrating(useLegacyMigrationStore.getState(), 's1')).toBe(true);
    store.end('s1');
    expect(selectIsMigrating(useLegacyMigrationStore.getState(), 's1')).toBe(false);
    expect(useLegacyMigrationStore.getState().migrating).toEqual({ s2: 1 });
    // An unmatched end is harmless.
    store.end('s3');
    expect(useLegacyMigrationStore.getState().migrating).toEqual({ s2: 1 });
    expect(selectIsMigrating(useLegacyMigrationStore.getState(), null)).toBe(false);
  });

  it('bumps a per-chat posture revision', () => {
    useLegacyMigrationStore.getState().notePostureSynced('s1');
    useLegacyMigrationStore.getState().notePostureSynced('s1');
    expect(useLegacyMigrationStore.getState().postureRevisions).toEqual({ s1: 2 });
  });
});

it('ships its copy in the dictionary (constants, which the catalog scan cannot see)', () => {
  for (const key of [
    LEGACY_MIGRATION_PROGRESS_TITLE,
    LEGACY_MIGRATION_PROGRESS_DETAIL,
    LEGACY_MIGRATION_OPERATION_FAILED,
  ]) {
    expect(zhTranslations[key], key).toBeDefined();
  }
});
