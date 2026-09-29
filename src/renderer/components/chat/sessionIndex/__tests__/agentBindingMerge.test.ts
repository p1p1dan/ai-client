import { DSH_AGENT, PI_AGENT, sessionAgent } from '@shared/types/agentWire';
import type { SessionCreatedEvent } from '@shared/types/runtimeEvents';
import type { SessionIndexListEntry } from '@shared/types/sessionIndex';
import { describe, expect, it } from 'vitest';
import {
  applyRuntimeEvent,
  type ChatSession,
  type ChatSessionsState,
  type ChatWorkspace,
} from '@/stores/chatSessions';
import { mergeSessionIndex } from '../sessionIndexMerge';

/**
 * S2 slice 1 — the renderer half of the agent binding.
 *
 * Two writers touch `ChatSession.agent` and only two: `mergeSessionIndex`,
 * which is the ONE place a missing value becomes a binding, and the
 * `session.created` reducer, which copies what the runtime reported. Every
 * other consumer reads through `sessionAgent()`, so if these two disagree the
 * whole tree quietly disagrees with them.
 */

function entry(
  sessionId: string,
  opts: Partial<SessionIndexListEntry> = {}
): SessionIndexListEntry {
  return {
    sessionId,
    workspacePath: '/repo',
    title: sessionId,
    updatedAt: 1000,
    archived: false,
    agent: PI_AGENT,
    ...opts,
  };
}

function session(id: string, extra: Partial<ChatSession> = {}): ChatSession {
  return {
    id,
    projectId: 'p1',
    workspaceId: 'ws-1',
    title: id,
    status: 'idle',
    updatedAt: 1000,
    ...extra,
  };
}

const workspaces: ChatWorkspace[] = [
  { id: 'ws-1', projectId: 'p1', name: 'Main', kind: 'main', path: '/repo' },
];

describe('mergeSessionIndex materializes the agent binding', () => {
  it('hides a row written before the field existed', () => {
    const { sessions, orphaned } = mergeSessionIndex([], [entry('s1', { agent: undefined })], {
      workspaces,
    });
    expect(sessions).toEqual([]);
    expect(orphaned).toEqual([]);
  });

  it('passes the Pi slug through untouched', () => {
    const { sessions } = mergeSessionIndex([], [entry('s1', { agent: PI_AGENT })], { workspaces });
    expect(sessions[0].agent).toBe(PI_AGENT);
  });

  it('[P1-1] passes the DSH slug through untouched', () => {
    const { sessions } = mergeSessionIndex([], [entry('s1', { agent: DSH_AGENT })], { workspaces });
    expect(sessions[0].agent).toBe(DSH_AGENT);
  });

  it('hides a row whose slug this build cannot read, without touching a live row', () => {
    // Written by a NEWER build (the user downgraded). Guessing a runtime for it
    // would run the session against the wrong agent; the entry stays on disk,
    // so upgrading brings the row back.
    const live = [session('s1', { title: 'live title', status: 'running' })];
    const { sessions } = mergeSessionIndex(live, [entry('s1', { agent: 'gemini' })], {
      workspaces,
    });

    // The persisted row contributed nothing — not its title, not its agent —
    // and the live sentence survived verbatim through the live-only tail pass.
    expect(sessions).toEqual(live);
  });

  it('hides an unknown-slug row that has no live counterpart at all', () => {
    const { sessions, orphaned } = mergeSessionIndex([], [entry('s1', { agent: 'gemini' })], {
      workspaces,
    });
    expect(sessions).toEqual([]);
    // Not "orphaned" either — that bucket means "no workspace to host it",
    // which is a different problem with a different remedy.
    expect(orphaned).toEqual([]);
  });

  it('lets a live binding win over the persisted one', () => {
    // The live value came from this run's `session.created` echo, i.e. from the
    // runtime that is actually running. A stale index row must not downgrade it.
    const live = [session('s1', { agent: PI_AGENT })];
    const { sessions } = mergeSessionIndex(live, [entry('s1')], { workspaces });
    expect(sessions[0].agent).toBe(PI_AGENT);
  });

  it('materializes on the orphan path too', () => {
    // No workspace to host the row, but the caller still receives a session
    // object — it must not be the one shape in the tree with an unset binding.
    const { orphaned } = mergeSessionIndex([], [entry('s1', { workspacePath: '/elsewhere' })], {
      workspaces,
    });
    expect(orphaned).toHaveLength(1);
    expect(orphaned[0].agent).toBe(PI_AGENT);
  });

  it('leaves a live-only row unmaterialized — the documented limit of the invariant', () => {
    // A session created this run and never sent has NO index entry, so it
    // reaches the tail safety net instead of the materialization loop and
    // comes out with `agent` still unset. Pinned deliberately: `ChatSession`'s
    // own doc comment says the field is not always defined and that readers
    // must go through `sessionAgent()`, and this is the case that makes that
    // true. Materializing here would be a second default AND would rebuild
    // every live row on every refresh.
    const live = session('live-only');
    const { sessions } = mergeSessionIndex([live], [], { workspaces });
    expect(sessions).toEqual([live]);
    expect(sessions[0].agent).toBeUndefined();
    // Same object, not a copy — the safety net does not rewrite live rows.
    expect(sessions[0]).toBe(live);
    // …and the one reader every consumer is required to use still answers:
    // an unsent chat of this build is a DSH chat (dsh-rebase P1-1).
    expect(sessionAgent(sessions[0])).toBe(DSH_AGENT);
  });
});

