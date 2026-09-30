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

/**
 * dsh-rebase P1-7e e3 (decision 142). Problem 5: DSH commits a resume as the
 * goal's change and then its activation edge — two events, verified on a real
 * host with the fake gateway (goal `active rev3` one millisecond before
 * `activation armed rev3`). Problem 17: the jobs a worker listed when it went
 * away stay as former rows.
 */
describe('sessionPanelsModel — a resumed goal (P1-7e problem 5)', () => {
  const at = (revision: number, activation: 'armed' | 'disarmed') =>
    ({
      key: 'goalActivation',
      view: { goalId: 'goal-1', revision, activation },
    }) as const;

  it('[P7E-GOAL-RESUME] paused → active reads as armed until the new edge; the edge decides after', () => {
    const paused = panelsWith(
      { key: 'goal', view: goal('paused', { revision: 2 }) },
      at(2, 'disarmed')
    );
    expect(deriveGoalBarView(paused, false)?.state).toBe('paused');
    let state: SessionPanelsState = { bySession: { s1: paused } };
    state = reduceSessionPanels(
      state,
      projection('s1', { key: 'goal', view: goal('active', { revision: 3 }) })
    );
    // The moment between the goal's change and its activation edge.
    expect(state.bySession.s1?.resumedGoal).toEqual({ goalId: 'goal-1', revision: 3 });
    expect(deriveGoalBarView(state.bySession.s1, false)?.state).toBe('waiting');
    expect(deriveGoalBarView(state.bySession.s1, true)?.state).toBe('running');
    state = reduceSessionPanels(state, projection('s1', at(3, 'armed')));
    expect(deriveGoalBarView(state.bySession.s1, false)?.state).toBe('waiting');
    // A real disarm of the resumed revision (a Stop outside the round) is believed.
    state = reduceSessionPanels(state, projection('s1', at(3, 'disarmed')));
    expect(deriveGoalBarView(state.bySession.s1, false)?.state).toBe('suspended');
  });

  it('[P7E-GOAL-RESUME-BLOCKED] blocked → active is a resume too', () => {
    let state: SessionPanelsState = {
      bySession: {
        s1: panelsWith(
          {
            key: 'goal',
            view: goal('blocked', {
              revision: 5,
              blockedReason: { code: 'model-reported', message: 'Config missing' },
            }),
          },
          at(5, 'disarmed')
        ),
      },
    };
    state = reduceSessionPanels(
      state,
      projection('s1', { key: 'goal', view: goal('active', { revision: 6 }) })
    );
    expect(deriveGoalBarView(state.bySession.s1, true)?.state).toBe('running');
  });

  it('[P7E-GOAL-EDIT-SUSPENDED] editing a suspended goal keeps it suspended (DSH sends no edge)', () => {
    let state: SessionPanelsState = {
      bySession: {
        s1: panelsWith({ key: 'goal', view: goal('active', { revision: 3 }) }, at(3, 'disarmed')),
      },
    };
    expect(deriveGoalBarView(state.bySession.s1, false)?.state).toBe('suspended');
    state = reduceSessionPanels(
      state,
      projection('s1', { key: 'goal', view: goal('active', { revision: 4 }) })
    );
    expect(state.bySession.s1?.resumedGoal).toBeUndefined();
    expect(deriveGoalBarView(state.bySession.s1, false)?.state).toBe('suspended');
  });

  it('[P7E-GOAL-RESUME-NOT-LIVE] a resumed goal with no live worker is still suspended', () => {
    let state: SessionPanelsState = {
      bySession: {
        s1: panelsWith({ key: 'goal', view: goal('paused', { revision: 2 }) }, at(2, 'disarmed')),
      },
    };
    state = reduceSessionPanels(
      state,
      projection('s1', { key: 'goal', view: goal('active', { revision: 3 }) })
    );
    state = reduceSessionPanels(state, {
      type: 'session.status',
      sessionId: 's1',
      seq: 99,
      timestamp: 99,
      payload: { status: 'disconnected', disconnectReason: 'engine_restarted' },
    } as RuntimeEvent);
    expect(deriveGoalBarView(state.bySession.s1, false)).toMatchObject({
      state: 'suspended',
      action: null,
    });
  });
});

describe('sessionPanelsModel — a worker that went away (P1-7e problem 17)', () => {
  const job = (id: string, status: 'running' | 'completed' | 'killed') => ({
    id,
    kind: 'bash',
    label: `job ${id}`,
    status,
    startedAt: 1,
  });
  const gone = (sessionId = 's1'): RuntimeEvent =>
    ({
      type: 'session.status',
      sessionId,
      seq: 77,
      timestamp: 77,
      payload: { status: 'disconnected', disconnectReason: 'engine_restarted' },
    }) as RuntimeEvent;

  it('[P7E-JOBS-CARRY] the listed jobs move to formerJobs with their worker, and the list empties', () => {
    let state = reduceSessionPanels(
      initialSessionPanels,
      projection('s1', { key: 'jobs', view: [job('bash-2', 'running'), job('bash-4', 'killed')] })
    );
    state = reduceSessionPanels(state, gone());
    const panels = state.bySession.s1;
    expect(panels?.live).toBe(false);
    expect(panels?.jobs).toEqual([]);
    expect(panels?.workerEpoch).toBe(1);
    expect(panels?.formerJobs?.map((entry) => [entry.id, entry.status, entry.epoch])).toEqual([
      ['bash-2', 'running', 0],
      ['bash-4', 'killed', 0],
    ]);
    // The next worker's list replaces `jobs` and leaves the former rows alone.
    state = reduceSessionPanels(
      state,
      projection('s1', { key: 'jobs', view: [job('bash-2', 'running')] })
    );
    expect(state.bySession.s1?.formerJobs).toHaveLength(2);
    expect(state.bySession.s1?.jobs?.map((entry) => entry.id)).toEqual(['bash-2']);
    // A second loss stamps the second worker; a disconnect of a session no longer live does nothing.
    state = reduceSessionPanels(state, gone());
    expect(state.bySession.s1?.formerJobs?.map((entry) => entry.epoch)).toEqual([0, 0, 1]);
    expect(reduceSessionPanels(state, gone())).toBe(state);
  });

  it('[P7E-JOBS-CARRY-CAP] keeps the newest eight; a worker with no jobs only moves the epoch', () => {
    let state = reduceSessionPanels(
      initialSessionPanels,
      projection('s1', {
        key: 'jobs',
        view: Array.from({ length: 10 }, (_, index) => job(`bash-${index + 1}`, 'completed')),
      })
    );
    state = reduceSessionPanels(state, gone());
    expect(state.bySession.s1?.formerJobs?.map((entry) => entry.id)).toEqual(
      Array.from({ length: 8 }, (_, index) => `bash-${index + 3}`)
    );
    let empty = reduceSessionPanels(
      initialSessionPanels,
      projection('s2', { key: 'goal', view: goal('active') })
    );
    empty = reduceSessionPanels(empty, gone('s2'));
    expect(empty.bySession.s2?.workerEpoch).toBe(1);
    expect(empty.bySession.s2?.formerJobs).toBeUndefined();
  });
});
