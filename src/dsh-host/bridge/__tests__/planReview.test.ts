import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GOAL_NOT_SET_PREFIX,
  KEEP_PLANNING_FEEDBACK_PREFIX,
  PLAN_APPROVAL_HOLD_REASON,
  PLAN_MODE_RESUME_REASON,
  PLAN_REVIEW_SOURCE_KIND,
  planGoalObjective,
  REVIEW_DISMISSED_TEXT,
  RUN_WITHOUT_GOAL_TEXT,
} from '../../../shared/planReview.ts';
import type { RuntimeEventDraft } from '../../../shared/types/runtimeEvents.ts';
import type { RuntimePermissionSettings } from '../../../shared/types/runtimePermission.ts';
import type { DshPreToolDecision, DshToolCall } from '../../permissions/dshTypes.ts';
import {
  type DshBridgeContext,
  DshSessionRuntime,
  type DshToolOutcome,
  dshSessionIdFor,
} from '../dshSessionRuntime.ts';
import {
  abortedOutcome,
  approveAnswer,
  askCancelled,
  createGoalReviewCard,
  exitPlanReviewCard,
  goalRoundCapOf,
  goalToolValue,
  keepPlanningAnswer,
  planReviewOf,
} from '../planReview.ts';
import { testPermissionHost } from './permissionTestHost.ts';
import { TEST_PLAN } from './testPlan.ts';

/**
 * dsh-rebase decision 169 — plan mode's end: the review card for DSH's
 * `exit_plan_mode` and for `create_goal` in plan mode, the approval's posture
 * switch mid-turn, the goal it sets, the hold on the rest of the step, and
 * DSH's plan mode following the gate. Against the real `PermissionHost` and
 * gate; the DSH side (plan-mode, goals, the waterfalls) is a fake context.
 * The real engine runs it in bridge-record's `plan-review` / `plan-dismiss`.
 */

const LOGICAL = 'plan-session';
const DSH_ID = dshSessionIdFor(LOGICAL);
const PLAN = [
  '# Ship CSV export',
  '',
  '## Goal and success criteria',
  '- The export menu offers CSV; Excel opens the file.',
  '',
  '## Changes',
  '1. src/export/csv.ts',
  '',
].join('\n');

let home = '';
let ws = '';

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-plan-home-'));
  ws = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-plan-ws-')));
  writeFileSync(join(ws, 'notes.txt'), 'notes\n');
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(ws, { recursive: true, force: true });
});

type Event = RuntimeEventDraft & { requestId?: string; payload: Record<string, unknown> };

interface FakeGoal {
  id: string;
  revision: number;
  objective: string;
  phase: string;
  maxGoalRounds: number;
  roundsStarted: number;
  activation: string;
}

