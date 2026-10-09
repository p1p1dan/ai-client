import { describe, expect, it } from 'vitest';
import {
  decodePlanReviewResponse,
  GOAL_NOT_SET_PREFIX,
  isGoalResumeCall,
  KEEP_PLANNING_TEXT,
  PLAN_GOAL_OBJECTIVE_MAX,
  PLAN_REVIEW_CHOICES,
  PLAN_REVIEW_NOTICE_SUMMARIES,
  type PlanReviewResponse,
  planGoalObjective,
  planGoalSections,
  planReviewNoticeSummary,
  planReviewNoticeText,
  planReviewPermissions,
  planReviewResponse,
  planReviewRowOutcome,
  planTitleOf,
  REVIEW_DISMISSED_TEXT,
  RUN_WITHOUT_GOAL_TEXT,
} from '../planReview';

/**
 * dsh-rebase decision 169 — what the bridge, Main and the renderer agree on
 * when plan mode ends: the card's choices and how a response decodes (fail
 * closed), the goal an approved plan sets, and how a review's tool row and
 * its notice read back.
 */

describe('the card’s answer', () => {
  it('round-trips every choice; keep-planning carries its trimmed feedback', () => {
    expect(PLAN_REVIEW_CHOICES).toEqual(['goal:auto', 'goal:bypass', 'run:auto', 'keep-planning']);
    expect(decodePlanReviewResponse(planReviewResponse('goal:auto'))).toEqual({
      kind: 'approve',
      choice: 'goal:auto',
      permissions: { mode: 'agent', gear: 'auto' },
      goal: true,
    });
    expect(decodePlanReviewResponse(planReviewResponse('goal:bypass'))).toMatchObject({
      permissions: { mode: 'agent', gear: 'bypass' },
      goal: true,
    });
    expect(decodePlanReviewResponse(planReviewResponse('run:auto'))).toMatchObject({
      permissions: { mode: 'agent', gear: 'auto' },
      goal: false,
    });
    expect(planReviewResponse('keep-planning', '  narrow it ')).toEqual({
      answers: { 'plan-review': 'keep-planning' },
      response: 'narrow it',
    });
    expect(decodePlanReviewResponse(planReviewResponse('keep-planning', 'narrow it'))).toEqual({
      kind: 'keep-planning',
      feedback: 'narrow it',
    });
    // Feedback only travels with keep-planning.
    expect(planReviewResponse('goal:auto', 'ignored')).toEqual({
      answers: { 'plan-review': 'goal:auto' },
    });
  });

  it('fails closed: a cancel, an unknown or extra answer, or empty feedback closes the review', () => {
    const responses: PlanReviewResponse[] = [
      { cancel: true, answers: { 'plan-review': 'goal:auto' } },
      { answers: { 'plan-review': 'Approve' } },
      { answers: { 'plan-review': 'goal:auto', extra: 'x' } },
      { answers: { other: 'goal:auto' } },
      { answers: { 'plan-review': 'keep-planning' } },
      { answers: { 'plan-review': 'keep-planning' }, response: '   ' },
      {},
    ];
    for (const response of responses) {
      expect(decodePlanReviewResponse(response)).toEqual({ kind: 'dismiss' });
    }
    // Free text alone is feedback.
    expect(decodePlanReviewResponse({ response: 'drop step 3' })).toEqual({
      kind: 'keep-planning',
      feedback: 'drop step 3',
    });
  });

  it('never approves into plan mode, and never bypass unless asked', () => {
    expect(planReviewPermissions('goal:auto')).toEqual({ mode: 'agent', gear: 'auto' });
    expect(planReviewPermissions('run:auto')).toEqual({ mode: 'agent', gear: 'auto' });
    expect(planReviewPermissions('goal:bypass')).toEqual({ mode: 'agent', gear: 'bypass' });
  });
});

