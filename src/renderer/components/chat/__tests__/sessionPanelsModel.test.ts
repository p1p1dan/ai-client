import type {
  DshGoalProjection,
  RuntimeEvent,
  SessionProjectionPayload,
} from '@shared/types/runtimeEvents';
import { describe, expect, it } from 'vitest';
import {
  applyPanelsSnapshot,
  deriveGoalBarView,
  deriveTodoCardView,
  goalCommandLine,
  goalDismissKey,
  initialSessionPanels,
  panelsMark,
  pruneSessionPanels,
  reduceSessionPanels,
  type SessionPanels,
  type SessionPanelsState,
} from '../sessionPanelsModel';

/**
 * dsh-rebase P1-7a (decisions 068/109, 072, 111, 113, 118): the fold behind
 * the todo card and the goal bar, and what the two strips derive from it —
 * the seven goal states of plan P1-7 shard 03 §2 (the prototype draws four),
 * the todo card's one-line summary, and the ordering rule between live
 * `session.projection` events and a `worker.panels` answer.
 */

let seq = 0;
function projection(sessionId: string, payload: SessionProjectionPayload): RuntimeEvent {
  seq += 1;
  return { type: 'session.projection', sessionId, seq, timestamp: seq, payload };
}

function goal(
  phase: DshGoalProjection['goal']['phase'],
  extra: Partial<DshGoalProjection['goal']> = {},
  roundsStarted = 3
): DshGoalProjection {
  return {
    goal: {
      id: 'goal-1',
      revision: 4,
      objective: 'Get CI green and commit the fix',
      phase,
      maxGoalRounds: 256,
      ...extra,
    },
    roundsStarted,
    createdAt: 1_790_000_000_000,
    updatedAt: 1_790_000_300_000,
  };
}

function panelsWith(...payloads: SessionProjectionPayload[]): SessionPanels {
  let state: SessionPanelsState = initialSessionPanels;
  for (const payload of payloads) state = reduceSessionPanels(state, projection('s1', payload));
  const panels = state.bySession.s1;
  if (!panels) throw new Error('no panels');
  return panels;
}

const armed = {
  key: 'goalActivation',
  view: { goalId: 'goal-1', revision: 4, activation: 'armed' },
} as const;
const disarmed = {
  key: 'goalActivation',
  view: { goalId: 'goal-1', revision: 4, activation: 'disarmed' },
} as const;

