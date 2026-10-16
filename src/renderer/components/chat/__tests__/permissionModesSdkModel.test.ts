// @vitest-environment happy-dom
import { translate } from '@shared/i18n';
import {
  decodePlanReviewResponse,
  PLAN_REVIEW_CHOICES,
  planReviewChoicesOf,
  planReviewPermissions,
  SDK_PLAN_REVIEW_CHOICES,
} from '@shared/planReview';
import { describe, expect, it } from 'vitest';
import type { ChatBlock } from '@/stores/chatSessions';
import { applyPlanApprovalPosture } from '@/stores/planApprovalPosture';
import { chatEngineForDisplay, predictNewChatEngine } from '../chatEngineView';
import {
  permissionModeRefusalReasonText,
  permissionModeRefusalText,
} from '../permissionModeRefusal';
import {
  defaultPlanReviewChoice,
  frozenPlanReviewLine,
  planReviewOptionRows,
  planReviewSubmit,
} from '../planReviewModel';
import { planReviewRowWord } from '../planReviewRowWord';
import { SDK_MODE_DESCRIPTIONS } from '../sdkModeCopy';
import { readDefaultPermissions, writeDefaultPermissions } from '../sessionPreferenceStore';

/** Route B, S-2 (topic s2-permission-modes.md §3.1 items 10, 12-14): the pure halves. */

const zh = (key: string, params?: Record<string, string | number>) => translate('zh', key, params);

describe('which engine a chat speaks for (A-9)', () => {
  const catalog = [
    { id: 'gw/claude-opus-5', label: 'Opus', groups: [], sdkRoute: 'gw' },
    { id: 'zai/glm-5', label: 'GLM', groups: [] },
  ] as never;

  it('predicts a chat not started yet from the model the next send carries', () => {
    const on = { enabled: true, hostAvailable: true, catalog };
    expect(predictNewChatEngine({ ...on, model: 'gw/claude-opus-5' })).toBe('claude-sdk');
    expect(predictNewChatEngine({ ...on, model: 'zai/glm-5' })).toBe('dsh');
    // Automatic is the catalog's first model.
    expect(predictNewChatEngine({ ...on, model: undefined })).toBe('claude-sdk');
    expect(predictNewChatEngine({ ...on, enabled: false, model: 'gw/claude-opus-5' })).toBe('dsh');
  });

  it('a build without the SDK host predicts DSH, as Main chooses (review R1)', () => {
    const off = { enabled: true, hostAvailable: false, catalog };
    expect(predictNewChatEngine({ ...off, model: 'gw/claude-opus-5' })).toBe('dsh');
    expect(predictNewChatEngine({ ...off, model: undefined })).toBe('dsh');
  });

  it('a bound chat is what Main reported; a reopened one is read off its stub', () => {
    expect(chatEngineForDisplay({ bound: true, predicted: 'claude-sdk' })).toBe('dsh');
    expect(chatEngineForDisplay({ bound: true, engine: 'claude-sdk', predicted: 'dsh' })).toBe(
      'claude-sdk'
    );
    expect(
      chatEngineForDisplay({
        bound: false,
        runtimeIdentity: '/cfg/aiclient-sessions/abc.ccsdk.json',
        predicted: 'dsh',
      })
    ).toBe('claude-sdk');
    expect(
      chatEngineForDisplay({
        bound: false,
        runtimeIdentity: '/x/abc.dsh.json',
        predicted: 'claude-sdk',
      })
    ).toBe('dsh');
    expect(chatEngineForDisplay({ bound: false, predicted: 'claude-sdk' })).toBe('claude-sdk');
  });
});

describe('a refused mode, in our words (A-5)', () => {
  it('reads the reason inside Electron invoke text and translates it', () => {
    const text = permissionModeRefusalText(
      new Error(
        "Error invoking remote method 'chat:setPermissions': WorkerSlotError: WORKER_PERMISSION_MODE_REFUSED: bypass_disabled"
      )
    );
    expect(text && zh(text)).toBe('跳过权限确认被设置关闭了。');
    expect(
      zh(permissionModeRefusalText(new Error('WORKER_PERMISSION_MODE_REFUSED: timeout')) ?? '')
    ).toBe('引擎没有及时回应，请再试一次。');
    expect(permissionModeRefusalText(new Error('WORKER_PERMISSION_MODE_REFUSED: nonsense'))).toBe(
      'The engine refused this mode.'
    );
    expect(permissionModeRefusalText(new Error('session_busy'))).toBeNull();
  });
});