function fakeDsh(options: { planMode?: boolean; goalExists?: boolean } = {}) {
  const permissions = testPermissionHost();
  const listeners = new Map<string, (...args: unknown[]) => unknown>();
  const agentState = { status: 'idle' as 'idle' | 'running' };
  const agent = {
    id: DSH_ID,
    get status() {
      return agentState.status;
    },
    session: { header: { cwd: ws } },
    followup: () => undefined,
    cancel: () => undefined,
  };
  const selections: boolean[] = [];
  const planMode = {
    get: vi.fn(() => ({ active: selections.at(-1) ?? false })),
    set: vi.fn((_agent: unknown, active: boolean) => {
      selections.push(active);
      return 'committed' as const;
    }),
  };
  const created: FakeGoal[] = [];
  const goals = {
    get: vi.fn(() => undefined),
    create: vi.fn((_agent: unknown, request: { objective: string; maxGoalRounds?: number }) => {
      if (options.goalExists) {
        throw Object.assign(new Error('goal "goal-0" already exists with phase "paused"'), {
          code: 'GOAL_ALREADY_EXISTS',
        });
      }
      const goal: FakeGoal = {
        id: 'goal-1',
        revision: 1,
        objective: request.objective,
        phase: 'active',
        maxGoalRounds: request.maxGoalRounds ?? 20,
        roundsStarted: 0,
        activation: 'armed',
      };
      created.push(goal);
      return goal;
    }),
  };
  let seq = 100;
  const emitEvent = (type: string, data: Record<string, unknown> = {}) => {
    seq += 1;
    listeners.get('session/event')?.({ id: DSH_ID }, { type, seq, time: seq, data });
  };
  const services: Record<string, unknown> = {
    goals,
    ...(options.planMode === false ? {} : { planMode }),
  };
  const ctx = {
    on: (name: string, listener: (...args: unknown[]) => unknown) => {
      listeners.set(name, listener);
      return () => listeners.delete(name);
    },
    get: (name: string) => services[name],
    agents: {
      create: vi.fn(async () => ({ agent, dispose: async () => undefined })),
      resume: vi.fn(async () => ({ agent, dispose: async () => undefined })),
    },
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'aiclient-gateway', model: 'fake-1' }),
    },
    sessions: { flush: vi.fn(async () => true) },
    sessionQuery: {
      observeSession: vi.fn(async () => ({
        events: [],
        cursor: -1,
        [Symbol.dispose]: () => undefined,
      })),
    },
    aiclientPermissions: permissions.api,
  } as unknown as DshBridgeContext;
  /** DSH's `exit_plan_mode` asking through `ctx.userQuestions` (one root agent). */
  const ask = (signal?: AbortSignal) =>
    listeners.get('user-questions/request')?.(
      {
        questions: [
          {
            id: 'plan-review',
            header: 'Plan review',
            question: 'Approve this plan and leave plan mode?',
            detail: PLAN,
            options: [{ label: 'Approve' }, { label: 'Keep planning' }],
            intent: { kind: 'plan-review', approve: 'Approve', callId: 'call-plan' },
          },
        ],
        agent: { id: DSH_ID },
        ...(signal ? { signal } : {}),
      },
      () => Promise.reject(new Error('not ours'))
    ) as Promise<unknown>;
  /** dsh-tools' around-dispatch waterfall for one call of the session's agent. */
  const execute = (
    name: string,
    args: Record<string, unknown>,
    next: () => Promise<DshToolOutcome>,
    options: { callId?: string; signal?: AbortSignal } = {}
  ) =>
    listeners.get('tools/execute')?.(
      {
        callId: options.callId ?? `call-${name}`,
        name,
        arguments: args,
        agent: { id: DSH_ID },
        ...(options.signal ? { signal: options.signal } : {}),
      },
      next
    ) as Promise<DshToolOutcome>;
  return {
    ctx,
    host: permissions.host,
    agentState,
    planMode,
    selections,
    goals,
    created,
    emitEvent,
    ask,
    execute,
  };
}

const PLAN_POSTURE: RuntimePermissionSettings = { mode: 'plan', gear: 'auto' };

function runtime(ctx: DshBridgeContext, permissions: RuntimePermissionSettings = PLAN_POSTURE) {
  const events: Event[] = [];
  const log = vi.fn();
  const notices: unknown[] = [];
  const bridge = new DshSessionRuntime(
    ctx,
    {
      logicalSessionId: LOGICAL,
      cwd: ws,
      projectTrusted: true,
      permissions,
      emit: (event) => events.push(event as Event),
      log,
    },
    {
      createUserMessage: (input) => {
        notices.push(input);
        return { id: `message-${notices.length}`, ...input };
      },
      now: () => 1_700_000_000_000,
      modelPlan: () => TEST_PLAN,
      home,
      permissionAgentDir: null,
    }
  );
  return { bridge, events, log, notices };
}

/** One call of the session's own agent, as `tools/pre-execute` sees it. */
function call(name: string, args: Record<string, unknown>, agentId = DSH_ID): DshToolCall {
  return {
    callId: `pre-${name}`,
    name,
    arguments: Object.freeze({ ...args }),
    agent: { id: agentId, session: { header: { id: agentId, cwd: ws } } },
    signal: new AbortController().signal,
  };
}

const allowNext = async (): Promise<DshPreToolDecision> => ({ kind: 'allow' });

async function until(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((done) => setTimeout(done, 5));
  }
}

const ofType = (events: Event[], type: string) => events.filter((e) => e.type === type);
const cardOf = (events: Event[]) => ofType(events, 'question.requested').at(-1)?.payload;