describe('sessionPanelsModel — the fold', () => {
  it('[P7A-FOLD] a later value of a key replaces the earlier one, per session; the session is live', () => {
    let state = reduceSessionPanels(
      initialSessionPanels,
      projection('s1', { key: 'todos', view: [{ content: 'a', status: 'pending' }] })
    );
    state = reduceSessionPanels(state, projection('s2', { key: 'goal', view: goal('active') }));
    state = reduceSessionPanels(state, projection('s1', { key: 'todos', view: null }));
    expect(state.bySession.s1?.todos).toBeNull();
    expect(state.bySession.s1?.live).toBe(true);
    expect(state.bySession.s1?.seq).toEqual({ todos: 2 });
    expect(state.bySession.s2?.goal?.goal.phase).toBe('active');
  });

  it('[P7A-FOLD-IGNORES] other events keep the state object; a malformed view is not taken', () => {
    const state = reduceSessionPanels(
      initialSessionPanels,
      projection('s1', { key: 'todos', view: [{ content: 'a', status: 'pending' }] })
    );
    const unrelated = {
      type: 'message.delta',
      sessionId: 's1',
      seq: 1,
      timestamp: 1,
      payload: { messageId: 'm', blockId: 'b', text: 'x' },
    } as RuntimeEvent;
    expect(reduceSessionPanels(state, unrelated)).toBe(state);
    const garbled = reduceSessionPanels(
      state,
      projection('s1', {
        key: 'goal',
        view: { goal: 'nope' },
      } as unknown as SessionProjectionPayload)
    );
    expect(garbled.bySession.s1?.goal).toBeUndefined();
    expect(garbled.bySession.s1?.todos).toEqual([{ content: 'a', status: 'pending' }]);
  });

  it('[P7A-FOLD-DISCONNECT] a disconnected session is no longer live; its values stay', () => {
    const state = reduceSessionPanels(
      initialSessionPanels,
      projection('s1', { key: 'goal', view: goal('active') })
    );
    const next = reduceSessionPanels(state, {
      type: 'session.status',
      sessionId: 's1',
      seq: 9,
      timestamp: 9,
      payload: { status: 'disconnected', disconnectReason: 'capacity_reclaimed' },
    } as RuntimeEvent);
    expect(next.bySession.s1?.live).toBe(false);
    expect(next.bySession.s1?.goal?.goal.id).toBe('goal-1');
  });

  it('[P7A-HYDRATE] an answer fills what is known; an empty answer says nothing is live', () => {
    const answered = applyPanelsSnapshot(
      initialSessionPanels,
      's1',
      [
        { key: 'todos', view: null },
        { key: 'goal', view: goal('paused') },
        { key: 'subagentCatalog', view: [] },
        { key: 'goalActivation', view: null },
      ],
      {}
    );
    expect(answered.bySession.s1).toMatchObject({ live: true, todos: null, goalActivation: null });
    expect(answered.bySession.s1?.goal?.goal.phase).toBe('paused');
    // No slot for a session nothing is known about: nothing to record.
    expect(applyPanelsSnapshot(initialSessionPanels, 's9', [], {})).toBe(initialSessionPanels);
    const gone = applyPanelsSnapshot(answered, 's1', [], panelsMark(answered, 's1'));
    expect(gone.bySession.s1?.live).toBe(false);
    expect(gone.bySession.s1?.goal?.goal.phase).toBe('paused');
  });

  it('[P7A-HYDRATE-ORDER] an event that landed after the ask wins over the answer read before it', () => {
    let state = reduceSessionPanels(
      initialSessionPanels,
      projection('s1', { key: 'goal', view: goal('active') })
    );
    const mark = panelsMark(state, 's1');
    // The goal was paused after the worker read its answer; the event came first.
    state = reduceSessionPanels(state, projection('s1', { key: 'goal', view: goal('paused') }));
    state = applyPanelsSnapshot(
      state,
      's1',
      [
        { key: 'goal', view: goal('active') },
        { key: 'todos', view: [{ content: 'x', status: 'in_progress' }] },
      ],
      mark
    );
    expect(state.bySession.s1?.goal?.goal.phase).toBe('paused');
    expect(state.bySession.s1?.todos).toEqual([{ content: 'x', status: 'in_progress' }]);
    // An empty answer from before a live event does not take "live" back.
    const empty = applyPanelsSnapshot(state, 's1', [], mark);
    expect(empty.bySession.s1?.live).toBe(true);
  });

  it('[P7A-PRUNE] drops sessions no longer in the tree, and keeps the object when none go', () => {
    const state = reduceSessionPanels(
      reduceSessionPanels(initialSessionPanels, projection('s1', { key: 'todos', view: null })),
      projection('s2', { key: 'todos', view: null })
    );
    expect(Object.keys(pruneSessionPanels(state, ['s2']).bySession)).toEqual(['s2']);
    expect(pruneSessionPanels(state, ['s1', 's2'])).toBe(state);
  });
});

describe('sessionPanelsModel — the goal bar (plan P1-7 shard 03 §2)', () => {
  it('[P7A-GOAL-NONE] no goal, or a cleared one, draws no bar', () => {
    expect(deriveGoalBarView(undefined, false)).toBeNull();
    expect(deriveGoalBarView(panelsWith({ key: 'goal', view: null }), false)).toBeNull();
  });

  it('[P7A-GOAL-ARMED] active and armed: running while a turn is in flight, else waiting; pause', () => {
    const panels = panelsWith({ key: 'goal', view: goal('active') }, armed);
    expect(deriveGoalBarView(panels, true)).toMatchObject({
      state: 'running',
      round: 3,
      maxRounds: 256,
      action: 'pause',
      actionDisabled: false,
      controls: true,
    });
    expect(deriveGoalBarView(panels, false)?.state).toBe('waiting');
  });

  it('[P7A-GOAL-SUSPENDED] active but disarmed, or held by no live worker: suspended', () => {
    expect(
      deriveGoalBarView(panelsWith({ key: 'goal', view: goal('active') }, disarmed), true)
    ).toMatchObject({ state: 'suspended', action: 'resume' });
    const gone = { ...panelsWith({ key: 'goal', view: goal('active') }, armed), live: false };
    expect(deriveGoalBarView(gone, false)).toMatchObject({
      state: 'suspended',
      action: null,
      controls: false,
    });
  });

  it('[P7A-GOAL-ACTIVATION-ID] an activation of another goal is not this one’s', () => {
    const other = {
      key: 'goalActivation',
      view: { goalId: 'goal-0', revision: 9, activation: 'disarmed' },
    } as const;
    // Unknown activation on a live worker reads as armed (the bridge sends one with every goal).
    expect(
      deriveGoalBarView(panelsWith({ key: 'goal', view: goal('active') }, other), false)?.state
    ).toBe('waiting');
  });

  it('[P7A-GOAL-PAUSED] paused: resume; no "paused by an interjection" state exists (decision 111)', () => {
    expect(
      deriveGoalBarView(panelsWith({ key: 'goal', view: goal('paused') }), false)
    ).toMatchObject({ state: 'paused', action: 'resume', actionDisabled: false });
  });

  it('[P7A-GOAL-BLOCKED] blocked by the model: its reason, resume; round limit: resume disabled', () => {
    expect(
      deriveGoalBarView(
        panelsWith({
          key: 'goal',
          view: goal('blocked', {
            blockedReason: { code: 'model-reported', message: '/etc/app.json is missing' },
          }),
        }),
        false
      )
    ).toMatchObject({
      state: 'blocked',
      blockedMessage: '/etc/app.json is missing',
      action: 'resume',
      actionDisabled: false,
    });
    const spent = deriveGoalBarView(
      panelsWith({
        key: 'goal',
        view: goal(
          'blocked',
          { blockedReason: { code: 'round-limit', message: 'budget spent' }, maxGoalRounds: 4 },
          4
        ),
      }),
      false
    );
    expect(spent).toMatchObject({ state: 'roundLimit', action: 'resume', actionDisabled: true });
  });

  it('[P7A-GOAL-COMPLETE] complete: put away in this window until the goal changes', () => {
    const panels = panelsWith({ key: 'goal', view: goal('complete') });
    expect(deriveGoalBarView(panels, false)).toMatchObject({
      state: 'complete',
      action: 'dismiss',
    });
    expect(deriveGoalBarView(panels, false, goalDismissKey('goal-1', 4))).toBeNull();
    // A new revision (a replacement goal, an edit) brings the bar back.
    expect(deriveGoalBarView(panels, false, goalDismissKey('goal-1', 3))).not.toBeNull();
  });

  it('[P7A-GOAL-LINES] each control is DSH’s own /goal line', () => {
    expect(goalCommandLine('pause')).toBe('/goal pause');
    expect(goalCommandLine('resume')).toBe('/goal resume');
    expect(goalCommandLine('clear')).toBe('/goal clear');
    expect(goalCommandLine('edit', 'Ship the release')).toBe('/goal edit Ship the release');
  });
});