describe('the plan review on the SDK engine (A-7)', () => {
  it('decodes only what the card offered; DSH cards are unchanged', () => {
    const approve = (choice: string, offered?: typeof PLAN_REVIEW_CHOICES) =>
      decodePlanReviewResponse({ answers: { 'plan-review': choice } }, offered);
    expect(approve('run:accept-edits').kind).toBe('dismiss');
    expect(approve('goal:auto').kind).toBe('approve');
    expect(approve('goal:auto', SDK_PLAN_REVIEW_CHOICES).kind).toBe('dismiss');
    expect(approve('run:ask', SDK_PLAN_REVIEW_CHOICES)).toMatchObject({
      kind: 'approve',
      permissions: { mode: 'agent', gear: 'ask' },
      goal: false,
    });
    expect(planReviewPermissions('run:accept-edits')).toEqual({
      mode: 'agent',
      gear: 'accept-edits',
    });
    expect(planReviewPermissions('run:bypass')).toEqual({ mode: 'agent', gear: 'bypass' });
    expect(planReviewPermissions('goal:auto')).toEqual({ mode: 'agent', gear: 'auto' });
    expect(planReviewChoicesOf({})).toBe(PLAN_REVIEW_CHOICES);
    expect(PLAN_REVIEW_CHOICES).toEqual(['goal:auto', 'goal:bypass', 'run:auto', 'keep-planning']);
  });

  it('shows the card own choices, Edit automatically first, all in Chinese', () => {
    const rows = planReviewOptionRows(null, SDK_PLAN_REVIEW_CHOICES);
    expect(rows.map((row) => zh(row.label))).toEqual([
      '批准，用自动编辑继续',
      '批准，用手动审批继续',
      '批准，用自动模式继续',
      '批准，用跳过权限确认继续',
      zh('Keep discussing and revising'),
    ]);
    expect(rows.every((row) => !row.disabled)).toBe(true);
    expect(defaultPlanReviewChoice(null, SDK_PLAN_REVIEW_CHOICES)).toBe('run:accept-edits');
    // A DSH card keeps its own rows and default.
    expect(planReviewOptionRows(null).map((row) => row.id)).toEqual([...PLAN_REVIEW_CHOICES]);
    expect(defaultPlanReviewChoice(null)).toBe('goal:auto');
  });

  it('confirms Bypass permissions once more before it answers', () => {
    expect(planReviewSubmit('run:bypass', '', false)).toEqual({ kind: 'confirm-bypass' });
    expect(planReviewSubmit('run:bypass', '', true)).toMatchObject({ kind: 'send' });
    expect(planReviewSubmit('run:ask', '', false)).toMatchObject({ kind: 'send' });
  });

  it('the frozen card says which mode the plan continues in', () => {
    const block = (choice: string, choices?: string[]) =>
      ({
        type: 'question',
        questionOutcome: 'answered',
        planReview: {
          kind: 'plan',
          source: 'exit_plan_mode',
          goalObjective: 'x',
          ...(choices ? { choices } : {}),
        },
        planReviewResult: { choice },
      }) as unknown as ChatBlock;
    expect(
      zh(frozenPlanReviewLine(block('run:accept-edits', [...SDK_PLAN_REVIEW_CHOICES])).key)
    ).toBe('计划审阅 · 已批准：用自动编辑继续');
    expect(zh(frozenPlanReviewLine(block('run:auto', [...SDK_PLAN_REVIEW_CHOICES])).key)).toBe(
      '计划审阅 · 已批准：用自动模式继续'
    );
    // On a DSH card, run:auto is still a run without a goal.
    expect(frozenPlanReviewLine(block('run:auto')).key).toBe(
      'Plan review · approved: run once, no goal'
    );
  });

  it('the SDK ExitPlanMode row ends with the review word', () => {
    expect(planReviewRowWord('ExitPlanMode', 'ok', undefined)).toEqual({ key: 'Plan approved' });
    expect(
      planReviewRowWord(
        'ExitPlanMode',
        'failed',
        'The user dismissed the plan review to speak instead; stay in plan mode, stop here, and wait for their message.'
      )
    ).toEqual({ key: 'Review closed' });
  });
});