/** The bridge's posture as the gate holds it, read through what the prompt context says. */
function gateOf(bridge: DshSessionRuntime): { mode: string; gear: string } {
  const gate = (bridge as unknown as { gate: { mode: string; gear: string } }).gate;
  return { mode: gate.mode, gear: gate.gear };
}

describe('pure helpers', () => {
  it('recognises DSH’s review question, and nothing else', () => {
    const item = {
      id: 'plan-review',
      question: 'Approve?',
      detail: PLAN,
      options: [{ label: 'Approve' }],
      intent: { kind: 'plan-review', approve: 'Approve', callId: 'c1' },
    };
    expect(planReviewOf({ questions: [item] })).toEqual({ item, plan: PLAN, callId: 'c1' });
    expect(planReviewOf({ questions: [item, item] })).toBeUndefined();
    expect(planReviewOf({ questions: [{ ...item, intent: undefined }] })).toBeUndefined();
    expect(planReviewOf({ questions: [{ ...item, detail: undefined }] })).toBeUndefined();
  });

  it('answers DSH in its own terms: Approve with nothing custom; Keep planning with feedback', () => {
    expect(approveAnswer('plan-review')).toEqual({
      answers: [{ id: 'plan-review', selected: ['Approve'] }],
    });
    expect(keepPlanningAnswer('narrow it', 'plan-review')).toEqual({
      answers: [{ id: 'plan-review', selected: ['Keep planning'], custom: 'narrow it' }],
    });
  });

  it('ASK_CANCELLED is shaped the way dsh-user-questions restores its own error', () => {
    const error = askCancelled() as Error & { code?: unknown };
    // dsh-user-questions `restoreUserQuestionError`: a record named
    // UserQuestionError with a string message and code.
    expect(error.name).toBe('UserQuestionError');
    expect(typeof error.message).toBe('string');
    expect(error.code).toBe('ASK_CANCELLED');
  });

  it('builds the cards and create_goal’s own value', () => {
    expect(
      exitPlanReviewCard(
        { item: { id: 'plan-review', question: 'q' }, plan: PLAN, callId: 'c' },
        'g'
      )
    ).toEqual({
      kind: 'plan',
      source: 'exit_plan_mode',
      title: 'Ship CSV export',
      plan: PLAN,
      callId: 'c',
      goalObjective: 'g',
    });
    expect(createGoalReviewCard({ objective: 'Do it', callId: 'c2' })).toEqual({
      kind: 'plan',
      source: 'create_goal',
      objective: 'Do it',
      callId: 'c2',
      goalObjective: 'Do it',
    });
    expect(
      goalToolValue({
        id: 'goal-1',
        revision: 1,
        objective: 'Do it',
        phase: 'active',
        maxGoalRounds: 5,
        activation: 'armed',
      })
    ).toEqual({
      goal: {
        id: 'goal-1',
        revision: 1,
        objective: 'Do it',
        phase: 'active',
        roundsStarted: 0,
        maxGoalRounds: 5,
      },
      activation: 'armed',
    });
    expect(goalRoundCapOf({ max_goal_rounds: 4 })).toBe(4);
    expect(goalRoundCapOf({ max_goal_rounds: 0 })).toBeUndefined();
    expect(abortedOutcome().error.info?.code).toBe('ABORTED');
  });
});

describe('DSH’s plan mode follows the gate', () => {
  it('a plan-mode session turns DSH’s plan mode on at bootstrap; another selects it off', async () => {
    const planned = fakeDsh();
    await runtime(planned.ctx).bridge.bootstrap();
    expect(planned.selections).toEqual([true]);
    const executing = fakeDsh();
    await runtime(executing.ctx, { mode: 'agent', gear: 'ask' }).bridge.bootstrap();
    // DSH answers `noop` for the state it already has: nothing is logged.
    expect(executing.selections).toEqual([false]);
  });

  it('an idle posture change follows; a mid-turn mode change is still refused, and selects nothing', async () => {
    const dsh = fakeDsh();
    const { bridge } = runtime(dsh.ctx);
    await bridge.bootstrap();
    bridge.setPermissions({ mode: 'agent', gear: 'auto' });
    expect(dsh.selections).toEqual([true, false]);
    dsh.agentState.status = 'running';
    expect(() => bridge.setPermissions({ mode: 'plan', gear: 'auto' })).toThrow(
      expect.objectContaining({ code: 'WORKER_SESSION_BUSY' })
    );
    expect(dsh.selections).toEqual([true, false]);
  });

  it('a host without the plan-mode service keeps the gate alone, and says so once', async () => {
    const dsh = fakeDsh({ planMode: false });
    const { bridge, log } = runtime(dsh.ctx);
    await bridge.bootstrap();
    bridge.setPermissions({ mode: 'plan', gear: 'ask' });
    expect(
      log.mock.calls.filter(([line]) => String(line).includes('no plan-mode service'))
    ).toHaveLength(1);
  });
});

