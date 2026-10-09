import { englishTranslate, translate } from '@shared/i18n';
import { PLAN_REVIEW_NOTICE_SUMMARIES } from '@shared/planReview';
import { describe, expect, it } from 'vitest';
import type { ChatBlock } from '@/stores/chatSessions';
import {
  availablePlanReviewChoice,
  defaultPlanReviewChoice,
  frozenPlanReviewGoalNote,
  frozenPlanReviewLine,
  PLAN_REVIEW_OPTION_COPY,
  pendingPlanReviewId,
  planPreviewClass,
  planReviewBody,
  planReviewOptionRows,
  planReviewSubmit,
} from '../planReviewModel';
import { planReviewRowWord } from '../planReviewRowWord';
import type { GoalBarView } from '../sessionPanelsModel';
import { deriveToolRowView } from '../toolCard';

/**
 * dsh-rebase decision 169 — the plan review card's pure half: the four ways
 * on (goal choices off while an unfinished goal is current), what 「确定」
 * does (bypass confirmed once more, keep planning needs feedback), what a
 * settled review says, and which card a message sent now closes first.
 */

const goal = (state: GoalBarView['state']) => ({ state }) as GoalBarView;

const CARD = {
  kind: 'plan' as const,
  source: 'exit_plan_mode' as const,
  title: 'Ship CSV export',
  plan: '# Ship CSV export\n\n## Goal\n- CSV',
  callId: 'call-1',
  goalObjective: '# Ship CSV export\n\n## Goal\n- CSV',
};

describe('the card’s choices', () => {
  it('offers the four ways on, the goal on full auto first', () => {
    expect(planReviewOptionRows(null).map((row) => [row.id, row.disabled])).toEqual([
      ['goal:auto', false],
      ['goal:bypass', false],
      ['run:auto', false],
      ['keep-planning', false],
    ]);
    expect(defaultPlanReviewChoice(null)).toBe('goal:auto');
    // A completed goal can be replaced.
    expect(defaultPlanReviewChoice(goal('complete'))).toBe('goal:auto');
  });

  it('turns the goal choices off while an unfinished goal is current, and says why', () => {
    const rows = planReviewOptionRows(goal('paused'));
    expect(rows.filter((row) => row.disabled).map((row) => row.id)).toEqual([
      'goal:auto',
      'goal:bypass',
    ]);
    expect(rows[0]?.hint).toBe(
      'This chat has an unfinished goal. Pause, finish or clear it in the goal bar first.'
    );
    expect(defaultPlanReviewChoice(goal('running'))).toBe('run:auto');
    expect(availablePlanReviewChoice('goal:bypass', goal('blocked'))).toBe('run:auto');
    expect(availablePlanReviewChoice('keep-planning', goal('blocked'))).toBe('keep-planning');
  });

  it('every label and description is in the dictionary', () => {
    for (const copy of Object.values(PLAN_REVIEW_OPTION_COPY)) {
      expect(translate('zh', copy.label)).not.toBe(copy.label);
      expect(translate('zh', copy.description)).not.toBe(copy.description);
    }
    expect(translate('zh', 'Set as goal, run on full auto')).toBe('设为目标，全自动执行');
  });
});

describe('what 「确定」 does', () => {
  it('asks once more before bypass, then sends it', () => {
    expect(planReviewSubmit('goal:bypass', '', false)).toEqual({ kind: 'confirm-bypass' });
    expect(planReviewSubmit('goal:bypass', '', true)).toEqual({
      kind: 'send',
      payload: { answers: { 'plan-review': 'goal:bypass' } },
    });
  });

  it('needs feedback to keep planning; sends it trimmed', () => {
    expect(planReviewSubmit('keep-planning', '   ', false)).toEqual({ kind: 'feedback-required' });
    expect(planReviewSubmit('keep-planning', ' drop step 3 ', false)).toEqual({
      kind: 'send',
      payload: { answers: { 'plan-review': 'keep-planning' }, response: 'drop step 3' },
    });
    expect(planReviewSubmit('goal:auto', 'ignored', false)).toEqual({
      kind: 'send',
      payload: { answers: { 'plan-review': 'goal:auto' } },
    });
  });

  it('shows a few lines of the plan in the dock, more once opened; a proposed goal without a plan', () => {
    expect(planPreviewClass(false)).toBe('max-h-48');
    expect(planPreviewClass(true)).toBe('max-h-96');
    expect(planReviewBody(CARD)).toEqual({ kind: 'plan', markdown: CARD.plan });
    expect(
      planReviewBody({
        kind: 'plan',
        source: 'create_goal',
        objective: 'Ship it',
        goalObjective: 'Ship it',
      })
    ).toEqual({ kind: 'goal', markdown: 'Ship it' });
  });
});