describe('posture changes in the engine words (A-6)', () => {
  function fold(cause: string, engine: 'claude-sdk' | undefined) {
    const toasts: Array<{ title: string }> = [];
    const written: unknown[] = [];
    applyPlanApprovalPosture(
      {
        type: 'session.permissions',
        sessionId: 's1',
        payload: { permissions: { mode: 'agent', gear: 'auto' }, cause },
      } as never,
      {
        t: zh,
        writeSessionPermissions: (_id, settings) => written.push(settings),
        notePostureSynced: () => undefined,
        toast: (toast) => toasts.push(toast),
        engineOf: () => engine,
      }
    );
    return { toasts, written };
  }

  it('an SDK chat names the mode with Claude names, a DSH chat with its own', () => {
    expect(fold('plan-approved', 'claude-sdk').toasts[0]?.title).toBe(
      '计划已批准，已切换到「自动模式」'
    );
    expect(fold('plan-approved', undefined).toasts[0]?.title).toBe(
      '计划已批准，已切换到「全自动」'
    );
  });

  it('a change the engine made itself is stored and said once', () => {
    const { toasts, written } = fold('engine', 'claude-sdk');
    expect(written).toEqual([{ mode: 'agent', gear: 'auto' }]);
    expect(toasts.map((toast) => toast.title)).toEqual(['已切换到「自动模式」']);
  });
});

describe('review fixes: refusals, copy and the new-chat default (S-2)', () => {
  it('a mode the engine refused is a warning that says why, in our words', () => {
    const toasts: Array<{ type: string; title: string; description?: string }> = [];
    applyPlanApprovalPosture(
      {
        type: 'session.permissions',
        sessionId: 's1',
        payload: {
          permissions: { mode: 'agent', gear: 'ask' },
          cause: 'engine',
          refusedReason: 'auto_mode_model',
        },
      } as never,
      {
        t: zh,
        writeSessionPermissions: () => undefined,
        notePostureSynced: () => undefined,
        toast: (toast) => toasts.push(toast),
        engineOf: () => 'claude-sdk',
      }
    );
    expect(toasts).toEqual([
      { type: 'warning', title: '已切换到「手动审批」', description: '这个模型不能用自动模式。' },
    ]);
    expect(zh(permissionModeRefusalReasonText('nonsense'))).toBe('引擎没有接受这一档。');
  });

  it('the plan card describes each mode in the menu own words', () => {
    const rows = planReviewOptionRows(null, SDK_PLAN_REVIEW_CHOICES);
    const description = (id: string) => rows.find((row) => row.id === id)?.description;
    expect(description('run:ask')).toBe(SDK_MODE_DESCRIPTIONS.ask);
    expect(description('run:accept-edits')).toBe(SDK_MODE_DESCRIPTIONS['accept-edits']);
    expect(description('run:auto')).toBe(SDK_MODE_DESCRIPTIONS.auto);
    for (const row of rows) expect(zh(row.description), row.id).not.toBe(row.description);
  });

  it('an Auto or Edit automatically default picked under the SDK wording starts other chats on Manual', () => {
    localStorage.clear();
    writeDefaultPermissions({ mode: 'agent', gear: 'auto' }, 'claude-sdk');
    expect(readDefaultPermissions('claude-sdk')).toEqual({ mode: 'agent', gear: 'auto' });
    expect(readDefaultPermissions('dsh')).toEqual({ mode: 'agent', gear: 'ask' });
    expect(readDefaultPermissions()).toEqual({ mode: 'agent', gear: 'ask' });
    writeDefaultPermissions({ mode: 'agent', gear: 'accept-edits' }, 'claude-sdk');
    expect(readDefaultPermissions('dsh')).toEqual({ mode: 'agent', gear: 'ask' });
    // Plan mode and Manual mean the same on both engines.
    writeDefaultPermissions({ mode: 'plan', gear: 'auto' }, 'claude-sdk');
    expect(readDefaultPermissions('dsh')).toEqual({ mode: 'plan', gear: 'auto' });
    // A default picked under DSH wording stays what it was, on both.
    writeDefaultPermissions({ mode: 'agent', gear: 'auto' });
    expect(readDefaultPermissions('dsh')).toEqual({ mode: 'agent', gear: 'auto' });
    expect(readDefaultPermissions('claude-sdk')).toEqual({ mode: 'agent', gear: 'auto' });
    localStorage.clear();
  });
});
