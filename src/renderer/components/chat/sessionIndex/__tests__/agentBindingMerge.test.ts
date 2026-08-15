import { sessionAgent } from '@shared/types/agentWire';
import type { RuntimeEvent } from '@shared/types/runtimeEvents';
import type { SessionIndexEntry } from '@shared/types/sessionIndex';
import { describe, expect, it } from 'vitest';
import {
  applyRuntimeEvent,
  type ChatSession,
  type ChatSessionsState,
  type ChatWorkspace,
} from '@/stores/chatSessions';
import { shouldResumeSession } from '../resumeIntent';
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
  it('reads a row written before the field existed as Claude Code', () => {
    // Every row on disk today is in this state. The default lives in
    // `resolveAgentWireName`, not here, and not on the Main side either: the
    // index map is written back whole on every flush, so defaulting at load
    // would stamp the field onto legacy rows the first time anything else
    // changed.
    const { sessions } = mergeSessionIndex([], [entry('s1')], { workspaces });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].agent).toBe('claude-code');
  });

  it('passes a known slug through untouched', () => {
    const { sessions } = mergeSessionIndex([], [entry('s1', { agent: 'codex' })], { workspaces });
    expect(sessions[0].agent).toBe('codex');
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
    const live = [session('s1', { agent: 'codex' })];
    const { sessions } = mergeSessionIndex(live, [entry('s1')], { workspaces });
    expect(sessions[0].agent).toBe('codex');
  });

  it('materializes on the orphan path too', () => {
    // No workspace to host the row, but the caller still receives a session
    // object — it must not be the one shape in the tree with an unset binding.
    const { orphaned } = mergeSessionIndex([], [entry('s1', { workspacePath: '/elsewhere' })], {
      workspaces,
    });
    expect(orphaned).toHaveLength(1);
    expect(orphaned[0].agent).toBe('claude-code');
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
    expect(sessionAgent(sessions[0])).toBe('claude-code');
  });
});

/**
 * G13, renderer half — the whole string from a persisted row to the resume args.
 *
 * The Host half of this test lives in `agent-host/__tests__/codexRuntime.test.ts`
 * and asserts that `thread/resume` addresses exactly the `runtimeIdentity` it was
 * handed. Neither half is worth much alone: the failure they bracket is a resume
 * that reaches the right runtime with the wrong id, or the right id with the
 * wrong runtime, and both look like "the history is empty" on screen.
 */
describe('G13 — a persisted codex row becomes codex resume args', () => {
  const THREAD_ID = '01a003a5-307f-77d1-b7a4-a5379a560067';

  it('carries the agent and the threadId from the index row into the resume args', () => {
    const { sessions } = mergeSessionIndex(
      [],
      [entry('s1', { agent: 'codex', runtimeIdentity: THREAD_ID })],
      { workspaces }
    );
    const intent = shouldResumeSession(sessions[0], workspaces[0]);

    expect(sessions[0]).toMatchObject({ agent: 'codex', runtimeIdentity: THREAD_ID });
    expect(intent.shouldResume).toBe(true);
    expect(intent.args).toEqual({
      sessionId: 's1',
      runtimeIdentity: THREAD_ID,
      workspacePath: '/repo',
      model: undefined,
      agent: 'codex',
    });
  });

  it('does not hand a legacy row a codex binding just because it has a runtimeIdentity', () => {
    // The negative control that makes the case above mean something: a row
    // written before the field existed still resumes as Claude Code, so a merge
    // that defaulted everything to `codex` would fail here rather than pass both.
    const { sessions } = mergeSessionIndex([], [entry('s1', { runtimeIdentity: 'claude-uuid' })], {
      workspaces,
    });

    expect(shouldResumeSession(sessions[0], workspaces[0]).args).toMatchObject({
      agent: 'claude-code',
      runtimeIdentity: 'claude-uuid',
    });
  });
});

describe('the runtime echo reaches the live row', () => {
  function state(sessions: ChatSession[]): ChatSessionsState {
    return { sessions, hostBoundSessionIds: [] } as unknown as ChatSessionsState;
  }

  function created(payload: RuntimeEvent['payload']): RuntimeEvent {
    return {
      type: 'session.created',
      seq: 1,
      sessionId: 's1',
      timestamp: 0,
      payload,
    } as RuntimeEvent;
  }

  it('takes the agent the runtime reported', () => {
    const patch = applyRuntimeEvent(state([session('s1')]), created({ agent: 'codex' }));
    expect(patch.sessions?.[0].agent).toBe('codex');
  });

  it('keeps the existing binding when an older Host sends none', () => {
    // An old Host omits the key entirely. Substituting a default HERE would be
    // a second materialization point, and it would also overwrite a row that
    // already knew better.
    const patch = applyRuntimeEvent(
      state([session('s1', { agent: 'codex' })]),
      created({ runtimeIdentity: 'rt-1' })
    );
    expect(patch.sessions?.[0].agent).toBe('codex');
    expect(patch.sessions?.[0].runtimeIdentity).toBe('rt-1');
  });
});