describe('exit_plan_mode’s review (decision 169)', () => {
  async function reviewing(options: { goalExists?: boolean } = {}) {
    const dsh = fakeDsh(options);
    const run = runtime(dsh.ctx);
    await run.bridge.bootstrap();
    // Inside the review's turn: DSH's agent runs.
    dsh.agentState.status = 'running';
    const answer = dsh.ask();
    await until(() => cardOf(run.events) !== undefined);
    const questionId = String(cardOf(run.events)?.questionId);
    return { dsh, ...run, answer, questionId };
  }

  it('raises the review card with the plan and the goal an approval would set', async () => {
    const { events, questionId } = await reviewing();
    expect(cardOf(events)).toEqual({
      questionId,
      questions: [
        { id: 'plan-review', header: 'Plan review', question: 'Ship CSV export', options: [] },
      ],
      review: {
        kind: 'plan',
        source: 'exit_plan_mode',
        title: 'Ship CSV export',
        plan: PLAN,
        callId: 'call-plan',
        goalObjective: planGoalObjective(PLAN),
      },
    });
  });

  it('an approval mid-turn switches the gate without BUSY, sets the goal, tells Main first, then approves', async () => {
    const { dsh, bridge, events, answer, questionId } = await reviewing();
    // The RPC setter still refuses a mode change while the agent runs.
    expect(() => bridge.setPermissions({ mode: 'agent', gear: 'auto' })).toThrow(
      expect.objectContaining({ code: 'WORKER_SESSION_BUSY' })
    );
    expect(bridge.respondQuestion({ questionId, answers: { 'plan-review': 'goal:auto' } })).toBe(
      true
    );
    await expect(answer).resolves.toEqual({
      answers: [{ id: 'plan-review', selected: ['Approve'] }],
    });
    expect(gateOf(bridge)).toEqual({ mode: 'agent', gear: 'auto' });
    // DSH's plan mode is told to leave at the next step (queued mid-turn).
    expect(dsh.selections).toEqual([true, false]);
    expect(dsh.goals.create).toHaveBeenCalledWith(expect.anything(), {
      objective: planGoalObjective(PLAN),
    });
    const tail = events.slice(events.findIndex((e) => e.type === 'session.permissions'));
    expect(tail.map((e) => e.type)).toEqual(['session.permissions', 'question.resolved']);
    expect(tail[0]?.payload).toEqual({
      permissions: { mode: 'agent', gear: 'auto' },
      cause: 'plan-approved',
      questionId,
      goal: { set: true },
    });
    expect(tail[1]?.payload).toEqual({
      questionId,
      outcome: 'answered',
      answers: { 'plan-review': 'goal:auto' },
      review: { choice: 'goal:auto', goal: { set: true } },
    });
  });

  it('goal:bypass switches to bypass; run:auto sets no goal', async () => {
    const bypass = await reviewing();
    bypass.bridge.respondQuestion({
      questionId: bypass.questionId,
      answers: { 'plan-review': 'goal:bypass' },
    });
    await bypass.answer;
    expect(gateOf(bypass.bridge)).toEqual({ mode: 'agent', gear: 'bypass' });

    const once = await reviewing();
    once.bridge.respondQuestion({
      questionId: once.questionId,
      answers: { 'plan-review': 'run:auto' },
    });
    await once.answer;
    expect(gateOf(once.bridge)).toEqual({ mode: 'agent', gear: 'auto' });
    expect(once.dsh.goals.create).not.toHaveBeenCalled();
    expect(ofType(once.events, 'session.permissions')[0]?.payload).not.toHaveProperty('goal');
  });

  it('an unfinished goal keeps the approval and reports why no goal was set', async () => {
    const { bridge, events, answer, questionId } = await reviewing({ goalExists: true });
    bridge.respondQuestion({ questionId, answers: { 'plan-review': 'goal:auto' } });
    await expect(answer).resolves.toEqual(approveAnswer('plan-review'));
    expect(gateOf(bridge)).toEqual({ mode: 'agent', gear: 'auto' });
    const goal = { set: false, reason: 'goal "goal-0" already exists with phase "paused"' };
    expect(ofType(events, 'session.permissions')[0]?.payload).toMatchObject({ goal });
    expect(ofType(events, 'question.resolved')[0]?.payload).toMatchObject({
      review: { choice: 'goal:auto', goal },
    });
  });

  it('keep planning hands DSH the feedback and moves nothing', async () => {
    const { dsh, bridge, events, answer, questionId } = await reviewing();
    bridge.respondQuestion({
      questionId,
      answers: { 'plan-review': 'keep-planning' },
      response: 'Split the parser first.',
    });
    await expect(answer).resolves.toEqual(keepPlanningAnswer('Split the parser first.'));
    expect(gateOf(bridge)).toEqual({ mode: 'plan', gear: 'auto' });
    expect(dsh.selections).toEqual([true]);
    expect(dsh.goals.create).not.toHaveBeenCalled();
    expect(ofType(events, 'session.permissions')).toEqual([]);
  });

  it('closing the review (or keep planning with no feedback) is ASK_CANCELLED and moves nothing', async () => {
    for (const response of [{ cancel: true }, { answers: { 'plan-review': 'keep-planning' } }]) {
      const { dsh, bridge, events, answer, questionId } = await reviewing();
      bridge.respondQuestion({ questionId, ...response });
      await expect(answer).rejects.toMatchObject({
        name: 'UserQuestionError',
        code: 'ASK_CANCELLED',
      });
      expect(gateOf(bridge)).toEqual({ mode: 'plan', gear: 'auto' });
      expect(dsh.goals.create).not.toHaveBeenCalled();
      expect(ofType(events, 'question.resolved')[0]?.payload).toEqual({
        questionId,
        outcome: 'cancelled',
      });
    }
  });

  it('Stop takes the review down with no side effect', async () => {
    const dsh = fakeDsh();
    const { bridge, events } = runtime(dsh.ctx);
    await bridge.bootstrap();
    dsh.agentState.status = 'running';
    const controller = new AbortController();
    const answer = dsh.ask(controller.signal);
    await until(() => cardOf(events) !== undefined);
    controller.abort();
    await expect(answer).rejects.toThrow();
    expect(gateOf(bridge)).toEqual({ mode: 'plan', gear: 'auto' });
    expect(dsh.selections).toEqual([true]);
    expect(dsh.goals.create).not.toHaveBeenCalled();
    expect(ofType(events, 'session.permissions')).toEqual([]);
    expect(ofType(events, 'question.resolved')[0]?.payload).toMatchObject({ stopped: true });
  });

  it('the approval holds the agent’s other calls until its next step, and a second review raises no card', async () => {
    const { dsh, bridge, events, answer, questionId } = await reviewing();
    bridge.respondQuestion({ questionId, answers: { 'plan-review': 'goal:auto' } });
    await answer;
    // A write the model put beside exit_plan_mode, judged after the approval.
    const held = await dsh.host.preExecute(
      call('write', { file_path: 'a.txt', content: 'x' }),
      allowNext
    );
    expect(held).toEqual({
      kind: 'deny',
      reason: PLAN_APPROVAL_HOLD_REASON,
      info: { name: 'PermissionDenial', code: 'plan_review_hold' },
    });
    // Internal tools too: a sibling create_goal must not set a goal the user did not choose.
    expect(
      await dsh.host.preExecute(call('create_goal', { objective: 'x' }), allowNext)
    ).toMatchObject({
      kind: 'deny',
      reason: PLAN_APPROVAL_HOLD_REASON,
    });
    // A delegate's call is not the agent's own: not held.
    const child = `${DSH_ID}-child`;
    dsh.host.onSessionCreated({
      id: child,
      header: { id: child, parentSession: DSH_ID, origin: 'subagent' },
    });
    expect(await dsh.host.preExecute(call('todo_write', { todos: [] }, child), allowNext)).toEqual({
      kind: 'allow',
    });
    const cards = ofType(events, 'question.requested').length;
    await expect(dsh.ask()).rejects.toThrow('already approved in this step');
    expect(ofType(events, 'question.requested')).toHaveLength(cards);
    // The next step lifts it.
    dsh.emitEvent('assistant/message', { turn: 1, step: 2, message: { id: 'm', content: [] } });
    expect(await dsh.host.preExecute(call('read', { file_path: 'notes.txt' }), allowNext)).toEqual({
      kind: 'allow',
    });
  });

  it('the approval leaves a notice on exit_plan_mode’s result for the model and the timeline', async () => {
    const dsh = fakeDsh();
    const { bridge, events, notices } = runtime(dsh.ctx);
    await bridge.bootstrap();
    dsh.agentState.status = 'running';
    const result = dsh.execute(
      'exit_plan_mode',
      { plan: PLAN },
      async () => {
        await dsh.ask();
        return { isError: false, value: { approved: true } };
      },
      { callId: 'call-plan' }
    );
    await until(() => cardOf(events) !== undefined);
    bridge.respondQuestion({
      questionId: String(cardOf(events)?.questionId),
      answers: { 'plan-review': 'goal:auto' },
    });
    const outcome = await result;
    expect(outcome).toMatchObject({ isError: false, value: { approved: true } });
    expect(outcome.additionalContexts).toHaveLength(1);
    expect(notices.at(-1)).toEqual({
      content: [
        {
          type: 'text',
          text: expect.stringContaining('set it as the session goal'),
        },
      ],
      source: {
        kind: PLAN_REVIEW_SOURCE_KIND,
        form: 'notice',
        summary: 'Plan approved: set as the goal, running on full auto.',
        choice: 'goal:auto',
        goal: true,
      },
    });
  });
});