describe('a settled review', () => {
  const settled = (extra: Partial<ChatBlock>): ChatBlock => ({
    id: 'q1',
    type: 'question',
    questionId: 'q1',
    planReview: CARD,
    resolved: true,
    ...extra,
  });

  it('the frozen line says what was chosen', () => {
    expect(
      frozenPlanReviewLine(
        settled({ questionOutcome: 'answered', planReviewResult: { choice: 'goal:auto' } })
      )
    ).toEqual({ key: 'Plan review · approved: set as goal, full auto' });
    expect(
      frozenPlanReviewLine(
        settled({
          questionOutcome: 'answered',
          questionResponse: 'Split\n  the parser.',
          planReviewResult: { choice: 'keep-planning' },
        })
      )
    ).toEqual({
      key: 'Plan review · keep revising: {{feedback}}',
      params: { feedback: 'Split the parser.' },
    });
    expect(frozenPlanReviewLine(settled({ questionOutcome: 'cancelled' }))).toEqual({
      key: 'Plan review · closed',
    });
    expect(
      frozenPlanReviewLine(settled({ questionOutcome: 'cancelled', questionStopped: true }))
    ).toEqual({ key: 'Plan review · stopped' });
  });

  it('says why an approval set no goal', () => {
    const block = settled({
      questionOutcome: 'answered',
      planReviewResult: { choice: 'goal:auto', goal: { set: false, reason: 'goal exists' } },
    });
    expect(frozenPlanReviewGoalNote(block)).toEqual({
      key: 'Goal not set: {{reason}}',
      params: { reason: 'goal exists' },
    });
    expect(
      frozenPlanReviewGoalNote(
        settled({ planReviewResult: { choice: 'goal:auto', goal: { set: true } } })
      )
    ).toBeNull();
  });

  it('a review’s tool row ends with a word, never in the failed tone', () => {
    expect(planReviewRowWord('exit_plan_mode', 'ok', 'Plan approved — plan mode exited')).toEqual({
      key: 'Plan approved',
    });
    expect(
      planReviewRowWord(
        'exit_plan_mode',
        'failed',
        'Error: The user chose to keep planning; their feedback: Split it.'
      )
    ).toEqual({ key: 'Keep revising: {{feedback}}', params: { feedback: 'Split it.' } });
    expect(
      planReviewRowWord(
        'exit_plan_mode',
        'failed',
        'Error: The user dismissed the plan review to speak instead; stay in plan mode, stop here, and wait for their message.'
      )
    ).toEqual({ key: 'Review closed' });
    // A real failure stays a failure; other tools and a running call have no word.
    expect(
      planReviewRowWord(
        'exit_plan_mode',
        'failed',
        'Error: exit_plan_mode is only available in plan mode'
      )
    ).toBeUndefined();
    expect(planReviewRowWord('exit_plan_mode', 'running', undefined)).toBeUndefined();
    expect(planReviewRowWord('write', 'ok', 'ok')).toBeUndefined();
    // create_goal: a goal set is an ordinary result; the review's other answers are words.
    expect(planReviewRowWord('create_goal', 'ok', '{"goal":{}}')).toBeUndefined();
    expect(
      planReviewRowWord(
        'create_goal',
        'failed',
        'Error: The user approved the plan for this run only and set no goal; plan mode is exited — carry out the plan starting with your next step. Do not create a goal.'
      )
    ).toEqual({ key: 'Approved, no goal set' });
  });

  it('every word and line is in the dictionary, and so is every notice an approval leaves', () => {
    const keys = [
      'Plan review · approved: set as goal, full auto',
      'Plan review · approved: set as goal, all prompts bypassed',
      'Plan review · approved: run once, no goal',
      'Plan review · keep revising: {{feedback}}',
      'Plan review · keep revising',
      'Plan review · closed',
      'Plan review · stopped',
      'Goal not set: {{reason}}',
      'Plan approved',
      'Keep revising: {{feedback}}',
      'Keep revising',
      'Review closed',
      'Approved, no goal set',
      'Approved; the goal could not be set',
      ...PLAN_REVIEW_NOTICE_SUMMARIES,
    ];
    for (const key of keys) {
      expect(translate('zh', key), key).not.toBe(englishTranslate(key));
    }
  });
});

describe('which card a message sent now closes first', () => {
  const state = (planReview: boolean, resolved = false) => ({
    pendingQuestions: [{ sessionId: 's1', questionId: 'q1', messageId: 'm1' }],
    messages: {
      s1: [
        {
          id: 'm1',
          blocks: [
            {
              id: 'q1',
              type: 'question' as const,
              questionId: 'q1',
              resolved,
              ...(planReview ? { planReview: CARD } : {}),
            },
          ],
        },
      ],
    },
  });

  it('a pending plan review of this chat only', () => {
    expect(pendingPlanReviewId(state(true), 's1')).toBe('q1');
    expect(pendingPlanReviewId(state(true), 's2')).toBeNull();
    expect(pendingPlanReviewId(state(true), null)).toBeNull();
    // An ordinary question card keeps its own rule (decision 114 rule 6).
    expect(pendingPlanReviewId(state(false), 's1')).toBeNull();
    expect(pendingPlanReviewId(state(true, true), 's1')).toBeNull();
  });
});

describe('a review’s tool row', () => {
  const run = (status: 'ok' | 'failed', output: string) => ({
    toolCallId: 'call-1',
    blockIndex: 0,
    blockId: 'b1',
    toolName: 'exit_plan_mode',
    input: { plan: '# Ship CSV export\n\n- step' },
    status,
    output,
  });

  it('is not red, ends in its word, keeps the plan as its body and drops DSH’s English account', () => {
    const view = deriveToolRowView(
      run('failed', 'Error: The user chose to keep planning; their feedback: Split it.')
    );
    expect(view).toMatchObject({
      failed: false,
      planReview: { key: 'Keep revising: {{feedback}}', params: { feedback: 'Split it.' } },
      input: '# Ship CSV export\n\n- step',
    });
    expect(view.output).toBeUndefined();
    expect(view.body).toBeUndefined();
    // A real failure keeps the failed tone and its account.
    const failed = deriveToolRowView(run('failed', 'Error: only available in plan mode'));
    expect(failed).toMatchObject({ failed: true, output: 'Error: only available in plan mode' });
    expect(failed.planReview).toBeUndefined();
  });
});