describe('T32 — legacy index bindings never re-enter live execution', () => {
  it('rejects an explicit Codex persisted row before it becomes a ChatSession', () => {
    const legacyEntry = entry('s1', {
      agent: 'codex',
      runtimeIdentity: 'legacy-thread',
    });
    const { sessions, orphaned } = mergeSessionIndex([], [legacyEntry], { workspaces });

    expect(sessions).toEqual([]);
    expect(orphaned).toEqual([]);
  });

  it('rejects a pre-agent-field row instead of treating it as Pi', () => {
    const { sessions, orphaned } = mergeSessionIndex(
      [],
      [entry('s1', { agent: undefined, runtimeIdentity: 'legacy-session' })],
      { workspaces }
    );
    expect(sessions).toEqual([]);
    expect(orphaned).toEqual([]);
  });
});

/**
 * dsh-rebase P1-9e (decisions 051, 122 rules 10 and 15, 123). Main hides the
 * legacy rows migrated chats came from, and lists one again, flagged
 * `migrationDiverged`, once 1.0.x has written to its file since. The merge
 * turns the flag into `legacyDiverged`, and lets a migrated row's binding
 * replace a live row that still holds the legacy one.
 */
describe('P1-9e — migrated chats and their legacy rows', () => {
  const PI_FILE = '/profile/pi-agent/sessions/s1.jsonl';
  const STUB = '/dsh-home/aiclient-sessions/aiclient-s1.dsh.json';
  const MIGRATED_FROM = {
    legacySessionId: 's1_pi',
    runtimeIdentity: PI_FILE,
    sourceSha256: 'a'.repeat(64),
    sourceBytes: 10,
    sourceMtimeMs: 1,
    migratedAt: 2,
    converter: 'pi-dsh/2',
  };

  it('marks a diverged legacy row, new or live, and clears the mark with the flag', () => {
    const diverged = entry('s1_pi', {
      runtimeIdentity: PI_FILE,
      migratedTo: 's1',
      migrationDiverged: true,
    });
    const fresh = mergeSessionIndex([], [diverged], { workspaces }).sessions;
    expect(fresh[0]).toMatchObject({ id: 's1_pi', agent: PI_AGENT, legacyDiverged: true });

    const live = mergeSessionIndex(fresh, [diverged], { workspaces }).sessions;
    expect(live[0].legacyDiverged).toBe(true);

    // Moved over since (or its file put back): Main lists it without the flag.
    const settled = mergeSessionIndex(
      live,
      [entry('s1_pi', { runtimeIdentity: PI_FILE, migratedTo: 's1' })],
      { workspaces }
    ).sessions;
    expect(settled[0].legacyDiverged).toBeUndefined();
  });

  it('never marks an ordinary row', () => {
    const { sessions } = mergeSessionIndex(
      [],
      [entry('s1', { runtimeIdentity: PI_FILE }), entry('s2', { agent: DSH_AGENT })],
      { workspaces }
    );
    expect(sessions.map((row) => 'legacyDiverged' in row)).toEqual([false, false]);
  });

  it('lets a migration replace the legacy binding a live row still holds', () => {
    // The move committed, and the resume after it failed: no `session.resumed`
    // ever rebound the live row.
    const live = [session('s1', { agent: PI_AGENT, runtimeIdentity: PI_FILE })];
    const { sessions } = mergeSessionIndex(
      live,
      [entry('s1', { agent: DSH_AGENT, runtimeIdentity: STUB, migratedFrom: MIGRATED_FROM })],
      { workspaces }
    );
    expect(sessions[0]).toMatchObject({ agent: DSH_AGENT, runtimeIdentity: STUB });
  });

  it('reverse: a live binding still wins over a DSH row that was never migrated', () => {
    const live = [session('s1', { agent: DSH_AGENT, runtimeIdentity: 'rt-live' })];
    const { sessions } = mergeSessionIndex(
      live,
      [entry('s1', { agent: DSH_AGENT, runtimeIdentity: STUB, migratedFrom: MIGRATED_FROM })],
      { workspaces }
    );
    expect(sessions[0]).toMatchObject({ agent: DSH_AGENT, runtimeIdentity: 'rt-live' });
    const legacyLive = [session('s2', { agent: PI_AGENT, runtimeIdentity: PI_FILE })];
    const plain = mergeSessionIndex(
      legacyLive,
      [entry('s2', { agent: DSH_AGENT, runtimeIdentity: STUB })],
      { workspaces }
    ).sessions;
    expect(plain[0]).toMatchObject({ agent: PI_AGENT, runtimeIdentity: PI_FILE });
  });

  it('[D131-MERGE] a forked chat waits for its first message until a rename clears the mark', () => {
    const forked = entry('s1_pi', {
      agent: DSH_AGENT,
      runtimeIdentity: '/dsh-home/aiclient-sessions/aiclient-s1_pi.dsh.json',
      title: 'Notes (1.0.x branch)',
      forkTitlePending: true,
    });
    const fresh = mergeSessionIndex([], [forked], { workspaces }).sessions;
    expect(fresh[0]).toMatchObject({ title: 'Notes (1.0.x branch)', forkTitlePending: true });
    const live = mergeSessionIndex(fresh, [forked], { workspaces }).sessions;
    expect(live[0].forkTitlePending).toBe(true);
    // Renamed (by its first message, or by the user): Main lists it without the mark.
    const { forkTitlePending: _cleared, ...renamed } = forked;
    const settled = mergeSessionIndex(live, [{ ...renamed, title: 'Ship the fix' }], {
      workspaces,
    }).sessions;
    expect(settled[0]).toMatchObject({ title: 'Ship the fix' });
    expect(settled[0].forkTitlePending).toBeUndefined();
    // Reverse: an ordinary row never carries it.
    const plain = mergeSessionIndex([], [entry('s2', { agent: DSH_AGENT })], { workspaces });
    expect('forkTitlePending' in (plain.sessions[0] ?? {})).toBe(false);
  });
});

