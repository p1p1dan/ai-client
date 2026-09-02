import { PI_AGENT, sessionAgent } from '@shared/types/agentWire';
import type { SessionCreatedEvent } from '@shared/types/runtimeEvents';
import type { SessionIndexEntry } from '@shared/types/sessionIndex';
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

function entry(sessionId: string, opts: Partial<SessionIndexEntry> = {}): SessionIndexEntry {
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
    // …and the one reader every consumer is required to use still answers.
    expect(sessionAgent(sessions[0])).toBe(PI_AGENT);
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

  it('keeps the existing binding when an older Host sends none', () => {
    const patch = applyRuntimeEvent(
      state([session('s1', { agent: PI_AGENT })]),
      created({ runtimeIdentity: 'rt-1' })
    );
    expect(patch.sessions?.[0].agent).toBe(PI_AGENT);
    expect(patch.sessions?.[0].runtimeIdentity).toBe('rt-1');
  });
});