describe('create_goal in plan mode opens the same review (decision 169)', () => {
  async function proposing(
    options: { goalExists?: boolean; permissions?: RuntimePermissionSettings } = {}
  ) {
    const dsh = fakeDsh(options);
    const run = runtime(dsh.ctx, options.permissions);
    await run.bridge.bootstrap();
    dsh.agentState.status = 'running';
    const ran = vi.fn(async (): Promise<DshToolOutcome> => ({ isError: false, value: 'tool ran' }));
    const result = dsh.execute(
      'create_goal',
      { objective: 'Ship CSV export', max_goal_rounds: 6 },
      ran
    );
    return { dsh, ...run, ran, result };
  }

  it('an approval sets the model’s goal itself and settles the call with the goal, never running the tool', async () => {
    const { dsh, bridge, events, ran, result } = await proposing();
    await until(() => cardOf(events) !== undefined);
    expect(cardOf(events)?.review).toEqual({
      kind: 'plan',
      source: 'create_goal',
      objective: 'Ship CSV export',
      callId: 'call-create_goal',
      goalObjective: 'Ship CSV export',
    });
    bridge.respondQuestion({
      questionId: String(cardOf(events)?.questionId),
      answers: { 'plan-review': 'goal:auto' },
    });
    const outcome = await result;
    expect(ran).not.toHaveBeenCalled();
    expect(dsh.goals.create).toHaveBeenCalledWith(expect.anything(), {
      objective: 'Ship CSV export',
      maxGoalRounds: 6,
    });
    expect(outcome).toMatchObject({
      isError: false,
      value: goalToolValue(dsh.created[0] as never),
    });
    expect(outcome.additionalContexts).toHaveLength(1);
    expect(gateOf(bridge)).toEqual({ mode: 'agent', gear: 'auto' });
  });

  it('carries the plan last presented in the session', async () => {
    const dsh = fakeDsh();
    const { bridge, events } = runtime(dsh.ctx);
    await bridge.bootstrap();
    dsh.agentState.status = 'running';
    const answer = dsh.ask();
    await until(() => cardOf(events) !== undefined);
    bridge.respondQuestion({
      questionId: String(cardOf(events)?.questionId),
      answers: { 'plan-review': 'keep-planning' },
      response: 'More detail.',
    });
    await answer;
    void dsh.execute('create_goal', { objective: 'Ship it' }, async () => ({ isError: false }));
    await until(() => ofType(events, 'question.requested').length === 2);
    expect(cardOf(events)?.review).toMatchObject({
      source: 'create_goal',
      title: 'Ship CSV export',
      plan: PLAN,
      objective: 'Ship it',
    });
  });

  it('keep planning, a closed review and run-once each settle the call with what happened', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [
        { answers: { 'plan-review': 'keep-planning' }, response: 'Smaller first.' },
        `${KEEP_PLANNING_FEEDBACK_PREFIX}Smaller first.`,
      ],
      [{ cancel: true }, REVIEW_DISMISSED_TEXT],
      [{ answers: { 'plan-review': 'run:auto' } }, RUN_WITHOUT_GOAL_TEXT],
    ];
    for (const [response, text] of cases) {
      const { dsh, bridge, events, ran, result } = await proposing();
      await until(() => cardOf(events) !== undefined);
      bridge.respondQuestion({ questionId: String(cardOf(events)?.questionId), ...response });
      const outcome = await result;
      expect(ran).not.toHaveBeenCalled();
      expect(dsh.goals.create).not.toHaveBeenCalled();
      expect(outcome).toMatchObject({
        isError: true,
        content: [{ type: 'text', text: `Error: ${text}` }],
        error: { message: text },
      });
    }
  });

  it('an unfinished goal: approved, posture switched, the call says why no goal was set', async () => {
    const { bridge, events, result } = await proposing({ goalExists: true });
    await until(() => cardOf(events) !== undefined);
    bridge.respondQuestion({
      questionId: String(cardOf(events)?.questionId),
      answers: { 'plan-review': 'goal:auto' },
    });
    const outcome = await result;
    expect(gateOf(bridge)).toEqual({ mode: 'agent', gear: 'auto' });
    expect(outcome).toMatchObject({
      isError: true,
      error: {
        message: `${GOAL_NOT_SET_PREFIX}goal "goal-0" already exists with phase "paused"`,
      },
    });
  });

  it('a Stop while it is up settles the call aborted', async () => {
    const dsh = fakeDsh();
    const { bridge, events } = runtime(dsh.ctx);
    await bridge.bootstrap();
    dsh.agentState.status = 'running';
    const controller = new AbortController();
    const result = dsh.execute(
      'create_goal',
      { objective: 'x' },
      async () => ({ isError: false }),
      {
        signal: controller.signal,
      }
    );
    await until(() => cardOf(events) !== undefined);
    controller.abort();
    expect(await result).toEqual(abortedOutcome());
    expect(gateOf(bridge)).toEqual({ mode: 'plan', gear: 'auto' });
  });

  it('outside plan mode the tool runs as DSH’s own', async () => {
    const { ran, result, events } = await proposing({
      permissions: { mode: 'agent', gear: 'auto' },
    });
    expect(await result).toEqual({ isError: false, value: 'tool ran' });
    expect(ran).toHaveBeenCalledOnce();
    expect(cardOf(events)).toBeUndefined();
  });
});

describe('update_goal resume in plan mode is refused with the way out (decision 169)', () => {
  it('refuses resume in plan mode only', async () => {
    const dsh = fakeDsh();
    const { bridge } = runtime(dsh.ctx);
    await bridge.bootstrap();
    const resume = call('update_goal', { goal_id: 'g', revision: 1, action: 'resume' });
    expect(await dsh.host.preExecute(resume, allowNext)).toEqual({
      kind: 'deny',
      reason: PLAN_MODE_RESUME_REASON,
      info: { name: 'PermissionDenial', code: 'plan_mode_goal_resume' },
    });
    const pause = call('update_goal', { goal_id: 'g', revision: 1, action: 'pause' });
    expect(await dsh.host.preExecute(pause, allowNext)).toEqual({ kind: 'allow' });
    bridge.setPermissions({ mode: 'agent', gear: 'auto' });
    expect(await dsh.host.preExecute(resume, allowNext)).toEqual({ kind: 'allow' });
  });
});