describe('sessionPanelsModel — the todo card (plan P1-7 shard 03 §3)', () => {
  it('[P7A-TODO-NONE] null (a new turn cleared it) or an empty list draws no card', () => {
    expect(deriveTodoCardView(undefined)).toBeNull();
    expect(deriveTodoCardView(panelsWith({ key: 'todos', view: null }))).toBeNull();
    expect(deriveTodoCardView(panelsWith({ key: 'todos', view: [] }))).toBeNull();
  });

  it('[P7A-TODO-COUNTS] done of total, what is in progress in list order, and what is next', () => {
    const view = deriveTodoCardView(
      panelsWith({
        key: 'todos',
        view: [
          { content: 'read the log', status: 'completed' },
          { content: 'fix the branch', status: 'in_progress' },
          { content: 'add tests', status: 'in_progress' },
          { content: 'commit', status: 'pending' },
        ],
      })
    );
    expect(view).toMatchObject({
      done: 1,
      total: 4,
      current: ['fix the branch', 'add tests'],
      allDone: false,
    });
    expect(view?.next).toBeUndefined();
    expect(
      deriveTodoCardView(
        panelsWith({
          key: 'todos',
          view: [
            { content: 'a', status: 'completed' },
            { content: 'b', status: 'pending' },
          ],
        })
      )
    ).toMatchObject({ current: [], next: 'b', allDone: false });
    expect(
      deriveTodoCardView(
        panelsWith({ key: 'todos', view: [{ content: 'a', status: 'completed' }] })
      )
    ).toMatchObject({ done: 1, total: 1, allDone: true });
  });
});

describe('sessionPanelsModel — the jobs key (P1-7b, decision 119)', () => {
  it('[P7B-PANELS-JOBS] keeps well-formed jobs, replaces the list whole, and ignores a list it cannot read', () => {
    const job = {
      id: 'bash-1',
      kind: 'bash',
      label: 'npm run dev',
      status: 'running' as const,
      startedAt: 1,
    };
    let state = reduceSessionPanels(
      initialSessionPanels,
      projection('s1', {
        key: 'jobs',
        view: [
          job,
          { id: 'bad', status: 'weird' } as never,
          { ...job, id: 'bash-2', status: 'completed' },
        ],
      })
    );
    expect(state.bySession.s1?.jobs?.map((entry) => entry.id)).toEqual(['bash-1', 'bash-2']);
    expect(state.bySession.s1?.live).toBe(true);
    state = reduceSessionPanels(state, projection('s1', { key: 'jobs', view: [] }));
    expect(state.bySession.s1?.jobs).toEqual([]);
    const same = reduceSessionPanels(
      state,
      projection('s1', { key: 'jobs', view: 'nope' as never })
    );
    expect(same.bySession.s1?.jobs).toEqual([]);
    // A rehydration answer fills the key like the others.
    const hydrated = applyPanelsSnapshot(
      initialSessionPanels,
      's2',
      [{ key: 'jobs', view: [job] }],
      {}
    );
    expect(hydrated.bySession.s2?.jobs).toEqual([job]);
  });
});