describe('the goal an approved plan sets', () => {
  const PLAN = [
    '# Ship CSV export',
    '',
    '## Context',
    'Users export to XLSX today.',
    '',
    '## Goal and success criteria',
    '- The export menu offers CSV.',
    '### Checks',
    '- Excel opens the file.',
    '',
    '## Non-goals',
    '- No TSV.',
    '',
    '```md',
    '## Goal inside a fence',
    '```',
    '',
    '## Acceptance',
    '- A test covers quoting.',
  ].join('\n');

  it('takes the title and the goal / success sections, nested headings included, fences and non-goals not', () => {
    expect(planTitleOf(PLAN)).toBe('Ship CSV export');
    expect(planGoalSections(PLAN)).toEqual([
      '## Goal and success criteria\n- The export menu offers CSV.\n### Checks\n- Excel opens the file.',
      '## Acceptance\n- A test covers quoting.',
    ]);
    expect(planGoalObjective(PLAN)).toBe(
      '# Ship CSV export\n\n## Goal and success criteria\n- The export menu offers CSV.\n### Checks\n- Excel opens the file.\n\n## Acceptance\n- A test covers quoting.'
    );
  });

  it('reads Chinese headings', () => {
    const plan =
      '# 为导出增加 CSV\n\n## 背景\n略\n\n## 目标与成功标准\n- 导出菜单出现 CSV\n\n## 改动\n1. csv.ts\n';
    expect(planGoalObjective(plan)).toBe(
      '# 为导出增加 CSV\n\n## 目标与成功标准\n- 导出菜单出现 CSV'
    );
  });

  it('points at the plan when it states no goal, or states one past the cap', () => {
    expect(planGoalObjective('# Tidy the logs\n\n## Steps\n1. a\n')).toBe(
      'Carry out the approved plan "Tidy the logs" (presented for review in this session) until its success criteria are met.'
    );
    const long = `# Big\n\n## Goal\n${'x'.repeat(PLAN_GOAL_OBJECTIVE_MAX)}\n`;
    expect(planGoalObjective(long)).toMatch(/^Carry out the approved plan "Big"/);
    expect(planGoalObjective('no heading at all')).toMatch(/"the approved plan"/);
  });
});

describe('a review read back from its tool row and its notice', () => {
  it('classifies the review outcomes, and nothing else', () => {
    expect(
      planReviewRowOutcome('Error: The user chose to keep planning; their feedback: Split it.')
    ).toEqual({ kind: 'keep-planning', feedback: 'Split it.' });
    expect(planReviewRowOutcome(`Error: ${KEEP_PLANNING_TEXT}`)).toEqual({ kind: 'keep-planning' });
    expect(planReviewRowOutcome(REVIEW_DISMISSED_TEXT)).toEqual({ kind: 'dismissed' });
    expect(planReviewRowOutcome(`Error: ${RUN_WITHOUT_GOAL_TEXT}`)).toEqual({
      kind: 'approved-without-goal',
    });
    expect(planReviewRowOutcome(`Error: ${GOAL_NOT_SET_PREFIX}goal exists`)).toEqual({
      kind: 'goal-not-set',
      reason: 'goal exists',
    });
    expect(planReviewRowOutcome('Error: exit_plan_mode is only available in plan mode')).toBe(
      undefined
    );
    expect(planReviewRowOutcome(undefined)).toBe(undefined);
  });

  it('every notice summary is one the dictionary lists; the model text names the posture', () => {
    const summaries = [
      planReviewNoticeSummary('goal:auto', { set: true }),
      planReviewNoticeSummary('goal:bypass', { set: true }),
      planReviewNoticeSummary('run:auto'),
      planReviewNoticeSummary('goal:auto', { set: false, reason: 'r' }),
      planReviewNoticeSummary('goal:bypass', { set: false, reason: 'r' }),
    ];
    expect(new Set(summaries)).toEqual(new Set(PLAN_REVIEW_NOTICE_SUMMARIES));
    expect(planReviewNoticeText('goal:bypass', { set: true })).toContain('bypassed');
    expect(planReviewNoticeText('goal:auto', { set: false, reason: 'exists' })).toContain(
      '(exists)'
    );
    expect(planReviewNoticeText('run:auto')).toContain('no goal was set');
  });

  it('knows a goal resume', () => {
    expect(isGoalResumeCall('update_goal', { action: 'resume' })).toBe(true);
    expect(isGoalResumeCall('update_goal', { action: 'pause' })).toBe(false);
    expect(isGoalResumeCall('create_goal', { action: 'resume' })).toBe(false);
  });
});