describe('the runtime echo reaches the live row', () => {
  function state(sessions: ChatSession[]): ChatSessionsState {
    return { sessions, hostBoundSessionIds: [] } as unknown as ChatSessionsState;
  }

  function created(payload: NonNullable<SessionCreatedEvent['payload']>): SessionCreatedEvent {
    return {
      type: 'session.created',
      seq: 1,
      sessionId: 's1',
      timestamp: 0,
      payload,
    };
  }

  it('takes the Pi agent the runtime reported', () => {
    const patch = applyRuntimeEvent(state([session('s1')]), created({ agent: PI_AGENT }));
    expect(patch.sessions?.[0].agent).toBe(PI_AGENT);
  });

  it('[P1-1] rebinds a never-run pi row to the DSH engine that created it', () => {
    const patch = applyRuntimeEvent(
      state([session('s1', { agent: PI_AGENT })]),
      created({
        agent: DSH_AGENT,
        runtimeIdentity: '/dsh-home/aiclient-sessions/aiclient-s1.dsh.json',
      })
    );
    expect(patch.sessions?.[0].agent).toBe(DSH_AGENT);
  });

  it('keeps the existing binding when an older Host sends none', () => {
    const patch = applyRuntimeEvent(
      state([session('s1', { agent: PI_AGENT })]),
      created({ runtimeIdentity: 'rt-1' })
    );
    expect(patch.sessions?.[0].agent).toBe(PI_AGENT);
    expect(patch.sessions?.[0].runtimeIdentity).toBe('rt-1');
  });
});
